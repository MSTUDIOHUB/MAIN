//! Checks literal, unconditional shader includes against the exact project.
use super::{editor_install_candidates, ProjectEditor};
use crate::code_ast::{SourceSyntaxCheckResult, SourceSyntaxError};
use regex::Regex;
use serde_json::Value;
use std::{
    collections::HashMap,
    fs,
    io::Read,
    path::{Component, Path, PathBuf},
    sync::OnceLock,
};

fn bounded_json(path: &Path) -> Option<Value> {
    let file = fs::File::open(path).ok()?;
    serde_json::from_reader(file.take(2 * 1024 * 1024)).ok()
}

fn normalized_path(path: &Path) -> Option<PathBuf> {
    let mut normalized = PathBuf::new();
    for part in path.components() {
        match part {
            Component::Normal(part) => normalized.push(part),
            Component::CurDir => {}
            Component::ParentDir if normalized.pop() => {}
            _ => return None,
        }
    }
    Some(normalized)
}

fn file_exists_in_root(root: &Path, relative: &Path) -> Option<bool> {
    match fs::canonicalize(root.join(relative)) {
        Ok(path) if path.starts_with(root) => Some(path.is_file()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Some(false),
        _ => None,
    }
}

fn package_matches(root: &Path, package: &str, version: &str) -> bool {
    let manifest = Path::new("package.json");
    if file_exists_in_root(root, manifest) != Some(true) {
        return false;
    }
    let Some(metadata) = bounded_json(&root.join(manifest)) else {
        return false;
    };
    metadata.get("name").and_then(Value::as_str) == Some(package)
        && metadata.get("version").and_then(Value::as_str) == Some(version)
}

fn installed_package(project: &Path, package: &str, lock: &Value) -> Option<PathBuf> {
    let entry = lock.get("dependencies")?.get(package)?;
    let version = entry.get("version")?.as_str()?;
    if !version
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'+'))
    {
        return None;
    }
    let embedded = project.join("Packages").join(package);
    if embedded.exists() {
        let root = fs::canonicalize(embedded).ok()?;
        return (root.starts_with(project) && package_matches(&root, package, version))
            .then_some(root);
    }
    let cache = fs::canonicalize(project.join("Library/PackageCache")).ok()?;
    if !cache.starts_with(project) {
        return None;
    }
    let direct = fs::canonicalize(cache.join(format!("{package}@{version}"))).ok();
    if let Some(root) =
        direct.filter(|root| root.starts_with(&cache) && package_matches(root, package, version))
    {
        return Some(root);
    }
    // Recent Editors use content hashes in the package cache directory name.
    let prefix = format!("{package}@");
    let mut matches = Vec::new();
    for entry in fs::read_dir(&cache).ok()?.take(2_049).enumerate() {
        if entry.0 == 2_048 {
            return None;
        }
        let entry = entry.1.ok()?;
        if !entry.file_name().to_string_lossy().starts_with(&prefix) {
            continue;
        }
        let Ok(root) = fs::canonicalize(entry.path()) else {
            continue;
        };
        if root.starts_with(&cache) && package_matches(&root, package, version) {
            matches.push(root);
        }
    }
    (matches.len() == 1).then(|| matches.remove(0))
}

fn builtin_include_roots(editor: &ProjectEditor) -> Vec<PathBuf> {
    editor_install_candidates(editor)
        .iter()
        .filter_map(|binary| {
            let base = binary.parent()?;
            // The exact-version Hub path supplies evidence. An unversioned fallback
            // installation does not prove the selected Editor's built-in includes.
            if !binary
                .components()
                .any(|part| part.as_os_str() == editor.version.as_str())
                || !binary.is_file()
            {
                return None;
            }
            let includes = if cfg!(target_os = "macos") {
                base.parent()?.join("CGIncludes")
            } else {
                base.join("Data/CGIncludes")
            };
            fs::canonicalize(includes).ok().filter(|path| path.is_dir())
        })
        .collect()
}

fn include_exists(
    project: &Path,
    owner: &Path,
    include: &str,
    builtins: &[PathBuf],
    lock: &Value,
    patch_paths: &HashMap<PathBuf, bool>,
) -> Option<bool> {
    let include = Path::new(include);
    if include.is_absolute() || include.to_str()?.contains(['\\', ':', '\0']) {
        return None;
    }
    let workspace_qualified = include.starts_with("Assets") || include.starts_with("Packages");
    let relative = normalized_path(&if workspace_qualified {
        include.to_owned()
    } else {
        owner.parent()?.join(include)
    })?;
    if let Some(exists) = patch_paths.get(&relative) {
        if *exists || include.components().count() > 1 {
            return Some(*exists);
        }
    } else if file_exists_in_root(project, &relative)? {
        return Some(true);
    }
    if let Ok(package_relative) = relative.strip_prefix("Packages") {
        let mut parts = package_relative.components();
        let package = parts.next()?.as_os_str().to_str()?;
        return file_exists_in_root(&installed_package(project, package, lock)?, parts.as_path());
    }
    // An unqualified include can resolve through the editor's built-ins.
    // Do not infer absence when the exact installation is unavailable.
    if !workspace_qualified
        && include
            .components()
            .all(|part| matches!(part, Component::Normal(_)))
    {
        if builtins.is_empty() {
            return None;
        }
        for root in builtins {
            if file_exists_in_root(root, include)? {
                return Some(true);
            }
        }
    }
    Some(false)
}

pub(crate) fn check_shader_includes(
    project: &Path,
    path: &Path,
    content: &str,
    patch_paths: Option<&HashMap<String, bool>>,
) -> Option<SourceSyntaxCheckResult> {
    if !matches!(
        path.extension()?.to_str()?.to_ascii_lowercase().as_str(),
        "shader" | "hlsl" | "cginc" | "compute"
    ) {
        return None;
    }
    let path = normalized_path(if path.is_absolute() {
        path.strip_prefix(project).ok()?
    } else {
        path
    })?;
    if !path.starts_with("Assets") && !path.starts_with("Packages") {
        return None;
    }
    let editor = ProjectEditor::read(project).ok().flatten()?;
    let builtins = builtin_include_roots(&editor);
    let lock_path = Path::new("Packages/packages-lock.json");
    let lock = if file_exists_in_root(project, lock_path) == Some(true) {
        bounded_json(&project.join(lock_path)).unwrap_or(Value::Null)
    } else {
        Value::Null
    };
    let patch_paths = patch_paths
        .into_iter()
        .flatten()
        .filter_map(|(path, exists)| {
            let path = Path::new(path);
            normalized_path(if path.is_absolute() {
                path.strip_prefix(project).ok()?
            } else {
                path
            })
            .map(|path| (path, *exists))
        })
        .collect();

    Some(shader_include_result(&path, content, |include| {
        include_exists(project, &path, include, &builtins, &lock, &patch_paths)
    }))
}

fn shader_include_result(
    path: &Path,
    content: &str,
    resolve: impl Fn(&str) -> Option<bool>,
) -> SourceSyntaxCheckResult {
    static COMMENTS_AND_STRINGS: OnceLock<Regex> = OnceLock::new();
    let comments = COMMENTS_AND_STRINGS
        .get_or_init(|| Regex::new(r#"(?s)/\*.*?(?:\*/|$)|//[^\n]*|"(?:\\.|[^"\\\n])*""#).unwrap());
    let masked = comments.replace_all(content, |capture: &regex::Captures| {
        let token = &capture[0];
        if token.starts_with('/') {
            token
                .chars()
                .map(|ch| if ch == '\n' { ch } else { ' ' })
                .collect::<String>()
        } else {
            token.to_owned()
        }
    });
    static DIRECTIVE: OnceLock<Regex> = OnceLock::new();
    let directive = DIRECTIVE
        .get_or_init(|| Regex::new(r#"^\s*#\s*(\w+)\b(?:\s+(?:"([^"]+)"|<([^>]+)>))?"#).unwrap());
    let mut errors = Vec::new();
    let mut error_count = 0;
    let mut conditional_depth: usize = 0;
    for (index, line) in masked.lines().enumerate() {
        let Some(parts) = directive.captures(line) else {
            continue;
        };
        match &parts[1] {
            "if" | "ifdef" | "ifndef" => conditional_depth += 1,
            "endif" => conditional_depth = conditional_depth.saturating_sub(1),
            "include" | "include_with_pragmas" if conditional_depth == 0 => {
                let Some(include) = parts.get(2).or_else(|| {
                    parts.get(3).filter(|path| {
                        path.as_str().starts_with("Assets/")
                            || path.as_str().starts_with("Packages/")
                    })
                }) else {
                    continue;
                };
                let name = include.as_str();
                if name.len() <= 512 && resolve(name) == Some(false) {
                    error_count += 1;
                    if errors.len() < 12 {
                        errors.push(SourceSyntaxError {
                            line: index + 1,
                            column: include.start() + 1,
                            kind: "missing_shader_include".to_owned(),
                            symbol: Some(name.to_owned()),
                        });
                    }
                }
            }
            _ => {}
        }
    }
    SourceSyntaxCheckResult {
        path: path.to_string_lossy().into_owned(),
        language: Some("unity-shader".to_owned()),
        applicable: true,
        has_errors: error_count > 0,
        error_count,
        first_error_line: errors.first().map(|error| error.line),
        first_error_column: errors.first().map(|error| error.column),
        errors_truncated: error_count > errors.len(),
        errors,
        module_exports: Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn literal_includes_report_missing_and_leave_conditional_or_unresolved_cases_for_the_editor() {
        let result = shader_include_result(Path::new("Assets/Test.shader"),
            "// #include \"commented.hlsl\"\n/*\n#include \"also-commented.hlsl\"\n*/\n#if SHADER_API_D3D11\n#include \"platform.hlsl\"\n#endif\n#include \"valid.hlsl\"\n#include SOME_MACRO\n#include_with_pragmas \"missing.hlsl\"\n#include <unknown.hlsl>\n",
            |name| match name { "valid.hlsl" => Some(true), "unknown.hlsl" => None, _ => Some(false) });
        assert_eq!(result.error_count, 1);
        assert_eq!(result.first_error_line, Some(10));
        assert_eq!(result.errors[0].symbol.as_deref(), Some("missing.hlsl"));
    }

    #[test]
    fn builtin_include_absence_is_proven_only_with_a_known_editor_root() {
        let fixture = tempfile::tempdir().unwrap();
        let project = fs::canonicalize(fixture.path()).unwrap();
        let builtins = project.join("fixture-CGIncludes");
        fs::create_dir_all(&builtins).unwrap();
        fs::write(builtins.join("UnityCG.cginc"), "").unwrap();
        let owner = Path::new("Assets/Example.shader");
        let lock = Value::Null;
        let patch = HashMap::new();
        assert_eq!(
            include_exists(
                &project,
                owner,
                "UnityCG.cginc",
                std::slice::from_ref(&builtins),
                &lock,
                &patch
            ),
            Some(true)
        );
        assert_eq!(
            include_exists(
                &project,
                owner,
                "UnityHLSL.shared.hlsl",
                std::slice::from_ref(&builtins),
                &lock,
                &patch
            ),
            Some(false)
        );
        assert_eq!(
            include_exists(&project, owner, "UnityHLSL.shared.hlsl", &[], &lock, &patch),
            None
        );
    }

    #[test]
    fn lookup_uses_the_locked_package_and_the_transaction_post_image() {
        let project = tempfile::tempdir().unwrap();
        let project = fs::canonicalize(project.path()).unwrap();
        let cache = project.join("Library/PackageCache/com.example@14.2.0-t1");
        fs::create_dir_all(&cache).unwrap();
        fs::write(
            cache.join("package.json"),
            r#"{"name":"com.example","version":"14.2.0-t1"}"#,
        )
        .unwrap();
        fs::write(cache.join("Core.hlsl"), "").unwrap();
        let lock = serde_json::json!({"dependencies":{"com.example":{"version":"14.2.0-t1"}}});
        let patch = HashMap::from([(PathBuf::from("Assets/New.hlsl"), true)]);
        let owner = Path::new("Assets/Test.shader");
        assert_eq!(
            include_exists(
                &project,
                owner,
                "Packages/com.example/Core.hlsl",
                &[],
                &lock,
                &patch
            ),
            Some(true)
        );
        assert_eq!(
            include_exists(
                &project,
                owner,
                "Packages/com.example/Missing.hlsl",
                &[],
                &lock,
                &patch
            ),
            Some(false)
        );
        assert_eq!(
            include_exists(
                &project,
                owner,
                "Packages/com.unresolved/Missing.hlsl",
                &[],
                &lock,
                &patch
            ),
            None
        );
        assert_eq!(
            include_exists(&project, owner, "New.hlsl", &[], &lock, &patch),
            Some(true)
        );
    }
}
