use crate::harness::permissions::PermissionGuard;
use crate::mcp::{
    arg_str, descriptor, result, workspace_path, McpToolCall, McpToolDescriptor, McpToolDomain,
    McpToolResult,
};
use serde_json::json;
use std::path::Path;
use std::time::Instant;

pub fn tools() -> Vec<McpToolDescriptor> {
    vec![
        descriptor(
            "filesystem.read",
            McpToolDomain::Filesystem,
            "Read a workspace file through the MCP runtime mesh.",
            "filesystem:read",
            json!({"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"]}),
        ),
        descriptor(
            "filesystem.write",
            McpToolDomain::Filesystem,
            "Write a workspace file through the MCP runtime mesh.",
            "filesystem:write",
            json!({
                "type": "object",
                "properties": {
                    "path": {"type": "string"},
                    "content": {"type": "string"}
                },
                "required": ["path", "content"]
            }),
        ),
        descriptor(
            "filesystem.list",
            McpToolDomain::Filesystem,
            "List workspace directory entries through the MCP runtime mesh.",
            "filesystem:list",
            json!({"type": "object", "properties": {"path": {"type": "string"}}}),
        ),
    ]
}

pub async fn call(
    workspace: &Path,
    _permission_guard: &PermissionGuard,
    call: &McpToolCall,
) -> Result<McpToolResult, String> {
    let started_at = Instant::now();
    match call.tool.as_str() {
        "filesystem.read" => {
            let raw_path =
                arg_str(&call.arguments, "path").ok_or("filesystem.read requires path")?;
            let path = workspace_path(workspace, raw_path)?;
            let content = tokio::fs::read_to_string(&path).await.map_err(|error| {
                format!("MCP filesystem.read failed {}: {error}", path.display())
            })?;
            Ok(result(
                call,
                true,
                json!({"path": raw_path, "bytes": content.len()}),
                content,
                "",
                started_at.elapsed().as_millis(),
            ))
        }
        "filesystem.write" => {
            let raw_path =
                arg_str(&call.arguments, "path").ok_or("filesystem.write requires path")?;
            let content =
                arg_str(&call.arguments, "content").ok_or("filesystem.write requires content")?;
            let path = workspace_path(workspace, raw_path)?;
            if let Some(parent) = path.parent() {
                tokio::fs::create_dir_all(parent)
                    .await
                    .map_err(|error| format!("MCP filesystem.write mkdir failed: {error}"))?;
            }
            tokio::fs::write(&path, content).await.map_err(|error| {
                format!("MCP filesystem.write failed {}: {error}", path.display())
            })?;
            Ok(result(
                call,
                true,
                json!({"path": raw_path, "bytes": content.len()}),
                format!("wrote {raw_path}"),
                "",
                started_at.elapsed().as_millis(),
            ))
        }
        "filesystem.list" => {
            let raw_path = arg_str(&call.arguments, "path").unwrap_or(".");
            let path = workspace_path(workspace, raw_path)?;
            let mut entries = Vec::new();
            let mut reader = tokio::fs::read_dir(&path).await.map_err(|error| {
                format!("MCP filesystem.list failed {}: {error}", path.display())
            })?;
            while let Some(entry) = reader
                .next_entry()
                .await
                .map_err(|error| format!("MCP filesystem.list entry failed: {error}"))?
            {
                let file_type = entry
                    .file_type()
                    .await
                    .map_err(|error| format!("MCP filesystem.list file type failed: {error}"))?;
                entries.push(json!({
                    "name": entry.file_name().to_string_lossy(),
                    "isDir": file_type.is_dir(),
                }));
            }
            Ok(result(
                call,
                true,
                json!({"path": raw_path, "entries": entries}),
                "",
                "",
                started_at.elapsed().as_millis(),
            ))
        }
        _ => Err(format!("unknown filesystem MCP tool: {}", call.tool)),
    }
}
