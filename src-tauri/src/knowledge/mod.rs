pub mod migration;
pub mod presets;

use rusqlite::{params, Connection, OpenFlags, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Write;
use std::sync::Mutex;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const LEXICAL_PROFILE: &str = "fts5_cjk_bigram_v2";
const CHUNK_TARGET_CHARS: usize = 2_800;
const CHUNK_OVERLAP_CHARS: usize = 400;
static PRESET_COMMIT_LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeBase {
    pub id: String,
    pub name: String,
    pub description: String,
    pub enabled: bool,
    pub source_count: usize,
    pub index_status: String,
    pub embedding_profile: String,
    pub index_revision: String,
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preset_id: Option<String>,
    #[serde(default)]
    pub toc_entry_count: usize,
    #[serde(default)]
    pub toc_indexed_source_count: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preset_sync_status: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeSource {
    pub id: String,
    pub kb_id: String,
    pub title: String,
    pub original_path: String,
    pub storage_path: String,
    pub ext: String,
    pub size: u64,
    pub hash: String,
    pub status: String,
    pub metadata: Value,
    pub last_indexed_at_ms: u64,
    pub source_revision: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provenance: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeChunk {
    pub id: String,
    pub source_id: String,
    pub chunk_index: usize,
    pub text: String,
    pub hash: String,
    pub page: Option<usize>,
    pub block: Option<String>,
    pub heading: Option<String>,
    pub token_count: usize,
    pub embedding_status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeCitation {
    pub kb_id: String,
    pub kb_name: String,
    pub source_id: String,
    pub source_title: String,
    pub chunk_id: String,
    pub page: Option<usize>,
    pub block: Option<String>,
    pub source_url: Option<String>,
    pub score: f32,
    pub index_revision: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub admitted_index_revision: Option<String>,
    pub source_revision: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub documentation_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub documentation_coverage: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeSearchHit {
    pub text: String,
    pub excerpt: String,
    pub citation: KnowledgeCitation,
    pub returned_char_range: KnowledgeCharRange,
    pub total_chars: usize,
    pub complete: bool,
    pub retrieval_kind: String,
    pub source_overview: Option<KnowledgeSourceOverview>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeSearchResult {
    pub query: String,
    pub searched_knowledge_base_ids: Vec<String>,
    pub hits: Vec<KnowledgeSearchHit>,
    pub note: String,
    pub attempted_tiers: Vec<String>,
    pub hydrated_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeImportResult {
    pub base: KnowledgeBase,
    pub source: KnowledgeSource,
    pub chunks: usize,
    pub deduped: bool,
}

#[derive(Debug, Clone)]
pub struct StoredSource {
    pub source: KnowledgeSource,
    pub storage_path: PathBuf,
}

#[derive(Debug, Clone)]
struct ChunkInput {
    index: usize,
    text: String,
    page: Option<usize>,
    block: Option<String>,
    heading: Option<String>,
}

#[derive(Debug, Clone)]
struct CandidateHit {
    kb_id: String,
    kb_name: String,
    source_id: String,
    source_title: String,
    chunk_id: String,
    text: String,
    page: Option<usize>,
    block: Option<String>,
    source_url: Option<String>,
    rank: f64,
    source_revision: String,
    index_revision: String,
    admitted_index_revision: Option<String>,
    source_kind: Option<String>,
    manual_scope: Option<(String, String)>,
}

/// Frozen, explicit authority for one submitted message. Empty means no access.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(
    tag = "kind",
    rename_all = "lowercase",
    rename_all_fields = "camelCase"
)]
pub enum KnowledgeReference {
    Base {
        kb_id: String,
        index_revision: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        activation_mode: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        preset_id: Option<String>,
    },
    Source {
        kb_id: String,
        source_id: String,
        source_revision: String,
    },
}

fn validate_id(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value == "."
        || value == ".."
        || !value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-')
    {
        return Err("KNOWLEDGE_INVALID_ID".to_string());
    }
    Ok(())
}

fn version_hash(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}

fn source_revision(conn: &Connection, source_id: &str) -> Result<String, String> {
    let head: (String, String, String, String) = conn
        .query_row(
            "SELECT hash, status, title, metadata FROM sources WHERE id = ?1",
            params![source_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare("SELECT hash, page, block, heading FROM chunks WHERE source_id = ?1 ORDER BY chunk_index").map_err(|e| e.to_string())?;
    let chunks = stmt
        .query_map(params![source_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<i64>>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, Option<String>>(3)?,
            ))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(version_hash(
        &serde_json::json!([LEXICAL_PROFILE, source_id, head, chunks]).to_string(),
    ))
}

fn index_revision(conn: &Connection) -> Result<String, String> {
    let mut stmt = conn
        .prepare("SELECT id FROM sources ORDER BY id")
        .map_err(|e| e.to_string())?;
    let ids = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    let revisions = ids
        .iter()
        .map(|id| source_revision(conn, id).map(|revision| (id, revision)))
        .collect::<Result<Vec<_>, _>>()?;
    let mut stmt = conn.prepare(
        "SELECT p.source_id, p.content_hash, p.kind, p.url FROM source_provenance p
         JOIN sources s ON s.id=p.source_id AND s.hash=p.content_hash ORDER BY p.source_id"
    ).map_err(|e| e.to_string())?;
    let proofs = stmt.query_map([], |row| Ok((
        row.get::<_, String>(0)?, row.get::<_, String>(1)?,
        row.get::<_, String>(2)?, row.get::<_, Option<String>>(3)?,
    ))).map_err(|e| e.to_string())?.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?;
    // Preserve revisions of existing libraries until verified provenance is added.
    let value = if proofs.is_empty() {
        serde_json::json!([LEXICAL_PROFILE, revisions])
    } else {
        serde_json::json!([LEXICAL_PROFILE, revisions, proofs])
    };
    Ok(version_hash(&value.to_string()))
}

fn hydrate_source(
    conn: &Connection,
    mut source: KnowledgeSource,
) -> Result<KnowledgeSource, String> {
    source.source_revision = source_revision(conn, &source.id)?;
    source.provenance = conn.query_row(
        "SELECT kind FROM source_provenance WHERE source_id=?1 AND content_hash=?2",
        params![source.id, source.hash], |row| row.get(0),
    ).optional().map_err(|error| error.to_string())?;
    if source.provenance.is_none() {
        let metadata = &source.metadata["metadata"];
        if ["autoHydrated", "builtinSeed", "seedUrl"].into_iter()
            .any(|key| metadata[key].as_bool() == Some(true))
        {
            source.provenance = Some("unverified_legacy".into());
        }
    }
    Ok(source)
}

pub fn knowledge_root(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("knowledge")
}

fn kb_dir(app_data_dir: &Path, kb_id: &str) -> PathBuf {
    knowledge_root(app_data_dir).join(kb_id)
}

fn db_path(app_data_dir: &Path, kb_id: &str) -> PathBuf {
    kb_dir(app_data_dir, kb_id).join("index.sqlite")
}

pub fn source_storage_dir(app_data_dir: &Path, kb_id: &str) -> PathBuf {
    kb_dir(app_data_dir, kb_id).join("sources")
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_else(|_| Duration::from_secs(0))
        .as_millis() as u64
}

fn short_hash(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest
        .iter()
        .take(12)
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>()
}

pub fn file_hash(path: &Path) -> Result<String, String> {
    let bytes = fs::read(path)
        .map_err(|error| format!("读取知识库源文件失败 {}: {error}", path.display()))?;
    Ok(short_hash(&bytes))
}

pub fn sanitize_file_name(value: &str) -> String {
    let mut result = value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-' | '_') {
                ch
            } else {
                '_'
            }
        })
        .collect::<String>();
    while result.contains("__") {
        result = result.replace("__", "_");
    }
    result.trim_matches('_').to_string()
}

fn make_id(prefix: &str, seed: &str) -> String {
    format!(
        "{}_{}",
        prefix,
        short_hash(format!("{seed}:{}", now_millis()).as_bytes())
    )
}

fn open_or_create_db(app_data_dir: &Path, kb_id: &str) -> Result<Connection, String> {
    open_knowledge_db(app_data_dir, kb_id, true)
}

fn open_knowledge_db(app_data_dir: &Path, kb_id: &str, create: bool) -> Result<Connection, String> {
    validate_id(kb_id)?;
    if fs::symlink_metadata(knowledge_root(app_data_dir)).is_ok_and(|m| m.file_type().is_symlink())
        || fs::symlink_metadata(db_path(app_data_dir, kb_id))
            .is_ok_and(|m| m.file_type().is_symlink())
    {
        return Err("KNOWLEDGE_UNTRUSTED_PATH".into());
    }
    let dir = kb_dir(app_data_dir, kb_id);
    if fs::symlink_metadata(&dir).is_ok_and(|m| m.file_type().is_symlink()) {
        return Err("KNOWLEDGE_UNTRUSTED_PATH".to_string());
    }
    if create {
        fs::create_dir_all(&dir)
            .map_err(|error| format!("创建知识库目录失败 {}: {error}", dir.display()))?;
    }
    let mut flags = OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX;
    if create {
        flags |= OpenFlags::SQLITE_OPEN_CREATE;
    }
    let conn = Connection::open_with_flags(db_path(app_data_dir, kb_id), flags)
        .map_err(|error| format!("打开知识库索引失败: {error}"))?;
    conn.busy_timeout(Duration::from_secs(3)).map_err(|error| error.to_string())?;
    init_db(&conn)?;
    ensure_lexical_index(&conn)?;
    Ok(conn)
}

fn open_db(app_data_dir: &Path, kb_id: &str) -> Result<Connection, String> {
    validate_id(kb_id)?;
    if !db_path(app_data_dir, kb_id).is_file() {
        return Err("知识库不存在".into());
    }
    open_knowledge_db(app_data_dir, kb_id, false)
}

fn init_db(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        r#"
        PRAGMA journal_mode = WAL;
        CREATE TABLE IF NOT EXISTS knowledge_base (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          description TEXT NOT NULL,
          enabled INTEGER NOT NULL,
          index_status TEXT NOT NULL,
          embedding_profile TEXT NOT NULL,
          created_at_ms INTEGER NOT NULL,
          updated_at_ms INTEGER NOT NULL,
          preset_id TEXT
        );
        CREATE TABLE IF NOT EXISTS sources (
          id TEXT PRIMARY KEY,
          kb_id TEXT NOT NULL,
          title TEXT NOT NULL,
          original_path TEXT NOT NULL,
          storage_path TEXT NOT NULL,
          ext TEXT NOT NULL,
          size_bytes INTEGER NOT NULL,
          hash TEXT NOT NULL,
          status TEXT NOT NULL,
          metadata TEXT NOT NULL,
          last_indexed_at_ms INTEGER NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS sources_kb_hash_idx ON sources(kb_id, hash);
        CREATE TABLE IF NOT EXISTS chunks (
          id TEXT PRIMARY KEY,
          source_id TEXT NOT NULL,
          kb_id TEXT NOT NULL,
          chunk_index INTEGER NOT NULL,
          text TEXT NOT NULL,
          hash TEXT NOT NULL,
          page INTEGER,
          block TEXT,
          heading TEXT,
          token_count INTEGER NOT NULL,
          embedding_status TEXT NOT NULL,
          embedding TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS chunks_source_idx ON chunks(source_id);
        CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
          text,
          title,
          source_id UNINDEXED,
          chunk_id UNINDEXED,
          tokenize = 'unicode61'
        );
        CREATE TABLE IF NOT EXISTS toc_entries (
          id TEXT PRIMARY KEY,
          kb_id TEXT NOT NULL,
          symbol TEXT NOT NULL,
          title TEXT NOT NULL,
          url TEXT NOT NULL UNIQUE,
          hydrated_source_id TEXT
        );
        CREATE TABLE IF NOT EXISTS toc_snapshot_entries (
          source_key TEXT NOT NULL,
          entry_id TEXT NOT NULL,
          PRIMARY KEY (source_key, entry_id)
        );
        CREATE INDEX IF NOT EXISTS toc_snapshot_entry_idx ON toc_snapshot_entries(entry_id);
        CREATE TABLE IF NOT EXISTS source_provenance (
          source_id TEXT PRIMARY KEY,
          content_hash TEXT NOT NULL,
          kind TEXT NOT NULL,
          url TEXT
        );
        CREATE TABLE IF NOT EXISTS hydration_revision_edges (
          after_revision TEXT PRIMARY KEY,
          before_revision TEXT NOT NULL
        );
        CREATE VIRTUAL TABLE IF NOT EXISTS toc_fts USING fts5(
          symbol,
          title,
          entry_id UNINDEXED,
          tokenize = 'unicode61'
        );
        "#,
    )
    .map_err(|error| format!("初始化知识库索引失败: {error}"))?;
    let _ = conn.execute("ALTER TABLE knowledge_base ADD COLUMN preset_id TEXT", []);
    Ok(())
}

fn ensure_lexical_index(conn: &Connection) -> Result<(), String> {
    let profile: Option<String> = conn
        .query_row(
            "SELECT embedding_profile FROM knowledge_base LIMIT 1",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    if profile
        .as_deref()
        .is_none_or(|value| value == LEXICAL_PROFILE)
    {
        return Ok(());
    }
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let rows = {
        let mut stmt = tx.prepare("SELECT c.text, s.title, c.source_id, c.id FROM chunks c JOIN sources s ON s.id=c.source_id ORDER BY c.id").map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                ))
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        rows
    };
    tx.execute("DELETE FROM chunks_fts", [])
        .map_err(|e| e.to_string())?;
    for (text, title, source, chunk) in rows {
        tx.execute(
            "INSERT INTO chunks_fts(text,title,source_id,chunk_id) VALUES (?1,?2,?3,?4)",
            params![
                lexical_index_text(&text),
                lexical_index_text(&title),
                source,
                chunk
            ],
        )
        .map_err(|e| e.to_string())?;
    }
    tx.execute(
        "UPDATE chunks SET embedding_status='not_required',embedding='[]'",
        [],
    )
    .map_err(|e| e.to_string())?;
    tx.execute(
        "UPDATE knowledge_base SET embedding_profile=?1",
        params![LEXICAL_PROFILE],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())
}

fn base_from_row(conn: &Connection) -> Result<KnowledgeBase, String> {
    let revision = index_revision(conn)?;
    conn.query_row(
        "SELECT id, name, description, enabled, index_status, embedding_profile, created_at_ms, updated_at_ms, preset_id FROM knowledge_base LIMIT 1",
        [],
        |row| {
            let id: String = row.get(0)?;
            let source_count = conn
                .query_row("SELECT COUNT(*) FROM sources", [], |count_row| count_row.get::<_, i64>(0))
                .unwrap_or(0)
                .max(0) as usize;
            let toc_entry_count = conn
                .query_row("SELECT COUNT(DISTINCT entry_id) FROM toc_snapshot_entries", [], |count_row| count_row.get::<_, i64>(0))
                .unwrap_or(0)
                .max(0) as usize;
            Ok(KnowledgeBase {
                id,
                name: row.get(1)?,
                description: row.get(2)?,
                enabled: row.get::<_, i64>(3)? != 0,
                source_count,
                index_status: row.get(4)?,
                embedding_profile: row.get(5)?,
                index_revision: revision.clone(),
                created_at_ms: row.get::<_, i64>(6)?.max(0) as u64,
                updated_at_ms: row.get::<_, i64>(7)?.max(0) as u64,
                preset_id: row.get::<_, Option<String>>(8)?.filter(|value| !value.trim().is_empty()),
                toc_entry_count,
                toc_indexed_source_count: conn.query_row(
                    "SELECT COUNT(DISTINCT source_key) FROM toc_snapshot_entries WHERE source_key<>'builtin'",
                    [], |row| row.get::<_, i64>(0)
                )?.max(0) as usize,
                preset_sync_status: None,
            })
        },
    )
    .map_err(|error| format!("读取知识库元数据失败: {error}"))
}

fn source_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<KnowledgeSource> {
    let metadata_text: String = row.get(9)?;
    Ok(KnowledgeSource {
        id: row.get(0)?,
        kb_id: row.get(1)?,
        title: row.get(2)?,
        original_path: row.get(3)?,
        storage_path: row.get(4)?,
        ext: row.get(5)?,
        size: row.get::<_, i64>(6)?.max(0) as u64,
        hash: row.get(7)?,
        status: row.get(8)?,
        metadata: serde_json::from_str(&metadata_text).unwrap_or(Value::Null),
        last_indexed_at_ms: row.get::<_, i64>(10)?.max(0) as u64,
        source_revision: String::new(),
        provenance: None,
    })
}

pub fn create_knowledge_base(
    app_data_dir: &Path,
    name: &str,
    description: &str,
) -> Result<KnowledgeBase, String> {
    let _guard = PRESET_COMMIT_LOCK.lock().map_err(|error| error.to_string())?;
    let root = knowledge_root(app_data_dir);
    fs::create_dir_all(&root)
        .map_err(|error| format!("创建知识库根目录失败 {}: {error}", root.display()))?;
    let id = make_id("kb", name);
    let conn = open_or_create_db(app_data_dir, &id)?;
    let now = now_millis() as i64;
    conn.execute(
        "INSERT INTO knowledge_base (id, name, description, enabled, index_status, embedding_profile, created_at_ms, updated_at_ms) VALUES (?1, ?2, ?3, 1, 'empty', 'fts5_cjk_bigram_v2', ?4, ?4)",
        params![&id, name.trim(), description.trim(), now],
    )
    .map_err(|error| format!("创建知识库失败: {error}"))?;
    base_from_row(&conn)
}

pub fn ensure_preset_knowledge_base(
    app_data_dir: &Path,
    preset: &presets::EngineManualPreset,
) -> Result<KnowledgeBase, String> {
    let _guard = PRESET_COMMIT_LOCK.lock().map_err(|e| e.to_string())?;
    for existing in list_knowledge_bases_locked(app_data_dir)? {
        if existing.preset_id.as_deref() == Some(preset.preset_id.as_str()) {
            let conn = open_db(app_data_dir, &existing.id)?;
            conn.execute(
                "UPDATE knowledge_base SET name = ?1, description = ?2, updated_at_ms = ?3 WHERE id = ?4",
                params![preset.name.trim(), preset.description.trim(), now_millis() as i64, &existing.id],
            )
            .map_err(|e| format!("更新预设知识库失败: {e}"))?;
            return base_from_row(&conn);
        }
    }
    let root = knowledge_root(app_data_dir);
    fs::create_dir_all(&root)
        .map_err(|error| format!("创建知识库根目录失败 {}: {error}", root.display()))?;
    let id = format!("kb_preset_{}", sanitize_file_name(&preset.preset_id));
    let conn = open_or_create_db(app_data_dir, &id)?;
    let now = now_millis() as i64;
    conn.execute(
        "INSERT OR REPLACE INTO knowledge_base (id, name, description, enabled, index_status, embedding_profile, created_at_ms, updated_at_ms, preset_id) VALUES (?1, ?2, ?3, 1, 'empty', 'fts5_cjk_bigram_v2', ?4, ?4, ?5)",
        params![&id, preset.name.trim(), preset.description.trim(), now, &preset.preset_id],
    )
    .map_err(|error| format!("创建预设知识库失败: {error}"))?;
    base_from_row(&conn)
}

pub fn replace_toc_snapshot(
    app_data_dir: &Path,
    base: &KnowledgeBase,
    source_key: &str,
    entries: &[presets::TocSeedEntry],
) -> Result<usize, String> {
    if entries.is_empty() {
        return Err("KNOWLEDGE_TOC_EMPTY".into());
    }
    let _guard = PRESET_COMMIT_LOCK.lock().map_err(|e| e.to_string())?;
    let kb_id = &base.id;
    let mut conn = open_db(app_data_dir, kb_id)?;
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| format!("开启 TOC 索引事务失败: {error}"))?;
    let current = base_from_row(&tx)?;
    if current.created_at_ms != base.created_at_ms || current.preset_id != base.preset_id {
        return Err("STALE_KNOWLEDGE_REFERENCE: preset library was replaced".into());
    }
    tx.execute("DELETE FROM toc_snapshot_entries WHERE source_key=?1", params![source_key])
        .map_err(|error| error.to_string())?;
    let mut inserted = 0usize;
    for item in entries {
        let url = item.url.trim();
        let symbol = item.symbol.trim();
        let title = item.title.trim();
        if url.is_empty() || title.is_empty() {
            continue;
        }
        let entry_id = format!("toc_{}", short_hash(url.as_bytes()));
        tx.execute(
            "INSERT INTO toc_entries (id, kb_id, symbol, title, url, hydrated_source_id)
             VALUES (?1, ?2, ?3, ?4, ?5, NULL)
             ON CONFLICT(url) DO UPDATE SET symbol = excluded.symbol, title = excluded.title",
            params![&entry_id, kb_id, symbol, title, url],
        )
        .map_err(|error| format!("写入 TOC 条目失败: {error}"))?;
        tx.execute(
            "DELETE FROM toc_fts WHERE entry_id = ?1",
            params![&entry_id],
        )
        .map_err(|error| format!("更新 TOC 全文索引失败: {error}"))?;
        tx.execute(
            "INSERT INTO toc_fts (symbol, title, entry_id) VALUES (?1, ?2, ?3)",
            params![
                lexical_index_text(symbol),
                lexical_index_text(title),
                &entry_id
            ],
        )
        .map_err(|error| format!("写入 TOC 全文索引失败: {error}"))?;
        tx.execute(
            "INSERT OR IGNORE INTO toc_snapshot_entries (source_key,entry_id) VALUES (?1,?2)",
            params![source_key, &entry_id],
        ).map_err(|error| error.to_string())?;
        inserted += 1;
    }
    tx.execute_batch(
        "DELETE FROM toc_fts WHERE entry_id NOT IN (SELECT entry_id FROM toc_snapshot_entries);
         DELETE FROM toc_entries WHERE id NOT IN (SELECT entry_id FROM toc_snapshot_entries);"
    ).map_err(|error| error.to_string())?;
    tx.execute(
        "UPDATE knowledge_base SET updated_at_ms = ?1 WHERE id = ?2",
        params![now_millis() as i64, kb_id],
    )
    .map_err(|error| format!("更新知识库时间戳失败: {error}"))?;
    tx.commit()
        .map_err(|error| format!("提交 TOC 索引事务失败: {error}"))?;
    Ok(inserted)
}

pub fn search_unhydrated_toc_entries(
    app_data_dir: &Path,
    kb_id: &str,
    query: &str,
    limit: usize,
) -> Result<Vec<(String, String, String)>, String> {
    let fts_query = normalize_fts_query(query);
    if fts_query.trim().is_empty() {
        return Ok(Vec::new());
    }
    let conn = open_db(app_data_dir, kb_id)?;
    let mut stmt = conn
        .prepare(
            r#"
            SELECT t.id, t.title, t.url, bm25(toc_fts) AS rank
            FROM toc_fts
            JOIN toc_entries t ON t.id = toc_fts.entry_id
            WHERE toc_fts MATCH ?1
              AND EXISTS(SELECT 1 FROM toc_snapshot_entries d WHERE d.entry_id=t.id)
              AND NOT EXISTS(
                SELECT 1 FROM sources s JOIN source_provenance p ON p.source_id=s.id
                WHERE s.id=t.hydrated_source_id AND s.status='indexed' AND s.hash=p.content_hash
                  AND p.kind='official_document'
              )
            ORDER BY rank, t.id
            LIMIT ?2
            "#,
        )
        .map_err(|error| format!("查询 TOC 索引失败: {error}"))?;
    let rows = stmt
        .query_map(params![fts_query, limit.clamp(1, 5) as i64], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .map_err(|error| format!("读取 TOC 索引匹配失败: {error}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

pub fn list_knowledge_bases(app_data_dir: &Path) -> Result<Vec<KnowledgeBase>, String> {
    let _guard = PRESET_COMMIT_LOCK.lock().map_err(|error| error.to_string())?;
    list_knowledge_bases_locked(app_data_dir)
}

fn list_knowledge_bases_locked(app_data_dir: &Path) -> Result<Vec<KnowledgeBase>, String> {
    let root = knowledge_root(app_data_dir);
    if !root.exists() {
        return Ok(Vec::new());
    }
    let mut bases = Vec::new();
    let entries = fs::read_dir(&root)
        .map_err(|error| format!("读取知识库目录失败 {}: {error}", root.display()))?;
    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        if entry.file_type().map_err(|e| e.to_string())?.is_symlink() {
            return Err("KNOWLEDGE_UNTRUSTED_PATH".into());
        }
        let path = entry.path();
        if !path.is_dir() || !path.join("index.sqlite").exists() {
            continue;
        }
        let Some(kb_id) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        if kb_id.starts_with('.') {
            continue;
        }
        let conn = open_db(app_data_dir, kb_id)?;
        let has_metadata: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM knowledge_base LIMIT 1)",
                [],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())?;
        if !has_metadata {
            let has_sources: bool = conn
                .query_row("SELECT EXISTS(SELECT 1 FROM sources LIMIT 1)", [], |row| {
                    row.get(0)
                })
                .map_err(|error| error.to_string())?;
            drop(conn);
            if !has_sources {
                let _ = fs::remove_dir_all(&path);
            }
            continue;
        }
        bases.push(base_from_row(&conn)?);
    }
    bases.sort_by(|a, b| {
        b.updated_at_ms
            .cmp(&a.updated_at_ms)
            .then(a.name.cmp(&b.name))
    });
    Ok(bases)
}

pub fn get_knowledge_base(app_data_dir: &Path, kb_id: &str) -> Result<KnowledgeBase, String> {
    validate_id(kb_id)?;
    if !db_path(app_data_dir, kb_id).is_file() {
        return Err("知识库不存在".into());
    }
    base_from_row(&open_db(app_data_dir, kb_id)?)
}

pub fn list_sources(app_data_dir: &Path, kb_id: &str) -> Result<Vec<KnowledgeSource>, String> {
    let conn = open_db(app_data_dir, kb_id)?;
    let mut stmt = conn
        .prepare(
            "SELECT id, kb_id, title, original_path, storage_path, ext, size_bytes, hash, status, metadata, last_indexed_at_ms FROM sources ORDER BY last_indexed_at_ms DESC",
        )
        .map_err(|error| format!("读取知识库来源失败: {error}"))?;
    let rows = stmt
        .query_map([], source_from_row)
        .map_err(|error| format!("读取知识库来源失败: {error}"))?;
    rows.map(|row| {
        row.map_err(|error| error.to_string())
            .and_then(|source| hydrate_source(&conn, source))
    })
    .collect()
}

pub fn stored_sources(app_data_dir: &Path, kb_id: &str) -> Result<Vec<StoredSource>, String> {
    list_sources(app_data_dir, kb_id).map(|sources| {
        sources
            .into_iter()
            .map(|source| StoredSource {
                storage_path: PathBuf::from(&source.storage_path),
                source,
            })
            .collect()
    })
}

pub fn set_knowledge_base_enabled(
    app_data_dir: &Path,
    kb_id: &str,
    enabled: bool,
) -> Result<KnowledgeBase, String> {
    let conn = open_db(app_data_dir, kb_id)?;
    conn.execute(
        "UPDATE knowledge_base SET enabled = ?1, updated_at_ms = ?2",
        params![if enabled { 1 } else { 0 }, now_millis() as i64],
    )
    .map_err(|error| format!("更新知识库开关失败: {error}"))?;
    base_from_row(&conn)
}

pub fn delete_knowledge_base(app_data_dir: &Path, kb_id: &str) -> Result<(), String> {
    let _guard = PRESET_COMMIT_LOCK.lock().map_err(|e| e.to_string())?;
    validate_id(kb_id)?;
    let dir = kb_dir(app_data_dir, kb_id);
    if dir.exists() {
        fs::remove_dir_all(&dir)
            .map_err(|error| format!("删除知识库失败 {}: {error}", dir.display()))?;
    }
    Ok(())
}

fn normalize_text(text: &str) -> String {
    text.replace("\r\n", "\n")
        .replace('\r', "\n")
        .lines()
        .map(str::trim)
        .collect::<Vec<_>>()
        .join("\n")
        .split("\n\n\n")
        .collect::<Vec<_>>()
        .join("\n\n")
        .trim()
        .to_string()
}

fn split_large_text(text: &str) -> Vec<String> {
    let text = normalize_text(text);
    if text.chars().count() <= CHUNK_TARGET_CHARS {
        return if text.is_empty() {
            Vec::new()
        } else {
            vec![text]
        };
    }
    let chars: Vec<char> = text.chars().collect();
    let mut chunks = Vec::new();
    let mut start = 0;
    while start < chars.len() {
        let mut end = (start + CHUNK_TARGET_CHARS).min(chars.len());
        if end < chars.len() {
            let search_start = start + CHUNK_TARGET_CHARS.saturating_sub(600);
            if let Some(relative) = chars[search_start..end]
                .iter()
                .rposition(|ch| matches!(ch, '\n' | '.' | '。' | ';' | '；'))
            {
                end = search_start + relative + 1;
            }
        }
        let chunk = chars[start..end]
            .iter()
            .collect::<String>()
            .trim()
            .to_string();
        if !chunk.is_empty() {
            chunks.push(chunk);
        }
        if end >= chars.len() {
            break;
        }
        start = end.saturating_sub(CHUNK_OVERLAP_CHARS);
    }
    chunks
}

fn value_as_usize(value: Option<&Value>) -> Option<usize> {
    value
        .and_then(Value::as_u64)
        .and_then(|number| usize::try_from(number).ok())
}

fn block_label(block: &Value) -> Option<String> {
    for key in ["sourceLabel", "kind", "rowStart", "paragraph", "table"] {
        let Some(value) = block.get(key) else {
            continue;
        };
        if let Some(text) = value.as_str() {
            if !text.trim().is_empty() {
                return Some(text.trim().to_string());
            }
        } else if value.is_number() {
            return Some(format!("{key} {value}"));
        }
    }
    None
}

fn chunks_from_extracted(extracted: &Value) -> Vec<ChunkInput> {
    let mut chunks = Vec::new();
    let blocks = extracted
        .get("blocks")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let source_blocks = if blocks.is_empty() {
        vec![serde_json::json!({
            "text": extracted.get("content").and_then(Value::as_str).unwrap_or("")
        })]
    } else {
        blocks
    };
    for block in source_blocks {
        let text = block.get("text").and_then(Value::as_str).unwrap_or("");
        let page = value_as_usize(block.get("page"));
        let label = block_label(&block);
        let heading = block
            .get("heading")
            .and_then(Value::as_str)
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        for part in split_large_text(text) {
            chunks.push(ChunkInput {
                index: chunks.len(),
                text: part,
                page,
                block: label.clone(),
                heading: heading.clone(),
            });
        }
    }
    chunks
}

fn estimate_tokens(text: &str) -> usize {
    (text.chars().count() / 3).max(1)
}

fn source_status(extracted: &Value, chunks: &[ChunkInput]) -> String {
    let warning = extracted
        .get("metadata")
        .and_then(|metadata| metadata.get("warning"))
        .and_then(Value::as_str)
        .unwrap_or("");
    if chunks.is_empty() && warning.to_lowercase().contains("ocr") {
        "needs_ocr".to_string()
    } else if chunks.is_empty() {
        "empty".to_string()
    } else {
        "indexed".to_string()
    }
}

fn get_existing_source_by_hash(
    conn: &Connection,
    kb_id: &str,
    hash: &str,
) -> Result<Option<KnowledgeSource>, String> {
    conn.query_row(
        "SELECT id, kb_id, title, original_path, storage_path, ext, size_bytes, hash, status, metadata, last_indexed_at_ms FROM sources WHERE kb_id = ?1 AND hash = ?2 LIMIT 1",
        params![kb_id, hash],
        source_from_row,
    )
    .optional()
    .map_err(|error| format!("检查知识库重复来源失败: {error}"))?
    .map(|source| hydrate_source(conn, source)).transpose()
}

fn get_existing_source_by_storage_path(
    conn: &Connection,
    kb_id: &str,
    storage_path: &Path,
) -> Result<Option<KnowledgeSource>, String> {
    conn.query_row(
        "SELECT id, kb_id, title, original_path, storage_path, ext, size_bytes, hash, status, metadata, last_indexed_at_ms FROM sources WHERE kb_id = ?1 AND storage_path = ?2 LIMIT 1",
        params![kb_id, storage_path.to_string_lossy().to_string()],
        source_from_row,
    )
    .optional()
    .map_err(|error| format!("检查知识库来源路径失败: {error}"))?
    .map(|source| hydrate_source(conn, source)).transpose()
}

fn delete_source_chunks(conn: &Connection, source_id: &str) -> Result<(), String> {
    conn.execute(
        "DELETE FROM chunks_fts WHERE source_id = ?1",
        params![source_id],
    )
    .map_err(|error| format!("清理知识库全文索引失败: {error}"))?;
    conn.execute(
        "DELETE FROM chunks WHERE source_id = ?1",
        params![source_id],
    )
    .map_err(|error| format!("清理知识库分块失败: {error}"))?;
    Ok(())
}

pub fn index_extracted_source(
    app_data_dir: &Path,
    kb_id: &str,
    original_path: &Path,
    storage_path: &Path,
    extracted: &Value,
    force: bool,
) -> Result<KnowledgeImportResult, String> {
    let mut conn = open_db(app_data_dir, kb_id)?;
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| format!("打开知识库索引事务失败: {error}"))?;
    let result = index_extracted_source_in_transaction(&tx, kb_id, original_path, storage_path, extracted, force, true)?;
    tx.commit().map_err(|error| format!("提交知识库索引失败: {error}"))?;
    Ok(result)
}

fn index_extracted_source_in_transaction(
    tx: &Connection,
    kb_id: &str,
    original_path: &Path,
    storage_path: &Path,
    extracted: &Value,
    force: bool,
    repair_failed: bool,
) -> Result<KnowledgeImportResult, String> {
    let hash = file_hash(storage_path)?;
    let force = force
        || (repair_failed && get_existing_source_by_hash(tx, kb_id, &hash)?
            .is_some_and(|source| source.status == "failed"));
    if !force {
        if let Some(source) = get_existing_source_by_hash(tx, kb_id, &hash)? {
            return Ok(KnowledgeImportResult {
                base: base_from_row(tx)?,
                source,
                chunks: 0,
                deduped: true,
            });
        }
    }

    let title = extracted
        .get("title")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or_else(|| {
            storage_path
                .file_stem()
                .and_then(|name| name.to_str())
                .map(str::to_string)
        })
        .unwrap_or_else(|| "Untitled Source".to_string());
    let ext = storage_path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| format!(".{}", value.to_lowercase()))
        .unwrap_or_default();
    let metadata = serde_json::json!({
        "documentType": extracted.get("documentType").cloned().unwrap_or(Value::Null),
        "title": extracted.get("title").cloned().unwrap_or(Value::Null),
        "metadata": extracted.get("metadata").cloned().unwrap_or(Value::Null),
        "charCount": extracted.get("charCount").cloned().unwrap_or(Value::Null),
        "truncated": extracted.get("truncated").cloned().unwrap_or(Value::Bool(false)),
    });
    let chunks = chunks_from_extracted(extracted);
    let status = source_status(extracted, &chunks);
    let now = now_millis();
    let source_id = if force {
        get_existing_source_by_storage_path(tx, kb_id, storage_path)?
            .or(get_existing_source_by_hash(tx, kb_id, &hash)?)
            .map(|source| source.id)
            .unwrap_or_else(|| make_id("src", &hash))
    } else {
        make_id("src", &hash)
    };

    if force {
        delete_source_chunks(tx, &source_id)?;
        tx.execute("DELETE FROM sources WHERE id = ?1", params![source_id])
            .map_err(|error| format!("刷新知识库来源失败: {error}"))?;
    }
    tx.execute(
        "INSERT OR REPLACE INTO sources (id, kb_id, title, original_path, storage_path, ext, size_bytes, hash, status, metadata, last_indexed_at_ms) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
        params![
            &source_id,
            kb_id,
            &title,
            original_path.to_string_lossy().to_string(),
            storage_path.to_string_lossy().to_string(),
            &ext,
            fs::metadata(storage_path).map(|metadata| metadata.len()).unwrap_or(0) as i64,
            &hash,
            &status,
            metadata.to_string(),
            now as i64,
        ],
    )
    .map_err(|error| format!("写入知识库来源失败: {error}"))?;

    for chunk in &chunks {
        let chunk_id = format!("{source_id}:{}", chunk.index);
        let chunk_hash = short_hash(chunk.text.as_bytes());
        let embedding = "[]";
        tx.execute(
            "INSERT INTO chunks (id, source_id, kb_id, chunk_index, text, hash, page, block, heading, token_count, embedding_status, embedding) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'not_required', ?11)",
            params![
                &chunk_id,
                &source_id,
                kb_id,
                chunk.index as i64,
                &chunk.text,
                &chunk_hash,
                chunk.page.map(|value| value as i64),
                &chunk.block,
                &chunk.heading,
                estimate_tokens(&chunk.text) as i64,
                &embedding,
            ],
        )
        .map_err(|error| format!("写入知识库分块失败: {error}"))?;
        tx.execute(
            "INSERT INTO chunks_fts (text, title, source_id, chunk_id) VALUES (?1, ?2, ?3, ?4)",
            params![
                lexical_index_text(&chunk.text),
                lexical_index_text(&title),
                &source_id,
                &chunk_id
            ],
        )
        .map_err(|error| format!("写入知识库全文索引失败: {error}"))?;
    }

    let next_status: String = tx.query_row("SELECT CASE WHEN EXISTS(SELECT 1 FROM sources WHERE status='failed') THEN 'error' WHEN EXISTS(SELECT 1 FROM chunks) THEN 'ready' WHEN EXISTS(SELECT 1 FROM sources WHERE status='needs_ocr') THEN 'needs_ocr' ELSE 'empty' END", [], |row| row.get(0)).map_err(|e| e.to_string())?;
    tx.execute(
        "UPDATE knowledge_base SET index_status = ?1, updated_at_ms = ?2 WHERE id = ?3",
        params![next_status, now as i64, kb_id],
    )
    .map_err(|error| format!("更新知识库状态失败: {error}"))?;
    let base = base_from_row(tx)?;
    let source = get_existing_source_by_hash(tx, kb_id, &file_hash(storage_path)?)?
        .ok_or_else(|| "知识库来源写入后未找到".to_string())?;
    Ok(KnowledgeImportResult {
        base,
        source,
        chunks: chunks.len(),
        deduped: false,
    })
}

fn is_cjk(ch: char) -> bool {
    matches!(ch as u32, 0x3400..=0x4dbf | 0x4e00..=0x9fff | 0xf900..=0xfaff | 0x20000..=0x323af)
}

fn lexical_terms(value: &str, indexing: bool) -> Vec<String> {
    let mut result = Vec::new();
    let mut run = String::new();
    let mut cjk = false;
    let flush = |run: &mut String, cjk: bool, result: &mut Vec<String>| {
        if run.is_empty() {
            return;
        }
        if cjk {
            let chars: Vec<char> = run.chars().collect();
            if indexing || chars.len() == 1 {
                result.extend(chars.iter().map(char::to_string));
            }
            result.extend(chars.windows(2).map(|pair| pair.iter().collect::<String>()));
        } else {
            result.push(run.to_lowercase());
        }
        run.clear();
    };
    for ch in value.chars() {
        let next_cjk = is_cjk(ch);
        if ch.is_alphanumeric() || ch == '_' {
            if !run.is_empty() && cjk != next_cjk {
                flush(&mut run, cjk, &mut result);
            }
            cjk = next_cjk;
            run.push(ch);
        } else {
            flush(&mut run, cjk, &mut result);
        }
    }
    flush(&mut run, cjk, &mut result);
    result
}

fn lexical_index_text(value: &str) -> String {
    lexical_terms(value, true).join(" ")
}

fn normalize_fts_query(query: &str) -> String {
    let mut seen = HashSet::new();
    lexical_terms(query, false)
        .into_iter()
        .filter(|term| seen.insert(term.clone()))
        .take(64)
        .map(|term| format!("\"{}\"", term.replace('"', "\"\"")))
        .collect::<Vec<_>>()
        .join(" OR ")
}

struct SelectedBase {
    base: KnowledgeBase,
    admitted_index_revision: String,
    allow_workspace_active: bool,
    source_ids: Option<Vec<String>>,
    source_revisions: HashMap<String, String>,
}

fn is_compatible_hydrated_revision(
    conn: &Connection,
    admitted_revision: &str,
    current_revision: &str,
) -> Result<bool, String> {
    let mut revision = current_revision.to_owned();
    let mut seen = HashSet::new();
    while revision != admitted_revision {
        if !seen.insert(revision.clone()) {
            return Ok(false);
        }
        let previous: Option<String> = conn
            .query_row(
                "SELECT before_revision FROM hydration_revision_edges WHERE after_revision=?1",
                params![revision],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| error.to_string())?;
        let Some(previous) = previous else {
            return Ok(false);
        };
        revision = previous;
    }
    Ok(true)
}

fn verify_base_revision(
    conn: &Connection,
    base: &KnowledgeBase,
    admitted_revision: &str,
    allow_workspace_active: bool,
) -> Result<(), String> {
    if allow_workspace_active && !base.enabled {
        return Err("STALE_KNOWLEDGE_REFERENCE: active library is disabled".into());
    }
    if base.index_revision == admitted_revision
        || (allow_workspace_active
            && is_compatible_hydrated_revision(conn, admitted_revision, &base.index_revision)?)
    {
        return Ok(());
    }
    Err("STALE_KNOWLEDGE_REFERENCE: selected library changed; select it again".into())
}

pub struct PresetDocument<'a> {
    pub title: &'a str,
    pub content: &'a str,
    pub source_url: &'a str,
    pub builtin_summary: bool,
    pub truncated: bool,
}

pub struct HydrationScope<'a> {
    pub admitted_revision: &'a str,
    pub toc_entry: Option<(&'a str, &'a str)>,
}

/// A fetched document may add bytes or verified provenance, but cannot replace a source.
pub fn append_preset_document(
    app_data_dir: &Path,
    base: &KnowledgeBase,
    preset: &presets::EngineManualPreset,
    document: PresetDocument<'_>,
    hydration: Option<HydrationScope<'_>>,
    cancelled: impl Fn() -> bool,
) -> Result<bool, String> {
    let url = url::Url::parse(document.source_url)
        .ok()
        .and_then(|url| preset.document_url(url))
        .ok_or("KNOWLEDGE_DOCUMENT_OUTSIDE_PRESET")?;
    let kind = if document.builtin_summary {
        "builtin_summary"
    } else {
        "official_document"
    };
    if document.content.trim().chars().count() < 40 {
        return Err("KNOWLEDGE_DOCUMENT_EMPTY".into());
    }
    let _guard = PRESET_COMMIT_LOCK
        .lock()
        .map_err(|error| error.to_string())?;
    let mut conn = open_db(app_data_dir, &base.id)?;
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| error.to_string())?;
    let current = base_from_row(&tx)?;
    if current.created_at_ms != base.created_at_ms
        || current.preset_id.as_deref() != Some(preset.preset_id.as_str())
    {
        return Err("STALE_KNOWLEDGE_REFERENCE: preset library was replaced".into());
    }
    if let Some(scope) = &hydration {
        verify_base_revision(&tx, &current, scope.admitted_revision, true)?;
        if let Some((entry_id, expected_url)) = scope.toc_entry {
            let valid: bool = tx
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM toc_entries t JOIN toc_snapshot_entries snapshot
                 ON snapshot.entry_id=t.id WHERE t.id=?1 AND t.url=?2)",
                    params![entry_id, expected_url],
                    |row| row.get(0),
                )
                .map_err(|error| error.to_string())?;
            if !valid {
                return Err("KNOWLEDGE_TOC_ENTRY_CHANGED".into());
            }
        }
    }
    if cancelled() {
        return Err("Aborted".into());
    }

    let hash = short_hash(document.content.as_bytes());
    let existing = get_existing_source_by_hash(&tx, &base.id, &hash)?;
    let mut staged_file = None;
    let result = (|| {
        let source = if let Some(source) = existing {
            source
        } else {
            let storage_dir = source_storage_dir(app_data_dir, &base.id);
            if fs::symlink_metadata(&storage_dir)
                .is_ok_and(|metadata| metadata.file_type().is_symlink())
            {
                return Err("KNOWLEDGE_UNTRUSTED_SOURCE_PATH".into());
            }
            fs::create_dir_all(&storage_dir).map_err(|error| error.to_string())?;
            let path = storage_dir.join(format!("official_{hash}.md"));
            let mut temp =
                tempfile::NamedTempFile::new_in(&storage_dir).map_err(|error| error.to_string())?;
            temp.write_all(document.content.as_bytes())
                .map_err(|error| error.to_string())?;
            match temp.persist_noclobber(&path) {
                Ok(_) => staged_file = Some(path.clone()),
                Err(error)
                    if error.error.kind() == std::io::ErrorKind::AlreadyExists
                        && fs::symlink_metadata(&path).is_ok_and(|meta| meta.is_file())
                        && file_hash(&path).as_deref() == Ok(hash.as_str()) => {}
                Err(error) => return Err(error.to_string()),
            }
            let extracted = serde_json::json!({
                "title": document.title,
                "documentType": "text",
                "content": document.content,
                "charCount": document.content.chars().count(),
                "truncated": document.truncated,
                "metadata": { "presetId": preset.preset_id, "kind": kind },
            });
            index_extracted_source_in_transaction(
                &tx,
                &base.id,
                Path::new(url.as_str()),
                &path,
                &extracted,
                false,
                false,
            )?
            .source
        };
        if source.status != "indexed" {
            return Err("KNOWLEDGE_DOCUMENT_NOT_INDEXED".into());
        }
        let proof_url = (!document.builtin_summary).then_some(url.as_str());
        let changed = tx.execute(
            "INSERT OR IGNORE INTO source_provenance (source_id, content_hash, kind, url) VALUES (?1,?2,?3,?4)",
            params![source.id, hash, kind, proof_url],
        ).map_err(|error| error.to_string())? > 0;

        if let Some(scope) = hydration {
            if let Some((entry_id, _)) = scope.toc_entry {
                tx.execute(
                    "UPDATE toc_entries SET hydrated_source_id=?1 WHERE id=?2",
                    params![source.id, entry_id],
                )
                .map_err(|error| error.to_string())?;
            }
            if changed {
                let after = index_revision(&tx)?;
                tx.execute(
                    "INSERT INTO hydration_revision_edges (after_revision,before_revision) VALUES (?1,?2)",
                    params![after, current.index_revision],
                ).map_err(|error| error.to_string())?;
            }
        }
        if cancelled() {
            return Err("Aborted".into());
        }
        tx.commit().map_err(|error| error.to_string())?;
        Ok(changed)
    })();
    if result.is_err() {
        if let Some(path) = staged_file {
            let _ = fs::remove_file(path);
        }
    }
    result
}

fn verify_selected_snapshot(
    conn: &Connection,
    selected: &SelectedBase,
) -> Result<KnowledgeBase, String> {
    let base = base_from_row(conn)?;
    if selected.source_ids.is_none() {
        verify_base_revision(
            conn, &base, &selected.admitted_index_revision, selected.allow_workspace_active,
        )?;
    } else {
        for (source, revision) in &selected.source_revisions {
            if source_revision(conn, source).ok().as_ref() != Some(revision) {
                return Err(
                    "STALE_KNOWLEDGE_REFERENCE: selected source changed; select it again".into(),
                );
            }
        }
    }
    Ok(base)
}

fn resolve_selected_bases(
    app_data_dir: &Path,
    references: &[KnowledgeReference],
) -> Result<Vec<SelectedBase>, String> {
    // Do not enumerate or open any knowledge storage without explicit selections.
    if references.is_empty() {
        return Ok(Vec::new());
    }
    let mut selected: HashMap<String, SelectedBase> = HashMap::new();
    for reference in references {
        let kb_id = match reference {
            KnowledgeReference::Base { kb_id, .. } | KnowledgeReference::Source { kb_id, .. } => {
                kb_id
            }
        };
        validate_id(kb_id)?;
        if !db_path(app_data_dir, kb_id).is_file() {
            return Err("STALE_KNOWLEDGE_REFERENCE: knowledge base no longer exists".into());
        }
        let conn = open_db(app_data_dir, kb_id)?;
        let base = base_from_row(&conn)?;
        match reference {
            KnowledgeReference::Base {
                index_revision,
                activation_mode,
                preset_id,
                ..
            } => {
                let allow_workspace_active = activation_mode.as_deref() == Some("workspace_active");
                if allow_workspace_active && (
                    base.preset_id.is_none() || preset_id != &base.preset_id
                ) {
                    return Err("STALE_KNOWLEDGE_REFERENCE: active preset does not match the library".into());
                }
                verify_base_revision(&conn, &base, index_revision, allow_workspace_active)?;
                selected.insert(
                    kb_id.clone(),
                    SelectedBase {
                        base,
                        admitted_index_revision: index_revision.clone(),
                        allow_workspace_active,
                        source_ids: None,
                        source_revisions: HashMap::new(),
                    },
                );
            }
            KnowledgeReference::Source {
                source_id,
                source_revision: revision,
                ..
            } => {
                let actual = source_revision(&conn, source_id).map_err(|_| {
                    "STALE_KNOWLEDGE_REFERENCE: source no longer exists".to_string()
                })?;
                if *revision != actual {
                    return Err(
                        "STALE_KNOWLEDGE_REFERENCE: selected source changed; select it again"
                            .into(),
                    );
                }
                let entry = selected.entry(kb_id.clone()).or_insert_with(|| SelectedBase {
                    admitted_index_revision: base.index_revision.clone(),
                    allow_workspace_active: false,
                    base,
                    source_ids: Some(Vec::new()),
                    source_revisions: HashMap::new(),
                });
                if let Some(ids) = &mut entry.source_ids {
                    if !ids.contains(source_id) {
                        ids.push(source_id.clone());
                    }
                    entry
                        .source_revisions
                        .insert(source_id.clone(), revision.clone());
                }
            }
        }
    }
    let mut result: Vec<_> = selected.into_values().collect();
    result.sort_by(|a, b| a.base.id.cmp(&b.base.id));
    Ok(result)
}

fn collect_bm25_hits(
    app_data_dir: &Path,
    selected: &SelectedBase,
    fts_query: &str,
    limit: usize,
) -> Result<Vec<CandidateHit>, String> {
    if fts_query.trim().is_empty() {
        return Ok(Vec::new());
    }
    let conn = open_db(app_data_dir, &selected.base.id)?;
    conn.execute_batch("BEGIN DEFERRED")
        .map_err(|e| e.to_string())?;
    let base = verify_selected_snapshot(&conn, selected)?;
    let filter = serde_json::to_string(&selected.source_ids).map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            r#"
            SELECT c.id, c.source_id, s.title, c.text, c.page, c.block, bm25(chunks_fts) AS rank,
                   CASE WHEN p.kind IS NOT NULL THEN p.url ELSE json_extract(s.metadata, '$.metadata.sourceUrl') END, p.kind
            FROM chunks_fts
            JOIN chunks c ON c.id = chunks_fts.chunk_id
            JOIN sources s ON s.id = c.source_id
            LEFT JOIN source_provenance p ON p.source_id=s.id AND p.content_hash=s.hash
            WHERE chunks_fts MATCH ?1 AND s.status = 'indexed' AND (?3 = 'null' OR c.source_id IN (SELECT value FROM json_each(?3)))
              AND (p.kind IS NOT NULL OR (
                ?4=0 AND COALESCE(json_extract(s.metadata, '$.metadata.autoHydrated'), 0)=0
                     AND COALESCE(json_extract(s.metadata, '$.metadata.builtinSeed'), 0)=0
                     AND COALESCE(json_extract(s.metadata, '$.metadata.seedUrl'), 0)=0
              ))
            ORDER BY rank, c.id
            LIMIT ?2
            "#,
        )
        .map_err(|error| format!("准备知识库全文检索失败: {error}"))?;
    let rows = stmt
        .query_map(params![fts_query, limit as i64, filter, selected.allow_workspace_active], |row| {
            let rank: f64 = row.get(6)?;
            let source_kind: Option<String> = row.get(8)?;
            let manual_scope = manual_source_scope(base.preset_id.as_deref(), source_kind.as_deref());
            Ok(CandidateHit {
                kb_id: base.id.clone(),
                kb_name: base.name.clone(),
                chunk_id: row.get(0)?,
                source_id: row.get(1)?,
                source_title: row.get(2)?,
                text: row.get(3)?,
                page: row
                    .get::<_, Option<i64>>(4)?
                    .map(|value| value.max(0) as usize),
                block: row.get(5)?,
                source_url: row.get(7)?,
                source_kind,
                manual_scope,
                rank,
                source_revision: String::new(),
                index_revision: base.index_revision.clone(),
                admitted_index_revision: selected.allow_workspace_active
                    .then(|| selected.admitted_index_revision.clone()),
            })
        })
        .map_err(|error| format!("执行知识库全文检索失败: {error}"))?;
    rows.map(|row| {
        let mut hit = row.map_err(|e| e.to_string())?;
        hit.source_revision = source_revision(&conn, &hit.source_id)?;
        Ok(hit)
    })
    .collect()
}

fn excerpt(text: &str, max_chars: usize) -> String {
    let normalized = normalize_text(text);
    if normalized.chars().count() <= max_chars {
        return normalized;
    }
    let mut result = normalized
        .chars()
        .take(max_chars.saturating_sub(3))
        .collect::<String>();
    result.push_str("...");
    result
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeCharRange {
    pub start: usize,
    pub end: usize,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeSourceOverview {
    pub total_chunks: usize,
    pub total_chars: usize,
    pub next_chunk_id: Option<String>,
}

fn matched_window(
    text: &str,
    query: &str,
    max_chars: usize,
) -> (String, KnowledgeCharRange, usize, bool) {
    let chars: Vec<char> = text.chars().collect();
    let total = chars.len();
    let folded: Vec<(char, usize)> = chars
        .iter()
        .enumerate()
        .flat_map(|(index, ch)| ch.to_lowercase().map(move |lower| (lower, index)))
        .collect();
    let lower: String = folded.iter().map(|(ch, _)| ch).collect();
    let positions: Vec<usize> = lexical_terms(query, false)
        .iter()
        .filter_map(|term| {
            lower
                .find(term)
                .map(|byte| folded[lower[..byte].chars().count()].1)
        })
        .collect();
    let mut start = 0;
    let mut best = 0;
    for position in &positions {
        let candidate = position
            .saturating_sub(max_chars / 3)
            .min(total.saturating_sub(max_chars));
        let coverage = positions
            .iter()
            .filter(|position| {
                **position >= candidate && **position < candidate.saturating_add(max_chars)
            })
            .count();
        if coverage > best {
            best = coverage;
            start = candidate;
        }
    }
    let end = start.saturating_add(max_chars).min(total);
    let content = chars[start..end].iter().collect();
    (
        content,
        KnowledgeCharRange { start, end },
        total,
        start == 0 && end == total,
    )
}

fn manual_source_scope(preset_id: Option<&str>, source_kind: Option<&str>) -> Option<(String, String)> {
    let kind = source_kind?;
    let preset = presets::find_engine_manual_preset(preset_id?)?;
    let scope = match kind {
        "builtin_summary" => "Built-in summary of selected topics",
        "official_document" => match preset.preset_id.as_str() {
            "unity6" => "Unity Manual and ScriptReference",
            "tuanjie" => "Tuanjie Manual and ScriptReference",
            "ue6_verse" => "UEFN Verse language and API documentation",
            _ => return None,
        },
        _ => return None,
    };
    Some((preset.documentation_version, scope.into()))
}

fn candidate_hit(hit: CandidateHit, query: &str) -> KnowledgeSearchHit {
    let (text, returned_char_range, total_chars, complete) = matched_window(&hit.text, query, 1600);
    let (documentation_version, documentation_coverage) = hit.manual_scope.unzip();
    KnowledgeSearchHit {
        excerpt: excerpt(&text, 700),
        text,
        returned_char_range,
        total_chars,
        complete,
        retrieval_kind: "lexical_match".into(),
        source_overview: None,
        citation: KnowledgeCitation {
            kb_id: hit.kb_id,
            kb_name: hit.kb_name,
            source_id: hit.source_id,
            source_title: hit.source_title,
            chunk_id: hit.chunk_id,
            page: hit.page,
            block: hit.block,
            source_url: hit.source_url,
            score: (-hit.rank).max(0.0) as f32,
            index_revision: hit.index_revision,
            admitted_index_revision: hit.admitted_index_revision,
            source_revision: hit.source_revision,
            source_kind: hit.source_kind,
            documentation_version,
            documentation_coverage,
        },
    }
}

/// Explicit single-source selection can start from an opening chunk even when
/// the user's request contains no source keywords. This is not a search match.
fn selected_source_overview(
    app_data_dir: &Path,
    references: &[KnowledgeReference],
) -> Result<Option<KnowledgeSearchHit>, String> {
    let unique: HashSet<(String, String)> = references
        .iter()
        .filter_map(|reference| match reference {
            KnowledgeReference::Source {
                kb_id, source_id, ..
            } => Some((kb_id.clone(), source_id.clone())),
            _ => None,
        })
        .collect();
    if unique.len() != 1
        || references
            .iter()
            .any(|r| matches!(r, KnowledgeReference::Base { .. }))
    {
        return Ok(None);
    }
    let (kb_id, source_id) = unique.into_iter().next().expect("one selected source");
    let selected = resolve_selected_bases(app_data_dir, references)?;
    let conn = open_db(app_data_dir, &kb_id)?;
    conn.execute_batch("BEGIN DEFERRED")
        .map_err(|e| e.to_string())?;
    verify_selected_snapshot(&conn, &selected[0])?;
    let first: Option<String> = conn
        .query_row(
            "SELECT id FROM chunks WHERE source_id=?1 ORDER BY chunk_index LIMIT 1",
            params![source_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let Some(first) = first else { return Ok(None) };
    // get_excerpt rechecks the exact same frozen selection before returning bytes.
    let Some(mut hit) = get_excerpt(app_data_dir, &source_id, &first, references)? else {
        return Ok(None);
    };
    let (text, range, total, complete) = matched_window(&hit.text, "", 1600);
    hit.text = text;
    hit.excerpt = excerpt(&hit.text, 700);
    hit.returned_char_range = range;
    hit.total_chars = total;
    hit.complete = complete;
    hit.retrieval_kind = "source_overview".into();
    hit.citation.score = 0.0;
    Ok(Some(hit))
}

pub fn search(
    app_data_dir: &Path,
    query: &str,
    references: &[KnowledgeReference],
    limit: usize,
) -> Result<KnowledgeSearchResult, String> {
    let query = query.trim();
    if query.is_empty() {
        return Err("knowledge_search 缺少 query".into());
    }
    let bases = resolve_selected_bases(app_data_dir, references)?;
    let fts_query = normalize_fts_query(query);
    let mut candidates = Vec::new();
    for selected in &bases {
        candidates.extend(collect_bm25_hits(app_data_dir, selected, &fts_query, 60)?);
    }
    candidates.sort_by(|a, b| {
        a.rank
            .total_cmp(&b.rank)
            .then(a.kb_id.cmp(&b.kb_id))
            .then(a.chunk_id.cmp(&b.chunk_id))
    });
    candidates.truncate(limit.clamp(1, 16));
    let mut hits: Vec<_> = candidates
        .into_iter()
        .map(|hit| candidate_hit(hit, query))
        .collect();
    let mut note="Local lexical matches within this message's selected materials only; no semantic or synonym recall is implied. Empty hits means no supporting indexed evidence was found in that scope.".to_string();
    if hits.is_empty() {
        if let Some(overview) = selected_source_overview(app_data_dir, references)? {
            hits.push(overview);
            note="NO_LEXICAL_MATCH: the explicitly selected single document's opening chunk is supplied as a limited source_overview, not a search match or a complete-document summary. Range metadata is zero-based/end-exclusive within the original chunk; sourceOverview reports total source chunks/chars and the next chunk for scoped continuation. Do not summarize unread parts.".into();
        }
    }
    Ok(KnowledgeSearchResult {
        query: query.into(),
        searched_knowledge_base_ids: bases.iter().map(|item| item.base.id.clone()).collect(),
        hits,
        note,
        attempted_tiers: vec!["local".into()],
        hydrated_count: 0,
    })
}

pub fn get_excerpt(
    app_data_dir: &Path,
    source_id: &str,
    chunk_id: &str,
    references: &[KnowledgeReference],
) -> Result<Option<KnowledgeSearchHit>, String> {
    for selected in resolve_selected_bases(app_data_dir, references)? {
        if selected
            .source_ids
            .as_ref()
            .is_some_and(|ids| !ids.iter().any(|id| id == source_id))
        {
            continue;
        }
        let conn = open_db(app_data_dir, &selected.base.id)?;
        conn.execute_batch("BEGIN DEFERRED")
            .map_err(|e| e.to_string())?;
        let base = verify_selected_snapshot(&conn, &selected)?;
        let row = conn.query_row(
            "SELECT c.text,s.title,c.page,c.block,c.chunk_index,
               CASE WHEN p.kind IS NOT NULL THEN p.url ELSE json_extract(s.metadata, '$.metadata.sourceUrl') END, p.kind
             FROM chunks c JOIN sources s ON s.id=c.source_id
             LEFT JOIN source_provenance p ON p.source_id=s.id AND p.content_hash=s.hash
             WHERE c.source_id=?1 AND c.id=?2 AND s.status='indexed'
               AND (p.kind IS NOT NULL OR (
                 ?3=0 AND COALESCE(json_extract(s.metadata, '$.metadata.autoHydrated'), 0)=0
                      AND COALESCE(json_extract(s.metadata, '$.metadata.builtinSeed'), 0)=0
                      AND COALESCE(json_extract(s.metadata, '$.metadata.seedUrl'), 0)=0
               ))",
            params![source_id, chunk_id, selected.allow_workspace_active],
            |row| Ok((
                row.get::<_,String>(0)?, row.get::<_,String>(1)?, row.get::<_,Option<i64>>(2)?,
                row.get::<_,Option<String>>(3)?, row.get::<_,i64>(4)?,
                row.get::<_,Option<String>>(5)?, row.get::<_,Option<String>>(6)?,
            )),
        ).optional().map_err(|error| error.to_string())?;
        if let Some((text, title, page, block, index, source_url, source_kind)) = row {
            let (documentation_version, documentation_coverage) =
                manual_source_scope(base.preset_id.as_deref(), source_kind.as_deref()).unzip();
            let total_chars = text.chars().count();
            let (total_chunks, source_chars): (i64, i64) = conn
                .query_row(
                    "SELECT COUNT(*),COALESCE(SUM(length(text)),0) FROM chunks WHERE source_id=?1",
                    params![source_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .map_err(|e| e.to_string())?;
            let next=conn.query_row("SELECT id FROM chunks WHERE source_id=?1 AND chunk_index>?2 ORDER BY chunk_index LIMIT 1",params![source_id,index],|row|row.get::<_,String>(0)).optional().map_err(|e|e.to_string())?;
            return Ok(Some(KnowledgeSearchHit {
                excerpt: excerpt(&text, 700),
                text,
                returned_char_range: KnowledgeCharRange {
                    start: 0,
                    end: total_chars,
                },
                total_chars,
                complete: true,
                retrieval_kind: "source_excerpt".into(),
                source_overview: Some(KnowledgeSourceOverview {
                    total_chunks: total_chunks.max(0) as usize,
                    total_chars: source_chars.max(0) as usize,
                    next_chunk_id: next,
                }),
                citation: KnowledgeCitation {
                    kb_id: base.id,
                    kb_name: base.name,
                    source_id: source_id.into(),
                    source_title: title,
                    chunk_id: chunk_id.into(),
                    page: page.map(|n| n.max(0) as usize),
                    block,
                    source_url,
                    source_kind,
                    documentation_version,
                    documentation_coverage,
                    score: 1.0,
                    index_revision: base.index_revision,
                    admitted_index_revision: selected.allow_workspace_active
                        .then(|| selected.admitted_index_revision.clone()),
                    source_revision: source_revision(&conn, source_id)?,
                },
            }));
        }
    }
    Ok(None)
}

/// A failed rebuild keeps prior chunks recoverable but cannot advertise them as a successful current index.
pub fn mark_source_failure(
    app_data_dir: &Path,
    kb_id: &str,
    source_id: &str,
    error: &str,
) -> Result<(), String> {
    let conn = open_db(app_data_dir, kb_id)?;
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    tx.execute("UPDATE sources SET status='failed',metadata=json_set(metadata,'$.metadata.importError',?1) WHERE id=?2",params![error,source_id]).map_err(|e|e.to_string())?;
    tx.execute("UPDATE knowledge_base SET index_status='error'", [])
        .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())
}

/// Persist a parse/import failure as a visible source, never an indexed success.
pub fn record_source_failure(
    app_data_dir: &Path,
    kb_id: &str,
    original_path: &Path,
    storage_path: &Path,
    error: &str,
) -> Result<(), String> {
    index_extracted_source(
        app_data_dir,
        kb_id,
        original_path,
        storage_path,
        &serde_json::json!({"title":original_path.file_name().and_then(|n| n.to_str()).unwrap_or("Source"),"content":"","metadata":{"importError":error}}),
        true,
    )?;
    let conn = open_db(app_data_dir, kb_id)?;
    conn.execute(
        "UPDATE sources SET status='failed' WHERE storage_path=?1",
        params![storage_path.to_string_lossy().as_ref()],
    )
    .map_err(|e| e.to_string())?;
    conn.execute("UPDATE knowledge_base SET index_status='error'", [])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn add_source(root: &Path, kb: &str, name: &str, content: &str) -> KnowledgeImportResult {
        let sources = source_storage_dir(root, kb);
        fs::create_dir_all(&sources).unwrap();
        let path = sources.join(name);
        fs::write(&path, content).unwrap();
        index_extracted_source(
            root,
            kb,
            &path,
            &path,
            &serde_json::json!({"title":name,"content":content}),
            false,
        )
        .unwrap()
    }
    fn base_ref(root: &Path, kb: &str) -> KnowledgeReference {
        KnowledgeReference::Base {
            kb_id: kb.into(),
            index_revision: get_knowledge_base(root, kb).unwrap().index_revision,
            activation_mode: None,
            preset_id: None,
        }
    }
    fn source_ref(source: &KnowledgeSource) -> KnowledgeReference {
        KnowledgeReference::Source {
            kb_id: source.kb_id.clone(),
            source_id: source.id.clone(),
            source_revision: source.source_revision.clone(),
        }
    }
    #[test]
    fn empty_scope_does_not_enumerate_or_create_storage() {
        let parent = tempfile::tempdir().unwrap();
        let missing = parent.path().join("not-created");
        let result = search(&missing, "知识库", &[], 8).unwrap();
        assert!(result.hits.is_empty());
        assert!(result.searched_knowledge_base_ids.is_empty());
        assert!(get_excerpt(&missing, "source", "chunk", &[])
            .unwrap()
            .is_none());
        assert!(!missing.exists());
    }
    #[test]
    fn selected_source_is_filtered_in_sql_and_other_sources_cannot_be_excerpted() {
        let root = tempfile::tempdir().unwrap();
        let base = create_knowledge_base(root.path(), "scope", "").unwrap();
        let a = add_source(root.path(), &base.id, "a.md", "中文知识库甲资料");
        let b = add_source(root.path(), &base.id, "b.md", "中文知识库乙资料");
        let references = [source_ref(&a.source)];
        let hits = search(root.path(), "知识库", &references, 1).unwrap();
        assert_eq!(hits.hits.len(), 1);
        assert_eq!(hits.hits[0].citation.source_id, a.source.id);
        assert!(get_excerpt(
            root.path(),
            &b.source.id,
            &format!("{}:0", b.source.id),
            &references
        )
        .unwrap()
        .is_none());
        let own = get_excerpt(
            root.path(),
            &a.source.id,
            &format!("{}:0", a.source.id),
            &references,
        )
        .unwrap()
        .unwrap();
        assert_eq!(own.citation.source_revision, a.source.source_revision);
        let stale = [KnowledgeReference::Source {
            kb_id: base.id,
            source_id: a.source.id,
            source_revision: "stale".into(),
        }];
        assert!(search(root.path(), "资料", &stale, 8)
            .unwrap_err()
            .contains("STALE_KNOWLEDGE_REFERENCE"));
    }
    #[test]
    fn library_membership_revision_changes_but_unchanged_selected_source_remains_valid() {
        let root = tempfile::tempdir().unwrap();
        let base = create_knowledge_base(root.path(), "versions", "").unwrap();
        let a = add_source(root.path(), &base.id, "a.md", "original alpha");
        let library = base_ref(root.path(), &base.id);
        let source = source_ref(&a.source);
        add_source(root.path(), &base.id, "b.md", "new beta");
        assert!(search(root.path(), "alpha", &[library], 8)
            .unwrap_err()
            .contains("STALE_KNOWLEDGE_REFERENCE"));
        assert_eq!(
            search(root.path(), "alpha", &[source.clone()], 8)
                .unwrap()
                .hits
                .len(),
            1
        );
        let path = PathBuf::from(a.source.storage_path);
        fs::write(&path, "replacement gamma").unwrap();
        index_extracted_source(
            root.path(),
            &base.id,
            &path,
            &path,
            &serde_json::json!({"content":"replacement gamma"}),
            true,
        )
        .unwrap();
        assert!(search(root.path(), "alpha", &[source], 8)
            .unwrap_err()
            .contains("STALE_KNOWLEDGE_REFERENCE"));
    }
    #[test]
    fn resolved_scope_is_rechecked_inside_the_query_snapshot() {
        let root = tempfile::tempdir().unwrap();
        let base = create_knowledge_base(root.path(), "race", "").unwrap();
        let first = add_source(root.path(), &base.id, "a.md", "alpha original");
        let resolved = resolve_selected_bases(root.path(), &[source_ref(&first.source)]).unwrap();
        let path = PathBuf::from(first.source.storage_path);
        fs::write(&path, "alpha replaced").unwrap();
        index_extracted_source(
            root.path(),
            &base.id,
            &path,
            &path,
            &serde_json::json!({"content":"alpha replaced"}),
            true,
        )
        .unwrap();
        assert!(
            collect_bm25_hits(root.path(), &resolved[0], &normalize_fts_query("alpha"), 60)
                .unwrap_err()
                .contains("STALE_KNOWLEDGE_REFERENCE")
        );
    }
    #[test]
    fn search_windows_keep_the_actual_tail_match_and_report_exact_original_range() {
        let root = tempfile::tempdir().unwrap();
        let base = create_knowledge_base(root.path(), "windows", "").unwrap();
        let original = format!("{}specialneedle", "甲".repeat(2200));
        let source = add_source(root.path(), &base.id, "long.md", &original);
        let result = search(
            root.path(),
            "specialneedle",
            &[source_ref(&source.source)],
            8,
        )
        .unwrap();
        let hit = &result.hits[0];
        assert!(hit.text.contains("specialneedle"));
        assert!(!hit.complete);
        assert!(hit.returned_char_range.start > 0);
        assert_eq!(hit.total_chars, original.chars().count());
        assert_eq!(
            hit.text,
            original
                .chars()
                .skip(hit.returned_char_range.start)
                .take(hit.returned_char_range.end - hit.returned_char_range.start)
                .collect::<String>()
        );
        assert_eq!(hit.retrieval_kind, "lexical_match");
    }
    #[test]
    fn single_selected_source_no_match_supplies_honest_opening_overview_only() {
        let root = tempfile::tempdir().unwrap();
        let base = create_knowledge_base(root.path(), "overview", "").unwrap();
        let source = add_source(
            root.path(),
            &base.id,
            "selected.md",
            &"中文原文。".repeat(700),
        );
        add_source(
            root.path(),
            &base.id,
            "other.md",
            "summaryxyz must not leak from this source",
        );
        let result = search(root.path(), "summaryxyz", &[source_ref(&source.source)], 8).unwrap();
        assert_eq!(result.hits.len(), 1);
        let hit = &result.hits[0];
        assert_eq!(hit.citation.source_id, source.source.id);
        assert_eq!(hit.citation.score, 0.0);
        assert_eq!(hit.retrieval_kind, "source_overview");
        assert!(result.note.contains("NO_LEXICAL_MATCH"));
        assert!(!hit.complete);
        let overview = hit.source_overview.as_ref().unwrap();
        assert!(overview.total_chunks > 1);
        assert!(overview.next_chunk_id.is_some());
        assert!(overview.total_chars > hit.total_chars);
        assert!(
            search(
                root.path(),
                "unmatched_unique_query",
                &[base_ref(root.path(), &base.id)],
                8
            )
            .unwrap()
            .hits
            .is_empty(),
            "whole-library no-match never falls back to unrelated openings"
        );
        let next = get_excerpt(
            root.path(),
            &source.source.id,
            overview.next_chunk_id.as_ref().unwrap(),
            &[source_ref(&source.source)],
        )
        .unwrap()
        .unwrap();
        assert_eq!(next.retrieval_kind, "source_excerpt");
        assert!(next.complete);
    }

    #[test]
    fn references_serde_matches_frozen_message_wire_and_rejects_missing_version() {
        let reference:KnowledgeReference=serde_json::from_value(serde_json::json!({"kind":"source","kbId":"kb_a","sourceId":"src_a","sourceRevision":"v1","label":"Display only"})).unwrap();
        assert_eq!(
            reference,
            KnowledgeReference::Source {
                kb_id: "kb_a".into(),
                source_id: "src_a".into(),
                source_revision: "v1".into()
            }
        );
        assert!(serde_json::from_value::<KnowledgeReference>(
            serde_json::json!({"kind":"base","kbId":"kb_a"})
        )
        .is_err());
    }
    #[test]
    fn lexical_results_keep_bm25_direction_and_never_fall_back_to_hash_similarity() {
        let root = tempfile::tempdir().unwrap();
        let base = create_knowledge_base(root.path(), "rank", "").unwrap();
        add_source(root.path(), &base.id, "a.md", "alpha alpha alpha");
        add_source(
            root.path(),
            &base.id,
            "b.md",
            "alpha beta beta beta beta beta beta",
        );
        add_source(root.path(), &base.id, "c.md", "beta gamma");
        let refs = [base_ref(root.path(), &base.id)];
        let hits = search(root.path(), "alpha", &refs, 8).unwrap().hits;
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].text, "alpha alpha alpha");
        assert!(hits[0].citation.score >= hits[1].citation.score);
        assert!(search(root.path(), "unrelatedxyz", &refs, 8)
            .unwrap()
            .hits
            .is_empty());
        let conn = open_db(root.path(), &base.id).unwrap();
        let embeddings:i64=conn.query_row("SELECT COUNT(*) FROM chunks WHERE embedding!='[]' OR embedding_status!='not_required'",[],|row|row.get(0)).unwrap();
        assert_eq!(embeddings, 0);
    }
    #[test]
    fn old_unicode_index_rebuilds_from_original_chunks_without_source_parser() {
        let root = tempfile::tempdir().unwrap();
        let base = create_knowledge_base(root.path(), "legacy", "").unwrap();
        let added = add_source(root.path(), &base.id, "a.md", "MAIN支持中文知识库检索");
        let conn = open_db(root.path(), &base.id).unwrap();
        conn.execute(
            "UPDATE knowledge_base SET embedding_profile='local_hash_v1+fts5'",
            [],
        )
        .unwrap();
        conn.execute("DELETE FROM chunks_fts", []).unwrap();
        conn.execute(
            "INSERT INTO chunks_fts(text,title,source_id,chunk_id) VALUES (?1,'',?2,?3)",
            params![
                "MAIN支持中文知识库检索",
                added.source.id,
                format!("{}:0", added.source.id)
            ],
        )
        .unwrap();
        drop(conn);
        fs::remove_file(&added.source.storage_path).unwrap(); // Index migration uses the durable chunks, not parser/model/file access.
        let refs = [base_ref(root.path(), &base.id)];
        assert_eq!(
            search(root.path(), "知识库", &refs, 8).unwrap().hits.len(),
            1
        );
        assert_eq!(
            get_knowledge_base(root.path(), &base.id)
                .unwrap()
                .embedding_profile,
            LEXICAL_PROFILE
        );
    }
    #[test]
    fn parse_failure_and_ocr_are_truthful_and_failed_import_can_retry() {
        let root = tempfile::tempdir().unwrap();
        let base = create_knowledge_base(root.path(), "states", "").unwrap();
        let dir = source_storage_dir(root.path(), &base.id);
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("a.pdf");
        fs::write(&path, "pdf bytes").unwrap();
        record_source_failure(root.path(), &base.id, &path, &path, "parser unavailable").unwrap();
        assert_eq!(
            get_knowledge_base(root.path(), &base.id)
                .unwrap()
                .index_status,
            "error"
        );
        assert_eq!(
            list_sources(root.path(), &base.id).unwrap()[0].status,
            "failed"
        );
        let retried = index_extracted_source(
            root.path(),
            &base.id,
            &path,
            &path,
            &serde_json::json!({"content":"可检索的资料"}),
            false,
        )
        .unwrap();
        assert!(!retried.deduped);
        assert_eq!(retried.source.status, "indexed");
        assert_eq!(retried.base.index_status, "ready");
        let path = dir.join("scan.pdf");
        fs::write(&path, "scan bytes").unwrap();
        let ocr=index_extracted_source(root.path(),&base.id,&path,&path,&serde_json::json!({"content":"","metadata":{"warning":"No text extracted; requires OCR"}}),false).unwrap();
        assert_eq!(ocr.source.status, "needs_ocr");
        assert_eq!(
            ocr.base.index_status, "ready",
            "an empty later import must not hide indexed earlier sources"
        );
    }

    #[test]
    fn chunks_split_large_text_with_overlap() {
        let text = "Unity Transform position rotation scale. ".repeat(300);
        let chunks = split_large_text(&text);
        assert!(chunks.len() > 1);
        assert!(chunks.iter().all(|chunk| !chunk.is_empty()));
    }

    #[test]
    fn chinese_lexical_query_indexes_substrings_without_embedding() {
        let root = tempfile::tempdir().unwrap();
        let base = create_knowledge_base(root.path(), "中文资料", "").unwrap();
        let path = root.path().join("source.md");
        fs::write(&path, "MAIN支持中文知识库检索。网络访问需要开启。").unwrap();
        index_extracted_source(root.path(), &base.id, &path, &path,
            &serde_json::json!({"title":"产品说明","content":"MAIN支持中文知识库检索。网络访问需要开启。"}), false).unwrap();
        let selected = list_knowledge_bases(root.path()).unwrap().remove(0);
        let result = search(
            root.path(),
            "知识库",
            &[KnowledgeReference::Base {
                kb_id: base.id,
                index_revision: selected.index_revision,
                activation_mode: None,
                preset_id: None,
            }],
            8,
        )
        .unwrap();
        assert_eq!(
            result.hits.len(),
            1,
            "CJK substring must match indexed lexical terms"
        );
        assert!(normalize_fts_query("知识库").contains("\"知识\""));
    }

    #[test]
    fn local_search_indexes_and_finds_chunks() {
        let root = std::env::temp_dir().join(format!("main-knowledge-test-{}", now_millis()));
        fs::create_dir_all(&root).unwrap();
        let base = create_knowledge_base(&root, "Unity Manual", "Unity API docs").unwrap();
        let source_path = root.join("source.md");
        fs::write(
            &source_path,
            "Transform controls position, rotation, and scale in Unity scenes.",
        )
        .unwrap();
        let extracted = serde_json::json!({
            "title": "Transform API",
            "documentType": "text",
            "content": "Transform controls position, rotation, and scale in Unity scenes.",
            "charCount": 64,
            "truncated": false,
            "metadata": {},
            "blocks": [{
                "kind": "section",
                "sourceLabel": "Section 1",
                "text": "Transform controls position, rotation, and scale in Unity scenes."
            }]
        });
        let imported = index_extracted_source(
            &root,
            &base.id,
            &source_path,
            &source_path,
            &extracted,
            false,
        )
        .unwrap();
        assert_eq!(imported.chunks, 1);
        let selected = list_knowledge_bases(&root).unwrap().remove(0);
        let result = search(
            &root,
            "Unity Transform position",
            &[KnowledgeReference::Base {
                kb_id: base.id.clone(),
                index_revision: selected.index_revision,
                activation_mode: None,
                preset_id: None,
            }],
            8,
        )
        .unwrap();
        assert_eq!(result.hits.len(), 1);
        assert_eq!(result.hits[0].citation.source_title, "Transform API");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn force_reindex_replaces_chunks_and_fts_rows() {
        let root =
            std::env::temp_dir().join(format!("main-knowledge-reindex-test-{}", now_millis()));
        fs::create_dir_all(&root).unwrap();
        let base = create_knowledge_base(&root, "Unity Manual", "Unity API docs").unwrap();
        let source_path = root.join("source.md");
        fs::write(&source_path, "Transform controls position.").unwrap();
        let first = serde_json::json!({
            "title": "Unity API",
            "documentType": "text",
            "content": "Transform controls position.",
            "charCount": 28,
            "truncated": false,
            "metadata": {},
            "blocks": [{ "kind": "section", "text": "Transform controls position." }]
        });
        index_extracted_source(&root, &base.id, &source_path, &source_path, &first, false).unwrap();

        fs::write(&source_path, "Rigidbody AddForce applies force.").unwrap();
        let second = serde_json::json!({
            "title": "Unity API",
            "documentType": "text",
            "content": "Rigidbody AddForce applies force.",
            "charCount": 32,
            "truncated": false,
            "metadata": {},
            "blocks": [{ "kind": "section", "text": "Rigidbody AddForce applies force." }]
        });
        index_extracted_source(&root, &base.id, &source_path, &source_path, &second, true).unwrap();

        let selected = list_knowledge_bases(&root).unwrap().remove(0);
        let references = [KnowledgeReference::Base {
            kb_id: base.id.clone(),
            index_revision: selected.index_revision,
            activation_mode: None,
            preset_id: None,
        }];
        let old_hits = search(&root, "Transform position", &references, 8).unwrap();
        assert_eq!(old_hits.hits.len(), 0);
        let new_hits = search(&root, "Rigidbody AddForce", &references, 8).unwrap();
        assert_eq!(new_hits.hits.len(), 1);
        assert!(new_hits.hits[0].text.contains("Rigidbody"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn official_hydration_appends_through_concurrent_revisions_and_keeps_exact_selections() {
        let root = tempfile::tempdir().unwrap();
        let preset = presets::find_engine_manual_preset("unity6").unwrap();
        let base = ensure_preset_knowledge_base(root.path(), &preset).unwrap();
        let inserted = replace_toc_snapshot(root.path(), &base, "builtin", &preset.builtin_toc_entries).unwrap();
        assert!(inserted > 0);
        assert_eq!(get_knowledge_base(root.path(), &base.id).unwrap().toc_entry_count, inserted);
        let exact = base_ref(root.path(), &base.id);
        let active = KnowledgeReference::Base {
            kb_id: base.id.clone(), index_revision: base.index_revision.clone(),
            activation_mode: Some("workspace_active".into()), preset_id: base.preset_id.clone(),
        };
        let matches = search_unhydrated_toc_entries(root.path(), &base.id, "Awaitable", 3).unwrap();
        let (entry_id, title, url) = &matches[0];
        let mut committed = 0;
        let barrier = std::sync::Barrier::new(3);
        std::thread::scope(|scope| {
            let barrier = &barrier;
            let root = root.path();
            let base = &base;
            let preset = &preset;
            let threads: Vec<_> = [
                (title.as_str(), url.as_str(), Some((entry_id.as_str(), url.as_str())),
                 "Awaitable.NextFrameAsync waits until the next frame in Unity 6."),
                (title.as_str(), url.as_str(), Some((entry_id.as_str(), url.as_str())),
                 "Awaitable.NextFrameAsync waits until the next frame in Unity 6."),
                ("Rigidbody", "https://docs.unity3d.com/6000.0/Documentation/ScriptReference/Rigidbody.html",
                 None, "Rigidbody.linearVelocity is documented here with its velocity semantics."),
            ].into_iter().map(|(title, url, toc_entry, content)| scope.spawn(move || {
                barrier.wait();
                append_preset_document(root, base, preset, PresetDocument {
                    title, content, source_url: url, builtin_summary: false, truncated: false,
                }, Some(HydrationScope { admitted_revision: &base.index_revision, toc_entry }), || false)
                .unwrap()
            })).collect();
            committed = threads.into_iter().map(|thread| thread.join().unwrap() as usize).sum();
        });
        assert_eq!(committed, 2);
        assert_eq!(list_sources(root.path(), &base.id).unwrap().len(), 2);
        assert!(search_unhydrated_toc_entries(root.path(), &base.id, "Awaitable", 3).unwrap()
            .iter().all(|(id, _, _)| id != entry_id));
        let refs = [active];
        let hit = search(root.path(), "NextFrameAsync", &refs, 4).unwrap().hits.remove(0);
        assert_ne!(hit.citation.index_revision, base.index_revision);
        assert_eq!(hit.citation.admitted_index_revision.as_ref(), Some(&base.index_revision));
        let excerpt = get_excerpt(root.path(), &hit.citation.source_id, &hit.citation.chunk_id, &refs)
            .unwrap().unwrap();
        assert_eq!(excerpt.citation.source_revision, hit.citation.source_revision);
        assert_eq!(excerpt.citation.index_revision, hit.citation.index_revision);
        assert!(search(root.path(), "Awaitable", &[exact], 4).unwrap_err().contains("STALE_KNOWLEDGE_REFERENCE"));
        let path = root.path().join("manual.txt");
        fs::write(&path, "Manual source change breaks the hydration revision chain.").unwrap();
        index_extracted_source(root.path(), &base.id, &path, &path, &serde_json::json!({
            "title": "Manual", "content": "Manual source change breaks the hydration revision chain."
        }), false).unwrap();
        assert!(search(root.path(), "Awaitable", &refs, 4).unwrap_err().contains("STALE_KNOWLEDGE_REFERENCE"));
    }

    #[test]
    fn legacy_automatic_sources_need_verified_content_before_they_can_return_citations() {
        let root = tempfile::tempdir().unwrap();
        let preset = presets::find_engine_manual_preset("unity6").unwrap();
        let base = ensure_preset_knowledge_base(root.path(), &preset).unwrap();
        let original = "LegacyWidget proves that automatic data requires verified content.";
        let file = root.path().join("legacy.txt");
        fs::write(&file, original).unwrap();
        let legacy = index_extracted_source(root.path(), &base.id, &file, &file, &serde_json::json!({
            "title": "Old title", "content": original,
            "metadata": { "autoHydrated": true, "sourceUrl": "https://unverified.example/" },
        }), false).unwrap();
        let active = [KnowledgeReference::Base {
            kb_id: base.id.clone(), index_revision: legacy.base.index_revision.clone(),
            activation_mode: Some("workspace_active".into()), preset_id: base.preset_id.clone(),
        }];
        assert!(search(root.path(), "LegacyWidget", &active, 4).unwrap().hits.is_empty());
        assert_eq!(list_sources(root.path(), &base.id).unwrap()[0].provenance.as_deref(), Some("unverified_legacy"));
        let url = "https://docs.unity3d.com/6000.0/Documentation/ScriptReference/LegacyWidget.html";
        assert!(append_preset_document(root.path(), &base, &preset, PresetDocument {
            title: "New title", content: original, source_url: url,
            builtin_summary: false, truncated: false,
        }, Some(HydrationScope { admitted_revision: &legacy.base.index_revision, toc_entry: None }), || false).unwrap());
        let hit = search(root.path(), "LegacyWidget", &active, 4).unwrap().hits.remove(0);
        assert_eq!(hit.citation.source_url.as_deref(), Some(url));
        assert_eq!(hit.citation.source_revision, legacy.source.source_revision);
        let sources = list_sources(root.path(), &base.id).unwrap();
        assert_eq!(sources.len(), 1);
        assert_eq!(sources[0].provenance.as_deref(), Some("official_document"));
    }

    #[test]
    fn preset_cancel_leaves_no_source_and_toc_refresh_preserves_other_snapshots() {
        let root = tempfile::tempdir().unwrap();
        let preset = presets::find_engine_manual_preset("unity6").unwrap();
        let base = ensure_preset_knowledge_base(root.path(), &preset).unwrap();
        let [first, second, ..] = preset.builtin_toc_entries.as_slice() else { panic!("fixture requires two seeds") };
        replace_toc_snapshot(root.path(), &base, "A", std::slice::from_ref(first)).unwrap();
        replace_toc_snapshot(root.path(), &base, "B", std::slice::from_ref(second)).unwrap();
        assert!(replace_toc_snapshot(root.path(), &base, "A", &[]).is_err());
        assert_eq!(get_knowledge_base(root.path(), &base.id).unwrap().toc_entry_count, 2);
        replace_toc_snapshot(root.path(), &base, "A", std::slice::from_ref(second)).unwrap();
        assert_eq!(get_knowledge_base(root.path(), &base.id).unwrap().toc_entry_count, 1);
        let calls = std::cell::Cell::new(0);
        let result = append_preset_document(root.path(), &base, &preset, PresetDocument {
            title: &first.title, source_url: &first.url, builtin_summary: false, truncated: false,
            content: "Awaitable.NextFrameAsync waits until the next frame in Unity 6.",
        }, Some(HydrationScope { admitted_revision: &base.index_revision, toc_entry: None }), || {
            calls.set(calls.get() + 1);
            calls.get() > 1
        });
        assert_eq!(result.unwrap_err(), "Aborted");
        assert!(list_sources(root.path(), &base.id).unwrap().is_empty());
        assert_eq!(get_knowledge_base(root.path(), &base.id).unwrap().index_revision, base.index_revision);
        assert_eq!(fs::read_dir(source_storage_dir(root.path(), &base.id)).unwrap().count(), 0);
        let append = || append_preset_document(root.path(), &base, &preset, PresetDocument {
            title: &first.title, source_url: &first.url, builtin_summary: false, truncated: false,
            content: "Awaitable.NextFrameAsync waits until the next frame in Unity 6.",
        }, Some(HydrationScope { admitted_revision: &base.index_revision, toc_entry: None }), || false);
        set_knowledge_base_enabled(root.path(), &base.id, false).unwrap();
        assert!(append().unwrap_err().contains("STALE_KNOWLEDGE_REFERENCE"));
        delete_knowledge_base(root.path(), &base.id).unwrap();
        assert!(append().is_err());
        assert!(!kb_dir(root.path(), &base.id).exists());
    }

    #[test]
    fn orphan_empty_sqlite_does_not_brick_list_or_preset_bootstrap_and_deleted_kb_is_not_recreated() {
        let root = tempfile::tempdir().unwrap();
        // Simulate an orphan sqlite db with 0 rows in knowledge_base
        let _orphan_conn = open_or_create_db(root.path(), "kb_orphan123").unwrap();
        drop(_orphan_conn);
        assert!(db_path(root.path(), "kb_orphan123").is_file());

        // list_knowledge_bases should self-heal/clean up the empty orphan and succeed
        let listed = list_knowledge_bases(root.path()).unwrap();
        assert!(listed.is_empty());
        assert!(!kb_dir(root.path(), "kb_orphan123").exists());

        // ensure_preset_knowledge_base should succeed
        let preset = presets::find_engine_manual_preset("tuanjie").unwrap();
        let base = ensure_preset_knowledge_base(root.path(), &preset).unwrap();
        assert_eq!(base.preset_id.as_deref(), Some("tuanjie"));

        // Deleting a KB and then calling list_sources on it must fail cleanly without recreating index.sqlite
        delete_knowledge_base(root.path(), &base.id).unwrap();
        assert!(list_sources(root.path(), &base.id).is_err());
        assert!(!db_path(root.path(), &base.id).exists());
    }
}
