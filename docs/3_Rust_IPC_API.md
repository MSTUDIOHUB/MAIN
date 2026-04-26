# MAIN — Rust Tauri Backend IPC API

All file operations go through Tauri IPC (`invoke`) to the Rust backend, which enforces **workspace-scoped path safety** via `ensure_in_workspace()`. This avoids `tauri-plugin-fs` permission dialogs entirely.

## 1. File System Operations

### 1.1 `read_file`
```rust
#[tauri::command]
fn read_file(path: String) -> Result<String, String>
```
Read complete file content. Path must be within workspace root. Binary files detected and rejected with error message.

### 1.2 `write_file`
```rust
#[tauri::command]
fn write_file(path: String, content: String) -> Result<(), String>
```
Write complete file content (create or overwrite). Only executed after user accepts ActionCard review. Path must be within workspace root.

### 1.3 `list_directory`
```rust
#[tauri::command]
fn list_directory(path: String) -> Result<Vec<FileNode>, String>
```
List files and subdirectories in a directory. Returns `FileNode { name, path, is_dir }`. Sorts directories first, then files alphabetically.

### 1.4 `glob_search`
```rust
#[tauri::command]
fn glob_search(pattern: String) -> Result<Vec<String>, String>
```
Search files by glob pattern (e.g., `**/*.tsx`, `src/**/*.ts`). Uses `walkdir` for efficient traversal. Results sorted by modification time (newest first).

### 1.5 `grep_search`
```rust
#[tauri::command]
fn grep_search(query: String, path: String) -> Result<String, String>
```
Fast regex search within files. Returns matched lines with file paths and line numbers. Safety limits:
- `GREP_MATCH_LIMIT`: 2000 matches max
- `GREP_OUTPUT_LIMIT_BYTES`: 512KB output max
- Binary files detected via `is_probably_binary()` and skipped

## 2. Project Intelligence

### 2.1 `get_project_skeleton`
```rust
#[tauri::command]
fn get_project_skeleton(depth: Option<usize>) -> Result<String, String>
```
Fast recursive directory tree with **Unity-aware** intelligence:
- **`.asmdef` module boundary**: Stops traversal at Assembly Definition files, marks as `[ASMDEF]`
- **Large directory folding**: Directories with >12 `.cs` files show `[... +N .cs files]`
- **Elastic depth穿透**: Passes through directories containing only subdirectories (no leaf files)
- **Ignored directories**: `node_modules`, `.git`, `Library`, `Temp`, `Obj`, `Bin`, `build`, `dist`, etc.
- Default depth: 4 levels

### 2.2 `get_file_outline`
```rust
#[tauri::command]
fn get_file_outline(path: String) -> Result<String, String>
```
Extract C# type definitions and `public`/`protected` member signatures (methods, properties, fields) without reading full source. Uses regex-based parsing (not tree-sitter) for lightweight interface extraction. Returns structured outline of:
- Class/struct/interface declarations
- Public/protected method signatures (without body)
- Public/protected property declarations
- Field declarations

## 3. PTY Terminal

### 3.1 `spawn_pty`
```rust
#[tauri::command]
fn spawn_pty(cols: u16, rows: u16) -> Result<(), String>
```
Spawn a new PTY instance with given dimensions. Uses `portable-pty` crate for cross-platform terminal.

### 3.2 `write_pty`
```rust
#[tauri::command]
fn write_pty(input: String) -> Result<(), String>
```
Write input to the PTY (as if the user typed it). Used by `execute_command` tool.

### 3.3 `read_pty_buffer`
```rust
#[tauri::command]
fn read_pty_buffer(max_chars: Option<usize>) -> Result<String, String>
```
Read captured terminal output. Buffer limited to `PTY_BUFFER_LIMIT_BYTES` (512KB). Kept for compatibility; agents should prefer `read_pty_tail` for recent logs or `read_pty_since` for incremental logs.

### 3.4 `read_pty_tail`
```rust
#[tauri::command]
fn read_pty_tail(max_chars: Option<usize>) -> Result<PtyReadResult, String>
```
Read the latest terminal log window plus `startOffset` / `endOffset` metadata.

### 3.5 `read_pty_since`
```rust
#[tauri::command]
fn read_pty_since(offset: u64, max_chars: Option<usize>) -> Result<PtyReadResult, String>
```
Read terminal output appended after a previous buffer offset. This lets agents run a command, inspect only new output, and continue polling from the returned `endOffset`.

### 3.6 `get_pty_status`
```rust
#[tauri::command]
fn get_pty_status() -> Result<PtyStatus, String>
```
Return PTY process state, pid, exit code if available, buffer offsets, buffer size, and a short recent-output tail.

### 3.7 `clear_pty_buffer`
```rust
#[tauri::command]
fn clear_pty_buffer() -> Result<PtyReadResult, String>
```
Clear the AI-side captured PTY buffer without closing the terminal process.

### 3.8 `run_command`
```rust
#[tauri::command]
fn run_command(command: String, input: Option<String>, timeout_ms: Option<u64>) -> Result<TerminalCommandOutput, String>
```
Run a finite shell command in the workspace and wait for completion. Returns `stdout`, `stderr`, `exitCode`, `timedOut`, `durationMs`, and truncation flags. Prefer this for tests, builds, Python scripts, and other commands where the agent needs a definitive result.

### 3.9 Event: `pty-data`
```rust
app.emit("pty-data", PtyDataPayload { chunk: String })
```
Emitted on each PTY output chunk. Frontend listens via `onPtyData()` and writes to xterm.js.

## 4. Token Counting

### 4.1 `count_tokens`
```rust
#[tauri::command]
fn count_tokens(text: String) -> Result<usize, String>
```
Count tokens using `tiktoken-rs`. Used for context budget estimation.

## 5. Network / Streaming Proxy

### 5.1 `start_chat_stream`
```rust
#[tauri::command]
fn start_chat_stream(stream_id: String, url: String, headers: HashMap<String, String>, body: String) -> Result<(), String>
```
Start an SSE stream from the Rust backend (bypasses WebView CORS). Chunks emitted as Tauri events:
- `chat-stream-chunk`: `{ stream_id, chunk }` — each SSE data chunk
- `chat-stream-done`: `{ stream_id, status, error? }` — stream completion

### 5.2 `cancel_chat_stream`
```rust
#[tauri::command]
fn cancel_chat_stream() -> Result<(), String>
```
Cancel the active SSE stream (used when user clicks Stop button).

### 5.3 `proxy_request`
```rust
#[tauri::command]
fn proxy_request(url: String, method: String, headers: HashMap<String, String>, body: Option<String>) -> Result<String, String>
```
Generic HTTP proxy for MCP server communication and other network requests.

## 6. Workspace Management

### 6.1 `get_workspace_root`
```rust
#[tauri::command]
fn get_workspace_root() -> Result<String, String>
```
Get current workspace root path.

### 6.2 `set_workspace_root`
```rust
#[tauri::command]
fn set_workspace_root(path: String) -> Result<String, String>
```
Set workspace root path. All file operations are validated against this path.

## 7. Plan File Management

### 7.1 `delete_plan_files`
```rust
#[tauri::command]
fn delete_plan_files() -> Result<(), String>
```
Delete spec files from `.MAIN/plans/` directory. Security-scoped: only deletes the 4 named spec files (`requirements.md`, `design.md`, `tasks.md`, `bugfix.md`). This is a manual cleanup action from the Plan panel / file tree; approved plans are preserved after execution.

## 8. MCP / Protocol Packages

### 8.1 `extract_protocol_package`
```rust
#[tauri::command]
fn extract_protocol_package(slot: String, zip_data: Vec<u8>) -> Result<(), String>
```
Extract a protocol package ZIP to `.protocols/<slot>/`. Contains SKILL.md entry point and supporting files.

### 8.2 `delete_protocol_package`
```rust
#[tauri::command]
fn delete_protocol_package(slot: String) -> Result<(), String>
```
Delete an extracted protocol package directory.

## 9. Security Model

All file operations are **strictly workspace-scoped**:

```rust
fn ensure_in_workspace(path: &str, workspace_root: &str) -> Result<PathBuf, String> {
    let canonical = canonicalize(path)?;
    let root = canonicalize(workspace_root)?;
    if !canonical.starts_with(&root) {
        return Err("Path is outside workspace".into());
    }
    Ok(canonical)
}
```

Additional safety measures:
- **Binary detection**: `is_probably_binary()` prevents grepping non-text files
- **Output limits**: Grep (512KB), PTY buffer (512KB), tool results (8000 chars in orchestrator)
- **Path traversal prevention**: `..` components resolved and validated
