//! Removal is limited to the retired product's own temporary output directories.
use serde::Serialize;
use std::fs;
use std::path::Path;
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupResult {
    pub removed_directories: usize,
}
fn remove_tree_without_following_links(path: &Path) -> Result<(), String> {
    let metadata = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    if metadata.file_type().is_symlink() || metadata.is_file() {
        return fs::remove_file(path).map_err(|e| e.to_string());
    }
    for entry in fs::read_dir(path).map_err(|e| e.to_string())? {
        remove_tree_without_following_links(&entry.map_err(|e| e.to_string())?.path())?;
    }
    fs::remove_dir(path).map_err(|e| e.to_string())
}
pub fn cleanup_at(temp_root: &Path) -> Result<CleanupResult, String> {
    let trusted = temp_root.canonicalize().map_err(|e| e.to_string())?;
    let mut root = trusted;
    for part in ["MAIN", ".tmp", "chat-sessions"] {
        root.push(part);
        match fs::symlink_metadata(&root) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Ok(CleanupResult {
                    removed_directories: 0,
                })
            }
            Err(e) => return Err(e.to_string()),
            Ok(meta) if meta.file_type().is_symlink() || !meta.is_dir() => {
                return Err("LEGACY_ASSET_UNTRUSTED_ROOT".into())
            }
            Ok(_) => (),
        }
    }
    let mut removed = 0;
    for entry in fs::read_dir(&root).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if !entry.file_type().map_err(|e| e.to_string())?.is_dir() {
            continue;
        }
        let output = entry.path().join("image-studio");
        match fs::symlink_metadata(&output) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => return Err(e.to_string()),
            Ok(meta) if meta.file_type().is_symlink() => {
                return Err("LEGACY_ASSET_UNTRUSTED_OUTPUT".into())
            }
            Ok(meta) if !meta.is_dir() => continue,
            Ok(_) => (),
        }
        remove_tree_without_following_links(&output)?;
        removed += 1;
    }
    Ok(CleanupResult {
        removed_directories: removed,
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cleanup_preserves_attachments_and_exports() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("MAIN/.tmp/chat-sessions/s1");
        for name in ["image-studio", ".MAIN-chat-attachments", "export"] {
            fs::create_dir_all(root.join(name)).unwrap();
            fs::write(root.join(name).join("a.txt"), "keep").unwrap();
        }
        assert_eq!(cleanup_at(temp.path()).unwrap().removed_directories, 1);
        assert_eq!(cleanup_at(temp.path()).unwrap().removed_directories, 0);
        assert!(root.join(".MAIN-chat-attachments/a.txt").exists());
        assert!(root.join("export/a.txt").exists());
    }
    #[cfg(unix)]
    #[test]
    fn cleanup_does_not_follow_session_or_output_symlinks() {
        let temp = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let root = temp.path().join("MAIN/.tmp/chat-sessions");
        fs::create_dir_all(root.join("s1")).unwrap();
        fs::write(outside.path().join("keep"), "keep").unwrap();
        std::os::unix::fs::symlink(outside.path(), root.join("s1/image-studio")).unwrap();
        assert!(cleanup_at(temp.path()).is_err());
        assert!(outside.path().join("keep").exists());
    }
}
