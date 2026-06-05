use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const EMBEDDING_DIMS: usize = 32;
const CHUNK_TARGET_CHARS: usize = 2_800;
const CHUNK_OVERLAP_CHARS: usize = 400;

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
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
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
    pub score: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeSearchHit {
    pub text: String,
    pub excerpt: String,
    pub citation: KnowledgeCitation,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeSearchResult {
    pub query: String,
    pub searched_knowledge_base_ids: Vec<String>,
    pub hits: Vec<KnowledgeSearchHit>,
    pub note: String,
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
    bm25_score: f32,
    vector_score: f32,
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

fn open_db(app_data_dir: &Path, kb_id: &str) -> Result<Connection, String> {
    let dir = kb_dir(app_data_dir, kb_id);
    fs::create_dir_all(&dir)
        .map_err(|error| format!("创建知识库目录失败 {}: {error}", dir.display()))?;
    let conn = Connection::open(db_path(app_data_dir, kb_id))
        .map_err(|error| format!("打开知识库索引失败: {error}"))?;
    init_db(&conn)?;
    Ok(conn)
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
          updated_at_ms INTEGER NOT NULL
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
        "#,
    )
    .map_err(|error| format!("初始化知识库索引失败: {error}"))?;
    Ok(())
}

fn base_from_row(conn: &Connection) -> Result<KnowledgeBase, String> {
    conn.query_row(
        "SELECT id, name, description, enabled, index_status, embedding_profile, created_at_ms, updated_at_ms FROM knowledge_base LIMIT 1",
        [],
        |row| {
            let id: String = row.get(0)?;
            let source_count = conn
                .query_row("SELECT COUNT(*) FROM sources", [], |count_row| count_row.get::<_, i64>(0))
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
                created_at_ms: row.get::<_, i64>(6)?.max(0) as u64,
                updated_at_ms: row.get::<_, i64>(7)?.max(0) as u64,
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
    })
}

pub fn create_knowledge_base(
    app_data_dir: &Path,
    name: &str,
    description: &str,
) -> Result<KnowledgeBase, String> {
    let root = knowledge_root(app_data_dir);
    fs::create_dir_all(&root)
        .map_err(|error| format!("创建知识库根目录失败 {}: {error}", root.display()))?;
    let id = make_id("kb", name);
    let conn = open_db(app_data_dir, &id)?;
    let now = now_millis() as i64;
    conn.execute(
        "INSERT INTO knowledge_base (id, name, description, enabled, index_status, embedding_profile, created_at_ms, updated_at_ms) VALUES (?1, ?2, ?3, 1, 'empty', 'local_hash_v1+fts5', ?4, ?4)",
        params![&id, name.trim(), description.trim(), now],
    )
    .map_err(|error| format!("创建知识库失败: {error}"))?;
    base_from_row(&conn)
}

pub fn list_knowledge_bases(app_data_dir: &Path) -> Result<Vec<KnowledgeBase>, String> {
    let root = knowledge_root(app_data_dir);
    if !root.exists() {
        return Ok(Vec::new());
    }
    let mut bases = Vec::new();
    let entries = fs::read_dir(&root)
        .map_err(|error| format!("读取知识库目录失败 {}: {error}", root.display()))?;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() || !path.join("index.sqlite").exists() {
            continue;
        }
        let Some(kb_id) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        if let Ok(conn) = open_db(app_data_dir, kb_id) {
            if let Ok(base) = base_from_row(&conn) {
                bases.push(base);
            }
        }
    }
    bases.sort_by(|a, b| {
        b.updated_at_ms
            .cmp(&a.updated_at_ms)
            .then(a.name.cmp(&b.name))
    });
    Ok(bases)
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
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("读取知识库来源失败: {error}"))
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
    if kb_id.trim().is_empty() || kb_id.contains('/') || kb_id.contains('\\') {
        return Err("知识库 ID 无效".to_string());
    }
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

fn local_embedding(content: &str) -> Vec<f32> {
    let mut vector = vec![0.0_f32; EMBEDDING_DIMS];
    let mut token_count = 0.0_f32;
    for token in content
        .split(|ch: char| !ch.is_alphanumeric() && ch != '_')
        .filter(|token| token.chars().count() > 1)
    {
        token_count += 1.0;
        let digest = Sha256::digest(token.to_ascii_lowercase().as_bytes());
        let dim = digest[0] as usize % EMBEDDING_DIMS;
        let sign = if digest[1] & 1 == 0 { 1.0 } else { -1.0 };
        vector[dim] += sign;
    }
    if token_count > 0.0 {
        let norm = vector.iter().map(|value| value * value).sum::<f32>().sqrt();
        if norm > 0.0 {
            for value in &mut vector {
                *value = (*value / norm * 10_000.0).round() / 10_000.0;
            }
        }
    }
    vector
}

fn cosine_similarity(a: &[f32], b: &[f32]) -> f32 {
    if a.len() != b.len() || a.is_empty() {
        return 0.0;
    }
    let dot = a
        .iter()
        .zip(b.iter())
        .map(|(left, right)| left * right)
        .sum::<f32>();
    let norm_a = a.iter().map(|value| value * value).sum::<f32>().sqrt();
    let norm_b = b.iter().map(|value| value * value).sum::<f32>().sqrt();
    if norm_a <= 0.0 || norm_b <= 0.0 {
        0.0
    } else {
        dot / (norm_a * norm_b)
    }
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
    .map_err(|error| format!("检查知识库重复来源失败: {error}"))
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
    .map_err(|error| format!("检查知识库来源路径失败: {error}"))
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
    let conn = open_db(app_data_dir, kb_id)?;
    let base = base_from_row(&conn)?;
    let hash = file_hash(storage_path)?;
    if !force {
        if let Some(source) = get_existing_source_by_hash(&conn, kb_id, &hash)? {
            return Ok(KnowledgeImportResult {
                base,
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
        get_existing_source_by_storage_path(&conn, kb_id, storage_path)?
            .or(get_existing_source_by_hash(&conn, kb_id, &hash)?)
            .map(|source| source.id)
            .unwrap_or_else(|| make_id("src", &hash))
    } else {
        make_id("src", &hash)
    };

    let tx = conn
        .unchecked_transaction()
        .map_err(|error| format!("打开知识库索引事务失败: {error}"))?;
    if force {
        delete_source_chunks(&tx, &source_id)?;
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
        let vector = local_embedding(&chunk.text);
        let embedding = serde_json::to_string(&vector)
            .map_err(|error| format!("序列化知识库向量失败: {error}"))?;
        tx.execute(
            "INSERT INTO chunks (id, source_id, kb_id, chunk_index, text, hash, page, block, heading, token_count, embedding_status, embedding) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'local_hash_v1', ?11)",
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
            params![&chunk.text, &title, &source_id, &chunk_id],
        )
        .map_err(|error| format!("写入知识库全文索引失败: {error}"))?;
    }

    let next_status = if chunks.is_empty() { "empty" } else { "ready" };
    tx.execute(
        "UPDATE knowledge_base SET index_status = ?1, updated_at_ms = ?2 WHERE id = ?3",
        params![next_status, now as i64, kb_id],
    )
    .map_err(|error| format!("更新知识库状态失败: {error}"))?;
    tx.commit()
        .map_err(|error| format!("提交知识库索引失败: {error}"))?;

    let conn = open_db(app_data_dir, kb_id)?;
    let base = base_from_row(&conn)?;
    let source = get_existing_source_by_hash(&conn, kb_id, &file_hash(storage_path)?)?
        .ok_or_else(|| "知识库来源写入后未找到".to_string())?;
    Ok(KnowledgeImportResult {
        base,
        source,
        chunks: chunks.len(),
        deduped: false,
    })
}

fn normalize_fts_query(query: &str) -> String {
    let mut terms = Vec::new();
    let mut current = String::new();
    for ch in query.chars() {
        if ch.is_alphanumeric() || ch == '_' {
            current.push(ch);
        } else {
            if current.chars().count() >= 2 {
                terms.push(current.clone());
            }
            current.clear();
            if ('\u{4e00}'..='\u{9fff}').contains(&ch) {
                terms.push(ch.to_string());
            }
        }
    }
    if current.chars().count() >= 2 {
        terms.push(current);
    }
    terms.sort();
    terms.dedup();
    terms
        .into_iter()
        .take(12)
        .map(|term| format!("\"{}\"", term.replace('"', "\"\"")))
        .collect::<Vec<_>>()
        .join(" OR ")
}

fn load_enabled_or_selected_base_ids(
    app_data_dir: &Path,
    selected: &[String],
) -> Result<Vec<KnowledgeBase>, String> {
    let selected_set: HashSet<String> = selected.iter().cloned().collect();
    Ok(list_knowledge_bases(app_data_dir)?
        .into_iter()
        .filter(|base| {
            if selected_set.is_empty() {
                base.enabled
            } else {
                selected_set.contains(&base.id)
            }
        })
        .collect())
}

fn collect_bm25_hits(
    app_data_dir: &Path,
    base: &KnowledgeBase,
    fts_query: &str,
    limit: usize,
) -> Result<Vec<CandidateHit>, String> {
    if fts_query.trim().is_empty() {
        return Ok(Vec::new());
    }
    let conn = open_db(app_data_dir, &base.id)?;
    let mut stmt = conn
        .prepare(
            r#"
            SELECT c.id, c.source_id, s.title, c.text, c.page, c.block, bm25(chunks_fts) AS rank
            FROM chunks_fts
            JOIN chunks c ON c.id = chunks_fts.chunk_id
            JOIN sources s ON s.id = c.source_id
            WHERE chunks_fts MATCH ?1
            ORDER BY rank
            LIMIT ?2
            "#,
        )
        .map_err(|error| format!("准备知识库全文检索失败: {error}"))?;
    let rows = stmt
        .query_map(params![fts_query, limit as i64], |row| {
            let rank: f64 = row.get(6)?;
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
                bm25_score: (1.0 / (1.0 + rank.abs() as f32)).clamp(0.0, 1.0),
                vector_score: 0.0,
            })
        })
        .map_err(|error| format!("执行知识库全文检索失败: {error}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("读取知识库全文检索结果失败: {error}"))
}

fn collect_vector_hits(
    app_data_dir: &Path,
    base: &KnowledgeBase,
    query_vector: &[f32],
    limit: usize,
) -> Result<Vec<CandidateHit>, String> {
    let conn = open_db(app_data_dir, &base.id)?;
    let mut stmt = conn
        .prepare(
            r#"
            SELECT c.id, c.source_id, s.title, c.text, c.page, c.block, c.embedding
            FROM chunks c
            JOIN sources s ON s.id = c.source_id
            ORDER BY c.source_id, c.chunk_index
            "#,
        )
        .map_err(|error| format!("准备知识库向量检索失败: {error}"))?;
    let rows = stmt
        .query_map([], |row| {
            let embedding_text: String = row.get(6)?;
            let vector: Vec<f32> = serde_json::from_str(&embedding_text).unwrap_or_default();
            Ok((
                CandidateHit {
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
                    bm25_score: 0.0,
                    vector_score: cosine_similarity(query_vector, &vector).max(0.0),
                },
                vector,
            ))
        })
        .map_err(|error| format!("执行知识库向量检索失败: {error}"))?;
    let mut hits = rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("读取知识库向量检索结果失败: {error}"))?
        .into_iter()
        .map(|(hit, _)| hit)
        .filter(|hit| hit.vector_score > 0.05)
        .collect::<Vec<_>>();
    hits.sort_by(|a, b| {
        b.vector_score
            .partial_cmp(&a.vector_score)
            .unwrap_or(Ordering::Equal)
    });
    hits.truncate(limit);
    Ok(hits)
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

pub fn search(
    app_data_dir: &Path,
    query: &str,
    kb_ids: &[String],
    limit: usize,
) -> Result<KnowledgeSearchResult, String> {
    let query = query.trim();
    if query.is_empty() {
        return Err("knowledge_search 缺少 query".to_string());
    }
    let bases = load_enabled_or_selected_base_ids(app_data_dir, kb_ids)?;
    let fts_query = normalize_fts_query(query);
    let query_vector = local_embedding(query);
    let mut merged: HashMap<String, CandidateHit> = HashMap::new();

    for base in &bases {
        for hit in collect_bm25_hits(app_data_dir, base, &fts_query, 60)? {
            merged
                .entry(hit.chunk_id.clone())
                .and_modify(|existing| {
                    existing.bm25_score = existing.bm25_score.max(hit.bm25_score)
                })
                .or_insert(hit);
        }
        for hit in collect_vector_hits(app_data_dir, base, &query_vector, 60)? {
            merged
                .entry(hit.chunk_id.clone())
                .and_modify(|existing| {
                    existing.vector_score = existing.vector_score.max(hit.vector_score)
                })
                .or_insert(hit);
        }
    }

    let mut hits = merged.into_values().collect::<Vec<_>>();
    hits.sort_by(|a, b| {
        let score_a = a.bm25_score * 0.62 + a.vector_score * 0.38;
        let score_b = b.bm25_score * 0.62 + b.vector_score * 0.38;
        score_b.partial_cmp(&score_a).unwrap_or(Ordering::Equal)
    });
    hits.truncate(limit.clamp(1, 16));

    Ok(KnowledgeSearchResult {
        query: query.to_string(),
        searched_knowledge_base_ids: bases.iter().map(|base| base.id.clone()).collect(),
        hits: hits
            .into_iter()
            .map(|hit| {
                let score = (hit.bm25_score * 0.62 + hit.vector_score * 0.38).clamp(0.0, 1.0);
                KnowledgeSearchHit {
                    excerpt: excerpt(&hit.text, 700),
                    text: excerpt(&hit.text, 1_600),
                    citation: KnowledgeCitation {
                        kb_id: hit.kb_id,
                        kb_name: hit.kb_name,
                        source_id: hit.source_id,
                        source_title: hit.source_title,
                        chunk_id: hit.chunk_id,
                        page: hit.page,
                        block: hit.block,
                        score,
                    },
                }
            })
            .collect(),
        note: "Use these retrieved snippets as the only knowledge-base evidence. If hits is empty, say the enabled knowledge bases did not contain supporting evidence.".to_string(),
    })
}

pub fn get_excerpt(
    app_data_dir: &Path,
    source_id: &str,
    chunk_id: &str,
) -> Result<Option<KnowledgeSearchHit>, String> {
    for base in list_knowledge_bases(app_data_dir)? {
        let conn = open_db(app_data_dir, &base.id)?;
        let hit = conn
            .query_row(
                r#"
                SELECT c.id, c.source_id, s.title, c.text, c.page, c.block
                FROM chunks c
                JOIN sources s ON s.id = c.source_id
                WHERE c.source_id = ?1 AND c.id = ?2
                LIMIT 1
                "#,
                params![source_id, chunk_id],
                |row| {
                    let text: String = row.get(3)?;
                    Ok(KnowledgeSearchHit {
                        excerpt: excerpt(&text, 700),
                        text,
                        citation: KnowledgeCitation {
                            kb_id: base.id.clone(),
                            kb_name: base.name.clone(),
                            chunk_id: row.get(0)?,
                            source_id: row.get(1)?,
                            source_title: row.get(2)?,
                            page: row
                                .get::<_, Option<i64>>(4)?
                                .map(|value| value.max(0) as usize),
                            block: row.get(5)?,
                            score: 1.0,
                        },
                    })
                },
            )
            .optional()
            .map_err(|error| format!("读取知识库摘录失败: {error}"))?;
        if hit.is_some() {
            return Ok(hit);
        }
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chunks_split_large_text_with_overlap() {
        let text = "Unity Transform position rotation scale. ".repeat(300);
        let chunks = split_large_text(&text);
        assert!(chunks.len() > 1);
        assert!(chunks.iter().all(|chunk| !chunk.is_empty()));
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
        let result = search(&root, "Unity Transform position", &[], 8).unwrap();
        assert_eq!(result.hits.len(), 1);
        assert_eq!(result.hits[0].citation.source_title, "Transform API");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn force_reindex_replaces_chunks_and_fts_rows() {
        let root = std::env::temp_dir().join(format!("main-knowledge-reindex-test-{}", now_millis()));
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

        let old_hits = search(&root, "Transform position", &[], 8).unwrap();
        assert_eq!(old_hits.hits.len(), 0);
        let new_hits = search(&root, "Rigidbody AddForce", &[], 8).unwrap();
        assert_eq!(new_hits.hits.len(), 1);
        assert!(new_hits.hits[0].text.contains("Rigidbody"));
        let _ = fs::remove_dir_all(root);
    }
}
