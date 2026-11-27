use serde_json::{json, Value};
use std::process::{Command, Stdio};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, ChildStdout},
};

const MAX_FRAME_BYTES: usize = 4 * 1024 * 1024;

/// A client for a local MCP process selected by the native connector.
pub(crate) struct StdioMcpClient {
    _child: Child,
    input: ChildStdin,
    output: BufReader<ChildStdout>,
    next_id: u32,
}

impl StdioMcpClient {
    pub(crate) async fn connect(command: Command, server_name: &str) -> Result<Self, String> {
        let mut child = tokio::process::Command::from(command)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .map_err(|_| "MCP_STDIO_START_FAILED")?;
        let input = child.stdin.take().ok_or("MCP_STDIO_NO_STDIN")?;
        let output = BufReader::new(child.stdout.take().ok_or("MCP_STDIO_NO_STDOUT")?);
        let mut client = Self {
            _child: child,
            input,
            output,
            next_id: 0,
        };
        let handshake = client
            .request(
                "initialize",
                json!({
                    "protocolVersion": "2025-11-25",
                    "capabilities": {},
                    "clientInfo": { "name": "MAIN", "version": env!("CARGO_PKG_VERSION") },
                }),
            )
            .await?;
        if handshake
            .pointer("/serverInfo/name")
            .and_then(Value::as_str)
            != Some(server_name)
            || !matches!(
                handshake["protocolVersion"].as_str(),
                Some("2025-11-25" | "2025-06-18" | "2025-03-26" | "2024-11-05")
            )
            || !handshake
                .pointer("/capabilities/tools")
                .is_some_and(Value::is_object)
        {
            return Err("MCP_STDIO_HANDSHAKE_MISMATCH".into());
        }
        client
            .send(json!({"jsonrpc": "2.0", "method": "notifications/initialized"}))
            .await?;
        Ok(client)
    }

    async fn send(&mut self, frame: Value) -> Result<(), String> {
        let mut bytes = serde_json::to_vec(&frame).map_err(|_| "MCP_STDIO_FRAME_INVALID")?;
        if bytes.len() >= MAX_FRAME_BYTES {
            return Err("MCP_STDIO_FRAME_TOO_LARGE".into());
        }
        bytes.push(b'\n');
        self.input
            .write_all(&bytes)
            .await
            .map_err(|_| "MCP_STDIO_WRITE_FAILED".into())
    }

    pub(crate) async fn request(&mut self, method: &str, params: Value) -> Result<Value, String> {
        self.next_id += 1;
        let id = self.next_id;
        self.send(json!({
            "jsonrpc": "2.0", "id": id, "method": method, "params": params
        }))
        .await?;
        let mut line = Vec::new();
        loop {
            line.clear();
            let count = (&mut self.output)
                .take(MAX_FRAME_BYTES as u64)
                .read_until(b'\n', &mut line)
                .await
                .map_err(|_| "MCP_STDIO_READ_FAILED")?;
            if count == 0 {
                return Err("MCP_STDIO_CLOSED".into());
            }
            if line.last() != Some(&b'\n') {
                return Err("MCP_STDIO_FRAME_INCOMPLETE".into());
            }
            let frame: Value =
                serde_json::from_slice(&line).map_err(|_| "MCP_STDIO_FRAME_INVALID")?;
            if frame["jsonrpc"].as_str() != Some("2.0") {
                return Err("MCP_STDIO_FRAME_INVALID".into());
            }
            if let Some(server_method) = frame["method"].as_str() {
                if let Some(server_id) = frame.get("id") {
                    self.send(if server_method == "ping" {
                        json!({"jsonrpc": "2.0", "id": server_id, "result": {}})
                    } else {
                        json!({"jsonrpc": "2.0", "id": server_id, "error": {"code": -32601, "message": "Method not supported"}})
                    }).await?;
                }
                continue;
            }
            if frame["id"].as_u64() != Some(u64::from(id)) {
                continue;
            }
            if let Some(error) = frame.get("error") {
                let message: String = error["message"]
                    .as_str()
                    .unwrap_or(method)
                    .chars()
                    .take(400)
                    .collect();
                return Err(format!("MCP_STDIO_RPC_ERROR: {message}"));
            }
            return frame
                .get("result")
                .cloned()
                .ok_or_else(|| "MCP_STDIO_RESULT_MISSING".into());
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn initializes_and_routes_by_id_over_stdio() {
        tauri::async_runtime::block_on(async {
            tokio::time::timeout(Duration::from_secs(5), async {
                let mut command = Command::new("/bin/sh");
                command.args(["-c", r#"
                    IFS= read -r line || exit 1
                    case "$line" in *'"method":"initialize"'*) ;; *) exit 2 ;; esac
                    printf '%s\n' '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-11-25","serverInfo":{"name":"fixture"},"capabilities":{"tools":{}}}}'
                    IFS= read -r line || exit 3
                    case "$line" in *'"method":"notifications/initialized"'*) ;; *) exit 4 ;; esac
                    IFS= read -r line || exit 5
                    case "$line" in *'"method":"tools/list"'*) ;; *) exit 6 ;; esac
                    printf '%s\n' '{"jsonrpc":"2.0","method":"notifications/tools/list_changed"}'
                    printf '%s\n' '{"jsonrpc":"2.0","id":42,"method":"ping"}'
                    IFS= read -r line || exit 7
                    case "$line" in *'"id":42'*'"result":{}'*) ;; *) exit 8 ;; esac
                    printf '%s\n' '{"jsonrpc":"2.0","id":99,"result":{}}'
                    printf '%s\n' '{"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"console"}]}}'
                "#]);
                let mut client = StdioMcpClient::connect(command, "fixture").await.unwrap();
                let list = client.request("tools/list", json!({})).await.unwrap();
                assert_eq!(list["tools"][0]["name"], "console");
            }).await.expect("fixture server completed");
        });
    }
}
