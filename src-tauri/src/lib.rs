use glob::glob;
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::cmp::Ordering;
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::process::{Child as ProcessChild, ChildStdin, Command as ProcessCommand, Stdio};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, State};
use tiktoken_rs::{cl100k_base, CoreBPE};
use walkdir::WalkDir;

// region: 全局常量与状态

const PTY_BUFFER_LIMIT_BYTES: usize = 512 * 1024;
const GREP_MATCH_LIMIT: usize = 2000;
const GREP_OUTPUT_LIMIT_BYTES: usize = 512 * 1024;
const COMMAND_OUTPUT_LIMIT_BYTES: usize = 1024 * 1024;
const DOCUMENT_READER_SCRIPT: &str = include_str!("../Scripts/document_reader.py");
const HTTP_CONNECT_TIMEOUT_SECS: u64 = 15;
const HTTP_SHORT_TIMEOUT_SECS: u64 = 15;
const MODEL_REQUEST_TIMEOUT_SECS: u64 = 30 * 60;
const STREAM_READ_TIMEOUT_SECS: u64 = 15 * 60;
const STREAM_FIRST_RESPONSE_TIMEOUT_SECS: u64 = 180;
const STREAM_FIRST_CHUNK_TIMEOUT_SECS: u64 = 180;
const READ_FILE_WINDOW_DEFAULT_MAX_LINES: usize = 180;
const READ_FILE_WINDOW_MAX_LINES: usize = 600;
const READ_FILE_WINDOW_DEFAULT_MAX_CHARS: usize = 6_800;
const READ_FILE_WINDOW_MAX_CHARS: usize = 24_000;

static TOKENIZER: OnceLock<CoreBPE> = OnceLock::new();

// region: 调试日志

const DEBUG_LOG_FILE_NAME: &str = "main-debug.log";
const DEBUG_LOG_MAX_BYTES: u64 = 4 * 1024 * 1024;
const DEBUG_LOG_TRIM_KEEP_BYTES: usize = 3 * 1024 * 1024;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DebugLogPayload {
    timestamp: String,
    level: String,
    source: String,
    message: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DebugLogSnapshot {
    path: String,
    content: String,
    truncated: bool,
}

fn debug_timestamp() -> String {
    let elapsed = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_else(|_| Duration::from_secs(0));
    format!("{}.{:03}", elapsed.as_secs(), elapsed.subsec_millis())
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_else(|_| Duration::from_secs(0))
        .as_millis() as u64
}

fn sanitize_log_part(value: &str) -> String {
    let mut result = value
        .replace('\r', "\\r")
        .replace('\n', "\\n")
        .replace('\t', "\\t");
    if result.len() > 8_000 {
        result.truncate(8_000);
        result.push_str("...<truncated>");
    }
    result
}

fn debug_log_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_log_dir()
        .map_err(|e| format!("解析调试日志目录失败: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("创建调试日志目录失败: {e}"))?;
    Ok(dir.join(DEBUG_LOG_FILE_NAME))
}

fn trim_debug_log_file(path: &Path) {
    let Ok(metadata) = fs::metadata(path) else {
        return;
    };
    if metadata.len() <= DEBUG_LOG_MAX_BYTES {
        return;
    }
    let Ok(bytes) = fs::read(path) else {
        return;
    };
    if bytes.len() <= DEBUG_LOG_TRIM_KEEP_BYTES {
        return;
    }
    let raw_start = bytes.len().saturating_sub(DEBUG_LOG_TRIM_KEEP_BYTES);
    let start = bytes[raw_start..]
        .iter()
        .position(|b| *b == b'\n')
        .map(|offset| raw_start + offset + 1)
        .unwrap_or(raw_start);
    let _ = fs::write(path, &bytes[start..]);
}

fn append_debug_log_line(app: &AppHandle, payload: &DebugLogPayload) -> Result<(), String> {
    let path = debug_log_path(app)?;
    let line = format!(
        "[{}] [{}] [{}] {}\n",
        sanitize_log_part(&payload.timestamp),
        sanitize_log_part(&payload.level),
        sanitize_log_part(&payload.source),
        sanitize_log_part(&payload.message),
    );
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("打开调试日志失败: {e}"))?;
    file.write_all(line.as_bytes())
        .map_err(|e| format!("写入调试日志失败: {e}"))?;
    trim_debug_log_file(&path);
    Ok(())
}

fn record_debug_log(app: &AppHandle, level: &str, source: &str, message: impl AsRef<str>) {
    let payload = DebugLogPayload {
        timestamp: debug_timestamp(),
        level: level.to_string(),
        source: source.to_string(),
        message: message.as_ref().to_string(),
    };
    println!("[{}] {}", payload.source, payload.message);
    let _ = append_debug_log_line(app, &payload);
    let _ = app.emit("main-debug-log", payload);
}

#[tauri::command]
fn append_debug_log(app: AppHandle, level: String, source: String, message: String) -> Result<(), String> {
    let payload = DebugLogPayload {
        timestamp: debug_timestamp(),
        level,
        source,
        message,
    };
    append_debug_log_line(&app, &payload)
}

#[tauri::command]
fn read_debug_log(app: AppHandle, max_bytes: Option<usize>) -> Result<DebugLogSnapshot, String> {
    let path = debug_log_path(&app)?;
    if !path.exists() {
        return Ok(DebugLogSnapshot {
            path: path.to_string_lossy().to_string(),
            content: String::new(),
            truncated: false,
        });
    }

    let bytes = fs::read(&path).map_err(|e| format!("读取调试日志失败: {e}"))?;
    let max = max_bytes.unwrap_or(256 * 1024).clamp(1_024, 1024 * 1024);
    let truncated = bytes.len() > max;
    let slice = if truncated {
        &bytes[bytes.len() - max..]
    } else {
        &bytes[..]
    };
    Ok(DebugLogSnapshot {
        path: path.to_string_lossy().to_string(),
        content: String::from_utf8_lossy(slice).to_string(),
        truncated,
    })
}

#[tauri::command]
fn clear_debug_log(app: AppHandle) -> Result<(), String> {
    let path = debug_log_path(&app)?;
    fs::write(path, "").map_err(|e| format!("清空调试日志失败: {e}"))
}

// endregion

#[derive(Default)]
struct PtyManager {
    sessions: Mutex<HashMap<String, PtySession>>,
}

struct FeishuAdapterManager {
    process: Mutex<Option<FeishuAdapterProcess>>,
    status: Arc<Mutex<FeishuAdapterStatus>>,
}

struct WorkspaceState {
    root: Mutex<PathBuf>,
}

struct FeishuAdapterProcess {
    child: ProcessChild,
    writer: Arc<Mutex<ChildStdin>>,
}

struct PtySession {
    master: Box<dyn portable_pty::MasterPty + Send>,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    buffer: Arc<Mutex<PtyBuffer>>,
    child: Box<dyn portable_pty::Child + Send>,
}

#[derive(Default)]
struct PtyBuffer {
    bytes: Vec<u8>,
    start_offset: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PtyReadResult {
    text: String,
    start_offset: u64,
    end_offset: u64,
    truncated: bool,
    buffer_start_offset: u64,
    buffer_end_offset: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PtyStatus {
    active: bool,
    running: bool,
    pid: Option<u32>,
    exit_code: Option<i32>,
    buffer_start_offset: u64,
    buffer_end_offset: u64,
    buffer_bytes: usize,
    tail: String,
}

struct CapturedPipe {
    text: String,
    truncated: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalCommandOutput {
    command: String,
    stdout: String,
    stderr: String,
    exit_code: i32,
    timed_out: bool,
    duration_ms: u128,
    success: bool,
    stdout_truncated: bool,
    stderr_truncated: bool,
}

struct GitProcessOutput {
    stdout: String,
    stderr: String,
    exit_code: i32,
    timed_out: bool,
    success: bool,
}

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct GitStatus {
    is_repo: bool,
    git_available: bool,
    repo_root: Option<String>,
    branch: Option<String>,
    upstream: Option<String>,
    ahead: usize,
    behind: usize,
    changed_files: usize,
    insertions: usize,
    deletions: usize,
    untracked_files: usize,
    staged_files: usize,
    unstaged_files: usize,
    conflicted_files: usize,
    clean: bool,
    has_origin: bool,
    error: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct GitFileEntry {
    path: String,
    status: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct GitDiffEntry {
    path: String,
    status: String,
    old: String,
    new: String,
    existed: bool,
    full_file: bool,
    binary: bool,
}

struct GitPorcelainEntry {
    path: String,
    original_path: Option<String>,
    status: String,
}

#[derive(Default)]
struct GitBranchInfo {
    branch: Option<String>,
    upstream: Option<String>,
    ahead: usize,
    behind: usize,
}

#[derive(Default)]
struct GitWorktreeCounts {
    changed_files: usize,
    untracked_files: usize,
    staged_files: usize,
    unstaged_files: usize,
    conflicted_files: usize,
}

#[derive(Default)]
struct GitNumstatCounts {
    insertions: usize,
    deletions: usize,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FeishuAdapterStatus {
    status: String,
    running: bool,
    message: String,
    updated_at: u64,
    pid: Option<u32>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FeishuAdapterConfigPayload {
    app_id: String,
    app_secret: String,
    domain: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct NodeRuntimeStatus {
    found: bool,
    executable: Option<String>,
    version: Option<String>,
    message: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PtyDataPayload {
    session_key: String,
    chunk: String,
}

impl Default for FeishuAdapterManager {
    fn default() -> Self {
        Self {
            process: Mutex::new(None),
            status: Arc::new(Mutex::new(FeishuAdapterStatus::default())),
        }
    }
}

impl Default for FeishuAdapterStatus {
    fn default() -> Self {
        Self {
            status: "idle".to_string(),
            running: false,
            message: "Feishu adapter is idle.".to_string(),
            updated_at: now_millis(),
            pid: None,
        }
    }
}

impl FeishuAdapterProcess {
    fn shutdown(&mut self) {
        if let Ok(mut writer) = self.writer.lock() {
            let _ = writeln!(writer, "{}", json!({ "type": "stop" }));
            let _ = writer.flush();
        }
        thread::sleep(Duration::from_millis(120));
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl PtySession {
    fn shutdown(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl PtyBuffer {
    fn end_offset(&self) -> u64 {
        self.start_offset + self.bytes.len() as u64
    }

    fn append(&mut self, data: &[u8]) {
        self.bytes.extend_from_slice(data);
        if self.bytes.len() > PTY_BUFFER_LIMIT_BYTES {
            let overflow = self.bytes.len() - PTY_BUFFER_LIMIT_BYTES;
            self.bytes.drain(..overflow);
            self.start_offset += overflow as u64;
        }
    }

    fn clear(&mut self) {
        self.start_offset = self.end_offset();
        self.bytes.clear();
    }

    fn read_all(&self, max_chars: Option<usize>) -> PtyReadResult {
        self.read_since(self.start_offset, max_chars)
    }

    fn read_tail(&self, max_chars: Option<usize>) -> PtyReadResult {
        let end_offset = self.end_offset();
        let text = decode_utf8_lossy_for_display(&self.bytes);
        let max = max_chars.unwrap_or(8_000).clamp(1, 200_000);
        let (tail, truncated_by_chars) = take_tail_chars(&text, max);
        let start_offset = if truncated_by_chars {
            end_offset.saturating_sub(tail.as_bytes().len() as u64)
        } else {
            self.start_offset
        };

        PtyReadResult {
            text: tail,
            start_offset,
            end_offset,
            truncated: truncated_by_chars,
            buffer_start_offset: self.start_offset,
            buffer_end_offset: end_offset,
        }
    }

    fn read_since(&self, requested_offset: u64, max_chars: Option<usize>) -> PtyReadResult {
        let buffer_end = self.end_offset();
        let mut truncated = false;
        let start_offset = if requested_offset < self.start_offset {
            truncated = true;
            self.start_offset
        } else {
            requested_offset.min(buffer_end)
        };
        let start_idx = (start_offset - self.start_offset) as usize;
        let text = decode_utf8_lossy_for_display(&self.bytes[start_idx..]);

        let (text, truncated_by_chars) = match max_chars {
            Some(max) => take_tail_chars(&text, max.clamp(1, 200_000)),
            None => (text, false),
        };
        let effective_start = if truncated_by_chars {
            buffer_end.saturating_sub(text.as_bytes().len() as u64)
        } else {
            start_offset
        };

        PtyReadResult {
            text,
            start_offset: effective_start,
            end_offset: buffer_end,
            truncated: truncated || truncated_by_chars,
            buffer_start_offset: self.start_offset,
            buffer_end_offset: buffer_end,
        }
    }
}

impl WorkspaceState {
    fn new(root: PathBuf) -> Self {
        Self {
            root: Mutex::new(root),
        }
    }

    fn get_root(&self) -> Result<PathBuf, String> {
        let guard = self
            .root
            .lock()
            .map_err(|_| "无法读取工作区路径：状态锁已损坏".to_string())?;
        Ok(guard.clone())
    }

    fn set_root(&self, root: PathBuf) -> Result<(), String> {
        let mut guard = self
            .root
            .lock()
            .map_err(|_| "无法写入工作区路径：状态锁已损坏".to_string())?;
        *guard = root;
        Ok(())
    }
}

// endregion

// region: 路径安全辅助

fn default_workspace_root() -> Result<PathBuf, String> {
    let configured = std::env::var("LOCAL_AGENT_WORKSPACE").ok();
    let base = match configured {
        Some(root) => PathBuf::from(root),
        None => std::env::current_dir().map_err(|e| format!("无法获取当前目录: {e}"))?,
    };
    base.canonicalize()
        .map_err(|e| format!("无法解析工作区路径: {e}"))
}

fn canonicalize_workspace_dir(path: &str) -> Result<PathBuf, String> {
    let raw = PathBuf::from(path);
    if !raw.exists() {
        return Err("工作区路径不存在".to_string());
    }
    if !raw.is_dir() {
        return Err("工作区路径必须是目录".to_string());
    }
    raw.canonicalize()
        .map_err(|e| format!("无法解析工作区路径: {e}"))
}

fn resolve_workspace_root(state: &WorkspaceState, workspace: Option<String>) -> Result<PathBuf, String> {
    match workspace {
        Some(path) if !path.trim().is_empty() => canonicalize_workspace_dir(path.trim()),
        _ => state.get_root(),
    }
}

fn normalize_pty_session_key(session_key: Option<String>) -> String {
    let raw = session_key
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("__MAIN_DEFAULT_PTY__");
    sanitize_session_key(raw)
}

fn sanitize_session_key(session_key: &str) -> String {
    let sanitized = session_key
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' || ch == '.' {
                ch
            } else {
                '_'
            }
        })
        .collect::<String>();
    let trimmed = sanitized.trim_matches('_');
    if trimmed.is_empty() {
        "session".to_string()
    } else {
        trimmed.to_string()
    }
}

fn ensure_chat_temp_root(session_key: &str) -> Result<PathBuf, String> {
    let safe_key = sanitize_session_key(session_key);
    let root = std::env::temp_dir()
        .join("MAIN")
        .join(".tmp")
        .join("chat-sessions")
        .join(safe_key);
    fs::create_dir_all(&root).map_err(|e| format!("创建聊天临时目录失败: {e}"))?;
    root.canonicalize()
        .map_err(|e| format!("无法解析聊天临时目录: {e}"))
}

const CHAT_ATTACHMENT_PREFIX: &str = ".MAIN-chat-attachments";

const SUPPORTED_ATTACHMENT_EXTENSIONS: &[&str] = &[
    "txt", "md", "markdown",
    "js", "ts", "tsx", "jsx",
    "py", "cs", "java", "c", "cpp", "h", "hpp",
    "json", "yaml", "yml", "toml", "xml", "html", "css", "scss", "less",
    "sh", "bash", "zsh", "fish", "rs", "go", "rb", "php", "swift", "kt", "dart", "lua",
    "sql", "graphql", "env", "gitignore", "ignore",
    "pdf", "docx", "xlsx", "xls", "csv", "tsv",
];

const SUPPORTED_IMAGE_ATTACHMENT_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg"];

fn attachment_extension(path: &Path) -> String {
    path.extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
}

fn is_supported_attachment_path(path: &Path) -> bool {
    let ext = attachment_extension(path);
    SUPPORTED_ATTACHMENT_EXTENSIONS.contains(&ext.as_str())
}

fn is_supported_image_attachment_path(path: &Path) -> bool {
    let ext = attachment_extension(path);
    SUPPORTED_IMAGE_ATTACHMENT_EXTENSIONS.contains(&ext.as_str())
}

fn image_attachment_mime(path: &Path) -> &'static str {
    match attachment_extension(path).as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        _ => "application/octet-stream",
    }
}

fn sanitize_attachment_filename(name: &str) -> String {
    let sanitized = name
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '.' || ch == '-' || ch == '_' {
                ch
            } else {
                '_'
            }
        })
        .collect::<String>();
    let trimmed = sanitized.trim_matches('_');
    if trimmed.is_empty() {
        "attachment".to_string()
    } else {
        trimmed.chars().take(120).collect()
    }
}

fn encode_base64(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut output = String::with_capacity(((bytes.len() + 2) / 3) * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0];
        let b1 = *chunk.get(1).unwrap_or(&0);
        let b2 = *chunk.get(2).unwrap_or(&0);
        output.push(TABLE[(b0 >> 2) as usize] as char);
        output.push(TABLE[(((b0 & 0b0000_0011) << 4) | (b1 >> 4)) as usize] as char);
        if chunk.len() > 1 {
            output.push(TABLE[(((b1 & 0b0000_1111) << 2) | (b2 >> 6)) as usize] as char);
        } else {
            output.push('=');
        }
        if chunk.len() > 2 {
            output.push(TABLE[(b2 & 0b0011_1111) as usize] as char);
        } else {
            output.push('=');
        }
    }
    output
}

fn stable_project_hash(input: &str) -> String {
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in input.as_bytes() {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}

fn normalize_workspace_for_sessions(workspace: &str) -> String {
    let trimmed = workspace.trim();
    if trimmed.is_empty() {
        return "__MAIN_GLOBAL_CHAT__".to_string();
    }
    let path = PathBuf::from(trimmed);
    path.canonicalize()
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

fn session_project_id(workspace_root: &str) -> String {
    let scope = if workspace_root == "__MAIN_GLOBAL_CHAT__" {
        "global".to_string()
    } else {
        workspace_root.to_string()
    };
    format!("p_{}", stable_project_hash(&scope))
}

fn sessions_project_root(app: &AppHandle, workspace: &str) -> Result<(PathBuf, String, String), String> {
    let workspace_root = normalize_workspace_for_sessions(workspace);
    let project_id = session_project_id(&workspace_root);
    let data_root = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("解析应用数据目录失败: {e}"))?
        .join("sessions")
        .join("projects")
        .join(&project_id);
    fs::create_dir_all(data_root.join("sessions"))
        .map_err(|e| format!("创建项目会话目录失败: {e}"))?;
    Ok((data_root, project_id, workspace_root))
}

fn session_id_from_value(value: &Value) -> Result<String, String> {
    let raw = match value {
        Value::Number(number) => number.to_string(),
        Value::String(text) => text.trim().to_string(),
        _ => String::new(),
    };
    let session_id = sanitize_session_key(&raw);
    if session_id.is_empty() || session_id == "session" {
        Err("会话 id 缺失，无法保存记录".to_string())
    } else {
        Ok(session_id)
    }
}

fn session_id_from_object(value: &Value) -> Result<String, String> {
    session_id_from_value(value.get("id").unwrap_or(&Value::Null))
}

fn session_dir(project_root: &Path, session_id: &str) -> PathBuf {
    project_root.join("sessions").join(sanitize_session_key(session_id))
}

fn session_index_path(project_root: &Path) -> PathBuf {
    project_root.join("sessions.index.json")
}

fn write_text_atomic(path: &Path, content: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建会话记录父目录失败: {e}"))?;
    }
    let temp_path = path.with_extension("tmp");
    fs::write(&temp_path, content).map_err(|e| format!("写入会话记录临时文件失败: {e}"))?;
    fs::rename(&temp_path, path).map_err(|e| format!("替换会话记录失败: {e}"))
}

fn write_json_atomic(path: &Path, value: &Value) -> Result<(), String> {
    let content = serde_json::to_string_pretty(value)
        .map_err(|e| format!("序列化会话记录失败: {e}"))?;
    write_text_atomic(path, &(content + "\n"))
}

fn read_json_file(path: &Path) -> Result<Value, String> {
    let content = fs::read_to_string(path).map_err(|e| format!("读取会话记录失败: {e}"))?;
    serde_json::from_str(&content).map_err(|e| format!("解析会话记录失败: {e}"))
}

fn read_jsonl_file(path: &Path) -> Result<Vec<Value>, String> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    let file = File::open(path).map_err(|e| format!("打开会话消息记录失败: {e}"))?;
    let reader = BufReader::new(file);
    let mut rows = Vec::new();
    for (index, line) in reader.lines().enumerate() {
        let line = line.map_err(|e| format!("读取会话消息记录失败: {e}"))?;
        if line.trim().is_empty() {
            continue;
        }
        let value = serde_json::from_str::<Value>(&line)
            .map_err(|e| format!("解析会话消息第 {} 行失败: {e}", index + 1))?;
        rows.push(value);
    }
    Ok(rows)
}

fn write_jsonl_atomic(path: &Path, values: &[Value], error_label: &str) -> Result<(), String> {
    let mut lines = String::new();
    for row in values {
        let line = serde_json::to_string(row)
            .map_err(|e| format!("序列化{error_label}失败: {e}"))?;
        lines.push_str(&line);
        lines.push('\n');
    }
    write_text_atomic(path, &lines)
}

fn strip_runtime_transcript_fields(runtime: &mut Value) {
    if let Some(object) = runtime.as_object_mut() {
        object.remove("taskFlow");
        object.remove("conversationTurns");
    }
}

#[derive(Clone, Debug)]
struct SessionTranscript {
    messages: Vec<Value>,
    turns: Vec<Value>,
    recovered_from_agent_messages: bool,
}

fn runtime_array_field(path: &Path, field: &str) -> Result<Vec<Value>, String> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    Ok(read_json_file(path)?
        .get(field)
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default())
}

fn agent_message_role(value: &Value) -> &str {
    value
        .get("role")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
}

fn agent_message_content(value: &Value) -> String {
    value
        .get("content")
        .or_else(|| value.get("text"))
        .or_else(|| value.get("message"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}

fn push_synthetic_turn(
    turns: &mut Vec<Value>,
    turn_id: &mut Option<String>,
    block_ids: &mut Vec<Value>,
    first_user_prompt: &mut String,
    turn_index: usize,
) {
    if let Some(id) = turn_id.take() {
        let title = if first_user_prompt.trim().is_empty() {
            "Recovered conversation".to_string()
        } else {
            first_user_prompt.chars().take(80).collect::<String>()
        };
        turns.push(json!({
            "id": id,
            "userPrompt": first_user_prompt,
            "title": title,
            "mode": "chat",
            "status": "done",
            "summary": title,
            "blockIds": block_ids.clone(),
            "collapsed": false,
            "createdAt": turn_index,
            "recoveredFromAgentMessages": true,
        }));
    }
    block_ids.clear();
    first_user_prompt.clear();
}

fn agent_messages_to_synthetic_transcript(agent_messages: Vec<Value>, session_id: &str) -> (Vec<Value>, Vec<Value>) {
    let mut messages = Vec::new();
    let mut turns = Vec::new();
    let mut current_turn_id: Option<String> = None;
    let mut current_block_ids: Vec<Value> = Vec::new();
    let mut first_user_prompt = String::new();
    let mut turn_index = 0usize;
    let mut block_id = 1usize;

    for message in agent_messages {
        let role = agent_message_role(&message);
        if role == "system" || role.is_empty() {
            continue;
        }

        let content = agent_message_content(&message);
        if content.trim().is_empty() {
            continue;
        }

        if role == "user" || current_turn_id.is_none() {
            if current_turn_id.is_some() {
                push_synthetic_turn(
                    &mut turns,
                    &mut current_turn_id,
                    &mut current_block_ids,
                    &mut first_user_prompt,
                    turn_index,
                );
                turn_index += 1;
            }
            current_turn_id = Some(format!("recovered-{session_id}-{turn_index}"));
            first_user_prompt = if role == "user" {
                content.clone()
            } else {
                String::new()
            };
        }

        let turn_id = current_turn_id
            .clone()
            .unwrap_or_else(|| format!("recovered-{session_id}-{turn_index}"));
        let id = block_id as u64;
        block_id += 1;
        current_block_ids.push(Value::Number(id.into()));

        let block = match role {
            "user" => json!({
                "id": id,
                "turnId": turn_id,
                "type": "user",
                "content": content,
                "recoveredFromAgentMessages": true,
            }),
            "assistant" => json!({
                "id": id,
                "turnId": turn_id,
                "type": "agent",
                "content": content,
                "recoveredFromAgentMessages": true,
            }),
            "tool" => json!({
                "id": id,
                "turnId": turn_id,
                "type": "tool",
                "toolName": message
                    .get("name")
                    .or_else(|| message.get("toolName"))
                    .and_then(Value::as_str)
                    .unwrap_or("tool"),
                "target": message
                    .get("tool_call_id")
                    .or_else(|| message.get("toolCallId"))
                    .and_then(Value::as_str)
                    .unwrap_or(""),
                "status": "done",
                "toolStatus": "executed",
                "message": content,
                "recoveredFromAgentMessages": true,
            }),
            _ => json!({
                "id": id,
                "turnId": turn_id,
                "type": "agent",
                "content": content,
                "recoveredFromAgentMessages": true,
            }),
        };
        messages.push(block);
    }

    if current_turn_id.is_some() && !current_block_ids.is_empty() {
        push_synthetic_turn(
            &mut turns,
            &mut current_turn_id,
            &mut current_block_ids,
            &mut first_user_prompt,
            turn_index,
        );
    }

    (messages, turns)
}

fn read_session_transcript_with_fallback(
    messages_path: &Path,
    turns_path: &Path,
    runtime_path: &Path,
    session_id: &str,
) -> Result<SessionTranscript, String> {
    let messages = read_jsonl_file(messages_path)?;
    let turns = read_jsonl_file(turns_path)?;
    if !messages.is_empty() || !turns.is_empty() {
        return Ok(SessionTranscript {
            messages,
            turns,
            recovered_from_agent_messages: false,
        });
    }

    let runtime_messages = runtime_array_field(runtime_path, "taskFlow")?;
    let runtime_turns = runtime_array_field(runtime_path, "conversationTurns")?;
    if !runtime_messages.is_empty() || !runtime_turns.is_empty() {
        return Ok(SessionTranscript {
            messages: runtime_messages,
            turns: runtime_turns,
            recovered_from_agent_messages: false,
        });
    }

    let agent_messages = runtime_array_field(runtime_path, "agentMessages")?;
    if !agent_messages.is_empty() {
        let (messages, turns) = agent_messages_to_synthetic_transcript(agent_messages, session_id);
        if !messages.is_empty() || !turns.is_empty() {
            return Ok(SessionTranscript {
                messages,
                turns,
                recovered_from_agent_messages: true,
            });
        }
    }

    Ok(SessionTranscript {
        messages: Vec::new(),
        turns: Vec::new(),
        recovered_from_agent_messages: false,
    })
}

fn restore_runtime_transcript_fields(runtime: &mut Value, messages: Vec<Value>, turns: Vec<Value>) {
    if let Some(object) = runtime.as_object_mut() {
        object.insert("taskFlow".to_string(), Value::Array(messages));
        object.insert("conversationTurns".to_string(), Value::Array(turns));
    }
}

fn read_jsonl_rows_by_block_ids(path: &Path, block_ids: &HashSet<String>) -> Result<Vec<Value>, String> {
    if !path.exists() || block_ids.is_empty() {
        return Ok(Vec::new());
    }
    let file = File::open(path).map_err(|e| format!("打开会话消息记录失败: {e}"))?;
    let reader = BufReader::new(file);
    let mut rows = Vec::new();
    for (index, line) in reader.lines().enumerate() {
        let line = line.map_err(|e| format!("读取会话消息记录失败: {e}"))?;
        if line.trim().is_empty() {
            continue;
        }
        let value = serde_json::from_str::<Value>(&line)
            .map_err(|e| format!("解析会话消息第 {} 行失败: {e}", index + 1))?;
        let id_key = match value.get("id") {
            Some(Value::Number(number)) => number.to_string(),
            Some(Value::String(text)) => text.trim().to_string(),
            _ => String::new(),
        };
        if block_ids.contains(&id_key) {
            rows.push(value);
        }
    }
    Ok(rows)
}

fn json_row_id_key(value: &Value) -> Option<String> {
    match value.get("id") {
        Some(Value::Number(number)) => Some(number.to_string()),
        Some(Value::String(text)) => {
            let trimmed = text.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            }
        }
        _ => None,
    }
}

fn merge_json_rows_by_id(existing: Vec<Value>, incoming: Vec<Value>) -> Vec<Value> {
    let mut rows = existing;
    let mut positions: HashMap<String, usize> = HashMap::new();
    for (index, row) in rows.iter().enumerate() {
        if let Some(key) = json_row_id_key(row) {
            positions.insert(key, index);
        }
    }

    for row in incoming {
        if let Some(key) = json_row_id_key(&row) {
            if let Some(index) = positions.get(&key).copied() {
                rows[index] = row;
                continue;
            }
            positions.insert(key, rows.len());
        }
        rows.push(row);
    }
    rows
}

fn resolve_session_transcript_to_write(
    existing_transcript: &SessionTranscript,
    incoming_messages: Vec<Value>,
    incoming_turns: Vec<Value>,
    transcript_partial: bool,
) -> (Vec<Value>, Vec<Value>) {
    let existing_messages = if transcript_partial {
        existing_transcript.messages.clone()
    } else {
        Vec::new()
    };
    let existing_turns = if transcript_partial {
        existing_transcript.turns.clone()
    } else {
        Vec::new()
    };
    let mut messages_to_write = if transcript_partial {
        merge_json_rows_by_id(existing_messages, incoming_messages)
    } else {
        incoming_messages
    };
    let mut turns_to_write = if transcript_partial {
        merge_json_rows_by_id(existing_turns, incoming_turns)
    } else {
        incoming_turns
    };
    if messages_to_write.is_empty() && !existing_transcript.messages.is_empty() {
        messages_to_write = existing_transcript.messages.clone();
    }
    if turns_to_write.is_empty() && !existing_transcript.turns.is_empty() {
        turns_to_write = existing_transcript.turns.clone();
    }
    (messages_to_write, turns_to_write)
}

fn session_detail_status(dir: &Path) -> &'static str {
    let has_messages = dir.join("messages.jsonl").exists();
    let has_runtime = dir.join("runtime.json").exists();
    if has_messages || has_runtime {
        "ok"
    } else {
        "missing"
    }
}

fn annotate_session_meta(mut meta: Value, project_id: &str, workspace_root: &str, dir: &Path) -> Value {
    if let Some(object) = meta.as_object_mut() {
        object.insert("projectId".to_string(), Value::String(project_id.to_string()));
        object.insert("workspaceRoot".to_string(), Value::String(workspace_root.to_string()));
        object.insert(
            "storageStatus".to_string(),
            Value::String(session_detail_status(dir).to_string()),
        );
    }
    meta
}

fn rebuild_sessions_index_for_project(
    project_root: &Path,
    project_id: &str,
    workspace_root: &str,
) -> Result<Vec<Value>, String> {
    let sessions_root = project_root.join("sessions");
    fs::create_dir_all(&sessions_root).map_err(|e| format!("创建会话目录失败: {e}"))?;

    let mut sessions = Vec::new();
    for entry in fs::read_dir(&sessions_root).map_err(|e| format!("读取会话目录失败: {e}"))? {
        let entry = entry.map_err(|e| format!("读取会话目录项失败: {e}"))?;
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let meta_path = path.join("session.json");
        if !meta_path.exists() {
            continue;
        }
        let meta = read_json_file(&meta_path)?;
        sessions.push(annotate_session_meta(meta, project_id, workspace_root, &path));
    }

    sessions.sort_by(|a, b| {
        let a_date = a
            .get("date")
            .and_then(Value::as_str)
            .unwrap_or("");
        let b_date = b
            .get("date")
            .and_then(Value::as_str)
            .unwrap_or("");
        b_date.cmp(a_date)
    });

    let index = json!({
        "projectId": project_id,
        "workspaceRoot": workspace_root,
        "updatedAt": now_millis(),
        "sessions": sessions,
    });
    write_json_atomic(&session_index_path(project_root), &index)?;
    Ok(index
        .get("sessions")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default())
}

fn merge_session_lists(index_sessions: Vec<Value>, disk_sessions: Vec<Value>) -> Vec<Value> {
    let mut by_id: HashMap<String, Value> = HashMap::new();
    for session in index_sessions {
        if let Ok(session_id) = session_id_from_object(&session) {
            by_id.insert(session_id, session);
        }
    }
    for session in disk_sessions {
        if let Ok(session_id) = session_id_from_object(&session) {
            by_id.insert(session_id, session);
        }
    }
    let mut sessions: Vec<Value> = by_id.into_values().collect();
    sessions.sort_by(|a, b| {
        let a_date = a
            .get("date")
            .and_then(Value::as_str)
            .unwrap_or("");
        let b_date = b
            .get("date")
            .and_then(Value::as_str)
            .unwrap_or("");
        b_date.cmp(a_date)
    });
    sessions
}

fn ensure_in_workspace(path: &Path, workspace: &Path) -> Result<(), String> {
    if path.starts_with(workspace) {
        Ok(())
    } else {
        Err("路径越界：禁止访问工作区之外的内容".to_string())
    }
}

fn resolve_existing_path(input: &str, workspace: &Path) -> Result<PathBuf, String> {
    let raw = if Path::new(input).is_absolute() {
        PathBuf::from(input)
    } else {
        workspace.join(input)
    };
    let canonical = raw
        .canonicalize()
        .map_err(|e| format!("路径不存在或无法访问: {e}"))?;
    ensure_in_workspace(&canonical, &workspace)?;
    Ok(canonical)
}

fn resolve_write_path(input: &str, workspace: &Path) -> Result<PathBuf, String> {
    let raw = if Path::new(input).is_absolute() {
        PathBuf::from(input)
    } else {
        workspace.join(input)
    };

    let mut probe = raw.as_path();
    while !probe.exists() {
        probe = probe
            .parent()
            .ok_or_else(|| "写入路径非法：无法找到有效父目录".to_string())?;
    }
    let canonical_parent = probe
        .canonicalize()
        .map_err(|e| format!("无法解析写入路径父目录: {e}"))?;
    ensure_in_workspace(&canonical_parent, &workspace)?;
    Ok(raw)
}

fn validate_glob_pattern(pattern: &str) -> Result<(), String> {
    let path = Path::new(pattern);
    if path.is_absolute() {
        return Err("glob 模式不允许绝对路径".to_string());
    }
    if path
        .components()
        .any(|c| matches!(c, Component::ParentDir))
    {
        return Err("glob 模式不允许包含 ..".to_string());
    }
    Ok(())
}

// endregion

fn parse_curl_status_output(output: String) -> Result<String, String> {
    let marker = "\n__HTTP_STATUS__:";
    let Some(idx) = output.rfind(marker) else {
        return Err("curl 回退未返回状态标记".to_string());
    };

    let body = output[..idx].to_string();
    let status_raw = output[idx + marker.len()..].trim();
    let status_code = status_raw
        .parse::<u16>()
        .map_err(|_| format!("curl 回退返回了无法解析的状态码: {status_raw}"))?;

    if (200..300).contains(&status_code) {
        Ok(body)
    } else {
        Err(format!(
            "HTTP {}: {}",
            status_code,
            body.chars().take(500).collect::<String>()
        ))
    }
}

fn should_use_curl_fallback(
    url: &str,
    method: &str,
    status: reqwest::StatusCode,
    error_body: &str,
) -> bool {
    if !method.eq_ignore_ascii_case("POST") {
        return false;
    }

    if !(url.contains("/v1/responses") || url.contains("/v1/chat/completions")) {
        return false;
    }

    if status.as_u16() == 524 || error_body.to_ascii_lowercase().contains("error code: 524") {
        return false;
    }

    status.is_server_error() || error_body.to_ascii_lowercase().contains("upstream_error")
}

fn should_try_curl_transport_fallback(url: &str, method: &str, error_message: &str) -> bool {
    if !method.eq_ignore_ascii_case("POST") {
        return false;
    }

    if !(url.contains("/v1/responses") || url.contains("/v1/chat/completions") || url.contains("/v1/messages")) {
        return false;
    }

    let normalized = error_message.to_ascii_lowercase();
    normalized.contains("error sending request")
        || normalized.contains("connection closed")
        || normalized.contains("connection reset")
        || normalized.contains("error decoding response body")
        || normalized.contains("error reading a body")
        || normalized.contains("error reading response body")
        || normalized.contains("unexpected eof")
        || normalized.contains("operation timed out")
        || normalized.contains("timed out")
        || normalized.contains("timeout")
        || normalized.contains("tls")
        || normalized.contains("certificate")
}

fn proxy_request_via_curl(
    url: &str,
    method: &str,
    headers: Option<&std::collections::HashMap<String, String>>,
    body: Option<&str>,
) -> Result<String, String> {
    let mut command = ProcessCommand::new("curl");
    command.arg("-sS");
    command.arg("-L");
    command.arg("-X").arg(method);
    command.arg(url);
    command.arg("--connect-timeout").arg(HTTP_CONNECT_TIMEOUT_SECS.to_string());
    let max_time_secs = if method.eq_ignore_ascii_case("POST")
        && (url.contains("/v1/responses") || url.contains("/v1/chat/completions") || url.contains("/v1/messages"))
    {
        MODEL_REQUEST_TIMEOUT_SECS
    } else {
        HTTP_SHORT_TIMEOUT_SECS
    };
    command.arg("--max-time").arg(max_time_secs.to_string());
    command.arg("-w").arg("\n__HTTP_STATUS__:%{http_code}");

    let has_accept_encoding = headers
        .map(|hdrs| hdrs.keys().any(|key| key.eq_ignore_ascii_case("accept-encoding")))
        .unwrap_or(false);
    if !has_accept_encoding {
        command.arg("-H").arg("Accept-Encoding: identity");
    }

    if let Some(hdrs) = headers {
        for (key, value) in hdrs {
            command.arg("-H").arg(format!("{key}: {value}"));
        }
    }

    if let Some(body_str) = body {
        command.arg("--data-binary").arg(body_str);
    }

    let output = command
        .output()
        .map_err(|e| format!("curl 回退执行失败: {e}"))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();

    if !output.status.success() && stdout.trim().is_empty() {
        return Err(if stderr.is_empty() {
            format!("curl 回退失败，退出码 {:?}", output.status.code())
        } else {
            format!("curl 回退失败: {stderr}")
        });
    }

    parse_curl_status_output(stdout).map_err(|err| {
        if stderr.is_empty() {
            err
        } else {
            format!("{err} | curl stderr: {stderr}")
        }
    })
}

// region: grep 辅助

fn is_probably_binary(path: &Path) -> bool {
    let mut file = match File::open(path) {
        Ok(f) => f,
        Err(_) => return false,
    };
    let mut head = [0_u8; 1024];
    let n = match file.read(&mut head) {
        Ok(size) => size,
        Err(_) => return false,
    };
    head[..n].contains(&0)
}

fn append_grep_hit(
    workspace: &Path,
    file_path: &Path,
    line_no: usize,
    line: &str,
    output: &mut String,
) {
    let display_path = file_path
        .strip_prefix(workspace)
        .unwrap_or(file_path)
        .to_string_lossy();
    output.push_str(&format!("{display_path}:{line_no}:{line}\n"));
}

fn grep_file(
    workspace: &Path,
    file_path: &Path,
    regex: &Regex,
    output: &mut String,
    matched: &mut usize,
) -> Result<(), String> {
    let file = File::open(file_path)
        .map_err(|e| format!("无法读取文件 {}: {e}", file_path.display()))?;
    let reader = BufReader::new(file);

    for (idx, line_result) in reader.lines().enumerate() {
        let line = match line_result {
            Ok(text) => text,
            Err(_) => continue,
        };
        if regex.is_match(&line) {
            *matched += 1;
            append_grep_hit(workspace, file_path, idx + 1, &line, output);
            if *matched >= GREP_MATCH_LIMIT || output.len() >= GREP_OUTPUT_LIMIT_BYTES {
                break;
            }
        }
    }
    Ok(())
}

// endregion

// region: PTY 辅助

fn default_shell() -> String {
    #[cfg(target_os = "windows")]
    {
        "cmd.exe".to_string()
    }
    #[cfg(not(target_os = "windows"))]
    {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string())
    }
}

fn preferred_utf8_locale() -> String {
    for key in ["LC_ALL", "LC_CTYPE", "LANG"] {
        if let Ok(value) = std::env::var(key) {
            let upper = value.to_ascii_uppercase();
            if upper.contains("UTF-8") || upper.contains("UTF8") {
                return value;
            }
        }
    }

    #[cfg(target_os = "macos")]
    {
        "en_US.UTF-8".to_string()
    }
    #[cfg(target_os = "windows")]
    {
        "en_US.UTF-8".to_string()
    }
    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    {
        "C.UTF-8".to_string()
    }
}

fn apply_pty_terminal_env(cmd: &mut CommandBuilder) {
    let locale = preferred_utf8_locale();
    cmd.env("LANG", &locale);
    cmd.env("LC_ALL", &locale);
    cmd.env("LC_CTYPE", &locale);
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("PYTHONIOENCODING", "utf-8");
    cmd.env("PYTHONUTF8", "1");
}

fn apply_process_terminal_env(cmd: &mut ProcessCommand) {
    let locale = preferred_utf8_locale();
    cmd.env("LANG", &locale)
        .env("LC_ALL", &locale)
        .env("LC_CTYPE", &locale)
        .env("TERM", "xterm-256color")
        .env("COLORTERM", "truecolor")
        .env("PYTHONIOENCODING", "utf-8")
        .env("PYTHONUTF8", "1");
}

fn decode_utf8_stream_chunk(pending: &mut Vec<u8>, data: &[u8]) -> String {
    let mut bytes = Vec::with_capacity(pending.len() + data.len());
    bytes.extend_from_slice(pending);
    bytes.extend_from_slice(data);
    pending.clear();

    let mut output = String::new();
    let mut start = 0;

    while start < bytes.len() {
        match std::str::from_utf8(&bytes[start..]) {
            Ok(valid) => {
                output.push_str(valid);
                break;
            }
            Err(error) => {
                let valid_up_to = error.valid_up_to();
                if valid_up_to > 0 {
                    output.push_str(
                        std::str::from_utf8(&bytes[start..start + valid_up_to])
                            .unwrap_or_default(),
                    );
                }

                let invalid_start = start + valid_up_to;
                match error.error_len() {
                    Some(error_len) => {
                        output.push('\u{FFFD}');
                        start = invalid_start + error_len;
                    }
                    None => {
                        pending.extend_from_slice(&bytes[invalid_start..]);
                        break;
                    }
                }
            }
        }
    }

    output
}

fn decode_utf8_lossy_for_display(bytes: &[u8]) -> String {
    let first_boundary = bytes
        .iter()
        .position(|byte| (*byte & 0b1100_0000) != 0b1000_0000)
        .unwrap_or(bytes.len());
    String::from_utf8_lossy(&bytes[first_boundary..]).to_string()
}

#[cfg(test)]
mod terminal_utf8_tests {
    use super::*;

    #[test]
    fn stream_decoder_preserves_split_cjk_bytes() {
        let mut pending = Vec::new();
        let bytes = "中文输出".as_bytes();

        let first = decode_utf8_stream_chunk(&mut pending, &bytes[..2]);
        let second = decode_utf8_stream_chunk(&mut pending, &bytes[2..7]);
        let third = decode_utf8_stream_chunk(&mut pending, &bytes[7..]);

        assert_eq!(format!("{first}{second}{third}"), "中文输出");
        assert!(pending.is_empty());
    }

    #[test]
    fn display_decoder_skips_leading_continuation_bytes() {
        let bytes = "中文".as_bytes();

        assert_eq!(decode_utf8_lossy_for_display(&bytes[1..]), "文");
    }
}

fn take_tail_chars(text: &str, max_chars: usize) -> (String, bool) {
    let char_count = text.chars().count();
    if char_count <= max_chars {
        return (text.to_string(), false);
    }
    (
        text.chars().skip(char_count - max_chars).collect::<String>(),
        true,
    )
}

fn read_limited_pipe<R: Read>(mut reader: R, limit: usize) -> CapturedPipe {
    let mut bytes = Vec::new();
    let mut chunk = [0_u8; 8192];
    let mut truncated = false;

    loop {
        match reader.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => {
                if bytes.len() < limit {
                    let remaining = limit - bytes.len();
                    let take = remaining.min(n);
                    bytes.extend_from_slice(&chunk[..take]);
                    if take < n {
                        truncated = true;
                    }
                } else {
                    truncated = true;
                }
            }
            Err(err) if err.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => {
                truncated = true;
                break;
            }
        }
    }

    CapturedPipe {
        text: String::from_utf8_lossy(&bytes).to_string(),
        truncated,
    }
}

fn join_captured_pipe(
    handle: Option<JoinHandle<CapturedPipe>>,
    label: &str,
) -> Result<CapturedPipe, String> {
    match handle {
        Some(handle) => handle
            .join()
            .map_err(|_| format!("读取 {label} 线程异常退出")),
        None => Ok(CapturedPipe {
            text: String::new(),
            truncated: false,
        }),
    }
}

fn build_workspace_shell_command(command: &str) -> ProcessCommand {
    if cfg!(target_os = "windows") {
        let mut cmd = ProcessCommand::new("cmd");
        let utf8_command = format!("chcp 65001>nul && {command}");
        cmd.args(["/C", &utf8_command]);
        apply_process_terminal_env(&mut cmd);
        cmd
    } else {
        let mut cmd = ProcessCommand::new("/bin/sh");
        cmd.args(["-lc", command]);
        apply_process_terminal_env(&mut cmd);
        cmd
    }
}

fn run_workspace_shell_command(
    workspace: &Path,
    command: String,
    input: Option<String>,
    timeout: Duration,
) -> Result<TerminalCommandOutput, String> {
    let trimmed = command.trim();
    if trimmed.is_empty() {
        return Err("命令不能为空".to_string());
    }

    let mut process = build_workspace_shell_command(trimmed);
    process
        .current_dir(workspace)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = process
        .spawn()
        .map_err(|e| format!("启动命令失败: {e}"))?;

    let stdout_handle = child.stdout.take().map(|stdout| {
        thread::spawn(move || read_limited_pipe(stdout, COMMAND_OUTPUT_LIMIT_BYTES))
    });
    let stderr_handle = child.stderr.take().map(|stderr| {
        thread::spawn(move || read_limited_pipe(stderr, COMMAND_OUTPUT_LIMIT_BYTES))
    });

    if let Some(stdin) = child.stdin.as_mut() {
        if let Some(payload) = input.as_ref() {
            stdin
                .write_all(payload.as_bytes())
                .map_err(|e| format!("写入命令输入失败: {e}"))?;
        }
    }
    let _ = child.stdin.take();

    let started_at = Instant::now();
    let mut timed_out = false;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {
                if started_at.elapsed() >= timeout {
                    timed_out = true;
                    let _ = child.kill();
                    break child
                        .wait()
                        .map_err(|e| format!("等待被终止的命令结束失败: {e}"))?;
                }
                thread::sleep(Duration::from_millis(10));
            }
            Err(e) => return Err(format!("等待命令结束失败: {e}")),
        }
    };

    let stdout = join_captured_pipe(stdout_handle, "stdout")?;
    let stderr = join_captured_pipe(stderr_handle, "stderr")?;
    let exit_code = status.code().unwrap_or(if timed_out { -1 } else { 1 });

    Ok(TerminalCommandOutput {
        command: trimmed.to_string(),
        stdout: stdout.text,
        stderr: stderr.text,
        exit_code,
        timed_out,
        duration_ms: started_at.elapsed().as_millis(),
        success: !timed_out && status.success(),
        stdout_truncated: stdout.truncated,
        stderr_truncated: stderr.truncated,
    })
}

fn run_git_process(
    workspace: &Path,
    args: &[&str],
    timeout: Duration,
) -> Result<GitProcessOutput, String> {
    let mut process = ProcessCommand::new("git");
    process
        .args(args)
        .current_dir(workspace)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = process.spawn().map_err(|e| format!("启动 git 失败: {e}"))?;

    let stdout_handle = child
        .stdout
        .take()
        .map(|stdout| thread::spawn(move || read_limited_pipe(stdout, COMMAND_OUTPUT_LIMIT_BYTES)));
    let stderr_handle = child
        .stderr
        .take()
        .map(|stderr| thread::spawn(move || read_limited_pipe(stderr, COMMAND_OUTPUT_LIMIT_BYTES)));

    let started_at = Instant::now();
    let mut timed_out = false;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {
                if started_at.elapsed() >= timeout {
                    timed_out = true;
                    let _ = child.kill();
                    break child
                        .wait()
                        .map_err(|e| format!("等待被终止的 git 命令结束失败: {e}"))?;
                }
                thread::sleep(Duration::from_millis(10));
            }
            Err(e) => return Err(format!("等待 git 命令结束失败: {e}")),
        }
    };

    let stdout = join_captured_pipe(stdout_handle, "git stdout")?;
    let stderr = join_captured_pipe(stderr_handle, "git stderr")?;
    let exit_code = status.code().unwrap_or(if timed_out { -1 } else { 1 });

    Ok(GitProcessOutput {
        stdout: stdout.text,
        stderr: stderr.text,
        exit_code,
        timed_out,
        success: !timed_out && status.success(),
    })
}

fn git_failure_message(output: &GitProcessOutput) -> String {
    let detail = if output.stderr.trim().is_empty() {
        output.stdout.trim()
    } else {
        output.stderr.trim()
    };
    let fallback = if output.timed_out {
        "git 命令超时".to_string()
    } else {
        format!("git 命令失败，退出码 {}", output.exit_code)
    };
    if detail.is_empty() {
        fallback
    } else {
        detail.to_string()
    }
}

fn has_git_marker(mut path: &Path) -> bool {
    loop {
        if path.join(".git").exists() {
            return true;
        }
        match path.parent() {
            Some(parent) => path = parent,
            None => return false,
        }
    }
}

fn empty_git_status(git_available: bool, is_repo: bool, error: Option<String>) -> GitStatus {
    GitStatus {
        is_repo,
        git_available,
        clean: true,
        error,
        ..GitStatus::default()
    }
}

fn parse_git_ahead_behind(detail: &str) -> (usize, usize) {
    let mut ahead = 0;
    let mut behind = 0;
    for part in detail.split(',') {
        let trimmed = part.trim();
        if let Some(value) = trimmed.strip_prefix("ahead ") {
            ahead = value.trim().parse::<usize>().unwrap_or(0);
        } else if let Some(value) = trimmed.strip_prefix("behind ") {
            behind = value.trim().parse::<usize>().unwrap_or(0);
        }
    }
    (ahead, behind)
}

fn parse_git_branch_line(line: &str) -> GitBranchInfo {
    let mut info = GitBranchInfo::default();
    let mut text = line.strip_prefix("## ").unwrap_or(line).trim();

    if let Some(rest) = text.strip_prefix("No commits yet on ") {
        info.branch = Some(rest.trim().to_string());
        return info;
    }

    if let Some(bracket_start) = text.rfind(" [") {
        if text.ends_with(']') {
            let detail = &text[bracket_start + 2..text.len() - 1];
            let (ahead, behind) = parse_git_ahead_behind(detail);
            info.ahead = ahead;
            info.behind = behind;
            text = text[..bracket_start].trim();
        }
    }

    if let Some((branch, upstream)) = text.split_once("...") {
        let branch = branch.trim();
        if !branch.is_empty() {
            info.branch = Some(branch.to_string());
        }
        let upstream = upstream.trim();
        if !upstream.is_empty() {
            info.upstream = Some(upstream.to_string());
        }
    } else if !text.is_empty() {
        info.branch = Some(text.to_string());
    }

    info
}

fn is_git_conflict_status(x: char, y: char) -> bool {
    matches!(
        (x, y),
        ('D', 'D') | ('A', 'U') | ('U', 'D') | ('U', 'A') | ('D', 'U') | ('A', 'A') | ('U', 'U')
    )
}

fn parse_git_porcelain_status(output: &str) -> (GitBranchInfo, GitWorktreeCounts) {
    let mut branch = GitBranchInfo::default();
    let mut counts = GitWorktreeCounts::default();

    for line in output.lines() {
        if line.trim().is_empty() {
            continue;
        }
        if line.starts_with("## ") {
            branch = parse_git_branch_line(line);
            continue;
        }
        if line.starts_with("!!") {
            continue;
        }

        counts.changed_files += 1;
        let mut chars = line.chars();
        let x = chars.next().unwrap_or(' ');
        let y = chars.next().unwrap_or(' ');

        if x == '?' && y == '?' {
            counts.untracked_files += 1;
            continue;
        }

        if is_git_conflict_status(x, y) {
            counts.conflicted_files += 1;
            continue;
        }

        if x != ' ' && x != '?' {
            counts.staged_files += 1;
        }
        if y != ' ' && y != '?' {
            counts.unstaged_files += 1;
        }
    }

    (branch, counts)
}

fn parse_git_numstat(output: &str) -> GitNumstatCounts {
    let mut counts = GitNumstatCounts::default();
    for line in output.lines() {
        let mut parts = line.split('\t');
        let Some(insertions) = parts.next() else {
            continue;
        };
        let Some(deletions) = parts.next() else {
            continue;
        };
        counts.insertions += insertions.parse::<usize>().unwrap_or(0);
        counts.deletions += deletions.parse::<usize>().unwrap_or(0);
    }
    counts
}

fn parse_git_porcelain_entries(output: &str, filter: Option<&str>) -> Vec<GitPorcelainEntry> {
    let filter_type = filter.unwrap_or("");
    let mut entries = Vec::new();

    for line in output.lines() {
        if line.len() < 3 {
            continue;
        }

        let status_chars = line.chars().take(2).collect::<String>();
        let path_part = line[2..].trim_start();
        let (original_path, display_path) = if let Some(arrow_pos) = path_part.find(" -> ") {
            (
                Some(path_part[..arrow_pos].trim().to_string()),
                path_part[arrow_pos + 4..].trim().to_string(),
            )
        } else {
            (None, path_part.to_string())
        };

        let primary_status = if status_chars.starts_with('R') {
            "R"
        } else if status_chars.starts_with('A') {
            "A"
        } else if status_chars.starts_with('D') {
            "D"
        } else if status_chars.starts_with('?') {
            "U"
        } else if status_chars.starts_with('M') || status_chars.starts_with('C') {
            "M"
        } else {
            "M"
        };

        match filter_type {
            "changed" | "modified" => {
                if primary_status != "M" && primary_status != "R" {
                    continue;
                }
            }
            "added" => {
                if primary_status != "A" && primary_status != "U" {
                    continue;
                }
            }
            "deleted" => {
                if primary_status != "D" {
                    continue;
                }
            }
            "untracked" => {
                if primary_status != "U" {
                    continue;
                }
            }
            _ => {}
        }

        entries.push(GitPorcelainEntry {
            path: display_path,
            original_path,
            status: primary_status.to_string(),
        });
    }

    entries
}

fn is_valid_git_branch_name(branch: &str) -> bool {
    let trimmed = branch.trim();
    if trimmed.is_empty() || trimmed != branch || trimmed == "HEAD" || trimmed.starts_with('-') {
        return false;
    }
    if trimmed.starts_with('/') || trimmed.ends_with('/') || trimmed.ends_with(".lock") {
        return false;
    }
    if trimmed.contains("..") || trimmed.contains("//") || trimmed.contains("@{") {
        return false;
    }
    if trimmed
        .chars()
        .any(|ch| ch.is_control() || ch.is_whitespace() || "\\~^:?*[".contains(ch))
    {
        return false;
    }
    trimmed.split('/').all(|part| {
        !part.is_empty() && !part.starts_with('.') && !part.ends_with('.') && part != "@"
    })
}

fn get_git_status_for_workspace(
    workspace: &Path,
    include_stats: bool,
) -> Result<GitStatus, String> {
    let timeout = Duration::from_millis(10_000);
    let repo = match run_git_process(workspace, &["rev-parse", "--show-toplevel"], timeout) {
        Ok(output) if output.success => output.stdout.trim().to_string(),
        Ok(_) => return Ok(empty_git_status(true, false, None)),
        Err(error) => {
            return Ok(empty_git_status(
                false,
                has_git_marker(workspace),
                Some(error),
            ));
        }
    };

    let repo_root = PathBuf::from(repo.trim());
    let repo_root_string = repo_root.to_string_lossy().to_string();
    let status_output = run_git_process(
        &repo_root,
        &["status", "--porcelain=v1", "--branch"],
        timeout,
    )?;
    if !status_output.success {
        return Ok(GitStatus {
            is_repo: true,
            git_available: true,
            repo_root: Some(repo_root_string),
            clean: true,
            error: Some(git_failure_message(&status_output)),
            ..GitStatus::default()
        });
    }

    let (branch, counts) = parse_git_porcelain_status(&status_output.stdout);
    let has_head = run_git_process(&repo_root, &["rev-parse", "--verify", "HEAD"], timeout)
        .map(|output| output.success)
        .unwrap_or(false);
    let numstat = if include_stats && has_head {
        run_git_process(&repo_root, &["diff", "--numstat", "HEAD", "--"], timeout)
            .ok()
            .filter(|output| output.success)
            .map(|output| parse_git_numstat(&output.stdout))
            .unwrap_or_default()
    } else {
        GitNumstatCounts::default()
    };
    let has_origin = run_git_process(&repo_root, &["remote", "get-url", "origin"], timeout)
        .map(|output| output.success && !output.stdout.trim().is_empty())
        .unwrap_or(false);

    Ok(GitStatus {
        is_repo: true,
        git_available: true,
        repo_root: Some(repo_root_string),
        branch: branch.branch,
        upstream: branch.upstream,
        ahead: branch.ahead,
        behind: branch.behind,
        changed_files: counts.changed_files,
        insertions: numstat.insertions,
        deletions: numstat.deletions,
        untracked_files: counts.untracked_files,
        staged_files: counts.staged_files,
        unstaged_files: counts.unstaged_files,
        conflicted_files: counts.conflicted_files,
        clean: counts.changed_files == 0,
        has_origin,
        error: None,
    })
}

fn ensure_git_ready(status: &GitStatus) -> Result<(), String> {
    if !status.git_available {
        return Err(status
            .error
            .clone()
            .unwrap_or_else(|| "未找到 Git".to_string()));
    }
    if !status.is_repo {
        return Err("当前文件夹不是 Git 仓库".to_string());
    }
    Ok(())
}

fn current_git_branch(status: &GitStatus) -> Result<String, String> {
    let branch = status.branch.as_deref().unwrap_or("").trim();
    if branch.is_empty() || branch.starts_with("HEAD") {
        return Err("当前仓库不在普通分支上，无法执行该操作".to_string());
    }
    Ok(branch.to_string())
}

#[tauri::command]
fn get_git_status(
    state: State<WorkspaceState>,
    workspace: Option<String>,
    include_stats: Option<bool>,
) -> Result<GitStatus, String> {
    let workspace = resolve_workspace_root(&state, workspace)?;
    get_git_status_for_workspace(&workspace, include_stats.unwrap_or(false))
}

#[tauri::command]
fn get_git_file_list(
    state: State<WorkspaceState>,
    workspace: Option<String>,
    filter: Option<String>,
) -> Result<Vec<GitFileEntry>, String> {
    let workspace = resolve_workspace_root(&state, workspace)?;
    let timeout = Duration::from_millis(10_000);

    let repo = match run_git_process(&workspace, &["rev-parse", "--show-toplevel"], timeout) {
        Ok(output) if output.success => output.stdout.trim().to_string(),
        Ok(_) => return Ok(Vec::new()),
        Err(_) => return Ok(Vec::new()),
    };

    let repo_root = PathBuf::from(repo.trim());
    let status_output = run_git_process(
        &repo_root,
        &["status", "--porcelain=v1"],
        timeout,
    )?;

    if !status_output.success {
        return Ok(Vec::new());
    }

    let max_entries = 100;
    Ok(parse_git_porcelain_entries(&status_output.stdout, filter.as_deref())
        .into_iter()
        .take(max_entries)
        .map(|entry| GitFileEntry {
            path: entry.path,
            status: entry.status,
        })
        .collect())
}

fn read_git_head_file(repo_root: &Path, path: &str, timeout: Duration) -> Result<String, String> {
    let spec = format!("HEAD:{path}");
    let output = run_git_process(repo_root, &["show", &spec], timeout)?;
    if !output.success {
        return Err(git_failure_message(&output));
    }
    Ok(output.stdout)
}

fn read_worktree_text_file(repo_root: &Path, path: &str) -> Result<String, String> {
    let full_path = repo_root.join(path);
    let bytes = fs::read(&full_path).map_err(|e| format!("读取文件失败: {e}"))?;
    String::from_utf8(bytes).map_err(|_| "binary_or_non_utf8".to_string())
}

fn build_git_diff_entry(
    repo_root: &Path,
    entry: GitPorcelainEntry,
    has_head: bool,
    timeout: Duration,
) -> GitDiffEntry {
    let head_path = entry.original_path.as_deref().unwrap_or(&entry.path);
    let mut old_text = String::new();
    let mut new_text = String::new();
    let mut existed = false;
    let mut binary = false;

    if has_head && entry.status != "A" && entry.status != "U" {
        match read_git_head_file(repo_root, head_path, timeout) {
            Ok(text) => {
                old_text = text;
                existed = true;
            }
            Err(_) => {
                binary = true;
            }
        }
    }

    if entry.status != "D" {
        match read_worktree_text_file(repo_root, &entry.path) {
            Ok(text) => {
                new_text = text;
            }
            Err(_) => {
                binary = true;
            }
        }
    }

    if binary {
        old_text.clear();
        new_text.clear();
    }

    GitDiffEntry {
        path: entry.path,
        status: entry.status,
        old: old_text,
        new: new_text,
        existed,
        full_file: true,
        binary,
    }
}

#[tauri::command]
fn get_git_diff(
    state: State<WorkspaceState>,
    workspace: Option<String>,
    path: Option<String>,
    filter: Option<String>,
) -> Result<Vec<GitDiffEntry>, String> {
    let workspace = resolve_workspace_root(&state, workspace)?;
    let timeout = Duration::from_millis(10_000);
    let repo = match run_git_process(&workspace, &["rev-parse", "--show-toplevel"], timeout) {
        Ok(output) if output.success => output.stdout.trim().to_string(),
        Ok(_) => return Ok(Vec::new()),
        Err(_) => return Ok(Vec::new()),
    };
    let repo_root = PathBuf::from(repo.trim());
    let status_output = run_git_process(&repo_root, &["status", "--porcelain=v1"], timeout)?;
    if !status_output.success {
        return Ok(Vec::new());
    }
    let requested_path = path.map(|value| value.replace('\\', "/"));
    let has_head = run_git_process(&repo_root, &["rev-parse", "--verify", "HEAD"], timeout)
        .map(|output| output.success)
        .unwrap_or(false);

    Ok(parse_git_porcelain_entries(&status_output.stdout, filter.as_deref())
        .into_iter()
        .filter(|entry| {
            requested_path
                .as_ref()
                .map(|path| entry.path == *path || entry.original_path.as_deref() == Some(path.as_str()))
                .unwrap_or(true)
        })
        .take(100)
        .map(|entry| build_git_diff_entry(&repo_root, entry, has_head, timeout))
        .collect())
}

#[tauri::command]
fn git_commit_all(
    state: State<WorkspaceState>,
    workspace: Option<String>,
    message: String,
) -> Result<GitStatus, String> {
    let message = message.trim();
    if message.is_empty() {
        return Err("提交信息不能为空".to_string());
    }

    let workspace = resolve_workspace_root(&state, workspace)?;
    let status = get_git_status_for_workspace(&workspace, true)?;
    ensure_git_ready(&status)?;
    if status.conflicted_files > 0 {
        return Err("当前存在冲突文件，请先解决冲突再提交".to_string());
    }
    if status.changed_files == 0 {
        return Err("没有可提交的更改".to_string());
    }

    let repo_root = status
        .repo_root
        .as_deref()
        .ok_or_else(|| "无法确定 Git 仓库根目录".to_string())?;
    let repo_root = PathBuf::from(repo_root);
    let timeout = Duration::from_millis(120_000);

    let add = run_git_process(&repo_root, &["add", "-A"], timeout)?;
    if !add.success {
        return Err(git_failure_message(&add));
    }

    let diff = run_git_process(
        &repo_root,
        &["diff", "--cached", "--quiet", "--exit-code"],
        timeout,
    )?;
    if diff.success {
        return Err("没有可提交的更改".to_string());
    }
    if diff.exit_code != 1 {
        return Err(git_failure_message(&diff));
    }

    let commit = run_git_process(&repo_root, &["commit", "-m", message], timeout)?;
    if !commit.success {
        return Err(git_failure_message(&commit));
    }

    get_git_status_for_workspace(&repo_root, true)
}

#[tauri::command]
fn git_push_current_branch(
    state: State<WorkspaceState>,
    workspace: Option<String>,
) -> Result<GitStatus, String> {
    let workspace = resolve_workspace_root(&state, workspace)?;
    let status = get_git_status_for_workspace(&workspace, true)?;
    ensure_git_ready(&status)?;
    let branch = current_git_branch(&status)?;
    let repo_root = status
        .repo_root
        .as_deref()
        .ok_or_else(|| "无法确定 Git 仓库根目录".to_string())?;
    let repo_root = PathBuf::from(repo_root);
    let timeout = Duration::from_millis(120_000);
    let push = if status.upstream.is_some() {
        run_git_process(&repo_root, &["push"], timeout)?
    } else if status.has_origin {
        run_git_process(
            &repo_root,
            &["push", "-u", "origin", branch.as_str()],
            timeout,
        )?
    } else {
        return Err("当前分支没有 upstream，且没有 origin remote".to_string());
    };

    if !push.success {
        return Err(git_failure_message(&push));
    }

    get_git_status_for_workspace(&repo_root, true)
}

#[tauri::command]
fn git_create_branch(
    state: State<WorkspaceState>,
    workspace: Option<String>,
    branch: String,
) -> Result<GitStatus, String> {
    let branch = branch.trim();
    if !is_valid_git_branch_name(branch) {
        return Err("分支名不合法".to_string());
    }

    let workspace = resolve_workspace_root(&state, workspace)?;
    let status = get_git_status_for_workspace(&workspace, true)?;
    ensure_git_ready(&status)?;
    let repo_root = status
        .repo_root
        .as_deref()
        .ok_or_else(|| "无法确定 Git 仓库根目录".to_string())?;
    let repo_root = PathBuf::from(repo_root);
    let timeout = Duration::from_millis(60_000);

    let check = run_git_process(
        &repo_root,
        &["check-ref-format", "--branch", branch],
        timeout,
    )?;
    if !check.success {
        return Err(git_failure_message(&check));
    }

    let created = run_git_process(&repo_root, &["switch", "-c", branch], timeout)?;
    if !created.success {
        return Err(git_failure_message(&created));
    }

    get_git_status_for_workspace(&repo_root, true)
}

fn start_pty_reader_thread(
    mut reader: Box<dyn Read + Send>,
    buffer: Arc<Mutex<PtyBuffer>>,
    app: AppHandle,
    session_key: String,
) {
    std::thread::spawn(move || {
        let mut chunk = [0_u8; 4096];
        let mut pending_utf8 = Vec::new();
        loop {
            match reader.read(&mut chunk) {
                Ok(0) => break,
                Ok(n) => {
                    let data = &chunk[..n];
                    if let Ok(mut shared) = buffer.lock() {
                        shared.append(data);
                    } else {
                        break;
                    }

                    let text = decode_utf8_stream_chunk(&mut pending_utf8, data);
                    if !text.is_empty() {
                        let _ = app.emit("pty-data", PtyDataPayload {
                            session_key: session_key.clone(),
                            chunk: text,
                        });
                    }
                }
                Err(err) if err.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => break,
            }
        }
    });
}

// endregion

// region: IPC 命令实现

fn get_tokenizer() -> Result<&'static CoreBPE, String> {
    if let Some(tok) = TOKENIZER.get() {
        return Ok(tok);
    }
    let built = cl100k_base().map_err(|e| e.to_string())?;
    let _ = TOKENIZER.set(built);
    TOKENIZER
        .get()
        .ok_or_else(|| "Tokenizer 初始化失败".to_string())
}

#[tauri::command]
fn get_workspace_root(state: State<WorkspaceState>) -> Result<String, String> {
    let root = state.get_root()?;
    Ok(root.to_string_lossy().to_string())
}

#[tauri::command]
fn set_workspace_root(state: State<WorkspaceState>, path: String) -> Result<String, String> {
    let canonical = canonicalize_workspace_dir(&path)?;
    state.set_root(canonical.clone())?;
    Ok(canonical.to_string_lossy().to_string())
}

#[tauri::command]
fn canonicalize_workspace_path(path: String) -> Result<String, String> {
    Ok(canonicalize_workspace_dir(&path)?.to_string_lossy().to_string())
}

#[tauri::command]
fn read_file(state: State<WorkspaceState>, path: String, workspace: Option<String>) -> Result<String, String> {
    let workspace = resolve_workspace_root(&state, workspace)?;
    let real_path = resolve_existing_path(&path, &workspace)?;
    fs::read_to_string(real_path).map_err(|e| e.to_string())
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct FileMetadata {
    path: String,
    size_bytes: u64,
    modified_ms: u128,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ReadFileWindowResult {
    path: String,
    content: String,
    start_line: usize,
    end_line: usize,
    total_lines: usize,
    total_chars: usize,
    returned_chars: usize,
    truncated: bool,
    next_start_line: Option<usize>,
}

fn normalize_read_file_line(mut raw: String) -> String {
    if raw.ends_with('\n') {
        raw.pop();
        if raw.ends_with('\r') {
            raw.pop();
        }
    } else if raw.ends_with('\r') {
        raw.pop();
    }
    raw
}

fn take_prefix_chars(value: &str, max_chars: usize) -> String {
    if value.chars().count() <= max_chars {
        return value.to_string();
    }
    value.chars().take(max_chars).collect()
}

#[tauri::command]
fn get_file_metadata(state: State<WorkspaceState>, path: String, workspace: Option<String>) -> Result<FileMetadata, String> {
    let workspace = resolve_workspace_root(&state, workspace)?;
    let real_path = resolve_existing_path(&path, &workspace)?;
    if !real_path.is_file() {
        return Err("get_file_metadata 目标不是文件".to_string());
    }
    let metadata = fs::metadata(&real_path).map_err(|e| e.to_string())?;
    let modified_ms = metadata
        .modified()
        .map_err(|e| format!("读取文件修改时间失败: {e}"))?
        .duration_since(UNIX_EPOCH)
        .map_err(|e| format!("文件修改时间早于 UNIX_EPOCH: {e}"))?
        .as_millis();

    Ok(FileMetadata {
        path: real_path.to_string_lossy().to_string(),
        size_bytes: metadata.len(),
        modified_ms,
    })
}

#[tauri::command]
fn read_file_window(
    state: State<WorkspaceState>,
    path: String,
    workspace: Option<String>,
    start_line: Option<usize>,
    end_line: Option<usize>,
    max_lines: Option<usize>,
    max_chars: Option<usize>,
) -> Result<ReadFileWindowResult, String> {
    let workspace = resolve_workspace_root(&state, workspace)?;
    let real_path = resolve_existing_path(&path, &workspace)?;
    if !real_path.is_file() {
        return Err("read_file_window 目标不是文件".to_string());
    }

    let start = start_line.unwrap_or(1).max(1);
    let requested_max_lines = max_lines
        .unwrap_or(READ_FILE_WINDOW_DEFAULT_MAX_LINES)
        .clamp(1, READ_FILE_WINDOW_MAX_LINES);
    let requested_end = end_line
        .unwrap_or(start.saturating_add(requested_max_lines).saturating_sub(1))
        .min(start.saturating_add(requested_max_lines).saturating_sub(1))
        .max(start);
    let char_limit = max_chars
        .unwrap_or(READ_FILE_WINDOW_DEFAULT_MAX_CHARS)
        .clamp(1, READ_FILE_WINDOW_MAX_CHARS);

    let file = File::open(&real_path).map_err(|e| e.to_string())?;
    let mut reader = BufReader::new(file);
    let mut raw = String::new();
    let mut total_lines = 0usize;
    let mut total_chars = 0usize;
    let mut selected: Vec<String> = Vec::new();
    let mut selected_chars = 0usize;
    let mut line_truncated = false;

    loop {
        raw.clear();
        let bytes = reader.read_line(&mut raw).map_err(|e| e.to_string())?;
        if bytes == 0 {
            break;
        }
        total_lines += 1;
        let line = normalize_read_file_line(raw.clone());
        let line_chars = line.chars().count();
        total_chars += line_chars;
        if total_lines > 1 {
            total_chars += 1;
        }

        if total_lines < start || total_lines > requested_end {
            continue;
        }
        if line_truncated {
            continue;
        }

        let separator_chars = if selected.is_empty() { 0 } else { 1 };
        let next_chars = selected_chars + separator_chars + line_chars;
        if !selected.is_empty() && next_chars > char_limit {
            line_truncated = true;
            continue;
        }
        if selected.is_empty() && next_chars > char_limit {
            selected.push(take_prefix_chars(&line, char_limit));
            selected_chars = char_limit;
            line_truncated = true;
            continue;
        }
        selected.push(line);
        selected_chars = next_chars;
    }

    let returned_start = if total_lines == 0 || selected.is_empty() { 0 } else { start.min(total_lines) };
    let returned_end = if total_lines == 0 || selected.is_empty() {
        0
    } else {
        returned_start + selected.len().saturating_sub(1)
    };
    let content = selected.join("\n");
    let not_whole_file = returned_start != 1 || returned_end != total_lines;
    let more_requested_lines = returned_end > 0 && returned_end < requested_end.min(total_lines.max(1));
    let more_file_lines = returned_end > 0 && returned_end < total_lines;
    let truncated = not_whole_file || more_requested_lines || more_file_lines || line_truncated;
    let next_start_line = if truncated && returned_end > 0 && (more_file_lines || more_requested_lines || line_truncated) {
        Some(returned_end + 1)
    } else {
        None
    };

    Ok(ReadFileWindowResult {
        path,
        content,
        start_line: returned_start,
        end_line: returned_end,
        total_lines,
        total_chars,
        returned_chars: selected_chars,
        truncated,
        next_start_line,
    })
}

#[tauri::command]
fn write_file(state: State<WorkspaceState>, path: String, content: String, workspace: Option<String>) -> Result<(), String> {
    let workspace = resolve_workspace_root(&state, workspace)?;
    let real_path = resolve_write_path(&path, &workspace)?;
    if real_path.exists() && real_path.is_dir() {
        return Err("write_file 目标是目录，无法写入".to_string());
    }
    if let Some(parent) = real_path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建父目录失败: {e}"))?;
    }
    fs::write(real_path, content).map_err(|e| format!("写入文件失败: {e}"))
}

#[tauri::command]
fn write_chat_temp_file(session_key: String, path: String, content: String) -> Result<String, String> {
    let workspace = ensure_chat_temp_root(&session_key)?;
    let real_path = resolve_write_path(&path, &workspace)?;
    if real_path.exists() && real_path.is_dir() {
        return Err("write_chat_temp_file 目标是目录，无法写入".to_string());
    }
    if let Some(parent) = real_path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建聊天临时父目录失败: {e}"))?;
    }
    fs::write(&real_path, content).map_err(|e| format!("写入聊天临时文件失败: {e}"))?;
    Ok(real_path.to_string_lossy().to_string())
}

#[tauri::command]
fn read_chat_temp_file(session_key: String, path: String) -> Result<String, String> {
    let workspace = ensure_chat_temp_root(&session_key)?;
    let real_path = resolve_existing_path(&path, &workspace)?;
    fs::read_to_string(real_path).map_err(|e| format!("读取聊天临时文件失败: {e}"))
}

#[tauri::command]
fn get_chat_temp_root(session_key: String) -> Result<String, String> {
    Ok(ensure_chat_temp_root(&session_key)?.to_string_lossy().to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AttachmentIngestResult {
    path: String,
    workspace: String,
    original_path: String,
    display_name: String,
    size_bytes: u64,
}

#[tauri::command]
fn ingest_attachment_file(session_key: String, source_path: String) -> Result<AttachmentIngestResult, String> {
    let raw = PathBuf::from(source_path.trim());
    let source = raw
        .canonicalize()
        .map_err(|e| format!("附件路径不存在或无法访问: {e}"))?;
    if !source.is_file() {
        return Err("只能添加文件，不能添加文件夹".to_string());
    }
    if !is_supported_attachment_path(&source) {
        return Err("不支持的附件格式".to_string());
    }

    let workspace = ensure_chat_temp_root(&session_key)?;
    let display_name = source
        .file_name()
        .and_then(|value| value.to_str())
        .map(str::to_string)
        .unwrap_or_else(|| "attachment".to_string());
    let safe_name = sanitize_attachment_filename(&display_name);
    let source_key = source.to_string_lossy().to_string();
    let relative_path = format!(
        "{}/{}-{}",
        CHAT_ATTACHMENT_PREFIX,
        stable_project_hash(&source_key),
        safe_name,
    );
    let real_path = resolve_write_path(&relative_path, &workspace)?;
    if let Some(parent) = real_path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建附件临时目录失败: {e}"))?;
    }
    fs::copy(&source, &real_path).map_err(|e| format!("复制附件失败: {e}"))?;
    let metadata = fs::metadata(&real_path).map_err(|e| format!("读取附件元数据失败: {e}"))?;

    Ok(AttachmentIngestResult {
        path: relative_path,
        workspace: workspace.to_string_lossy().to_string(),
        original_path: source.to_string_lossy().to_string(),
        display_name,
        size_bytes: metadata.len(),
    })
}

#[tauri::command]
fn ingest_attachment_bytes(
    session_key: String,
    file_name: String,
    bytes: Vec<u8>,
) -> Result<AttachmentIngestResult, String> {
    if bytes.is_empty() {
        return Err("附件内容为空".to_string());
    }
    let display_name = if file_name.trim().is_empty() {
        "attachment".to_string()
    } else {
        file_name.trim().to_string()
    };
    let safe_name = sanitize_attachment_filename(&display_name);
    let probe_path = PathBuf::from(&safe_name);
    if !is_supported_attachment_path(&probe_path) {
        return Err("不支持的附件格式".to_string());
    }

    let workspace = ensure_chat_temp_root(&session_key)?;
    let relative_path = format!(
        "{}/{}-{}",
        CHAT_ATTACHMENT_PREFIX,
        stable_project_hash(&format!("{}:{}:{}", display_name, bytes.len(), now_millis())),
        safe_name,
    );
    let real_path = resolve_write_path(&relative_path, &workspace)?;
    if let Some(parent) = real_path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建附件临时目录失败: {e}"))?;
    }
    fs::write(&real_path, &bytes).map_err(|e| format!("写入附件失败: {e}"))?;

    Ok(AttachmentIngestResult {
        path: relative_path,
        workspace: workspace.to_string_lossy().to_string(),
        original_path: display_name.clone(),
        display_name,
        size_bytes: bytes.len() as u64,
    })
}

#[tauri::command]
fn read_attachment_image_data_url(source_path: String) -> Result<String, String> {
    let raw = PathBuf::from(source_path.trim());
    let source = raw
        .canonicalize()
        .map_err(|e| format!("图片路径不存在或无法访问: {e}"))?;
    if !source.is_file() {
        return Err("只能添加图片文件，不能添加文件夹".to_string());
    }
    if !is_supported_image_attachment_path(&source) {
        return Err("不支持的图片格式".to_string());
    }
    let bytes = fs::read(&source).map_err(|e| format!("读取图片失败: {e}"))?;
    Ok(format!(
        "data:{};base64,{}",
        image_attachment_mime(&source),
        encode_base64(&bytes),
    ))
}

#[tauri::command]
fn list_project_sessions(app: AppHandle, workspace: String) -> Result<Vec<Value>, String> {
    let (project_root, project_id, workspace_root) = sessions_project_root(&app, &workspace)?;
    let index_path = session_index_path(&project_root);
    let disk_sessions = rebuild_sessions_index_for_project(&project_root, &project_id, &workspace_root)?;
    if index_path.exists() {
        let index = read_json_file(&index_path)?;
        if let Some(sessions) = index.get("sessions").and_then(Value::as_array) {
            let index_sessions = sessions
                .iter()
                .map(|session| {
                    let session_id = session_id_from_object(session).unwrap_or_else(|_| "session".to_string());
                    annotate_session_meta(
                        session.clone(),
                        &project_id,
                        &workspace_root,
                        &session_dir(&project_root, &session_id),
                    )
                })
                .collect();
            return Ok(merge_session_lists(index_sessions, disk_sessions));
        }
    }
    Ok(disk_sessions)
}

#[tauri::command]
fn rebuild_project_sessions_index(app: AppHandle, workspace: String) -> Result<Vec<Value>, String> {
    let (project_root, project_id, workspace_root) = sessions_project_root(&app, &workspace)?;
    rebuild_sessions_index_for_project(&project_root, &project_id, &workspace_root)
}

#[tauri::command]
fn save_project_session(app: AppHandle, workspace: String, session: Value) -> Result<Value, String> {
    let (project_root, project_id, workspace_root) = sessions_project_root(&app, &workspace)?;
    let session_id = session_id_from_object(&session)?;
    let dir = session_dir(&project_root, &session_id);
    fs::create_dir_all(&dir).map_err(|e| format!("创建会话记录目录失败: {e}"))?;

    let mut meta = session
        .as_object()
        .cloned()
        .ok_or_else(|| "会话记录必须是对象".to_string())?;
    let messages = meta.remove("messages").unwrap_or_else(|| Value::Array(Vec::new()));
    let mut runtime = meta.remove("runtimeSnapshot");
    let turns = runtime
        .as_ref()
        .and_then(|value| value.get("conversationTurns"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let transcript_partial = runtime
        .as_ref()
        .and_then(|value| value.get("transcriptPartial"))
        .and_then(Value::as_bool)
        .unwrap_or(false)
        || meta
            .get("transcriptPartial")
            .and_then(Value::as_bool)
            .unwrap_or(false);
    let messages_path = dir.join("messages.jsonl");
    let turns_path = dir.join("turns.jsonl");
    let runtime_path = dir.join("runtime.json");
    let incoming_messages = messages.as_array().cloned().unwrap_or_default();
    let existing_transcript = read_session_transcript_with_fallback(
        &messages_path,
        &turns_path,
        &runtime_path,
        &session_id,
    )?;
    let (messages_to_write, turns_to_write) = resolve_session_transcript_to_write(
        &existing_transcript,
        incoming_messages,
        turns,
        transcript_partial,
    );
    if let Some(runtime_value) = runtime.as_mut() {
        if let Some(object) = runtime_value.as_object_mut() {
            object.remove("transcriptPartial");
            object.remove("transcriptLoadedTurns");
            object.remove("transcriptTotalTurns");
        }
        strip_runtime_transcript_fields(runtime_value);
    }
    meta.remove("transcriptPartial");
    meta.remove("transcriptLoadedTurns");
    meta.remove("transcriptTotalTurns");
    meta.insert("turnCount".to_string(), Value::Number(turns_to_write.len().into()));
    meta.insert("messageCount".to_string(), Value::Number(messages_to_write.len().into()));
    meta.insert("projectId".to_string(), Value::String(project_id.clone()));
    meta.insert("workspaceRoot".to_string(), Value::String(workspace_root.clone()));
    meta.insert("updatedAtMs".to_string(), Value::Number(now_millis().into()));
    meta.insert("storageStatus".to_string(), Value::String("ok".to_string()));

    let meta_value = Value::Object(meta);
    write_json_atomic(&dir.join("session.json"), &meta_value)?;

    write_jsonl_atomic(&messages_path, &messages_to_write, "会话消息")?;
    write_jsonl_atomic(&turns_path, &turns_to_write, "会话回合")?;

    if let Some(runtime_value) = runtime {
        write_json_atomic(&runtime_path, &runtime_value)?;
    }

    let sessions = rebuild_sessions_index_for_project(&project_root, &project_id, &workspace_root)?;
    Ok(sessions
        .into_iter()
        .find(|item| item.get("id") == meta_value.get("id"))
        .unwrap_or_else(|| annotate_session_meta(meta_value, &project_id, &workspace_root, &dir)))
}

#[tauri::command]
fn load_project_session(app: AppHandle, workspace: String, session_id: Value) -> Result<Value, String> {
    let (project_root, project_id, workspace_root) = sessions_project_root(&app, &workspace)?;
    let session_id = session_id_from_value(&session_id)?;
    let dir = session_dir(&project_root, &session_id);
    let meta_path = dir.join("session.json");

    let mut session = if meta_path.exists() {
        read_json_file(&meta_path)?
    } else {
        json!({
            "id": session_id,
            "title": "Missing Session",
            "date": "",
            "active": false,
        })
    };

    let messages_path = dir.join("messages.jsonl");
    let turns_path = dir.join("turns.jsonl");
    let runtime_path = dir.join("runtime.json");
    let messages_missing = !messages_path.exists();
    let runtime_missing = !runtime_path.exists();
    let transcript = read_session_transcript_with_fallback(
        &messages_path,
        &turns_path,
        &runtime_path,
        &session_id,
    )?;
    let mut runtime = if runtime_path.exists() {
        Some(read_json_file(&runtime_path)?)
    } else {
        None
    };
    if let Some(runtime_value) = runtime.as_mut() {
        restore_runtime_transcript_fields(
            runtime_value,
            transcript.messages.clone(),
            transcript.turns.clone(),
        );
        if let Some(object) = runtime_value.as_object_mut() {
            object.insert(
                "recoveredFromAgentMessages".to_string(),
                Value::Bool(transcript.recovered_from_agent_messages),
            );
        }
    }

    if let Some(object) = session.as_object_mut() {
        object.insert("projectId".to_string(), Value::String(project_id));
        object.insert("workspaceRoot".to_string(), Value::String(workspace_root));
        object.insert(
            "storageStatus".to_string(),
            Value::String(if messages_missing && runtime_missing { "missing" } else { "ok" }.to_string()),
        );
        let message_count = transcript.messages.len();
        let turn_count = transcript.turns.len();
        object.insert("messages".to_string(), Value::Array(transcript.messages));
        object.insert("messageCount".to_string(), Value::Number(message_count.into()));
        object.insert("turnCount".to_string(), Value::Number(turn_count.into()));
        object.insert(
            "recoveredFromAgentMessages".to_string(),
            Value::Bool(transcript.recovered_from_agent_messages),
        );
        if let Some(runtime_value) = runtime {
            object.insert("runtimeSnapshot".to_string(), runtime_value);
        }
    }

    Ok(session)
}

#[tauri::command]
fn load_project_session_meta(app: AppHandle, workspace: String, session_id: Value) -> Result<Value, String> {
    let (project_root, project_id, workspace_root) = sessions_project_root(&app, &workspace)?;
    let session_id = session_id_from_value(&session_id)?;
    let dir = session_dir(&project_root, &session_id);
    let meta_path = dir.join("session.json");

    let mut session = if meta_path.exists() {
        read_json_file(&meta_path)?
    } else {
        json!({
            "id": session_id,
            "title": "Missing Session",
            "date": "",
            "active": false,
        })
    };

    let turns_path = dir.join("turns.jsonl");
    let messages_path = dir.join("messages.jsonl");
    let runtime_path = dir.join("runtime.json");
    let transcript = read_session_transcript_with_fallback(
        &messages_path,
        &turns_path,
        &runtime_path,
        &session_id,
    )?;

    if let Some(object) = session.as_object_mut() {
        object.insert("projectId".to_string(), Value::String(project_id));
        object.insert("workspaceRoot".to_string(), Value::String(workspace_root));
        object.insert("storageStatus".to_string(), Value::String(session_detail_status(&dir).to_string()));
        object.insert("storageVersion".to_string(), Value::Number(2.into()));
        object.insert("turnCount".to_string(), Value::Number(transcript.turns.len().into()));
        object.insert("messageCount".to_string(), Value::Number(transcript.messages.len().into()));
        object.insert(
            "recoveredFromAgentMessages".to_string(),
            Value::Bool(transcript.recovered_from_agent_messages),
        );
        if runtime_path.exists() {
            let mut runtime_value = read_json_file(&runtime_path)?;
            restore_runtime_transcript_fields(
                &mut runtime_value,
                transcript.messages.clone(),
                transcript.turns.clone(),
            );
            if let Some(runtime_object) = runtime_value.as_object_mut() {
                runtime_object.insert(
                    "recoveredFromAgentMessages".to_string(),
                    Value::Bool(transcript.recovered_from_agent_messages),
                );
            }
            object.insert("runtimeSnapshot".to_string(), runtime_value);
        }
    }

    Ok(session)
}

#[tauri::command]
fn load_project_session_page(
    app: AppHandle,
    workspace: String,
    session_id: Value,
    before_turn_index: Option<usize>,
    limit: Option<usize>,
) -> Result<Value, String> {
    let (project_root, _project_id, _workspace_root) = sessions_project_root(&app, &workspace)?;
    let session_id = session_id_from_value(&session_id)?;
    let dir = session_dir(&project_root, &session_id);
    let turns_path = dir.join("turns.jsonl");
    let messages_path = dir.join("messages.jsonl");
    let runtime_path = dir.join("runtime.json");
    let transcript = read_session_transcript_with_fallback(
        &messages_path,
        &turns_path,
        &runtime_path,
        &session_id,
    )?;
    let turns_all = transcript.turns.clone();
    let total_turns = turns_all.len();
    let page_limit = limit.unwrap_or(30).clamp(1, 120);
    let end = before_turn_index.unwrap_or(total_turns).min(total_turns);
    let start = end.saturating_sub(page_limit);
    let page_turns = turns_all[start..end].to_vec();
    let mut block_ids = HashSet::new();
    for turn in &page_turns {
        if let Some(ids) = turn.get("blockIds").and_then(Value::as_array) {
            for id in ids {
                match id {
                    Value::Number(number) => {
                        block_ids.insert(number.to_string());
                    }
                    Value::String(text) => {
                        block_ids.insert(text.trim().to_string());
                    }
                    _ => {}
                }
            }
        }
    }
    let messages = if messages_path.exists() && !block_ids.is_empty() {
        read_jsonl_rows_by_block_ids(&messages_path, &block_ids)?
    } else {
        transcript.messages.clone()
            .into_iter()
            .filter(|value| {
                let id_key = match value.get("id") {
                    Some(Value::Number(number)) => number.to_string(),
                    Some(Value::String(text)) => text.trim().to_string(),
                    _ => String::new(),
                };
                block_ids.contains(&id_key)
            })
            .collect()
    };
    let messages = if messages.is_empty() && !block_ids.is_empty() {
        transcript.messages
            .into_iter()
            .filter(|value| {
                let id_key = match value.get("id") {
                    Some(Value::Number(number)) => number.to_string(),
                    Some(Value::String(text)) => text.trim().to_string(),
                    _ => String::new(),
                };
                block_ids.contains(&id_key)
            })
            .collect()
    } else {
        messages
    };

    Ok(json!({
        "sessionId": session_id,
        "turns": page_turns,
        "messages": messages,
        "startTurnIndex": start,
        "endTurnIndex": end,
        "totalTurns": total_turns,
        "hasMore": start > 0,
        "nextBeforeTurnIndex": if start > 0 { Value::Number(start.into()) } else { Value::Null },
        "recoveredFromAgentMessages": transcript.recovered_from_agent_messages,
    }))
}

#[tauri::command]
fn delete_project_session(app: AppHandle, workspace: String, session_id: Value) -> Result<Vec<Value>, String> {
    let (project_root, project_id, workspace_root) = sessions_project_root(&app, &workspace)?;
    let session_id = session_id_from_value(&session_id)?;
    let dir = session_dir(&project_root, &session_id);
    if dir.exists() {
        fs::remove_dir_all(&dir).map_err(|e| format!("删除会话记录失败: {e}"))?;
    }
    rebuild_sessions_index_for_project(&project_root, &project_id, &workspace_root)
}

#[tauri::command]
fn clear_project_sessions(app: AppHandle, workspace: String) -> Result<(), String> {
    let (project_root, _project_id, _workspace_root) = sessions_project_root(&app, &workspace)?;
    if project_root.exists() {
        fs::remove_dir_all(&project_root).map_err(|e| format!("清空项目会话记录失败: {e}"))?;
    }
    Ok(())
}

#[tauri::command]
fn export_text_file(path: String, content: String) -> Result<(), String> {
    let real_path = PathBuf::from(&path);
    if !real_path.is_absolute() {
        return Err("导出路径必须是绝对路径".to_string());
    }
    if real_path.exists() && real_path.is_dir() {
        return Err("导出目标是目录，无法写入".to_string());
    }
    if let Some(parent) = real_path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建导出目录失败: {e}"))?;
    }
    fs::write(real_path, content).map_err(|e| format!("导出文件失败: {e}"))
}

#[derive(serde::Serialize)]
pub struct FileNode {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
}

const LIST_DIRECTORY_IGNORED_DIRS: &[&str] = &[
    "Library", "Logs", "obj", "bin", ".git", "node_modules",
    "Temp", "UserSettings", ".vs", "Build", "Builds", "dist",
    "out", "target", "coverage", "PackageCache",
];

fn should_hide_list_directory_entry(name: &str, is_dir: bool) -> bool {
    name == ".DS_Store" || (is_dir && LIST_DIRECTORY_IGNORED_DIRS.contains(&name))
}

fn compare_file_nodes(a: &FileNode, b: &FileNode) -> Ordering {
    match (a.is_dir, b.is_dir) {
        (true, false) => Ordering::Less,
        (false, true) => Ordering::Greater,
        _ => a.name.cmp(&b.name),
    }
}

#[tauri::command]
fn list_directory(
    state: State<WorkspaceState>,
    path: String,
    workspace: Option<String>,
) -> Result<Vec<FileNode>, String> {
    let workspace = resolve_workspace_root(&state, workspace)?;
    let real_path = resolve_existing_path(&path, &workspace)?;
    if !real_path.is_dir() {
        return Err("list_directory 目标不是目录".to_string());
    }
    let mut nodes = Vec::new();
    let entries = fs::read_dir(&real_path).map_err(|e| e.to_string())?;
    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let file_name = entry.file_name().to_string_lossy().to_string();
        let meta = entry.metadata().map_err(|e| e.to_string())?;
        if should_hide_list_directory_entry(&file_name, meta.is_dir()) {
            continue;
        }
        nodes.push(FileNode {
            name: file_name,
            path: entry.path().to_string_lossy().to_string(),
            is_dir: meta.is_dir(),
        });
    }
    nodes.sort_by(compare_file_nodes);
    Ok(nodes)
}

// region: get_project_skeleton 辅助

const SKELETON_WHITELIST_EXT: &[&str] = &[
    "cs", "asmdef", "asmref", "shader", "hlsl", "compute", "scene",
    "xlsx", "xls", "csv", "tsv", "pdf", "docx", "doc", "txt", "md", "json",
];
const SKELETON_BLACKLIST_EXT: &[&str] = &[
    "meta", "png", "fbx", "mat", "anim", "controller", "unitypackage", "asset",
];
const SKELETON_IGNORED_DIRS: &[&str] = &[
    "Library", "Logs", "obj", "bin", ".git", "node_modules",
    "Temp", "UserSettings", ".vs", "Build", "dist",
];
const CS_COLLAPSE_THRESHOLD: usize = 12;

fn should_skip_recursive_search_dir(name: &str) -> bool {
    SKELETON_IGNORED_DIRS.contains(&name) || LIST_DIRECTORY_IGNORED_DIRS.contains(&name)
}

fn ext_in_list(name: &str, list: &[&str]) -> bool {
    list.iter().any(|ext| name.ends_with(&format!(".{}", ext)))
}

/// Recursively build the skeleton tree. Returns `true` if this subtree
/// contains any whitelist files (used by elastic-depth logic).
fn build_skeleton_tree(
    dir: &Path,
    current_depth: usize,
    max_depth: usize,
    elastic_budget: usize,
    tree: &mut String,
) -> bool {
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return false,
    };

    let mut dirs: Vec<fs::DirEntry> = Vec::new();
    let mut cs_files: Vec<String> = Vec::new();
    let mut asm_files: Vec<String> = Vec::new();
    let mut other_wl_files: Vec<String> = Vec::new();

    for entry in entries.filter_map(|e| e.ok()) {
        let name = entry.file_name().to_string_lossy().to_string();
        if name == ".DS_Store" || SKELETON_IGNORED_DIRS.contains(&name.as_str()) {
            continue;
        }
        let path = entry.path();
        if path.is_dir() {
            dirs.push(entry);
            continue;
        }
        // Skip blacklisted extensions entirely
        if ext_in_list(&name, SKELETON_BLACKLIST_EXT) {
            continue;
        }
        // Classify whitelist files
        if name.ends_with(".asmdef") || name.ends_with(".asmref") {
            asm_files.push(name);
        } else if name.ends_with(".cs") {
            cs_files.push(name);
        } else if ext_in_list(&name, SKELETON_WHITELIST_EXT) {
            other_wl_files.push(name);
        }
    }

    dirs.sort_by(|a, b| a.file_name().cmp(&b.file_name()));
    asm_files.sort();
    cs_files.sort();
    other_wl_files.sort();

    let prefix = "  ".repeat(current_depth);
    let mut has_content = false;

    // ── Render files ──────────────────────────────────────────
    // asmdef/asmref: always visible (penetration)
    for f in &asm_files {
        tree.push_str(&format!("{}{}\n", prefix, f));
        has_content = true;
    }

    // .cs files: dynamic truncation
    if cs_files.len() > CS_COLLAPSE_THRESHOLD {
        tree.push_str(&format!("{}[... +{} .cs files]\n", prefix, cs_files.len()));
        has_content = true;
    } else {
        for f in &cs_files {
            tree.push_str(&format!("{}{}\n", prefix, f));
            has_content = true;
        }
    }

    // Other whitelist files
    for f in &other_wl_files {
        tree.push_str(&format!("{}{}\n", prefix, f));
        has_content = true;
    }

    // ── Render subdirectories ─────────────────────────────────
    for sub in &dirs {
        let sub_name = sub.file_name().to_string_lossy().to_string();
        let sub_path = sub.path();

        // Check for .asmdef/.asmref anywhere inside this subtree (penetration)
        let has_asm = directory_contains_asmdef(&sub_path, 0, 3);

        // Determine effective depth limits
        let (can_recurse, new_elastic) = if current_depth + 1 < max_depth {
            (true, elastic_budget)
        } else if current_depth + 1 == max_depth {
            (true, elastic_budget)
        } else if has_asm {
            // Penetration: force recurse even past max_depth for asmdef boundaries
            (true, elastic_budget)
        } else if elastic_budget > 0 {
            // Elastic depth: use one unit of budget
            (true, elastic_budget - 1)
        } else {
            (false, 0)
        };

        if !can_recurse {
            // Just show the directory name
            tree.push_str(&format!("{}{}/\n", prefix, sub_name));
            has_content = true;
            continue;
        }

        // Build subtree into a temp buffer to decide whether to show it
        let mut sub_tree = String::new();
        let sub_has_content = build_skeleton_tree(
            &sub_path,
            current_depth + 1,
            max_depth,
            new_elastic,
            &mut sub_tree,
        );

        if sub_has_content {
            tree.push_str(&format!("{}{}/\n", prefix, sub_name));
            tree.push_str(&sub_tree);
            has_content = true;
        } else if has_asm {
            // Even with no whitelist content, show dirs that contain asmdef boundaries
            tree.push_str(&format!("{}{}/\n", prefix, sub_name));
            has_content = true;
        } else {
            // Elastic depth: this dir had no whitelist content at current level.
            // Grant extra budget to probe deeper.
            if elastic_budget < 2 {
                let mut probe_tree = String::new();
                let probe_has = build_skeleton_tree(
                    &sub_path,
                    current_depth + 1,
                    max_depth,
                    elastic_budget + 1,
                    &mut probe_tree,
                );
                if probe_has {
                    tree.push_str(&format!("{}{}/\n", prefix, sub_name));
                    tree.push_str(&probe_tree);
                    has_content = true;
                }
            } else {
                // Already maxed out elastic budget — just show the dir
                tree.push_str(&format!("{}{}/\n", prefix, sub_name));
                has_content = true;
            }
        }
    }

    has_content
}

/// Check whether a directory (or its descendants up to `probe_depth` levels)
/// contains any `.asmdef` or `.asmref` files.
fn directory_contains_asmdef(dir: &Path, current: usize, probe_depth: usize) -> bool {
    if current > probe_depth {
        return false;
    }
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return false,
    };
    for entry in entries.filter_map(|e| e.ok()) {
        let name = entry.file_name().to_string_lossy().to_string();
        if SKELETON_IGNORED_DIRS.contains(&name.as_str()) || name == ".DS_Store" {
            continue;
        }
        let path = entry.path();
        if path.is_dir() {
            if directory_contains_asmdef(&path, current + 1, probe_depth) {
                return true;
            }
        } else if name.ends_with(".asmdef") || name.ends_with(".asmref") {
            return true;
        }
    }
    false
}

#[tauri::command]
fn get_project_skeleton(
    state: State<WorkspaceState>,
    depth: Option<serde_json::Value>,
    workspace: Option<String>,
) -> Result<String, String> {
    let workspace = resolve_workspace_root(&state, workspace)?;
    let max_depth = match depth {
        Some(serde_json::Value::Number(n)) => n.as_u64().map(|v| v as usize).unwrap_or(4),
        Some(serde_json::Value::String(s)) => s.parse::<usize>().unwrap_or(4),
        _ => 4,
    };
    let mut tree = String::new();

    build_skeleton_tree(&workspace, 0, max_depth, 0, &mut tree);

    // Safety: Prevent insane out-of-control project trees from blowing up token count
    if tree.len() > 32000 {
        tree.truncate(32000);
        tree.push_str("... (Project tree too large, truncated)\n");
    }

    if tree.is_empty() {
        return Ok("项目当前为空或目录受限。".to_string());
    }

    Ok(tree)
}

#[tauri::command]
fn glob_search(
    state: State<WorkspaceState>,
    pattern: String,
    workspace: Option<String>,
) -> Result<Vec<String>, String> {
    validate_glob_pattern(&pattern)?;
    let workspace = resolve_workspace_root(&state, workspace)?;
    let full_pattern = workspace.join(pattern).to_string_lossy().to_string();
    let mut hits = Vec::new();

    for entry in glob(&full_pattern).map_err(|e| format!("glob 模式错误: {e}"))? {
        if let Ok(path) = entry {
            let canonical = match path.canonicalize() {
                Ok(p) => p,
                Err(_) => continue,
            };
            if !canonical.starts_with(&workspace) {
                continue;
            }
            let relative = canonical
                .strip_prefix(&workspace)
                .unwrap_or(&canonical)
                .to_string_lossy()
                .to_string();
            hits.push(relative);
        }
    }

    hits.sort();
    hits.dedup();
    Ok(hits)
}

#[tauri::command]
fn grep_search(
    state: State<WorkspaceState>,
    query: String,
    path: String,
    workspace: Option<String>,
) -> Result<String, String> {
    let regex = Regex::new(&query).map_err(|e| format!("无效正则表达式: {e}"))?;
    let workspace = resolve_workspace_root(&state, workspace)?;
    let target = resolve_existing_path(&path, &workspace)?;

    let mut output = String::new();
    let mut matched = 0_usize;

    if target.is_file() {
        grep_file(&workspace, &target, &regex, &mut output, &mut matched)?;
    } else if target.is_dir() {
        for entry in WalkDir::new(&target)
            .follow_links(false)
            .into_iter()
            .filter_entry(|entry| {
                if entry.depth() == 0 || !entry.file_type().is_dir() {
                    return true;
                }
                let name = entry.file_name().to_string_lossy();
                !should_skip_recursive_search_dir(name.as_ref())
            })
        {
            let entry = match entry {
                Ok(v) => v,
                Err(_) => continue,
            };
            let file_path = entry.path();
            if !entry.file_type().is_file() || is_probably_binary(file_path) {
                continue;
            }
            // Skip macOS system junk files
            if file_path.file_name().map_or(false, |n| n == ".DS_Store") {
                continue;
            }

            let _ = grep_file(&workspace, file_path, &regex, &mut output, &mut matched);
            if matched >= GREP_MATCH_LIMIT || output.len() >= GREP_OUTPUT_LIMIT_BYTES {
                break;
            }
        }
    } else {
        return Err("grep_search 目标路径无效".to_string());
    }

    Ok(output)
}

#[tauri::command]
fn spawn_pty(
    app: AppHandle,
    state: State<PtyManager>,
    workspace_state: State<WorkspaceState>,
    cols: u16,
    rows: u16,
    session_key: Option<String>,
    workspace: Option<String>,
) -> Result<(), String> {
    let mut guard = state
        .sessions
        .lock()
        .map_err(|_| "无法获取 PTY 会话锁".to_string())?;
    let key = normalize_pty_session_key(session_key);

    if let Some(mut existing) = guard.remove(&key) {
        existing.shutdown();
    }

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("创建 PTY 失败: {e}"))?;

    let shell = default_shell();
    let mut cmd = CommandBuilder::new(&shell);
    if cfg!(target_os = "windows") {
        cmd.args(["/K", "chcp 65001>nul"]);
    }
    apply_pty_terminal_env(&mut cmd);
    let root = resolve_workspace_root(&workspace_state, workspace)?;
    cmd.cwd(root);
    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("启动 PTY 进程失败: {e}"))?;
    drop(pair.slave);

    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("创建 PTY Reader 失败: {e}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("创建 PTY Writer 失败: {e}"))?;

    let shared_buffer = Arc::new(Mutex::new(PtyBuffer::default()));
    let shared_writer = Arc::new(Mutex::new(writer));
    start_pty_reader_thread(reader, Arc::clone(&shared_buffer), app, key.clone());

    guard.insert(key, PtySession {
        master: pair.master,
        writer: shared_writer,
        buffer: shared_buffer,
        child,
    });

    Ok(())
}

#[tauri::command]
fn resize_pty(state: State<PtyManager>, cols: u16, rows: u16, session_key: Option<String>) -> Result<(), String> {
    let guard = state
        .sessions
        .lock()
        .map_err(|_| "无法获取 PTY 会话锁".to_string())?;
    let key = normalize_pty_session_key(session_key);
    let session = guard
        .get(&key)
        .ok_or_else(|| "PTY 尚未启动，请先调用 spawn_pty".to_string())?;
    session
        .master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("调整 PTY 尺寸失败: {e}"))
}

#[tauri::command]
fn write_pty(state: State<PtyManager>, input: String, session_key: Option<String>) -> Result<(), String> {
    let guard = state
        .sessions
        .lock()
        .map_err(|_| "无法获取 PTY 会话锁".to_string())?;
    let key = normalize_pty_session_key(session_key);
    let session = guard
        .get(&key)
        .ok_or_else(|| "PTY 尚未启动，请先调用 spawn_pty".to_string())?;
    let mut writer = session
        .writer
        .lock()
        .map_err(|_| "无法写入 PTY：writer 锁已损坏".to_string())?;
    writer
        .write_all(input.as_bytes())
        .map_err(|e| format!("写入 PTY 失败: {e}"))?;
    writer.flush().map_err(|e| format!("刷新 PTY 失败: {e}"))
}

#[tauri::command]
fn read_pty_buffer(
    state: State<PtyManager>,
    max_chars: Option<usize>,
    session_key: Option<String>,
) -> Result<String, String> {
    let guard = state
        .sessions
        .lock()
        .map_err(|_| "无法获取 PTY 会话锁".to_string())?;
    let key = normalize_pty_session_key(session_key);
    let session = guard
        .get(&key)
        .ok_or_else(|| "PTY 尚未启动，请先调用 spawn_pty".to_string())?;
    let buffer = session
        .buffer
        .lock()
        .map_err(|_| "无法读取 PTY 缓冲区：buffer 锁已损坏".to_string())?;
    let result = buffer.read_all(max_chars);
    if result.truncated {
        Ok(format!(
            "[terminal output truncated; buffer offsets {}..{}]\n{}",
            result.start_offset, result.end_offset, result.text
        ))
    } else {
        Ok(result.text)
    }
}

#[tauri::command]
fn read_pty_tail(
    state: State<PtyManager>,
    max_chars: Option<usize>,
    session_key: Option<String>,
) -> Result<PtyReadResult, String> {
    let guard = state
        .sessions
        .lock()
        .map_err(|_| "无法获取 PTY 会话锁".to_string())?;
    let key = normalize_pty_session_key(session_key);
    let session = guard
        .get(&key)
        .ok_or_else(|| "PTY 尚未启动，请先调用 spawn_pty".to_string())?;
    let buffer = session
        .buffer
        .lock()
        .map_err(|_| "无法读取 PTY 缓冲区：buffer 锁已损坏".to_string())?;
    Ok(buffer.read_tail(max_chars))
}

#[tauri::command]
fn read_pty_since(
    state: State<PtyManager>,
    offset: u64,
    max_chars: Option<usize>,
    session_key: Option<String>,
) -> Result<PtyReadResult, String> {
    let guard = state
        .sessions
        .lock()
        .map_err(|_| "无法获取 PTY 会话锁".to_string())?;
    let key = normalize_pty_session_key(session_key);
    let session = guard
        .get(&key)
        .ok_or_else(|| "PTY 尚未启动，请先调用 spawn_pty".to_string())?;
    let buffer = session
        .buffer
        .lock()
        .map_err(|_| "无法读取 PTY 缓冲区：buffer 锁已损坏".to_string())?;
    Ok(buffer.read_since(offset, max_chars))
}

#[tauri::command]
fn clear_pty_buffer(state: State<PtyManager>, session_key: Option<String>) -> Result<PtyReadResult, String> {
    let guard = state
        .sessions
        .lock()
        .map_err(|_| "无法获取 PTY 会话锁".to_string())?;
    let key = normalize_pty_session_key(session_key);
    let session = guard
        .get(&key)
        .ok_or_else(|| "PTY 尚未启动，请先调用 spawn_pty".to_string())?;
    let mut buffer = session
        .buffer
        .lock()
        .map_err(|_| "无法清空 PTY 缓冲区：buffer 锁已损坏".to_string())?;
    let had_content = !buffer.bytes.is_empty();
    buffer.clear();
    Ok(PtyReadResult {
        text: String::new(),
        start_offset: buffer.start_offset,
        end_offset: buffer.end_offset(),
        truncated: had_content,
        buffer_start_offset: buffer.start_offset,
        buffer_end_offset: buffer.end_offset(),
    })
}

#[tauri::command]
fn get_pty_status(state: State<PtyManager>, session_key: Option<String>) -> Result<PtyStatus, String> {
    let mut guard = state
        .sessions
        .lock()
        .map_err(|_| "无法获取 PTY 会话锁".to_string())?;
    let key = normalize_pty_session_key(session_key);

    let Some(session) = guard.get_mut(&key) else {
        return Ok(PtyStatus {
            active: false,
            running: false,
            pid: None,
            exit_code: None,
            buffer_start_offset: 0,
            buffer_end_offset: 0,
            buffer_bytes: 0,
            tail: String::new(),
        });
    };

    let status = session
        .child
        .try_wait()
        .map_err(|e| format!("检查 PTY 进程状态失败: {e}"))?;
    let running = status.is_none();
    let exit_code = status.map(|s| s.exit_code() as i32);
    let pid = session.child.process_id();
    let buffer = session
        .buffer
        .lock()
        .map_err(|_| "无法读取 PTY 缓冲区：buffer 锁已损坏".to_string())?;
    let tail = buffer.read_tail(Some(2_000)).text;

    Ok(PtyStatus {
        active: true,
        running,
        pid,
        exit_code,
        buffer_start_offset: buffer.start_offset,
        buffer_end_offset: buffer.end_offset(),
        buffer_bytes: buffer.bytes.len(),
        tail,
    })
}

#[tauri::command]
fn run_command(
    state: State<WorkspaceState>,
    command: String,
    input: Option<String>,
    timeout_ms: Option<u64>,
    workspace: Option<String>,
) -> Result<TerminalCommandOutput, String> {
    let workspace = resolve_workspace_root(&state, workspace)?;
    let timeout = Duration::from_millis(timeout_ms.unwrap_or(60_000).clamp(100, 600_000));
    run_workspace_shell_command(&workspace, command, input, timeout)
}

#[tauri::command]
fn get_system_memory() -> Result<serde_json::Value, String> {
    use sysinfo::System;
    let mut sys = System::new();
    sys.refresh_memory();
    Ok(serde_json::json!({
        "total_gb": (sys.total_memory() as f64 / 1073741824.0 * 10.0).round() / 10.0,
        "available_gb": (sys.available_memory() as f64 / 1073741824.0 * 10.0).round() / 10.0,
        "total_bytes": sys.total_memory(),
        "available_bytes": sys.available_memory(),
    }))
}

#[tauri::command]
fn count_tokens(text: String) -> Result<usize, String> {
    let tokenizer = get_tokenizer()?;
    Ok(tokenizer.encode_with_special_tokens(&text).len())
}

/// Proxy an HTTP request through the Rust backend (bypasses WebView CORS).
/// Uses async reqwest with a timeout — prevents UI freeze during model discovery.
static PROXY_REQUEST_CANCEL: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
static PROXY_REQUEST_ABORT: std::sync::Mutex<Option<futures_util::future::AbortHandle>> = std::sync::Mutex::new(None);

fn set_proxy_abort_handle(handle: Option<futures_util::future::AbortHandle>) {
    if let Ok(mut slot) = PROXY_REQUEST_ABORT.lock() {
        *slot = handle;
    }
}

#[tauri::command]
async fn proxy_request(app: AppHandle, url: String, method: String, headers: Option<std::collections::HashMap<String, String>>, body: Option<String>) -> Result<String, String> {
    PROXY_REQUEST_CANCEL.store(false, std::sync::atomic::Ordering::Relaxed);
    let meth = method.to_uppercase();
    let body_for_debug = body.clone();
    let request_started_at = std::time::Instant::now();

    let is_model_request = url.contains("/v1/chat/completions") || url.contains("/v1/responses") || url.contains("/v1/messages");
    let request_timeout_secs = if meth == "POST" && is_model_request {
        MODEL_REQUEST_TIMEOUT_SECS
    } else {
        HTTP_SHORT_TIMEOUT_SECS
    };

    let mut client_builder = reqwest::Client::builder()
        .timeout(Duration::from_secs(request_timeout_secs))
        .read_timeout(Duration::from_secs(STREAM_READ_TIMEOUT_SECS))
        .connect_timeout(Duration::from_secs(HTTP_CONNECT_TIMEOUT_SECS));
    if is_model_request {
        client_builder = client_builder.http1_only();
    }
    let client = client_builder
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {e}"))?;

    let mut req = match meth.as_str() {
        "GET" => client.get(&url),
        "POST" => client.post(&url),
        _ => return Err(format!("Unsupported HTTP method: {meth}")),
    };

    req = req.header("Content-Type", "application/json");
    if is_model_request {
        req = req.header("Accept-Encoding", "identity");
    }

    if let Some(hdrs) = &headers {
        for (key, value) in hdrs {
            req = req.header(key.as_str(), value.as_str());
        }
    }

    if url.contains("/v1/chat/completions") || url.contains("/v1/responses") || url.contains("/v1/messages") {
        let mut debug_parts = vec![
            format!("method={meth}"),
            format!("url={url}"),
        ];

        if let Some(body_str) = &body_for_debug {
            if let Ok(json) = serde_json::from_str::<Value>(body_str) {
                if let Some(model) = json.get("model").and_then(Value::as_str) {
                    debug_parts.push(format!("model={model}"));
                }
                if let Some(stream) = json.get("stream").and_then(Value::as_bool) {
                    debug_parts.push(format!("stream={stream}"));
                }
                if let Some(store) = json.get("store").and_then(Value::as_bool) {
                    debug_parts.push(format!("store={store}"));
                }
                if let Some(input) = json.get("input").and_then(Value::as_array) {
                    debug_parts.push(format!("input_len={}", input.len()));
                    if let Some(first) = input.first() {
                        if let Some(role) = first.get("role").and_then(Value::as_str) {
                            debug_parts.push(format!("first_input_role={role}"));
                        }
                        if let Some(content) = first.get("content").and_then(Value::as_array) {
                            debug_parts.push(format!("first_input_content_parts={}", content.len()));
                        } else if first.get("content").is_some() {
                            debug_parts.push("first_input_content=scalar".to_string());
                        }
                    }
                }
                if let Some(messages) = json.get("messages").and_then(Value::as_array) {
                    debug_parts.push(format!("messages_len={}", messages.len()));
                    if let Some(first) = messages.first() {
                        if let Some(role) = first.get("role").and_then(Value::as_str) {
                            debug_parts.push(format!("first_message_role={role}"));
                        }
                    }
                }
                if let Some(instructions) = json.get("instructions").and_then(Value::as_str) {
                    debug_parts.push(format!("instructions_len={}", instructions.len()));
                }
                if let Some(reasoning_effort) = json
                    .get("reasoning")
                    .and_then(Value::as_object)
                    .and_then(|reasoning| reasoning.get("effort"))
                    .and_then(Value::as_str)
                {
                    debug_parts.push(format!("reasoning_effort={reasoning_effort}"));
                }
            } else {
                debug_parts.push(format!("body_chars={}", body_str.len()));
            }
        } else {
            debug_parts.push("body=<none>".to_string());
        }

        record_debug_log(&app, "info", "proxy_request", debug_parts.join(" "));
    }

    let req = if let Some(body_str) = body {
        req.body(body_str)
    } else {
        req
    };

    let (abort_handle, abort_registration) = futures_util::future::AbortHandle::new_pair();
    set_proxy_abort_handle(Some(abort_handle));

    let response = match futures_util::future::Abortable::new(req.send(), abort_registration).await {
        Err(_) => {
            set_proxy_abort_handle(None);
            return Err("Aborted".to_string());
        }
        Ok(response) => response,
    };
    set_proxy_abort_handle(None);

    let response = match response {
        Ok(response) => response,
        Err(e) => {
            set_proxy_abort_handle(None);
            if PROXY_REQUEST_CANCEL.load(std::sync::atomic::Ordering::Relaxed) {
                return Err("Aborted".to_string());
            }
            let msg = e.to_string();
            let should_retry_transport = should_try_curl_transport_fallback(&url, &meth, &msg);
            if is_model_request {
                record_debug_log(
                    &app,
                    if should_retry_transport { "warn" } else { "error" },
                    "proxy_request",
                    if should_retry_transport {
                        format!("primary_transport_failed url={} err={} trying_curl_fallback=true", url, msg)
                    } else {
                        format!("request_failed url={} err={}", url, msg)
                    },
                );
            }

            if should_retry_transport {
                record_debug_log(&app, "warn", "proxy_request", format!("primary failed, trying curl fallback: {}", url));
                match proxy_request_via_curl(&url, &meth, headers.as_ref(), body_for_debug.as_deref()) {
                    Ok(result) => {
                        record_debug_log(&app, "info", "proxy_request", format!("recovered_by=curl url={} elapsed_ms={}", url, request_started_at.elapsed().as_millis()));
                        return Ok(result);
                    }
                    Err(curl_err) => {
                        record_debug_log(&app, "error", "proxy_request", format!("curl fallback failed after transport error url={} primary_err={} curl_err={}", url, msg, curl_err));
                    }
                }
            }

            return Err(if msg.contains("dns") || msg.contains("resolve") {
                format!("DNS 解析失败，请检查地址是否正确: {msg}")
            } else if msg.contains("Connection refused") || msg.contains("connect") {
                format!("连接被拒绝，请确认服务正在运行: {msg}")
            } else if msg.contains("timed out") || msg.contains("timeout") {
                format!("连接超时，请检查网络或服务状态: {msg}")
            } else if msg.contains("tls") || msg.contains("certificate") {
                format!("TLS/SSL 错误: {msg}")
            } else {
                format!("请求失败: {msg}")
            });
        }
    };

    let status = response.status();
    if !status.is_success() {
        let error_body = response.text().await.unwrap_or_default();
        let should_retry_via_curl = should_use_curl_fallback(&url, &meth, status, &error_body);
        if is_model_request {
            let error_excerpt = error_body.chars().take(240).collect::<String>();
            record_debug_log(
                &app,
                if should_retry_via_curl { "warn" } else { "error" },
                "proxy_request",
                if should_retry_via_curl {
                    format!(
                        "primary_status_failed status={} url={} body={} trying_curl_fallback=true",
                        status,
                        url,
                        error_excerpt,
                    )
                } else {
                    format!(
                        "error status={} url={} body={}",
                        status,
                        url,
                        error_excerpt,
                    )
                },
            );
        }

        if is_model_request {
            record_debug_log(
                &app,
                "info",
                "proxy_request",
                format!(
                    "fallback_decision status={} url={} use_curl={}",
                    status,
                    url,
                    should_retry_via_curl,
                ),
            );
        }

        if should_retry_via_curl {
            record_debug_log(&app, "warn", "proxy_request", format!("primary failed, trying curl fallback: {}", url));
            match proxy_request_via_curl(&url, &meth, headers.as_ref(), body_for_debug.as_deref()) {
                Ok(result) => {
                    record_debug_log(&app, "info", "proxy_request", format!("recovered_by=curl status={} url={} elapsed_ms={}", status, url, request_started_at.elapsed().as_millis()));
                    return Ok(result);
                }
                Err(curl_err) => {
                    record_debug_log(
                        &app,
                        "error",
                        "proxy_request",
                        format!(
                            "curl fallback failed after status error status={} url={} body={} curl_err={}",
                            status,
                            url,
                            error_body.chars().take(240).collect::<String>(),
                            curl_err,
                        ),
                    );
                }
            }
        }

        return Err(format!("HTTP {}: {}", status, error_body.chars().take(500).collect::<String>()));
    }

    if PROXY_REQUEST_CANCEL.load(std::sync::atomic::Ordering::Relaxed) {
        return Err("Aborted".to_string());
    }
    let (text_abort_handle, text_abort_registration) = futures_util::future::AbortHandle::new_pair();
    set_proxy_abort_handle(Some(text_abort_handle));
    let text_result = match futures_util::future::Abortable::new(response.text(), text_abort_registration).await {
        Err(_) => {
            set_proxy_abort_handle(None);
            return Err("Aborted".to_string());
        }
        Ok(result) => result,
    };
    set_proxy_abort_handle(None);

    let text = match text_result {
        Ok(text) => text,
        Err(e) => {
            if PROXY_REQUEST_CANCEL.load(std::sync::atomic::Ordering::Relaxed) {
                return Err("Aborted".to_string());
            }
            let msg = e.to_string();
            let should_retry_read = should_try_curl_transport_fallback(&url, &meth, &msg);
            if is_model_request {
                record_debug_log(
                    &app,
                    if should_retry_read { "warn" } else { "error" },
                    "proxy_request",
                    if should_retry_read {
                        format!("primary_read_failed url={} err={} trying_curl_fallback=true", url, msg)
                    } else {
                        format!("read_failed url={} err={}", url, msg)
                    },
                );
            }
            if should_retry_read {
                record_debug_log(&app, "warn", "proxy_request", format!("primary failed, trying curl fallback: {}", url));
                match proxy_request_via_curl(&url, &meth, headers.as_ref(), body_for_debug.as_deref()) {
                    Ok(result) => {
                        record_debug_log(&app, "info", "proxy_request", format!("recovered_by=curl url={} elapsed_ms={}", url, request_started_at.elapsed().as_millis()));
                        return Ok(result);
                    }
                    Err(curl_err) => {
                        record_debug_log(&app, "error", "proxy_request", format!("curl fallback failed after read error url={} primary_err={} curl_err={}", url, msg, curl_err));
                    }
                }
            }
            return Err(format!("读取响应失败: {msg}"));
        }
    };
    if url.contains("/v1/chat/completions") || url.contains("/v1/responses") || url.contains("/v1/messages") {
        record_debug_log(&app, "info", "proxy_request", format!("success status={} url={} elapsed_ms={}", status, url, request_started_at.elapsed().as_millis()));
    }
    Ok(text)
}

#[tauri::command]
fn cancel_proxy_request() -> Result<(), String> {
    PROXY_REQUEST_CANCEL.store(true, std::sync::atomic::Ordering::Relaxed);
    if let Ok(mut slot) = PROXY_REQUEST_ABORT.lock() {
        if let Some(handle) = slot.take() {
            handle.abort();
        }
    }
    Ok(())
}

// endregion

// region: 流式聊天代理 (Cloud SSE Proxy)

/// Global cancellation token for the active chat stream.
static STREAM_CANCEL: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
static STREAM_ABORT: std::sync::Mutex<Option<futures_util::future::AbortHandle>> = std::sync::Mutex::new(None);

fn set_stream_abort_handle(handle: Option<futures_util::future::AbortHandle>) {
    if let Ok(mut slot) = STREAM_ABORT.lock() {
        *slot = handle;
    }
}

fn abort_active_stream_request() {
    if let Ok(mut slot) = STREAM_ABORT.lock() {
        if let Some(handle) = slot.take() {
            handle.abort();
        }
    }
}

fn emit_chat_stream_done(app: &AppHandle, stream_id: &str, status: &str, error: Option<String>) {
    let _ = app.emit(
        "chat-stream-done",
        StreamDonePayload {
            stream_id: stream_id.to_string(),
            status: status.to_string(),
            error,
        },
    );
}

#[derive(Clone, Serialize)]
struct StreamChunkPayload {
    stream_id: String,
    chunk: String,
}

#[derive(Clone, Serialize)]
struct StreamDonePayload {
    stream_id: String,
    status: String, // "ok" | "error"
    error: Option<String>,
}

/// Start a streaming chat completion request through Rust (bypasses CORS).
/// Chunks are emitted as Tauri events `chat-stream-chunk`.
/// When done, emits `chat-stream-done`.
#[tauri::command]
async fn start_chat_stream(
    app: AppHandle,
    stream_id: String,
    url: String,
    headers: std::collections::HashMap<String, String>,
    body: String,
) -> Result<(), String> {
    STREAM_CANCEL.store(false, std::sync::atomic::Ordering::Relaxed);
    set_stream_abort_handle(None);
    let stream_started_at = Instant::now();

    let is_model_request = url.contains("/v1/chat/completions") || url.contains("/v1/responses") || url.contains("/v1/messages");

    if is_model_request {
        let mut debug_parts = vec![format!("method=POST"), format!("url={}", url)];
        if let Ok(body_json) = serde_json::from_str::<Value>(&body) {
            if let Some(model) = body_json.get("model").and_then(|v| v.as_str()) {
                debug_parts.push(format!("model={}", model));
            }
            if let Some(messages) = body_json.get("messages").and_then(|v| v.as_array()) {
                debug_parts.push(format!("messages_len={}", messages.len()));
                if let Some(role) = messages
                    .first()
                    .and_then(|v| v.get("role"))
                    .and_then(|v| v.as_str())
                {
                    debug_parts.push(format!("first_message_role={}", role));
                }
            }
            if let Some(stream) = body_json.get("stream").and_then(|v| v.as_bool()) {
                debug_parts.push(format!("stream={}", stream));
            }
        }
        record_debug_log(&app, "info", "start_chat_stream", debug_parts.join(" "));
    }

    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(HTTP_CONNECT_TIMEOUT_SECS))
        // Do not set a total timeout for streaming model output: large code
        // generations can legitimately run for more than five minutes.
        .read_timeout(Duration::from_secs(STREAM_READ_TIMEOUT_SECS))
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {e}"))?;
    let mut req_builder = client
        .post(&url)
        .header("Content-Type", "application/json");
    if is_model_request {
        req_builder = req_builder.header("Accept-Encoding", "identity");
    }

    for (key, value) in &headers {
        req_builder = req_builder.header(key.as_str(), value.as_str());
    }

    req_builder = req_builder.body(body);

    let (send_abort_handle, send_abort_registration) = futures_util::future::AbortHandle::new_pair();
    set_stream_abort_handle(Some(send_abort_handle));
    let response_result = match tokio::time::timeout(
        Duration::from_secs(STREAM_FIRST_RESPONSE_TIMEOUT_SECS),
        futures_util::future::Abortable::new(req_builder.send(), send_abort_registration),
    )
    .await
    {
        Err(_) => {
            abort_active_stream_request();
            STREAM_CANCEL.store(true, std::sync::atomic::Ordering::Relaxed);
            record_debug_log(
                &app,
                "warn",
                "stream_first_chunk_timeout",
                format!(
                    "phase=response_headers url={} timeout_secs={} elapsed_ms={}",
                    url,
                    STREAM_FIRST_RESPONSE_TIMEOUT_SECS,
                    stream_started_at.elapsed().as_millis(),
                ),
            );
            record_debug_log(
                &app,
                "info",
                "stream_cancelled_by_watchdog",
                format!("phase=response_headers url={}", url),
            );
            emit_chat_stream_done(
                &app,
                &stream_id,
                "error",
                Some(format!(
                    "STREAM_FIRST_CHUNK_TIMEOUT: 模型在 {} 秒内没有返回响应头，本轮已暂停。",
                    STREAM_FIRST_RESPONSE_TIMEOUT_SECS,
                )),
            );
            return Ok(());
        }
        Ok(Err(_)) => {
            set_stream_abort_handle(None);
            record_debug_log(
                &app,
                "info",
                "start_chat_stream",
                format!(
                    "cancelled_before_response url={} elapsed_ms={}",
                    url,
                    stream_started_at.elapsed().as_millis(),
                ),
            );
            emit_chat_stream_done(&app, &stream_id, "cancelled", None);
            return Ok(());
        }
        Ok(Ok(result)) => {
            set_stream_abort_handle(None);
            result
        }
    };

    let response = response_result.map_err(|e| {
            record_debug_log(&app, "error", "start_chat_stream", format!("request_failed url={} err={}", url, e));
            format!("请求失败: {e}")
        })?;

    if !response.status().is_success() {
        let status = response.status();
        let error_body = response.text().await.unwrap_or_default();
        if is_model_request {
            record_debug_log(
                &app,
                "error",
                "start_chat_stream",
                format!(
                    "error status={} url={} body={}",
                    status,
                    url,
                    error_body.chars().take(240).collect::<String>(),
                ),
            );
        }
        return Err(format!("HTTP {}: {}", status, error_body.chars().take(500).collect::<String>()));
    }

    let mut stream = response.bytes_stream();
    use futures_util::StreamExt;

    // Buffer for incomplete UTF-8 tail bytes that straddle chunk boundaries.
    // Without this, multi-byte CJK characters get mangled by from_utf8_lossy.
    let mut utf8_tail: Vec<u8> = Vec::new();
    let mut chunk_count: usize = 0;
    let mut byte_count: usize = 0;

    loop {
        let (chunk_abort_handle, chunk_abort_registration) = futures_util::future::AbortHandle::new_pair();
        set_stream_abort_handle(Some(chunk_abort_handle));
        let next_chunk = if chunk_count == 0 {
            match tokio::time::timeout(
                Duration::from_secs(STREAM_FIRST_CHUNK_TIMEOUT_SECS),
                futures_util::future::Abortable::new(stream.next(), chunk_abort_registration),
            )
            .await
            {
                Err(_) => {
                    abort_active_stream_request();
                    STREAM_CANCEL.store(true, std::sync::atomic::Ordering::Relaxed);
                    record_debug_log(
                        &app,
                        "warn",
                        "stream_first_chunk_timeout",
                        format!(
                            "phase=first_chunk url={} timeout_secs={} elapsed_ms={}",
                            url,
                            STREAM_FIRST_CHUNK_TIMEOUT_SECS,
                            stream_started_at.elapsed().as_millis(),
                        ),
                    );
                    record_debug_log(
                        &app,
                        "info",
                        "stream_cancelled_by_watchdog",
                        format!("phase=first_chunk url={}", url),
                    );
                    emit_chat_stream_done(
                        &app,
                        &stream_id,
                        "error",
                        Some(format!(
                            "STREAM_FIRST_CHUNK_TIMEOUT: 模型在 {} 秒内没有返回首个流式 chunk，本轮已暂停。",
                            STREAM_FIRST_CHUNK_TIMEOUT_SECS,
                        )),
                    );
                    return Ok(());
                }
                Ok(Err(_)) => {
                    set_stream_abort_handle(None);
                    record_debug_log(
                        &app,
                        "info",
                        "start_chat_stream",
                        format!(
                            "cancelled_waiting_for_first_chunk url={} elapsed_ms={}",
                            url,
                            stream_started_at.elapsed().as_millis(),
                        ),
                    );
                    emit_chat_stream_done(&app, &stream_id, "cancelled", None);
                    return Ok(());
                }
                Ok(Ok(item)) => {
                    set_stream_abort_handle(None);
                    item
                }
            }
        } else {
            match futures_util::future::Abortable::new(stream.next(), chunk_abort_registration).await {
                Err(_) => {
                    set_stream_abort_handle(None);
                    record_debug_log(
                        &app,
                        "info",
                        "start_chat_stream",
                        format!(
                            "cancelled url={} chunks={} bytes={} elapsed_ms={}",
                            url,
                            chunk_count,
                            byte_count,
                            stream_started_at.elapsed().as_millis(),
                        ),
                    );
                    emit_chat_stream_done(&app, &stream_id, "cancelled", None);
                    return Ok(());
                }
                Ok(item) => {
                    set_stream_abort_handle(None);
                    item
                }
            }
        };

        let Some(chunk_result) = next_chunk else {
            break;
        };

        if STREAM_CANCEL.load(std::sync::atomic::Ordering::Relaxed) {
            record_debug_log(
                &app,
                "info",
                "start_chat_stream",
                format!("cancelled url={} chunks={} bytes={} elapsed_ms={}", url, chunk_count, byte_count, stream_started_at.elapsed().as_millis()),
            );
            emit_chat_stream_done(&app, &stream_id, "cancelled", None);
            return Ok(());
        }

        match chunk_result {
            Ok(bytes) => {
                if chunk_count == 0 {
                    record_debug_log(
                        &app,
                        "info",
                        "start_chat_stream",
                        format!(
                            "first_chunk url={} bytes={} elapsed_ms={}",
                            url,
                            bytes.len(),
                            stream_started_at.elapsed().as_millis(),
                        ),
                    );
                }
                chunk_count += 1;
                byte_count += bytes.len();

                // Prepend any leftover bytes from the previous chunk
                let mut combined = Vec::with_capacity(utf8_tail.len() + bytes.len());
                combined.extend_from_slice(&utf8_tail);
                utf8_tail.clear();
                combined.extend_from_slice(&bytes);

                // Find the longest valid UTF-8 prefix; trailing incomplete
                // bytes are saved for the next chunk.
                let text = match std::str::from_utf8(&combined) {
                    Ok(s) => s.to_string(),
                    Err(e) => {
                        let valid_up_to = e.valid_up_to();
                        if valid_up_to == 0 {
                            // No valid bytes yet — keep buffering
                            utf8_tail = combined;
                            continue;
                        }
                        // Save the incomplete tail for the next iteration
                        utf8_tail = combined[valid_up_to..].to_vec();
                        std::str::from_utf8(&combined[..valid_up_to])
                            .unwrap_or("")
                            .to_string()
                    }
                };

                if !text.is_empty() {
                    let _ = app.emit(
                        "chat-stream-chunk",
                        StreamChunkPayload {
                            stream_id: stream_id.clone(),
                            chunk: text,
                        },
                    );
                }
            }
            Err(e) => {
                record_debug_log(
                    &app,
                    "error",
                    "start_chat_stream",
                    format!("read_error url={} chunks={} bytes={} elapsed_ms={} err={}", url, chunk_count, byte_count, stream_started_at.elapsed().as_millis(), e),
                );
                emit_chat_stream_done(&app, &stream_id, "error", Some(format!("流读取错误: {e}")));
                return Ok(());
            }
        }
    }

    set_stream_abort_handle(None);
    emit_chat_stream_done(&app, &stream_id, "ok", None);

    if is_model_request {
        record_debug_log(
            &app,
            "info",
            "start_chat_stream",
            format!("success url={} chunks={} bytes={} elapsed_ms={}", url, chunk_count, byte_count, stream_started_at.elapsed().as_millis()),
        );
    }

    Ok(())
}

/// Cancel the active chat stream.
#[tauri::command]
fn cancel_chat_stream() -> Result<(), String> {
    STREAM_CANCEL.store(true, std::sync::atomic::Ordering::Relaxed);
    abort_active_stream_request();
    Ok(())
}

// endregion

// region: get_file_outline C# 符号提取

/// Lightweight regex-based C# symbol extractor.
/// Produces an "interface-first" outline: type declarations + public/protected
/// members, with method bodies stripped.
#[tauri::command]
fn get_file_outline(
    state: State<WorkspaceState>,
    path: String,
    workspace: Option<String>,
) -> Result<String, String> {
    let workspace = resolve_workspace_root(&state, workspace)?;
    let real_path = resolve_existing_path(&path, &workspace)?;

    let ext = real_path
        .extension()
        .map(|e| e.to_string_lossy().to_string())
        .unwrap_or_default()
        .to_lowercase();

    if ext != "cs" {
        return Err("get_file_outline 仅支持 .cs 文件".to_string());
    }

    let source = fs::read_to_string(&real_path)
        .map_err(|e| format!("无法读取文件: {e}"))?;

    Ok(extract_csharp_outline(&source))
}

fn extract_csharp_outline(source: &str) -> String {
    let mut outline = String::new();
    let mut brace_depth: i32 = 0;
    let mut in_type_body = false;
    let mut type_depth: i32 = -1;

    // Regex patterns (compiled lazily)
    let re_type = Regex::new(
        r"(?i)^\s*(public|protected|internal|private)?\s*(sealed|abstract|static|partial)?\s*(class|interface|enum|struct)\s+([A-Za-z_]\w*)(?:\s*<[^>]+>)?(?:\s*:\s*([^{]+))?"
    ).unwrap();

    let re_method = Regex::new(
        r"(?i)^\s*(public|protected)\s+(?:static\s+|virtual\s+|override\s+|async\s+|unsafe\s+)*(?:\w+(?:<[^>]+>)?(?:\[\])?)\s+([A-Za-z_]\w*)\s*\([^)]*\)"
    ).unwrap();

    let re_property = Regex::new(
        r"(?i)^\s*(public|protected)\s+.*\s+([A-Za-z_]\w*)\s*\{"
    ).unwrap();

    let re_enum_member = Regex::new(
        r"^\s*([A-Za-z_]\w*)\s*(?:=|,|$)"
    ).unwrap();

    let mut current_type_kind = String::new(); // "class", "interface", "enum", "struct"

    for line in source.lines() {
        let trimmed = line.trim();

        // Skip empty lines and comments
        if trimmed.is_empty() || trimmed.starts_with("//") || trimmed.starts_with("/*") {
            // Still count braces in block comments — but for simplicity, skip
            continue;
        }

        // Track brace depth
        let opens = trimmed.chars().filter(|c| *c == '{').count() as i32;
        let closes = trimmed.chars().filter(|c| *c == '}').count() as i32;

        // At depth 0: look for type declarations
        if brace_depth == 0 || (brace_depth == 1 && opens > 0 && closes == 0 && !in_type_body) {
            if let Some(caps) = re_type.captures(trimmed) {
                let access = caps.get(1).map(|m| m.as_str()).unwrap_or("internal");
                let modifier = caps.get(2).map(|m| m.as_str()).unwrap_or("");
                let kind = caps.get(3).map(|m| m.as_str()).unwrap_or("class");
                let name = caps.get(4).map(|m| m.as_str()).unwrap_or("?");
                let inherits = caps.get(5).map(|m| m.as_str().trim()).unwrap_or("");

                current_type_kind = kind.to_lowercase();

                let mod_str = if modifier.is_empty() { String::new() } else { format!("{} ", modifier) };
                let inherit_str = if inherits.is_empty() { String::new() } else { format!(" : {}", inherits) };
                outline.push_str(&format!("{} {}{}{}{}\n", access, mod_str, kind, name, inherit_str));

                type_depth = brace_depth;
                in_type_body = true;
                brace_depth += opens - closes;
                continue;
            }
        }

        brace_depth += opens - closes;

        // If we just closed a type body
        if in_type_body && brace_depth <= type_depth {
            in_type_body = false;
            current_type_kind.clear();
            outline.push('\n');
        }

        // Inside a type body at depth 1 (relative to type)
        if in_type_body && brace_depth == type_depth + 1 {
            // Enums: extract members
            if current_type_kind == "enum" {
                if let Some(caps) = re_enum_member.captures(trimmed) {
                    let member = caps.get(1).map(|m| m.as_str()).unwrap_or("");
                    if !member.is_empty() && member != "get" && member != "set" {
                        outline.push_str(&format!("  {}\n", member));
                    }
                }
                continue;
            }

            // Properties
            if let Some(caps) = re_property.captures(trimmed) {
                let access = caps.get(1).map(|m| m.as_str()).unwrap_or("public");
                let prop_name = caps.get(2).map(|m| m.as_str()).unwrap_or("?");
                // Reconstruct the type from the line
                let sig = extract_property_signature(trimmed, access, prop_name);
                outline.push_str(&format!("  {}\n", sig));
                continue;
            }

            // Methods
            if let Some(caps) = re_method.captures(trimmed) {
                let access = caps.get(1).map(|m| m.as_str()).unwrap_or("public");
                let method_name = caps.get(2).map(|m| m.as_str()).unwrap_or("?");
                // Reconstruct the full signature from the line
                let sig = extract_method_signature(trimmed, access, method_name);
                outline.push_str(&format!("  {}\n", sig));
                continue;
            }
        }
    }

    if outline.is_empty() {
        outline.push_str("(No public/protected type definitions found)\n");
    }

    outline
}

/// Extract a clean method signature from a line of C# source.
fn extract_method_signature(line: &str, access: &str, name: &str) -> String {
    // Find the parameter list
    let start = line.find(name).unwrap_or(0) + name.len();
    let rest = &line[start..];
    let paren_open = rest.find('(').unwrap_or(0);
    let mut depth = 0;
    let mut end = 0;
    for (i, c) in rest[paren_open..].char_indices() {
        match c {
            '(' => depth += 1,
            ')' => {
                depth -= 1;
                if depth == 0 {
                    end = paren_open + i + 1;
                    break;
                }
            }
            _ => {}
        }
    }
    let params = &rest[paren_open..end.min(rest.len())];

    // Collect modifiers before the return type
    let before_name = &line[..line.find(name).unwrap_or(line.len())];
    let mods: Vec<&str> = before_name
        .split_whitespace()
        .filter(|w| *w != access)
        .collect();

    let return_type_idx = mods.len().saturating_sub(1);
    let return_type = mods.get(return_type_idx).unwrap_or(&"void");
    let modifier_strs: Vec<&str> = mods.iter().filter(|w| *w != return_type).copied().collect();

    let mod_str = if modifier_strs.is_empty() {
        String::new()
    } else {
        format!("{} ", modifier_strs.join(" "))
    };

    format!("{} {}{}{}{}", access, mod_str, return_type, name, params)
}

/// Extract a clean property signature from a line of C# source.
fn extract_property_signature(line: &str, access: &str, name: &str) -> String {
    // Get the portion before the name to extract type and modifiers
    let before_name = &line[..line.find(name).unwrap_or(line.len())];
    let mods: Vec<&str> = before_name
        .split_whitespace()
        .filter(|w| *w != access)
        .collect();

    let type_name = mods.last().unwrap_or(&"object");
    let modifier_strs: Vec<&str> = mods.iter().filter(|w| *w != type_name).copied().collect();

    let mod_str = if modifier_strs.is_empty() {
        String::new()
    } else {
        format!("{} ", modifier_strs.join(" "))
    };

    // Detect get/set from remainder of line
    let after = &line[line.find(name).unwrap_or(0) + name.len()..];
    let has_get = after.contains("get");
    let has_set = after.contains("set");
    let accessors = match (has_get, has_set) {
        (true, true) => " { get; set; }",
        (true, false) => " { get; }",
        (false, true) => " { set; }",
        _ => "",
    };

    format!("{} {}{}{}{}", access, mod_str, type_name, name, accessors)
}

// endregion

// region: Protocol Package 管理

#[derive(serde::Serialize)]
pub struct ProtocolPackageMeta {
    pub name: String,
    pub entry_point: String,
    pub local_path: String,
}

/// Extract a protocol package ZIP into `.protocols/<slot>/` under the workspace.
/// Returns metadata about the extracted package.
#[tauri::command]
fn extract_protocol_package(
    state: State<WorkspaceState>,
    zip_path: String,
) -> Result<ProtocolPackageMeta, String> {
    let workspace = state.get_root()?;
    let zip = PathBuf::from(&zip_path);
    if !zip.exists() || !zip.is_file() {
        return Err("ZIP 文件不存在或不是文件".to_string());
    }

    // Read the ZIP archive
    let file = File::open(&zip).map_err(|e| format!("无法打开 ZIP 文件: {e}"))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("ZIP 解析失败: {e}"))?;

    // Derive package name from the ZIP filename (without extension)
    let package_name = zip
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "unknown-package".to_string());

    // Generate a unique slot: <name>-<timestamp>
    let slot = format!(
        "{}-{}",
        package_name,
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
    );

    let protocols_dir = workspace.join(".protocols");
    let target_dir = protocols_dir.join(&slot);

    // Create the target directory
    fs::create_dir_all(&target_dir).map_err(|e| format!("创建目录失败: {e}"))?;

    // Extract all entries
    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| format!("读取 ZIP 条目失败: {e}"))?;

        let out_path = match entry.enclosed_name() {
            Some(path) => target_dir.join(path),
            None => continue,
        };

        // Security: ensure the extracted path stays within target_dir
        let canonical_target = target_dir.canonicalize().unwrap_or_else(|_| target_dir.clone());
        if let Some(parent) = out_path.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("创建子目录失败: {e}"))?;
            // Verify the parent is within target_dir after creation
            if let Ok(canonical_parent) = parent.canonicalize() {
                if !canonical_parent.starts_with(&canonical_target) && canonical_parent != canonical_target {
                    // Parent could be the target_dir itself before canonicalization
                    let target_parent = canonical_target.parent();
                    if target_parent.is_none() || canonical_parent != *target_parent.unwrap() {
                        continue; // Skip suspicious paths (zip slip)
                    }
                }
            }
        }

        if entry.is_dir() {
            fs::create_dir_all(&out_path).map_err(|e| format!("创建目录失败: {e}"))?;
        } else {
            let mut outfile = File::create(&out_path)
                .map_err(|e| format!("创建文件失败: {e}"))?;
            std::io::copy(&mut entry, &mut outfile)
                .map_err(|e| format!("写入文件失败: {e}"))?;
        }
    }

    // Detect entry point: look for SKILL.md or program.md in the extracted root
    let entry_point = find_entry_point(&target_dir);

    // Compute the relative path from workspace
    let local_path = target_dir
        .strip_prefix(&workspace)
        .unwrap_or(&target_dir)
        .to_string_lossy()
        .to_string();

    Ok(ProtocolPackageMeta {
        name: package_name,
        entry_point,
        local_path,
    })
}

/// Find the entry point file in an extracted protocol package.
/// Looks for SKILL.md, program.md, or falls back to the first .md file found.
fn find_entry_point(dir: &Path) -> String {
    let candidates = ["SKILL.md", "program.md", "README.md"];

    // Check root level first (or first subdirectory if the ZIP had a top-level folder)
    let dirs_to_check: Vec<PathBuf> = {
        let mut dirs = vec![dir.to_path_buf()];
        // Also check immediate subdirectories (common when ZIP has a top-level folder)
        if let Ok(entries) = fs::read_dir(dir) {
            for entry in entries.flatten() {
                if entry.path().is_dir() {
                    dirs.push(entry.path());
                }
            }
        }
        dirs
    };

    for check_dir in &dirs_to_check {
        for candidate in &candidates {
            let path = check_dir.join(candidate);
            if path.exists() && path.is_file() {
                return path
                    .strip_prefix(dir)
                    .unwrap_or(&path)
                    .to_string_lossy()
                    .to_string();
            }
        }
    }

    // Fallback: find the first .md file
    for check_dir in &dirs_to_check {
        if let Ok(entries) = fs::read_dir(check_dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_file() && path.extension().map_or(false, |ext| ext == "md") {
                    return path
                        .strip_prefix(dir)
                        .unwrap_or(&path)
                        .to_string_lossy()
                        .to_string();
                }
            }
        }
    }

    "SKILL.md".to_string()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HookCommandOutput {
    stdout: String,
    stderr: String,
    exit_code: i32,
    timed_out: bool,
}

#[tauri::command]
fn run_hook_command(
    state: State<WorkspaceState>,
    command: String,
    input: Option<String>,
    timeout_ms: Option<u64>,
) -> Result<HookCommandOutput, String> {
    let workspace = state.get_root()?;
    let trimmed = command.trim();
    if trimmed.is_empty() {
        return Err("Hook 命令不能为空".to_string());
    }
    let timeout = Duration::from_millis(timeout_ms.unwrap_or(4_000).clamp(100, 60_000));
    let output = run_workspace_shell_command(&workspace, trimmed.to_string(), input, timeout)
        .map_err(|e| format!("Hook 命令执行失败: {e}"))?;

    Ok(HookCommandOutput {
        stdout: output.stdout,
        stderr: output.stderr,
        exit_code: output.exit_code,
        timed_out: output.timed_out,
    })
}

fn user_home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("USERPROFILE").map(PathBuf::from))
}

fn candidate_python_binaries() -> Vec<String> {
    let mut candidates: Vec<String> = Vec::new();

    for key in ["CODEX_PYTHON", "PYTHON_EXECUTABLE"] {
        if let Some(value) = std::env::var_os(key) {
            let candidate = PathBuf::from(value).to_string_lossy().to_string();
            if !candidate.trim().is_empty() && !candidates.contains(&candidate) {
                candidates.push(candidate);
            }
        }
    }

    if let Some(home) = user_home_dir() {
        let runtime_bin = home
            .join(".cache")
            .join("codex-runtimes")
            .join("codex-primary-runtime")
            .join("dependencies")
            .join("python")
            .join("bin");
        for name in ["python3", "python", "python3.12"] {
            let candidate = runtime_bin.join(name);
            if candidate.exists() {
                let text = candidate.to_string_lossy().to_string();
                if !candidates.contains(&text) {
                    candidates.push(text);
                }
            }
        }
    }

    for fallback in ["python3", "python"] {
        let text = fallback.to_string();
        if !candidates.contains(&text) {
            candidates.push(text);
        }
    }

    candidates
}

fn run_document_reader_with_python(
    python_bin: &str,
    workspace: &Path,
    payload: &Value,
) -> Result<Value, String> {
    let mut process = ProcessCommand::new(python_bin);
    process
        .arg("-c")
        .arg(DOCUMENT_READER_SCRIPT)
        .current_dir(workspace)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("PYTHONIOENCODING", "utf-8")
        .env("PYTHONUTF8", "1");

    let mut child = process
        .spawn()
        .map_err(|e| format!("无法启动 Python 解析器 `{python_bin}`: {e}"))?;

    if let Some(stdin) = child.stdin.as_mut() {
        let input = serde_json::to_vec(payload)
            .map_err(|e| format!("无法序列化文档读取参数: {e}"))?;
        stdin
            .write_all(&input)
            .map_err(|e| format!("无法写入文档读取请求: {e}"))?;
    }
    let _ = child.stdin.take();

    let output = child
        .wait_with_output()
        .map_err(|e| format!("等待文档解析器输出失败: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let details = if !stderr.is_empty() {
            stderr
        } else if !stdout.is_empty() {
            stdout
        } else {
            "unknown error".to_string()
        };
        return Err(format!("文档解析器执行失败: {details}"));
    }

    serde_json::from_slice(&output.stdout).map_err(|e| {
        let stdout = String::from_utf8_lossy(&output.stdout);
        format!("文档解析器返回了无效 JSON: {e}. Output: {stdout}")
    })
}

fn run_document_reader(workspace: &Path, payload: &Value) -> Result<Value, String> {
    let mut failures: Vec<String> = Vec::new();

    for python_bin in candidate_python_binaries() {
        match run_document_reader_with_python(&python_bin, workspace, payload) {
            Ok(value) => return Ok(value),
            Err(error) => failures.push(format!("{python_bin}: {error}")),
        }
    }

    Err(format!(
        "无法找到可用的文档解析 Python 运行时。已尝试: {}",
        failures.join(" | ")
    ))
}

#[tauri::command]
fn read_document(
    state: State<WorkspaceState>,
    path: String,
    max_chars: Option<usize>,
    max_blocks: Option<usize>,
    row_offset: Option<usize>,
    max_rows: Option<usize>,
    sheet: Option<String>,
    workspace: Option<String>,
) -> Result<Value, String> {
    let workspace = resolve_workspace_root(&state, workspace)?;
    let real_path = resolve_existing_path(&path, &workspace)?;
    if !real_path.is_file() {
        return Err("read_document 目标不是文件".to_string());
    }

    let payload = json!({
        "command": "read_document",
        "workspaceRoot": workspace.to_string_lossy().to_string(),
        "path": real_path.to_string_lossy().to_string(),
        "maxChars": max_chars.unwrap_or(6_000).clamp(500, 20_000),
        "maxBlocks": max_blocks.unwrap_or(24).clamp(1, 100),
        "rowOffset": row_offset.unwrap_or(0),
        "maxRows": max_rows,
        "sheet": sheet,
    });

    run_document_reader(&workspace, &payload)
}

#[tauri::command]
fn analyze_tabular_document(
    state: State<WorkspaceState>,
    path: String,
    sheet: Option<String>,
    max_columns: Option<usize>,
    sample_rows: Option<usize>,
    focus_columns: Option<String>,
    workspace: Option<String>,
) -> Result<Value, String> {
    let workspace = resolve_workspace_root(&state, workspace)?;
    let real_path = resolve_existing_path(&path, &workspace)?;
    if !real_path.is_file() {
        return Err("analyze_tabular_document 目标不是文件".to_string());
    }

    let payload = json!({
        "command": "analyze_tabular_document",
        "workspaceRoot": workspace.to_string_lossy().to_string(),
        "path": real_path.to_string_lossy().to_string(),
        "sheet": sheet,
        "maxColumns": max_columns.unwrap_or(40).clamp(1, 200),
        "sampleRows": sample_rows.unwrap_or(5).clamp(1, 20),
        "focusColumns": focus_columns,
    });

    run_document_reader(&workspace, &payload)
}

#[tauri::command]
fn query_tabular_document(
    state: State<WorkspaceState>,
    path: String,
    sheet: Option<String>,
    select_columns: Option<String>,
    filters: Option<String>,
    filter_logic: Option<String>,
    group_by: Option<String>,
    aggregations: Option<String>,
    sort_by: Option<String>,
    row_offset: Option<usize>,
    limit: Option<usize>,
    workspace: Option<String>,
) -> Result<Value, String> {
    let workspace = resolve_workspace_root(&state, workspace)?;
    let real_path = resolve_existing_path(&path, &workspace)?;
    if !real_path.is_file() {
        return Err("query_tabular_document 目标不是文件".to_string());
    }

    let payload = json!({
        "command": "query_tabular_document",
        "workspaceRoot": workspace.to_string_lossy().to_string(),
        "path": real_path.to_string_lossy().to_string(),
        "sheet": sheet,
        "selectColumns": select_columns,
        "filters": filters,
        "filterLogic": filter_logic.unwrap_or_else(|| "and".to_string()),
        "groupBy": group_by,
        "aggregations": aggregations,
        "sortBy": sort_by,
        "rowOffset": row_offset.unwrap_or(0),
        "limit": limit.unwrap_or(50).clamp(1, 500),
    });

    run_document_reader(&workspace, &payload)
}

#[tauri::command]
fn index_workspace_documents(
    state: State<WorkspaceState>,
    path: Option<String>,
    max_files: Option<usize>,
    max_chars_per_file: Option<usize>,
    extensions: Option<String>,
    workspace: Option<String>,
) -> Result<Value, String> {
    let workspace = resolve_workspace_root(&state, workspace)?;
    let requested_path = path.unwrap_or_else(|| ".".to_string());
    let real_path = resolve_existing_path(&requested_path, &workspace)?;
    if !real_path.is_dir() {
        return Err("index_workspace_documents 目标不是目录".to_string());
    }

    let payload = json!({
        "command": "index_workspace_documents",
        "workspaceRoot": workspace.to_string_lossy().to_string(),
        "path": real_path.to_string_lossy().to_string(),
        "maxFiles": max_files.unwrap_or(8).clamp(1, 100),
        "maxCharsPerFile": max_chars_per_file.unwrap_or(700).clamp(200, 10_000),
        "extensions": extensions,
    });

    run_document_reader(&workspace, &payload)
}

/// Delete a protocol package folder when the skill is removed from the UI.
#[tauri::command]
fn delete_protocol_package(
    state: State<WorkspaceState>,
    local_path: String,
) -> Result<(), String> {
    let workspace = state.get_root()?;
    let full_path = workspace.join(&local_path);

    // Security: ensure the path is within .protocols/
    if !local_path.starts_with(".protocols/") && !local_path.starts_with(".protocols\\") {
        return Err("只能删除 .protocols/ 目录下的包".to_string());
    }

    if !full_path.exists() {
        return Ok(()); // Already gone, no error
    }

    if full_path.is_dir() {
        fs::remove_dir_all(&full_path).map_err(|e| format!("删除包目录失败: {e}"))?;
    }

    Ok(())
}

#[tauri::command]
fn delete_workspace_path(
    state: State<WorkspaceState>,
    path: String,
    workspace: Option<String>,
) -> Result<(), String> {
    let workspace = resolve_workspace_root(&state, workspace)?;
    let raw_path = if Path::new(&path).is_absolute() {
        PathBuf::from(&path)
    } else {
        workspace.join(&path)
    };

    if !raw_path.exists() {
        return Ok(());
    }

    let real_path = raw_path
        .canonicalize()
        .map_err(|e| format!("无法解析待删除路径: {e}"))?;
    ensure_in_workspace(&real_path, &workspace)?;

    if real_path.is_dir() {
        fs::remove_dir_all(&real_path).map_err(|e| format!("删除目录失败: {e}"))?;
    } else {
        fs::remove_file(&real_path).map_err(|e| format!("删除文件失败: {e}"))?;
    }

    Ok(())
}

#[tauri::command]
fn delete_chat_temp_path(session_key: String, path: String) -> Result<(), String> {
    let workspace = ensure_chat_temp_root(&session_key)?;
    let raw_path = if Path::new(&path).is_absolute() {
        PathBuf::from(&path)
    } else {
        workspace.join(&path)
    };

    if !raw_path.exists() {
        return Ok(());
    }

    let real_path = raw_path
        .canonicalize()
        .map_err(|e| format!("无法解析聊天临时删除路径: {e}"))?;
    ensure_in_workspace(&real_path, &workspace)?;

    if real_path.is_dir() {
        fs::remove_dir_all(&real_path).map_err(|e| format!("删除聊天临时目录失败: {e}"))?;
    } else {
        fs::remove_file(&real_path).map_err(|e| format!("删除聊天临时文件失败: {e}"))?;
    }

    Ok(())
}

/// Delete all spec files (requirements.md, design.md, tasks.md, bugfix.md)
/// from the `.MAIN/plans/` directory. Called automatically when a plan is
/// approved and execution begins, so the user never sees leftover plan files.
#[tauri::command]
fn delete_plan_files(state: State<WorkspaceState>) -> Result<(), String> {
    let workspace = state.get_root()?;
    let plans_dir = workspace.join(".MAIN").join("plans");

    if !plans_dir.exists() {
        return Ok(());
    }

    let spec_names = [
        "requirements.md",
        "design.md",
        "tasks.md",
        "bugfix.md",
    ];

    for name in &spec_names {
        let file_path = plans_dir.join(name);
        if file_path.exists() && file_path.is_file() {
            fs::remove_file(&file_path)
                .map_err(|e| format!("删除规格文件 {:?} 失败: {e}", file_path))?;
        }
    }

    Ok(())
}

// endregion

// region: 飞书 IM Adapter

fn sanitize_feishu_domain(domain: Option<String>) -> String {
    let trimmed = domain
        .unwrap_or_else(|| "https://open.feishu.cn".to_string())
        .trim()
        .trim_end_matches('/')
        .to_string();
    if trimmed.is_empty() {
        "https://open.feishu.cn".to_string()
    } else {
        trimmed
    }
}

fn feishu_project_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."))
}

fn feishu_sidecar_script_path() -> PathBuf {
    feishu_project_root()
        .join("scripts")
        .join("feishu_adapter_sidecar.mjs")
}

fn node_executable_name() -> &'static str {
    if cfg!(target_os = "windows") {
        "node.exe"
    } else {
        "node"
    }
}

fn push_node_candidate(candidates: &mut Vec<PathBuf>, path: impl Into<PathBuf>) {
    let path = path.into();
    if !candidates.iter().any(|candidate| candidate == &path) {
        candidates.push(path);
    }
}

fn collect_glob_node_candidates(candidates: &mut Vec<PathBuf>, pattern: String) {
    if let Ok(paths) = glob(&pattern) {
        for entry in paths.flatten() {
            push_node_candidate(candidates, entry);
        }
    }
}

fn candidate_node_paths() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    let executable = node_executable_name();

    if let Some(path_var) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path_var) {
            push_node_candidate(&mut candidates, dir.join(executable));
        }
    }

    if cfg!(target_os = "macos") {
        push_node_candidate(&mut candidates, "/opt/homebrew/bin/node");
        push_node_candidate(&mut candidates, "/usr/local/bin/node");
        push_node_candidate(&mut candidates, "/usr/bin/node");
        push_node_candidate(&mut candidates, "/usr/local/opt/node/bin/node");
        if let Some(home) = std::env::var_os("HOME") {
            let home = PathBuf::from(home);
            push_node_candidate(&mut candidates, home.join(".volta/bin/node"));
            push_node_candidate(&mut candidates, home.join(".asdf/shims/node"));
            collect_glob_node_candidates(
                &mut candidates,
                home.join(".nvm/versions/node/*/bin/node").to_string_lossy().to_string(),
            );
            collect_glob_node_candidates(
                &mut candidates,
                home.join(".fnm/node-versions/*/installation/bin/node").to_string_lossy().to_string(),
            );
        }
    } else if cfg!(target_os = "windows") {
        if let Some(program_files) = std::env::var_os("ProgramFiles") {
            push_node_candidate(&mut candidates, PathBuf::from(program_files).join("nodejs/node.exe"));
        }
        if let Some(program_files_x86) = std::env::var_os("ProgramFiles(x86)") {
            push_node_candidate(&mut candidates, PathBuf::from(program_files_x86).join("nodejs/node.exe"));
        }
        if let Some(local_app_data) = std::env::var_os("LOCALAPPDATA") {
            push_node_candidate(&mut candidates, PathBuf::from(local_app_data).join("Programs/nodejs/node.exe"));
        }
    } else {
        push_node_candidate(&mut candidates, "/usr/bin/node");
        push_node_candidate(&mut candidates, "/usr/local/bin/node");
        push_node_candidate(&mut candidates, "/snap/bin/node");
        if let Some(home) = std::env::var_os("HOME") {
            let home = PathBuf::from(home);
            push_node_candidate(&mut candidates, home.join(".volta/bin/node"));
            push_node_candidate(&mut candidates, home.join(".asdf/shims/node"));
            collect_glob_node_candidates(
                &mut candidates,
                home.join(".nvm/versions/node/*/bin/node").to_string_lossy().to_string(),
            );
            collect_glob_node_candidates(
                &mut candidates,
                home.join(".fnm/node-versions/*/installation/bin/node").to_string_lossy().to_string(),
            );
        }
    }

    candidates
}

fn resolve_node_executable() -> Option<PathBuf> {
    candidate_node_paths()
        .into_iter()
        .find(|path| path.is_file())
}

fn get_node_version(path: &Path) -> Option<String> {
    let output = ProcessCommand::new(path).arg("-v").output().ok()?;
    if !output.status.success() {
        return None;
    }
    let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if version.is_empty() {
        None
    } else {
        Some(version)
    }
}

#[tauri::command]
fn get_feishu_node_runtime_status() -> Result<NodeRuntimeStatus, String> {
    let Some(path) = resolve_node_executable() else {
        return Ok(NodeRuntimeStatus {
            found: false,
            executable: None,
            version: None,
            message: "未找到 Node.js。请在飞书设置中使用快速配置，或手动安装 Node.js LTS。".to_string(),
        });
    };
    let version = get_node_version(&path);
    Ok(NodeRuntimeStatus {
        found: true,
        executable: Some(path.to_string_lossy().to_string()),
        version: version.clone(),
        message: match version {
            Some(version) => format!("已找到 Node.js {version}"),
            None => "已找到 Node.js，但无法读取版本号。".to_string(),
        },
    })
}

fn set_feishu_status(
    status_slot: &Arc<Mutex<FeishuAdapterStatus>>,
    status: &str,
    running: bool,
    message: impl Into<String>,
    pid: Option<u32>,
) -> FeishuAdapterStatus {
    let next = FeishuAdapterStatus {
        status: status.to_string(),
        running,
        message: message.into(),
        updated_at: now_millis(),
        pid,
    };
    if let Ok(mut guard) = status_slot.lock() {
        *guard = next.clone();
    }
    next
}

fn update_feishu_status_from_event(
    status_slot: &Arc<Mutex<FeishuAdapterStatus>>,
    value: &Value,
    fallback_pid: Option<u32>,
) {
    let event_type = value.get("type").and_then(Value::as_str).unwrap_or("");
    if event_type != "status" && event_type != "error" {
        return;
    }

    let status = value
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or(if event_type == "error" { "error" } else { "idle" });
    let running = value
        .get("running")
        .and_then(Value::as_bool)
        .unwrap_or(matches!(status, "starting" | "connected"));
    let message = value
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or(if event_type == "error" { "Feishu adapter error." } else { "" });
    let pid = value
        .get("pid")
        .and_then(Value::as_u64)
        .and_then(|raw| u32::try_from(raw).ok())
        .or(fallback_pid);

    let _ = set_feishu_status(status_slot, status, running, message, pid);
}

fn write_feishu_sidecar_command(
    writer: &Arc<Mutex<ChildStdin>>,
    command: Value,
) -> Result<(), String> {
    let mut guard = writer
        .lock()
        .map_err(|_| "无法写入飞书适配器：状态锁已损坏".to_string())?;
    writeln!(guard, "{command}").map_err(|e| format!("写入飞书适配器失败: {e}"))?;
    guard.flush().map_err(|e| format!("刷新飞书适配器命令失败: {e}"))
}

#[tauri::command]
fn get_feishu_adapter_status(state: State<FeishuAdapterManager>) -> Result<FeishuAdapterStatus, String> {
    state
        .status
        .lock()
        .map(|guard| guard.clone())
        .map_err(|_| "无法读取飞书适配器状态：状态锁已损坏".to_string())
}

#[tauri::command]
fn start_feishu_adapter(
    app: AppHandle,
    state: State<FeishuAdapterManager>,
    config: FeishuAdapterConfigPayload,
) -> Result<FeishuAdapterStatus, String> {
    let app_id = config.app_id.trim().to_string();
    let app_secret = config.app_secret;
    if app_id.is_empty() || app_secret.trim().is_empty() {
        return Err("请先填写飞书 App ID 和 App Secret".to_string());
    }

    let script_path = feishu_sidecar_script_path();
    if !script_path.exists() {
        return Err(format!("未找到飞书适配器脚本: {}", script_path.display()));
    }

    {
        let mut process_guard = state
            .process
            .lock()
            .map_err(|_| "无法启动飞书适配器：状态锁已损坏".to_string())?;
        if let Some(mut existing) = process_guard.take() {
            existing.shutdown();
        }
    }

    let starting = set_feishu_status(&state.status, "starting", true, "正在启动飞书长连接...", None);
    let _ = app.emit("feishu-adapter-event", json!({
        "type": "status",
        "adapter": "feishu",
        "status": starting.status,
        "running": starting.running,
        "message": starting.message,
        "timestamp": starting.updated_at,
    }));

    let node_path = resolve_node_executable().ok_or_else(|| {
        "启动飞书适配器失败：未找到 Node.js。请在「系统设置 > 即时通讯适配器」点击「快速配置 Node.js」，或手动安装 Node.js LTS 后重启 MAIN。".to_string()
    })?;
    record_debug_log(
        &app,
        "info",
        "feishu.adapter",
        format!("using node runtime: {}", node_path.display()),
    );

    let mut command = ProcessCommand::new(&node_path);
    command
        .arg(script_path)
        .current_dir(feishu_project_root())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = command
        .spawn()
        .map_err(|e| format!("启动飞书适配器失败，请确认已安装 Node.js: {e}"))?;
    let pid = child.id();
    let stdin = child.stdin.take().ok_or_else(|| "无法打开飞书适配器输入管道".to_string())?;
    let stdout = child.stdout.take().ok_or_else(|| "无法打开飞书适配器输出管道".to_string())?;
    let stderr = child.stderr.take().ok_or_else(|| "无法打开飞书适配器日志管道".to_string())?;
    let writer = Arc::new(Mutex::new(stdin));
    let status_slot = state.status.clone();
    let app_for_stdout = app.clone();

    thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line_result in reader.lines() {
            let Ok(line) = line_result else {
                break;
            };
            if line.trim().is_empty() {
                continue;
            }
            match serde_json::from_str::<Value>(&line) {
                Ok(value) => {
                    update_feishu_status_from_event(&status_slot, &value, Some(pid));
                    let _ = app_for_stdout.emit("feishu-adapter-event", value);
                }
                Err(err) => {
                    record_debug_log(
                        &app_for_stdout,
                        "warn",
                        "feishu.adapter",
                        format!("忽略无法解析的飞书适配器输出: {err}"),
                    );
                }
            }
        }
        let stopped = set_feishu_status(
            &status_slot,
            "stopped",
            false,
            "飞书适配器进程已退出。",
            Some(pid),
        );
        let _ = app_for_stdout.emit("feishu-adapter-event", json!({
            "type": "status",
            "adapter": "feishu",
            "status": stopped.status,
            "running": stopped.running,
            "message": stopped.message,
            "pid": stopped.pid,
            "timestamp": stopped.updated_at,
        }));
    });

    let app_for_stderr = app.clone();
    thread::spawn(move || {
        let reader = BufReader::new(stderr);
        for line in reader.lines().flatten() {
            if line.trim().is_empty() {
                continue;
            }
            record_debug_log(&app_for_stderr, "info", "feishu.adapter", line);
        }
    });

    write_feishu_sidecar_command(&writer, json!({
        "type": "start",
        "config": {
            "appId": app_id,
            "appSecret": app_secret,
            "domain": sanitize_feishu_domain(config.domain),
        },
    }))?;

    let status = set_feishu_status(
        &state.status,
        "starting",
        true,
        "飞书适配器已启动，正在等待长连接就绪...",
        Some(pid),
    );

    let mut process_guard = state
        .process
        .lock()
        .map_err(|_| "无法保存飞书适配器进程：状态锁已损坏".to_string())?;
    *process_guard = Some(FeishuAdapterProcess { child, writer });

    Ok(status)
}

#[tauri::command]
fn stop_feishu_adapter(
    app: AppHandle,
    state: State<FeishuAdapterManager>,
) -> Result<FeishuAdapterStatus, String> {
    let mut process_guard = state
        .process
        .lock()
        .map_err(|_| "无法停止飞书适配器：状态锁已损坏".to_string())?;
    if let Some(mut process) = process_guard.take() {
        process.shutdown();
    }
    let status = set_feishu_status(&state.status, "stopped", false, "飞书适配器已停止。", None);
    let _ = app.emit("feishu-adapter-event", json!({
        "type": "status",
        "adapter": "feishu",
        "status": status.status,
        "running": status.running,
        "message": status.message,
        "timestamp": status.updated_at,
    }));
    Ok(status)
}

#[tauri::command]
fn send_feishu_message(
    state: State<FeishuAdapterManager>,
    chat_id: String,
    text: String,
    user_id: Option<String>,
    open_id: Option<String>,
    message_id: Option<String>,
) -> Result<(), String> {
    let process_guard = state
        .process
        .lock()
        .map_err(|_| "无法发送飞书消息：状态锁已损坏".to_string())?;
    let process = process_guard
        .as_ref()
        .ok_or_else(|| "飞书适配器尚未启动".to_string())?;
    write_feishu_sidecar_command(&process.writer, json!({
        "type": "send_text",
        "chatId": chat_id,
        "userId": user_id,
        "openId": open_id,
        "messageId": message_id,
        "text": text,
    }))
}

#[tauri::command]
fn send_feishu_card(
    state: State<FeishuAdapterManager>,
    chat_id: String,
    card: Value,
    user_id: Option<String>,
    open_id: Option<String>,
    message_id: Option<String>,
    approval_id: Option<String>,
) -> Result<(), String> {
    let process_guard = state
        .process
        .lock()
        .map_err(|_| "无法发送飞书卡片：状态锁已损坏".to_string())?;
    let process = process_guard
        .as_ref()
        .ok_or_else(|| "飞书适配器尚未启动".to_string())?;
    write_feishu_sidecar_command(&process.writer, json!({
        "type": "send_card",
        "chatId": chat_id,
        "userId": user_id,
        "openId": open_id,
        "messageId": message_id,
        "approvalId": approval_id,
        "messageKind": "approval_card",
        "card": card,
    }))
}

#[tauri::command]
fn patch_feishu_card(
    state: State<FeishuAdapterManager>,
    message_id: String,
    card: Value,
) -> Result<(), String> {
    let process_guard = state
        .process
        .lock()
        .map_err(|_| "无法更新飞书卡片：状态锁已损坏".to_string())?;
    let process = process_guard
        .as_ref()
        .ok_or_else(|| "飞书适配器尚未启动".to_string())?;
    write_feishu_sidecar_command(&process.writer, json!({
        "type": "patch_card",
        "messageId": message_id,
        "card": card,
    }))
}

#[tauri::command]
async fn test_feishu_adapter_connection(
    app_id: String,
    app_secret: String,
    domain: Option<String>,
) -> Result<String, String> {
    let app_id = app_id.trim().to_string();
    if app_id.is_empty() || app_secret.trim().is_empty() {
        return Err("请先填写飞书 App ID 和 App Secret".to_string());
    }
    let url = format!(
        "{}/open-apis/auth/v3/tenant_access_token/internal",
        sanitize_feishu_domain(domain),
    );
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(HTTP_SHORT_TIMEOUT_SECS))
        .connect_timeout(Duration::from_secs(HTTP_CONNECT_TIMEOUT_SECS))
        .build()
        .map_err(|e| format!("创建飞书测试客户端失败: {e}"))?;
    let body = json!({
        "app_id": app_id,
        "app_secret": app_secret,
    })
    .to_string();
    let response = client
        .post(url)
        .header("Content-Type", "application/json")
        .body(body)
        .send()
        .await
        .map_err(|e| format!("飞书连接测试失败: {e}"))?;
    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|e| format!("读取飞书连接测试响应失败: {e}"))?;
    let parsed = serde_json::from_str::<Value>(&body).unwrap_or_else(|_| json!({}));
    let code = parsed.get("code").and_then(Value::as_i64).unwrap_or(-1);
    if status.is_success() && code == 0 {
        Ok("飞书凭据验证成功，长连接可在开启后建立。".to_string())
    } else {
        let message = parsed
            .get("msg")
            .and_then(Value::as_str)
            .unwrap_or("飞书返回非成功状态");
        Err(format!("飞书凭据验证失败: {message}"))
    }
}

// endregion

// region: App icon

fn generate_app_icon_png(variant: &str) -> Vec<u8> {
    if variant == "dark" {
        include_bytes!("../../public/app-icon-dark.png").to_vec()
    } else {
        include_bytes!("../../public/app-icon-light.png").to_vec()
    }
}

#[cfg(target_os = "macos")]
fn apply_app_icon_variant_macos(app: AppHandle, variant: String) -> Result<(), String> {
    use objc2::{AllocAnyThread, MainThreadMarker};
    use objc2_app_kit::{NSApp, NSImage};
    use objc2_foundation::NSData;
    use std::sync::mpsc;

    let (tx, rx) = mpsc::channel();
    app.run_on_main_thread(move || {
        let result = (|| -> Result<(), String> {
            let mtm = MainThreadMarker::new()
                .ok_or_else(|| "macOS app icon update did not run on the main thread".to_string())?;
            let bytes = generate_app_icon_png(&variant);
            let data = NSData::with_bytes(&bytes);
            let image = NSImage::initWithData(NSImage::alloc(), &data)
                .ok_or_else(|| "macOS could not decode the selected app icon".to_string())?;
            let ns_app = NSApp(mtm);
            unsafe {
                ns_app.setApplicationIconImage(Some(&image));
            }
            Ok(())
        })();
        let _ = tx.send(result);
    }).map_err(|e| format!("调度 macOS 图标更新失败: {e}"))?;

    rx.recv().map_err(|e| format!("等待 macOS 图标更新失败: {e}"))?
}

#[cfg(not(target_os = "macos"))]
#[allow(clippy::unnecessary_wraps)]
fn apply_app_icon_variant_macos(_app: AppHandle, _variant: String) -> Result<(), String> {
    Ok(())
}

#[tauri::command]
fn apply_app_icon_variant(app: AppHandle, variant: String) -> Result<(), String> {
    let normalized = if variant == "dark" { "dark" } else { "light" }.to_string();
    apply_app_icon_variant_macos(app, normalized)
}

// endregion

// region: 应用启动

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let workspace_root = default_workspace_root().unwrap_or_else(|_| {
        std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
    });

    tauri::Builder::default()
        .manage(WorkspaceState::new(workspace_root))
        .manage(PtyManager::default())
        .manage(FeishuAdapterManager::default())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![
            get_workspace_root,
            set_workspace_root,
            canonicalize_workspace_path,
            list_directory,
            get_project_skeleton,
            get_file_outline,
            read_file,
            read_file_window,
            get_file_metadata,
            write_file,
            export_text_file,
            glob_search,
            grep_search,
            spawn_pty,
            resize_pty,
            write_pty,
            read_pty_buffer,
            read_pty_tail,
            read_pty_since,
            clear_pty_buffer,
            get_pty_status,
            run_command,
            get_git_status,
            get_git_file_list,
            get_git_diff,
            git_commit_all,
            git_push_current_branch,
            git_create_branch,
            count_tokens,
            get_system_memory,
            append_debug_log,
            read_debug_log,
            clear_debug_log,
            proxy_request,
            cancel_proxy_request,
            start_chat_stream,
            cancel_chat_stream,
            read_document,
            analyze_tabular_document,
            query_tabular_document,
            index_workspace_documents,
            extract_protocol_package,
            delete_protocol_package,
            write_chat_temp_file,
            read_chat_temp_file,
            get_chat_temp_root,
            ingest_attachment_file,
            ingest_attachment_bytes,
            read_attachment_image_data_url,
            list_project_sessions,
            rebuild_project_sessions_index,
            save_project_session,
            load_project_session,
            load_project_session_meta,
            load_project_session_page,
            delete_project_session,
            clear_project_sessions,
            delete_workspace_path,
            delete_chat_temp_path,
            run_hook_command,
            delete_plan_files,
            start_feishu_adapter,
            stop_feishu_adapter,
            get_feishu_adapter_status,
            get_feishu_node_runtime_status,
            send_feishu_message,
            send_feishu_card,
            patch_feishu_card,
            test_feishu_adapter_connection,
            apply_app_icon_variant
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

// endregion

#[cfg(test)]
mod tests {
    use super::{
        compare_file_nodes,
        is_valid_git_branch_name,
        merge_json_rows_by_id,
        parse_git_branch_line,
        parse_git_numstat,
        parse_git_porcelain_entries,
        parse_git_porcelain_status,
        read_session_transcript_with_fallback,
        resolve_session_transcript_to_write,
        resolve_existing_path,
        resolve_write_path,
        SessionTranscript,
        should_hide_list_directory_entry,
        should_skip_recursive_search_dir,
        write_json_atomic,
        write_jsonl_atomic,
        FileNode,
    };
    use serde_json::json;
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn make_temp_workspace(name: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("main-workspace-{name}-{unique}"));
        fs::create_dir_all(&root).unwrap();
        root.canonicalize().unwrap()
    }

    #[test]
    fn merge_json_rows_by_id_preserves_existing_rows_and_replaces_loaded_page() {
        let existing = vec![
            json!({"id": 1, "content": "old one"}),
            json!({"id": 2, "content": "old two"}),
            json!({"id": 3, "content": "old three"}),
        ];
        let incoming = vec![
            json!({"id": 2, "content": "new two"}),
            json!({"id": 4, "content": "new four"}),
        ];

        let merged = merge_json_rows_by_id(existing, incoming);

        assert_eq!(merged.len(), 4);
        assert_eq!(merged[0]["content"], "old one");
        assert_eq!(merged[1]["content"], "new two");
        assert_eq!(merged[2]["content"], "old three");
        assert_eq!(merged[3]["content"], "new four");
    }

    #[test]
    fn session_transcript_readers_fall_back_to_legacy_runtime_snapshot() {
        let workspace = make_temp_workspace("legacy-session-runtime");
        let runtime_path = workspace.join("runtime.json");
        let messages_path = workspace.join("messages.jsonl");
        let turns_path = workspace.join("turns.jsonl");
        write_json_atomic(&runtime_path, &json!({
            "taskFlow": [
                {"id": 11, "type": "user", "content": "legacy user"},
                {"id": 12, "type": "agent", "content": "legacy agent"}
            ],
            "conversationTurns": [
                {"id": "turn-legacy", "blockIds": [11, 12], "createdAt": 1}
            ]
        })).unwrap();

        let transcript = read_session_transcript_with_fallback(
            &messages_path,
            &turns_path,
            &runtime_path,
            "legacy",
        ).unwrap();

        assert_eq!(transcript.messages.len(), 2);
        assert_eq!(transcript.messages[0]["content"], "legacy user");
        assert_eq!(transcript.turns.len(), 1);
        assert_eq!(transcript.turns[0]["id"], "turn-legacy");

        fs::remove_dir_all(&workspace).unwrap();
    }

    #[test]
    fn session_transcript_readers_recover_legacy_runtime_when_v2_jsonl_is_empty() {
        let workspace = make_temp_workspace("v2-session-runtime");
        let runtime_path = workspace.join("runtime.json");
        let messages_path = workspace.join("messages.jsonl");
        let turns_path = workspace.join("turns.jsonl");
        write_json_atomic(&runtime_path, &json!({
            "taskFlow": [{"id": 11, "type": "user", "content": "legacy user"}],
            "conversationTurns": [{"id": "turn-legacy", "blockIds": [11], "createdAt": 1}]
        })).unwrap();
        write_jsonl_atomic(&messages_path, &[], "test messages").unwrap();
        write_jsonl_atomic(&turns_path, &[], "test turns").unwrap();

        let transcript = read_session_transcript_with_fallback(
            &messages_path,
            &turns_path,
            &runtime_path,
            "v2",
        ).unwrap();

        assert_eq!(transcript.messages.len(), 1);
        assert_eq!(transcript.messages[0]["content"], "legacy user");
        assert_eq!(transcript.turns.len(), 1);
        assert_eq!(transcript.turns[0]["id"], "turn-legacy");

        fs::remove_dir_all(&workspace).unwrap();
    }

    #[test]
    fn session_transcript_readers_recover_from_agent_messages_when_jsonl_and_legacy_runtime_are_empty() {
        let workspace = make_temp_workspace("agent-message-session-runtime");
        let runtime_path = workspace.join("runtime.json");
        let messages_path = workspace.join("messages.jsonl");
        let turns_path = workspace.join("turns.jsonl");
        write_json_atomic(&runtime_path, &json!({
            "agentMessages": [
                {"role": "system", "content": "hidden instruction"},
                {"role": "user", "content": "recover this user prompt"},
                {"role": "assistant", "content": "recover this assistant reply"},
                {"role": "tool", "tool_call_id": "tool-1", "content": "recover this tool output"}
            ]
        })).unwrap();
        write_jsonl_atomic(&messages_path, &[], "test messages").unwrap();
        write_jsonl_atomic(&turns_path, &[], "test turns").unwrap();

        let transcript = read_session_transcript_with_fallback(
            &messages_path,
            &turns_path,
            &runtime_path,
            "177",
        ).unwrap();

        assert!(transcript.recovered_from_agent_messages);
        assert_eq!(transcript.messages.len(), 3);
        assert_eq!(transcript.turns.len(), 1);
        assert_eq!(transcript.messages[0]["type"], "user");
        assert_eq!(transcript.messages[1]["type"], "agent");
        assert_eq!(transcript.messages[2]["type"], "tool");
        assert_eq!(transcript.turns[0]["id"], "recovered-177-0");
        assert_eq!(transcript.turns[0]["blockIds"].as_array().unwrap().len(), 3);

        fs::remove_dir_all(&workspace).unwrap();
    }

    #[test]
    fn session_transcript_fallback_prefers_existing_jsonl_over_agent_messages() {
        let workspace = make_temp_workspace("jsonl-before-agent-runtime");
        let runtime_path = workspace.join("runtime.json");
        let messages_path = workspace.join("messages.jsonl");
        let turns_path = workspace.join("turns.jsonl");
        write_json_atomic(&runtime_path, &json!({
            "agentMessages": [
                {"role": "user", "content": "agent user"},
                {"role": "assistant", "content": "agent assistant"}
            ]
        })).unwrap();
        write_jsonl_atomic(
            &messages_path,
            &[json!({"id": 9, "turnId": "jsonl-turn", "type": "user", "content": "jsonl user"})],
            "test messages",
        ).unwrap();
        write_jsonl_atomic(
            &turns_path,
            &[json!({"id": "jsonl-turn", "blockIds": [9], "createdAt": 1})],
            "test turns",
        ).unwrap();

        let transcript = read_session_transcript_with_fallback(
            &messages_path,
            &turns_path,
            &runtime_path,
            "178",
        ).unwrap();

        assert!(!transcript.recovered_from_agent_messages);
        assert_eq!(transcript.messages.len(), 1);
        assert_eq!(transcript.messages[0]["content"], "jsonl user");
        assert_eq!(transcript.turns[0]["id"], "jsonl-turn");

        fs::remove_dir_all(&workspace).unwrap();
    }

    #[test]
    fn session_save_resolution_keeps_existing_transcript_when_incoming_is_empty() {
        let existing = SessionTranscript {
            messages: vec![json!({"id": 1, "type": "user", "content": "existing message"})],
            turns: vec![json!({"id": "turn-existing", "blockIds": [1], "createdAt": 1})],
            recovered_from_agent_messages: false,
        };

        let (messages, turns) = resolve_session_transcript_to_write(
            &existing,
            Vec::new(),
            Vec::new(),
            false,
        );

        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0]["content"], "existing message");
        assert_eq!(turns.len(), 1);
        assert_eq!(turns[0]["id"], "turn-existing");
    }

    #[test]
    fn resolve_existing_path_allows_nested_workspace_directory() {
        let workspace = make_temp_workspace("nested-dir");
        let nested = workspace.join("gdjrpg-prepare");
        fs::create_dir_all(&nested).unwrap();

        let resolved = resolve_existing_path("gdjrpg-prepare", &workspace).unwrap();
        assert_eq!(resolved, nested.canonicalize().unwrap());

        fs::remove_dir_all(&workspace).unwrap();
    }

    #[test]
    fn resolve_existing_path_rejects_parent_escape() {
        let parent = make_temp_workspace("parent");
        let workspace = parent.join("workspace");
        let outside = parent.join("outside");
        fs::create_dir_all(&workspace).unwrap();
        fs::create_dir_all(&outside).unwrap();

        let err = resolve_existing_path("../outside", &workspace.canonicalize().unwrap()).unwrap_err();
        assert!(err.contains("路径越界"));

        fs::remove_dir_all(&parent).unwrap();
    }

    #[test]
    fn resolve_write_path_keeps_relative_writes_inside_workspace() {
        let workspace = make_temp_workspace("write-path");
        let file_path = resolve_write_path("notes/output.md", &workspace).unwrap();
        assert!(file_path.starts_with(&workspace));
        assert_eq!(file_path, workspace.join("notes").join("output.md"));

        fs::remove_dir_all(&workspace).unwrap();
    }

    #[test]
    fn list_directory_hides_common_build_noise_but_keeps_project_metadata() {
        assert!(should_hide_list_directory_entry("target", true));
        assert!(should_hide_list_directory_entry("Library", true));
        assert!(should_hide_list_directory_entry(".DS_Store", false));
        assert!(!should_hide_list_directory_entry("Scripts", true));
        assert!(!should_hide_list_directory_entry(".MAIN", true));
        assert!(!should_hide_list_directory_entry(".protocols", true));
    }

    #[test]
    fn recursive_search_skips_build_directories() {
        assert!(should_skip_recursive_search_dir("target"));
        assert!(should_skip_recursive_search_dir("PackageCache"));
        assert!(!should_skip_recursive_search_dir(".MAIN"));
        assert!(!should_skip_recursive_search_dir(".protocols"));
        assert!(!should_skip_recursive_search_dir("Scripts"));
    }

    #[test]
    fn list_directory_sorts_directories_before_files() {
        let mut nodes = vec![
            FileNode {
                name: "Cargo.toml".to_string(),
                path: "/tmp/Cargo.toml".to_string(),
                is_dir: false,
            },
            FileNode {
                name: "Scripts".to_string(),
                path: "/tmp/Scripts".to_string(),
                is_dir: true,
            },
            FileNode {
                name: "README.md".to_string(),
                path: "/tmp/README.md".to_string(),
                is_dir: false,
            },
            FileNode {
                name: "capabilities".to_string(),
                path: "/tmp/capabilities".to_string(),
                is_dir: true,
            },
        ];

        nodes.sort_by(compare_file_nodes);
        let ordered_names: Vec<&str> = nodes.iter().map(|node| node.name.as_str()).collect();
        assert_eq!(ordered_names, vec!["Scripts", "capabilities", "Cargo.toml", "README.md"]);
    }

    #[test]
    fn parse_git_branch_line_extracts_upstream_and_divergence() {
        let info = parse_git_branch_line("## feature/ui...origin/feature/ui [ahead 2, behind 1]");

        assert_eq!(info.branch.as_deref(), Some("feature/ui"));
        assert_eq!(info.upstream.as_deref(), Some("origin/feature/ui"));
        assert_eq!(info.ahead, 2);
        assert_eq!(info.behind, 1);
    }

    #[test]
    fn parse_git_branch_line_handles_repo_without_head_commit() {
        let info = parse_git_branch_line("## No commits yet on main");

        assert_eq!(info.branch.as_deref(), Some("main"));
        assert_eq!(info.upstream, None);
        assert_eq!(info.ahead, 0);
        assert_eq!(info.behind, 0);
    }

    #[test]
    fn parse_git_porcelain_status_counts_worktree_states() {
        let output = [
            "## main...origin/main [ahead 1]",
            " M src/App.tsx",
            "M  src/lib/ipc.ts",
            "A  src/new.ts",
            "?? notes.md",
            "UU conflicted.txt",
        ]
        .join("\n");

        let (branch, counts) = parse_git_porcelain_status(&output);

        assert_eq!(branch.branch.as_deref(), Some("main"));
        assert_eq!(branch.ahead, 1);
        assert_eq!(counts.changed_files, 5);
        assert_eq!(counts.unstaged_files, 1);
        assert_eq!(counts.staged_files, 2);
        assert_eq!(counts.untracked_files, 1);
        assert_eq!(counts.conflicted_files, 1);
    }

    #[test]
    fn parse_git_numstat_sums_text_changes_and_ignores_binary_rows() {
        let counts = parse_git_numstat("10\t2\tsrc/a.ts\n-\t-\tpublic/logo.png\n3\t0\tsrc/b.ts\n");

        assert_eq!(counts.insertions, 13);
        assert_eq!(counts.deletions, 2);
    }

    #[test]
    fn parse_git_porcelain_entries_filters_status_groups() {
        let output = [
            " M src/modified.ts",
            "A  src/added.ts",
            "D  src/deleted.ts",
            "R  src/old.ts -> src/new.ts",
            "?? notes.md",
        ]
        .join("\n");

        let changed = parse_git_porcelain_entries(&output, Some("changed"));
        assert_eq!(changed.len(), 2);
        assert_eq!(changed[0].path, "src/modified.ts");
        assert_eq!(changed[1].path, "src/new.ts");
        assert_eq!(changed[1].original_path.as_deref(), Some("src/old.ts"));

        let added = parse_git_porcelain_entries(&output, Some("added"));
        assert_eq!(added.len(), 2);
        assert_eq!(added[0].status, "A");
        assert_eq!(added[1].status, "U");

        let deleted = parse_git_porcelain_entries(&output, Some("deleted"));
        assert_eq!(deleted.len(), 1);
        assert_eq!(deleted[0].path, "src/deleted.ts");
    }

    #[test]
    fn git_branch_name_validation_rejects_risky_names() {
        assert!(is_valid_git_branch_name("feature/sidebar-git"));
        assert!(is_valid_git_branch_name("release/1.5.1"));
        assert!(!is_valid_git_branch_name(""));
        assert!(!is_valid_git_branch_name("-oops"));
        assert!(!is_valid_git_branch_name("feature bad"));
        assert!(!is_valid_git_branch_name("feature..bad"));
        assert!(!is_valid_git_branch_name("feature/@{bad"));
        assert!(!is_valid_git_branch_name("feature.lock"));
        assert!(!is_valid_git_branch_name("HEAD"));
    }
}
