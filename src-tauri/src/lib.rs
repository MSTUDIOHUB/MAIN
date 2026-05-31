use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use glob::glob;
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use rand::{distributions::Alphanumeric, rngs::OsRng, Rng, RngCore};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{IpAddr, TcpListener};
use std::path::{Component, Path, PathBuf};
use std::process::{
    Child as ProcessChild, ChildStdin, Command as ProcessCommand, ExitStatus, Stdio,
};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_opener::OpenerExt;
use tiktoken_rs::{cl100k_base, CoreBPE};
use walkdir::WalkDir;

#[cfg(unix)]
use std::os::raw::c_int;
#[cfg(unix)]
use std::os::unix::process::CommandExt;

pub mod critic;
pub mod eval;
pub mod executor;
pub mod harness;
pub mod indexer;
pub mod mcp;
pub mod memory;
pub mod planner;
pub mod runtime;
pub mod task_graph;
pub mod web_search;

// region: 全局常量与状态

const PTY_BUFFER_LIMIT_BYTES: usize = 512 * 1024;
const GREP_MATCH_LIMIT: usize = 2000;
const GREP_OUTPUT_LIMIT_BYTES: usize = 512 * 1024;
const COMMAND_OUTPUT_LIMIT_BYTES: usize = 1024 * 1024;
const LOGIN_SHELL_ENV_TIMEOUT_MS: u64 = 4_000;
const LOGIN_SHELL_ENV_OUTPUT_LIMIT_BYTES: usize = 256 * 1024;
const DOCUMENT_READER_SCRIPT: &str = include_str!("../Scripts/document_reader.py");
const HTTP_CONNECT_TIMEOUT_SECS: u64 = 15;
const HTTP_SHORT_TIMEOUT_SECS: u64 = 15;
const MODEL_REQUEST_TIMEOUT_SECS: u64 = 30 * 60;
const STREAM_READ_TIMEOUT_SECS: u64 = 15 * 60;
const STREAM_FIRST_RESPONSE_TIMEOUT_SECS: u64 = 180;
const STREAM_FIRST_CHUNK_TIMEOUT_SECS: u64 = 180;
const STREAM_IDLE_CHUNK_TIMEOUT_SECS: u64 = 180;
const READ_FILE_WINDOW_DEFAULT_MAX_LINES: usize = 180;
const READ_FILE_WINDOW_MAX_LINES: usize = 600;
const READ_FILE_WINDOW_DEFAULT_MAX_CHARS: usize = 6_800;
const READ_FILE_WINDOW_MAX_CHARS: usize = 24_000;

#[cfg(unix)]
const SIGTERM_SIGNAL: c_int = 15;
#[cfg(unix)]
const SIGKILL_SIGNAL: c_int = 9;

#[cfg(unix)]
extern "C" {
    fn kill(pid: c_int, sig: c_int) -> c_int;
    fn setpgid(pid: c_int, pgid: c_int) -> c_int;
}

static TOKENIZER: OnceLock<CoreBPE> = OnceLock::new();
static TERMINAL_ENV_OVERRIDES: OnceLock<HashMap<String, String>> = OnceLock::new();

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
fn append_debug_log(
    app: AppHandle,
    level: String,
    source: String,
    message: String,
) -> Result<(), String> {
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
    workspace: PathBuf,
    pending_command: String,
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

fn resolve_workspace_root(
    state: &WorkspaceState,
    workspace: Option<String>,
) -> Result<PathBuf, String> {
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
    "txt",
    "log",
    "md",
    "markdown",
    "js",
    "ts",
    "tsx",
    "jsx",
    "py",
    "cs",
    "java",
    "c",
    "cpp",
    "h",
    "hpp",
    "json",
    "yaml",
    "yml",
    "toml",
    "xml",
    "html",
    "css",
    "scss",
    "less",
    "sh",
    "bash",
    "zsh",
    "fish",
    "rs",
    "go",
    "rb",
    "php",
    "swift",
    "kt",
    "dart",
    "lua",
    "sql",
    "graphql",
    "env",
    "gitignore",
    "ignore",
    "pdf",
    "docx",
    "xlsx",
    "xls",
    "csv",
    "tsv",
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

fn sessions_project_root(
    app: &AppHandle,
    workspace: &str,
) -> Result<(PathBuf, String, String), String> {
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
    project_root
        .join("sessions")
        .join(sanitize_session_key(session_id))
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
    let content =
        serde_json::to_string_pretty(value).map_err(|e| format!("序列化会话记录失败: {e}"))?;
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
        let line =
            serde_json::to_string(row).map_err(|e| format!("序列化{error_label}失败: {e}"))?;
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

fn agent_messages_to_synthetic_transcript(
    agent_messages: Vec<Value>,
    session_id: &str,
) -> (Vec<Value>, Vec<Value>) {
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

fn read_jsonl_rows_by_block_ids(
    path: &Path,
    block_ids: &HashSet<String>,
) -> Result<Vec<Value>, String> {
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

fn annotate_session_meta(
    mut meta: Value,
    project_id: &str,
    workspace_root: &str,
    dir: &Path,
) -> Value {
    if let Some(object) = meta.as_object_mut() {
        object.insert(
            "projectId".to_string(),
            Value::String(project_id.to_string()),
        );
        object.insert(
            "workspaceRoot".to_string(),
            Value::String(workspace_root.to_string()),
        );
        object.insert(
            "storageStatus".to_string(),
            Value::String(session_detail_status(dir).to_string()),
        );
    }
    meta
}

fn session_sort_numeric(value: &Value, key: &str) -> i64 {
    match value.get(key) {
        Some(Value::Number(number)) => number.as_i64().unwrap_or(0),
        Some(Value::String(text)) => text.trim().parse::<i64>().unwrap_or(0),
        _ => 0,
    }
}

fn session_sort_string(value: &Value, key: &str) -> String {
    match value.get(key) {
        Some(Value::String(text)) => text.trim().to_string(),
        Some(Value::Number(number)) => number.to_string(),
        _ => String::new(),
    }
}

fn sort_sessions_by_recent(sessions: &mut Vec<Value>) {
    sessions.sort_by(|a, b| {
        let a_updated_ms = session_sort_numeric(a, "updatedAtMs");
        let b_updated_ms = session_sort_numeric(b, "updatedAtMs");
        if a_updated_ms != b_updated_ms {
            return b_updated_ms.cmp(&a_updated_ms);
        }

        let a_updated = session_sort_string(a, "updatedAt");
        let b_updated = session_sort_string(b, "updatedAt");
        if a_updated != b_updated {
            return b_updated.cmp(&a_updated);
        }

        let a_date = session_sort_string(a, "date");
        let b_date = session_sort_string(b, "date");
        if a_date != b_date {
            return b_date.cmp(&a_date);
        }

        let a_id_num = session_sort_numeric(a, "id");
        let b_id_num = session_sort_numeric(b, "id");
        if a_id_num != b_id_num {
            return b_id_num.cmp(&a_id_num);
        }

        let a_id = session_sort_string(a, "id");
        let b_id = session_sort_string(b, "id");
        b_id.cmp(&a_id)
    });
}

fn rebuild_sessions_index_for_project(
    project_root: &Path,
    project_id: &str,
    workspace_root: &str,
) -> Result<Vec<Value>, String> {
    let sessions_root = project_root.join("sessions");
    fs::create_dir_all(&sessions_root).map_err(|e| format!("创建会话目录失败: {e}"))?;

    let mut sessions = Vec::new();
    for entry in fs::read_dir(&sessions_root).map_err(|e| format!("读取会话目录失败: {e}"))?
    {
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
        sessions.push(annotate_session_meta(
            meta,
            project_id,
            workspace_root,
            &path,
        ));
    }

    sort_sessions_by_recent(&mut sessions);

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
    if path.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err("glob 模式不允许包含 ..".to_string());
    }
    Ok(())
}

// endregion

fn parse_curl_status_output(output: String, url: &str) -> Result<String, String> {
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
        if url.contains("/backend-api/codex/responses") {
            Ok(response_with_content_type(body, Some("text/event-stream")))
        } else {
            Ok(body)
        }
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

    if !(url.contains("/v1/responses")
        || url.contains("/v1/chat/completions")
        || url.contains("/backend-api/codex/responses"))
    {
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

    if !(url.contains("/v1/responses")
        || url.contains("/v1/chat/completions")
        || url.contains("/v1/messages")
        || url.contains("/backend-api/codex/responses")
        || url.contains("/v1internal:generateContent"))
    {
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
    command
        .arg("--connect-timeout")
        .arg(HTTP_CONNECT_TIMEOUT_SECS.to_string());
    let max_time_secs = if method.eq_ignore_ascii_case("POST")
        && (url.contains("/v1/responses")
            || url.contains("/v1/chat/completions")
            || url.contains("/v1/messages")
            || url.contains("/backend-api/codex/responses")
            || url.contains("/v1internal:generateContent"))
    {
        MODEL_REQUEST_TIMEOUT_SECS
    } else {
        HTTP_SHORT_TIMEOUT_SECS
    };
    command.arg("--max-time").arg(max_time_secs.to_string());
    command.arg("-w").arg("\n__HTTP_STATUS__:%{http_code}");

    let has_content_type = headers
        .map(|hdrs| {
            hdrs.keys()
                .any(|key| key.eq_ignore_ascii_case("content-type"))
        })
        .unwrap_or(false);
    if !has_content_type {
        command.arg("-H").arg("Content-Type: application/json");
    }

    let has_accept_encoding = headers
        .map(|hdrs| {
            hdrs.keys()
                .any(|key| key.eq_ignore_ascii_case("accept-encoding"))
        })
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

    parse_curl_status_output(stdout, url).map_err(|err| {
        if stderr.is_empty() {
            err
        } else {
            format!("{err} | curl stderr: {stderr}")
        }
    })
}

fn inject_gemini_code_assist_project(body: &str, project_id: &str) -> Result<String, String> {
    let mut payload = serde_json::from_str::<Value>(body)
        .map_err(|e| format!("解析 Gemini Code Assist 请求失败: {e}"))?;
    let object = payload
        .as_object_mut()
        .ok_or_else(|| "Gemini Code Assist 请求体必须是 JSON object。".to_string())?;
    object
        .entry("project".to_string())
        .or_insert_with(|| Value::String(project_id.to_string()));
    serde_json::to_string(&payload).map_err(|e| format!("序列化 Gemini Code Assist 请求失败: {e}"))
}

fn has_header_case_insensitive(headers: &HashMap<String, String>, name: &str) -> bool {
    headers.keys().any(|key| key.eq_ignore_ascii_case(name))
}

fn response_with_content_type(body: String, content_type: Option<&str>) -> String {
    if let Some(content_type) =
        content_type.filter(|value| value.to_ascii_lowercase().contains("text/event-stream"))
    {
        format!("__CONTENT_TYPE__:{}\n{}", content_type.trim(), body)
    } else {
        body
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProxyDetailedResponse {
    status: u16,
    ok: bool,
    body: String,
    content_type: Option<String>,
    headers: std::collections::HashMap<String, String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ImageStudioEngineCapabilities {
    text_to_image: bool,
    image_to_image: bool,
    progress_preview: bool,
    cuda_required: bool,
    cloud_hosted: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ImageStudioEngineCheckResult {
    ready: bool,
    message: String,
    capabilities: ImageStudioEngineCapabilities,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ImageStudioProxyResponse {
    status: u16,
    ok: bool,
    body: String,
    content_type: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ImageStudioStreamChunkPayload {
    stream_id: String,
    chunk: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ImageStudioStreamDonePayload {
    stream_id: String,
    status: String,
    error: Option<String>,
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
    let file =
        File::open(file_path).map_err(|e| format!("无法读取文件 {}: {e}", file_path.display()))?;
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

fn shell_file_name(shell: &str) -> String {
    Path::new(shell)
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or(shell)
        .trim_start_matches('-')
        .to_ascii_lowercase()
}

#[cfg(not(target_os = "windows"))]
fn apply_login_shell_args(cmd: &mut CommandBuilder, shell: &str) {
    match shell_file_name(shell).as_str() {
        "bash" | "fish" | "zsh" => cmd.args(["-l"]),
        _ => {}
    }
}

#[cfg(target_os = "windows")]
fn apply_login_shell_args(_cmd: &mut CommandBuilder, _shell: &str) {}

#[cfg(not(target_os = "windows"))]
fn configure_login_env_probe(command: &mut ProcessCommand, shell: &str) {
    match shell_file_name(shell).as_str() {
        "bash" | "fish" | "zsh" => {
            command.args(["-i", "-l", "-c", "/usr/bin/env -0"]);
        }
        _ => {
            command.args(["-l", "-c", "/usr/bin/env -0"]);
        }
    }
}

fn is_valid_env_key(key: &str) -> bool {
    !key.is_empty()
        && key
            .chars()
            .all(|ch| ch == '_' || ch.is_ascii_alphanumeric())
}

fn parse_login_shell_env_output(output: &str) -> HashMap<String, String> {
    let mut env = HashMap::new();

    for entry in output.split('\0') {
        let cleaned = entry.rsplit('\n').next().unwrap_or(entry);
        let Some((key, value)) = cleaned.split_once('=') else {
            continue;
        };
        if is_valid_env_key(key) {
            env.insert(key.to_string(), value.to_string());
        }
    }

    env
}

fn push_unique_path_text(paths: &mut Vec<String>, path: String) {
    if path.is_empty() || paths.iter().any(|existing| existing == &path) {
        return;
    }
    paths.push(path);
}

fn push_unique_path(paths: &mut Vec<String>, path: impl AsRef<Path>) {
    push_unique_path_text(paths, path.as_ref().to_string_lossy().to_string());
}

fn push_existing_path(paths: &mut Vec<String>, path: impl AsRef<Path>) {
    let path = path.as_ref();
    if path.is_dir() {
        push_unique_path(paths, path);
    }
}

fn collect_glob_path_candidates(paths: &mut Vec<String>, pattern: String) {
    if let Ok(matches) = glob(&pattern) {
        let mut entries = matches.flatten().collect::<Vec<_>>();
        entries.sort_by(|a, b| b.cmp(a));
        for entry in entries {
            push_existing_path(paths, entry);
        }
    }
}

fn developer_path_candidates() -> Vec<String> {
    let mut paths = Vec::new();

    if cfg!(target_os = "macos") {
        push_existing_path(&mut paths, "/opt/homebrew/bin");
        push_existing_path(&mut paths, "/opt/homebrew/sbin");
        push_existing_path(&mut paths, "/usr/local/bin");
        push_existing_path(&mut paths, "/usr/local/sbin");
        push_existing_path(&mut paths, "/opt/local/bin");
        push_existing_path(&mut paths, "/opt/local/sbin");
    } else if cfg!(target_os = "linux") {
        push_existing_path(&mut paths, "/usr/local/bin");
        push_existing_path(&mut paths, "/usr/local/sbin");
        push_existing_path(&mut paths, "/snap/bin");
    }

    if let Some(home) = std::env::var_os("HOME") {
        let home = PathBuf::from(home);
        push_existing_path(&mut paths, home.join(".local/bin"));
        push_existing_path(&mut paths, home.join("bin"));
        push_existing_path(&mut paths, home.join(".cargo/bin"));
        push_existing_path(&mut paths, home.join(".volta/bin"));
        push_existing_path(&mut paths, home.join(".asdf/shims"));
        push_existing_path(&mut paths, home.join(".pyenv/shims"));
        push_existing_path(&mut paths, home.join(".rbenv/shims"));
        push_existing_path(&mut paths, home.join(".deno/bin"));
        push_existing_path(&mut paths, home.join(".bun/bin"));
        push_existing_path(&mut paths, home.join(".npm-global/bin"));
        push_existing_path(&mut paths, home.join(".local/share/pnpm"));
        push_existing_path(&mut paths, home.join("Library/pnpm"));
        collect_glob_path_candidates(
            &mut paths,
            home.join(".nvm/versions/node/*/bin")
                .to_string_lossy()
                .to_string(),
        );
        collect_glob_path_candidates(
            &mut paths,
            home.join(".fnm/node-versions/*/installation/bin")
                .to_string_lossy()
                .to_string(),
        );
    }

    paths
}

fn split_path_text(path: &str) -> Vec<String> {
    let raw = std::ffi::OsString::from(path);
    std::env::split_paths(&raw)
        .map(|entry| entry.to_string_lossy().to_string())
        .collect()
}

fn join_path_text(paths: &[String]) -> Option<String> {
    let path_bufs = paths.iter().map(PathBuf::from).collect::<Vec<_>>();
    std::env::join_paths(path_bufs)
        .ok()
        .and_then(|value| value.into_string().ok())
}

fn build_terminal_path(base_path: Option<&str>, prefer_base_order: bool) -> Option<String> {
    let mut paths = Vec::new();
    let developer_paths = developer_path_candidates();

    if !prefer_base_order {
        for path in developer_paths.iter() {
            push_unique_path_text(&mut paths, path.clone());
        }
    }

    if let Some(base_path) = base_path {
        for path in split_path_text(base_path) {
            push_unique_path_text(&mut paths, path);
        }
    }

    for path in developer_paths {
        push_unique_path_text(&mut paths, path);
    }

    join_path_text(&paths)
}

#[cfg(not(target_os = "windows"))]
fn capture_login_shell_environment() -> Option<HashMap<String, String>> {
    let shell = default_shell();
    let mut command = ProcessCommand::new(&shell);
    configure_login_env_probe(&mut command, &shell);
    isolate_process_group(&mut command);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = command.spawn().ok()?;
    let stdout_handle = child.stdout.take().map(|stdout| {
        thread::spawn(move || read_limited_pipe(stdout, LOGIN_SHELL_ENV_OUTPUT_LIMIT_BYTES))
    });
    let stderr_handle = child.stderr.take().map(|stderr| {
        thread::spawn(move || read_limited_pipe(stderr, LOGIN_SHELL_ENV_OUTPUT_LIMIT_BYTES))
    });

    let started_at = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {
                if started_at.elapsed() >= Duration::from_millis(LOGIN_SHELL_ENV_TIMEOUT_MS) {
                    let _ = terminate_timed_out_child(&mut child);
                    let _ = join_captured_pipe(stdout_handle, "login shell stdout");
                    let _ = join_captured_pipe(stderr_handle, "login shell stderr");
                    return None;
                }
                thread::sleep(Duration::from_millis(10));
            }
            Err(_) => return None,
        }
    };

    let stdout = join_captured_pipe(stdout_handle, "login shell stdout").ok()?;
    let _ = join_captured_pipe(stderr_handle, "login shell stderr");
    if !status.success() && stdout.text.trim().is_empty() {
        return None;
    }

    let env = parse_login_shell_env_output(&stdout.text);
    if env.is_empty() {
        None
    } else {
        Some(env)
    }
}

#[cfg(target_os = "windows")]
fn capture_login_shell_environment() -> Option<HashMap<String, String>> {
    None
}

fn terminal_env_overrides() -> &'static HashMap<String, String> {
    TERMINAL_ENV_OVERRIDES.get_or_init(|| {
        let mut env = capture_login_shell_environment().unwrap_or_default();
        let has_login_path = env
            .get("PATH")
            .is_some_and(|value| !value.trim().is_empty());
        let base_path = if has_login_path {
            env.get("PATH").map(String::as_str)
        } else {
            None
        };
        let fallback_path = std::env::var("PATH").ok();
        let final_path =
            build_terminal_path(base_path.or(fallback_path.as_deref()), has_login_path);
        if let Some(path) = final_path {
            env.insert("PATH".to_string(), path);
        }
        env
    })
}

fn apply_terminal_env_to_pty(cmd: &mut CommandBuilder) {
    for (key, value) in terminal_env_overrides() {
        cmd.env(key, value);
    }
}

fn apply_terminal_env_to_process(cmd: &mut ProcessCommand) {
    for (key, value) in terminal_env_overrides() {
        cmd.env(key, value);
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
    apply_terminal_env_to_pty(cmd);
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
    apply_terminal_env_to_process(cmd);
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
                        std::str::from_utf8(&bytes[start..start + valid_up_to]).unwrap_or_default(),
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

    #[test]
    fn login_shell_env_parser_skips_noise_and_invalid_keys() {
        let parsed = parse_login_shell_env_output(
            "startup banner\nPATH=/opt/homebrew/bin:/usr/bin\0BAD-KEY=value\0HOME=/Users/test\0",
        );

        assert_eq!(
            parsed.get("PATH").map(String::as_str),
            Some("/opt/homebrew/bin:/usr/bin")
        );
        assert_eq!(parsed.get("HOME").map(String::as_str), Some("/Users/test"));
        assert!(!parsed.contains_key("BAD-KEY"));
    }
}

fn take_tail_chars(text: &str, max_chars: usize) -> (String, bool) {
    let char_count = text.chars().count();
    if char_count <= max_chars {
        return (text.to_string(), false);
    }
    (
        text.chars()
            .skip(char_count - max_chars)
            .collect::<String>(),
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

#[cfg(unix)]
fn isolate_process_group(command: &mut ProcessCommand) {
    unsafe {
        command.pre_exec(|| {
            let result = setpgid(0, 0);
            if result == 0 {
                Ok(())
            } else {
                Err(std::io::Error::last_os_error())
            }
        });
    }
}

#[cfg(not(unix))]
fn isolate_process_group(_command: &mut ProcessCommand) {}

fn terminate_timed_out_child(child: &mut ProcessChild) -> Result<ExitStatus, String> {
    #[cfg(unix)]
    {
        let process_group_id = child.id() as c_int;
        unsafe {
            let _ = kill(-process_group_id, SIGTERM_SIGNAL);
        }
        thread::sleep(Duration::from_millis(250));
        unsafe {
            let _ = kill(-process_group_id, SIGKILL_SIGNAL);
        }
    }

    let _ = child.kill();
    child
        .wait()
        .map_err(|e| format!("等待被终止的命令结束失败: {e}"))
}

fn looks_long_running_shell_command(command: &str) -> bool {
    static LONG_RUNNING_COMMAND_RE: OnceLock<Regex> = OnceLock::new();
    LONG_RUNNING_COMMAND_RE
        .get_or_init(|| {
            Regex::new(
                r"(?i)\b(?:npm|pnpm|yarn|bun)\s+run\s+tauri\s+dev\b|\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?dev\b|\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:start|serve|watch|preview|storybook)\b|\b(?:cargo\s+)?tauri\s+dev\b|\bvite(?:\s+(?:dev|serve|preview)\b|\s+--|$)|\bnext\s+(?:dev|start)\b|\b(?:nuxt|nuxi)\s+(?:dev|start|preview)\b|\bastro\s+(?:dev|preview)\b|\bwebpack-dev-server\b|\bstorybook(?:\s+dev\b|\s+--|$)",
            )
            .expect("valid long-running command regex")
        })
        .is_match(command)
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
        isolate_process_group(&mut cmd);
        cmd
    }
}

fn run_workspace_shell_command(
    workspace: &Path,
    command: String,
    input: Option<String>,
    timeout: Duration,
    permission_approval: Option<harness::permissions::ShellPermissionApproval>,
) -> Result<TerminalCommandOutput, String> {
    let trimmed = command.trim();
    if trimmed.is_empty() {
        return Err("命令不能为空".to_string());
    }
    if looks_long_running_shell_command(trimmed) {
        return Err(
            "run_command 只适合会自行结束的命令。检测到开发服务器或 watch 类长驻命令，请改用 execute_command 并通过 read_pty_since/read_pty_tail/get_pty_status 观察输出。"
                .to_string(),
        );
    }
    harness::permissions::PermissionGuard::from_workspace(workspace)
        .and_then(|guard| guard.validate_with_approval(trimmed, permission_approval.as_ref()))
        .map_err(|error| error.to_string())?;

    let mut process = build_workspace_shell_command(trimmed);
    process
        .current_dir(workspace)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = process.spawn().map_err(|e| format!("启动命令失败: {e}"))?;

    let stdout_handle = child
        .stdout
        .take()
        .map(|stdout| thread::spawn(move || read_limited_pipe(stdout, COMMAND_OUTPUT_LIMIT_BYTES)));
    let stderr_handle = child
        .stderr
        .take()
        .map(|stderr| thread::spawn(move || read_limited_pipe(stderr, COMMAND_OUTPUT_LIMIT_BYTES)));

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
                    break terminate_timed_out_child(&mut child)?;
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

fn validate_pty_input(
    workspace: &Path,
    pending_command: &mut String,
    input: &str,
    permission_approval: Option<&harness::permissions::ShellPermissionApproval>,
) -> Result<(), String> {
    let mut next_pending = pending_command.clone();

    for ch in input.chars() {
        match ch {
            '\u{3}' => next_pending.clear(),
            '\u{8}' | '\u{7f}' => {
                let _ = next_pending.pop();
            }
            '\r' | '\n' => {
                let command = next_pending.trim();
                if !command.is_empty() {
                    harness::permissions::PermissionGuard::from_workspace(workspace)
                        .and_then(|guard| {
                            guard.validate_with_approval(command, permission_approval)
                        })
                        .map_err(|error| error.to_string())?;
                }
                next_pending.clear();
            }
            '\t' => next_pending.push(' '),
            _ if !ch.is_control() => next_pending.push(ch),
            _ => {}
        }
    }

    *pending_command = next_pending;
    Ok(())
}

#[tauri::command]
async fn build_repository_index(
    state: State<'_, WorkspaceState>,
    workspace: Option<String>,
) -> Result<indexer::RepositoryIndex, String> {
    let workspace = resolve_workspace_root(&state, workspace)?;
    let (index, _) = indexer::RepositoryIndexer::new(&workspace)
        .build_and_store()
        .await?;
    Ok(index)
}

#[tauri::command]
async fn load_session_memory(
    state: State<'_, WorkspaceState>,
    workspace: Option<String>,
) -> Result<memory::SessionMemory, String> {
    let workspace = resolve_workspace_root(&state, workspace)?;
    let store = memory::SessionMemoryStore::for_workspace(&workspace);
    let memory = store.profile_repository(&workspace).await?;
    Ok(memory)
}

#[tauri::command]
async fn record_session_failure(
    state: State<'_, WorkspaceState>,
    step_id: String,
    tool_call: String,
    stderr: String,
    verification: String,
    workspace: Option<String>,
) -> Result<memory::ReflectionRecord, String> {
    let workspace = resolve_workspace_root(&state, workspace)?;
    let store = memory::SessionMemoryStore::for_workspace(&workspace);
    let (_, reflection) = store
        .record_failure(memory::failure_record(
            step_id,
            tool_call,
            stderr,
            verification,
        ))
        .await?;
    Ok(reflection)
}

#[tauri::command]
fn run_eval_harness(
    state: State<WorkspaceState>,
    workspace: Option<String>,
) -> Result<eval::EvalReport, String> {
    let workspace = resolve_workspace_root(&state, workspace)?;
    eval::EvalHarness::for_workspace(&workspace).run()
}

#[tauri::command]
async fn run_runtime_harness(
    state: State<'_, WorkspaceState>,
    request: runtime::harness_runner::RuntimeHarnessRequest,
    workspace: Option<String>,
) -> Result<runtime::harness_runner::RuntimeHarnessReport, String> {
    let workspace = resolve_workspace_root(&state, workspace)?;
    runtime::harness_runner::run_workspace_harness(&workspace, request).await
}

#[tauri::command]
fn create_multi_agent_plan(objective: String) -> Result<planner::MultiAgentPlan, String> {
    Ok(planner::PlannerAgent::new().plan(objective))
}

#[tauri::command]
fn list_mcp_tools() -> Result<Vec<mcp::McpToolDescriptor>, String> {
    Ok(mcp::McpRuntimeMesh::list_tools())
}

#[tauri::command]
async fn call_mcp_tool(
    state: State<'_, WorkspaceState>,
    call: mcp::McpToolCall,
    workspace: Option<String>,
) -> Result<mcp::McpToolResult, String> {
    let workspace = resolve_workspace_root(&state, workspace)?;
    let mesh = mcp::McpRuntimeMesh::for_workspace(&workspace)?;
    mesh.call_tool(call).await
}

#[tauri::command]
async fn execute_task_graph(
    state: State<'_, WorkspaceState>,
    graph: task_graph::TaskGraph,
    workspace: Option<String>,
) -> Result<task_graph::TaskGraphExecution, String> {
    let workspace = resolve_workspace_root(&state, workspace)?;
    let mesh = mcp::McpRuntimeMesh::for_workspace(&workspace)?;
    let runner = mcp::McpTaskGraphRunner::new(&mesh, graph.id.clone());
    executor::ExecutorAgent::new()
        .execute(&graph, &runner)
        .await
}

#[tauri::command]
fn review_task_graph_execution(
    execution: task_graph::TaskGraphExecution,
) -> Result<critic::CriticReport, String> {
    Ok(critic::CriticAgent::new().review_execution(&execution))
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
    let status_output = run_git_process(&repo_root, &["status", "--porcelain=v1"], timeout)?;

    if !status_output.success {
        return Ok(Vec::new());
    }

    let max_entries = 100;
    Ok(
        parse_git_porcelain_entries(&status_output.stdout, filter.as_deref())
            .into_iter()
            .take(max_entries)
            .map(|entry| GitFileEntry {
                path: entry.path,
                status: entry.status,
            })
            .collect(),
    )
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

    Ok(
        parse_git_porcelain_entries(&status_output.stdout, filter.as_deref())
            .into_iter()
            .filter(|entry| {
                requested_path
                    .as_ref()
                    .map(|path| {
                        entry.path == *path || entry.original_path.as_deref() == Some(path.as_str())
                    })
                    .unwrap_or(true)
            })
            .take(100)
            .map(|entry| build_git_diff_entry(&repo_root, entry, has_head, timeout))
            .collect(),
    )
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
                        let _ = app.emit(
                            "pty-data",
                            PtyDataPayload {
                                session_key: session_key.clone(),
                                chunk: text,
                            },
                        );
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
    Ok(canonicalize_workspace_dir(&path)?
        .to_string_lossy()
        .to_string())
}

#[tauri::command]
fn read_file(
    state: State<WorkspaceState>,
    path: String,
    workspace: Option<String>,
) -> Result<String, String> {
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

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct OpenFileExternalResult {
    path: String,
    opened: bool,
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
fn get_file_metadata(
    state: State<WorkspaceState>,
    path: String,
    workspace: Option<String>,
) -> Result<FileMetadata, String> {
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

fn resolve_open_file_external_path(path: &str, workspace: &Path) -> Result<PathBuf, String> {
    let real_path = resolve_existing_path(path, workspace)?;
    if !real_path.is_file() {
        return Err("open_file_external 目标不是文件".to_string());
    }
    Ok(real_path)
}

#[tauri::command]
fn open_file_external(
    app: AppHandle,
    state: State<WorkspaceState>,
    path: String,
    workspace: Option<String>,
) -> Result<OpenFileExternalResult, String> {
    let workspace = resolve_workspace_root(&state, workspace)?;
    let real_path = resolve_open_file_external_path(&path, &workspace)?;
    let open_path = real_path.to_string_lossy().to_string();
    app.opener()
        .open_path(open_path.clone(), None::<&str>)
        .map_err(|e| format!("无法使用系统默认应用打开文件：{e}"))?;

    Ok(OpenFileExternalResult {
        path: open_path,
        opened: true,
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

    let returned_start = if total_lines == 0 || selected.is_empty() {
        0
    } else {
        start.min(total_lines)
    };
    let returned_end = if total_lines == 0 || selected.is_empty() {
        0
    } else {
        returned_start + selected.len().saturating_sub(1)
    };
    let content = selected.join("\n");
    let not_whole_file = returned_start != 1 || returned_end != total_lines;
    let more_requested_lines =
        returned_end > 0 && returned_end < requested_end.min(total_lines.max(1));
    let more_file_lines = returned_end > 0 && returned_end < total_lines;
    let truncated = not_whole_file || more_requested_lines || more_file_lines || line_truncated;
    let next_start_line = if truncated
        && returned_end > 0
        && (more_file_lines || more_requested_lines || line_truncated)
    {
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
fn write_file(
    state: State<WorkspaceState>,
    path: String,
    content: String,
    workspace: Option<String>,
) -> Result<(), String> {
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
fn write_chat_temp_file(
    session_key: String,
    path: String,
    content: String,
) -> Result<String, String> {
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
    Ok(ensure_chat_temp_root(&session_key)?
        .to_string_lossy()
        .to_string())
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
fn ingest_attachment_file(
    session_key: String,
    source_path: String,
) -> Result<AttachmentIngestResult, String> {
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
        stable_project_hash(&format!(
            "{}:{}:{}",
            display_name,
            bytes.len(),
            now_millis()
        )),
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
    if index_path.exists() {
        if let Ok(index) = read_json_file(&index_path) {
            if let Some(sessions) = index.get("sessions").and_then(Value::as_array) {
                let mut index_sessions: Vec<Value> = sessions
                    .iter()
                    .map(|session| {
                        let session_id = session_id_from_object(session)
                            .unwrap_or_else(|_| "session".to_string());
                        annotate_session_meta(
                            session.clone(),
                            &project_id,
                            &workspace_root,
                            &session_dir(&project_root, &session_id),
                        )
                    })
                    .collect();
                sort_sessions_by_recent(&mut index_sessions);
                return Ok(index_sessions);
            }
        }
    }
    rebuild_sessions_index_for_project(&project_root, &project_id, &workspace_root)
}

#[tauri::command]
fn rebuild_project_sessions_index(app: AppHandle, workspace: String) -> Result<Vec<Value>, String> {
    let (project_root, project_id, workspace_root) = sessions_project_root(&app, &workspace)?;
    rebuild_sessions_index_for_project(&project_root, &project_id, &workspace_root)
}

#[tauri::command]
fn save_project_session(
    app: AppHandle,
    workspace: String,
    session: Value,
) -> Result<Value, String> {
    let (project_root, project_id, workspace_root) = sessions_project_root(&app, &workspace)?;
    let session_id = session_id_from_object(&session)?;
    let dir = session_dir(&project_root, &session_id);
    fs::create_dir_all(&dir).map_err(|e| format!("创建会话记录目录失败: {e}"))?;

    let mut meta = session
        .as_object()
        .cloned()
        .ok_or_else(|| "会话记录必须是对象".to_string())?;
    let messages = meta
        .remove("messages")
        .unwrap_or_else(|| Value::Array(Vec::new()));
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
    meta.insert(
        "turnCount".to_string(),
        Value::Number(turns_to_write.len().into()),
    );
    meta.insert(
        "messageCount".to_string(),
        Value::Number(messages_to_write.len().into()),
    );
    meta.insert("projectId".to_string(), Value::String(project_id.clone()));
    meta.insert(
        "workspaceRoot".to_string(),
        Value::String(workspace_root.clone()),
    );
    let updated_at_ms = meta
        .get("updatedAtMs")
        .and_then(|value| match value {
            Value::Number(number) => number.as_i64(),
            Value::String(text) => text.trim().parse::<i64>().ok(),
            _ => None,
        })
        .filter(|value| *value > 0);
    if let Some(value) = updated_at_ms {
        meta.insert("updatedAtMs".to_string(), Value::Number(value.into()));
    } else {
        meta.remove("updatedAtMs");
    }
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
fn load_project_session(
    app: AppHandle,
    workspace: String,
    session_id: Value,
) -> Result<Value, String> {
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
            Value::String(
                if messages_missing && runtime_missing {
                    "missing"
                } else {
                    "ok"
                }
                .to_string(),
            ),
        );
        let message_count = transcript.messages.len();
        let turn_count = transcript.turns.len();
        object.insert("messages".to_string(), Value::Array(transcript.messages));
        object.insert(
            "messageCount".to_string(),
            Value::Number(message_count.into()),
        );
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
fn load_project_session_meta(
    app: AppHandle,
    workspace: String,
    session_id: Value,
) -> Result<Value, String> {
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
        object.insert(
            "storageStatus".to_string(),
            Value::String(session_detail_status(&dir).to_string()),
        );
        object.insert("storageVersion".to_string(), Value::Number(2.into()));
        object.insert(
            "turnCount".to_string(),
            Value::Number(transcript.turns.len().into()),
        );
        object.insert(
            "messageCount".to_string(),
            Value::Number(transcript.messages.len().into()),
        );
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
        transcript
            .messages
            .clone()
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
        transcript
            .messages
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
fn delete_project_session(
    app: AppHandle,
    workspace: String,
    session_id: Value,
) -> Result<Vec<Value>, String> {
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
    "Library",
    "Logs",
    "obj",
    "bin",
    ".git",
    "node_modules",
    "Temp",
    "UserSettings",
    ".vs",
    "Build",
    "Builds",
    "dist",
    "out",
    "target",
    "coverage",
    "PackageCache",
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
    "cs", "asmdef", "asmref", "shader", "hlsl", "compute", "scene", "xlsx", "xls", "csv", "tsv",
    "pdf", "docx", "doc", "txt", "md", "json",
];
const SKELETON_BLACKLIST_EXT: &[&str] = &[
    "meta",
    "png",
    "fbx",
    "mat",
    "anim",
    "controller",
    "unitypackage",
    "asset",
];
const SKELETON_IGNORED_DIRS: &[&str] = &[
    "Library",
    "Logs",
    "obj",
    "bin",
    ".git",
    "node_modules",
    "Temp",
    "UserSettings",
    ".vs",
    "Build",
    "dist",
    "out",
    "target",
    "coverage",
    "PackageCache",
    ".protocols",
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
        if name == ".DS_Store" || should_skip_recursive_search_dir(&name) {
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
        if should_skip_recursive_search_dir(&name) || name == ".DS_Store" {
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

struct TreeNode {
    name: String,
    is_dir: bool,
    children: std::collections::BTreeMap<String, TreeNode>,
}

impl TreeNode {
    fn new(name: String, is_dir: bool) -> Self {
        Self {
            name,
            is_dir,
            children: std::collections::BTreeMap::new(),
        }
    }

    fn insert_path(&mut self, parts: &[&str], index: usize) {
        if index >= parts.len() {
            return;
        }
        let part = parts[index];
        let is_last = index == parts.len() - 1;
        let child = self.children.entry(part.to_string()).or_insert_with(|| {
            TreeNode::new(part.to_string(), !is_last)
        });
        if !is_last {
            child.is_dir = true;
            child.insert_path(parts, index + 1);
        }
    }

    fn render(&self, depth: usize, max_depth: usize, output: &mut String) {
        if depth > 0 {
            let indent = "  ".repeat(depth - 1);
            if self.is_dir {
                output.push_str(&format!("{}{}/\n", indent, self.name));
            } else {
                output.push_str(&format!("{}{}\n", indent, self.name));
            }
        }
        if depth >= max_depth && self.is_dir {
            let file_count = self.count_files_recursive();
            if file_count > 0 {
                let indent = "  ".repeat(depth);
                output.push_str(&format!("{}[... +{} files]\n", indent, file_count));
            }
            return;
        }
        let mut child_nodes: Vec<&TreeNode> = self.children.values().collect();
        child_nodes.sort_by(|a, b| match (a.is_dir, b.is_dir) {
            (true, false) => Ordering::Less,
            (false, true) => Ordering::Greater,
            _ => a.name.cmp(&b.name),
        });
        for child in child_nodes {
            child.render(depth + 1, max_depth, output);
        }
    }

    fn count_files_recursive(&self) -> usize {
        let mut count = 0;
        for child in self.children.values() {
            if child.is_dir {
                count += child.count_files_recursive();
            } else {
                count += 1;
            }
        }
        count
    }
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

    // 1. Try Git Index first
    let mut git_success = false;
    let timeout = Duration::from_millis(5000);
    if let Ok(output) = run_git_process(&workspace, &["ls-files"], timeout) {
        if output.success {
            let mut root = TreeNode::new("".to_string(), true);
            for line in output.stdout.lines() {
                let line = line.trim();
                if line.is_empty() {
                    continue;
                }
                let parts: Vec<&str> = line.split(|c| c == '/' || c == '\\').filter(|s| !s.is_empty()).collect();
                if !parts.is_empty() {
                    root.insert_path(&parts, 0);
                }
            }
            root.render(0, max_depth, &mut tree);
            git_success = true;
        }
    }

    // 2. Fall back to Native Walker if not a Git repo or Git fails
    if !git_success {
        build_skeleton_tree(&workspace, 0, max_depth, 0, &mut tree);
    }

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
    } else {
        apply_login_shell_args(&mut cmd, &shell);
    }
    apply_pty_terminal_env(&mut cmd);
    let root = resolve_workspace_root(&workspace_state, workspace)?;
    cmd.cwd(&root);
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

    guard.insert(
        key,
        PtySession {
            master: pair.master,
            writer: shared_writer,
            buffer: shared_buffer,
            child,
            workspace: root,
            pending_command: String::new(),
        },
    );

    Ok(())
}

#[tauri::command]
fn resize_pty(
    state: State<PtyManager>,
    cols: u16,
    rows: u16,
    session_key: Option<String>,
) -> Result<(), String> {
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
fn write_pty(
    state: State<PtyManager>,
    input: String,
    session_key: Option<String>,
    permission_approval: Option<harness::permissions::ShellPermissionApproval>,
    user_terminal: Option<bool>,
) -> Result<(), String> {
    let mut guard = state
        .sessions
        .lock()
        .map_err(|_| "无法获取 PTY 会话锁".to_string())?;
    let key = normalize_pty_session_key(session_key);
    let session = guard
        .get_mut(&key)
        .ok_or_else(|| "PTY 尚未启动，请先调用 spawn_pty".to_string())?;
    if user_terminal != Some(true) {
        validate_pty_input(
            &session.workspace,
            &mut session.pending_command,
            &input,
            permission_approval.as_ref(),
        )?;
    } else {
        session.pending_command.clear();
    }
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
fn clear_pty_buffer(
    state: State<PtyManager>,
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
fn get_pty_status(
    state: State<PtyManager>,
    session_key: Option<String>,
) -> Result<PtyStatus, String> {
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
    permission_approval: Option<harness::permissions::ShellPermissionApproval>,
) -> Result<TerminalCommandOutput, String> {
    let workspace = resolve_workspace_root(&state, workspace)?;
    let timeout = Duration::from_millis(timeout_ms.unwrap_or(60_000).clamp(100, 600_000));
    run_workspace_shell_command(&workspace, command, input, timeout, permission_approval)
}

#[tauri::command]
fn browser_evaluate(
    state: State<WorkspaceState>,
    url: String,
    actions: Option<String>,
    checks: Option<String>,
    wait_for_text: Option<String>,
    wait_for_selector: Option<String>,
    screenshot: Option<bool>,
    fail_on_console_error: Option<bool>,
    timeout_ms: Option<u64>,
    workspace: Option<String>,
) -> Result<Value, String> {
    let workspace = resolve_workspace_root(&state, workspace)?;
    let script_path = browser_validation_script_path();
    if !script_path.exists() {
        return Err(format!(
            "browser_evaluate script not found: {}",
            script_path.display()
        ));
    }
    let node_path = resolve_node_executable().ok_or_else(|| {
        "browser_evaluate requires Node.js so it can run the bundled Playwright validation runtime."
            .to_string()
    })?;

    let timeout = Duration::from_millis(timeout_ms.unwrap_or(60_000).clamp(1_000, 180_000));
    let payload = json!({
        "url": url,
        "actions": actions.unwrap_or_default(),
        "checks": checks.unwrap_or_default(),
        "waitForText": wait_for_text,
        "waitForSelector": wait_for_selector,
        "screenshot": screenshot.unwrap_or(false),
        "failOnConsoleError": fail_on_console_error.unwrap_or(true),
        "timeoutMs": timeout.as_millis() as u64,
    });

    let mut command = ProcessCommand::new(&node_path);
    command
        .arg(script_path)
        .current_dir(&workspace)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    isolate_process_group(&mut command);

    let mut child = command
        .spawn()
        .map_err(|e| format!("启动 browser_evaluate 失败: {e}"))?;

    let stdout_handle = child
        .stdout
        .take()
        .map(|stdout| thread::spawn(move || read_limited_pipe(stdout, COMMAND_OUTPUT_LIMIT_BYTES)));
    let stderr_handle = child
        .stderr
        .take()
        .map(|stderr| thread::spawn(move || read_limited_pipe(stderr, COMMAND_OUTPUT_LIMIT_BYTES)));

    if let Some(stdin) = child.stdin.as_mut() {
        let input = serde_json::to_string(&payload)
            .map_err(|e| format!("序列化 browser_evaluate 输入失败: {e}"))?;
        stdin
            .write_all(input.as_bytes())
            .map_err(|e| format!("写入 browser_evaluate 输入失败: {e}"))?;
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
                    break terminate_timed_out_child(&mut child)?;
                }
                thread::sleep(Duration::from_millis(10));
            }
            Err(e) => return Err(format!("等待 browser_evaluate 结束失败: {e}")),
        }
    };

    let stdout = join_captured_pipe(stdout_handle, "browser_evaluate stdout")?;
    let stderr = join_captured_pipe(stderr_handle, "browser_evaluate stderr")?;
    let stdout_text = stdout.text.trim();
    let stderr_text = stderr.text.trim();

    if timed_out {
        return Err(format!(
            "browser_evaluate timed out after {}ms{}",
            timeout.as_millis(),
            if stderr_text.is_empty() {
                String::new()
            } else {
                format!(": {stderr_text}")
            }
        ));
    }

    if !status.success() {
        return Err(format!(
            "browser_evaluate exited with code {:?}. stdout: {} stderr: {}",
            status.code(),
            stdout_text,
            stderr_text
        ));
    }

    if stdout_text.is_empty() {
        return Err(format!(
            "browser_evaluate produced no JSON result{}",
            if stderr_text.is_empty() {
                String::new()
            } else {
                format!("; stderr: {stderr_text}")
            }
        ));
    }

    serde_json::from_str::<Value>(stdout_text)
        .map_err(|e| format!("browser_evaluate returned invalid JSON: {e}; stdout: {stdout_text}"))
}

#[tauri::command]
fn shell_permission_preflight(
    state: State<WorkspaceState>,
    command: String,
    workspace: Option<String>,
) -> Result<harness::permissions::PermissionDecision, String> {
    let workspace = resolve_workspace_root(&state, workspace)?;
    let trimmed = command.trim();
    if trimmed.is_empty() {
        return Err("命令不能为空".to_string());
    }
    harness::permissions::PermissionGuard::from_workspace(&workspace)
        .map(|guard| guard.inspect(trimmed))
        .map_err(|error| error.to_string())
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

// region: 云端账号 OAuth 登录与安全存储

const CLOUD_AUTH_FILE_NAME: &str = "cloud-auth.json";
const CLOUD_AUTH_REFRESH_SKEW_MS: u64 = 60_000;
const OPENAI_CHATGPT_CODEX_ENDPOINT: &str = "https://chatgpt.com/backend-api/codex/responses";
const GEMINI_CODE_ASSIST_ENDPOINT: &str =
    "https://cloudcode-pa.googleapis.com/v1internal:generateContent";
const GEMINI_CODE_ASSIST_LOAD_ENDPOINT: &str =
    "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist";
const GEMINI_CODE_ASSIST_ONBOARD_ENDPOINT: &str =
    "https://cloudcode-pa.googleapis.com/v1internal:onboardUser";
const GEMINI_CODE_ASSIST_OPERATIONS_ENDPOINT: &str =
    "https://cloudcode-pa.googleapis.com/v1internal";
const GEMINI_CODE_ASSIST_CLIENT_IDE_TYPE: &str = "IDE_UNSPECIFIED";
const GEMINI_CODE_ASSIST_CLIENT_PLATFORM: &str = "PLATFORM_UNSPECIFIED";
const GEMINI_CODE_ASSIST_CLIENT_PLUGIN_TYPE: &str = "GEMINI";
const OPENAI_OAUTH_CLIENT_ID: &str = "app_EMoamEEZ73f0CkXaXp7hrann";
const OPENAI_OAUTH_ISSUER: &str = "https://auth.openai.com";
const OPENAI_OAUTH_PREFERRED_PORT: u16 = 1455;
const GEMINI_OAUTH_CLIENT_ID: &str =
    "681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com";
const GEMINI_OAUTH_CLIENT_SECRET: &str = "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";
const CLOUD_AUTH_KEYCHAIN_SERVICE: &str = "MAIN Cloud Auth";

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CloudAuthPublicStatus {
    mode: String,
    status: String,
    token_ref: Option<String>,
    account_id: Option<String>,
    email: Option<String>,
    expires_at: Option<u64>,
    storage: Option<String>,
    message: Option<String>,
    project_id: Option<String>,
    tier: Option<String>,
    onboarded: Option<bool>,
    code_assist_message: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CloudAuthBeginResult {
    session_id: String,
    provider: String,
    mode: String,
    auth_url: String,
    redirect_uri: String,
    expires_at: u64,
    browser_opened: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredCloudToken {
    provider: String,
    mode: String,
    token_ref: String,
    access_token: String,
    refresh_token: Option<String>,
    id_token: Option<String>,
    expires_at: u64,
    account_id: Option<String>,
    email: Option<String>,
    project_id: Option<String>,
    tier: Option<String>,
    onboarded: Option<bool>,
    code_assist_message: Option<String>,
    storage: String,
    message: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredCloudTokenSecrets {
    access_token: String,
    refresh_token: Option<String>,
    id_token: Option<String>,
}

#[derive(Default, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CloudAuthStore {
    records: HashMap<String, StoredCloudToken>,
}

#[derive(Default, Clone, Debug)]
struct PendingCloudAuthCallback {
    code: Option<String>,
    error: Option<String>,
}

#[derive(Clone, Debug)]
struct PendingCloudAuth {
    session_id: String,
    provider: String,
    mode: String,
    server_id: Option<String>,
    verifier: String,
    redirect_uri: String,
    started_at_ms: u64,
    callback: Arc<Mutex<PendingCloudAuthCallback>>,
}

static CLOUD_AUTH_PENDING: OnceLock<Mutex<HashMap<String, PendingCloudAuth>>> = OnceLock::new();

fn cloud_auth_pending() -> &'static Mutex<HashMap<String, PendingCloudAuth>> {
    CLOUD_AUTH_PENDING.get_or_init(|| Mutex::new(HashMap::new()))
}

fn normalize_cloud_auth_mode(mode: &str) -> &str {
    match mode {
        "openai_chatgpt_oauth" => "openai_chatgpt_oauth",
        "gemini_google_oauth" => "gemini_google_oauth",
        _ => "api_key",
    }
}

fn normalize_cloud_auth_provider(provider: &str, mode: &str) -> String {
    let normalized = provider.trim().to_ascii_lowercase();
    if normalized.contains("gemini") || mode == "gemini_google_oauth" {
        "gemini".to_string()
    } else {
        "openai".to_string()
    }
}

fn random_urlsafe_bytes(byte_len: usize) -> String {
    let mut bytes = vec![0u8; byte_len];
    OsRng.fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

fn random_pkce_verifier() -> String {
    (&mut OsRng)
        .sample_iter(&Alphanumeric)
        .take(64)
        .map(char::from)
        .collect()
}

fn pkce_challenge(verifier: &str) -> String {
    let digest = Sha256::digest(verifier.as_bytes());
    URL_SAFE_NO_PAD.encode(digest)
}

fn cloud_auth_file_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("解析云端登录存储目录失败: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("创建云端登录存储目录失败: {e}"))?;
    Ok(dir.join(CLOUD_AUTH_FILE_NAME))
}

fn load_cloud_auth_store(app: &AppHandle) -> Result<CloudAuthStore, String> {
    let path = cloud_auth_file_path(app)?;
    if !path.exists() {
        return Ok(CloudAuthStore::default());
    }
    let content = fs::read_to_string(&path).map_err(|e| format!("读取云端登录存储失败: {e}"))?;
    serde_json::from_str(&content).map_err(|e| format!("解析云端登录存储失败: {e}"))
}

fn save_cloud_auth_store(app: &AppHandle, store: &CloudAuthStore) -> Result<(), String> {
    let path = cloud_auth_file_path(app)?;
    let content =
        serde_json::to_string_pretty(store).map_err(|e| format!("序列化云端登录存储失败: {e}"))?;
    write_text_atomic(&path, &(content + "\n"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut permissions = fs::metadata(&path)
            .map_err(|e| format!("读取云端登录存储权限失败: {e}"))?
            .permissions();
        permissions.set_mode(0o600);
        fs::set_permissions(&path, permissions)
            .map_err(|e| format!("设置云端登录存储权限失败: {e}"))?;
    }
    Ok(())
}

fn cloud_token_secrets(record: &StoredCloudToken) -> StoredCloudTokenSecrets {
    StoredCloudTokenSecrets {
        access_token: record.access_token.clone(),
        refresh_token: record.refresh_token.clone(),
        id_token: record.id_token.clone(),
    }
}

fn clear_record_secrets_for_keychain(record: &mut StoredCloudToken) {
    record.access_token.clear();
    record.refresh_token = None;
    record.id_token = None;
}

fn apply_token_secrets(record: &mut StoredCloudToken, secrets: StoredCloudTokenSecrets) {
    record.access_token = secrets.access_token;
    record.refresh_token = secrets.refresh_token;
    record.id_token = secrets.id_token;
}

#[cfg(target_os = "macos")]
fn save_cloud_token_to_keychain(
    token_ref: &str,
    secrets: &StoredCloudTokenSecrets,
) -> Result<(), String> {
    let payload =
        serde_json::to_vec(secrets).map_err(|e| format!("序列化 Keychain token 失败: {e}"))?;
    security_framework::passwords::set_generic_password(
        CLOUD_AUTH_KEYCHAIN_SERVICE,
        token_ref,
        &payload,
    )
    .map_err(|e| format!("写入 macOS Keychain 失败: {e}"))?;
    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn save_cloud_token_to_keychain(
    _token_ref: &str,
    _secrets: &StoredCloudTokenSecrets,
) -> Result<(), String> {
    Err("当前平台没有可用的 OS keychain 适配。".to_string())
}

#[cfg(target_os = "macos")]
fn load_cloud_token_from_keychain(token_ref: &str) -> Result<StoredCloudTokenSecrets, String> {
    let payload =
        security_framework::passwords::get_generic_password(CLOUD_AUTH_KEYCHAIN_SERVICE, token_ref)
            .map_err(|e| format!("读取 macOS Keychain 失败: {e}"))?;
    serde_json::from_slice(&payload).map_err(|e| format!("解析 Keychain token 失败: {e}"))
}

#[cfg(not(target_os = "macos"))]
fn load_cloud_token_from_keychain(_token_ref: &str) -> Result<StoredCloudTokenSecrets, String> {
    Err("当前平台没有可用的 OS keychain 适配。".to_string())
}

#[cfg(target_os = "macos")]
fn delete_cloud_token_from_keychain(token_ref: &str) -> Result<(), String> {
    match security_framework::passwords::delete_generic_password(
        CLOUD_AUTH_KEYCHAIN_SERVICE,
        token_ref,
    ) {
        Ok(()) => Ok(()),
        Err(err) => {
            let message = err.to_string();
            if message.contains("-25300") || message.contains("ItemNotFound") {
                Ok(())
            } else {
                Err(format!("删除 macOS Keychain token 失败: {err}"))
            }
        }
    }
}

#[cfg(not(target_os = "macos"))]
fn delete_cloud_token_from_keychain(_token_ref: &str) -> Result<(), String> {
    Ok(())
}

fn record_with_loaded_secrets(record: &StoredCloudToken) -> Result<StoredCloudToken, String> {
    if record.storage == "keychain" {
        let mut loaded = record.clone();
        let secrets = load_cloud_token_from_keychain(&record.token_ref)?;
        apply_token_secrets(&mut loaded, secrets);
        return Ok(loaded);
    }
    Ok(record.clone())
}

fn store_cloud_auth_record(
    app: &AppHandle,
    record: &StoredCloudToken,
) -> Result<StoredCloudToken, String> {
    let mut persisted = record.clone();
    let secrets = cloud_token_secrets(record);
    match save_cloud_token_to_keychain(&record.token_ref, &secrets) {
        Ok(()) => {
            clear_record_secrets_for_keychain(&mut persisted);
            persisted.storage = "keychain".to_string();
            persisted.message = Some("Stored in the operating system keychain.".to_string());
        }
        Err(err) => {
            persisted.storage = "file".to_string();
            persisted.message = Some(format!(
                "Keychain unavailable ({err}); stored in app data with 0600 file permissions."
            ));
        }
    }

    let mut store = load_cloud_auth_store(app)?;
    store
        .records
        .insert(persisted.token_ref.clone(), persisted.clone());
    save_cloud_auth_store(app, &store)?;
    Ok(record_with_loaded_secrets(&persisted).unwrap_or(persisted))
}

fn cloud_auth_status_from_record(record: &StoredCloudToken) -> CloudAuthPublicStatus {
    let status = if record.expires_at <= now_millis() {
        "expired"
    } else {
        "connected"
    };
    CloudAuthPublicStatus {
        mode: record.mode.clone(),
        status: status.to_string(),
        token_ref: Some(record.token_ref.clone()),
        account_id: record.account_id.clone(),
        email: record.email.clone(),
        expires_at: Some(record.expires_at),
        storage: Some(record.storage.clone()),
        message: record.message.clone(),
        project_id: record.project_id.clone(),
        tier: record.tier.clone(),
        onboarded: record.onboarded,
        code_assist_message: record.code_assist_message.clone(),
    }
}

fn disconnected_cloud_auth_status(mode: &str, message: Option<String>) -> CloudAuthPublicStatus {
    CloudAuthPublicStatus {
        mode: normalize_cloud_auth_mode(mode).to_string(),
        status: "disconnected".to_string(),
        token_ref: None,
        account_id: None,
        email: None,
        expires_at: None,
        storage: None,
        message,
        project_id: None,
        tier: None,
        onboarded: None,
        code_assist_message: None,
    }
}

fn pending_cloud_auth_status(pending: &PendingCloudAuth) -> CloudAuthPublicStatus {
    CloudAuthPublicStatus {
        mode: pending.mode.clone(),
        status: "pending".to_string(),
        token_ref: pending
            .server_id
            .clone()
            .or_else(|| Some(pending.session_id.clone())),
        account_id: None,
        email: None,
        expires_at: Some(pending.started_at_ms + 5 * 60 * 1000),
        storage: None,
        message: Some("Browser authorization is still pending.".to_string()),
        project_id: None,
        tier: None,
        onboarded: None,
        code_assist_message: None,
    }
}

fn parse_jwt_claims(token: &str) -> Option<Value> {
    let payload = token.split('.').nth(1)?;
    let decoded = URL_SAFE_NO_PAD
        .decode(payload)
        .or_else(|_| base64::engine::general_purpose::URL_SAFE.decode(payload))
        .ok()?;
    serde_json::from_slice(&decoded).ok()
}

fn extract_openai_account_id(claims: &Value) -> Option<String> {
    claims
        .get("chatgpt_account_id")
        .and_then(Value::as_str)
        .or_else(|| {
            claims
                .get("https://api.openai.com/auth")
                .and_then(Value::as_object)
                .and_then(|auth| auth.get("chatgpt_account_id"))
                .and_then(Value::as_str)
        })
        .or_else(|| {
            claims
                .get("organizations")
                .and_then(Value::as_array)
                .and_then(|orgs| orgs.first())
                .and_then(|org| org.get("id"))
                .and_then(Value::as_str)
        })
        .map(str::to_string)
}

fn extract_claim_string(claims: &Value, key: &str) -> Option<String> {
    claims.get(key).and_then(Value::as_str).map(str::to_string)
}

fn build_openai_oauth_url(
    redirect_uri: &str,
    challenge: &str,
    state: &str,
) -> Result<String, String> {
    let mut url = url::Url::parse(&format!("{OPENAI_OAUTH_ISSUER}/oauth/authorize"))
        .map_err(|e| format!("构建 OpenAI 登录地址失败: {e}"))?;
    url.query_pairs_mut()
        .append_pair("response_type", "code")
        .append_pair("client_id", OPENAI_OAUTH_CLIENT_ID)
        .append_pair("redirect_uri", redirect_uri)
        .append_pair("scope", "openid profile email offline_access")
        .append_pair("code_challenge", challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("id_token_add_organizations", "true")
        .append_pair("codex_cli_simplified_flow", "true")
        .append_pair("originator", "main")
        .append_pair("state", state);
    Ok(url.to_string())
}

fn build_gemini_oauth_url(
    redirect_uri: &str,
    challenge: &str,
    state: &str,
) -> Result<String, String> {
    let mut url = url::Url::parse("https://accounts.google.com/o/oauth2/v2/auth")
        .map_err(|e| format!("构建 Gemini 登录地址失败: {e}"))?;
    url.query_pairs_mut()
        .append_pair("response_type", "code")
        .append_pair("client_id", GEMINI_OAUTH_CLIENT_ID)
        .append_pair("redirect_uri", redirect_uri)
        .append_pair(
            "scope",
            "https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/generative-language https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile",
        )
        .append_pair("access_type", "offline")
        .append_pair("prompt", "consent")
        .append_pair("code_challenge", challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("state", state);
    Ok(url.to_string())
}

fn bind_oauth_listener(mode: &str) -> Result<(TcpListener, u16), String> {
    if mode == "openai_chatgpt_oauth" {
        if let Ok(listener) = TcpListener::bind(("127.0.0.1", OPENAI_OAUTH_PREFERRED_PORT)) {
            return Ok((listener, OPENAI_OAUTH_PREFERRED_PORT));
        }
    }
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .map_err(|e| format!("启动本地登录回调服务失败: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("读取本地登录回调端口失败: {e}"))?
        .port();
    Ok((listener, port))
}

fn oauth_success_html() -> &'static str {
    "<!doctype html><html><head><meta charset=\"utf-8\"><title>MAIN authorization complete</title></head><body style=\"font-family:system-ui,sans-serif;background:#09090b;color:#f4f4f5;display:grid;place-items:center;min-height:100vh;margin:0\"><main style=\"text-align:center\"><h1>Authorization complete</h1><p>You can close this window and return to MAIN.</p><script>setTimeout(()=>window.close(),1600)</script></main></body></html>"
}

fn oauth_error_html(message: &str) -> String {
    format!(
        "<!doctype html><html><head><meta charset=\"utf-8\"><title>MAIN authorization failed</title></head><body style=\"font-family:system-ui,sans-serif;background:#09090b;color:#f4f4f5;display:grid;place-items:center;min-height:100vh;margin:0\"><main style=\"text-align:center;max-width:640px\"><h1 style=\"color:#fca5a5\">Authorization failed</h1><p>{}</p></main></body></html>",
        message.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;"),
    )
}

fn write_oauth_response(stream: &mut std::net::TcpStream, status: &str, body: String) {
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.as_bytes().len(),
        body,
    );
    let _ = stream.write_all(response.as_bytes());
    let _ = stream.flush();
}

fn spawn_oauth_callback_listener(
    listener: TcpListener,
    expected_path: String,
    expected_state: String,
    callback: Arc<Mutex<PendingCloudAuthCallback>>,
) {
    thread::spawn(move || {
        let Ok((mut stream, _)) = listener.accept() else {
            return;
        };
        let mut buffer = [0u8; 4096];
        let read_len = stream.read(&mut buffer).unwrap_or(0);
        let request = String::from_utf8_lossy(&buffer[..read_len]);
        let request_target = request
            .lines()
            .next()
            .and_then(|line| line.split_whitespace().nth(1))
            .unwrap_or("/");
        let parsed = url::Url::parse(&format!("http://localhost{request_target}"));
        let mut status = "200 OK";
        let mut html = oauth_success_html().to_string();

        match parsed {
            Ok(url) if url.path() == expected_path => {
                let code = url
                    .query_pairs()
                    .find(|(key, _)| key == "code")
                    .map(|(_, value)| value.to_string());
                let state = url
                    .query_pairs()
                    .find(|(key, _)| key == "state")
                    .map(|(_, value)| value.to_string());
                let error = url
                    .query_pairs()
                    .find(|(key, _)| key == "error_description")
                    .or_else(|| url.query_pairs().find(|(key, _)| key == "error"))
                    .map(|(_, value)| value.to_string());
                let mut slot = callback
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                if let Some(message) = error {
                    slot.error = Some(message.clone());
                    status = "400 Bad Request";
                    html = oauth_error_html(&message);
                } else if state.as_deref() != Some(expected_state.as_str()) {
                    let message = "Invalid OAuth state.".to_string();
                    slot.error = Some(message.clone());
                    status = "400 Bad Request";
                    html = oauth_error_html(&message);
                } else if let Some(code) = code {
                    slot.code = Some(code);
                } else {
                    let message = "Missing authorization code.".to_string();
                    slot.error = Some(message.clone());
                    status = "400 Bad Request";
                    html = oauth_error_html(&message);
                }
            }
            _ => {
                status = "404 Not Found";
                html = oauth_error_html("Unknown OAuth callback path.");
            }
        }

        write_oauth_response(&mut stream, status, html);
    });
}

async fn fetch_gemini_userinfo(access_token: &str) -> (Option<String>, Option<String>) {
    let client = reqwest::Client::new();
    let result = client
        .get("https://www.googleapis.com/oauth2/v2/userinfo")
        .bearer_auth(access_token)
        .send()
        .await;
    let Ok(response) = result else {
        return (None, None);
    };
    let Ok(payload_text) = response.text().await else {
        return (None, None);
    };
    let Ok(payload) = serde_json::from_str::<Value>(&payload_text) else {
        return (None, None);
    };
    (
        extract_claim_string(&payload, "id").or_else(|| extract_claim_string(&payload, "sub")),
        extract_claim_string(&payload, "email"),
    )
}

fn extract_gemini_code_assist_project(payload: &Value) -> Option<String> {
    payload
        .pointer("/cloudaicompanionProject")
        .and_then(Value::as_str)
        .or_else(|| {
            payload
                .pointer("/cloudaicompanionProject/id")
                .and_then(Value::as_str)
        })
        .or_else(|| {
            payload
                .pointer("/response/cloudaicompanionProject")
                .and_then(Value::as_str)
        })
        .or_else(|| {
            payload
                .pointer("/response/cloudaicompanionProject/id")
                .and_then(Value::as_str)
        })
        .or_else(|| payload.pointer("/project").and_then(Value::as_str))
        .or_else(|| payload.pointer("/response/project").and_then(Value::as_str))
        .or_else(|| {
            payload
                .pointer("/metadata/cloudaicompanionProject")
                .and_then(Value::as_str)
        })
        .map(str::to_string)
}

fn extract_gemini_code_assist_tier(payload: &Value) -> Option<String> {
    payload
        .pointer("/paidTier/id")
        .and_then(Value::as_str)
        .or_else(|| {
            payload
                .pointer("/response/paidTier/id")
                .and_then(Value::as_str)
        })
        .or_else(|| payload.pointer("/currentTier/id").and_then(Value::as_str))
        .or_else(|| payload.pointer("/tier/id").and_then(Value::as_str))
        .or_else(|| {
            payload
                .pointer("/response/currentTier/id")
                .and_then(Value::as_str)
        })
        .or_else(|| payload.pointer("/response/tier/id").and_then(Value::as_str))
        .map(str::to_string)
}

fn gemini_code_assist_metadata(project_id: Option<&str>) -> Value {
    let mut metadata = json!({
        "ideType": GEMINI_CODE_ASSIST_CLIENT_IDE_TYPE,
        "platform": GEMINI_CODE_ASSIST_CLIENT_PLATFORM,
        "pluginType": GEMINI_CODE_ASSIST_CLIENT_PLUGIN_TYPE,
    });
    if let Some(project_id) = project_id.filter(|value| !value.trim().is_empty()) {
        if let Some(object) = metadata.as_object_mut() {
            object.insert(
                "duetProject".to_string(),
                Value::String(project_id.to_string()),
            );
        }
    }
    metadata
}

fn gemini_code_assist_load_body(project_id: Option<&str>) -> Value {
    json!({
        "cloudaicompanionProject": project_id,
        "metadata": gemini_code_assist_metadata(project_id),
    })
}

fn gemini_code_assist_onboard_body(tier_id: &str, project_id: Option<&str>) -> Value {
    let is_free_tier = tier_id == "free-tier";
    json!({
        "tierId": tier_id,
        "cloudaicompanionProject": if is_free_tier { None } else { project_id },
        "metadata": gemini_code_assist_metadata(if is_free_tier { None } else { project_id }),
    })
}

fn extract_gemini_code_assist_onboard_tier(payload: &Value) -> Option<String> {
    payload
        .pointer("/allowedTiers")
        .and_then(Value::as_array)
        .and_then(|tiers| {
            tiers
                .iter()
                .find(|tier| {
                    tier.get("isDefault")
                        .and_then(Value::as_bool)
                        .unwrap_or(false)
                })
                .or_else(|| tiers.first())
        })
        .and_then(|tier| tier.get("id").and_then(Value::as_str))
        .map(str::to_string)
        .or_else(|| Some("legacy-tier".to_string()))
}

fn extract_gemini_code_assist_ineligible_message(payload: &Value) -> Option<String> {
    let tiers = payload
        .pointer("/ineligibleTiers")
        .and_then(Value::as_array)?;
    let messages = tiers
        .iter()
        .filter_map(|tier| {
            tier.get("reasonMessage")
                .and_then(Value::as_str)
                .or_else(|| tier.get("validationErrorMessage").and_then(Value::as_str))
        })
        .filter(|value| !value.trim().is_empty())
        .collect::<Vec<_>>();
    if messages.is_empty() {
        None
    } else {
        Some(messages.join(" "))
    }
}

async fn poll_gemini_code_assist_operation(
    client: &reqwest::Client,
    access_token: &str,
    operation_name: &str,
) -> Result<Value, String> {
    let trimmed_name = operation_name.trim().trim_start_matches('/');
    if trimmed_name.is_empty() {
        return Err("Gemini Code Assist operation name is empty.".to_string());
    }
    let endpoint = format!(
        "{}/{}",
        GEMINI_CODE_ASSIST_OPERATIONS_ENDPOINT, trimmed_name
    );
    let mut last_payload = json!({});
    for _ in 0..6 {
        tokio::time::sleep(Duration::from_secs(2)).await;
        let response = client
            .get(&endpoint)
            .bearer_auth(access_token)
            .header("Content-Type", "application/json")
            .send()
            .await
            .map_err(|e| format!("Gemini Code Assist operation 查询失败: {e}"))?;
        let status = response.status();
        let payload_text = response
            .text()
            .await
            .map_err(|e| format!("读取 Gemini Code Assist operation 响应失败: {e}"))?;
        let payload = serde_json::from_str::<Value>(&payload_text)
            .unwrap_or_else(|_| json!({ "raw": payload_text }));
        if !status.is_success() {
            return Err(format!(
                "Gemini Code Assist operation HTTP {status}: {}",
                payload
            ));
        }
        if payload
            .get("done")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            return Ok(payload);
        }
        last_payload = payload;
    }
    Ok(last_payload)
}

async fn post_gemini_code_assist_json(
    client: &reqwest::Client,
    endpoint: &str,
    access_token: &str,
    body: Value,
) -> Result<Value, String> {
    let body_text = serde_json::to_string(&body)
        .map_err(|e| format!("序列化 Gemini Code Assist 请求失败: {e}"))?;
    let response = client
        .post(endpoint)
        .bearer_auth(access_token)
        .header("Content-Type", "application/json")
        .body(body_text)
        .send()
        .await
        .map_err(|e| format!("Gemini Code Assist 请求失败: {e}"))?;
    let status = response.status();
    let payload_text = response
        .text()
        .await
        .map_err(|e| format!("读取 Gemini Code Assist 响应失败: {e}"))?;
    let payload = serde_json::from_str::<Value>(&payload_text)
        .unwrap_or_else(|_| json!({ "raw": payload_text }));
    if !status.is_success() {
        return Err(format!("Gemini Code Assist HTTP {status}: {}", payload));
    }
    Ok(payload)
}

async fn initialize_gemini_code_assist_record(mut record: StoredCloudToken) -> StoredCloudToken {
    if record.mode != "gemini_google_oauth" || record.project_id.is_some() {
        return record;
    }
    let project_override = std::env::var("GOOGLE_CLOUD_PROJECT")
        .ok()
        .or_else(|| std::env::var("GOOGLE_CLOUD_PROJECT_ID").ok())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let project_override_ref = project_override.as_deref();

    let Ok(client) = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(HTTP_CONNECT_TIMEOUT_SECS))
        .timeout(Duration::from_secs(HTTP_SHORT_TIMEOUT_SECS))
        .build()
    else {
        record.onboarded = Some(false);
        record.code_assist_message =
            Some("Could not create Gemini Code Assist client.".to_string());
        return record;
    };

    match post_gemini_code_assist_json(
        &client,
        GEMINI_CODE_ASSIST_LOAD_ENDPOINT,
        &record.access_token,
        gemini_code_assist_load_body(project_override_ref),
    )
    .await
    {
        Ok(payload) => {
            record.project_id =
                extract_gemini_code_assist_project(&payload).or_else(|| project_override.clone());
            record.tier = extract_gemini_code_assist_tier(&payload);
            if record.project_id.is_some() {
                record.onboarded = Some(true);
                record.code_assist_message = Some("Gemini Code Assist project loaded.".to_string());
                return record;
            }
            if record.code_assist_message.is_none() {
                record.code_assist_message =
                    extract_gemini_code_assist_ineligible_message(&payload);
            }
            let Some(tier_id) = extract_gemini_code_assist_onboard_tier(&payload) else {
                record.onboarded = Some(false);
                record.code_assist_message =
                    Some(record.code_assist_message.unwrap_or_else(|| {
                        "Gemini Code Assist requires GOOGLE_CLOUD_PROJECT for this account."
                            .to_string()
                    }));
                return record;
            };

            match post_gemini_code_assist_json(
                &client,
                GEMINI_CODE_ASSIST_ONBOARD_ENDPOINT,
                &record.access_token,
                gemini_code_assist_onboard_body(&tier_id, project_override_ref),
            )
            .await
            {
                Ok(mut payload) => {
                    if !payload.get("done").and_then(Value::as_bool).unwrap_or(true) {
                        if let Some(name) = payload.get("name").and_then(Value::as_str) {
                            if let Ok(polled_payload) = poll_gemini_code_assist_operation(
                                &client,
                                &record.access_token,
                                name,
                            )
                            .await
                            {
                                payload = polled_payload;
                            }
                        }
                    }
                    record.project_id = extract_gemini_code_assist_project(&payload)
                        .or_else(|| project_override.clone());
                    record.tier = Some(tier_id);
                    record.onboarded = Some(record.project_id.is_some());
                    record.code_assist_message = Some(if record.project_id.is_some() {
                        "Gemini Code Assist onboarding completed.".to_string()
                    } else {
                        "Gemini Code Assist onboarding did not return a project.".to_string()
                    });
                }
                Err(err) => {
                    record.onboarded = Some(false);
                    record.code_assist_message = Some(err);
                }
            }
        }
        Err(err) => {
            record.onboarded = Some(false);
            record.code_assist_message = Some(err);
        }
    }
    record
}

fn classify_gemini_code_assist_error(status: reqwest::StatusCode, body: &str) -> String {
    let body_excerpt = body.chars().take(500).collect::<String>();
    if body.contains("SERVICE_DISABLED")
        || body.contains("Cloud Code Private API has not been used")
    {
        return format!(
            "Gemini Code Assist 请求使用的 Google Cloud Project 未启用 Cloud Code Private API。请在 Google Cloud Console 启用 cloudcode-pa.googleapis.com，或清除 GOOGLE_CLOUD_PROJECT / GOOGLE_CLOUD_PROJECT_ID 后重新登录让 Code Assist 使用可用项目；也可以改用 Gemini API Key。原始响应: {}",
            body_excerpt
        );
    }
    if body.contains("ACCESS_TOKEN_SCOPE_INSUFFICIENT") {
        return format!(
            "Gemini Code Assist 登录 token 缺少 cloud-platform 授权范围。请退出后重新登录 Gemini Google 账号；也可以改用 Gemini API Key。原始响应: {}",
            body_excerpt
        );
    }
    if body.contains("PERMISSION_DENIED") || status.as_u16() == 403 {
        return format!(
            "Gemini Code Assist 登录通道未获得可用项目或权限。请确认账号已完成 Gemini Code Assist onboarding，或设置可用的 GOOGLE_CLOUD_PROJECT；也可以改用 Gemini API Key。原始响应: {}",
            body_excerpt
        );
    }
    if status.is_server_error() {
        return format!(
            "Gemini Code Assist 后端返回 {}。这通常是账号/项目 provisioning 或预览模型波动；请尝试 gemini-2.5-pro/flash，或改用 Gemini API Key。原始响应: {}",
            status,
            body_excerpt
        );
    }
    format!("HTTP {}: {}", status, body_excerpt)
}

async fn exchange_cloud_oauth_code(
    pending: &PendingCloudAuth,
    code: &str,
) -> Result<StoredCloudToken, String> {
    let token_ref = pending
        .server_id
        .clone()
        .unwrap_or_else(|| pending.session_id.clone());
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(HTTP_CONNECT_TIMEOUT_SECS))
        .timeout(Duration::from_secs(HTTP_SHORT_TIMEOUT_SECS))
        .build()
        .map_err(|e| format!("创建 OAuth 客户端失败: {e}"))?;

    let (token_url, mut form): (String, Vec<(&str, String)>) =
        if pending.mode == "gemini_google_oauth" {
            (
                "https://oauth2.googleapis.com/token".to_string(),
                vec![
                    ("grant_type", "authorization_code".to_string()),
                    ("code", code.to_string()),
                    ("redirect_uri", pending.redirect_uri.clone()),
                    ("client_id", GEMINI_OAUTH_CLIENT_ID.to_string()),
                    ("client_secret", GEMINI_OAUTH_CLIENT_SECRET.to_string()),
                    ("code_verifier", pending.verifier.clone()),
                ],
            )
        } else {
            (
                format!("{OPENAI_OAUTH_ISSUER}/oauth/token"),
                vec![
                    ("grant_type", "authorization_code".to_string()),
                    ("code", code.to_string()),
                    ("redirect_uri", pending.redirect_uri.clone()),
                    ("client_id", OPENAI_OAUTH_CLIENT_ID.to_string()),
                    ("code_verifier", pending.verifier.clone()),
                ],
            )
        };

    let response = client
        .post(&token_url)
        .header("Content-Type", "application/x-www-form-urlencoded")
        .form(&form)
        .send()
        .await
        .map_err(|e| format!("OAuth token exchange failed: {e}"))?;
    let status = response.status();
    let payload_text = response
        .text()
        .await
        .map_err(|e| format!("读取 OAuth token 响应失败: {e}"))?;
    let payload = serde_json::from_str::<Value>(&payload_text)
        .map_err(|e| format!("解析 OAuth token 响应失败: {e}"))?;
    if !status.is_success() {
        return Err(format!(
            "OAuth token exchange failed: HTTP {status}: {}",
            payload
        ));
    }

    let access_token = payload
        .get("access_token")
        .and_then(Value::as_str)
        .ok_or_else(|| "OAuth token 响应缺少 access_token".to_string())?
        .to_string();
    let refresh_token = payload
        .get("refresh_token")
        .and_then(Value::as_str)
        .map(str::to_string);
    let id_token = payload
        .get("id_token")
        .and_then(Value::as_str)
        .map(str::to_string);
    let expires_in = payload
        .get("expires_in")
        .and_then(Value::as_u64)
        .unwrap_or(3600);
    let expires_at = now_millis().saturating_add(expires_in.saturating_mul(1000));

    let mut account_id = None;
    let mut email = None;
    if pending.mode == "openai_chatgpt_oauth" {
        if let Some(claims) = id_token.as_deref().and_then(parse_jwt_claims) {
            account_id = extract_openai_account_id(&claims);
            email = extract_claim_string(&claims, "email");
        }
        if account_id.is_none() {
            if let Some(claims) = parse_jwt_claims(&access_token) {
                account_id = extract_openai_account_id(&claims);
                if email.is_none() {
                    email = extract_claim_string(&claims, "email");
                }
            }
        }
    } else {
        if let Some(claims) = id_token.as_deref().and_then(parse_jwt_claims) {
            account_id = extract_claim_string(&claims, "sub");
            email = extract_claim_string(&claims, "email");
        }
        let (userinfo_id, userinfo_email) = fetch_gemini_userinfo(&access_token).await;
        if account_id.is_none() {
            account_id = userinfo_id;
        }
        if email.is_none() {
            email = userinfo_email;
        }
    }

    form.clear();
    Ok(StoredCloudToken {
        provider: pending.provider.clone(),
        mode: pending.mode.clone(),
        token_ref,
        access_token,
        refresh_token,
        id_token,
        expires_at,
        account_id,
        email,
        project_id: None,
        tier: None,
        onboarded: None,
        code_assist_message: None,
        storage: "file".to_string(),
        message: None,
    })
}

async fn refresh_stored_cloud_token(
    app: &AppHandle,
    token_ref: &str,
    force: bool,
) -> Result<StoredCloudToken, String> {
    let mut store = load_cloud_auth_store(app)?;
    let stored_record = store
        .records
        .get(token_ref)
        .cloned()
        .ok_or_else(|| "未找到云端登录 token，请重新登录。".to_string())?;
    let mut record = record_with_loaded_secrets(&stored_record)?;
    if !force && record.expires_at > now_millis().saturating_add(CLOUD_AUTH_REFRESH_SKEW_MS) {
        return Ok(record);
    }
    let refresh_token = record
        .refresh_token
        .clone()
        .ok_or_else(|| "当前登录没有 refresh token，请重新登录。".to_string())?;

    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(HTTP_CONNECT_TIMEOUT_SECS))
        .timeout(Duration::from_secs(HTTP_SHORT_TIMEOUT_SECS))
        .build()
        .map_err(|e| format!("创建 OAuth 刷新客户端失败: {e}"))?;

    let (token_url, form): (String, Vec<(&str, String)>) = if record.mode == "gemini_google_oauth" {
        (
            "https://oauth2.googleapis.com/token".to_string(),
            vec![
                ("grant_type", "refresh_token".to_string()),
                ("refresh_token", refresh_token),
                ("client_id", GEMINI_OAUTH_CLIENT_ID.to_string()),
                ("client_secret", GEMINI_OAUTH_CLIENT_SECRET.to_string()),
            ],
        )
    } else {
        (
            format!("{OPENAI_OAUTH_ISSUER}/oauth/token"),
            vec![
                ("grant_type", "refresh_token".to_string()),
                ("refresh_token", refresh_token),
                ("client_id", OPENAI_OAUTH_CLIENT_ID.to_string()),
            ],
        )
    };

    let response = client
        .post(&token_url)
        .header("Content-Type", "application/x-www-form-urlencoded")
        .form(&form)
        .send()
        .await
        .map_err(|e| format!("OAuth token refresh failed: {e}"))?;
    let status = response.status();
    let payload_text = response
        .text()
        .await
        .map_err(|e| format!("读取 OAuth 刷新响应失败: {e}"))?;
    let payload = serde_json::from_str::<Value>(&payload_text)
        .map_err(|e| format!("解析 OAuth 刷新响应失败: {e}"))?;
    if !status.is_success() {
        return Err(format!(
            "OAuth token refresh failed: HTTP {status}: {}",
            payload
        ));
    }

    if let Some(access_token) = payload.get("access_token").and_then(Value::as_str) {
        record.access_token = access_token.to_string();
    }
    if let Some(refresh_token) = payload.get("refresh_token").and_then(Value::as_str) {
        record.refresh_token = Some(refresh_token.to_string());
    }
    if let Some(id_token) = payload.get("id_token").and_then(Value::as_str) {
        record.id_token = Some(id_token.to_string());
    }
    let expires_in = payload
        .get("expires_in")
        .and_then(Value::as_u64)
        .unwrap_or(3600);
    record.expires_at = now_millis().saturating_add(expires_in.saturating_mul(1000));

    if record.mode == "openai_chatgpt_oauth" {
        if let Some(claims) = record.id_token.as_deref().and_then(parse_jwt_claims) {
            record.account_id = extract_openai_account_id(&claims).or(record.account_id);
            record.email = extract_claim_string(&claims, "email").or(record.email);
        }
    }

    let mut persisted = record.clone();
    if stored_record.storage == "keychain" {
        save_cloud_token_to_keychain(token_ref, &cloud_token_secrets(&record))?;
        clear_record_secrets_for_keychain(&mut persisted);
        persisted.storage = "keychain".to_string();
        persisted.message = Some("Stored in the operating system keychain.".to_string());
    }
    store.records.insert(token_ref.to_string(), persisted);
    save_cloud_auth_store(app, &store)?;
    Ok(record)
}

async fn valid_cloud_oauth_token(
    app: &AppHandle,
    token_ref: &str,
) -> Result<StoredCloudToken, String> {
    refresh_stored_cloud_token(app, token_ref, false).await
}

#[tauri::command]
async fn cloud_auth_begin(
    app: AppHandle,
    provider: String,
    mode: String,
    server_id: Option<String>,
) -> Result<CloudAuthBeginResult, String> {
    let mode = normalize_cloud_auth_mode(&mode).to_string();
    if mode == "api_key" {
        return Err("API Key 模式不需要浏览器登录。".to_string());
    }
    let provider = normalize_cloud_auth_provider(&provider, &mode);
    let (listener, port) = bind_oauth_listener(&mode)?;
    let callback_path = if mode == "gemini_google_oauth" {
        "/oauth2callback"
    } else {
        "/auth/callback"
    };
    let host = if mode == "openai_chatgpt_oauth" {
        "localhost"
    } else {
        "127.0.0.1"
    };
    let redirect_uri = format!("http://{host}:{port}{callback_path}");
    let verifier = random_pkce_verifier();
    let challenge = pkce_challenge(&verifier);
    let state = random_urlsafe_bytes(32);
    let auth_url = if mode == "gemini_google_oauth" {
        build_gemini_oauth_url(&redirect_uri, &challenge, &state)?
    } else {
        build_openai_oauth_url(&redirect_uri, &challenge, &state)?
    };
    let session_id = format!("cloud-auth-{}", random_urlsafe_bytes(18));
    let callback = Arc::new(Mutex::new(PendingCloudAuthCallback::default()));
    spawn_oauth_callback_listener(listener, callback_path.to_string(), state, callback.clone());

    let pending = PendingCloudAuth {
        session_id: session_id.clone(),
        provider: provider.clone(),
        mode: mode.clone(),
        server_id,
        verifier,
        redirect_uri: redirect_uri.clone(),
        started_at_ms: now_millis(),
        callback,
    };
    {
        let mut pending_map = cloud_auth_pending()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        pending_map.insert(session_id.clone(), pending);
    }

    let browser_opened = match app.opener().open_url(auth_url.clone(), None::<&str>) {
        Ok(_) => true,
        Err(err) => {
            record_debug_log(
                &app,
                "warn",
                "cloud_auth",
                format!("open_browser_failed mode={} err={}", mode, err),
            );
            false
        }
    };

    Ok(CloudAuthBeginResult {
        session_id,
        provider,
        mode,
        auth_url,
        redirect_uri,
        expires_at: now_millis() + 5 * 60 * 1000,
        browser_opened,
    })
}

#[tauri::command]
async fn cloud_auth_finish(
    app: AppHandle,
    session_id: String,
    server_id: Option<String>,
) -> Result<CloudAuthPublicStatus, String> {
    let pending = {
        let pending_map = cloud_auth_pending()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        pending_map.get(&session_id).cloned()
    }
    .ok_or_else(|| "登录会话不存在或已结束，请重新开始登录。".to_string())?;

    let callback_state = pending
        .callback
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone();

    if let Some(error) = callback_state.error {
        let mut pending_map = cloud_auth_pending()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        pending_map.remove(&session_id);
        return Ok(CloudAuthPublicStatus {
            mode: pending.mode,
            status: "error".to_string(),
            token_ref: None,
            account_id: None,
            email: None,
            expires_at: None,
            storage: None,
            message: Some(error),
            project_id: None,
            tier: None,
            onboarded: None,
            code_assist_message: None,
        });
    }

    let Some(code) = callback_state.code else {
        return Ok(pending_cloud_auth_status(&pending));
    };

    let mut pending_for_exchange = pending.clone();
    if pending_for_exchange.server_id.is_none() {
        pending_for_exchange.server_id = server_id;
    }
    let record = exchange_cloud_oauth_code(&pending_for_exchange, &code).await?;
    let record = initialize_gemini_code_assist_record(record).await;
    let record = store_cloud_auth_record(&app, &record)?;

    {
        let mut pending_map = cloud_auth_pending()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        pending_map.remove(&session_id);
    }

    Ok(cloud_auth_status_from_record(&record))
}

#[tauri::command]
fn cloud_auth_status(app: AppHandle, server_id: String) -> Result<CloudAuthPublicStatus, String> {
    let store = load_cloud_auth_store(&app)?;
    let Some(record) = store.records.get(&server_id) else {
        return Ok(disconnected_cloud_auth_status("api_key", None));
    };
    Ok(cloud_auth_status_from_record(record))
}

#[tauri::command]
fn cloud_auth_logout(app: AppHandle, server_id: String) -> Result<CloudAuthPublicStatus, String> {
    let mut store = load_cloud_auth_store(&app)?;
    let removed = store.records.remove(&server_id);
    let keychain_error = removed
        .as_ref()
        .filter(|record| record.storage == "keychain")
        .and_then(|_| delete_cloud_token_from_keychain(&server_id).err());
    save_cloud_auth_store(&app, &store)?;
    Ok(disconnected_cloud_auth_status(
        removed
            .as_ref()
            .map(|record| record.mode.as_str())
            .unwrap_or("api_key"),
        Some(keychain_error.unwrap_or_else(|| "Logged out.".to_string())),
    ))
}

async fn prepare_cloud_auth_request(
    app: &AppHandle,
    url: String,
    headers: Option<HashMap<String, String>>,
    auth_mode: Option<String>,
    token_ref: Option<String>,
) -> Result<(String, HashMap<String, String>, Option<String>), String> {
    let mode = auth_mode
        .as_deref()
        .map(normalize_cloud_auth_mode)
        .unwrap_or("api_key");
    let mut next_url = url;
    let mut next_headers = headers.unwrap_or_default();
    let mut next_body: Option<String> = None;
    if mode == "api_key" {
        return Ok((next_url, next_headers, next_body));
    }

    let token_ref = token_ref
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| "当前云端配置缺少 OAuth token 引用，请重新登录。".to_string())?;
    let token = valid_cloud_oauth_token(app, &token_ref).await?;

    if mode == "openai_chatgpt_oauth" {
        next_headers.retain(|key, _| {
            let key = key.to_ascii_lowercase();
            key != "authorization" && key != "x-api-key"
        });
        next_headers.insert(
            "Authorization".to_string(),
            format!("Bearer {}", token.access_token),
        );
        if let Some(account_id) = token
            .account_id
            .as_ref()
            .filter(|value| !value.trim().is_empty())
        {
            next_headers.insert("ChatGPT-Account-Id".to_string(), account_id.clone());
        }
        if next_url.contains("/v1/responses")
            || next_url.contains("/responses")
            || next_url.contains("/v1/chat/completions")
            || next_url.contains("/chat/completions")
        {
            next_url = OPENAI_CHATGPT_CODEX_ENDPOINT.to_string();
        }
        next_headers.insert("originator".to_string(), "main".to_string());
        next_headers.insert("session_id".to_string(), token_ref.clone());
        next_headers.insert("version".to_string(), env!("CARGO_PKG_VERSION").to_string());
        next_headers.insert("OpenAI-Beta".to_string(), "responses=v1".to_string());
        next_headers.insert("Accept".to_string(), "text/event-stream".to_string());
        next_headers.insert(
            "User-Agent".to_string(),
            format!(
                "MAIN/{} ({} {}; {})",
                env!("CARGO_PKG_VERSION"),
                std::env::consts::OS,
                std::env::consts::ARCH,
                token_ref
            ),
        );
    } else if mode == "gemini_google_oauth" {
        let mut token = token;
        let is_native_gemini = next_url.contains("generativelanguage.googleapis.com")
            || !next_url.contains("cloudcode-pa.googleapis.com");
        if !is_native_gemini
            && token.project_id.is_none()
            && std::env::var("GOOGLE_CLOUD_PROJECT").ok().is_none()
            && std::env::var("GOOGLE_CLOUD_PROJECT_ID").ok().is_none()
        {
            token = initialize_gemini_code_assist_record(token).await;
            let mut store = load_cloud_auth_store(app)?;
            if let Some(stored) = store.records.get_mut(&token_ref) {
                stored.project_id = token.project_id.clone();
                stored.tier = token.tier.clone();
                stored.onboarded = token.onboarded;
                stored.code_assist_message = token.code_assist_message.clone();
                save_cloud_auth_store(app, &store)?;
            }
        }
        next_headers.retain(|key, _| {
            let key = key.to_ascii_lowercase();
            key != "authorization" && key != "x-goog-api-key" && key != "x-goog-user-project"
        });
        next_headers.insert(
            "Authorization".to_string(),
            format!("Bearer {}", token.access_token),
        );
        if is_native_gemini {
            // Keep the original standard/native Gemini URL and pass the request body unchanged.
        } else {
            next_url = GEMINI_CODE_ASSIST_ENDPOINT.to_string();
            let project_id = std::env::var("GOOGLE_CLOUD_PROJECT")
                .ok()
                .or_else(|| std::env::var("GOOGLE_CLOUD_PROJECT_ID").ok())
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
                .or_else(|| token.project_id.clone());
            if let Some(project_id) = project_id {
                next_body = Some(project_id);
            }
        }
    }

    Ok((next_url, next_headers, next_body))
}

// endregion

#[tauri::command]
fn count_tokens(text: String) -> Result<usize, String> {
    let tokenizer = get_tokenizer()?;
    Ok(tokenizer.encode_with_special_tokens(&text).len())
}

/// Proxy an HTTP request through the Rust backend (bypasses WebView CORS).
/// Uses async reqwest with a timeout — prevents UI freeze during model discovery.
static PROXY_REQUEST_CANCEL: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);
static PROXY_REQUEST_ABORT: std::sync::Mutex<Option<futures_util::future::AbortHandle>> =
    std::sync::Mutex::new(None);

fn set_proxy_abort_handle(handle: Option<futures_util::future::AbortHandle>) {
    if let Ok(mut slot) = PROXY_REQUEST_ABORT.lock() {
        *slot = handle;
    }
}

#[tauri::command]
async fn proxy_request(
    app: AppHandle,
    url: String,
    method: String,
    headers: Option<std::collections::HashMap<String, String>>,
    body: Option<String>,
    auth_mode: Option<String>,
    token_ref: Option<String>,
) -> Result<String, String> {
    let (url, headers, body_project_id) =
        prepare_cloud_auth_request(&app, url, headers, auth_mode, token_ref).await?;
    PROXY_REQUEST_CANCEL.store(false, std::sync::atomic::Ordering::Relaxed);
    let meth = method.to_uppercase();
    let body = if let Some(project_id) = body_project_id {
        body.map(|body_str| inject_gemini_code_assist_project(&body_str, &project_id))
            .transpose()?
    } else {
        body
    };
    let body_for_debug = body.clone();
    let body_for_request = body_for_debug.clone();
    let request_started_at = std::time::Instant::now();

    let is_model_request = url.contains("/v1/chat/completions")
        || url.contains("/v1/responses")
        || url.contains("/v1/messages")
        || url.contains("/api/chat")
        || url.contains("/backend-api/codex/responses")
        || url.contains("/v1internal:generateContent");
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

    if !has_header_case_insensitive(&headers, "Content-Type") {
        req = req.header("Content-Type", "application/json");
    }
    if is_model_request {
        req = req.header("Accept-Encoding", "identity");
    }

    for (key, value) in &headers {
        req = req.header(key.as_str(), value.as_str());
    }

    if is_model_request {
        let mut debug_parts = vec![format!("method={meth}"), format!("url={url}")];

        if let Some(body_str) = &body_for_debug {
            if let Ok(json) = serde_json::from_str::<Value>(body_str) {
                if let Some(model) = json.get("model").and_then(Value::as_str) {
                    debug_parts.push(format!("model={model}"));
                }
                if let Some(stream) = json.get("stream").and_then(Value::as_bool) {
                    debug_parts.push(format!("stream={stream}"));
                }
                if let Some(tools) = json.get("tools").and_then(Value::as_array) {
                    debug_parts.push(format!("tools_len={}", tools.len()));
                }
                if let Some(tool_choice) = json.get("tool_choice") {
                    if let Some(tool_choice_str) = tool_choice.as_str() {
                        debug_parts.push(format!("tool_choice={tool_choice_str}"));
                    } else {
                        debug_parts.push("tool_choice=object".to_string());
                    }
                }
                if let Some(max_tokens) = json
                    .get("max_tokens")
                    .or_else(|| json.get("max_completion_tokens"))
                    .and_then(Value::as_i64)
                {
                    debug_parts.push(format!("max_tokens={max_tokens}"));
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
                            debug_parts
                                .push(format!("first_input_content_parts={}", content.len()));
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

    let req = if let Some(body_str) = body_for_request {
        req.body(body_str)
    } else {
        req
    };

    let (abort_handle, abort_registration) = futures_util::future::AbortHandle::new_pair();
    set_proxy_abort_handle(Some(abort_handle));

    let response = match futures_util::future::Abortable::new(req.send(), abort_registration).await
    {
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
                    if should_retry_transport {
                        "warn"
                    } else {
                        "error"
                    },
                    "proxy_request",
                    if should_retry_transport {
                        format!(
                            "primary_transport_failed url={} err={} trying_curl_fallback=true",
                            url, msg
                        )
                    } else {
                        format!("request_failed url={} err={}", url, msg)
                    },
                );
            }

            if should_retry_transport {
                record_debug_log(
                    &app,
                    "warn",
                    "proxy_request",
                    format!("primary failed, trying curl fallback: {}", url),
                );
                match proxy_request_via_curl(&url, &meth, Some(&headers), body_for_debug.as_deref())
                {
                    Ok(result) => {
                        record_debug_log(
                            &app,
                            "info",
                            "proxy_request",
                            format!(
                                "recovered_by=curl url={} elapsed_ms={}",
                                url,
                                request_started_at.elapsed().as_millis()
                            ),
                        );
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
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    if !status.is_success() {
        let error_body = response.text().await.unwrap_or_default();
        let error_message = if url.contains("/v1internal:generateContent") {
            classify_gemini_code_assist_error(status, &error_body)
        } else {
            format!(
                "HTTP {}: {}",
                status,
                error_body.chars().take(500).collect::<String>()
            )
        };
        let should_retry_via_curl = should_use_curl_fallback(&url, &meth, status, &error_body);
        if is_model_request {
            let error_excerpt = error_body.chars().take(240).collect::<String>();
            record_debug_log(
                &app,
                if should_retry_via_curl {
                    "warn"
                } else {
                    "error"
                },
                "proxy_request",
                if should_retry_via_curl {
                    format!(
                        "primary_status_failed status={} url={} body={} trying_curl_fallback=true",
                        status, url, error_excerpt,
                    )
                } else {
                    format!("error status={} url={} body={}", status, url, error_excerpt,)
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
                    status, url, should_retry_via_curl,
                ),
            );
        }

        if should_retry_via_curl {
            record_debug_log(
                &app,
                "warn",
                "proxy_request",
                format!("primary failed, trying curl fallback: {}", url),
            );
            match proxy_request_via_curl(&url, &meth, Some(&headers), body_for_debug.as_deref()) {
                Ok(result) => {
                    record_debug_log(
                        &app,
                        "info",
                        "proxy_request",
                        format!(
                            "recovered_by=curl status={} url={} elapsed_ms={}",
                            status,
                            url,
                            request_started_at.elapsed().as_millis()
                        ),
                    );
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

        return Err(error_message);
    }

    if PROXY_REQUEST_CANCEL.load(std::sync::atomic::Ordering::Relaxed) {
        return Err("Aborted".to_string());
    }
    let (text_abort_handle, text_abort_registration) =
        futures_util::future::AbortHandle::new_pair();
    set_proxy_abort_handle(Some(text_abort_handle));
    let text_result = match futures_util::future::Abortable::new(
        response.text(),
        text_abort_registration,
    )
    .await
    {
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
                        format!(
                            "primary_read_failed url={} err={} trying_curl_fallback=true",
                            url, msg
                        )
                    } else {
                        format!("read_failed url={} err={}", url, msg)
                    },
                );
            }
            if should_retry_read {
                record_debug_log(
                    &app,
                    "warn",
                    "proxy_request",
                    format!("primary failed, trying curl fallback: {}", url),
                );
                match proxy_request_via_curl(&url, &meth, Some(&headers), body_for_debug.as_deref())
                {
                    Ok(result) => {
                        record_debug_log(
                            &app,
                            "info",
                            "proxy_request",
                            format!(
                                "recovered_by=curl url={} elapsed_ms={}",
                                url,
                                request_started_at.elapsed().as_millis()
                            ),
                        );
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
    if is_model_request {
        record_debug_log(
            &app,
            "info",
            "proxy_request",
            format!(
                "success status={} url={} elapsed_ms={}",
                status,
                url,
                request_started_at.elapsed().as_millis()
            ),
        );
    }
    Ok(response_with_content_type(text, content_type.as_deref()))
}

#[tauri::command]
async fn proxy_request_detailed(
    url: String,
    method: String,
    headers: Option<std::collections::HashMap<String, String>>,
    body: Option<String>,
) -> Result<ProxyDetailedResponse, String> {
    let headers = headers.unwrap_or_default();
    let meth = method.to_uppercase();
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(HTTP_SHORT_TIMEOUT_SECS))
        .read_timeout(Duration::from_secs(STREAM_READ_TIMEOUT_SECS))
        .connect_timeout(Duration::from_secs(HTTP_CONNECT_TIMEOUT_SECS))
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {e}"))?;

    let mut req = match meth.as_str() {
        "GET" => client.get(&url),
        "POST" => client.post(&url),
        "DELETE" => client.delete(&url),
        _ => return Err(format!("Unsupported HTTP method: {meth}")),
    };

    if meth == "POST" && !has_header_case_insensitive(&headers, "Content-Type") {
        req = req.header("Content-Type", "application/json");
    }

    for (key, value) in &headers {
        req = req.header(key.as_str(), value.as_str());
    }

    let req = if let Some(body_str) = body {
        req.body(body_str)
    } else {
        req
    };

    let response = req.send().await.map_err(|e| format!("请求失败: {e}"))?;

    let status = response.status();
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);

    let mut response_headers = std::collections::HashMap::new();
    for (name, value) in response.headers().iter() {
        if let Ok(text) = value.to_str() {
            response_headers.insert(name.as_str().to_ascii_lowercase(), text.to_string());
        }
    }

    let body = response
        .text()
        .await
        .map_err(|e| format!("读取响应失败: {e}"))?;

    Ok(ProxyDetailedResponse {
        status: status.as_u16(),
        ok: status.is_success(),
        body,
        content_type,
        headers: response_headers,
    })
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

// region: 图像工作室 HTTP 代理

static IMAGE_STUDIO_STREAM_CANCEL: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);
static IMAGE_STUDIO_STREAM_ABORT: std::sync::Mutex<Option<futures_util::future::AbortHandle>> =
    std::sync::Mutex::new(None);

fn normalize_image_studio_engine(engine: &str) -> Result<&'static str, String> {
    match engine.trim() {
        "huggingface_space" => Ok("huggingface_space"),
        "hidream_http" => Ok("hidream_http"),
        _ => Err("Unsupported Image Studio engine.".to_string()),
    }
}

fn image_studio_default_capabilities(engine: &str) -> ImageStudioEngineCapabilities {
    let hosted = engine == "huggingface_space";
    ImageStudioEngineCapabilities {
        text_to_image: true,
        image_to_image: !hosted,
        progress_preview: !hosted,
        cuda_required: !hosted,
        cloud_hosted: hosted,
    }
}

fn set_image_studio_abort_handle(handle: Option<futures_util::future::AbortHandle>) {
    if let Ok(mut slot) = IMAGE_STUDIO_STREAM_ABORT.lock() {
        *slot = handle;
    }
}

fn abort_active_image_studio_request() {
    if let Ok(mut slot) = IMAGE_STUDIO_STREAM_ABORT.lock() {
        if let Some(handle) = slot.take() {
            handle.abort();
        }
    }
}

fn emit_image_studio_stream_done(
    app: &AppHandle,
    stream_id: &str,
    status: &str,
    error: Option<String>,
) {
    let _ = app.emit(
        "image-studio-stream-done",
        ImageStudioStreamDonePayload {
            stream_id: stream_id.to_string(),
            status: status.to_string(),
            error,
        },
    );
}

fn is_allowed_image_studio_host(host: &str) -> bool {
    let normalized = host.trim().trim_matches(['[', ']']).to_ascii_lowercase();
    if normalized == "localhost" {
        return true;
    }
    match normalized.parse::<IpAddr>() {
        Ok(IpAddr::V4(addr)) => {
            addr.is_loopback()
                || addr.is_private()
                || addr.is_link_local()
        }
        Ok(IpAddr::V6(addr)) => {
            addr.is_loopback()
                || addr.is_unique_local()
                || addr.is_unicast_link_local()
        }
        Err(_) => false,
    }
}

fn is_allowed_hugging_face_space_host(host: &str) -> bool {
    host.trim()
        .trim_matches(['[', ']'])
        .eq_ignore_ascii_case("hidream-ai-hidream-o1-image-dev.hf.space")
}

fn validate_image_studio_endpoint_for_engine(engine: &str, endpoint: &str) -> Result<url::Url, String> {
    let trimmed = endpoint.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return Err("图像工作室 endpoint 不能为空".to_string());
    }
    let parsed = url::Url::parse(trimmed).map_err(|e| format!("图像工作室 endpoint 无效: {e}"))?;
    match parsed.scheme() {
        "http" | "https" => {}
        _ => return Err("图像工作室 endpoint 仅支持 http/https".to_string()),
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("图像工作室 endpoint 不允许包含用户名或密码".to_string());
    }
    let host = parsed
        .host_str()
        .ok_or_else(|| "图像工作室 endpoint 缺少主机名".to_string())?;
    if engine == "huggingface_space" {
        if parsed.scheme() != "https" {
            return Err("Hugging Face Space endpoint 必须使用 https".to_string());
        }
        if !is_allowed_hugging_face_space_host(host) {
            return Err("Hugging Face Space endpoint 仅允许 HiDream-O1-Image-Dev 官方 Space".to_string());
        }
    } else if !is_allowed_image_studio_host(host) {
        return Err("图像工作室 endpoint 只允许 localhost、127.0.0.1、::1 或私有局域网 IP".to_string());
    }
    Ok(parsed)
}

fn build_image_studio_url(engine: &str, endpoint: &str, request_path: &str) -> Result<url::Url, String> {
    let mut base = validate_image_studio_endpoint_for_engine(engine, endpoint)?;
    let path = request_path.trim();
    if !path.starts_with('/') {
        return Err("图像工作室请求路径必须以 / 开头".to_string());
    }
    if path.contains("://") || path.contains('\\') || path.contains('\0') {
        return Err("图像工作室请求路径非法".to_string());
    }
    if path.split('/').any(|part| part == "..") {
        return Err("图像工作室请求路径不允许包含 ..".to_string());
    }
    base.set_path(path);
    base.set_query(None);
    base.set_fragment(None);
    Ok(base)
}

#[tauri::command]
async fn check_image_studio_engine(
    engine: String,
    endpoint: String,
) -> Result<ImageStudioEngineCheckResult, String> {
    let engine_kind = normalize_image_studio_engine(&engine)?;
    let health_path = if engine_kind == "huggingface_space" { "/config" } else { "/" };
    let url = build_image_studio_url(engine_kind, &endpoint, health_path)?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .connect_timeout(Duration::from_secs(3))
        .build()
        .map_err(|e| format!("创建图像工作室 HTTP 客户端失败: {e}"))?;

    match client.get(url.clone()).send().await {
        Ok(response) => {
            let status = response.status();
            let ready = !status.is_server_error();
            Ok(ImageStudioEngineCheckResult {
                ready,
                message: if ready {
                    if engine_kind == "huggingface_space" {
                        "Hugging Face HiDream Space is reachable and ready for hosted generation.".to_string()
                    } else {
                        format!("HiDream HTTP service is reachable at {}.", url)
                    }
                } else {
                    format!("Image Studio engine returned HTTP {}.", status)
                },
                capabilities: image_studio_default_capabilities(engine_kind),
            })
        }
        Err(error) => Ok(ImageStudioEngineCheckResult {
            ready: false,
            message: if error.is_connect() {
                if engine_kind == "huggingface_space" {
                    "无法连接 Hugging Face Space，请检查网络或稍后重试。".to_string()
                } else {
                    "未连接到图像引擎，请确认 HiDream/ComfyUI HTTP 服务已启动。".to_string()
                }
            } else if error.is_timeout() {
                "图像引擎健康检查超时。".to_string()
            } else {
                format!("图像引擎健康检查失败: {error}")
            },
            capabilities: image_studio_default_capabilities(engine_kind),
        }),
    }
}

#[tauri::command]
async fn proxy_image_studio_request(
    app: AppHandle,
    engine: Option<String>,
    endpoint: String,
    path: String,
    method: String,
    body: Option<String>,
    stream_id: Option<String>,
) -> Result<ImageStudioProxyResponse, String> {
    let engine_kind = normalize_image_studio_engine(engine.as_deref().unwrap_or("hidream_http"))?;
    let meth = method.trim().to_ascii_uppercase();
    let url = build_image_studio_url(engine_kind, &endpoint, &path)?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(MODEL_REQUEST_TIMEOUT_SECS))
        .read_timeout(Duration::from_secs(STREAM_READ_TIMEOUT_SECS))
        .connect_timeout(Duration::from_secs(HTTP_CONNECT_TIMEOUT_SECS))
        .build()
        .map_err(|e| format!("创建图像工作室 HTTP 客户端失败: {e}"))?;

    let mut req = match meth.as_str() {
        "GET" => client.get(url.clone()),
        "POST" => client.post(url.clone()),
        "DELETE" => client.delete(url.clone()),
        _ => return Err(format!("Unsupported Image Studio HTTP method: {meth}")),
    };

    if meth == "POST" {
        req = req.header("Content-Type", "application/json");
    }
    if stream_id.is_some() {
        req = req.header("Accept", "text/event-stream");
    }
    let req = if let Some(body_str) = body {
        req.body(body_str)
    } else {
        req
    };

    if meth == "GET" {
        if let Some(stream_id) = stream_id.filter(|value| !value.trim().is_empty()) {
            return stream_image_studio_response(app, stream_id, url.to_string(), req).await;
        }
    }

    let response = req
        .send()
        .await
        .map_err(|e| format!("图像工作室请求失败: {e}"))?;
    let status = response.status();
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    let body = response
        .text()
        .await
        .map_err(|e| format!("读取图像工作室响应失败: {e}"))?;

    Ok(ImageStudioProxyResponse {
        status: status.as_u16(),
        ok: status.is_success(),
        body,
        content_type,
    })
}

async fn stream_image_studio_response(
    app: AppHandle,
    stream_id: String,
    _url: String,
    req: reqwest::RequestBuilder,
) -> Result<ImageStudioProxyResponse, String> {
    use futures_util::StreamExt;

    IMAGE_STUDIO_STREAM_CANCEL.store(false, std::sync::atomic::Ordering::Relaxed);
    set_image_studio_abort_handle(None);

    let (send_abort_handle, send_abort_registration) =
        futures_util::future::AbortHandle::new_pair();
    set_image_studio_abort_handle(Some(send_abort_handle));
    let response_result = futures_util::future::Abortable::new(req.send(), send_abort_registration)
        .await;
    set_image_studio_abort_handle(None);

    let response = match response_result {
        Err(_) => {
            emit_image_studio_stream_done(&app, &stream_id, "cancelled", None);
            return Ok(ImageStudioProxyResponse {
                status: 499,
                ok: false,
                body: String::new(),
                content_type: None,
            });
        }
        Ok(result) => result.map_err(|e| format!("启动图像工作室流失败: {e}"))?,
    };

    let status = response.status();
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    if !status.is_success() {
        let error_body = response.text().await.unwrap_or_default();
        return Err(format!(
            "HTTP {}: {}",
            status,
            error_body.chars().take(500).collect::<String>()
        ));
    }

    let status_code = status.as_u16();
    let mut stream = response.bytes_stream();
    let mut utf8_tail: Vec<u8> = Vec::new();

    loop {
        let (chunk_abort_handle, chunk_abort_registration) =
            futures_util::future::AbortHandle::new_pair();
        set_image_studio_abort_handle(Some(chunk_abort_handle));
        let next_chunk = futures_util::future::Abortable::new(stream.next(), chunk_abort_registration).await;
        set_image_studio_abort_handle(None);

        let item = match next_chunk {
            Err(_) => {
                emit_image_studio_stream_done(&app, &stream_id, "cancelled", None);
                return Ok(ImageStudioProxyResponse {
                    status: 499,
                    ok: false,
                    body: String::new(),
                    content_type,
                });
            }
            Ok(item) => item,
        };

        let Some(chunk_result) = item else {
            break;
        };

        if IMAGE_STUDIO_STREAM_CANCEL.load(std::sync::atomic::Ordering::Relaxed) {
            emit_image_studio_stream_done(&app, &stream_id, "cancelled", None);
            return Ok(ImageStudioProxyResponse {
                status: 499,
                ok: false,
                body: String::new(),
                content_type,
            });
        }

        match chunk_result {
            Ok(bytes) => {
                let mut combined = Vec::with_capacity(utf8_tail.len() + bytes.len());
                combined.extend_from_slice(&utf8_tail);
                utf8_tail.clear();
                combined.extend_from_slice(&bytes);
                let text = match std::str::from_utf8(&combined) {
                    Ok(value) => value.to_string(),
                    Err(error) => {
                        let valid_up_to = error.valid_up_to();
                        if valid_up_to == 0 {
                            utf8_tail = combined;
                            continue;
                        }
                        utf8_tail = combined[valid_up_to..].to_vec();
                        std::str::from_utf8(&combined[..valid_up_to])
                            .unwrap_or("")
                            .to_string()
                    }
                };
                if !text.is_empty() {
                    let _ = app.emit(
                        "image-studio-stream-chunk",
                        ImageStudioStreamChunkPayload {
                            stream_id: stream_id.clone(),
                            chunk: text,
                        },
                    );
                }
            }
            Err(error) => {
                emit_image_studio_stream_done(
                    &app,
                    &stream_id,
                    "error",
                    Some(format!("图像流读取失败: {error}")),
                );
                return Ok(ImageStudioProxyResponse {
                    status: status_code,
                    ok: false,
                    body: String::new(),
                    content_type,
                });
            }
        }
    }

    set_image_studio_abort_handle(None);
    emit_image_studio_stream_done(&app, &stream_id, "ok", None);
    Ok(ImageStudioProxyResponse {
        status: status_code,
        ok: true,
        body: String::new(),
        content_type,
    })
}

#[tauri::command]
fn cancel_image_studio_job() -> Result<(), String> {
    IMAGE_STUDIO_STREAM_CANCEL.store(true, std::sync::atomic::Ordering::Relaxed);
    abort_active_image_studio_request();
    Ok(())
}

fn decode_image_studio_data_url(data_url: &str) -> Result<Vec<u8>, String> {
    let trimmed = data_url.trim();
    let comma_index = trimmed
        .find(',')
        .ok_or_else(|| "图像输出必须是 data URL".to_string())?;
    let header = trimmed[..comma_index].to_ascii_lowercase();
    if !header.starts_with("data:image/") || !header.contains(";base64") {
        return Err("图像输出必须是 base64 图片 data URL".to_string());
    }
    base64::engine::general_purpose::STANDARD
        .decode(trimmed[comma_index + 1..].trim())
        .map_err(|e| format!("解析图像输出失败: {e}"))
}

fn normalize_image_studio_output_file_name(file_name: &str) -> String {
    let safe_name = sanitize_attachment_filename(file_name);
    let lower = safe_name.to_ascii_lowercase();
    if lower.ends_with(".png") || lower.ends_with(".jpg") || lower.ends_with(".jpeg") {
        safe_name
    } else {
        format!("{safe_name}.png")
    }
}

fn save_image_studio_output_bytes(
    session_key: &str,
    file_name: &str,
    bytes: &[u8],
) -> Result<String, String> {
    let workspace = ensure_chat_temp_root(session_key)?;
    let safe_name = normalize_image_studio_output_file_name(file_name);
    let relative_path = format!("image-studio/{safe_name}");
    let real_path = resolve_write_path(&relative_path, &workspace)?;
    if let Some(parent) = real_path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建图像输出目录失败: {e}"))?;
    }
    fs::write(&real_path, bytes).map_err(|e| format!("保存图像输出失败: {e}"))?;
    Ok(real_path.to_string_lossy().to_string())
}

#[tauri::command]
fn save_image_studio_output(
    session_key: String,
    file_name: String,
    data_url: String,
) -> Result<String, String> {
    let bytes = decode_image_studio_data_url(&data_url)?;
    save_image_studio_output_bytes(&session_key, &file_name, &bytes)
}

fn validate_image_studio_remote_image_url(image_url: &str) -> Result<url::Url, String> {
    let parsed = url::Url::parse(image_url.trim())
        .map_err(|e| format!("图像输出 URL 无效: {e}"))?;
    if parsed.scheme() != "https" {
        return Err("远程图像输出只允许 https URL".to_string());
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("远程图像输出 URL 不允许包含用户名或密码".to_string());
    }
    let host = parsed
        .host_str()
        .ok_or_else(|| "远程图像输出 URL 缺少主机名".to_string())?;
    if !is_allowed_hugging_face_space_host(host) {
        return Err("远程图像输出只允许 HiDream Hugging Face Space 文件 URL".to_string());
    }
    if !parsed.path().starts_with("/gradio_api/file=") {
        return Err("远程图像输出 URL 不是受支持的 Gradio 文件地址".to_string());
    }
    Ok(parsed)
}

#[tauri::command]
async fn save_image_studio_remote_output(
    session_key: String,
    file_name: String,
    image_url: String,
) -> Result<String, String> {
    let url = validate_image_studio_remote_image_url(&image_url)?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(120))
        .connect_timeout(Duration::from_secs(HTTP_CONNECT_TIMEOUT_SECS))
        .build()
        .map_err(|e| format!("创建远程图像下载客户端失败: {e}"))?;
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("下载远程图像失败: {e}"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("下载远程图像失败: HTTP {status}"));
    }
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");
    if !content_type.to_ascii_lowercase().starts_with("image/") {
        return Err("远程输出不是图片内容".to_string());
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("读取远程图像失败: {e}"))?;
    if bytes.len() > 64 * 1024 * 1024 {
        return Err("远程图像超过 64MB，未保存。".to_string());
    }
    save_image_studio_output_bytes(&session_key, &file_name, &bytes)
}

fn image_studio_temp_sessions_root() -> PathBuf {
    std::env::temp_dir()
        .join("MAIN")
        .join(".tmp")
        .join("chat-sessions")
}

#[tauri::command]
fn open_image_studio_output(
    app: AppHandle,
    path: String,
) -> Result<OpenFileExternalResult, String> {
    let raw = PathBuf::from(path.trim());
    let real_path = raw
        .canonicalize()
        .map_err(|e| format!("图像输出路径不存在或无法访问: {e}"))?;
    if !real_path.is_file() {
        return Err("图像输出目标不是文件".to_string());
    }
    let temp_root = image_studio_temp_sessions_root()
        .canonicalize()
        .map_err(|e| format!("无法解析图像输出根目录: {e}"))?;
    if !real_path.starts_with(&temp_root) {
        return Err("只能打开 MAIN 图像工作室保存的输出文件".to_string());
    }
    let open_path = real_path.to_string_lossy().to_string();
    app.opener()
        .open_path(open_path.clone(), None::<&str>)
        .map_err(|e| format!("无法使用系统默认应用打开图像：{e}"))?;
    Ok(OpenFileExternalResult {
        path: open_path,
        opened: true,
    })
}

// endregion

// region: 流式聊天代理 (Cloud SSE Proxy)

/// Global cancellation token for the active chat stream.
static STREAM_CANCEL: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
static STREAM_ABORT: std::sync::Mutex<Option<futures_util::future::AbortHandle>> =
    std::sync::Mutex::new(None);

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
    auth_mode: Option<String>,
    token_ref: Option<String>,
) -> Result<(), String> {
    let (url, headers, body_project_id) =
        prepare_cloud_auth_request(&app, url, Some(headers), auth_mode, token_ref).await?;
    let body = if let Some(project_id) = body_project_id {
        inject_gemini_code_assist_project(&body, &project_id)?
    } else {
        body
    };
    STREAM_CANCEL.store(false, std::sync::atomic::Ordering::Relaxed);
    set_stream_abort_handle(None);
    let stream_started_at = Instant::now();

    let is_model_request = url.contains("/v1/chat/completions")
        || url.contains("/v1/responses")
        || url.contains("/v1/messages")
        || url.contains("/api/chat")
        || url.contains("/backend-api/codex/responses")
        || url.contains("/v1internal:generateContent");

    if is_model_request {
        let mut debug_parts = vec![
            format!("stream_id={}", stream_id),
            format!("method=POST"),
            format!("url={}", url),
        ];
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
            if let Some(tools) = body_json.get("tools").and_then(|v| v.as_array()) {
                debug_parts.push(format!("tools_len={}", tools.len()));
            }
            if let Some(tool_choice) = body_json.get("tool_choice") {
                if let Some(tool_choice_str) = tool_choice.as_str() {
                    debug_parts.push(format!("tool_choice={}", tool_choice_str));
                } else {
                    debug_parts.push("tool_choice=object".to_string());
                }
            }
            if let Some(max_tokens) = body_json
                .get("max_tokens")
                .or_else(|| body_json.get("max_completion_tokens"))
                .and_then(|v| v.as_i64())
            {
                debug_parts.push(format!("max_tokens={}", max_tokens));
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
    let mut req_builder = client.post(&url);
    if !has_header_case_insensitive(&headers, "Content-Type") {
        req_builder = req_builder.header("Content-Type", "application/json");
    }
    if is_model_request {
        req_builder = req_builder.header("Accept-Encoding", "identity");
    }

    for (key, value) in &headers {
        req_builder = req_builder.header(key.as_str(), value.as_str());
    }

    req_builder = req_builder.body(body);

    let (send_abort_handle, send_abort_registration) =
        futures_util::future::AbortHandle::new_pair();
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
                "stream_cancelled",
                format!(
                    "cancelled_before_response stream_id={} url={} elapsed_ms={}",
                    stream_id,
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
        record_debug_log(
            &app,
            "error",
            "start_chat_stream",
            format!("request_failed url={} err={}", url, e),
        );
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
        return Err(format!(
            "HTTP {}: {}",
            status,
            error_body.chars().take(500).collect::<String>()
        ));
    }

    let mut stream = response.bytes_stream();
    use futures_util::StreamExt;

    // Buffer for incomplete UTF-8 tail bytes that straddle chunk boundaries.
    // Without this, multi-byte CJK characters get mangled by from_utf8_lossy.
    let mut utf8_tail: Vec<u8> = Vec::new();
    let mut chunk_count: usize = 0;
    let mut byte_count: usize = 0;

    loop {
        let (chunk_abort_handle, chunk_abort_registration) =
            futures_util::future::AbortHandle::new_pair();
        set_stream_abort_handle(Some(chunk_abort_handle));
        let next_chunk = if chunk_count == 0 {
            match tokio::time::timeout(
                Duration::from_secs(STREAM_FIRST_CHUNK_TIMEOUT_SECS),
                futures_util::future::Abortable::new(stream.next(), chunk_abort_registration),
            )
            .await
            {
                Err(_) => {
                    set_stream_abort_handle(None);
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
                        "stream_cancelled",
                        format!(
                            "cancelled_waiting_for_first_chunk stream_id={} url={} elapsed_ms={}",
                            stream_id,
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
            match tokio::time::timeout(
                Duration::from_secs(STREAM_IDLE_CHUNK_TIMEOUT_SECS),
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
                        "stream_idle_timeout",
                        format!(
                            "stream_id={} url={} timeout_secs={} chunks={} bytes={} elapsed_ms={}",
                            stream_id,
                            url,
                            STREAM_IDLE_CHUNK_TIMEOUT_SECS,
                            chunk_count,
                            byte_count,
                            stream_started_at.elapsed().as_millis(),
                        ),
                    );
                    record_debug_log(
                        &app,
                        "info",
                        "stream_cancelled_by_watchdog",
                        format!("phase=after_first_chunk stream_id={} url={}", stream_id, url),
                    );
                    emit_chat_stream_done(
                        &app,
                        &stream_id,
                        "error",
                        Some(format!(
                            "STREAM_IDLE_TIMEOUT: 模型已返回首个流式 chunk，但 {} 秒内没有继续输出，本轮已暂停。",
                            STREAM_IDLE_CHUNK_TIMEOUT_SECS,
                        )),
                    );
                    return Ok(());
                }
                Ok(Err(_)) => {
                    set_stream_abort_handle(None);
                    record_debug_log(
                        &app,
                        "info",
                        "stream_cancelled",
                        format!(
                            "cancelled stream_id={} url={} chunks={} bytes={} elapsed_ms={}",
                            stream_id,
                            url,
                            chunk_count,
                            byte_count,
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
        };

        let Some(chunk_result) = next_chunk else {
            break;
        };

        if STREAM_CANCEL.load(std::sync::atomic::Ordering::Relaxed) {
            record_debug_log(
                &app,
                "info",
                "stream_cancelled",
                format!(
                    "cancelled stream_id={} url={} chunks={} bytes={} elapsed_ms={}",
                    stream_id,
                    url,
                    chunk_count,
                    byte_count,
                    stream_started_at.elapsed().as_millis()
                ),
            );
            emit_chat_stream_done(&app, &stream_id, "cancelled", None);
            return Ok(());
        }

        match chunk_result {
            Ok(bytes) => {
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
                    "stream_error",
                    format!(
                        "read_error stream_id={} url={} chunks={} bytes={} elapsed_ms={} err={}",
                        stream_id,
                        url,
                        chunk_count,
                        byte_count,
                        stream_started_at.elapsed().as_millis(),
                        e
                    ),
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
            "stream_done",
            format!(
                "success stream_id={} url={} chunks={} bytes={} elapsed_ms={}",
                stream_id,
                url,
                chunk_count,
                byte_count,
                stream_started_at.elapsed().as_millis()
            ),
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

/// Lightweight regex-based C#/multi-language symbol extractor.
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

    let source = fs::read_to_string(&real_path).map_err(|e| format!("无法读取文件: {e}"))?;

    if ext == "cs" {
        Ok(extract_csharp_outline(&source))
    } else {
        Ok(extract_generic_outline(&source, &ext))
    }
}

fn extract_generic_outline(source: &str, ext: &str) -> String {
    match ext {
        "ts" | "tsx" | "js" | "jsx" => extract_typescript_outline(source),
        "rs" => extract_rust_outline(source),
        "py" => extract_python_outline(source),
        "go" => extract_go_outline(source),
        _ => extract_fallback_outline(source),
    }
}

fn extract_typescript_outline(source: &str) -> String {
    let mut outline = String::new();
    let mut brace_depth: i32 = 0;
    let mut type_depth: i32 = -1;
    let mut in_type_body = false;
    let mut current_type_kind = String::new();

    let re_decl = Regex::new(
        r"(?i)^\s*(export\s+(?:default\s+)?)?(class|interface|type|enum|function|const|let|var)\s+([A-Za-z_]\w*)"
    ).unwrap();

    let re_method = Regex::new(
        r"^\s*(?:[A-Za-z_]\w*\s+)*([A-Za-z_]\w*)\s*\([^)]*\)"
    ).unwrap();

    let re_property = Regex::new(
        r"^\s*(?:[A-Za-z_]\w*\s+)*([A-Za-z_]\w*)\s*(\??:|=)"
    ).unwrap();

    let mut in_block_comment = false;

    for line in source.lines() {
        let trimmed = line.trim();

        if in_block_comment {
            if trimmed.contains("*/") {
                in_block_comment = false;
            }
            continue;
        }
        if trimmed.starts_with("/*") {
            if !trimmed.contains("*/") {
                in_block_comment = true;
            }
            continue;
        }

        if trimmed.is_empty() || trimmed.starts_with("//") {
            continue;
        }

        let opens = trimmed.chars().filter(|c| *c == '{').count() as i32;
        let closes = trimmed.chars().filter(|c| *c == '}').count() as i32;

        let start_depth = brace_depth;

        if start_depth == 0 || (start_depth == 1 && opens > 0 && closes == 0 && !in_type_body) {
            if let Some(caps) = re_decl.captures(trimmed) {
                let kind = caps.get(2).map(|m| m.as_str()).unwrap_or("");
                
                let decl_line = match trimmed.find('{') {
                    Some(idx) => trimmed[..idx].trim().to_string(),
                    None => trimmed.to_string(),
                };
                outline.push_str(&format!("{}\n", decl_line));

                current_type_kind = kind.to_lowercase();
                type_depth = start_depth;
                in_type_body = true;
                brace_depth += opens - closes;
                continue;
            }
        }

        if in_type_body && start_depth == type_depth + 1 {
            if current_type_kind == "class" || current_type_kind == "interface" {
                if !trimmed.contains("private ") && !trimmed.contains("internal ") {
                    if let Some(caps) = re_method.captures(trimmed) {
                        let method_name = caps.get(1).map(|m| m.as_str()).unwrap_or("");
                        if method_name != "if" && method_name != "for" && method_name != "while" && method_name != "switch" {
                            let sig_line = match trimmed.find('{') {
                                Some(idx) => trimmed[..idx].trim().to_string(),
                                None => trimmed.to_string(),
                            };
                            outline.push_str(&format!("  {}\n", sig_line));
                        }
                    } else if let Some(caps) = re_property.captures(trimmed) {
                        let prop_name = caps.get(1).map(|m| m.as_str()).unwrap_or("");
                        if prop_name != "return" {
                            outline.push_str(&format!("  {}\n", trimmed));
                        }
                    }
                }
            } else if current_type_kind == "enum" {
                if !trimmed.starts_with('}') {
                    outline.push_str(&format!("  {}\n", trimmed));
                }
            }
        }

        brace_depth += opens - closes;

        if in_type_body && brace_depth <= type_depth {
            in_type_body = false;
            current_type_kind.clear();
            outline.push('\n');
        }
    }

    if outline.is_empty() {
        outline.push_str("(No class/interface/type declarations found)\n");
    }
    outline
}

fn extract_rust_outline(source: &str) -> String {
    let mut outline = String::new();
    let mut brace_depth: i32 = 0;
    let mut type_depth: i32 = -1;
    let mut in_type_body = false;
    let mut current_type_kind = String::new();

    let re_decl = Regex::new(
        r"^\s*(pub(?:\([^)]+\))?\s+)?(struct|enum|trait|impl|fn|const|type|macro_rules!)\b"
    ).unwrap();

    let re_rust_method = Regex::new(
        r"^\s*(pub(?:\([^)]+\))?\s+)?(async\s+)?fn\s+([A-Za-z_]\w*)"
    ).unwrap();

    let re_rust_field = Regex::new(
        r"^\s*pub(?:\([^)]+\))?\s+([A-Za-z_]\w*)\s*:"
    ).unwrap();

    let mut in_block_comment = false;

    for line in source.lines() {
        let trimmed = line.trim();

        if in_block_comment {
            if trimmed.contains("*/") {
                in_block_comment = false;
            }
            continue;
        }
        if trimmed.starts_with("/*") {
            if !trimmed.contains("*/") {
                in_block_comment = true;
            }
            continue;
        }

        if trimmed.is_empty() || trimmed.starts_with("//") || trimmed.starts_with("#[") {
            continue;
        }

        let opens = trimmed.chars().filter(|c| *c == '{').count() as i32;
        let closes = trimmed.chars().filter(|c| *c == '}').count() as i32;

        let start_depth = brace_depth;

        if start_depth == 0 || (start_depth == 1 && opens > 0 && closes == 0 && !in_type_body) {
            if let Some(caps) = re_decl.captures(trimmed) {
                let kind = caps.get(2).map(|m| m.as_str()).unwrap_or("");
                
                let decl_line = match trimmed.find('{') {
                    Some(idx) => trimmed[..idx].trim().to_string(),
                    None => trimmed.to_string(),
                };
                outline.push_str(&format!("{}\n", decl_line));

                current_type_kind = kind.to_string();
                type_depth = start_depth;
                in_type_body = true;
                brace_depth += opens - closes;
                continue;
            }
        }

        if in_type_body && start_depth == type_depth + 1 {
            if current_type_kind == "impl" || current_type_kind == "trait" {
                if let Some(_) = re_rust_method.captures(trimmed) {
                    if current_type_kind == "trait" || trimmed.starts_with("pub ") || trimmed.starts_with("pub(") {
                        let sig_line = match trimmed.find('{') {
                            Some(idx) => trimmed[..idx].trim().to_string(),
                            None => trimmed.to_string(),
                        };
                        outline.push_str(&format!("  {}\n", sig_line));
                    }
                }
            } else if current_type_kind == "struct" {
                if let Some(_) = re_rust_field.captures(trimmed) {
                    outline.push_str(&format!("  {}\n", trimmed));
                }
            } else if current_type_kind == "enum" {
                if !trimmed.starts_with('}') && !trimmed.is_empty() {
                    outline.push_str(&format!("  {}\n", trimmed));
                }
            }
        }

        brace_depth += opens - closes;

        if in_type_body && brace_depth <= type_depth {
            in_type_body = false;
            current_type_kind.clear();
            outline.push('\n');
        }
    }

    if outline.is_empty() {
        outline.push_str("(No struct/enum/trait/impl/fn declarations found)\n");
    }
    outline
}

fn extract_python_outline(source: &str) -> String {
    let mut outline = String::new();

    for line in source.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }

        if trimmed.starts_with("def ") || trimmed.starts_with("class ") {
            let leading_spaces = line.len() - line.trim_start().len();
            if leading_spaces <= 4 {
                outline.push_str(&format!("{}{}\n", " ".repeat(leading_spaces), trimmed));
            }
        }
    }

    if outline.is_empty() {
        outline.push_str("(No class or function definitions found)\n");
    }
    outline
}

fn extract_go_outline(source: &str) -> String {
    let mut outline = String::new();
    let mut brace_depth: i32 = 0;
    let mut type_depth: i32 = -1;
    let mut in_type_body = false;
    let mut current_type_kind = String::new();

    let re_decl = Regex::new(
        r"^\s*(type\s+([A-Za-z_]\w*)\s+(struct|interface)|func\s+(?:\([^)]+\)\s+)?([A-Za-z_]\w*)\s*\()"
    ).unwrap();

    for line in source.lines() {
        let trimmed = line.trim();

        if trimmed.is_empty() || trimmed.starts_with("//") || trimmed.starts_with("/*") {
            continue;
        }

        let opens = trimmed.chars().filter(|c| *c == '{').count() as i32;
        let closes = trimmed.chars().filter(|c| *c == '}').count() as i32;

        let start_depth = brace_depth;

        if start_depth == 0 || (start_depth == 1 && opens > 0 && closes == 0 && !in_type_body) {
            if let Some(caps) = re_decl.captures(trimmed) {
                let _name = caps.get(2).or(caps.get(4)).map(|m| m.as_str()).unwrap_or("");
                let kind = caps.get(3).map(|m| m.as_str()).unwrap_or("func");

                let decl_line = match trimmed.find('{') {
                    Some(idx) => trimmed[..idx].trim().to_string(),
                    None => trimmed.to_string(),
                };
                outline.push_str(&format!("{}\n", decl_line));

                if kind == "struct" || kind == "interface" {
                    current_type_kind = kind.to_string();
                    type_depth = start_depth;
                    in_type_body = true;
                }
                brace_depth += opens - closes;
                continue;
            }
        }

        if in_type_body && start_depth == type_depth + 1 {
            if !trimmed.starts_with('}') && !trimmed.is_empty() {
                outline.push_str(&format!("  {}\n", trimmed));
            }
        }

        brace_depth += opens - closes;

        if in_type_body && brace_depth <= type_depth {
            in_type_body = false;
            current_type_kind.clear();
            outline.push('\n');
        }
    }

    if outline.is_empty() {
        outline.push_str("(No type or func declarations found)\n");
    }
    outline
}

fn extract_fallback_outline(source: &str) -> String {
    let mut outline = String::new();
    let re_fallback = Regex::new(
        r"(?i)^\s*(public|protected|private|export|pub)?\s*(class|struct|interface|enum|fn|function|def|func|void|int|string|var|let|const)\s+([A-Za-z_]\w*)"
    ).unwrap();

    for line in source.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with("//") || trimmed.starts_with('#') || trimmed.starts_with("/*") {
            continue;
        }

        if let Some(_) = re_fallback.captures(trimmed) {
            if trimmed.len() < 120 {
                let display_line = match trimmed.find('{') {
                    Some(idx) => trimmed[..idx].trim().to_string(),
                    None => trimmed.to_string(),
                };
                outline.push_str(&format!("{}\n", display_line));
            }
        }
    }

    if outline.is_empty() {
        outline.push_str("(No recognizable declarations found)\n");
    }
    outline
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

    let re_property = Regex::new(r"(?i)^\s*(public|protected)\s+.*\s+([A-Za-z_]\w*)\s*\{").unwrap();

    let re_enum_member = Regex::new(r"^\s*([A-Za-z_]\w*)\s*(?:=|,|$)").unwrap();

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

        let start_depth = brace_depth;

        // At depth 0: look for type declarations
        if start_depth == 0 || (start_depth == 1 && opens > 0 && closes == 0 && !in_type_body) {
            if let Some(caps) = re_type.captures(trimmed) {
                let access = caps.get(1).map(|m| m.as_str()).unwrap_or("internal");
                let modifier = caps.get(2).map(|m| m.as_str()).unwrap_or("");
                let kind = caps.get(3).map(|m| m.as_str()).unwrap_or("class");
                let name = caps.get(4).map(|m| m.as_str()).unwrap_or("?");
                let inherits = caps.get(5).map(|m| m.as_str().trim()).unwrap_or("");

                current_type_kind = kind.to_lowercase();

                let mod_str = if modifier.is_empty() {
                    String::new()
                } else {
                    format!("{} ", modifier)
                };
                let inherit_str = if inherits.is_empty() {
                    String::new()
                } else {
                    format!(" : {}", inherits)
                };
                outline.push_str(&format!(
                    "{} {}{} {}{}\n",
                    access, mod_str, kind, name, inherit_str
                ));

                type_depth = start_depth;
                in_type_body = true;
                brace_depth += opens - closes;
                continue;
            }
        }

        // Inside a type body at depth 1 (relative to type)
        if in_type_body && start_depth == type_depth + 1 {
            // Enums: extract members
            if current_type_kind == "enum" {
                if let Some(caps) = re_enum_member.captures(trimmed) {
                    let member = caps.get(1).map(|m| m.as_str()).unwrap_or("");
                    if !member.is_empty() && member != "get" && member != "set" {
                        outline.push_str(&format!("  {}\n", member));
                    }
                }
            } else {
                // Properties
                if let Some(caps) = re_property.captures(trimmed) {
                    let access = caps.get(1).map(|m| m.as_str()).unwrap_or("public");
                    let prop_name = caps.get(2).map(|m| m.as_str()).unwrap_or("?");
                    let sig = extract_property_signature(trimmed, access, prop_name);
                    outline.push_str(&format!("  {}\n", sig));
                } else if let Some(caps) = re_method.captures(trimmed) {
                    // Methods
                    let access = caps.get(1).map(|m| m.as_str()).unwrap_or("public");
                    let method_name = caps.get(2).map(|m| m.as_str()).unwrap_or("?");
                    let sig = extract_method_signature(trimmed, access, method_name);
                    outline.push_str(&format!("  {}\n", sig));
                }
            }
        }

        brace_depth += opens - closes;

        // If we just closed a type body
        if in_type_body && brace_depth <= type_depth {
            in_type_body = false;
            current_type_kind.clear();
            outline.push('\n');
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

    format!("{} {}{} {}{}", access, mod_str, return_type, name, params)
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

    format!("{} {}{} {}{}", access, mod_str, type_name, name, accessors)
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
        let canonical_target = target_dir
            .canonicalize()
            .unwrap_or_else(|_| target_dir.clone());
        if let Some(parent) = out_path.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("创建子目录失败: {e}"))?;
            // Verify the parent is within target_dir after creation
            if let Ok(canonical_parent) = parent.canonicalize() {
                if !canonical_parent.starts_with(&canonical_target)
                    && canonical_parent != canonical_target
                {
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
            let mut outfile = File::create(&out_path).map_err(|e| format!("创建文件失败: {e}"))?;
            std::io::copy(&mut entry, &mut outfile).map_err(|e| format!("写入文件失败: {e}"))?;
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
    let output = run_workspace_shell_command(&workspace, trimmed.to_string(), input, timeout, None)
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
        let input =
            serde_json::to_vec(payload).map_err(|e| format!("无法序列化文档读取参数: {e}"))?;
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
fn delete_protocol_package(state: State<WorkspaceState>, local_path: String) -> Result<(), String> {
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

const PLAN_FILE_NAMES: [&str; 5] = [
    "plan.md",
    "requirements.md",
    "design.md",
    "tasks.md",
    "bugfix.md",
];

fn delete_plan_files_in_dir(plans_dir: &Path) -> Result<(), String> {
    if !plans_dir.exists() {
        return Ok(());
    }

    for name in &PLAN_FILE_NAMES {
        let file_path = plans_dir.join(name);
        if file_path.exists() && file_path.is_file() {
            fs::remove_file(&file_path)
                .map_err(|e| format!("删除计划文件 {:?} 失败: {e}", file_path))?;
        }
    }

    Ok(())
}

/// Delete all plan files (plan.md, requirements.md, design.md, tasks.md, bugfix.md)
/// from the `.MAIN/plans/` directory when the user explicitly requests cleanup.
#[tauri::command]
fn delete_plan_files(state: State<WorkspaceState>) -> Result<(), String> {
    let workspace = state.get_root()?;
    let plans_dir = workspace.join(".MAIN").join("plans");
    delete_plan_files_in_dir(&plans_dir)
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

fn browser_validation_script_path() -> PathBuf {
    feishu_project_root()
        .join("scripts")
        .join("browser_evaluate.mjs")
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
                home.join(".nvm/versions/node/*/bin/node")
                    .to_string_lossy()
                    .to_string(),
            );
            collect_glob_node_candidates(
                &mut candidates,
                home.join(".fnm/node-versions/*/installation/bin/node")
                    .to_string_lossy()
                    .to_string(),
            );
        }
    } else if cfg!(target_os = "windows") {
        if let Some(program_files) = std::env::var_os("ProgramFiles") {
            push_node_candidate(
                &mut candidates,
                PathBuf::from(program_files).join("nodejs/node.exe"),
            );
        }
        if let Some(program_files_x86) = std::env::var_os("ProgramFiles(x86)") {
            push_node_candidate(
                &mut candidates,
                PathBuf::from(program_files_x86).join("nodejs/node.exe"),
            );
        }
        if let Some(local_app_data) = std::env::var_os("LOCALAPPDATA") {
            push_node_candidate(
                &mut candidates,
                PathBuf::from(local_app_data).join("Programs/nodejs/node.exe"),
            );
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
                home.join(".nvm/versions/node/*/bin/node")
                    .to_string_lossy()
                    .to_string(),
            );
            collect_glob_node_candidates(
                &mut candidates,
                home.join(".fnm/node-versions/*/installation/bin/node")
                    .to_string_lossy()
                    .to_string(),
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
            message: "未找到 Node.js。请在飞书设置中使用快速配置，或手动安装 Node.js LTS。"
                .to_string(),
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
        .unwrap_or(if event_type == "error" {
            "error"
        } else {
            "idle"
        });
    let running = value
        .get("running")
        .and_then(Value::as_bool)
        .unwrap_or(matches!(status, "starting" | "connected"));
    let message =
        value
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or(if event_type == "error" {
                "Feishu adapter error."
            } else {
                ""
            });
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
    guard
        .flush()
        .map_err(|e| format!("刷新飞书适配器命令失败: {e}"))
}

#[tauri::command]
fn get_feishu_adapter_status(
    state: State<FeishuAdapterManager>,
) -> Result<FeishuAdapterStatus, String> {
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

    let starting = set_feishu_status(
        &state.status,
        "starting",
        true,
        "正在启动飞书长连接...",
        None,
    );
    let _ = app.emit(
        "feishu-adapter-event",
        json!({
            "type": "status",
            "adapter": "feishu",
            "status": starting.status,
            "running": starting.running,
            "message": starting.message,
            "timestamp": starting.updated_at,
        }),
    );

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
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "无法打开飞书适配器输入管道".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "无法打开飞书适配器输出管道".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "无法打开飞书适配器日志管道".to_string())?;
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
        let _ = app_for_stdout.emit(
            "feishu-adapter-event",
            json!({
                "type": "status",
                "adapter": "feishu",
                "status": stopped.status,
                "running": stopped.running,
                "message": stopped.message,
                "pid": stopped.pid,
                "timestamp": stopped.updated_at,
            }),
        );
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

    write_feishu_sidecar_command(
        &writer,
        json!({
            "type": "start",
            "config": {
                "appId": app_id,
                "appSecret": app_secret,
                "domain": sanitize_feishu_domain(config.domain),
            },
        }),
    )?;

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
    let _ = app.emit(
        "feishu-adapter-event",
        json!({
            "type": "status",
            "adapter": "feishu",
            "status": status.status,
            "running": status.running,
            "message": status.message,
            "timestamp": status.updated_at,
        }),
    );
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
    write_feishu_sidecar_command(
        &process.writer,
        json!({
            "type": "send_text",
            "chatId": chat_id,
            "userId": user_id,
            "openId": open_id,
            "messageId": message_id,
            "text": text,
        }),
    )
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
    write_feishu_sidecar_command(
        &process.writer,
        json!({
            "type": "send_card",
            "chatId": chat_id,
            "userId": user_id,
            "openId": open_id,
            "messageId": message_id,
            "approvalId": approval_id,
            "messageKind": "approval_card",
            "card": card,
        }),
    )
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
    write_feishu_sidecar_command(
        &process.writer,
        json!({
            "type": "patch_card",
            "messageId": message_id,
            "card": card,
        }),
    )
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
fn current_macos_app_bundle_path() -> Option<std::path::PathBuf> {
    let executable = std::env::current_exe().ok()?;
    executable
        .ancestors()
        .find(|path| {
            path.extension()
                .and_then(|ext| ext.to_str())
                .map(|ext| ext.eq_ignore_ascii_case("app"))
                .unwrap_or(false)
        })
        .map(|path| path.to_path_buf())
}

#[cfg(target_os = "macos")]
fn apply_app_icon_variant_macos(app: AppHandle, variant: String) -> Result<(), String> {
    use objc2::{AllocAnyThread, MainThreadMarker};
    use objc2_app_kit::{NSApp, NSImage, NSWorkspace, NSWorkspaceIconCreationOptions};
    use objc2_foundation::{NSData, NSString};
    use std::sync::mpsc;

    let bundle_path = current_macos_app_bundle_path();
    let (tx, rx) = mpsc::channel();
    app.run_on_main_thread(move || {
        let result = (|| -> Result<(), String> {
            let mtm = MainThreadMarker::new().ok_or_else(|| {
                "macOS app icon update did not run on the main thread".to_string()
            })?;
            let bytes = generate_app_icon_png(&variant);
            let data = NSData::with_bytes(&bytes);
            let image = NSImage::initWithData(NSImage::alloc(), &data)
                .ok_or_else(|| "macOS could not decode the selected app icon".to_string())?;
            let ns_app = NSApp(mtm);
            unsafe {
                ns_app.setApplicationIconImage(Some(&image));
            }
            if let Some(path) = &bundle_path {
                let path_string = path.to_string_lossy().to_string();
                let ns_path = NSString::from_str(&path_string);
                let workspace = NSWorkspace::sharedWorkspace();
                let _ = workspace.setIcon_forFile_options(
                    None,
                    &ns_path,
                    NSWorkspaceIconCreationOptions::empty(),
                );
                let set_ok = workspace.setIcon_forFile_options(
                    Some(&image),
                    &ns_path,
                    NSWorkspaceIconCreationOptions::empty(),
                );
                workspace.noteFileSystemChanged_(&ns_path);
                if !set_ok {
                    return Err(format!(
                        "macOS could not update the app bundle icon at {}",
                        path.display()
                    ));
                }
            }
            Ok(())
        })();
        let _ = tx.send(result);
    })
    .map_err(|e| format!("调度 macOS 图标更新失败: {e}"))?;

    rx.recv()
        .map_err(|e| format!("等待 macOS 图标更新失败: {e}"))?
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
    let workspace_root = default_workspace_root()
        .unwrap_or_else(|_| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));

    tauri::Builder::default()
        .manage(WorkspaceState::new(workspace_root))
        .manage(PtyManager::default())
        .manage(FeishuAdapterManager::default())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
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
            open_file_external,
            write_file,
            export_text_file,
            glob_search,
            grep_search,
            web_search::web_search,
            web_search::web_fetch,
            spawn_pty,
            resize_pty,
            write_pty,
            read_pty_buffer,
            read_pty_tail,
            read_pty_since,
            clear_pty_buffer,
            get_pty_status,
            run_command,
            browser_evaluate,
            shell_permission_preflight,
            build_repository_index,
            load_session_memory,
            record_session_failure,
            run_eval_harness,
            run_runtime_harness,
            create_multi_agent_plan,
            list_mcp_tools,
            call_mcp_tool,
            execute_task_graph,
            review_task_graph_execution,
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
            cloud_auth_begin,
            cloud_auth_finish,
            cloud_auth_status,
            cloud_auth_logout,
            proxy_request,
            proxy_request_detailed,
            cancel_proxy_request,
            check_image_studio_engine,
            proxy_image_studio_request,
            cancel_image_studio_job,
            save_image_studio_output,
            save_image_studio_remote_output,
            open_image_studio_output,
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
        compare_file_nodes, is_supported_attachment_path, is_valid_git_branch_name,
        looks_long_running_shell_command, merge_json_rows_by_id, parse_git_branch_line,
        parse_git_numstat, parse_git_porcelain_entries, parse_git_porcelain_status,
        read_session_transcript_with_fallback, delete_plan_files_in_dir, resolve_existing_path,
        resolve_open_file_external_path, resolve_session_transcript_to_write, resolve_write_path,
        should_hide_list_directory_entry, should_skip_recursive_search_dir, validate_pty_input,
        write_json_atomic, write_jsonl_atomic, FileNode, SessionTranscript,
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
    fn delete_plan_files_in_dir_removes_plan_md_and_legacy_artifacts() {
        let workspace = make_temp_workspace("plan-cleanup");
        let plans_dir = workspace.join(".MAIN").join("plans");
        fs::create_dir_all(&plans_dir).unwrap();
        for name in ["plan.md", "requirements.md", "design.md", "tasks.md", "bugfix.md"] {
            fs::write(plans_dir.join(name), "# plan").unwrap();
        }
        fs::write(plans_dir.join("notes.md"), "# keep").unwrap();

        delete_plan_files_in_dir(&plans_dir).unwrap();

        for name in ["plan.md", "requirements.md", "design.md", "tasks.md", "bugfix.md"] {
            assert!(!plans_dir.join(name).exists(), "{name} should be deleted");
        }
        assert!(plans_dir.join("notes.md").exists());
    }

    #[test]
    fn pty_input_validates_command_when_enter_is_sent() {
        let workspace = make_temp_workspace("pty-permissions");
        fs::create_dir_all(workspace.join(".MAIN")).unwrap();
        fs::write(
            workspace.join(".MAIN").join("permissions.yaml"),
            "shell:\n  allow:\n    - cargo test\n  deny:\n    - sudo\n",
        )
        .unwrap();
        let mut pending = String::new();

        validate_pty_input(&workspace, &mut pending, "cargo test", None).unwrap();
        assert_eq!(pending, "cargo test");

        validate_pty_input(&workspace, &mut pending, "\r", None).unwrap();
        assert_eq!(pending, "");
    }

    #[test]
    fn long_running_shell_detection_catches_dev_servers_without_blocking_builds() {
        assert!(looks_long_running_shell_command("npm run tauri dev"));
        assert!(looks_long_running_shell_command("pnpm run dev"));
        assert!(looks_long_running_shell_command("vite --host 127.0.0.1"));
        assert!(looks_long_running_shell_command("next dev"));
        assert!(looks_long_running_shell_command(
            "storybook dev --port 6006"
        ));
        assert!(!looks_long_running_shell_command("npm run build"));
        assert!(!looks_long_running_shell_command("vite build"));
        assert!(!looks_long_running_shell_command("next build"));
        assert!(!looks_long_running_shell_command("storybook build"));
    }

    #[test]
    fn pty_input_blocks_denied_command_before_enter_passes() {
        let workspace = make_temp_workspace("pty-deny");
        fs::create_dir_all(workspace.join(".MAIN")).unwrap();
        fs::write(
            workspace.join(".MAIN").join("permissions.yaml"),
            "shell:\n  allow:\n    - cargo test\n  deny:\n    - sudo\n",
        )
        .unwrap();
        let mut pending = "sudo whoami".to_string();

        let error = validate_pty_input(&workspace, &mut pending, "\r", None)
            .expect_err("denied command must not be accepted for execution");

        assert!(error.contains("拒绝"));
        assert_eq!(pending, "sudo whoami");
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
        write_json_atomic(
            &runtime_path,
            &json!({
                "taskFlow": [
                    {"id": 11, "type": "user", "content": "legacy user"},
                    {"id": 12, "type": "agent", "content": "legacy agent"}
                ],
                "conversationTurns": [
                    {"id": "turn-legacy", "blockIds": [11, 12], "createdAt": 1}
                ]
            }),
        )
        .unwrap();

        let transcript = read_session_transcript_with_fallback(
            &messages_path,
            &turns_path,
            &runtime_path,
            "legacy",
        )
        .unwrap();

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
        write_json_atomic(
            &runtime_path,
            &json!({
                "taskFlow": [{"id": 11, "type": "user", "content": "legacy user"}],
                "conversationTurns": [{"id": "turn-legacy", "blockIds": [11], "createdAt": 1}]
            }),
        )
        .unwrap();
        write_jsonl_atomic(&messages_path, &[], "test messages").unwrap();
        write_jsonl_atomic(&turns_path, &[], "test turns").unwrap();

        let transcript =
            read_session_transcript_with_fallback(&messages_path, &turns_path, &runtime_path, "v2")
                .unwrap();

        assert_eq!(transcript.messages.len(), 1);
        assert_eq!(transcript.messages[0]["content"], "legacy user");
        assert_eq!(transcript.turns.len(), 1);
        assert_eq!(transcript.turns[0]["id"], "turn-legacy");

        fs::remove_dir_all(&workspace).unwrap();
    }

    #[test]
    fn session_transcript_readers_recover_from_agent_messages_when_jsonl_and_legacy_runtime_are_empty(
    ) {
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
        )
        .unwrap();

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
        write_json_atomic(
            &runtime_path,
            &json!({
                "agentMessages": [
                    {"role": "user", "content": "agent user"},
                    {"role": "assistant", "content": "agent assistant"}
                ]
            }),
        )
        .unwrap();
        write_jsonl_atomic(
            &messages_path,
            &[json!({"id": 9, "turnId": "jsonl-turn", "type": "user", "content": "jsonl user"})],
            "test messages",
        )
        .unwrap();
        write_jsonl_atomic(
            &turns_path,
            &[json!({"id": "jsonl-turn", "blockIds": [9], "createdAt": 1})],
            "test turns",
        )
        .unwrap();

        let transcript = read_session_transcript_with_fallback(
            &messages_path,
            &turns_path,
            &runtime_path,
            "178",
        )
        .unwrap();

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

        let (messages, turns) =
            resolve_session_transcript_to_write(&existing, Vec::new(), Vec::new(), false);

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

        let err =
            resolve_existing_path("../outside", &workspace.canonicalize().unwrap()).unwrap_err();
        assert!(err.contains("路径越界"));

        fs::remove_dir_all(&parent).unwrap();
    }

    #[test]
    fn open_file_external_path_accepts_workspace_file() {
        let workspace = make_temp_workspace("external-open-file");
        let target = workspace.join("notes.md");
        fs::write(&target, "# Notes\n").unwrap();

        let resolved = resolve_open_file_external_path("notes.md", &workspace).unwrap();

        assert_eq!(resolved, target.canonicalize().unwrap());
        fs::remove_dir_all(&workspace).unwrap();
    }

    #[test]
    fn open_file_external_path_rejects_directory_targets() {
        let workspace = make_temp_workspace("external-open-directory");
        fs::create_dir_all(workspace.join("docs")).unwrap();

        let error = resolve_open_file_external_path("docs", &workspace).unwrap_err();

        assert!(error.contains("目标不是文件"));
        fs::remove_dir_all(&workspace).unwrap();
    }

    #[test]
    fn open_file_external_path_rejects_missing_files() {
        let workspace = make_temp_workspace("external-open-missing");

        let error = resolve_open_file_external_path("missing.docx", &workspace).unwrap_err();

        assert!(error.contains("路径不存在") || error.contains("无法访问"));
        fs::remove_dir_all(&workspace).unwrap();
    }

    #[test]
    fn open_file_external_path_rejects_parent_escape() {
        let parent = make_temp_workspace("external-open-parent");
        let workspace = parent.join("workspace");
        fs::create_dir_all(&workspace).unwrap();
        fs::write(parent.join("outside.txt"), "outside").unwrap();

        let error =
            resolve_open_file_external_path("../outside.txt", &workspace.canonicalize().unwrap())
                .unwrap_err();

        assert!(error.contains("路径越界"));
        fs::remove_dir_all(&parent).unwrap();
    }

    #[test]
    fn log_files_are_supported_attachments() {
        assert!(is_supported_attachment_path(
            PathBuf::from("main-debug.log").as_path()
        ));
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
        assert!(should_skip_recursive_search_dir("coverage"));
        assert!(should_skip_recursive_search_dir("out"));
        assert!(should_skip_recursive_search_dir(".protocols"));
        assert!(!should_skip_recursive_search_dir(".MAIN"));
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
        assert_eq!(
            ordered_names,
            vec!["Scripts", "capabilities", "Cargo.toml", "README.md"]
        );
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

    #[test]
    fn test_extract_csharp_outline_works() {
        let source = r#"
            using System;
            namespace Test {
                public class MyClass : IDisposable {
                    public int MyProperty { get; set; }
                    private string _field;
                    protected void MyMethod(int x, string y) {
                        // impl
                    }
                }
            }
        "#;
        let outline = super::extract_csharp_outline(source);
        println!("CS OUTLINE:\n{}", outline);
        assert!(outline.contains("public class MyClass : IDisposable"));
        assert!(outline.contains("  public int MyProperty { get; set; }"));
        assert!(outline.contains("  protected void MyMethod(int x, string y)"));
        assert!(!outline.contains("_field"));
    }

    #[test]
    fn test_extract_typescript_outline_works() {
        let source = r#"
            export default class Component extends Base {
                public static isReady = true;
                private _internal = 123;
                async render(element: string) {
                    console.log("hello");
                }
            }
            export interface IService {
                name: string;
                run(): Promise<void>;
            }
        "#;
        let outline = super::extract_generic_outline(source, "ts");
        assert!(outline.contains("export default class Component extends Base"));
        assert!(outline.contains("  public static isReady = true;"));
        assert!(outline.contains("  async render(element: string)"));
        assert!(outline.contains("export interface IService"));
        assert!(outline.contains("  name: string;"));
        assert!(outline.contains("  run(): Promise<void>;"));
        assert!(!outline.contains("_internal"));
    }

    #[test]
    fn test_extract_rust_outline_works() {
        let source = r#"
            pub struct MyStruct {
                pub id: u64,
                secret: String,
            }
            pub enum State {
                Active,
                Inactive,
            }
            impl MyStruct {
                pub fn new(id: u64) -> Self {
                    MyStruct { id, secret: String::new() }
                }
                fn private_helper(&self) {}
            }
        "#;
        let outline = super::extract_generic_outline(source, "rs");
        assert!(outline.contains("pub struct MyStruct"));
        assert!(outline.contains("  pub id: u64,"));
        assert!(outline.contains("pub enum State"));
        assert!(outline.contains("  Active,"));
        assert!(outline.contains("impl MyStruct"));
        assert!(outline.contains("  pub fn new(id: u64) -> Self"));
        assert!(!outline.contains("secret: String"));
        assert!(!outline.contains("private_helper"));
    }

    #[test]
    fn test_extract_python_outline_works() {
        let source = r#"
class MyPythonClass:
    def __init__(self, val):
        self.val = val
    def get_val(self):
        return self.val

def global_function(x):
    return x * 2
"#;
        let outline = super::extract_generic_outline(source, "py");
        assert!(outline.contains("class MyPythonClass:"));
        assert!(outline.contains("    def __init__(self, val):"));
        assert!(outline.contains("    def get_val(self):"));
        assert!(outline.contains("def global_function(x):"));
    }

    #[test]
    fn test_extract_go_outline_works() {
        let source = r#"
            package main
            type Service interface {
                Start() error
            }
            type serviceImpl struct {
                name string
            }
            func NewService(name string) Service {
                return &serviceImpl{name: name}
            }
        "#;
        let outline = super::extract_generic_outline(source, "go");
        assert!(outline.contains("type Service interface"));
        assert!(outline.contains("  Start() error"));
        assert!(outline.contains("type serviceImpl struct"));
        assert!(outline.contains("  name string"));
        assert!(outline.contains("func NewService(name string) Service"));
    }
}
