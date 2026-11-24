//! Runtime-owned, versioned documents. This grants no ordinary workspace write capability.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, OpenOptions};
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

static DOCUMENT_WRITER: Mutex<()> = Mutex::new(());
const GLOBAL_CHAT_KEY: &str = "__MAIN_GLOBAL_CHAT__";
const DOCUMENT_NOT_FOUND: &str = "PLAN_DOCUMENT_NOT_FOUND";
const LEGACY_PLAN_FILES: [&str; 5] = [
    "plan.md",
    "requirements.md",
    "design.md",
    "tasks.md",
    "bugfix.md",
];

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PlanDocumentOwner {
    pub workspace: Option<String>,
    pub session_key: String,
    pub session_epoch: String,
    pub turn_id: String,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PlanDocumentKind {
    Plan,
    RulesDraft,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PlanDocumentRef {
    pub owner: PlanDocumentOwner,
    pub document_id: String,
    pub revision: u64,
    pub content_hash: String,
    pub path: String,
    pub title: String,
    pub kind: PlanDocumentKind,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavePlanDocumentInput {
    pub owner: PlanDocumentOwner,
    pub document_id: String,
    pub expected_revision: u64,
    pub expected_content_hash: Option<String>,
    pub title: String,
    pub markdown: String,
    pub kind: PlanDocumentKind,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanDocumentScope {
    pub workspace: Option<String>,
    pub session_key: String,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanDocumentContent {
    #[serde(flatten)]
    pub reference: PlanDocumentRef,
    pub markdown: String,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanFileCleanup {
    pub removed_document_ids: Vec<String>,
    pub removed_legacy_files: usize,
}

fn hash(text: &str) -> String {
    format!("{:x}", Sha256::digest(text.as_bytes()))
}
fn safe_id(id: &str) -> Result<(), String> {
    if id.is_empty()
        || id.len() > 160
        || !id
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-')
    {
        return Err("PLAN_DOCUMENT_INVALID_ID".into());
    }
    Ok(())
}
fn check_directory(path: &Path, create: bool) -> Result<bool, String> {
    // Refuse symlinks at every storage component, including already existing ancestors.
    let mut current = PathBuf::new();
    for component in path.components() {
        current.push(component.as_os_str());
        match fs::symlink_metadata(&current) {
            Ok(meta) if meta.file_type().is_symlink() => {
                return Err("PLAN_DOCUMENT_UNTRUSTED_PATH".into())
            }
            Ok(meta) if !meta.is_dir() => return Err("PLAN_DOCUMENT_UNTRUSTED_PATH".into()),
            Ok(_) => (),
            Err(error) if error.kind() == ErrorKind::NotFound && create => {
                fs::create_dir(&current).map_err(|e| e.to_string())?
            }
            Err(error) if error.kind() == ErrorKind::NotFound => return Ok(false),
            Err(error) => return Err(error.to_string()),
        }
    }
    Ok(true)
}
fn normalized_workspace(value: Option<&str>) -> Result<Option<String>, String> {
    match value
        .map(str::trim)
        .filter(|s| !s.is_empty() && *s != GLOBAL_CHAT_KEY)
    {
        None => Ok(None),
        Some(raw) => {
            let path = Path::new(raw).canonicalize().map_err(|e| e.to_string())?;
            if !path.is_dir() {
                return Err("PLAN_DOCUMENT_WORKSPACE_MISSING".into());
            }
            Ok(Some(path.to_string_lossy().replace('\\', "/")))
        }
    }
}
fn root(
    app_data: &Path,
    workspace: Option<&str>,
    session_key: &str,
    create: bool,
) -> Result<Option<PathBuf>, String> {
    if session_key.trim().is_empty() {
        return Err("PLAN_DOCUMENT_OWNER_MISSING".into());
    }
    let path = match workspace {
        Some(workspace) => PathBuf::from(workspace).join(".MAIN").join("plans"),
        None => {
            // This root is supplied by the application host, never by the model.
            // A first global-chat plan may precede every other app-data writer.
            if create {
                fs::create_dir_all(app_data).map_err(|e| e.to_string())?;
            }
            let app_data = match app_data.canonicalize() {
                Ok(path) => path,
                Err(error) if !create && error.kind() == ErrorKind::NotFound => return Ok(None),
                Err(error) => return Err(error.to_string()),
            };
            app_data
                .join("sessions")
                .join("plans")
                .join(hash(session_key))
        }
    };
    Ok(Some(path))
}
fn normalized_owner(
    app_data: &Path,
    owner: &PlanDocumentOwner,
    create: bool,
) -> Result<(Option<PathBuf>, PlanDocumentOwner), String> {
    if owner.session_epoch.trim().is_empty() || owner.turn_id.trim().is_empty() {
        return Err("PLAN_DOCUMENT_OWNER_MISSING".into());
    }
    let workspace = normalized_workspace(owner.workspace.as_deref())?;
    let prefix = format!("{}:", workspace.as_deref().unwrap_or(GLOBAL_CHAT_KEY));
    if !owner.session_key.starts_with(&prefix) {
        return Err("PLAN_DOCUMENT_OWNER_MISMATCH".into());
    }
    let root = root(app_data, workspace.as_deref(), &owner.session_key, create)?;
    let mut owner = owner.clone();
    owner.workspace = workspace;
    Ok((root, owner))
}
fn read_ref(path: &Path) -> Result<PlanDocumentRef, String> {
    if !fs::symlink_metadata(path)
        .map_err(document_file_error)?
        .is_file()
    {
        return Err("PLAN_DOCUMENT_UNTRUSTED_PATH".into());
    }
    serde_json::from_slice(&fs::read(path).map_err(document_file_error)?).map_err(|e| e.to_string())
}
fn read_markdown(path: &Path, expected_hash: &str) -> Result<String, String> {
    if !fs::symlink_metadata(path)
        .map_err(document_file_error)?
        .is_file()
    {
        return Err("PLAN_DOCUMENT_UNTRUSTED_PATH".into());
    }
    let content = fs::read_to_string(path).map_err(document_file_error)?;
    if hash(&content) != expected_hash {
        return Err("PLAN_DOCUMENT_HASH_MISMATCH".into());
    }
    Ok(content)
}

fn document_file_error(error: std::io::Error) -> String {
    if error.kind() == ErrorKind::NotFound {
        return DOCUMENT_NOT_FOUND.into();
    }
    error.to_string()
}

pub fn save(app_data: &Path, input: SavePlanDocumentInput) -> Result<PlanDocumentRef, String> {
    let _guard = DOCUMENT_WRITER
        .lock()
        .map_err(|_| "PLAN_DOCUMENT_LOCK_POISONED".to_string())?;
    safe_id(&input.document_id)?;
    let (root, owner) = normalized_owner(app_data, &input.owner, true)?;
    let directory = root.ok_or(DOCUMENT_NOT_FOUND)?.join(&input.document_id);
    check_directory(&directory, true)?;
    let manifest = directory.join("document.json");
    let current = if manifest.exists() {
        Some(read_ref(&manifest)?)
    } else {
        None
    };
    if let Some(current) = &current {
        if current.owner != owner || current.kind != input.kind {
            return Err("PLAN_DOCUMENT_OWNER_MISMATCH".into());
        }
        read_markdown(
            &directory.join(format!("rev-{}.md", current.revision)),
            &current.content_hash,
        )?;
        if current.revision != input.expected_revision
            || input.expected_content_hash.as_deref() != Some(current.content_hash.as_str())
        {
            // A lost acknowledgement can retry its exact already committed revision.
            if current.revision == input.expected_revision.saturating_add(1)
                && current.content_hash == hash(&input.markdown)
                && current.title == input.title
            {
                return Ok(current.clone());
            }
            return Err("PLAN_DOCUMENT_REVISION_CONFLICT".into());
        }
    } else if input.expected_revision != 0 || input.expected_content_hash.is_some() {
        return Err("PLAN_DOCUMENT_REVISION_CONFLICT".into());
    }
    let revision = input
        .expected_revision
        .checked_add(1)
        .ok_or("PLAN_DOCUMENT_REVISION_CONFLICT")?;
    let path = directory.join(format!("rev-{revision}.md"));
    match OpenOptions::new().write(true).create_new(true).open(&path) {
        Ok(mut file) => {
            file.write_all(input.markdown.as_bytes())
                .map_err(|e| e.to_string())?;
            file.sync_all().map_err(|e| e.to_string())?;
        }
        Err(error) if error.kind() == ErrorKind::AlreadyExists => {
            read_markdown(&path, &hash(&input.markdown))?;
        }
        Err(error) => return Err(error.to_string()),
    }
    let reference = PlanDocumentRef {
        owner,
        document_id: input.document_id,
        revision,
        content_hash: hash(&input.markdown),
        path: path.to_string_lossy().into_owned(),
        title: input.title,
        kind: input.kind,
    };
    // Each revision retains its own immutable reference for historical reads.
    let historical = directory.join(format!("rev-{revision}.json"));
    let bytes = serde_json::to_vec(&reference).map_err(|e| e.to_string())?;
    if historical.exists() {
        let previous = read_ref(&historical)?;
        if previous != reference {
            return Err("PLAN_DOCUMENT_REVISION_CONFLICT".into());
        }
    } else {
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&historical)
            .map_err(|e| e.to_string())?;
        file.write_all(&bytes).map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
    }
    let mut temp = tempfile::NamedTempFile::new_in(&directory).map_err(|e| e.to_string())?;
    temp.write_all(&bytes).map_err(|e| e.to_string())?;
    temp.as_file().sync_all().map_err(|e| e.to_string())?;
    temp.persist(&manifest).map_err(|e| e.to_string())?;
    Ok(reference)
}

pub fn read(app_data: &Path, reference: PlanDocumentRef) -> Result<PlanDocumentContent, String> {
    safe_id(&reference.document_id)?;
    let (root, owner) = normalized_owner(app_data, &reference.owner, false)?;
    let directory = root.ok_or(DOCUMENT_NOT_FOUND)?.join(&reference.document_id);
    if !check_directory(&directory, false)? {
        return Err(DOCUMENT_NOT_FOUND.into());
    }
    let actual = read_ref(&directory.join(format!("rev-{}.json", reference.revision)))?;
    if actual.owner != owner || actual != reference {
        return Err("PLAN_DOCUMENT_OWNER_OR_VERSION_MISMATCH".into());
    }
    let path = directory.join(format!("rev-{}.md", actual.revision));
    if path.to_string_lossy() != actual.path {
        return Err("PLAN_DOCUMENT_UNTRUSTED_PATH".into());
    }
    let markdown = read_markdown(&path, &actual.content_hash)?;
    Ok(PlanDocumentContent {
        reference: actual,
        markdown,
    })
}

pub fn list(app_data: &Path, scope: PlanDocumentScope) -> Result<Vec<PlanDocumentRef>, String> {
    let workspace = normalized_workspace(scope.workspace.as_deref())?;
    let mut result = Vec::new();
    let Some(root) = root(app_data, workspace.as_deref(), &scope.session_key, false)? else {
        return Ok(result);
    };
    if !check_directory(&root, false)? {
        return Ok(result);
    }
    for entry in fs::read_dir(root).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if !entry.file_type().map_err(|e| e.to_string())?.is_dir() {
            continue;
        }
        let manifest = entry.path().join("document.json");
        if !manifest.is_file() {
            continue;
        }
        let reference = read_ref(&manifest)?;
        if reference.owner.session_key == scope.session_key {
            read(app_data, reference.clone())?;
            result.push(reference);
        }
    }
    result.sort_by(|a, b| a.document_id.cmp(&b.document_id));
    Ok(result)
}

fn remove_regular_file(path: &Path) -> Result<bool, String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_file() => {
            fs::remove_file(path).map_err(|error| error.to_string())?;
            Ok(true)
        }
        Ok(_) => Ok(false),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error.to_string()),
    }
}

fn revision_path(directory: &Path, revision: u64) -> PathBuf {
    directory.join(format!("rev-{revision}.md"))
}

fn matches_plan_file(reference: &PlanDocumentRef, directory: &Path, id: &str) -> bool {
    reference.kind == PlanDocumentKind::Plan
        && reference.document_id == id
        && reference.revision > 0
        && reference.path == revision_path(directory, reference.revision).to_string_lossy()
}

fn remove_versioned_plans(
    plans: &Path,
    workspace: Option<&str>,
    session_key: Option<&str>,
    protected_turn_ids: &[String],
) -> Result<Vec<String>, String> {
    let mut removed = Vec::new();
    if !check_directory(plans, false)? {
        return Ok(removed);
    }
    let owner_prefix = format!("{}:", workspace.unwrap_or(GLOBAL_CHAT_KEY));
    for entry in fs::read_dir(plans).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        if !entry
            .file_type()
            .map_err(|error| error.to_string())?
            .is_dir()
        {
            continue;
        }
        let name = entry.file_name();
        let Some(id) = name.to_str() else { continue };
        if safe_id(id).is_err() {
            continue;
        }
        let directory = entry.path();
        let manifest_path = directory.join("document.json");
        let Ok(manifest) = read_ref(&manifest_path) else {
            continue;
        };
        if !matches_plan_file(&manifest, &directory, id)
            || manifest.owner.workspace.as_deref() != workspace
            || !manifest.owner.session_key.starts_with(&owner_prefix)
            || manifest.owner.session_epoch.trim().is_empty()
            || manifest.owner.turn_id.trim().is_empty()
            || session_key.is_some_and(|key| key != manifest.owner.session_key)
            || protected_turn_ids.contains(&manifest.owner.turn_id)
        {
            continue;
        }

        // Delete only files that have a runtime document reference. Unrelated
        // files or subdirectories added under a plan directory must survive.
        for revision in fs::read_dir(&directory).map_err(|error| error.to_string())? {
            let path = revision.map_err(|error| error.to_string())?.path();
            if !path
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with("rev-") && name.ends_with(".json"))
            {
                continue;
            }
            let Ok(reference) = read_ref(&path) else {
                continue;
            };
            if reference.owner == manifest.owner
                && matches_plan_file(&reference, &directory, id)
                && path == directory.join(format!("rev-{}.json", reference.revision))
            {
                remove_regular_file(&revision_path(&directory, reference.revision))?;
                remove_regular_file(&path)?;
            }
        }
        remove_regular_file(&revision_path(&directory, manifest.revision))?;
        remove_regular_file(&manifest_path)?;
        match fs::remove_dir(&directory) {
            Ok(()) => (),
            Err(error) if error.kind() == ErrorKind::DirectoryNotEmpty => (),
            Err(error) => return Err(error.to_string()),
        }
        removed.push(id.to_owned());
    }
    removed.sort();
    Ok(removed)
}

fn remove_legacy_plans(plans: &Path) -> Result<usize, String> {
    if !check_directory(plans, false)? {
        return Ok(0);
    }
    let mut removed = 0;
    for name in LEGACY_PLAN_FILES {
        removed += usize::from(remove_regular_file(&plans.join(name))?);
    }
    Ok(removed)
}

pub fn cleanup_workspace(
    workspace: &Path,
    protected_turn_ids: &[String],
) -> Result<PlanFileCleanup, String> {
    let _guard = DOCUMENT_WRITER
        .lock()
        .map_err(|_| "PLAN_DOCUMENT_LOCK_POISONED".to_string())?;
    let workspace = workspace
        .to_str()
        .ok_or("PLAN_DOCUMENT_WORKSPACE_MISSING")?;
    let workspace =
        normalized_workspace(Some(workspace))?.ok_or("PLAN_DOCUMENT_WORKSPACE_MISSING")?;
    let plans = Path::new(&workspace).join(".MAIN").join("plans");
    Ok(PlanFileCleanup {
        removed_document_ids: remove_versioned_plans(
            &plans,
            Some(&workspace),
            None,
            protected_turn_ids,
        )?,
        removed_legacy_files: remove_legacy_plans(&plans)?,
    })
}

pub fn cleanup_global_session(
    app_data: &Path,
    session_key: &str,
    legacy_plans: &Path,
    protected_turn_ids: &[String],
) -> Result<PlanFileCleanup, String> {
    let _guard = DOCUMENT_WRITER
        .lock()
        .map_err(|_| "PLAN_DOCUMENT_LOCK_POISONED".to_string())?;
    let removed_document_ids = match root(app_data, None, session_key, false)? {
        Some(plans) => remove_versioned_plans(&plans, None, Some(session_key), protected_turn_ids)?,
        None => Vec::new(),
    };
    Ok(PlanFileCleanup {
        removed_document_ids,
        removed_legacy_files: remove_legacy_plans(legacy_plans)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn input(workspace: Option<&Path>) -> SavePlanDocumentInput {
        let workspace = workspace.map(|p| p.canonicalize().unwrap().to_string_lossy().into_owned());
        let key = format!(
            "{}:s1",
            workspace.as_deref().unwrap_or("__MAIN_GLOBAL_CHAT__")
        );
        SavePlanDocumentInput {
            owner: PlanDocumentOwner {
                workspace,
                session_key: key,
                session_epoch: "epoch-1".into(),
                turn_id: "turn-1".into(),
            },
            document_id: "doc-1".into(),
            expected_revision: 0,
            expected_content_hash: None,
            title: "Plan".into(),
            markdown: "# Plan\n".into(),
            kind: PlanDocumentKind::Plan,
        }
    }
    #[test]
    fn first_global_document_initializes_its_application_data_directory() {
        let parent = tempfile::tempdir().unwrap();
        let application_data = parent.path().join("new-application-data");
        assert!(!application_data.exists());
        let reference = save(&application_data, input(None)).unwrap();
        assert_eq!(
            read(&application_data, reference).unwrap().markdown,
            "# Plan\n"
        );
    }
    #[test]
    fn document_revisions_are_owner_hash_and_cas_bound_in_both_scopes() {
        let app = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        for scope in [None, Some(workspace.path())] {
            let first = input(scope);
            let original = save(app.path(), first.clone()).unwrap();
            assert!(read(app.path(), original.clone())
                .unwrap()
                .markdown
                .contains("Plan"));
            assert_eq!(save(app.path(), first).unwrap(), original);
            let mut next = input(scope);
            next.expected_revision = 1;
            next.expected_content_hash = Some(original.content_hash.clone());
            next.markdown = "# Revised\n".into();
            let second = save(app.path(), next.clone()).unwrap();
            assert_eq!(second.revision, 2);
            assert!(save(app.path(), next).is_ok());
            assert_eq!(
                read(app.path(), original.clone())
                    .unwrap()
                    .reference
                    .revision,
                1
            );
            let mut stale = input(scope);
            stale.markdown = "stale overwrite".into();
            assert!(save(app.path(), stale).unwrap_err().contains("CONFLICT"));
            let mut wrong = second.clone();
            wrong.owner.session_epoch = "epoch-2".into();
            assert!(read(app.path(), wrong).is_err());
            fs::write(&second.path, "tampered").unwrap();
            assert!(read(app.path(), second)
                .unwrap_err()
                .contains("HASH_MISMATCH"));
        }
    }

    #[test]
    fn workspace_cleanup_removes_owned_history_and_keeps_other_content() {
        let app = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let mut save_input = input(Some(workspace.path()));
        let first = save(app.path(), save_input.clone()).unwrap();
        save_input.expected_revision = first.revision;
        save_input.expected_content_hash = Some(first.content_hash.clone());
        save_input.markdown = "# revised".into();
        let second = save(app.path(), save_input).unwrap();
        let folder = Path::new(&first.path).parent().unwrap();
        let plans = folder.parent().unwrap();
        let mut other = input(Some(workspace.path()));
        other.document_id = "protected-plan".into();
        other.owner.turn_id = "protected-turn".into();
        let protected = save(app.path(), other.clone()).unwrap();
        other.document_id = "rules-draft".into();
        other.kind = PlanDocumentKind::RulesDraft;
        let rules = save(app.path(), other).unwrap();
        let mut other_session = input(Some(workspace.path()));
        other_session.document_id = "other-session-plan".into();
        other_session.owner.session_key.push('2');
        let other_plan = save(app.path(), other_session).unwrap();
        let other_folder = Path::new(&other_plan.path).parent().unwrap();
        fs::write(other_folder.join("notes.md"), "keep").unwrap();
        fs::write(
            other_folder.join("rev-99.md"),
            "unowned revision-shaped file",
        )
        .unwrap();
        fs::create_dir(plans.join("unrelated-folder")).unwrap();
        fs::write(plans.join("unrelated-folder/document.json"), "keep").unwrap();
        fs::write(plans.join("plan.md"), "legacy plan").unwrap();
        fs::write(plans.join("notes.md"), "keep").unwrap();

        let removed =
            cleanup_workspace(workspace.path(), &[protected.owner.turn_id.clone()]).unwrap();
        assert_eq!(
            removed.removed_document_ids,
            ["doc-1", "other-session-plan"]
        );
        assert_eq!(removed.removed_legacy_files, 1);
        assert!(read(app.path(), second).is_err());
        assert_eq!(
            read(app.path(), first.clone()).unwrap_err(),
            "PLAN_DOCUMENT_NOT_FOUND"
        );
        assert!(
            !folder.exists(),
            "reads must not recreate deleted plan directories"
        );
        assert!(!plans.join("plan.md").exists());
        assert!(plans.join("notes.md").is_file());
        assert!(plans.join("unrelated-folder/document.json").is_file());
        assert!(other_folder.join("notes.md").is_file());
        assert!(other_folder.join("rev-99.md").is_file());
        assert!(!other_folder.join("document.json").exists());
        assert!(!other_folder.join("rev-1.json").exists());
        assert!(!Path::new(&other_plan.path).exists());
        assert_eq!(
            read(app.path(), other_plan).unwrap_err(),
            DOCUMENT_NOT_FOUND
        );
        assert!(read(app.path(), protected).is_ok());
        assert!(read(app.path(), rules).is_ok());
    }

    #[test]
    fn global_cleanup_removes_only_selected_session_and_leaves_missing_storage_absent() {
        let app = tempfile::tempdir().unwrap();
        let missing_app_data = app.path().join("new-application-data");
        let temp = tempfile::tempdir().unwrap();
        let legacy_plans = temp.path().canonicalize().unwrap().join(".MAIN/plans");
        let first = input(None);
        let scope = PlanDocumentScope {
            workspace: None,
            session_key: first.owner.session_key.clone(),
        };
        assert!(list(&missing_app_data, scope).unwrap().is_empty());
        assert!(cleanup_global_session(
            &missing_app_data,
            &first.owner.session_key,
            &legacy_plans,
            &[]
        )
        .unwrap()
        .removed_document_ids
        .is_empty());
        assert!(!missing_app_data.exists());
        assert!(!legacy_plans.exists());

        let original = save(app.path(), first.clone()).unwrap();
        let mut other = first;
        other.owner.session_key.push('2');
        let other_document = save(app.path(), other).unwrap();
        fs::create_dir_all(&legacy_plans).unwrap();
        fs::write(legacy_plans.join("plan.md"), "legacy plan").unwrap();
        fs::write(legacy_plans.join("notes.md"), "keep").unwrap();
        let removed =
            cleanup_global_session(app.path(), &original.owner.session_key, &legacy_plans, &[])
                .unwrap();
        assert_eq!(removed.removed_document_ids, ["doc-1"]);
        assert_eq!(removed.removed_legacy_files, 1);
        assert!(read(app.path(), original).is_err());
        assert!(read(app.path(), other_document).is_ok());
        assert!(legacy_plans.join("notes.md").is_file());
    }

    #[cfg(unix)]
    #[test]
    fn document_storage_never_follows_project_plan_symlink() {
        let app = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        fs::create_dir(workspace.path().join(".MAIN")).unwrap();
        std::os::unix::fs::symlink(outside.path(), workspace.path().join(".MAIN/plans")).unwrap();
        assert!(save(app.path(), input(Some(workspace.path())))
            .unwrap_err()
            .contains("UNTRUSTED_PATH"));
        fs::write(outside.path().join("plan.md"), "keep").unwrap();
        assert!(cleanup_workspace(workspace.path(), &[])
            .unwrap_err()
            .contains("UNTRUSTED_PATH"));
        assert!(outside.path().join("plan.md").is_file());
    }

    #[cfg(unix)]
    #[test]
    fn cleanup_never_follows_symlinks_inside_plans() {
        use std::os::unix::fs::symlink;

        let app = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let reference = save(app.path(), input(Some(workspace.path()))).unwrap();
        let folder = Path::new(&reference.path).parent().unwrap();
        let plans = folder.parent().unwrap();
        let outside_file = outside.path().join("keep.md");
        fs::write(&outside_file, "keep").unwrap();
        fs::remove_file(&reference.path).unwrap();
        symlink(&outside_file, &reference.path).unwrap();
        symlink(outside.path(), plans.join("outside-folder")).unwrap();
        symlink(&outside_file, plans.join("plan.md")).unwrap();

        let removed = cleanup_workspace(workspace.path(), &[]).unwrap();
        assert_eq!(removed.removed_document_ids, ["doc-1"]);
        assert_eq!(removed.removed_legacy_files, 0);
        assert_eq!(fs::read_to_string(&outside_file).unwrap(), "keep");
        assert!(plans.join("outside-folder").is_symlink());
        assert!(plans.join("plan.md").is_symlink());
        assert!(Path::new(&reference.path).is_symlink());
    }
}
