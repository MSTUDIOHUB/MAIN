//! Copy-only migration from a known legacy workspace root. Original data remains intact.
use super::*;
use rusqlite::OpenFlags;
static MIGRATION_WRITER: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn copy_tree(source: &Path, target: &Path) -> Result<(), String> {
    fs::create_dir_all(target).map_err(|e| e.to_string())?;
    for entry in fs::read_dir(source).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let metadata = fs::symlink_metadata(entry.path()).map_err(|e| e.to_string())?;
        if metadata.file_type().is_symlink() {
            return Err("KNOWLEDGE_MIGRATION_SYMLINK".into());
        }
        let destination = target.join(entry.file_name());
        if metadata.is_dir() {
            copy_tree(&entry.path(), &destination)?;
        } else if metadata.is_file() {
            fs::copy(entry.path(), &destination).map_err(|e| e.to_string())?;
            if file_hash(&entry.path())? != file_hash(&destination)? {
                return Err("KNOWLEDGE_MIGRATION_HASH_MISMATCH".into());
            }
        }
    }
    Ok(())
}

fn write_migration_record(
    journal: &Path,
    record: &Path,
    origin: &str,
    target_id: &str,
) -> Result<(), String> {
    use std::io::Write;
    let mut temp = tempfile::NamedTempFile::new_in(journal).map_err(|e| e.to_string())?;
    temp.write_all(
        serde_json::json!({"origin":origin,"targetId":target_id})
            .to_string()
            .as_bytes(),
    )
    .map_err(|e| e.to_string())?;
    temp.as_file().sync_all().map_err(|e| e.to_string())?;
    temp.persist(record).map_err(|e| e.to_string())?;
    Ok(())
}

/// Only caller-discovered legacy `.MAIN/knowledge` roots are accepted; no disk search.
pub fn migrate_legacy_root(app_data_dir: &Path, legacy_app_data: &Path) -> Result<(), String> {
    let _guard = MIGRATION_WRITER
        .lock()
        .map_err(|_| "KNOWLEDGE_MIGRATION_LOCK_POISONED".to_string())?;
    if fs::symlink_metadata(legacy_app_data).is_ok_and(|m| m.file_type().is_symlink()) {
        return Err("KNOWLEDGE_MIGRATION_SYMLINK".into());
    }
    let old_root = knowledge_root(legacy_app_data);
    if !old_root.exists() {
        return Ok(());
    }
    if fs::symlink_metadata(&old_root)
        .map_err(|e| e.to_string())?
        .file_type()
        .is_symlink()
    {
        return Err("KNOWLEDGE_MIGRATION_SYMLINK".into());
    }
    let old_root = old_root.canonicalize().map_err(|e| e.to_string())?;
    let root = knowledge_root(app_data_dir);
    if fs::symlink_metadata(&root).is_ok_and(|m| m.file_type().is_symlink()) {
        return Err("KNOWLEDGE_MIGRATION_SYMLINK".into());
    }
    fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    let root = root.canonicalize().map_err(|e| e.to_string())?;
    if root == old_root {
        return Ok(());
    }
    let journal = root.join(".migrations");
    if fs::symlink_metadata(&journal).is_ok_and(|m| m.file_type().is_symlink()) {
        return Err("KNOWLEDGE_MIGRATION_SYMLINK".into());
    }
    fs::create_dir_all(&journal).map_err(|e| e.to_string())?;
    for entry in fs::read_dir(&old_root).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let old = entry.path();
        if fs::symlink_metadata(&old)
            .map_err(|e| e.to_string())?
            .file_type()
            .is_symlink()
        {
            return Err("KNOWLEDGE_MIGRATION_SYMLINK".into());
        }
        if !old.is_dir() || !old.join("index.sqlite").is_file() {
            continue;
        }
        let id = entry.file_name().to_string_lossy().into_owned();
        validate_id(&id)?;
        let origin = old.to_string_lossy().to_string();
        let record = journal.join(format!("{}.json", version_hash(&origin)));
        // Completion lives outside the library: deleting a migrated library must not resurrect it.
        if record.is_file() {
            if fs::symlink_metadata(&record)
                .map_err(|e| e.to_string())?
                .file_type()
                .is_symlink()
            {
                return Err("KNOWLEDGE_MIGRATION_SYMLINK".into());
            }
            let value: Value =
                serde_json::from_slice(&fs::read(&record).map_err(|e| e.to_string())?)
                    .map_err(|e| e.to_string())?;
            if value.get("origin").and_then(Value::as_str) != Some(origin.as_str()) {
                return Err("KNOWLEDGE_MIGRATION_COLLISION".into());
            }
            continue;
        }

        let mut target_id = id.clone();
        if root.join(&id).exists()
            && fs::read_to_string(root.join(&id).join(".migration-origin"))
                .ok()
                .as_deref()
                != Some(&origin)
        {
            target_id = format!("{}_{}", id, short_hash(origin.as_bytes()));
        }
        let target = root.join(&target_id);
        if target.exists() {
            if fs::read_to_string(target.join(".migration-origin"))
                .ok()
                .as_deref()
                == Some(&origin)
            {
                write_migration_record(&journal, &record, &origin, &target_id)?;
                continue;
            }
            return Err("KNOWLEDGE_MIGRATION_COLLISION".into());
        }
        let stage = tempfile::Builder::new()
            .prefix(".migration-")
            .tempdir_in(&root)
            .map_err(|e| e.to_string())?;
        if fs::symlink_metadata(old.join("index.sqlite"))
            .map_err(|e| e.to_string())?
            .file_type()
            .is_symlink()
        {
            return Err("KNOWLEDGE_MIGRATION_SYMLINK".into());
        }
        let source =
            Connection::open_with_flags(old.join("index.sqlite"), OpenFlags::SQLITE_OPEN_READ_ONLY)
                .map_err(|e| e.to_string())?;
        source
            .execute(
                "VACUUM INTO ?1",
                params![stage.path().join("index.sqlite").to_string_lossy().as_ref()],
            )
            .map_err(|e| format!("知识库迁移快照失败: {e}"))?;
        if old.join("sources").exists() {
            copy_tree(&old.join("sources"), &stage.path().join("sources"))?;
        }
        let copy =
            Connection::open(stage.path().join("index.sqlite")).map_err(|e| e.to_string())?;
        let integrity: String = copy
            .query_row("PRAGMA integrity_check", [], |row| row.get(0))
            .map_err(|e| e.to_string())?;
        if integrity != "ok" {
            return Err("KNOWLEDGE_MIGRATION_CORRUPT_INDEX".into());
        }
        let rows = {
            let mut stmt = copy
                .prepare("SELECT id, storage_path FROM sources")
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map([], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })
                .map_err(|e| e.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?;
            rows
        };
        for (source_id, path) in rows {
            let stored = PathBuf::from(path)
                .canonicalize()
                .map_err(|e| e.to_string())?;
            let relative = stored
                .strip_prefix(&old)
                .map_err(|_| "KNOWLEDGE_MIGRATION_UNTRUSTED_SOURCE".to_string())?;
            if !relative.starts_with("sources")
                || relative
                    .components()
                    .any(|c| !matches!(c, std::path::Component::Normal(_)))
            {
                return Err("KNOWLEDGE_MIGRATION_UNTRUSTED_SOURCE".into());
            }
            // Verify the copied bytes before switching the storage pointer.
            if file_hash(&stored)? != file_hash(&stage.path().join(relative))? {
                return Err("KNOWLEDGE_MIGRATION_HASH_MISMATCH".into());
            }
            copy.execute(
                "UPDATE sources SET storage_path=?1,kb_id=?2 WHERE id=?3",
                params![
                    target.join(relative).to_string_lossy().as_ref(),
                    target_id,
                    source_id
                ],
            )
            .map_err(|e| e.to_string())?;
        }
        copy.execute("UPDATE knowledge_base SET id=?1", params![target_id])
            .map_err(|e| e.to_string())?;
        copy.execute("UPDATE chunks SET kb_id=?1", params![target_id])
            .map_err(|e| e.to_string())?;
        copy.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")
            .map_err(|e| e.to_string())?;
        drop(copy);
        drop(source);
        fs::write(stage.path().join(".migration-origin"), &origin).map_err(|e| e.to_string())?;
        fs::rename(stage.path(), &target).map_err(|e| e.to_string())?;
        write_migration_record(&journal, &record, &origin, &target_id)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn deleting_migrated_library_does_not_resurrect_legacy_data() {
        let old = tempfile::tempdir().unwrap();
        let global = tempfile::tempdir().unwrap();
        let base = create_knowledge_base(old.path(), "Legacy", "").unwrap();
        migrate_legacy_root(global.path(), old.path()).unwrap();
        delete_knowledge_base(global.path(), &base.id).unwrap();
        migrate_legacy_root(global.path(), old.path()).unwrap();
        assert!(list_knowledge_bases(global.path()).unwrap().is_empty());
        assert!(kb_dir(old.path(), &base.id).is_dir());
    }
    #[test]
    fn failed_copy_leaves_original_and_retries_without_committing_partial_index() {
        let old = tempfile::tempdir().unwrap();
        let global = tempfile::tempdir().unwrap();
        let base = create_knowledge_base(old.path(), "Retry", "").unwrap();
        let sources = source_storage_dir(old.path(), &base.id);
        fs::create_dir_all(&sources).unwrap();
        let path = sources.join("a.md");
        fs::write(&path, "original").unwrap();
        index_extracted_source(
            old.path(),
            &base.id,
            &path,
            &path,
            &serde_json::json!({"content":"original"}),
            false,
        )
        .unwrap();
        fs::remove_file(&path).unwrap();
        assert!(migrate_legacy_root(global.path(), old.path()).is_err());
        assert!(!kb_dir(global.path(), &base.id).exists());
        assert!(kb_dir(old.path(), &base.id).join("index.sqlite").is_file());
        fs::write(&path, "original").unwrap();
        migrate_legacy_root(global.path(), old.path()).unwrap();
        assert_eq!(list_knowledge_bases(global.path()).unwrap().len(), 1);
    }
    #[test]
    fn copy_migration_is_retryable_and_preserves_original_with_collision() {
        let old = tempfile::tempdir().unwrap();
        let global = tempfile::tempdir().unwrap();
        let base = create_knowledge_base(old.path(), "Legacy", "").unwrap();
        let sources = source_storage_dir(old.path(), &base.id);
        fs::create_dir_all(&sources).unwrap();
        let path = sources.join("a.md");
        fs::write(&path, "中文知识库资料").unwrap();
        index_extracted_source(
            old.path(),
            &base.id,
            &path,
            &path,
            &serde_json::json!({"content":"中文知识库资料"}),
            false,
        )
        .unwrap();
        migrate_legacy_root(global.path(), old.path()).unwrap();
        migrate_legacy_root(global.path(), old.path()).unwrap();
        let migrated = list_knowledge_bases(global.path()).unwrap();
        assert_eq!(migrated.len(), 1);
        assert_eq!(migrated[0].id, base.id);
        assert!(path.is_file());
        assert!(list_sources(global.path(), &base.id).unwrap()[0]
            .storage_path
            .starts_with(global.path().canonicalize().unwrap().to_str().unwrap()));
        let other = tempfile::tempdir().unwrap();
        fs::create_dir_all(knowledge_root(other.path())).unwrap();
        copy_tree(
            &kb_dir(old.path(), &base.id),
            &kb_dir(other.path(), &base.id),
        )
        .unwrap();
        // Different old root is a distinct library and must never overwrite the global one.
        // Rewrite copied legacy path as a real second legacy store before migrating.
        let conn = open_db(other.path(), &base.id).unwrap();
        conn.execute(
            "UPDATE sources SET storage_path=?1",
            params![source_storage_dir(other.path(), &base.id)
                .join("a.md")
                .to_string_lossy()
                .as_ref()],
        )
        .unwrap();
        drop(conn);
        migrate_legacy_root(global.path(), other.path()).unwrap();
        assert_eq!(list_knowledge_bases(global.path()).unwrap().len(), 2);
    }
}
