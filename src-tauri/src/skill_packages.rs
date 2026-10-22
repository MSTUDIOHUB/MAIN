//! Immutable, content-addressed Skill resources. These roots are never workspaces.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Component, Path, PathBuf},
};
use tauri::{AppHandle, Manager};

const MAX_ENTRIES: usize = 2_048;
const MAX_PACKAGE_BYTES: u64 = 64 * 1024 * 1024;
const MAX_TEXT_BYTES: u64 = 256_000;
const MAX_MANIFEST_BYTES: u64 = 2 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ManifestFile {
    path: String,
    size_bytes: u64,
    sha256: String,
}

#[derive(Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PackageManifest {
    schema_version: u32,
    package_id: String,
    name: String,
    entry_points: Vec<String>,
    files: Vec<ManifestFile>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GlobalSkillPackageMeta {
    pub package_id: String,
    pub name: String,
    pub entry_point: String,
    pub entry_points: Vec<String>,
    pub files: Vec<String>,
    pub reused: bool,
}

fn is_package_id(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn relative_path(value: &str) -> Result<PathBuf, String> {
    if value.is_empty()
        || value.len() > 4_096
        || value.contains(['\\', '\0'])
        || value
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
    {
        return Err("Invalid Skill resource relative path".into());
    }
    let path = Path::new(value);
    if path.is_absolute()
        || path
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
    {
        return Err("Skill resource path must remain package-relative".into());
    }
    Ok(path.to_path_buf())
}

fn regular_directory(path: &Path) -> Result<PathBuf, String> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("Cannot inspect Skill directory: {error}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err("Skill directories must be real directories, not links".into());
    }
    path.canonicalize()
        .map_err(|error| format!("Cannot resolve Skill directory: {error}"))
}

fn store_root(app_data: &Path, create: bool) -> Result<PathBuf, String> {
    if create {
        fs::create_dir_all(app_data)
            .map_err(|error| format!("Cannot create app data directory: {error}"))?;
    }
    let app_data = regular_directory(app_data)?;
    let store = app_data.join("skill-packages");
    if create {
        match fs::create_dir(&store) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(format!("Cannot create Skill store: {error}")),
        }
    }
    let canonical = regular_directory(&store)?;
    if canonical.parent() != Some(app_data.as_path()) {
        return Err("Skill store escaped app data directory".into());
    }
    Ok(canonical)
}

/// Inspect every component before opening, including directories and the leaf.
fn resource_path(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let relative = relative_path(relative)?;
    let mut path = root.to_path_buf();
    for component in relative.components() {
        path.push(component.as_os_str());
        let metadata = fs::symlink_metadata(&path)
            .map_err(|error| format!("Cannot inspect Skill resource: {error}"))?;
        if metadata.file_type().is_symlink() || (!metadata.is_file() && !metadata.is_dir()) {
            return Err("Skill resources cannot contain links or special files".into());
        }
    }
    let canonical = path
        .canonicalize()
        .map_err(|error| format!("Cannot resolve Skill resource: {error}"))?;
    if !canonical.starts_with(root) {
        return Err("Skill resource escaped its package".into());
    }
    Ok(canonical)
}

fn read_regular(path: &Path, limit: u64) -> Result<Vec<u8>, String> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("Cannot inspect Skill file: {error}"))?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err("Skill resources must be regular files".into());
    }
    if metadata.len() > limit {
        return Err(format!("Skill file exceeds {limit} byte limit"));
    }
    let file = File::open(path).map_err(|error| format!("Cannot open Skill file: {error}"))?;
    if !file
        .metadata()
        .map_err(|error| error.to_string())?
        .is_file()
    {
        return Err("Skill resources must be regular files".into());
    }
    let mut bytes = Vec::new();
    file.take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("Cannot read Skill file: {error}"))?;
    if bytes.len() as u64 > limit || bytes.len() as u64 != metadata.len() {
        return Err("Skill resource exceeded its limit or changed during read".into());
    }
    Ok(bytes)
}

fn inventory(payload: &Path) -> Result<Vec<String>, String> {
    let root = regular_directory(payload)?;
    let mut files = Vec::new();
    let mut identities = HashSet::new();
    for (index, entry) in walkdir::WalkDir::new(&root)
        .min_depth(1)
        .follow_links(false)
        .into_iter()
        .enumerate()
    {
        if index >= MAX_ENTRIES {
            return Err("Skill package has too many entries".into());
        }
        let entry = entry.map_err(|error| format!("Cannot enumerate Skill package: {error}"))?;
        if entry.file_type().is_symlink()
            || (!entry.file_type().is_file() && !entry.file_type().is_dir())
        {
            return Err("Skill package contains a link or special file".into());
        }
        let relative = entry
            .path()
            .strip_prefix(&root)
            .map_err(|error| error.to_string())?
            .to_str()
            .ok_or("Skill resource paths must be UTF-8")?
            .replace(std::path::MAIN_SEPARATOR, "/");
        relative_path(&relative)?;
        if !identities.insert(relative.to_lowercase()) {
            return Err("Skill package contains ambiguous duplicate paths".into());
        }
        if entry.file_type().is_file() {
            files.push(relative);
        }
    }
    files.sort();
    if files.is_empty() {
        return Err("Skill package is empty".into());
    }
    Ok(files)
}

fn build_manifest(payload: &Path, name: String) -> Result<PackageManifest, String> {
    if name.trim().is_empty() || name.len() > 1_024 || name.contains('\0') {
        return Err("Invalid Skill package name".into());
    }
    let payload = regular_directory(payload)?;
    let paths = inventory(&payload)?;
    let entry_points = super::find_entry_points(&payload);
    if entry_points.is_empty() {
        return Err("Skill package must contain SKILL.md or a legacy program.md".into());
    }
    let mut tree = Sha256::new();
    let mut total = 0_u64;
    let mut files = Vec::new();
    for path in paths {
        let bytes = read_regular(
            &resource_path(&payload, &path)?,
            MAX_PACKAGE_BYTES.saturating_sub(total),
        )?;
        total += bytes.len() as u64;
        if entry_points.contains(&path) {
            if bytes.len() as u64 > MAX_TEXT_BYTES || std::str::from_utf8(&bytes).is_err() {
                return Err("Skill entry points must be bounded UTF-8 text".into());
            }
        }
        tree.update((path.len() as u64).to_be_bytes());
        tree.update(path.as_bytes());
        tree.update((bytes.len() as u64).to_be_bytes());
        tree.update(&bytes);
        files.push(ManifestFile {
            path,
            size_bytes: bytes.len() as u64,
            sha256: format!("{:x}", Sha256::digest(&bytes)),
        });
    }
    Ok(PackageManifest {
        schema_version: 1,
        package_id: format!("{:x}", tree.finalize()),
        name,
        entry_points,
        files,
    })
}

fn metadata(manifest: &PackageManifest, reused: bool) -> GlobalSkillPackageMeta {
    GlobalSkillPackageMeta {
        package_id: manifest.package_id.clone(),
        name: manifest.name.clone(),
        entry_point: manifest.entry_points[0].clone(),
        entry_points: manifest.entry_points.clone(),
        files: manifest
            .files
            .iter()
            .map(|file| file.path.clone())
            .collect(),
        reused,
    }
}

fn inspect_at_store(store: &Path, package_id: &str) -> Result<(PackageManifest, PathBuf), String> {
    if !is_package_id(package_id) {
        return Err("Invalid global Skill package ID".into());
    }
    let blob = regular_directory(&store.join(package_id))?;
    if blob.parent() != Some(store) {
        return Err("Skill package escaped managed store".into());
    }
    let manifest_path = resource_path(&blob, "manifest.json")?;
    let raw = read_regular(&manifest_path, MAX_MANIFEST_BYTES)?;
    let manifest: PackageManifest = serde_json::from_slice(&raw)
        .map_err(|error| format!("Invalid Skill package manifest: {error}"))?;
    if manifest.schema_version != 1 || manifest.package_id != package_id {
        return Err("Skill package manifest identity mismatch".into());
    }
    let payload = regular_directory(&blob.join("payload"))?;
    if payload.parent() != Some(blob.as_path()) {
        return Err("Skill payload escaped its package".into());
    }
    let observed = build_manifest(&payload, manifest.name.clone())?;
    if observed != manifest {
        return Err("Skill package contents do not match their immutable manifest".into());
    }
    Ok((manifest, payload))
}

fn publish(
    store: &Path,
    staging: tempfile::TempDir,
    name: String,
) -> Result<GlobalSkillPackageMeta, String> {
    let manifest = build_manifest(&staging.path().join("payload"), name)?;
    let bytes = serde_json::to_vec(&manifest).map_err(|error| error.to_string())?;
    if bytes.len() as u64 > MAX_MANIFEST_BYTES {
        return Err("Skill package manifest is too large".into());
    }
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(staging.path().join("manifest.json"))
        .map_err(|error| format!("Cannot create Skill manifest: {error}"))?;
    file.write_all(&bytes)
        .and_then(|()| file.sync_all())
        .map_err(|error| format!("Cannot save Skill manifest: {error}"))?;
    drop(file);
    // Verify staged bytes using exactly the same reader as a later inspection.
    let decoded: PackageManifest = serde_json::from_slice(&read_regular(
        &staging.path().join("manifest.json"),
        MAX_MANIFEST_BYTES,
    )?)
    .map_err(|error| error.to_string())?;
    if decoded != manifest
        || build_manifest(&staging.path().join("payload"), manifest.name.clone())? != manifest
    {
        return Err("Skill package changed while staging".into());
    }
    let destination = store.join(&manifest.package_id);
    if fs::symlink_metadata(&destination).is_ok() {
        return inspect_at_store(store, &manifest.package_id)
            .map(|(existing, _)| metadata(&existing, true));
    }
    match fs::rename(staging.path(), &destination) {
        Ok(()) => Ok(metadata(&manifest, false)),
        Err(error) => {
            // Another importer may have published the same immutable tree first.
            if fs::symlink_metadata(&destination).is_ok() {
                inspect_at_store(store, &manifest.package_id)
                    .map(|(existing, _)| metadata(&existing, true))
            } else {
                Err(format!("Cannot publish Skill package: {error}"))
            }
        }
    }
}

pub fn extract_global_skill_package_at(
    app_data: &Path,
    zip: &Path,
) -> Result<GlobalSkillPackageMeta, String> {
    let zip_metadata =
        fs::symlink_metadata(zip).map_err(|error| format!("Cannot inspect Skill ZIP: {error}"))?;
    if !zip_metadata.is_file()
        || zip_metadata.file_type().is_symlink()
        || zip_metadata.len() > 128 * 1024 * 1024
    {
        return Err("Skill ZIP must be a bounded regular file, not a link".into());
    }
    let store = store_root(app_data, true)?;
    let staging = tempfile::Builder::new()
        .prefix(".staging-")
        .tempdir_in(&store)
        .map_err(|error| error.to_string())?;
    // Reuse the workspace importer only as an isolated, temporary extraction sandbox.
    let extracted = super::extract_package_archive_in_workspace(staging.path(), zip)?;
    fs::rename(&extracted.target_dir, staging.path().join("payload"))
        .map_err(|error| error.to_string())?;
    fs::remove_dir(staging.path().join(".protocols")).map_err(|error| error.to_string())?;
    publish(&store, staging, extracted.name)
}

pub fn promote_legacy_skill_package_at(
    app_data: &Path,
    workspace: &Path,
    local_path: &str,
) -> Result<GlobalSkillPackageMeta, String> {
    if !workspace.is_absolute() {
        return Err("Legacy Skill promotion requires an explicit absolute workspace".into());
    }
    let relative = relative_path(local_path)?;
    let parts = relative.components().collect::<Vec<_>>();
    if parts.len() != 2 || parts[0].as_os_str() != ".protocols" {
        return Err("Legacy Skill promotion requires a .protocols/<slot> package".into());
    }
    let workspace = regular_directory(workspace)?;
    let source = resource_path(&workspace, local_path)?;
    let paths = inventory(&source)?;
    let store = store_root(app_data, true)?;
    let staging = tempfile::Builder::new()
        .prefix(".staging-")
        .tempdir_in(&store)
        .map_err(|error| error.to_string())?;
    let payload = staging.path().join("payload");
    fs::create_dir(&payload).map_err(|error| error.to_string())?;
    let mut total = 0_u64;
    for relative in paths {
        let bytes = read_regular(
            &resource_path(&source, &relative)?,
            MAX_PACKAGE_BYTES.saturating_sub(total),
        )?;
        total += bytes.len() as u64;
        let destination = payload.join(relative_path(&relative)?);
        fs::create_dir_all(
            destination
                .parent()
                .ok_or("Missing Skill resource parent")?,
        )
        .map_err(|error| error.to_string())?;
        fs::write(destination, bytes).map_err(|error| error.to_string())?;
    }
    let name = parts[1]
        .as_os_str()
        .to_str()
        .ok_or("Legacy Skill slot must be UTF-8")?
        .to_string();
    publish(&store, staging, name)
}

pub fn inspect_global_skill_package_at(
    app_data: &Path,
    package_id: &str,
) -> Result<GlobalSkillPackageMeta, String> {
    let store = store_root(app_data, false)?;
    inspect_at_store(&store, package_id).map(|(manifest, _)| metadata(&manifest, true))
}

pub fn read_global_skill_package_file_at(
    app_data: &Path,
    package_id: &str,
    relative: &str,
) -> Result<String, String> {
    relative_path(relative)?;
    let store = store_root(app_data, false)?;
    let (manifest, payload) = inspect_at_store(&store, package_id)?;
    let record = manifest
        .files
        .iter()
        .find(|file| file.path == relative)
        .ok_or("Skill resource is not in the package manifest")?;
    let bytes = read_regular(&resource_path(&payload, relative)?, MAX_TEXT_BYTES)?;
    if bytes.len() as u64 != record.size_bytes
        || format!("{:x}", Sha256::digest(&bytes)) != record.sha256
    {
        return Err("Skill resource changed after verification".into());
    }
    String::from_utf8(bytes).map_err(|_| "Skill resource is not UTF-8 text".into())
}

fn app_data(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|error| format!("Cannot locate app data directory: {error}"))
}

async fn package_io<T: Send + 'static>(
    operation: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(operation)
        .await
        .map_err(|error| format!("Skill package worker failed: {error}"))?
}

#[tauri::command]
pub async fn extract_global_skill_package(
    app: AppHandle,
    zip_path: String,
) -> Result<GlobalSkillPackageMeta, String> {
    let root = app_data(&app)?;
    package_io(move || extract_global_skill_package_at(&root, Path::new(&zip_path))).await
}

#[tauri::command]
pub async fn promote_legacy_skill_package(
    app: AppHandle,
    workspace: String,
    local_path: String,
) -> Result<GlobalSkillPackageMeta, String> {
    let root = app_data(&app)?;
    package_io(move || promote_legacy_skill_package_at(&root, Path::new(&workspace), &local_path))
        .await
}

#[tauri::command]
pub async fn inspect_global_skill_package(
    app: AppHandle,
    package_id: String,
) -> Result<GlobalSkillPackageMeta, String> {
    let root = app_data(&app)?;
    package_io(move || inspect_global_skill_package_at(&root, &package_id)).await
}

#[tauri::command]
pub async fn read_global_skill_package_file(
    app: AppHandle,
    package_id: String,
    relative_path: String,
) -> Result<String, String> {
    let root = app_data(&app)?;
    package_io(move || read_global_skill_package_file_at(&root, &package_id, &relative_path)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, io::Write};

    fn archive(path: &Path, entries: &[(&str, &[u8])]) {
        let mut writer = zip::ZipWriter::new(fs::File::create(path).unwrap());
        for (name, content) in entries {
            writer
                .start_file(*name, zip::write::SimpleFileOptions::default())
                .unwrap();
            writer.write_all(content).unwrap();
        }
        writer.finish().unwrap();
    }

    fn import_fixture(root: &Path) -> GlobalSkillPackageMeta {
        let zip = root.join("skills.zip");
        archive(
            &zip,
            &[
                ("a/SKILL.md", b"# alpha\n"),
                ("a/refs/detail.md", b"details\r\n"),
                ("b/SKILL.md", b"# beta"),
            ],
        );
        extract_global_skill_package_at(root, &zip).unwrap()
    }

    #[test]
    fn global_skill_packages_deduplicate_full_tree_independent_of_zip_name_and_order() {
        let root = tempfile::tempdir().unwrap();
        let first = import_fixture(root.path());
        let zip = root.path().join("different-name.zip");
        archive(
            &zip,
            &[
                ("b/SKILL.md", b"# beta"),
                ("a/refs/detail.md", b"details\r\n"),
                ("a/SKILL.md", b"# alpha\n"),
            ],
        );
        let second = extract_global_skill_package_at(root.path(), &zip).unwrap();
        assert_eq!(first.package_id, second.package_id);
        assert_eq!(first.package_id.len(), 64);
        assert!(!first.reused);
        assert!(second.reused);
        assert_eq!(first.entry_points, vec!["a/SKILL.md", "b/SKILL.md"]);
        assert_eq!(
            first.files,
            vec!["a/SKILL.md", "a/refs/detail.md", "b/SKILL.md"]
        );
        archive(
            &zip,
            &[
                ("a/SKILL.md", b"# alpha\n"),
                ("a/refs/detail.md", b"changed"),
                ("b/SKILL.md", b"# beta"),
            ],
        );
        assert_ne!(
            first.package_id,
            extract_global_skill_package_at(root.path(), &zip)
                .unwrap()
                .package_id
        );
    }

    #[test]
    fn global_skill_packages_verified_reads_are_exact_and_fail_closed_on_tampering() {
        let root = tempfile::tempdir().unwrap();
        let package = import_fixture(root.path());
        assert_eq!(
            read_global_skill_package_file_at(root.path(), &package.package_id, "a/refs/detail.md")
                .unwrap(),
            "details\r\n"
        );
        assert_eq!(
            inspect_global_skill_package_at(root.path(), &package.package_id)
                .unwrap()
                .files,
            package.files
        );
        for path in [
            "../manifest.json",
            "/a/SKILL.md",
            "a/../b/SKILL.md",
            "a\\SKILL.md",
            "a//SKILL.md",
            "a/./SKILL.md",
            "a/SKILL.md\0",
            "manifest.json",
        ] {
            assert!(
                read_global_skill_package_file_at(root.path(), &package.package_id, path).is_err(),
                "{path:?}"
            );
        }
        for id in ["../escape".to_string(), "A".repeat(64), "0".repeat(64)] {
            assert!(inspect_global_skill_package_at(root.path(), &id).is_err());
        }
        let payload = root
            .path()
            .join("skill-packages")
            .join(&package.package_id)
            .join("payload");
        fs::write(payload.join("a/refs/detail.md"), "tampered!").unwrap();
        assert!(inspect_global_skill_package_at(root.path(), &package.package_id).is_err());
        assert!(read_global_skill_package_file_at(
            root.path(),
            &package.package_id,
            "a/refs/detail.md"
        )
        .is_err());
    }

    #[test]
    fn global_skill_packages_legacy_promotion_preserves_source_and_reuses_existing_blob() {
        let root = tempfile::tempdir().unwrap();
        let package = import_fixture(root.path());
        let workspace = tempfile::tempdir().unwrap();
        let slot = workspace.path().join(".protocols/old-slot");
        fs::create_dir_all(slot.join("a/refs")).unwrap();
        fs::create_dir_all(slot.join("b")).unwrap();
        fs::write(slot.join("a/SKILL.md"), "# alpha\n").unwrap();
        fs::write(slot.join("a/refs/detail.md"), "details\r\n").unwrap();
        fs::write(slot.join("b/SKILL.md"), "# beta").unwrap();
        let promoted =
            promote_legacy_skill_package_at(root.path(), workspace.path(), ".protocols/old-slot")
                .unwrap();
        assert_eq!(promoted.package_id, package.package_id);
        assert!(promoted.reused);
        assert_eq!(
            fs::read_to_string(slot.join("a/SKILL.md")).unwrap(),
            "# alpha\n"
        );
        for path in [
            "",
            "old-slot",
            ".protocols",
            ".protocols/../old-slot",
            ".protocols/old-slot/a",
            "/.protocols/old-slot",
        ] {
            assert!(promote_legacy_skill_package_at(root.path(), workspace.path(), path).is_err());
        }
        assert!(
            promote_legacy_skill_package_at(root.path(), Path::new(""), ".protocols/old-slot")
                .is_err()
        );
    }

    #[test]
    fn global_skill_packages_invalid_archives_rollback_and_concurrent_imports_are_idempotent() {
        let root = tempfile::tempdir().unwrap();
        let zip = root.path().join("bad.zip");
        for entries in [
            vec![("../escape", b"bad".as_slice())],
            vec![("notes.txt", b"not a Skill".as_slice())],
        ] {
            archive(&zip, &entries);
            assert!(extract_global_skill_package_at(root.path(), &zip).is_err());
        }
        archive(&zip, &[("SKILL.md", b"# shared")]);
        let results = std::thread::scope(|scope| {
            let first = scope.spawn(|| extract_global_skill_package_at(root.path(), &zip));
            let second = scope.spawn(|| extract_global_skill_package_at(root.path(), &zip));
            (
                first.join().unwrap().unwrap(),
                second.join().unwrap().unwrap(),
            )
        });
        assert_eq!(results.0.package_id, results.1.package_id);
        assert_ne!(results.0.reused, results.1.reused);
        assert_eq!(
            fs::read_dir(root.path().join("skill-packages"))
                .unwrap()
                .count(),
            1
        );
    }

    #[test]
    fn global_skill_packages_text_reads_reject_binary_and_oversized_resources() {
        let root = tempfile::tempdir().unwrap();
        let zip = root.path().join("text-limits.zip");
        let large = vec![b'a'; 256_001];
        archive(
            &zip,
            &[
                ("SKILL.md", b"# text"),
                ("large.md", &large),
                ("binary.bin", &[0xff]),
            ],
        );
        let package = extract_global_skill_package_at(root.path(), &zip).unwrap();
        assert!(
            read_global_skill_package_file_at(root.path(), &package.package_id, "large.md")
                .is_err()
        );
        assert!(
            read_global_skill_package_file_at(root.path(), &package.package_id, "binary.bin")
                .is_err()
        );
    }

    #[test]
    fn global_skill_packages_manifest_cannot_authorize_changed_or_unlisted_bytes() {
        let root = tempfile::tempdir().unwrap();
        let package = import_fixture(root.path());
        let blob = root.path().join("skill-packages").join(&package.package_id);
        let manifest_path = blob.join("manifest.json");
        let original = fs::read(&manifest_path).unwrap();
        let mut manifest: PackageManifest = serde_json::from_slice(&original).unwrap();
        manifest.entry_points = vec!["a/refs/detail.md".into()];
        fs::write(&manifest_path, serde_json::to_vec(&manifest).unwrap()).unwrap();
        assert!(inspect_global_skill_package_at(root.path(), &package.package_id).is_err());
        fs::write(&manifest_path, &original).unwrap();
        fs::write(blob.join("payload/unlisted.md"), "not registered").unwrap();
        assert!(
            read_global_skill_package_file_at(root.path(), &package.package_id, "unlisted.md")
                .is_err()
        );
        fs::remove_file(blob.join("payload/unlisted.md")).unwrap();
        fs::write(blob.join("payload/a/refs/detail.md"), "replacement").unwrap();
        let forged = build_manifest(&blob.join("payload"), manifest.name).unwrap();
        assert_ne!(forged.package_id, package.package_id);
        let forged = PackageManifest {
            package_id: package.package_id.clone(),
            ..forged
        };
        fs::write(&manifest_path, serde_json::to_vec(&forged).unwrap()).unwrap();
        assert!(read_global_skill_package_file_at(
            root.path(),
            &package.package_id,
            "a/refs/detail.md"
        )
        .is_err());
    }

    #[cfg(unix)]
    #[test]
    fn global_skill_packages_store_payload_and_resource_links_cannot_escape() {
        use std::os::unix::fs::symlink;
        let root = tempfile::tempdir().unwrap();
        let external = tempfile::tempdir().unwrap();
        symlink(external.path(), root.path().join("skill-packages")).unwrap();
        let zip = root.path().join("skills.zip");
        archive(&zip, &[("SKILL.md", b"# skill")]);
        assert!(extract_global_skill_package_at(root.path(), &zip).is_err());
        assert_eq!(fs::read_dir(external.path()).unwrap().count(), 0);
        fs::remove_file(root.path().join("skill-packages")).unwrap();
        let package = import_fixture(root.path());
        let blob = root.path().join("skill-packages").join(&package.package_id);
        let resource = blob.join("payload/a/refs/detail.md");
        fs::write(external.path().join("outside.md"), "secret").unwrap();
        fs::remove_file(&resource).unwrap();
        symlink(external.path().join("outside.md"), &resource).unwrap();
        assert!(read_global_skill_package_file_at(
            root.path(),
            &package.package_id,
            "a/refs/detail.md"
        )
        .is_err());
        fs::remove_file(resource).unwrap();
        fs::rename(blob.join("payload"), blob.join("saved-payload")).unwrap();
        symlink(blob.join("saved-payload"), blob.join("payload")).unwrap();
        assert!(inspect_global_skill_package_at(root.path(), &package.package_id).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn global_skill_packages_reject_symlinks_and_non_regular_files_without_opening_them() {
        use std::os::unix::fs::symlink;
        let root = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let slot = workspace.path().join(".protocols/old-slot");
        fs::create_dir_all(&slot).unwrap();
        fs::write(slot.join("SKILL.md"), "# skill").unwrap();
        let external = tempfile::tempdir().unwrap();
        fs::write(external.path().join("secret.md"), "secret").unwrap();
        symlink(external.path().join("secret.md"), slot.join("linked.md")).unwrap();
        assert!(promote_legacy_skill_package_at(
            root.path(),
            workspace.path(),
            ".protocols/old-slot"
        )
        .is_err());
        fs::remove_file(slot.join("linked.md")).unwrap();
        let fifo = slot.join("pipe.md");
        assert!(std::process::Command::new("mkfifo")
            .arg(&fifo)
            .status()
            .unwrap()
            .success());
        assert!(promote_legacy_skill_package_at(
            root.path(),
            workspace.path(),
            ".protocols/old-slot"
        )
        .is_err());
        fs::remove_file(&fifo).unwrap();
        symlink(&slot, workspace.path().join(".protocols/linked-slot")).unwrap();
        assert!(promote_legacy_skill_package_at(
            root.path(),
            workspace.path(),
            ".protocols/linked-slot"
        )
        .is_err());
        let package = import_fixture(root.path());
        let file = root
            .path()
            .join("skill-packages")
            .join(&package.package_id)
            .join("payload/a/SKILL.md");
        fs::remove_file(&file).unwrap();
        assert!(std::process::Command::new("mkfifo")
            .arg(&file)
            .status()
            .unwrap()
            .success());
        assert!(
            read_global_skill_package_file_at(root.path(), &package.package_id, "a/SKILL.md")
                .is_err()
        );
    }
}
