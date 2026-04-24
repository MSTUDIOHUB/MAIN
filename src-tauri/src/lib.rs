use glob::glob;
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use regex::Regex;
use serde::Serialize;
use serde_json::{json, Value};
use std::cmp::Ordering;
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::process::{Command as ProcessCommand, Stdio};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, State};
use tiktoken_rs::{cl100k_base, CoreBPE};
use walkdir::WalkDir;

// region: 全局常量与状态

const PTY_BUFFER_LIMIT_BYTES: usize = 512 * 1024;
const GREP_MATCH_LIMIT: usize = 2000;
const GREP_OUTPUT_LIMIT_BYTES: usize = 512 * 1024;
const COMMAND_OUTPUT_LIMIT_BYTES: usize = 1024 * 1024;
const DOCUMENT_READER_SCRIPT: &str = include_str!("../Scripts/document_reader.py");

static TOKENIZER: OnceLock<CoreBPE> = OnceLock::new();

#[derive(Default)]
struct PtyManager {
    session: Mutex<Option<PtySession>>,
}

struct WorkspaceState {
    root: Mutex<PathBuf>,
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

#[derive(Clone, Serialize)]
struct PtyDataPayload {
    chunk: String,
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
        let text = String::from_utf8_lossy(&self.bytes).to_string();
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
        let text = String::from_utf8_lossy(&self.bytes[start_idx..]).to_string();

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

    status.is_server_error() || error_body.to_ascii_lowercase().contains("upstream_error")
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
    command.arg("-w").arg("\n__HTTP_STATUS__:%{http_code}");

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
        cmd.args(["/C", command]);
        cmd
    } else {
        let mut cmd = ProcessCommand::new("/bin/sh");
        cmd.args(["-lc", command]);
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

fn start_pty_reader_thread(
    mut reader: Box<dyn Read + Send>,
    buffer: Arc<Mutex<PtyBuffer>>,
    app: AppHandle,
) {
    std::thread::spawn(move || {
        let mut chunk = [0_u8; 4096];
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

                    let text = String::from_utf8_lossy(data).to_string();
                    if !text.is_empty() {
                        let _ = app.emit("pty-data", PtyDataPayload { chunk: text });
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
    let raw = PathBuf::from(path);
    if !raw.exists() {
        return Err("工作区路径不存在".to_string());
    }
    if !raw.is_dir() {
        return Err("工作区路径必须是目录".to_string());
    }
    let canonical = raw
        .canonicalize()
        .map_err(|e| format!("无法解析工作区路径: {e}"))?;
    state.set_root(canonical.clone())?;
    Ok(canonical.to_string_lossy().to_string())
}

#[tauri::command]
fn read_file(state: State<WorkspaceState>, path: String) -> Result<String, String> {
    let workspace = state.get_root()?;
    let real_path = resolve_existing_path(&path, &workspace)?;
    fs::read_to_string(real_path).map_err(|e| e.to_string())
}

#[tauri::command]
fn write_file(state: State<WorkspaceState>, path: String, content: String) -> Result<(), String> {
    let workspace = state.get_root()?;
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
fn list_directory(state: State<WorkspaceState>, path: String) -> Result<Vec<FileNode>, String> {
    let workspace = state.get_root()?;
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
    "Temp", "UserSettings", ".vs", "Build", "dist", ".protocols",
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
fn get_project_skeleton(state: State<WorkspaceState>, depth: Option<serde_json::Value>) -> Result<String, String> {
    let workspace = state.get_root()?;
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
fn glob_search(state: State<WorkspaceState>, pattern: String) -> Result<Vec<String>, String> {
    validate_glob_pattern(&pattern)?;
    let workspace = state.get_root()?;
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
fn grep_search(state: State<WorkspaceState>, query: String, path: String) -> Result<String, String> {
    let regex = Regex::new(&query).map_err(|e| format!("无效正则表达式: {e}"))?;
    let workspace = state.get_root()?;
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
) -> Result<(), String> {
    let mut guard = state
        .session
        .lock()
        .map_err(|_| "无法获取 PTY 会话锁".to_string())?;

    if let Some(mut existing) = guard.take() {
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
    if let Ok(root) = workspace_state.get_root() {
        cmd.cwd(root);
    }
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
    start_pty_reader_thread(reader, Arc::clone(&shared_buffer), app);

    *guard = Some(PtySession {
        master: pair.master,
        writer: shared_writer,
        buffer: shared_buffer,
        child,
    });

    Ok(())
}

#[tauri::command]
fn resize_pty(state: State<PtyManager>, cols: u16, rows: u16) -> Result<(), String> {
    let guard = state
        .session
        .lock()
        .map_err(|_| "无法获取 PTY 会话锁".to_string())?;
    let session = guard
        .as_ref()
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
fn write_pty(state: State<PtyManager>, input: String) -> Result<(), String> {
    let guard = state
        .session
        .lock()
        .map_err(|_| "无法获取 PTY 会话锁".to_string())?;
    let session = guard
        .as_ref()
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
fn read_pty_buffer(state: State<PtyManager>, max_chars: Option<usize>) -> Result<String, String> {
    let guard = state
        .session
        .lock()
        .map_err(|_| "无法获取 PTY 会话锁".to_string())?;
    let session = guard
        .as_ref()
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
fn read_pty_tail(state: State<PtyManager>, max_chars: Option<usize>) -> Result<PtyReadResult, String> {
    let guard = state
        .session
        .lock()
        .map_err(|_| "无法获取 PTY 会话锁".to_string())?;
    let session = guard
        .as_ref()
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
) -> Result<PtyReadResult, String> {
    let guard = state
        .session
        .lock()
        .map_err(|_| "无法获取 PTY 会话锁".to_string())?;
    let session = guard
        .as_ref()
        .ok_or_else(|| "PTY 尚未启动，请先调用 spawn_pty".to_string())?;
    let buffer = session
        .buffer
        .lock()
        .map_err(|_| "无法读取 PTY 缓冲区：buffer 锁已损坏".to_string())?;
    Ok(buffer.read_since(offset, max_chars))
}

#[tauri::command]
fn clear_pty_buffer(state: State<PtyManager>) -> Result<PtyReadResult, String> {
    let guard = state
        .session
        .lock()
        .map_err(|_| "无法获取 PTY 会话锁".to_string())?;
    let session = guard
        .as_ref()
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
fn get_pty_status(state: State<PtyManager>) -> Result<PtyStatus, String> {
    let mut guard = state
        .session
        .lock()
        .map_err(|_| "无法获取 PTY 会话锁".to_string())?;

    let Some(session) = guard.as_mut() else {
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
) -> Result<TerminalCommandOutput, String> {
    let workspace = state.get_root()?;
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
#[tauri::command]
async fn proxy_request(url: String, method: String, headers: Option<std::collections::HashMap<String, String>>, body: Option<String>) -> Result<String, String> {
    let meth = method.to_uppercase();
    let body_for_debug = body.clone();

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .connect_timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {e}"))?;

    let mut req = match meth.as_str() {
        "GET" => client.get(&url),
        "POST" => client.post(&url),
        _ => return Err(format!("Unsupported HTTP method: {meth}")),
    };

    req = req.header("Content-Type", "application/json");

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

        println!("[proxy_request] {}", debug_parts.join(" "));
    }

    let req = if let Some(body_str) = body {
        req.body(body_str)
    } else {
        req
    };

    let response = req.send().await.map_err(|e| {
        let msg = e.to_string();
        if msg.contains("dns") || msg.contains("resolve") {
            format!("DNS 解析失败，请检查地址是否正确: {msg}")
        } else if msg.contains("Connection refused") || msg.contains("connect") {
            format!("连接被拒绝，请确认服务正在运行: {msg}")
        } else if msg.contains("timed out") || msg.contains("timeout") {
            format!("连接超时，请检查网络或服务状态: {msg}")
        } else if msg.contains("tls") || msg.contains("certificate") {
            format!("TLS/SSL 错误: {msg}")
        } else {
            format!("请求失败: {msg}")
        }
    })?;

    let status = response.status();
    if !status.is_success() {
        let error_body = response.text().await.unwrap_or_default();
        if url.contains("/v1/chat/completions") || url.contains("/v1/responses") || url.contains("/v1/messages") {
            println!(
                "[proxy_request] error status={} url={} body={}",
                status,
                url,
                error_body.chars().take(240).collect::<String>(),
            );
        }

        let should_retry_via_curl = should_use_curl_fallback(&url, &meth, status, &error_body);
        if url.contains("/v1/chat/completions") || url.contains("/v1/responses") || url.contains("/v1/messages") {
            println!(
                "[proxy_request] fallback_decision status={} url={} use_curl={}",
                status,
                url,
                should_retry_via_curl,
            );
        }

        if should_retry_via_curl {
            println!("[proxy_request] reqwest failed, retrying via curl fallback: {}", url);
            match proxy_request_via_curl(&url, &meth, headers.as_ref(), body_for_debug.as_deref()) {
                Ok(result) => {
                    println!("[proxy_request] curl fallback succeeded url={}", url);
                    return Ok(result);
                }
                Err(curl_err) => {
                    println!("[proxy_request] curl fallback failed url={} err={}", url, curl_err);
                }
            }
        }

        return Err(format!("HTTP {}: {}", status, error_body.chars().take(500).collect::<String>()));
    }

    let text = response.text().await.map_err(|e| format!("读取响应失败: {e}"))?;
    if url.contains("/v1/chat/completions") || url.contains("/v1/responses") || url.contains("/v1/messages") {
        println!("[proxy_request] success status={} url={}", status, url);
    }
    Ok(text)
}

// endregion

// region: 流式聊天代理 (Cloud SSE Proxy)

/// Global cancellation token for the active chat stream.
static STREAM_CANCEL: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

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

    if url.contains("/v1/chat/completions") || url.contains("/v1/responses") || url.contains("/v1/messages") {
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
        println!("[start_chat_stream] {}", debug_parts.join(" "));
    }

    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(15))
        .timeout(std::time::Duration::from_secs(300)) // 5 min overall timeout for long streams
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {e}"))?;
    let mut req_builder = client
        .post(&url)
        .header("Content-Type", "application/json");

    for (key, value) in &headers {
        req_builder = req_builder.header(key.as_str(), value.as_str());
    }

    req_builder = req_builder.body(body);

    let response = req_builder
        .send()
        .await
        .map_err(|e| {
            println!("[start_chat_stream] request_failed url={} err={}", url, e);
            format!("请求失败: {e}")
        })?;

    if !response.status().is_success() {
        let status = response.status();
        let error_body = response.text().await.unwrap_or_default();
        if url.contains("/v1/chat/completions") || url.contains("/v1/responses") || url.contains("/v1/messages") {
            println!(
                "[start_chat_stream] error status={} url={} body={}",
                status,
                url,
                error_body.chars().take(240).collect::<String>(),
            );
        }
        return Err(format!("HTTP {}: {}", status, error_body.chars().take(500).collect::<String>()));
    }

    let mut stream = response.bytes_stream();
    use futures_util::StreamExt;

    // Buffer for incomplete UTF-8 tail bytes that straddle chunk boundaries.
    // Without this, multi-byte CJK characters get mangled by from_utf8_lossy.
    let mut utf8_tail: Vec<u8> = Vec::new();

    while let Some(chunk_result) = stream.next().await {
        if STREAM_CANCEL.load(std::sync::atomic::Ordering::Relaxed) {
            let _ = app.emit(
                "chat-stream-done",
                StreamDonePayload {
                    stream_id: stream_id.clone(),
                    status: "cancelled".to_string(),
                    error: None,
                },
            );
            return Ok(());
        }

        match chunk_result {
            Ok(bytes) => {
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
                println!("[start_chat_stream] read_error url={} err={}", url, e);
                let _ = app.emit(
                    "chat-stream-done",
                    StreamDonePayload {
                        stream_id: stream_id.clone(),
                        status: "error".to_string(),
                        error: Some(format!("流读取错误: {e}")),
                    },
                );
                return Ok(());
            }
        }
    }

    let _ = app.emit(
        "chat-stream-done",
        StreamDonePayload {
            stream_id: stream_id.clone(),
            status: "ok".to_string(),
            error: None,
        },
    );

    if url.contains("/v1/chat/completions") || url.contains("/v1/responses") || url.contains("/v1/messages") {
        println!("[start_chat_stream] success url={}", url);
    }

    Ok(())
}

/// Cancel the active chat stream.
#[tauri::command]
fn cancel_chat_stream() -> Result<(), String> {
    STREAM_CANCEL.store(true, std::sync::atomic::Ordering::Relaxed);
    Ok(())
}

// endregion

// region: get_file_outline C# 符号提取

/// Lightweight regex-based C# symbol extractor.
/// Produces an "interface-first" outline: type declarations + public/protected
/// members, with method bodies stripped.
#[tauri::command]
fn get_file_outline(state: State<WorkspaceState>, path: String) -> Result<String, String> {
    let workspace = state.get_root()?;
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
) -> Result<Value, String> {
    let workspace = state.get_root()?;
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
) -> Result<Value, String> {
    let workspace = state.get_root()?;
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
) -> Result<Value, String> {
    let workspace = state.get_root()?;
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
) -> Result<Value, String> {
    let workspace = state.get_root()?;
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
fn delete_workspace_path(state: State<WorkspaceState>, path: String) -> Result<(), String> {
    let workspace = state.get_root()?;
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

// region: 应用启动

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let workspace_root = default_workspace_root().unwrap_or_else(|_| {
        std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
    });

    tauri::Builder::default()
        .manage(WorkspaceState::new(workspace_root))
        .manage(PtyManager::default())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            get_workspace_root,
            set_workspace_root,
            list_directory,
            get_project_skeleton,
            get_file_outline,
            read_file,
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
            count_tokens,
            get_system_memory,
            proxy_request,
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
            delete_workspace_path,
            delete_chat_temp_path,
            run_hook_command,
            delete_plan_files
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

// endregion

#[cfg(test)]
mod tests {
    use super::{
        compare_file_nodes,
        resolve_existing_path,
        resolve_write_path,
        should_hide_list_directory_entry,
        should_skip_recursive_search_dir,
        FileNode,
    };
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
    }

    #[test]
    fn recursive_search_skips_build_directories() {
        assert!(should_skip_recursive_search_dir("target"));
        assert!(should_skip_recursive_search_dir("PackageCache"));
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
}
