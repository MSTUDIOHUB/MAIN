//! Opaque maintenance of app-owned pre-SQLite copies. Feature policy is TypeScript-owned.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::Mutex,
};
pub(crate) static COPY_MUTATION_LOCK: Mutex<()> = Mutex::new(());
const FILES: [&str; 4] = [
    "session.json",
    "messages.jsonl",
    "turns.jsonl",
    "runtime.json",
];
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacySessionFile {
    pub workspace: String,
    pub session_id: String,
    pub file_name: String,
    pub content_hash: String,
    pub value: Value,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacySessionFileMutation {
    pub workspace: String,
    pub session_id: String,
    pub file_name: String,
    pub expected_hash: String,
    pub value: Value,
}
fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn checked_dir(root: &Path, workspace: &str, session_id: &str) -> Result<PathBuf, String> {
    if session_id != crate::sanitize_session_key(session_id)
        || session_id == "."
        || session_id == ".."
        || session_id.is_empty()
    {
        return Err("LEGACY_SESSION_OWNER_MISMATCH".into());
    }
    let mut dir = root.canonicalize().map_err(|e| e.to_string())?;
    for part in [
        "sessions",
        "projects",
        &crate::session_project_id(workspace),
        "sessions",
        session_id,
    ] {
        dir.push(part);
        let meta = fs::symlink_metadata(&dir).map_err(|e| e.to_string())?;
        if meta.file_type().is_symlink() || !meta.is_dir() {
            return Err("LEGACY_SESSION_UNTRUSTED_PATH".into());
        }
    }
    Ok(dir)
}
fn checked_file(dir: &Path, name: &str) -> Result<PathBuf, String> {
    if !FILES.contains(&name) {
        return Err("LEGACY_SESSION_INVALID_FILE".into());
    }
    let path = dir.join(name);
    let meta = fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
    if meta.file_type().is_symlink() || !meta.is_file() {
        return Err("LEGACY_SESSION_UNTRUSTED_FILE".into());
    }
    Ok(path)
}
pub(crate) fn parse(name: &str, bytes: &[u8]) -> Result<Value, String> {
    if name.ends_with(".jsonl") {
        let text = std::str::from_utf8(bytes).map_err(|_| "LEGACY_SESSION_CORRUPT_UTF8")?;
        text.lines()
            .filter(|line| !line.trim().is_empty())
            .map(|line| {
                serde_json::from_str(line).map_err(|e| format!("LEGACY_SESSION_CORRUPT_JSONL:{e}"))
            })
            .collect::<Result<Vec<Value>, String>>()
            .map(Value::Array)
    } else {
        serde_json::from_slice(bytes).map_err(|e| format!("LEGACY_SESSION_CORRUPT_JSON:{e}"))
    }
}
fn verify_owner(dir: &Path, workspace: &str, session_id: &str) -> Result<(), String> {
    let meta = dir.join("session.json");
    if !meta.exists() {
        return Ok(());
    }
    let meta = checked_file(dir, "session.json")?;
    let value = parse("session.json", &fs::read(meta).map_err(|e| e.to_string())?)?;
    if crate::session_id_from_object(&value)? != session_id
        || value
            .get("workspaceRoot")
            .and_then(Value::as_str)
            .is_some_and(|owner| crate::normalize_workspace_for_sessions(owner) != workspace)
    {
        return Err("LEGACY_SESSION_OWNER_MISMATCH".into());
    }
    Ok(())
}
pub fn list_at(
    root: &Path,
    owners: &HashMap<String, String>,
) -> Result<Vec<LegacySessionFile>, String> {
    let mut projects = root.canonicalize().map_err(|e| e.to_string())?;
    for part in ["sessions", "projects"] {
        projects.push(part);
        match fs::symlink_metadata(&projects) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
            Err(e) => return Err(e.to_string()),
            Ok(meta) if meta.file_type().is_symlink() || !meta.is_dir() => {
                return Err("LEGACY_SESSION_UNTRUSTED_PATH".into())
            }
            Ok(_) => (),
        }
    }
    let mut result = Vec::new();
    for (project, workspace) in owners {
        let mut sessions = projects.clone();
        let mut absent = false;
        for part in [project.as_str(), "sessions"] {
            sessions.push(part);
            match fs::symlink_metadata(&sessions) {
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                    absent = true;
                    break;
                }
                Err(e) => return Err(e.to_string()),
                Ok(meta) if meta.file_type().is_symlink() || !meta.is_dir() => {
                    return Err("LEGACY_SESSION_UNTRUSTED_PATH".into())
                }
                Ok(_) => (),
            }
        }
        if absent {
            continue;
        }
        for entry in fs::read_dir(sessions).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            if !entry.file_type().map_err(|e| e.to_string())?.is_dir() {
                continue;
            }
            let id = entry.file_name().to_string_lossy().into_owned();
            let dir = checked_dir(root, workspace, &id)?;
            verify_owner(&dir, workspace, &id)?;
            for name in FILES {
                let candidate = dir.join(name);
                if !candidate.exists() {
                    continue;
                }
                let path = checked_file(&dir, name)?;
                let bytes = fs::read(path).map_err(|e| e.to_string())?;
                result.push(LegacySessionFile {
                    workspace: workspace.clone(),
                    session_id: id.clone(),
                    file_name: name.into(),
                    content_hash: hash(&bytes),
                    value: parse(name, &bytes)?,
                });
            }
        }
    }
    result.sort_by(|a, b| {
        (&a.workspace, &a.session_id, &a.file_name).cmp(&(
            &b.workspace,
            &b.session_id,
            &b.file_name,
        ))
    });
    Ok(result)
}
pub fn compare_and_swap_at(
    root: &Path,
    input: &LegacySessionFileMutation,
) -> Result<String, String> {
    let _lock = COPY_MUTATION_LOCK
        .lock()
        .map_err(|_| "LEGACY_SESSION_LOCK_POISONED")?;
    let dir = checked_dir(root, &input.workspace, &input.session_id)?;
    verify_owner(&dir, &input.workspace, &input.session_id)?;
    let path = checked_file(&dir, &input.file_name)?;
    if hash(&fs::read(&path).map_err(|e| e.to_string())?) != input.expected_hash {
        return Err("LEGACY_SESSION_CONTENT_CONFLICT".into());
    }
    let bytes = if input.file_name.ends_with(".jsonl") {
        let values = input
            .value
            .as_array()
            .ok_or("LEGACY_SESSION_INVALID_JSONL_VALUE")?;
        let mut bytes = Vec::new();
        for value in values {
            serde_json::to_writer(&mut bytes, value).map_err(|e| e.to_string())?;
            bytes.push(b'\n');
        }
        bytes
    } else {
        serde_json::to_vec(&input.value).map_err(|e| e.to_string())?
    };
    // The temporary file contains only the replacement, never a copy of retired bytes.
    let temp = dir.join(format!(
        ".migration-{}-{}",
        std::process::id(),
        rand::random::<u64>()
    ));
    let result = (|| {
        let mut file = fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temp)
            .map_err(|e| e.to_string())?;
        file.write_all(&bytes).map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        if checked_dir(root, &input.workspace, &input.session_id)? != dir
            || hash(&fs::read(checked_file(&dir, &input.file_name)?).map_err(|e| e.to_string())?)
                != input.expected_hash
        {
            return Err("LEGACY_SESSION_CONTENT_CONFLICT".into());
        }
        fs::rename(&temp, &path).map_err(|e| e.to_string())?;
        Ok(hash(&bytes))
    })();
    if result.is_err() {
        let _ = fs::remove_file(temp);
    }
    result
}
#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (tempfile::TempDir, HashMap<String, String>, PathBuf) {
        let t = tempfile::tempdir().unwrap();
        let w = "/legacy/no-sql-row";
        let p = crate::session_project_id(w);
        let d = t
            .path()
            .join("sessions/projects")
            .join(&p)
            .join("sessions/s1");
        fs::create_dir_all(&d).unwrap();
        fs::write(
            d.join("session.json"),
            serde_json::json!({"id":"s1","workspaceRoot":w,"ordinary":"preserve"}).to_string(),
        )
        .unwrap();
        fs::write(d.join("messages.jsonl"),"{\"type\":\"user\",\"content\":\"ordinary text\"}\n{\"type\":\"imageGeneration\",\"imageUrl\":\"retired-base64\"}\n").unwrap();
        (t, HashMap::from([(p, w.into())]), d)
    }
    #[test]
    fn opaque_copy_rewrite_preserves_ordinary_fields_without_inserting_sql() {
        let (t, o, d) = fixture();
        let files = list_at(t.path(), &o).unwrap();
        let f = files
            .iter()
            .find(|f| f.file_name == "messages.jsonl")
            .unwrap();
        compare_and_swap_at(
            t.path(),
            &LegacySessionFileMutation {
                workspace: f.workspace.clone(),
                session_id: f.session_id.clone(),
                file_name: f.file_name.clone(),
                expected_hash: f.content_hash.clone(),
                value: serde_json::json!([{"type":"user","content":"ordinary text"}]),
            },
        )
        .unwrap();
        let bytes = fs::read_to_string(d.join("messages.jsonl")).unwrap();
        assert!(bytes.contains("ordinary text"));
        assert!(!bytes.contains("retired-base64"));
        assert!(!t.path().join("sessions/session-store.sqlite3").exists());
        assert_eq!(fs::read_dir(&d).unwrap().count(), 2);
    }
    #[test]
    fn opaque_copy_conflicts_and_corrupt_payloads_do_not_overwrite() {
        let (t, o, d) = fixture();
        let f = list_at(t.path(), &o).unwrap().remove(0);
        fs::write(d.join(&f.file_name), "changed").unwrap();
        assert!(compare_and_swap_at(
            t.path(),
            &LegacySessionFileMutation {
                workspace: f.workspace,
                session_id: f.session_id,
                file_name: f.file_name,
                expected_hash: f.content_hash,
                value: Value::Null
            }
        )
        .is_err());
        assert_eq!(
            fs::read_to_string(d.join("messages.jsonl")).unwrap(),
            "changed"
        );
        assert!(list_at(t.path(), &o).is_err());
    }
    #[cfg(unix)]
    #[test]
    fn opaque_copy_refuses_symlink_and_wrong_owner() {
        let (t, o, d) = fixture();
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("keep"), "export").unwrap();
        fs::remove_file(d.join("messages.jsonl")).unwrap();
        std::os::unix::fs::symlink(outside.path().join("keep"), d.join("messages.jsonl")).unwrap();
        assert!(list_at(t.path(), &o).is_err());
        assert_eq!(
            fs::read_to_string(outside.path().join("keep")).unwrap(),
            "export"
        );
        fs::remove_file(d.join("messages.jsonl")).unwrap();
        fs::write(d.join("session.json"), "{\"id\":\"wrong\"}").unwrap();
        assert!(list_at(t.path(), &o).is_err());
    }
}
