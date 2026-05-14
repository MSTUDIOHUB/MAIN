use crate::harness::permissions::PermissionGuard;
use crate::mcp::{
    arg_str, descriptor, result, McpToolCall, McpToolDescriptor, McpToolDomain, McpToolResult,
};
use serde_json::json;
use std::path::Path;
use std::time::Instant;

pub fn tools() -> Vec<McpToolDescriptor> {
    vec![
        descriptor(
            "browser.snapshot",
            McpToolDomain::Browser,
            "Record a browser automation snapshot request for replayable workflows.",
            "browser:read",
            json!({"type": "object", "properties": {"url": {"type": "string"}}}),
        ),
        descriptor(
            "browser.action",
            McpToolDomain::Browser,
            "Record a browser automation action request for replayable workflows.",
            "browser:action",
            json!({
                "type": "object",
                "properties": {
                    "url": {"type": "string"},
                    "action": {"type": "string"},
                    "selector": {"type": "string"}
                },
                "required": ["action"]
            }),
        ),
    ]
}

pub async fn call(
    _workspace: &Path,
    _permission_guard: &PermissionGuard,
    call: &McpToolCall,
) -> Result<McpToolResult, String> {
    let started_at = Instant::now();
    match call.tool.as_str() {
        "browser.snapshot" => {
            let url = arg_str(&call.arguments, "url").unwrap_or("about:blank");
            Ok(result(
                call,
                true,
                json!({"url": url, "status": "queued_for_browser_runtime"}),
                format!("browser snapshot requested for {url}"),
                "",
                started_at.elapsed().as_millis(),
            ))
        }
        "browser.action" => {
            let action =
                arg_str(&call.arguments, "action").ok_or("browser.action requires action")?;
            let selector = arg_str(&call.arguments, "selector").unwrap_or("");
            Ok(result(
                call,
                true,
                json!({
                    "action": action,
                    "selector": selector,
                    "status": "queued_for_browser_runtime"
                }),
                format!("browser action requested: {action} {selector}"),
                "",
                started_at.elapsed().as_millis(),
            ))
        }
        _ => Err(format!("unknown browser MCP tool: {}", call.tool)),
    }
}
