//! Standard Skill discovery and read-only resources. Discovery does not grant
//! shell execution, workspace writes, or authority to choose an arbitrary root.
use serde::Serialize;
use std::{
    collections::{HashMap, HashSet},
    fs::{self, File},
    io::Read,
    path::{Component, Path, PathBuf},
    sync::{Mutex, OnceLock},
};
use walkdir::WalkDir;

const MAX_TEXT_BYTES: u64 = 256_000;
const MAX_SKILLS_PER_ROOT: usize = 512;
const SKILL_SOURCES: [&str; 4] = ["codex", "claude", "gemini", "custom"];

#[cfg(test)]
thread_local! {
    static SCANNED_SKILL_ROOTS: std::cell::RefCell<Vec<PathBuf>> = const { std::cell::RefCell::new(Vec::new()) };
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DiscoveredPersonalAgentSkill {
    pub(crate) entry_path: String,
    pub(crate) base_path: String,
    pub(crate) content: String,
    pub(crate) openai_yaml: Option<String>,
    pub(crate) supporting_files: Vec<String>,
    pub(crate) platform_source: String,
    pub(crate) scope: String,
}

fn admitted_entries() -> &'static Mutex<HashMap<PathBuf, PathBuf>> {
    static ENTRIES: OnceLock<Mutex<HashMap<PathBuf, PathBuf>>> = OnceLock::new();
    ENTRIES.get_or_init(|| Mutex::new(HashMap::new()))
}

fn read_text(path: &Path, limit: u64) -> Result<String, String> {
    let metadata = fs::symlink_metadata(path).map_err(|error| error.to_string())?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > limit {
        return Err("SKILL_RESOURCE_UNAVAILABLE: expected bounded regular UTF-8 text".into());
    }
    let file = File::open(path).map_err(|error| error.to_string())?;
    if !file
        .metadata()
        .map_err(|error| error.to_string())?
        .is_file()
    {
        return Err("SKILL_RESOURCE_UNAVAILABLE: expected a regular file".into());
    }
    let mut bytes = Vec::new();
    file.take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    if bytes.len() as u64 > limit || bytes.len() as u64 != metadata.len() {
        return Err("SKILL_RESOURCE_UNAVAILABLE: resource changed or exceeded its bound".into());
    }
    if bytes.contains(&0) {
        return Err("SKILL_RESOURCE_UNAVAILABLE: binary resource".into());
    }
    String::from_utf8(bytes).map_err(|_| "SKILL_RESOURCE_UNAVAILABLE: resource is not UTF-8".into())
}

pub(crate) fn discover_agent_skills_in_root(
    root: &Path,
) -> Result<Vec<DiscoveredPersonalAgentSkill>, String> {
    #[cfg(test)]
    SCANNED_SKILL_ROOTS.with(|roots| roots.borrow_mut().push(root.to_path_buf()));
    if !root.exists() {
        return Ok(Vec::new());
    }
    let root = root.canonicalize().map_err(|error| error.to_string())?;
    if !root.is_dir() {
        return Ok(Vec::new());
    }
    let mut entries = WalkDir::new(root)
        .min_depth(2)
        .max_depth(8)
        // The standard root may contain links to independently maintained Skills.
        // Only the resolved Skill base is admitted; descendant links are rejected.
        .follow_links(true)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|entry| {
            entry.file_type().is_file()
                && entry
                    .file_name()
                    .to_string_lossy()
                    .eq_ignore_ascii_case("SKILL.md")
        })
        .take(MAX_SKILLS_PER_ROOT)
        .filter_map(|entry| {
            // A directory alias is a supported installation. A SKILL.md leaf
            // alias must not turn the target file's parent into a Skill base.
            if fs::symlink_metadata(entry.path())
                .ok()?
                .file_type()
                .is_symlink()
            {
                return None;
            }
            let entry_path = entry.path().canonicalize().ok()?;
            let base_path = entry_path.parent()?.to_path_buf();
            let content = read_text(&entry_path, MAX_TEXT_BYTES).ok()?;
            if content.trim().is_empty() {
                return None;
            }
            let config = safe_resource_path(&base_path, "agents/openai.yaml").ok();
            let openai_yaml = config.and_then(|path| read_text(&path, 32_000).ok());
            let mut supporting_files = WalkDir::new(&base_path)
                .min_depth(1)
                .max_depth(5)
                .follow_links(false)
                .into_iter()
                .filter_map(Result::ok)
                .filter(|entry| entry.file_type().is_file())
                .map(|entry| entry.path().to_path_buf())
                .filter(|path| path != &entry_path && path != &base_path.join("agents/openai.yaml"))
                .map(|path| path.to_string_lossy().into_owned())
                .take(10)
                .collect::<Vec<_>>();
            supporting_files.sort();
            supporting_files.truncate(10);
            Some(DiscoveredPersonalAgentSkill {
                entry_path: entry_path.to_string_lossy().into_owned(),
                base_path: base_path.to_string_lossy().into_owned(),
                content,
                openai_yaml,
                supporting_files,
                platform_source: "custom".into(),
                scope: "personal".into(),
            })
        })
        .collect::<Vec<_>>();
    entries.sort_by(|left, right| left.entry_path.cmp(&right.entry_path));
    Ok(entries)
}

fn validated_sources(requested: Option<Vec<String>>) -> Result<HashSet<String>, String> {
    let sources = requested.unwrap_or_else(|| {
        SKILL_SOURCES
            .iter()
            .map(|source| (*source).into())
            .collect()
    });
    if sources
        .iter()
        .any(|source| !SKILL_SOURCES.contains(&source.as_str()))
    {
        return Err("Unsupported Skill source; use codex, claude, gemini or custom".into());
    }
    Ok(sources.into_iter().collect())
}

#[cfg(test)]
fn discover_at(home: &Path, workspace: Option<&Path>) -> Vec<DiscoveredPersonalAgentSkill> {
    discover_at_enabled(home, workspace, &validated_sources(None).unwrap())
}

fn discover_at_enabled(
    home: &Path,
    workspace: Option<&Path>,
    enabled_sources: &HashSet<String>,
) -> Vec<DiscoveredPersonalAgentSkill> {
    let canonical_workspace = workspace.and_then(|path| path.canonicalize().ok());
    let mut roots = Vec::new();
    if let Some(workspace) = workspace {
        if enabled_sources.contains("codex") {
            roots.push((workspace.join(".agents/skills"), "codex", "workspace"));
        }
        if enabled_sources.contains("claude") {
            roots.push((workspace.join(".claude/skills"), "claude", "workspace"));
        }
    }
    if enabled_sources.contains("codex") {
        roots.extend([
            (home.join(".agents/skills"), "codex", "personal"),
            (home.join(".codex/skills"), "codex", "personal"),
        ]);
    }
    if enabled_sources.contains("claude") {
        roots.push((home.join(".claude/skills"), "claude", "personal"));
    }
    if enabled_sources.contains("gemini") {
        let plugins = home.join(".gemini/config/plugins");
        if let Ok(entries) = fs::read_dir(plugins) {
            let mut plugins = entries
                .filter_map(Result::ok)
                .map(|entry| entry.path())
                .collect::<Vec<_>>();
            plugins.sort();
            roots.extend(
                plugins
                    .into_iter()
                    .map(|plugin| (plugin.join("skills"), "gemini", "personal")),
            );
        }
        roots.push((
            home.join(".gemini/antigravity/builtin/skills"),
            "gemini",
            "personal",
        ));
    }
    let mut identities = HashSet::new();
    roots
        .into_iter()
        .flat_map(|(root, platform, scope)| {
            discover_agent_skills_in_root(&root)
                .unwrap_or_default()
                .into_iter()
                .map(move |mut entry| {
                    entry.platform_source = platform.into();
                    entry.scope = scope.into();
                    entry
                })
        })
        .filter(|entry| {
            entry.scope != "workspace"
                || canonical_workspace
                    .as_ref()
                    .is_some_and(|workspace| Path::new(&entry.entry_path).starts_with(workspace))
        })
        .filter(|entry| identities.insert(entry.entry_path.clone()))
        .collect()
}

#[tauri::command]
pub(crate) fn discover_personal_agent_skills(
    workspace: Option<String>,
    enabled_sources: Option<Vec<String>>,
) -> Result<Vec<DiscoveredPersonalAgentSkill>, String> {
    let enabled_sources = validated_sources(enabled_sources)?;
    let Some(home) = super::user_home_dir() else {
        return Ok(Vec::new());
    };
    let workspace = workspace
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .map(Path::new);
    let entries = discover_at_enabled(&home, workspace, &enabled_sources);
    let mut registry = admitted_entries()
        .lock()
        .map_err(|_| "Skill registry unavailable")?;
    // Retain other active workspaces' discoveries, removing entries whose base
    // no longer exists. This registry is guidance authority only.
    registry.retain(|entry, base| entry.is_file() && base.is_dir());
    for entry in &entries {
        registry.insert(
            PathBuf::from(&entry.entry_path),
            PathBuf::from(&entry.base_path),
        );
    }
    Ok(entries)
}

fn safe_resource_path(base: &Path, relative: &str) -> Result<PathBuf, String> {
    if relative.is_empty()
        || relative.len() > 4_096
        || relative.contains(['\\', '\0', ':'])
        || relative
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
    {
        return Err("SKILL_RESOURCE_PATH_INVALID: expected a Skill-relative path".into());
    }
    let relative = Path::new(relative);
    if relative.is_absolute()
        || relative
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
    {
        return Err("SKILL_RESOURCE_PATH_INVALID: expected a Skill-relative path".into());
    }
    let base = base.canonicalize().map_err(|error| error.to_string())?;
    let mut path = base.clone();
    for component in relative.components() {
        path.push(component);
        let metadata = fs::symlink_metadata(&path).map_err(|error| error.to_string())?;
        if metadata.file_type().is_symlink() || (!metadata.is_file() && !metadata.is_dir()) {
            return Err(
                "SKILL_RESOURCE_PATH_INVALID: links and special files are unavailable".into(),
            );
        }
    }
    let path = path.canonicalize().map_err(|error| error.to_string())?;
    if !path.starts_with(base) {
        return Err("SKILL_RESOURCE_PATH_INVALID: resource escaped Skill base".into());
    }
    Ok(path)
}

#[tauri::command]
pub(crate) fn read_agent_skill_resource(
    entry_path: String,
    relative_path: String,
) -> Result<String, String> {
    let base = admitted_entries()
        .lock()
        .map_err(|_| "Skill registry unavailable")?
        .get(Path::new(&entry_path))
        .cloned()
        .ok_or("SKILL_RESOURCE_NOT_ADMITTED: discover the Skill before loading resources")?;
    let entry = Path::new(&entry_path);
    if entry.parent() != Some(base.as_path()) || entry.canonicalize().ok().as_deref() != Some(entry)
    {
        return Err("SKILL_RESOURCE_NOT_ADMITTED: discovered entry identity changed".into());
    }
    read_text(&safe_resource_path(&base, &relative_path)?, MAX_TEXT_BYTES)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn disabled_skill_sources_skip_their_roots_before_discovery() {
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("home");
        let workspace = root.path().join("project");
        for path in [
            home.join(".agents/skills/codex"),
            home.join(".claude/skills/claude"),
            home.join(".gemini/config/plugins/pkg/skills/gemini"),
            workspace.join(".agents/skills/project-codex"),
            workspace.join(".claude/skills/project-claude"),
        ] {
            fs::create_dir_all(&path).unwrap();
            fs::write(path.join("SKILL.md"), "# Instructions\n").unwrap();
        }
        SCANNED_SKILL_ROOTS.with(|roots| roots.borrow_mut().clear());
        let sources = validated_sources(Some(vec!["codex".into()])).unwrap();
        let entries = discover_at_enabled(&home, Some(&workspace), &sources);
        assert_eq!(entries.len(), 2);
        assert!(entries.iter().all(|entry| entry.platform_source == "codex"));
        SCANNED_SKILL_ROOTS.with(|roots| {
            assert!(roots
                .borrow()
                .iter()
                .all(|path| !path.to_string_lossy().contains(".claude")
                    && !path.to_string_lossy().contains(".gemini")))
        });
        SCANNED_SKILL_ROOTS.with(|roots| roots.borrow_mut().clear());
        let empty = validated_sources(Some(Vec::new())).unwrap();
        assert!(discover_at_enabled(&home, Some(&workspace), &empty).is_empty());
        SCANNED_SKILL_ROOTS.with(|roots| assert!(roots.borrow().is_empty()));
    }

    #[test]
    fn discovery_source_arguments_only_accept_known_sources_and_default_to_all() {
        assert_eq!(validated_sources(None).unwrap().len(), 4);
        assert!(validated_sources(Some(Vec::new())).unwrap().is_empty());
        assert_eq!(
            validated_sources(Some(vec!["claude".into(), "claude".into()]))
                .unwrap()
                .len(),
            1
        );
        for value in ["../codex", "antigravity", "Codex", ""] {
            assert!(validated_sources(Some(vec![value.into()])).is_err());
        }
    }

    #[test]
    fn discover_multiplatform_skills_preserves_scope_and_canonical_identity() {
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("home");
        let workspace = root.path().join("project");
        for path in [
            home.join(".agents/skills/one"),
            home.join(".codex/skills/two"),
            home.join(".claude/skills/three"),
            home.join(".gemini/config/plugins/pkg/skills/four"),
            home.join(".gemini/antigravity/builtin/skills/five"),
            workspace.join(".claude/skills/six"),
        ] {
            fs::create_dir_all(&path).unwrap();
            fs::write(path.join("SKILL.md"), "# Instructions\n").unwrap();
        }
        let entries = discover_at(&home, Some(&workspace));
        assert_eq!(entries.len(), 6);
        assert_eq!(
            entries
                .iter()
                .filter(|entry| entry.platform_source == "codex")
                .count(),
            2
        );
        assert_eq!(
            entries
                .iter()
                .filter(|entry| entry.platform_source == "claude")
                .count(),
            2
        );
        assert_eq!(
            entries
                .iter()
                .filter(|entry| entry.platform_source == "gemini")
                .count(),
            2
        );
        assert_eq!(entries[0].scope, "workspace");
    }

    #[test]
    fn discovered_resource_reader_is_lossless_bounded_and_admission_scoped() {
        let root = tempfile::tempdir().unwrap();
        let base = root.path().canonicalize().unwrap();
        let entry = base.join("SKILL.md");
        fs::write(&entry, "# Instructions\n").unwrap();
        fs::create_dir(base.join("references")).unwrap();
        fs::write(base.join("references/check.md"), "# Exact\r\nChecklist\r\n").unwrap();
        let read = |path: &str| {
            read_agent_skill_resource(entry.to_string_lossy().into_owned(), path.into())
        };
        assert!(read("references/check.md").is_err());
        admitted_entries()
            .lock()
            .unwrap()
            .insert(entry.clone(), base.clone());
        assert_eq!(
            read("references/check.md").unwrap(),
            "# Exact\r\nChecklist\r\n"
        );
        for path in [
            "../outside",
            "/outside",
            "references//check.md",
            "C:\\outside",
            "x\0",
        ] {
            assert!(read(path).is_err());
        }
        fs::write(
            base.join("large.md"),
            vec![b'x'; MAX_TEXT_BYTES as usize + 1],
        )
        .unwrap();
        fs::write(base.join("binary.bin"), [0, 1, 2]).unwrap();
        assert!(read("large.md").is_err());
        assert!(read("binary.bin").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn discovered_resources_reject_descendant_symlinks_and_special_files() {
        use std::os::unix::fs::symlink;
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("secret.md"), "outside").unwrap();
        symlink(outside.path(), root.path().join("references")).unwrap();
        assert!(safe_resource_path(root.path(), "references/secret.md").is_err());
        symlink("/dev/null", root.path().join("null")).unwrap();
        assert!(safe_resource_path(root.path(), "null").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn discovery_rejects_entry_leaf_links_and_workspace_directory_escapes() {
        use std::os::unix::fs::symlink;
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("home");
        let workspace = root.path().join("project");
        let external = root.path().join("external");
        fs::create_dir_all(&external).unwrap();
        fs::write(external.join("config"), "private configuration").unwrap();
        let fake = home.join(".agents/skills/fake");
        fs::create_dir_all(&fake).unwrap();
        symlink(external.join("config"), fake.join("SKILL.md")).unwrap();
        assert!(discover_at(&home, None).is_empty());
        fs::write(external.join("SKILL.md"), "# External skill\n").unwrap();
        fs::create_dir_all(workspace.join(".claude/skills")).unwrap();
        symlink(&external, workspace.join(".claude/skills/escape")).unwrap();
        assert!(discover_at(&home, Some(&workspace)).is_empty());
        symlink(&external, home.join(".agents/skills/installed")).unwrap();
        let entries = discover_at(&home, Some(&workspace));
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].scope, "personal");
        assert_eq!(
            entries[0].base_path,
            external.canonicalize().unwrap().to_string_lossy()
        );
    }
}
