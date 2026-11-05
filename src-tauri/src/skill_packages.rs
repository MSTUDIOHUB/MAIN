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
const MAX_DOWNLOAD_BYTES: u64 = 128 * 1024 * 1024;

#[cfg(test)]
thread_local! {
    static PACKAGE_VERIFICATION_COUNT: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

/// Installation provenance belongs to a registration, not to shared content.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubSkillSource {
    pub repository: String,
    pub branch: String,
}

impl GithubSkillSource {
    fn archive_url(&self) -> url::Url {
        let mut url = url::Url::parse("https://codeload.github.com").unwrap();
        url.path_segments_mut()
            .unwrap()
            .extend(self.repository.split('/'))
            .extend(["zip", "refs", "heads"])
            .extend(self.branch.split('/'));
        url
    }
}

/// Accept repository identities, never arbitrary download hosts or credentials.
fn github_skill_source(
    repo_or_url: &str,
    branch: Option<&str>,
) -> Result<GithubSkillSource, String> {
    let input = repo_or_url.trim();
    let (repository, url_branch) = if input.starts_with("https://") {
        let parsed = url::Url::parse(input).map_err(|_| "Invalid GitHub repository URL")?;
        if parsed.host_str() != Some("github.com")
            || !parsed.username().is_empty()
            || parsed.password().is_some()
            || parsed.port().is_some()
            || parsed.query().is_some()
            || parsed.fragment().is_some()
        {
            return Err("Use a public https://github.com/owner/repo URL".into());
        }
        let parts = parsed
            .path()
            .trim_matches('/')
            .split('/')
            .collect::<Vec<_>>();
        if parts.len() < 2 || (parts.len() > 2 && (parts.len() < 4 || parts[2] != "tree")) {
            return Err("Use owner/repo or a GitHub repository/tree URL".into());
        }
        (
            format!("{}/{}", parts[0], parts[1].trim_end_matches(".git")),
            (parts.len() > 2).then(|| parts[3..].join("/")),
        )
    } else {
        (input.trim_end_matches(".git").to_string(), None)
    };
    let parts = repository.split('/').collect::<Vec<_>>();
    if parts.len() != 2
        || parts.iter().any(|part| {
            part.is_empty()
                || part.len() > 100
                || *part == "."
                || *part == ".."
                || !part
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
        })
    {
        return Err("Invalid GitHub owner/repository".into());
    }
    let selected_branch = branch
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .or(url_branch.as_deref())
        .unwrap_or("main");
    if selected_branch.len() > 256
        || selected_branch
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
        || selected_branch.contains("..")
        || !selected_branch
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-_./".contains(&b))
    {
        return Err("Invalid GitHub branch; specify a branch name, without URL escapes".into());
    }
    Ok(GithubSkillSource {
        repository: format!("{}/{}", parts[0], parts[1]),
        branch: selected_branch.to_string(),
    })
}

#[cfg(test)]
fn github_archive_url(repo_or_url: &str, branch: Option<&str>) -> Result<url::Url, String> {
    github_skill_source(repo_or_url, branch).map(|source| source.archive_url())
}

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
    pub payload_dir: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub github_source: Option<GithubSkillSource>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GlobalSkillCatalogDocument {
    pub relative_path: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GlobalSkillPackageCatalog {
    pub meta: GlobalSkillPackageMeta,
    pub documents: Vec<GlobalSkillCatalogDocument>,
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

fn metadata(manifest: &PackageManifest, payload: &Path, reused: bool) -> GlobalSkillPackageMeta {
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
        payload_dir: payload.to_string_lossy().into_owned(),
        github_source: None,
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
    #[cfg(test)]
    PACKAGE_VERIFICATION_COUNT.with(|count| count.set(count.get() + 1));
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
            .map(|(existing, payload)| metadata(&existing, &payload, true));
    }
    match fs::rename(staging.path(), &destination) {
        Ok(()) => {
            let payload = regular_directory(&destination.join("payload"))?;
            Ok(metadata(&manifest, &payload, false))
        }
        Err(error) => {
            // Another importer may have published the same immutable tree first.
            if fs::symlink_metadata(&destination).is_ok() {
                inspect_at_store(store, &manifest.package_id)
                    .map(|(existing, payload)| metadata(&existing, &payload, true))
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
    inspect_at_store(&store, package_id)
        .map(|(manifest, payload)| metadata(&manifest, &payload, true))
}

pub fn read_global_skill_package_file_at(
    app_data: &Path,
    package_id: &str,
    relative: &str,
) -> Result<String, String> {
    relative_path(relative)?;
    let store = store_root(app_data, false)?;
    let (manifest, payload) = inspect_at_store(&store, package_id)?;
    read_verified_manifest_file(&manifest, &payload, relative)
}

fn read_verified_manifest_file(
    manifest: &PackageManifest,
    payload: &Path,
    relative: &str,
) -> Result<String, String> {
    let record = manifest
        .files
        .iter()
        .find(|file| file.path == relative)
        .ok_or("Skill resource is not in the package manifest")?;
    let bytes = read_regular(&resource_path(payload, relative)?, MAX_TEXT_BYTES)?;
    if bytes.len() as u64 != record.size_bytes
        || format!("{:x}", Sha256::digest(&bytes)) != record.sha256
    {
        return Err("Skill resource changed after verification".into());
    }
    String::from_utf8(bytes).map_err(|_| "Skill resource is not UTF-8 text".into())
}

/// Load the entry points and their optional host configuration as one catalog.
/// References and scripts remain lazy resources, outside this response.
pub fn load_global_skill_package_catalog_at(
    app_data: &Path,
    package_id: &str,
) -> Result<GlobalSkillPackageCatalog, String> {
    // Verify the entire immutable tree once for this request. Do not cache the
    // result across requests: any entry, reference, manifest or link change
    // must invalidate the next admission, including unselected resources.
    let store = store_root(app_data, false)?;
    let (manifest, payload) = inspect_at_store(&store, package_id)?;
    let meta = metadata(&manifest, &payload, true);
    let mut paths = meta.entry_points.clone();
    for entry in &meta.entry_points {
        let base = entry.rsplit_once('/').map(|(base, _)| base);
        let config = base.map_or_else(
            || "agents/openai.yaml".to_string(),
            |base| format!("{base}/agents/openai.yaml"),
        );
        if meta.files.contains(&config) && !paths.contains(&config) {
            paths.push(config);
        }
    }
    let documents = paths
        .into_iter()
        .map(|relative_path| {
            // Recheck each returned document against this exact manifest after
            // opening it, preserving the execution-adjacent TOCTOU guard.
            let content = read_verified_manifest_file(&manifest, &payload, &relative_path)?;
            Ok(GlobalSkillCatalogDocument {
                relative_path,
                content,
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    Ok(GlobalSkillPackageCatalog { meta, documents })
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
pub async fn fetch_and_install_github_skill_package(
    app: AppHandle,
    repo_or_url: String,
    branch: Option<String>,
) -> Result<GlobalSkillPackageMeta, String> {
    let root = app_data(&app)?;
    fetch_and_install_github_skill_package_at(&root, &repo_or_url, branch.as_deref()).await
}

/// The command and opt-in network smoke test share the exact download and
/// extraction path. Callers choose an app-data root, never a workspace root.
pub async fn fetch_and_install_github_skill_package_at(
    app_data: &Path,
    repo_or_url: &str,
    branch: Option<&str>,
) -> Result<GlobalSkillPackageMeta, String> {
    use tokio::io::AsyncWriteExt;
    let source = github_skill_source(repo_or_url, branch)?;
    let url = source.archive_url();
    let root = app_data.to_path_buf();
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(std::time::Duration::from_secs(15))
        .timeout(std::time::Duration::from_secs(90))
        .build()
        .map_err(|error| format!("Cannot create Skill download client: {error}"))?;
    let mut response = client
        .get(url)
        .send()
        .await
        .map_err(|error| format!("Cannot download GitHub Skill package: {error}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "GitHub Skill download returned HTTP {}; check the public repository and branch",
            response.status().as_u16()
        ));
    }
    if response
        .content_length()
        .is_some_and(|size| size > MAX_DOWNLOAD_BYTES)
    {
        return Err("GitHub Skill archive exceeds the 128 MiB download limit".into());
    }
    let archive = tempfile::Builder::new()
        .prefix("main-github-skills-")
        .suffix(".zip")
        .tempfile()
        .map_err(|error| format!("Cannot create Skill download file: {error}"))?;
    let mut file = tokio::fs::File::from_std(archive.reopen().map_err(|error| error.to_string())?);
    let mut total = 0_u64;
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| format!("Skill archive download interrupted: {error}"))?
    {
        total = total.saturating_add(chunk.len() as u64);
        if total > MAX_DOWNLOAD_BYTES {
            return Err("GitHub Skill archive exceeds the 128 MiB download limit".into());
        }
        file.write_all(&chunk)
            .await
            .map_err(|error| format!("Cannot save Skill download: {error}"))?;
    }
    file.flush().await.map_err(|error| error.to_string())?;
    drop(file);
    package_io(move || install_github_skill_archive_at(&root, archive.path(), source)).await
}

/// The download candidate carries its own provenance even when immutable bytes
/// are reused. Inspection and ordinary ZIP installation never inherit it.
fn install_github_skill_archive_at(
    app_data: &Path,
    archive: &Path,
    source: GithubSkillSource,
) -> Result<GlobalSkillPackageMeta, String> {
    let mut meta = extract_global_skill_package_at(app_data, archive)?;
    meta.github_source = Some(source);
    Ok(meta)
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
pub async fn load_global_skill_package_catalog(
    app: AppHandle,
    package_id: String,
) -> Result<GlobalSkillPackageCatalog, String> {
    let root = app_data(&app)?;
    package_io(move || load_global_skill_package_catalog_at(&root, &package_id)).await
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

    #[test]
    #[ignore = "public network: downloads the current Unity-Technologies/skills main branch"]
    fn public_github_unity_skills_install_smoke() {
        let app_data = tempfile::tempdir().unwrap();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let meta = runtime
            .block_on(fetch_and_install_github_skill_package_at(
                app_data.path(),
                "Unity-Technologies/skills",
                Some("main"),
            ))
            .expect("public GitHub download and verified extraction should succeed");
        let inspected = inspect_global_skill_package_at(app_data.path(), &meta.package_id).unwrap();
        assert_eq!(
            meta.github_source,
            Some(GithubSkillSource {
                repository: "Unity-Technologies/skills".into(),
                branch: "main".into(),
            })
        );
        assert!(inspected.github_source.is_none());
        assert_eq!(meta.entry_points, inspected.entry_points);
        assert!(!meta.entry_points.is_empty());
        let has_cli = meta
            .entry_points
            .iter()
            .any(|path| path.ends_with("/unity-cli/SKILL.md"));
        let has_pipeline = meta
            .entry_points
            .iter()
            .any(|path| path.ends_with("/unity-pipeline/SKILL.md"));
        assert!(
            has_cli,
            "the current Unity official package must include unity-cli"
        );
        eprintln!(
            "Public Unity skills install: entries={} files={} unity-cli={} unity-pipeline={} package_id={}",
            meta.entry_points.len(), meta.files.len(), has_cli, has_pipeline, meta.package_id,
        );
    }

    #[test]
    fn github_skill_sources_use_only_public_codeload_with_validated_refs() {
        for source in [
            "Unity-Technologies/skills",
            "https://github.com/Unity-Technologies/skills.git/",
        ] {
            assert_eq!(
                github_archive_url(source, None).unwrap().as_str(),
                "https://codeload.github.com/Unity-Technologies/skills/zip/refs/heads/main"
            );
        }
        assert_eq!(
            github_archive_url("https://github.com/owner/repo/tree/feature/skills", None)
                .unwrap()
                .as_str(),
            "https://codeload.github.com/owner/repo/zip/refs/heads/feature/skills"
        );
        assert!(github_archive_url("owner/repo", Some("release-v1"))
            .unwrap()
            .path()
            .ends_with("/release-v1"));
        for source in [
            "http://github.com/o/r",
            "https://github.com.evil/o/r",
            "https://user:secret@github.com/o/r",
            "https://github.com:8443/o/r",
            "https://github.com/o/r?token=x",
            "https://github.com/o/r#x",
            "o/../r",
            "o/r/more",
            "https://github.com/o/r/blob/main/SKILL.md",
            "o/%2fetc",
        ] {
            assert!(
                github_archive_url(source, None).is_err(),
                "accepted {source}"
            );
        }
        for branch in [
            "../main", "/main", "main/", "a//b", "a%2fb", "main?x", "main#x", "a\\b",
        ] {
            assert!(
                github_archive_url("o/r", Some(branch)).is_err(),
                "accepted {branch}"
            );
        }
    }

    #[test]
    fn github_source_metadata_normalizes_repository_and_resolves_the_download_ref() {
        for (input, branch, repository, selected_branch) in [
            (
                " Unity-Technologies/skills ",
                None,
                "Unity-Technologies/skills",
                "main",
            ),
            (
                "https://github.com/Unity-Technologies/skills.git/",
                None,
                "Unity-Technologies/skills",
                "main",
            ),
            (
                "https://github.com/owner/skills/tree/feature/tools",
                None,
                "owner/skills",
                "feature/tools",
            ),
            (
                "https://github.com/owner/skills/tree/old/ref",
                Some(" release/v2 "),
                "owner/skills",
                "release/v2",
            ),
            ("owner/skills.git", Some(" "), "owner/skills", "main"),
        ] {
            let source = github_skill_source(input, branch).unwrap();
            assert_eq!(source.repository, repository);
            assert_eq!(source.branch, selected_branch);
            assert_eq!(
                source.archive_url(),
                github_archive_url(input, branch).unwrap()
            );
        }
    }

    #[test]
    fn github_download_candidate_keeps_provenance_outside_the_shared_manifest() {
        let root = tempfile::tempdir().unwrap();
        let zip = root.path().join("download.zip");
        archive(&zip, &[("skill/SKILL.md", b"# Instructions\n")]);
        let first_source = github_skill_source("owner/skills", Some("release/v1")).unwrap();
        let first =
            install_github_skill_archive_at(root.path(), &zip, first_source.clone()).unwrap();
        assert_eq!(first.github_source, Some(first_source));
        let value = serde_json::to_value(&first).unwrap();
        assert_eq!(value["githubSource"]["repository"], "owner/skills");
        assert_eq!(value["githubSource"]["branch"], "release/v1");

        let second_source = github_skill_source("fork/skills", None).unwrap();
        let second =
            install_github_skill_archive_at(root.path(), &zip, second_source.clone()).unwrap();
        assert_eq!(first.package_id, second.package_id);
        assert!(second.reused);
        assert_eq!(second.github_source, Some(second_source));

        let inspected = inspect_global_skill_package_at(root.path(), &first.package_id).unwrap();
        let ordinary_zip = extract_global_skill_package_at(root.path(), &zip).unwrap();
        let catalog = load_global_skill_package_catalog_at(root.path(), &first.package_id).unwrap();
        for meta in [inspected, ordinary_zip, catalog.meta] {
            assert!(meta.github_source.is_none());
            assert!(serde_json::to_value(meta)
                .unwrap()
                .get("githubSource")
                .is_none());
        }
        let manifest = fs::read_to_string(
            root.path()
                .join("skill-packages")
                .join(&first.package_id)
                .join("manifest.json"),
        )
        .unwrap();
        assert!(!manifest.contains("githubSource"));
        assert!(!manifest.contains("repository"));
        assert!(!manifest.contains("release/v1"));
    }

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
    fn global_skill_catalog_verifies_the_package_once_per_request_and_keeps_exact_documents() {
        let root = tempfile::tempdir().unwrap();
        let zip = root.path().join("catalog.zip");
        archive(
            &zip,
            &[
                ("a/SKILL.md", b"# alpha\r\n"),
                (
                    "a/agents/openai.yaml",
                    b"policy:\n  allow_implicit_invocation: false\n",
                ),
                ("a/refs/detail.md", b"details\r\n"),
                ("b/SKILL.md", b"# beta"),
            ],
        );
        let package = extract_global_skill_package_at(root.path(), &zip).unwrap();
        PACKAGE_VERIFICATION_COUNT.with(|count| count.set(0));
        let catalog =
            load_global_skill_package_catalog_at(root.path(), &package.package_id).unwrap();
        assert_eq!(catalog.meta.package_id, package.package_id);
        assert_eq!(catalog.documents.len(), 3);
        assert_eq!(catalog.documents[0].relative_path, "a/SKILL.md");
        assert_eq!(catalog.documents[0].content, "# alpha\r\n");
        assert_eq!(catalog.documents[1].relative_path, "b/SKILL.md");
        assert!(catalog
            .documents
            .iter()
            .any(|doc| doc.relative_path == "a/agents/openai.yaml"
                && doc.content.ends_with("false\n")));
        assert!(catalog
            .documents
            .iter()
            .all(|doc| !doc.relative_path.contains("refs/")));
        PACKAGE_VERIFICATION_COUNT.with(|count| {
            assert_eq!(
                count.get(),
                1,
                "catalog admission must not re-hash the full package for every entry"
            )
        });
    }

    #[test]
    fn global_skill_catalog_revalidates_unselected_resources_on_every_request() {
        let root = tempfile::tempdir().unwrap();
        let package = import_fixture(root.path());
        PACKAGE_VERIFICATION_COUNT.with(|count| count.set(0));
        for _ in 0..2 {
            load_global_skill_package_catalog_at(root.path(), &package.package_id).unwrap();
        }
        PACKAGE_VERIFICATION_COUNT.with(|count| assert_eq!(count.get(), 2));
        let reference = root
            .path()
            .join("skill-packages")
            .join(&package.package_id)
            .join("payload/a/refs/detail.md");
        fs::write(reference, "changed\r\n").unwrap();
        assert!(
            load_global_skill_package_catalog_at(root.path(), &package.package_id).is_err(),
            "even a resource outside the returned catalog invalidates immutable package admission"
        );
    }

    #[test]
    fn global_skill_catalog_returned_bytes_must_still_match_the_verified_manifest() {
        let root = tempfile::tempdir().unwrap();
        let package = import_fixture(root.path());
        let store = store_root(root.path(), false).unwrap();
        let (manifest, payload) = inspect_at_store(&store, &package.package_id).unwrap();
        fs::write(payload.join("a/SKILL.md"), "# other\n").unwrap();
        assert!(
            read_verified_manifest_file(&manifest, &payload, "a/SKILL.md").is_err(),
            "an equal-length document change after inspection cannot enter the returned batch"
        );
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
