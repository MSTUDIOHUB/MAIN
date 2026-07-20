use crate::harness::permissions::PermissionGuard;
use crate::mcp::{
    arg_str, descriptor, failure_result, result, run_permissioned_shell, McpToolCall,
    McpToolDescriptor, McpToolDomain, McpToolResult,
};
use serde_json::json;
use std::path::Path;
use std::time::Instant;

pub fn tools() -> Vec<McpToolDescriptor> {
    vec![descriptor(
        "terminal.run",
        McpToolDomain::Terminal,
        "Run a permission-aware terminal command through the MCP runtime mesh.",
        "shell",
        json!({
            "type": "object",
            "properties": {
                "command": {"type": "string"},
                "timeoutMs": {"type": "number"}
            },
            "required": ["command"]
        }),
    )]
}

pub async fn call(
    workspace: &Path,
    permission_guard: &PermissionGuard,
    call: &McpToolCall,
) -> Result<McpToolResult, String> {
    match call.tool.as_str() {
        "terminal.run" => {
            let started_at = Instant::now();
            let command =
                arg_str(&call.arguments, "command").ok_or("terminal.run requires command")?;
            let timeout_ms = call
                .arguments
                .get("timeoutMs")
                .and_then(|value| value.as_u64())
                .unwrap_or(60_000)
                .clamp(100, 600_000);
            let execution = match run_permissioned_shell(
                workspace,
                permission_guard,
                command,
                timeout_ms,
            )
            .await
            {
                Ok(execution) => execution,
                Err(failure) => {
                    return Ok(failure_result(
                        call,
                        failure.kind.result_kind(),
                        failure.kind.as_str(),
                        failure.message,
                        started_at.elapsed().as_millis(),
                    ));
                }
            };
            Ok(result(
                call,
                execution.success,
                json!({
                    "command": command,
                    "timeoutMs": timeout_ms,
                    "exitCode": execution.exit_code,
                    "timedOut": execution.timed_out,
                    "stdoutTruncated": execution.stdout_truncated,
                    "stderrTruncated": execution.stderr_truncated,
                }),
                execution.stdout,
                execution.stderr,
                execution.duration_ms,
            ))
        }
        _ => Err(format!("unknown terminal MCP tool: {}", call.tool)),
    }
}
