use crate::trusted_execution::{
    canonical_workspace_root, resolve_workspace_path, WorkspacePathMode,
};
use regex::Regex;
use serde::Serialize;
use serde_json::Value;
use std::collections::{BTreeSet, HashMap};
use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

const UNITY_VERSION_PATH: &str = "ProjectSettings/ProjectVersion.txt";
const MAX_CONTEXT_PATHS: usize = 16;
const MAX_ANCESTORS: usize = 24;
const MAX_DIRECTORY_ENTRIES: usize = 512;
const MAX_DESCRIPTOR_BYTES: u64 = 256 * 1024;
const MAX_TARGET_FILES: usize = 32;
const MAX_TARGET_BYTES: u64 = 64 * 1024;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum EngineKind {
    Unity,
    Godot,
    Unreal,
    Uefn,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct EngineProfile {
    kind: EngineKind,
    project_root: String,
    descriptor_path: String,
    project_version: Option<String>,
    manual_preset_id: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    engine_association: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    editor_build_target: Option<String>,
}

fn relative_path(workspace: &Path, path: &Path) -> Option<String> {
    super::portable_relative_path(path.strip_prefix(workspace).ok()?)
}

fn trusted_path(workspace: &Path, path: impl AsRef<Path>) -> Option<PathBuf> {
    resolve_workspace_path(workspace, path, WorkspacePathMode::Existing)
        .ok()
        .map(|path| path.path().to_path_buf())
}

fn safe_descriptor(workspace: &Path, path: PathBuf) -> Option<PathBuf> {
    let resolved = trusted_path(workspace, &path)?;
    (path == resolved && resolved.is_file()).then_some(resolved)
}

fn descriptor_kind(path: &Path) -> Option<(EngineKind, &Path)> {
    let directory = path.parent()?;
    match path.file_name()?.to_str()? {
        "ProjectVersion.txt" if directory.file_name()?.to_str()? == "ProjectSettings" => {
            Some((EngineKind::Unity, directory.parent()?))
        }
        "project.godot" => Some((EngineKind::Godot, directory)),
        _ => match path.extension()?.to_str()? {
            "uproject" => Some((EngineKind::Unreal, directory)),
            "uefnproject" => Some((EngineKind::Uefn, directory)),
            _ => None,
        },
    }
}

fn descriptors_in(workspace: &Path, directory: &Path) -> Option<Vec<PathBuf>> {
    let mut descriptors: Vec<_> = [UNITY_VERSION_PATH, "project.godot"]
        .into_iter()
        .filter_map(|name| safe_descriptor(workspace, directory.join(name)))
        .collect();
    for (index, entry) in fs::read_dir(directory).ok()?.enumerate() {
        // With an incomplete listing we cannot tell if the first candidate is unique.
        if index == MAX_DIRECTORY_ENTRIES {
            return None;
        }
        let Ok(entry) = entry else { continue };
        let path = entry.path();
        if !matches!(
            path.extension().and_then(|ext| ext.to_str()),
            Some("uproject" | "uefnproject")
        ) {
            continue;
        }
        descriptors.extend(safe_descriptor(workspace, path));
    }
    Some(descriptors)
}

fn is_line_number(value: &str) -> bool {
    !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit())
}

fn without_line_fragment(value: &str) -> &str {
    if let Some((path, range)) = value.rsplit_once("#L") {
        if is_line_number(range)
            || range
                .split_once("-L")
                .is_some_and(|(start, end)| is_line_number(start) && is_line_number(end))
        {
            return path;
        }
    }
    if let Some((path, line)) = value.rsplit_once(':') {
        if is_line_number(line) {
            return path
                .rsplit_once(':')
                .filter(|(_, line)| is_line_number(line))
                .map_or(path, |(path, _)| path);
        }
    }
    value
}

fn context_path(workspace: &Path, raw: &str) -> Option<PathBuf> {
    let path = raw.trim();
    if path.is_empty() || path.contains("://") {
        return None;
    }
    trusted_path(workspace, path).or_else(|| {
        let stripped = without_line_fragment(path);
        (stripped != path)
            .then(|| trusted_path(workspace, stripped))
            .flatten()
    })
}

fn metadata_token(value: &str) -> Option<&str> {
    (!value.is_empty()
        && value.len() <= 100
        && value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-' | b'{' | b'}')
        }))
    .then_some(value)
}

fn release_version(value: &str) -> Option<&str> {
    let parts: Vec<_> = value.split('.').collect();
    ((2..=3).contains(&parts.len()) && parts.iter().all(|part| is_line_number(part)))
        .then_some(value)
}

fn read_descriptor(path: &Path, max_bytes: u64) -> Option<String> {
    let mut text = String::new();
    File::open(path)
        .ok()?
        .take(max_bytes + 1)
        .read_to_string(&mut text)
        .ok()?;
    (text.len() as u64 <= max_bytes).then_some(text)
}

fn unity_version(contents: &str) -> (Option<String>, Option<&'static str>) {
    let mut unity = None;
    let mut tuanjie = None;
    for line in contents.lines() {
        let Some((key, value)) = line.trim_start_matches('\u{feff}').split_once(':') else {
            continue;
        };
        let Some(token) = metadata_token(value.trim())
            .filter(|token| token.as_bytes().first().is_some_and(u8::is_ascii_digit))
        else {
            continue;
        };
        match key.trim() {
            "m_EditorVersion" if unity.is_none() => unity = Some(token),
            "m_TuanjieEditorVersion" if tuanjie.is_none() => tuanjie = Some(token),
            _ => {}
        }
    }
    let unity_is_tuanjie = unity.is_some_and(|version| {
        version.to_ascii_lowercase().contains("tuanjie")
            || version.split_once('t').is_some_and(|(release, update)| {
                release_version(release).is_some() && is_line_number(update)
            })
    });
    let preset = if tuanjie.is_some() || unity_is_tuanjie {
        Some("tuanjie")
    } else if unity.is_some_and(|version| version.starts_with("6000.")) {
        Some("unity6")
    } else {
        None
    };
    (tuanjie.or(unity).map(str::to_string), preset)
}

fn godot_version(contents: &str) -> Option<String> {
    contents.lines().find_map(|line| {
        let (key, value) = line.split_once('=')?;
        if key.trim() != "config/features" {
            return None;
        }
        let entries = value
            .trim()
            .strip_prefix("PackedStringArray(")?
            .strip_suffix(')')?;
        entries
            .split(',')
            .find_map(|entry| release_version(entry.trim().strip_prefix('"')?.strip_suffix('"')?))
            .map(str::to_string)
    })
}

fn unreal_editor_target(workspace: &Path, project: &Path) -> Option<String> {
    static EDITOR_TYPE: OnceLock<Regex> = OnceLock::new();
    let editor_type = EDITOR_TYPE
        .get_or_init(|| Regex::new(r"(?m)^\s*Type\s*=\s*TargetType\.Editor\s*;").unwrap());
    let source = project.join("Source");
    if trusted_path(workspace, &source)? != source {
        return None;
    }
    let mut found = None;
    let mut target_files = 0;
    for (index, entry) in fs::read_dir(source).ok()?.enumerate() {
        if index == MAX_DIRECTORY_ENTRIES {
            return None;
        }
        let Ok(entry) = entry else { continue };
        let name = entry.file_name();
        let Some(target) = name
            .to_str()
            .and_then(|name| name.strip_suffix(".Target.cs"))
        else {
            continue;
        };
        target_files += 1;
        if target_files > MAX_TARGET_FILES {
            return None;
        }
        if target.is_empty()
            || !target
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
        {
            continue;
        }
        let Some(path) = safe_descriptor(workspace, entry.path()) else {
            continue;
        };
        if !read_descriptor(&path, MAX_TARGET_BYTES)
            .is_some_and(|contents| editor_type.is_match(&contents))
        {
            continue;
        }
        if found.is_some() {
            return None;
        }
        found = Some(target.to_string());
    }
    found
}

fn profile(workspace: &Path, path: &Path) -> Option<EngineProfile> {
    let path = safe_descriptor(workspace, path.to_path_buf())?;
    let (kind, project) = descriptor_kind(&path)?;
    let contents = read_descriptor(&path, MAX_DESCRIPTOR_BYTES)?;
    let mut profile = EngineProfile {
        kind,
        project_root: relative_path(workspace, project)?,
        descriptor_path: relative_path(workspace, &path)?,
        project_version: None,
        manual_preset_id: None,
        engine_association: None,
        editor_build_target: None,
    };
    match kind {
        EngineKind::Unity => {
            (profile.project_version, profile.manual_preset_id) = unity_version(&contents)
        }
        EngineKind::Godot => profile.project_version = godot_version(&contents),
        EngineKind::Unreal => {
            let descriptor: Value =
                serde_json::from_str(contents.trim_start_matches('\u{feff}')).ok()?;
            if !descriptor.is_object() {
                return None;
            }
            profile.engine_association = descriptor
                .get("EngineAssociation")
                .and_then(Value::as_str)
                .and_then(metadata_token)
                .map(str::to_string);
            profile.project_version = profile
                .engine_association
                .as_deref()
                .and_then(release_version)
                .map(str::to_string);
            profile.editor_build_target = unreal_editor_target(workspace, project);
        }
        EngineKind::Uefn => profile.manual_preset_id = Some("ue6_verse"),
    }
    Some(profile)
}

pub(crate) fn inspect(
    workspace_input: &Path,
    context_paths: &[String],
    project_root_hint: Option<&str>,
) -> Option<EngineProfile> {
    let canonical_workspace = canonical_workspace_root(workspace_input).ok()?;
    let workspace = canonical_workspace.as_path();
    if let Some(hint) = project_root_hint {
        let path = context_path(workspace_input, hint)?;
        if path.is_file() {
            return profile(workspace, &path);
        }
        let descriptors = descriptors_in(workspace, &path)?;
        return match descriptors.as_slice() {
            [path] => profile(workspace, path),
            _ => None,
        };
    }

    if context_paths.len() > MAX_CONTEXT_PATHS {
        return None;
    }
    let paths: BTreeSet<_> = context_paths
        .iter()
        .filter_map(|path| context_path(workspace_input, path))
        .collect();
    let exact_descriptors: Vec<_> = paths
        .iter()
        .filter(|path| path.is_file() && descriptor_kind(path).is_some())
        .collect();
    let exact = match exact_descriptors.as_slice() {
        [path] => Some(path.as_path()),
        [] => None,
        _ => return None,
    };
    let mut candidates: BTreeSet<_> = exact.into_iter().map(Path::to_path_buf).collect();
    let mut scanned = HashMap::new();
    for path in &paths {
        if Some(path.as_path()) == exact {
            continue;
        }
        let directory = if path.is_dir() {
            path.as_path()
        } else {
            path.parent()?
        };
        for (index, ancestor) in directory
            .ancestors()
            .take_while(|path| path.starts_with(workspace))
            .enumerate()
        {
            if index == MAX_ANCESTORS {
                return None;
            }
            let descriptors = scanned
                .entry(ancestor.to_path_buf())
                .or_insert_with(|| descriptors_in(workspace, ancestor));
            match descriptors.as_deref()? {
                [descriptor] => {
                    candidates.insert(descriptor.clone());
                    break;
                }
                [] => continue,
                descriptors => {
                    let descriptor = exact
                        .filter(|exact| descriptors.iter().any(|candidate| candidate == exact))?;
                    candidates.insert(descriptor.to_path_buf());
                    break;
                }
            }
        }
        if candidates.len() > 1 {
            return None;
        }
    }
    if candidates.is_empty() {
        let descriptors = descriptors_in(workspace, workspace)?;
        return match descriptors.as_slice() {
            [path] => profile(workspace, path),
            _ => None,
        };
    }
    profile(workspace, candidates.first()?)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(workspace: &Path, path: &str, contents: &str) {
        let path = workspace.join(path);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, contents).unwrap();
    }

    #[test]
    fn workspace_engine_uses_nearest_project_and_rejects_competing_contexts() {
        let directory = tempfile::tempdir().unwrap();
        let workspace = directory.path().canonicalize().unwrap();
        write(
            &workspace,
            "ProjectSettings/ProjectVersion.txt",
            "m_EditorVersion: 6000.0.32f1\n",
        );
        write(
            &workspace,
            "Games/Adventure/project.godot",
            "config_version=5\nconfig/features=PackedStringArray(\"4.3\", \"GL Compatibility\")\n",
        );
        write(
            &workspace,
            "Games/Adventure/Scripts/player.gd",
            "extends Node\n",
        );
        write(&workspace, "Assets/player.cs", "public class Player {}\n");

        let root = inspect(&workspace, &[], None).unwrap();
        assert_eq!(root.kind, EngineKind::Unity);
        assert_eq!(root.project_root, ".");
        assert_eq!(root.project_version.as_deref(), Some("6000.0.32f1"));
        assert_eq!(root.manual_preset_id, Some("unity6"));

        let selected = format!(
            "{}/Games/Adventure/Scripts/player.gd#L2-L4",
            workspace.display()
        );
        let nested = inspect(&workspace, &[selected.clone()], None).unwrap();
        assert_eq!(nested.kind, EngineKind::Godot);
        assert_eq!(nested.project_root, "Games/Adventure");
        assert_eq!(nested.project_version.as_deref(), Some("4.3"));
        assert!(inspect(&workspace, &[selected, "Assets/player.cs:3:1".into()], None).is_none());
        assert!(inspect(
            &workspace,
            &[
                "Assets/player.cs".into(),
                "Games/Adventure/project.godot".into()
            ],
            None,
        )
        .is_none());
        assert!(inspect(&workspace, &[], Some("../")).is_none());
    }

    #[test]
    fn workspace_engine_distinguishes_unreal_uefn_and_target_ambiguity() {
        let directory = tempfile::tempdir().unwrap();
        let workspace = directory.path().canonicalize().unwrap();
        write(
            &workspace,
            "Game.uproject",
            r#"{"FileVersion":3,"EngineAssociation":"5.6"}"#,
        );
        write(
            &workspace,
            "Source/Game.Target.cs",
            "Type = TargetType.Game;\n",
        );
        write(
            &workspace,
            "Source/CustomBuild.Target.cs",
            "\tType = TargetType.Editor;\n",
        );
        let unreal = inspect(&workspace, &[], None).unwrap();
        assert_eq!(unreal.kind, EngineKind::Unreal);
        assert_eq!(unreal.project_version.as_deref(), Some("5.6"));
        assert_eq!(unreal.editor_build_target.as_deref(), Some("CustomBuild"));
        assert_eq!(unreal.manual_preset_id, None);

        write(
            &workspace,
            "Source/Other.Target.cs",
            "Type = TargetType.Editor;\n",
        );
        assert!(inspect(&workspace, &[], None)
            .unwrap()
            .editor_build_target
            .is_none());
        write(&workspace, "Island.uefnproject", "{}");
        write(&workspace, "Source/Game.cpp", "int x;\n");
        assert!(inspect(&workspace, &[], None).is_none());
        let island = inspect(&workspace, &[], Some("Island.uefnproject")).unwrap();
        assert_eq!(island.kind, EngineKind::Uefn);
        assert_eq!(island.manual_preset_id, Some("ue6_verse"));
        assert_eq!(
            inspect(&workspace, &["Game.uproject:1".into()], None)
                .unwrap()
                .kind,
            EngineKind::Unreal
        );
        assert_eq!(
            inspect(
                &workspace,
                &["Source/Game.cpp".into(), "Game.uproject".into()],
                None
            )
            .unwrap()
            .kind,
            EngineKind::Unreal
        );
    }

    #[cfg(unix)]
    #[test]
    fn workspace_engine_never_reads_a_foreign_descriptor() {
        let directory = tempfile::tempdir().unwrap();
        let workspace = directory.path().canonicalize().unwrap();
        let outside = tempfile::tempdir().unwrap();
        write(outside.path(), "other.uproject", "{}");
        std::os::unix::fs::symlink(
            outside.path().join("other.uproject"),
            workspace.join("Local.uproject"),
        )
        .unwrap();
        assert!(inspect(&workspace, &[], None).is_none());
        assert!(inspect(&workspace, &[], Some("Local.uproject#L1")).is_none());
        write(&workspace, "..\\outside.uproject", "{}");
        assert!(inspect(&workspace, &[], Some("..\\outside.uproject")).is_none());
    }
}
