use crate::harness::permissions::PermissionGuard;
use crate::mcp::{
    arg_str, descriptor, result, run_permissioned_shell, McpToolCall, McpToolDescriptor,
    McpToolDomain, McpToolResult,
};
use serde_json::json;
use std::path::Path;

pub fn tools() -> Vec<McpToolDescriptor> {
    vec![
        descriptor(
            "git.status",
            McpToolDomain::Git,
            "Read git status through the MCP runtime mesh.",
            "git:read",
            json!({"type": "object", "properties": {}}),
        ),
        descriptor(
            "git.diff",
            McpToolDomain::Git,
            "Read git diff through the MCP runtime mesh.",
            "git:read",
            json!({"type": "object", "properties": {"path": {"type": "string"}}}),
        ),
        descriptor(
            "git.files",
            McpToolDomain::Git,
            "List tracked files through the MCP runtime mesh.",
            "git:read",
            json!({"type": "object", "properties": {}}),
        ),
    ]
}

pub async fn call(
    workspace: &Path,
    permission_guard: &PermissionGuard,
    call: &McpToolCall,
) -> Result<McpToolResult, String> {
    let command = match call.tool.as_str() {
        "git.status" => "git status --short --branch".to_string(),
        "git.diff" => {
            if let Some(path) = arg_str(&call.arguments, "path") {
                format!("git diff -- {path}")
            } else {
                "git diff".to_string()
            }
        }
        "git.files" => "git ls-files".to_string(),
        _ => return Err(format!("unknown git MCP tool: {}", call.tool)),
    };

    let (success, stdout, stderr, latency_ms) =
        run_permissioned_shell(workspace, permission_guard, &command, 60_000).await?;
    Ok(result(
        call,
        success,
        json!({"command": command}),
        stdout,
        stderr,
        latency_ms,
    ))
}
