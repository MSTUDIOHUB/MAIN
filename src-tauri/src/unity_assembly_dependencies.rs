//! Read-only assembly evidence for the source files named by Unity diagnostics.
use crate::{
    resolve_workspace_root, run_file_read_io, unity_editor::installed_package, WorkspaceState,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet, HashMap},
    fs::{self, File},
    io::Read,
    path::{Component, Path, PathBuf},
};
use tauri::State;
use tree_sitter::{Node, Parser};
use walkdir::{DirEntry, WalkDir};

const MAX_SOURCES: usize = 8;
const MAX_REFERENCES: usize = 48;
const MAX_DEPENDENCY_CLOSURE: usize = 48;
const METADATA_BYTES: u64 = 2 * 1024 * 1024;
const SOURCE_BYTES: u64 = 256 * 1024;
const MAX_INDEX_ENTRIES: usize = 52_000;
const MAX_ASSEMBLIES: usize = 1_024;
const MAX_DIRECTORY_DEPTH: usize = 24;
const MAX_PACKAGES: usize = 128;
const MAX_NAMESPACE_ENTRIES: usize = 1_100;
const MAX_NAMESPACE_FILES: usize = 192;

struct Package {
    id: String,
    version: String,
    root: PathBuf,
}

struct Assembly {
    path: PathBuf,
    name: String,
    version: String,
    guid: Option<String>,
    references: Vec<String>,
    references_complete: bool,
    has_precompiled_references: bool,
    package: Option<usize>,
}

enum Boundary {
    Definition(usize),
    Redirect(String),
    Invalid,
}

struct AssemblyIndex {
    definitions: Vec<Assembly>,
    directories: HashMap<PathBuf, Boundary>,
    complete: bool,
    dependency_metadata_complete: bool,
    remaining_entries: usize,
}

fn regular_bytes(path: &Path, max_bytes: u64) -> Option<Vec<u8>> {
    if !fs::symlink_metadata(path).ok()?.is_file() || path.canonicalize().ok()? != path {
        return None;
    }
    let file = File::open(path).ok()?;
    let metadata = file.metadata().ok()?;
    if !metadata.is_file() || metadata.len() > max_bytes {
        return None;
    }
    let mut bytes = Vec::new();
    file.take(max_bytes + 1).read_to_end(&mut bytes).ok()?;
    (bytes.len() as u64 <= max_bytes).then_some(bytes)
}

fn json_metadata(bytes: &[u8]) -> Option<Value> {
    serde_json::from_slice(bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(bytes)).ok()
}

fn relative_name(project: &Path, path: &Path) -> Option<String> {
    Some(
        path.strip_prefix(project)
            .ok()?
            .to_str()?
            .replace('\\', "/"),
    )
}

fn selected_source_path(value: &str) -> Option<PathBuf> {
    if value.len() > 512 || value.contains([':', '\0', '\n', '\r']) {
        return None;
    }
    let normalized = value.replace('\\', "/");
    let path = Path::new(&normalized);
    if !path
        .components()
        .all(|part| matches!(part, Component::Normal(_)))
        || !matches!(
            path.components().next()?.as_os_str().to_str()?,
            "Assets" | "Packages"
        )
        || !path.extension()?.to_str()?.eq_ignore_ascii_case("cs")
    {
        return None;
    }
    Some(path.to_owned())
}

fn valid_package_id(value: &str) -> bool {
    (1..=128).contains(&value.len())
        && value.split('.').all(|segment| !segment.is_empty())
        && value.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'.' | b'-' | b'_')
        })
}

fn locked_packages(project: &Path) -> (Vec<Package>, bool, bool) {
    let lock = regular_bytes(&project.join("Packages/packages-lock.json"), METADATA_BYTES)
        .and_then(|bytes| json_metadata(&bytes));
    let Some((lock, dependencies)) = lock
        .as_ref()
        .and_then(|lock| Some((lock, lock.get("dependencies")?.as_object()?)))
    else {
        return (Vec::new(), false, false);
    };
    let mut complete = dependencies.len() <= MAX_PACKAGES;
    let mut dependency_metadata_complete = true;
    let packages = dependencies
        .iter()
        .take(MAX_PACKAGES)
        .filter_map(|(id, info)| {
            let Some(version) = info.get("version").and_then(Value::as_str) else {
                complete = false;
                return None;
            };
            if !valid_package_id(id) {
                complete = false;
                return None;
            }
            let root = installed_package(project, id, lock);
            // Engine modules can live in the selected Editor. An explicit reference
            // to one we cannot resolve locally still disqualifies the closure.
            if root.is_none() && info.get("source").and_then(Value::as_str) != Some("builtin") {
                dependency_metadata_complete = false;
            }
            root.map(|root| Package {
                id: id.clone(),
                version: version.to_owned(),
                root,
            })
        })
        .collect();
    (packages, complete, dependency_metadata_complete)
}

fn read_guid(path: &Path) -> Option<String> {
    let mut meta = path.as_os_str().to_owned();
    meta.push(".meta");
    let bytes = regular_bytes(&PathBuf::from(meta), 32 * 1024)?;
    std::str::from_utf8(&bytes).ok()?.lines().find_map(|line| {
        let guid = line.trim().strip_prefix("guid:")?.trim();
        (guid.len() == 32 && guid.bytes().all(|byte| byte.is_ascii_hexdigit()))
            .then(|| guid.to_ascii_lowercase())
    })
}

fn metadata_entry(entry: &DirEntry) -> bool {
    if entry.depth() == 0 {
        return true;
    }
    let kind = entry.file_type();
    !kind.is_symlink()
        && entry
            .file_name()
            .to_str()
            .is_some_and(|name| !name.starts_with('.') && !(kind.is_dir() && name.ends_with('~')))
}

impl AssemblyIndex {
    fn collect(&mut self, root: &Path, package: Option<usize>) {
        if !root.is_dir() || root.canonicalize().ok().as_deref() != Some(root) {
            return;
        }
        for entry in WalkDir::new(root)
            .follow_links(false)
            .max_depth(MAX_DIRECTORY_DEPTH)
            .sort_by_file_name()
            .into_iter()
            .filter_entry(metadata_entry)
        {
            if self.remaining_entries == 0 || self.definitions.len() >= MAX_ASSEMBLIES {
                self.complete = false;
                return;
            }
            self.remaining_entries -= 1;
            let Ok(entry) = entry else {
                self.complete = false;
                continue;
            };
            if entry.depth() == MAX_DIRECTORY_DEPTH && entry.file_type().is_dir() {
                self.complete = false;
            }
            if !entry.file_type().is_file() {
                continue;
            }
            let path = entry.path();
            let extension = path.extension().and_then(|ext| ext.to_str()).unwrap_or("");
            // Plugin imports and compiler response files can introduce
            // project dependencies outside the explicit .asmdef graph.
            if (extension.eq_ignore_ascii_case("dll") || extension.eq_ignore_ascii_case("rsp"))
                && (package.is_none()
                    || root.parent().is_some_and(|path| path.ends_with("Packages")))
            {
                self.dependency_metadata_complete = false;
            }
            if !matches!(extension, "asmdef" | "asmref") {
                continue;
            }
            let Some(directory) = path.parent() else {
                continue;
            };
            let boundary = self
                .read_boundary(path, extension, package)
                .unwrap_or(Boundary::Invalid);
            if matches!(boundary, Boundary::Invalid) || self.directories.contains_key(directory) {
                self.dependency_metadata_complete = false;
            }
            self.directories
                .entry(directory.to_owned())
                .and_modify(|value| *value = Boundary::Invalid)
                .or_insert(boundary);
        }
    }

    fn read_boundary(
        &mut self,
        path: &Path,
        extension: &str,
        package: Option<usize>,
    ) -> Option<Boundary> {
        let bytes = regular_bytes(path, METADATA_BYTES)?;
        let data = json_metadata(&bytes)?;
        if extension == "asmref" {
            let reference = data.get("reference")?.as_str()?;
            return (reference.len() <= 180).then(|| Boundary::Redirect(reference.to_owned()));
        }
        let name = data.get("name")?.as_str()?.trim();
        if name.is_empty() || name.len() > 160 || name.chars().any(char::is_control) {
            return None;
        }
        let (references, references_complete) = match data.get("references") {
            None => (Vec::new(), true),
            Some(Value::Array(items)) => {
                let references: Vec<_> = items
                    .iter()
                    .take(MAX_REFERENCES)
                    .filter_map(|value| {
                        value
                            .as_str()
                            .filter(|name| name.len() <= 180 && !name.chars().any(char::is_control))
                            .map(str::to_owned)
                    })
                    .collect();
                let complete = references.len() == items.len();
                (references, complete)
            }
            Some(_) => (Vec::new(), false),
        };
        let index = self.definitions.len();
        self.definitions.push(Assembly {
            path: path.to_owned(),
            name: name.to_owned(),
            version: format!("sha256-{:x}", Sha256::digest(bytes)),
            guid: read_guid(path),
            references,
            references_complete,
            has_precompiled_references: data
                .get("precompiledReferences")
                .is_some_and(|items| items.as_array().is_none_or(|items| !items.is_empty())),
            package,
        });
        Some(Boundary::Definition(index))
    }

    fn matches_reference<'a>(&'a self, reference: &'a str) -> impl Iterator<Item = &'a Assembly> {
        self.definitions.iter().filter(move |definition| {
            if let Some(guid) = reference.strip_prefix("GUID:") {
                definition
                    .guid
                    .as_deref()
                    .is_some_and(|value| value.eq_ignore_ascii_case(guid))
            } else {
                definition.name == reference
            }
        })
    }

    fn owner(&self, path: &Path, project: &Path) -> Result<Option<&Assembly>, ()> {
        for folder in path
            .ancestors()
            .skip(1)
            .take_while(|folder| *folder != project)
        {
            match self.directories.get(folder) {
                None => {}
                Some(Boundary::Definition(index)) => return Ok(self.definitions.get(*index)),
                Some(Boundary::Redirect(reference)) => {
                    let mut matches = self.matches_reference(reference);
                    let definition = matches.next().ok_or(())?;
                    return if matches.next().is_none() {
                        Ok(Some(definition))
                    } else {
                        Err(())
                    };
                }
                Some(Boundary::Invalid) => return Err(()),
            }
        }
        Ok(None)
    }

    fn dependency_closure(&self, owner: &Assembly, project: &Path) -> Option<Vec<Value>> {
        if !self.complete || !self.dependency_metadata_complete {
            return None;
        }
        let mut visiting = BTreeSet::new();
        let mut visited = BTreeMap::new();
        self.visit_dependencies(owner, &mut visiting, &mut visited)?;
        visited
            .into_iter()
            .map(|(path, version)| {
                Some(json!({"path": relative_name(project, path)?, "version": version}))
            })
            .collect()
    }

    fn visit_dependencies<'a>(
        &'a self,
        assembly: &'a Assembly,
        visiting: &mut BTreeSet<&'a Path>,
        visited: &mut BTreeMap<&'a Path, &'a str>,
    ) -> Option<()> {
        let path = assembly.path.as_path();
        if visited.contains_key(path) {
            return Some(());
        }
        if !assembly.references_complete
            || assembly.has_precompiled_references
            || predefined(&assembly.name)
            || visiting.len() + visited.len() >= MAX_DEPENDENCY_CLOSURE
            || !visiting.insert(path)
            || self
                .definitions
                .iter()
                .filter(|definition| definition.name.eq_ignore_ascii_case(&assembly.name))
                .count()
                != 1
        {
            return None;
        }
        for reference in &assembly.references {
            let mut matches = self.matches_reference(reference);
            let dependency = matches.next()?;
            if matches.next().is_some() {
                return None;
            }
            self.visit_dependencies(dependency, visiting, visited)?;
        }
        visiting.remove(path);
        visited.insert(path, &assembly.version);
        Some(())
    }
}

fn resolve_source(project: &Path, relative: &Path, packages: &[Package]) -> Option<PathBuf> {
    let path = project.join(relative);
    if path.is_file() {
        return (path.canonicalize().ok()? == path).then_some(path);
    }
    let package_relative = relative.strip_prefix("Packages").ok()?;
    let mut parts = package_relative.components();
    let id = parts.next()?.as_os_str().to_str()?;
    let package = packages.iter().find(|package| package.id == id)?;
    let full = package.root.join(parts.as_path());
    (full.canonicalize().ok()? == full && full.is_file()).then_some(full)
}

fn visit_csharp(bytes: &[u8], predicate: impl Fn(Node<'_>) -> bool) -> bool {
    let mut parser = Parser::new();
    if parser
        .set_language(&tree_sitter_c_sharp::LANGUAGE.into())
        .is_err()
    {
        return false;
    }
    let Some(tree) = parser.parse(bytes, None) else {
        return false;
    };
    let mut cursor = tree.walk();
    for _ in 0..24_000 {
        if predicate(cursor.node()) {
            return true;
        }
        if cursor.goto_first_child() {
            continue;
        }
        while !cursor.goto_next_sibling() {
            if !cursor.goto_parent() {
                return false;
            }
        }
    }
    false
}

fn qualified_name(text: &str) -> Option<String> {
    let name: String = text
        .chars()
        .filter(|character| !character.is_whitespace())
        .collect();
    let name = name.strip_prefix("global::").unwrap_or(&name);
    (!name.is_empty()
        && name.split('.').all(|part| {
            part.as_bytes()
                .first()
                .is_some_and(|byte| byte.is_ascii_alphabetic() || *byte == b'_')
                && part
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
        }))
    .then(|| name.to_owned())
}

fn uses_namespace(source: &[u8], namespace: &str) -> bool {
    visit_csharp(source, |node| {
        matches!(node.kind(), "qualified_name" | "member_access_expression")
            && node
                .utf8_text(source)
                .ok()
                .and_then(qualified_name)
                .is_some_and(|name| {
                    name == namespace
                        || name
                            .strip_prefix(namespace)
                            .is_some_and(|suffix| suffix.starts_with('.'))
                })
    })
}

fn declares_namespace(source: &[u8], namespace: &str) -> bool {
    visit_csharp(source, |node| {
        if !matches!(
            node.kind(),
            "namespace_declaration" | "file_scoped_namespace_declaration"
        ) {
            return false;
        }
        let mut ancestors = Vec::new();
        let mut current = Some(node);
        while let Some(ancestor) = current {
            if matches!(
                ancestor.kind(),
                "namespace_declaration" | "file_scoped_namespace_declaration"
            ) {
                let Some(part) = ancestor
                    .child_by_field_name("name")
                    .and_then(|name| name.utf8_text(source).ok())
                    .and_then(qualified_name)
                else {
                    return false;
                };
                ancestors.push(part);
            }
            current = ancestor.parent();
        }
        ancestors.reverse();
        ancestors.join(".") == namespace
    })
}

fn assembly_declares_namespace(
    index: &AssemblyIndex,
    definition: &Assembly,
    namespace: &str,
) -> bool {
    let Some(root) = definition.path.parent() else {
        return false;
    };
    for entry in WalkDir::new(root)
        .follow_links(false)
        .max_depth(MAX_DIRECTORY_DEPTH)
        .sort_by_file_name()
        .into_iter()
        .filter_entry(|entry| {
            metadata_entry(entry)
                && (entry.depth() == 0
                    || !entry.file_type().is_dir()
                    || !index.directories.contains_key(entry.path()))
        })
        .take(MAX_NAMESPACE_ENTRIES)
        .filter_map(Result::ok)
        .filter(|entry| {
            entry.file_type().is_file() && entry.path().extension().is_some_and(|ext| ext == "cs")
        })
        .take(MAX_NAMESPACE_FILES)
    {
        if regular_bytes(entry.path(), SOURCE_BYTES)
            .is_some_and(|source| declares_namespace(&source, namespace))
        {
            return true;
        }
    }
    false
}

fn predefined(reference: &str) -> bool {
    matches!(
        reference,
        "Assembly-CSharp"
            | "Assembly-CSharp-Editor"
            | "Assembly-CSharp-firstpass"
            | "Assembly-CSharp-Editor-firstpass"
            | "UnityEngine"
            | "UnityEditor"
    )
}

fn package_assembly_provenance(project: &Path, definition: &Assembly, package: &Package) -> Value {
    json!({"name": definition.name, "path": relative_name(project, &definition.path),
        "package": package.id, "packageVersion": package.version, "version": definition.version})
}

fn reference_evidence(
    index: &AssemblyIndex,
    packages: &[Package],
    project: &Path,
    source: &[u8],
    reference: &str,
) -> Value {
    let mut exact = index.matches_reference(reference);
    if let Some(definition) = exact.next() {
        if exact.next().is_some() {
            return json!({"reference": reference, "status": "ambiguous"});
        }
        let mut result = json!({"reference": reference, "status": "resolved"});
        if let Some(package) = definition
            .package
            .and_then(|index| packages.get(index))
            .filter(|_| index.complete)
        {
            result["resolved"] = package_assembly_provenance(project, definition, package);
        }
        return result;
    }
    if predefined(reference) {
        return json!({"reference": reference, "status": "predefined"});
    }
    let mut result = json!({"reference": reference, "status": "missing"});
    let Some((_, stem)) = reference.rsplit_once('.') else {
        return result;
    };
    if !index.complete
        || qualified_name(reference).as_deref() != Some(reference)
        || !uses_namespace(source, reference)
    {
        return result;
    }
    // Require the package id and the assembly name to agree with the last
    // component, then verify this namespace in source owned by that assembly.
    let mut candidates = index.definitions.iter().filter_map(|definition| {
        let package = packages.get(definition.package?)?;
        let package_stem = package.id.rsplit('.').next()?;
        let assembly_stem = definition.name.rsplit('.').next()?;
        (stem.eq_ignore_ascii_case(package_stem) && stem == assembly_stem)
            .then_some((definition, package))
    });
    let Some((definition, package)) = candidates.next() else {
        return result;
    };
    if candidates.next().is_some() || index.matches_reference(&definition.name).count() != 1 {
        result["status"] = json!("ambiguous");
    } else if assembly_declares_namespace(index, definition, reference) {
        let mut candidate = package_assembly_provenance(project, definition, package);
        candidate["namespace"] = json!(reference);
        result["candidate"] = candidate;
    }
    result
}

pub fn inspect_unity_assembly_dependencies(
    project: &Path,
    source_paths: &[String],
) -> Result<Value, String> {
    if source_paths.is_empty() || source_paths.len() > MAX_SOURCES {
        return Err("UNITY_ASSEMBLY_SOURCE_LIMIT".into());
    }
    let project = project
        .canonicalize()
        .map_err(|_| "UNITY_ASSEMBLY_PROJECT_REQUIRED")?;
    if regular_bytes(
        &project.join("ProjectSettings/ProjectVersion.txt"),
        16 * 1024,
    )
    .is_none()
    {
        return Err("UNITY_ASSEMBLY_PROJECT_REQUIRED".into());
    }
    let mut sources = Vec::new();
    for value in source_paths {
        let relative = selected_source_path(value).ok_or("UNITY_ASSEMBLY_SOURCE_SCOPE_MISMATCH")?;
        if !sources.contains(&relative) {
            sources.push(relative);
        }
    }
    let (packages, complete, dependency_metadata_complete) = locked_packages(&project);
    let mut index = AssemblyIndex {
        definitions: Vec::new(),
        directories: HashMap::new(),
        complete,
        dependency_metadata_complete,
        remaining_entries: MAX_INDEX_ENTRIES,
    };
    index.collect(&project.join("Assets"), None);
    for (position, package) in packages.iter().enumerate() {
        index.collect(&package.root, Some(position));
    }
    let mut rows = Vec::new();
    let mut complete = index.complete;
    let multiple_source_paths = sources.len() > 1;
    for relative in sources {
        let path = relative.to_string_lossy().replace('\\', "/");
        let resolved = resolve_source(&project, &relative, &packages).and_then(|source| {
            let bytes = regular_bytes(&source, SOURCE_BYTES)?;
            Some((source, bytes))
        });
        let Some((source, bytes)) = resolved else {
            complete = false;
            rows.push(json!({"path": path, "assembly": null}));
            continue;
        };
        let assembly = match index.owner(&source, &project) {
            Ok(Some(owner)) => {
                complete &= owner.references_complete;
                let refs = owner
                    .references
                    .iter()
                    .map(|reference| {
                        reference_evidence(&index, &packages, &project, &bytes, reference)
                    })
                    .collect::<Vec<_>>();
                let mut evidence = json!({"name": owner.name, "path": relative_name(&project, &owner.path),
                    "version": owner.version, "predefined": false, "references": refs});
                if multiple_source_paths {
                    if let Some(closure) = index.dependency_closure(owner, &project) {
                        evidence["dependencyClosure"] = json!(closure);
                    }
                }
                evidence
            }
            Ok(None) if index.complete && relative.starts_with("Assets") => {
                let editor = relative
                    .components()
                    .any(|component| component.as_os_str() == "Editor");
                json!({"name": if editor { "Assembly-CSharp-Editor" } else { "Assembly-CSharp" },
                    "predefined": true, "references": []})
            }
            _ => {
                complete = false;
                Value::Null
            }
        };
        rows.push(json!({"path": path, "sourceVersion": format!("sha256-{:x}", Sha256::digest(bytes)), "assembly": assembly}));
    }
    Ok(json!({"sources": rows, "complete": complete}))
}

#[tauri::command]
pub async fn unity_inspect_assemblies(
    state: State<'_, WorkspaceState>,
    workspace: String,
    source_paths: Vec<String>,
) -> Result<Value, String> {
    if workspace.trim().is_empty() {
        return Err("UNITY_ASSEMBLY_PROJECT_REQUIRED".into());
    }
    let project = resolve_workspace_root(&state, Some(workspace))?;
    run_file_read_io(move || inspect_unity_assembly_dependencies(&project, &source_paths)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::{tempdir, TempDir};

    fn write(root: &Path, path: &str, content: &str) {
        let file = root.join(path);
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(file, content).unwrap();
    }

    fn package(root: &Path, id: &str, name: &str, version: &str, source: &str) {
        let cache = format!("Library/PackageCache/{id}@abcdef1234");
        write(
            root,
            &format!("{cache}/package.json"),
            &json!({"name": id, "version": version}).to_string(),
        );
        write(
            root,
            &format!("{cache}/Runtime/Library.asmdef"),
            &json!({"name": name}).to_string(),
        );
        write(root, &format!("{cache}/Runtime/Source.cs"), source);
    }

    fn project() -> TempDir {
        let dir = tempdir().unwrap();
        let project = dir.path();
        write(
            project,
            "ProjectSettings/ProjectVersion.txt",
            "m_EditorVersion: 6000.6.5f1\n",
        );
        write(
            project,
            "Packages/packages-lock.json",
            r#"{"dependencies":{"com.example.inputsystem":{"version":"1.20.0"}}}"#,
        );
        write(
            project,
            "Assets/Game/Game.asmdef",
            r#"{"name":"Game","references":["UnityEngine.InputSystem","Assembly-CSharp"]}"#,
        );
        write(
            project,
            "Assets/Game/Ball.cs",
            "using UnityEngine.InputSystem;\nclass Ball { }",
        );
        dir
    }

    fn inspect(root: &Path, source: &str) -> Value {
        inspect_unity_assembly_dependencies(root, &[source.to_owned()]).unwrap()
    }

    #[test]
    fn resolves_written_namespace_against_locked_package_owned_source() {
        let dir = project();
        package(
            dir.path(),
            "com.example.inputsystem",
            "Unity.InputSystem",
            "1.20.0",
            "namespace UnityEngine { namespace InputSystem { public class Keyboard {} }}",
        );
        let result = inspect(dir.path(), "Assets/Game/Ball.cs");
        assert_eq!(result["complete"], true);
        let owner = &result["sources"][0]["assembly"];
        assert_eq!(owner["path"], "Assets/Game/Game.asmdef");
        assert_eq!(owner["version"].as_str().unwrap().len(), 71);
        assert_eq!(owner["references"][0]["status"], "missing");
        let package_definition =
            "Library/PackageCache/com.example.inputsystem@abcdef1234/Runtime/Library.asmdef";
        let version = format!(
            "sha256-{:x}",
            Sha256::digest(fs::read(dir.path().join(package_definition)).unwrap())
        );
        assert_eq!(
            owner["references"][0]["candidate"],
            json!({
                "name": "Unity.InputSystem",
                "path": package_definition,
                "package": "com.example.inputsystem",
                "packageVersion": "1.20.0",
                "namespace": "UnityEngine.InputSystem",
                "version": version,
            })
        );
        assert_eq!(owner["references"][1]["status"], "predefined");

        write(
            dir.path(),
            "Assets/Game/Game.asmdef",
            r#"{"name":"Game","references":["Unity.InputSystem"]}"#,
        );
        write(
            dir.path(),
            "Assets/Game/Ball.cs",
            "using Unity.InputSystem;\nclass Ball { }",
        );
        let updated = inspect(dir.path(), "Assets/Game/Ball.cs");
        let updated_reference = &updated["sources"][0]["assembly"]["references"][0];
        assert_eq!(updated_reference["status"], "resolved");
        let mut expected_provenance = owner["references"][0]["candidate"].clone();
        expected_provenance
            .as_object_mut()
            .unwrap()
            .remove("namespace");
        assert_eq!(updated_reference["resolved"], expected_provenance);
    }

    #[test]
    fn declines_version_drift_and_comment_only_namespace() {
        let dir = project();
        let root = dir.path();
        package(
            root,
            "com.example.inputsystem",
            "Unity.InputSystem",
            "1.19.0",
            "namespace UnityEngine.InputSystem; public class Keyboard {}",
        );
        let candidate =
            |result: &Value| result["sources"][0]["assembly"]["references"][0]["candidate"].clone();
        assert_eq!(
            candidate(&inspect(root, "Assets/Game/Ball.cs")),
            Value::Null
        );
        package(
            root,
            "com.example.inputsystem",
            "Unity.InputSystem",
            "1.20.0",
            "// namespace UnityEngine.InputSystem;\nnamespace Different.InputSystem; public class Keyboard {}",
        );
        assert_eq!(
            candidate(&inspect(root, "Assets/Game/Ball.cs")),
            Value::Null
        );
        package(
            root,
            "com.example.inputsystem",
            "Unity.InputSystem",
            "1.20.0",
            "namespace UnityEngine.InputSystem; public class Keyboard {}",
        );
        write(
            root,
            "Assets/Game/Ball.cs",
            "// using UnityEngine.InputSystem;\nclass Ball {}",
        );
        assert_eq!(
            candidate(&inspect(root, "Assets/Game/Ball.cs")),
            Value::Null
        );
    }

    #[test]
    fn resolves_asmref_and_exact_guid_without_guessing_ambiguous_replacement() {
        let dir = project();
        let root = dir.path();
        let guid = "591fd508bce54501a93eaf3ed50f421b";
        write(
            root,
            "Assets/Game/Game.asmdef.meta",
            &format!("fileFormatVersion: 2\nguid: {guid}\n"),
        );
        write(
            root,
            "Assets/Other/Game.asmref",
            &json!({"reference": format!("GUID:{guid}")}).to_string(),
        );
        write(
            root,
            "Assets/Other/Controller.cs",
            "class Controller { UnityEngine.InputSystem.Keyboard k; }",
        );
        write(
            root,
            "Packages/packages-lock.json",
            r#"{"dependencies":{
                "com.example.inputsystem":{"version":"1.20.0"},
                "com.other.inputsystem":{"version":"2.0.0"}
            }}"#,
        );
        for (id, name, version) in [
            ("com.example.inputsystem", "Unity.InputSystem", "1.20.0"),
            ("com.other.inputsystem", "Another.InputSystem", "2.0.0"),
        ] {
            package(
                root,
                id,
                name,
                version,
                "namespace UnityEngine.InputSystem; public class Keyboard {}",
            );
        }
        let result = inspect(root, "Assets/Other/Controller.cs");
        let owner = &result["sources"][0]["assembly"];
        assert_eq!(owner["path"], "Assets/Game/Game.asmdef");
        assert_eq!(owner["references"][0]["status"], "ambiguous");
        assert_eq!(owner["references"][0]["candidate"], Value::Null);

        write(root, "Assets/Runner/Runner.cs", "class Runner {}");
        write(
            root,
            "Assets/Runner/Runner.asmdef",
            &json!({"name": "Runner","references":[format!("GUID:{guid}")]}).to_string(),
        );
        assert_eq!(
            inspect(root, "Assets/Runner/Runner.cs")["sources"][0]["assembly"]["references"][0]
                ["status"],
            "resolved"
        );
    }

    #[test]
    fn dependency_closure_is_versioned_and_requires_resolved_transitive_edges() {
        let dir = project();
        let root = dir.path();
        write(
            root,
            "Packages/packages-lock.json",
            r#"{"dependencies":{}}"#,
        );
        write(
            root,
            "Assets/Game/Game.asmdef",
            r#"{"name":"Game","references":["Support"]}"#,
        );
        let support = "Assets/Support/Support.asmdef";
        let shared = "Assets/Shared/Shared.asmdef";
        let guid = "591fd508bce54501a93eaf3ed50f421b";
        write(
            root,
            support,
            &json!({"name":"Support","references":[format!("GUID:{guid}")]}).to_string(),
        );
        write(root, shared, r#"{"name":"Shared"}"#);
        write(root, &format!("{shared}.meta"), &format!("guid: {guid}\n"));
        write(root, "Assets/Other/Other.asmdef", r#"{"name":"Other"}"#);
        write(root, "Assets/Other/Other.cs", "class Other {}");
        let inspect_pair = || {
            inspect_unity_assembly_dependencies(
                root,
                &["Assets/Game/Ball.cs".into(), "Assets/Other/Other.cs".into()],
            )
            .unwrap()
        };

        let row = &inspect_pair()["sources"][0];
        let version = |path: &str| {
            format!(
                "sha256-{:x}",
                Sha256::digest(fs::read(root.join(path)).unwrap())
            )
        };
        assert_eq!(row["sourceVersion"], version("Assets/Game/Ball.cs"));
        assert_eq!(
            row["assembly"]["dependencyClosure"],
            json!([
                {"path":"Assets/Game/Game.asmdef","version":version("Assets/Game/Game.asmdef")},
                {"path":shared,"version":version(shared)},
                {"path":support,"version":version(support)}
            ])
        );
        for conflicting in [
            r#"{"name":"Shared","references":["Game"]}"#,
            r#"{"name":"Shared","references":["Missing"]}"#,
            r#"{"name":"Shared","precompiledReferences":["OpaquePlugin.dll"]}"#,
        ] {
            write(root, shared, conflicting);
            let owner = &inspect_pair()["sources"][0]["assembly"];
            assert_eq!(owner["references"][0]["status"], "resolved");
            assert!(owner.get("dependencyClosure").is_none());
        }
        write(root, shared, r#"{"name":"Shared"}"#);
        write(root, "Assets/Plugins/OpaquePlugin.dll", "plugin fixture");
        assert!(inspect_pair()["sources"][0]["assembly"]
            .get("dependencyClosure")
            .is_none());
    }

    #[test]
    fn fails_closed_for_escaping_source_paths() {
        let dir = project();
        for path in [
            "../Elsewhere/Outside.cs",
            "Assets/../Outside.cs",
            "Library/PackageCache/Fake.cs",
            "/tmp/Assets/Outside.cs",
        ] {
            assert_eq!(
                inspect_unity_assembly_dependencies(dir.path(), &[path.into()]).unwrap_err(),
                "UNITY_ASSEMBLY_SOURCE_SCOPE_MISMATCH",
            );
        }
        #[cfg(unix)]
        {
            let outside = tempdir().unwrap();
            write(outside.path(), "Outside.cs", "using Credential.Provider;");
            std::os::unix::fs::symlink(
                outside.path().join("Outside.cs"),
                dir.path().join("Assets/Game/Outside.cs"),
            )
            .unwrap();
            let result = inspect(dir.path(), "Assets/Game/Outside.cs");
            assert_eq!(result["complete"], false);
            assert_eq!(result["sources"][0]["assembly"], Value::Null);
        }
    }
}
