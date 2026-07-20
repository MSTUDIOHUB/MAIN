pub mod browser;
pub mod filesystem;
pub mod git;
pub mod terminal;
pub mod unity;

use crate::harness::permissions::{PermissionError, PermissionGuard};
use crate::harness::tracing::{
    digest_tool_input, digest_tool_output, new_trace_run_id, TraceRecord, TraceRecorder,
    TraceResultKind, TRACE_SCHEMA_VERSION,
};
use crate::task_graph::{TaskGraphFuture, TaskGraphRunner, TaskGraphStepResult, TaskNode};
use crate::trusted_execution::{
    execute_trusted_shell, resolve_workspace_path, ExecutionResult, WorkspacePathMode,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum McpToolDomain {
    Unity,
    Browser,
    Git,
    Filesystem,
    Terminal,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpToolDescriptor {
    pub name: String,
    pub domain: McpToolDomain,
    pub description: String,
    pub permission_scope: String,
    pub traceable: bool,
    pub replayable: bool,
    pub input_schema: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpReplayRef {
    pub task_id: String,
    pub step_id: String,
    #[serde(default)]
    pub run_id: Option<String>,
    #[serde(default)]
    pub sequence: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpToolCall {
    pub id: String,
    pub task_id: String,
    #[serde(default)]
    pub run_id: Option<String>,
    pub tool: String,
    pub arguments: Value,
    pub replay: Option<McpReplayRef>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpToolResult {
    pub id: String,
    pub task_id: String,
    pub tool: String,
    pub success: bool,
    pub result_kind: TraceResultKind,
    pub content: Value,
    pub stdout: String,
    pub stderr: String,
    pub latency_ms: u128,
    pub trace_path: Option<String>,
    pub run_id: Option<String>,
    pub trace_sequence: Option<u64>,
    pub replayed: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum McpShellFailureKind {
    PermissionDenied,
    ApprovalRequired,
    PermissionConfiguration,
    ExecutionRejected,
}

impl McpShellFailureKind {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::PermissionDenied => "permission_denied",
            Self::ApprovalRequired => "approval_required",
            Self::PermissionConfiguration => "permission_configuration",
            Self::ExecutionRejected => "execution_rejected",
        }
    }

    pub(crate) fn result_kind(self) -> TraceResultKind {
        match self {
            Self::PermissionDenied | Self::ApprovalRequired | Self::PermissionConfiguration => {
                TraceResultKind::Blocked
            }
            Self::ExecutionRejected => TraceResultKind::Error,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct McpShellFailure {
    pub kind: McpShellFailureKind,
    pub message: String,
}

#[derive(Debug, Clone)]
pub struct McpRuntimeMesh {
    workspace: PathBuf,
    permission_guard: PermissionGuard,
    trace_recorder: TraceRecorder,
}

impl McpRuntimeMesh {
    pub fn for_workspace(workspace: impl AsRef<Path>) -> Result<Self, String> {
        let workspace = workspace.as_ref().to_path_buf();
        let permission_guard =
            PermissionGuard::from_workspace(&workspace).map_err(|error| error.to_string())?;
        let trace_recorder = TraceRecorder::for_workspace(&workspace);
        Ok(Self {
            workspace,
            permission_guard,
            trace_recorder,
        })
    }

    pub fn list_tools() -> Vec<McpToolDescriptor> {
        let mut tools = Vec::new();
        tools.extend(unity::tools());
        tools.extend(browser::tools());
        tools.extend(git::tools());
        tools.extend(filesystem::tools());
        tools.extend(terminal::tools());
        tools
    }

    pub async fn call_tool(&self, call: McpToolCall) -> Result<McpToolResult, String> {
        if let Some(replay) = call.replay.as_ref() {
            return self.replay_tool_call(&call, replay).await;
        }

        let started_at = Instant::now();
        let run_id = call
            .run_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .unwrap_or_else(new_trace_run_id);
        let known_tool = Self::list_tools()
            .iter()
            .any(|descriptor| descriptor.name == call.tool);
        let dispatched = if !known_tool {
            Err(format!("unknown MCP tool: {}", call.tool))
        } else {
            match call.tool.split('.').next().unwrap_or_default() {
                "unity" => unity::call(&self.workspace, &self.permission_guard, &call).await,
                "browser" => browser::call(&self.workspace, &self.permission_guard, &call).await,
                "git" => git::call(&self.workspace, &self.permission_guard, &call).await,
                "filesystem" => {
                    filesystem::call(&self.workspace, &self.permission_guard, &call).await
                }
                "terminal" => terminal::call(&self.workspace, &self.permission_guard, &call).await,
                _ => Err(format!("unknown MCP tool: {}", call.tool)),
            }
        };
        let mut result = match dispatched {
            Ok(result) => result,
            Err(error) => failure_result(
                &call,
                TraceResultKind::Error,
                if known_tool {
                    "operation_error"
                } else {
                    "unknown_tool"
                },
                error,
                started_at.elapsed().as_millis(),
            ),
        };
        result.run_id = Some(run_id.clone());

        let mut trace = TraceRecord::tool_result(
            result.task_id.clone(),
            result.id.clone(),
            result.tool.clone(),
            result.stdout.clone(),
            result.stderr.clone(),
            if result.success { "success" } else { "error" },
            result.latency_ms,
            result.success,
        );
        trace.run_id = Some(run_id.clone());
        trace.input_digest = digest_tool_input(&result.tool, &call.arguments);
        trace.structured_output = result.content.clone();
        trace.result_kind = result.result_kind;
        trace.exit_code = result
            .content
            .get("exitCode")
            .and_then(Value::as_i64)
            .and_then(|value| i32::try_from(value).ok());
        trace.timed_out = result
            .content
            .get("timedOut")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        trace.stdout_truncated = result
            .content
            .get("stdoutTruncated")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        trace.stderr_truncated = result
            .content
            .get("stderrTruncated")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        trace.events = vec!["tool_called".to_string(), "tool_result".to_string()];
        trace.metadata = json!({
            "traceKind": "mcp_tool_result",
            "mcpTool": result.tool,
            "success": result.success,
            "resultKind": result.result_kind,
            "inputDigestFormat": "mcp_tool_v1",
            "outputDigestFormat": "structured_tool_result_v1",
            "traceAware": true,
            "replayAware": true,
        });
        let (trace_path, trace_sequence) = self.trace_recorder.record_with_sequence(&trace).await?;
        result.trace_path = Some(trace_path.to_string_lossy().to_string());
        result.trace_sequence = Some(trace_sequence);
        Ok(result)
    }

    async fn replay_tool_call(
        &self,
        call: &McpToolCall,
        replay: &McpReplayRef,
    ) -> Result<McpToolResult, String> {
        if call.task_id != replay.task_id {
            return Err(format!(
                "replay task identity mismatch: call task={} replay task={}",
                call.task_id, replay.task_id
            ));
        }

        let trace = match (replay.sequence, replay.run_id.as_deref()) {
            (Some(sequence), _) => self
                .trace_recorder
                .load_exact(&replay.task_id, sequence)
                .await?,
            (None, Some(run_id)) => self
                .trace_recorder
                .replay_run(&replay.task_id, run_id)
                .await?
                .into_iter()
                .filter(|record| record.step_id == replay.step_id)
                .max_by_key(|record| (record.sequence, record.attempt))
                .ok_or_else(|| {
                    format!(
                        "未找到 trace task={} run={} step={}",
                        replay.task_id, run_id, replay.step_id
                    )
                })?,
            // An imprecise latest-step lookup exists solely for persisted
            // pre-run-id traces. New records must supply sequence or runId.
            (None, None) => self
                .trace_recorder
                .replay(&replay.task_id)
                .await?
                .into_iter()
                .filter(|record| record.run_id.is_none() && record.step_id == replay.step_id)
                .max_by_key(|record| (record.sequence, record.attempt))
                .ok_or_else(|| {
                    format!(
                        "legacy replay requires an unscoped trace task={} step={}; new traces require sequence or runId",
                        replay.task_id, replay.step_id
                    )
                })?,
        };

        validate_replay_identity(call, replay, &trace)?;
        let success = trace.recorded_success();
        let result_kind = trace.recorded_result_kind();
        Ok(McpToolResult {
            id: call.id.clone(),
            task_id: call.task_id.clone(),
            tool: call.tool.clone(),
            success,
            result_kind,
            content: trace.structured_output,
            stdout: trace.stdout,
            stderr: trace.stderr,
            latency_ms: trace.latency_ms,
            trace_path: None,
            run_id: trace.run_id,
            trace_sequence: Some(trace.sequence),
            replayed: true,
        })
    }
}

pub struct McpTaskGraphRunner<'a> {
    mesh: &'a McpRuntimeMesh,
    graph_task_id: String,
    graph_run_id: String,
}

impl<'a> McpTaskGraphRunner<'a> {
    pub fn new(mesh: &'a McpRuntimeMesh, graph_task_id: impl Into<String>) -> Self {
        Self::with_run_id(mesh, graph_task_id, new_trace_run_id())
    }

    pub fn with_run_id(
        mesh: &'a McpRuntimeMesh,
        graph_task_id: impl Into<String>,
        graph_run_id: impl Into<String>,
    ) -> Self {
        let graph_run_id = graph_run_id.into();
        let graph_run_id = if graph_run_id.trim().is_empty() {
            new_trace_run_id()
        } else {
            graph_run_id.trim().to_string()
        };
        Self {
            mesh,
            graph_task_id: graph_task_id.into(),
            graph_run_id,
        }
    }

    pub fn run_id(&self) -> &str {
        &self.graph_run_id
    }
}

impl TaskGraphRunner for McpTaskGraphRunner<'_> {
    fn run_id(&self) -> Option<&str> {
        Some(&self.graph_run_id)
    }

    fn run<'a>(&'a self, node: TaskNode) -> TaskGraphFuture<'a, TaskGraphStepResult> {
        Box::pin(async move {
            let started_at = Instant::now();
            let Some(tool) = node.tool.clone() else {
                return TaskGraphStepResult {
                    node_id: node.id,
                    success: true,
                    output: json!({
                        "description": node.description,
                        "agent": node.agent,
                        "status": "planned_without_tool"
                    }),
                    latency_ms: started_at.elapsed().as_millis(),
                    tool_calls: 0,
                };
            };

            match self
                .mesh
                .call_tool(McpToolCall {
                    id: node.id.clone(),
                    task_id: self.graph_task_id.clone(),
                    run_id: Some(self.graph_run_id.clone()),
                    tool,
                    arguments: node.input,
                    replay: None,
                })
                .await
            {
                Ok(result) => TaskGraphStepResult {
                    node_id: node.id,
                    success: result.success,
                    output: result.content,
                    latency_ms: result.latency_ms,
                    tool_calls: 1,
                },
                Err(error) => TaskGraphStepResult {
                    node_id: node.id,
                    success: false,
                    output: json!({"error": error}),
                    latency_ms: started_at.elapsed().as_millis(),
                    tool_calls: 1,
                },
            }
        })
    }
}

pub(crate) fn descriptor(
    name: &str,
    domain: McpToolDomain,
    description: &str,
    permission_scope: &str,
    input_schema: Value,
) -> McpToolDescriptor {
    McpToolDescriptor {
        name: name.to_string(),
        domain,
        description: description.to_string(),
        permission_scope: permission_scope.to_string(),
        traceable: true,
        replayable: true,
        input_schema,
    }
}

pub(crate) fn result(
    call: &McpToolCall,
    success: bool,
    content: Value,
    stdout: impl Into<String>,
    stderr: impl Into<String>,
    latency_ms: u128,
) -> McpToolResult {
    McpToolResult {
        id: call.id.clone(),
        task_id: call.task_id.clone(),
        tool: call.tool.clone(),
        success,
        result_kind: if success {
            TraceResultKind::Success
        } else {
            TraceResultKind::Error
        },
        content,
        stdout: stdout.into(),
        stderr: stderr.into(),
        latency_ms,
        trace_path: None,
        run_id: call.run_id.clone(),
        trace_sequence: None,
        replayed: false,
    }
}

pub(crate) fn failure_result(
    call: &McpToolCall,
    result_kind: TraceResultKind,
    error_kind: &str,
    error: impl Into<String>,
    latency_ms: u128,
) -> McpToolResult {
    let error = error.into();
    let mut failed = result(
        call,
        false,
        json!({
            "error": &error,
            "errorKind": error_kind,
            "resultKind": result_kind,
        }),
        "",
        error,
        latency_ms,
    );
    failed.result_kind = result_kind;
    failed
}

fn validate_replay_identity(
    call: &McpToolCall,
    replay: &McpReplayRef,
    trace: &TraceRecord,
) -> Result<(), String> {
    if trace.task_id != call.task_id {
        return Err(format!(
            "replay trace task identity mismatch: expected={} recorded={}",
            call.task_id, trace.task_id
        ));
    }
    if trace.step_id != replay.step_id {
        return Err(format!(
            "replay step identity mismatch: expected={} recorded={}",
            replay.step_id, trace.step_id
        ));
    }
    if trace.tool_call != call.tool {
        return Err(format!(
            "replay tool identity mismatch: expected={} recorded={}",
            call.tool, trace.tool_call
        ));
    }
    if trace.event_name != "tool_called" {
        return Err(format!(
            "replay event identity mismatch: expected=tool_called recorded={}",
            trace.event_name
        ));
    }
    if let Some(sequence) = replay.sequence {
        if trace.sequence != sequence {
            return Err(format!(
                "replay sequence identity mismatch: expected={sequence} recorded={}",
                trace.sequence
            ));
        }
    }
    if let Some(run_id) = replay.run_id.as_deref() {
        if trace.run_id.as_deref() != Some(run_id) {
            return Err(format!(
                "replay run identity mismatch: expected={run_id} recorded={}",
                trace.run_id.as_deref().unwrap_or("<legacy-unscoped>")
            ));
        }
    }

    let is_structured_mcp_trace =
        trace.metadata.get("traceKind").and_then(Value::as_str) == Some("mcp_tool_result");
    if trace.schema_version >= TRACE_SCHEMA_VERSION && !is_structured_mcp_trace {
        return Err(
            "replay trace kind mismatch: current-schema record is not an MCP tool result"
                .to_string(),
        );
    }
    if !is_structured_mcp_trace && trace.run_id.is_some() {
        return Err(
            "replay trace kind mismatch: legacy compatibility is limited to unscoped traces"
                .to_string(),
        );
    }
    if is_structured_mcp_trace {
        if trace
            .metadata
            .get("inputDigestFormat")
            .and_then(Value::as_str)
            != Some("mcp_tool_v1")
            || trace
                .metadata
                .get("outputDigestFormat")
                .and_then(Value::as_str)
                != Some("structured_tool_result_v1")
        {
            return Err(
                "replay digest format mismatch: structured MCP trace format is unsupported"
                    .to_string(),
            );
        }
        if !trace.events.iter().any(|event| event == "tool_result") {
            return Err(
                "replay event identity mismatch: MCP trace is missing tool_result".to_string(),
            );
        }
        let expected_input = digest_tool_input(&call.tool, &call.arguments);
        if trace.input_digest != expected_input {
            return Err(format!(
                "replay input digest mismatch: expected={expected_input} recorded={}",
                trace.input_digest
            ));
        }
        let expected_output =
            digest_tool_output(&trace.structured_output, &trace.stdout, &trace.stderr);
        if trace.output_digest != expected_output {
            return Err(format!(
                "replay output digest mismatch: expected={expected_output} recorded={}",
                trace.output_digest
            ));
        }
    }
    Ok(())
}

pub(crate) fn arg_str<'a>(arguments: &'a Value, key: &str) -> Option<&'a str> {
    arguments.get(key).and_then(Value::as_str)
}

pub(crate) fn arg_bool(arguments: &Value, key: &str, default: bool) -> bool {
    arguments
        .get(key)
        .and_then(Value::as_bool)
        .unwrap_or(default)
}

pub(crate) fn workspace_path(
    workspace: &Path,
    raw_path: &str,
    mode: WorkspacePathMode,
) -> Result<PathBuf, String> {
    let requested = if raw_path.trim().is_empty() {
        Path::new(".")
    } else {
        Path::new(raw_path)
    };
    resolve_workspace_path(workspace, requested, mode)
        .map(|trusted| trusted.path().to_path_buf())
        .map_err(|error| format!("MCP trusted workspace path rejected: {error}"))
}

pub(crate) async fn run_permissioned_shell(
    workspace: &Path,
    permission_guard: &PermissionGuard,
    command: &str,
    timeout_ms: u64,
) -> Result<ExecutionResult, McpShellFailure> {
    permission_guard.validate(command).map_err(|error| {
        let kind = match &error {
            PermissionError::Denied { .. } | PermissionError::NotAllowed { .. } => {
                McpShellFailureKind::PermissionDenied
            }
            PermissionError::ApprovalRequired { .. } => McpShellFailureKind::ApprovalRequired,
            PermissionError::InvalidConfig { .. } => McpShellFailureKind::PermissionConfiguration,
        };
        McpShellFailure {
            kind,
            message: error.to_string(),
        }
    })?;
    execute_trusted_shell(
        workspace,
        workspace,
        command,
        Duration::from_millis(timeout_ms),
        Some(1024 * 1024),
    )
    .await
    .map_err(|error| McpShellFailure {
        kind: McpShellFailureKind::ExecutionRejected,
        message: format!("MCP trusted shell rejected: {error}"),
    })
}

#[cfg(test)]
mod tests {
    use super::{McpReplayRef, McpRuntimeMesh, McpTaskGraphRunner, McpToolCall};
    use crate::harness::tracing::{digest_tool_input, digest_tool_output, TraceResultKind};
    use crate::task_graph::{AgentRole, TaskGraph, TaskNode};
    use serde_json::json;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_workspace() -> std::path::PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("main-mcp-{unique}"));
        fs::create_dir_all(root.join(".MAIN")).unwrap();
        fs::write(
            root.join(".MAIN").join("permissions.yaml"),
            "shell:\n  allow:\n    - ls\n  deny:\n    - sudo\n",
        )
        .unwrap();
        root
    }

    fn tool_call(
        id: &str,
        task_id: &str,
        run_id: Option<&str>,
        tool: &str,
        arguments: serde_json::Value,
    ) -> McpToolCall {
        McpToolCall {
            id: id.to_string(),
            task_id: task_id.to_string(),
            run_id: run_id.map(str::to_string),
            tool: tool.to_string(),
            arguments,
            replay: None,
        }
    }

    fn replay_call(
        id: &str,
        call_task_id: &str,
        tool: &str,
        arguments: serde_json::Value,
        replay_task_id: &str,
        step_id: &str,
        run_id: Option<&str>,
        sequence: Option<u64>,
    ) -> McpToolCall {
        McpToolCall {
            id: id.to_string(),
            task_id: call_task_id.to_string(),
            run_id: None,
            tool: tool.to_string(),
            arguments,
            replay: Some(McpReplayRef {
                task_id: replay_task_id.to_string(),
                step_id: step_id.to_string(),
                run_id: run_id.map(str::to_string),
                sequence,
            }),
        }
    }

    #[test]
    fn mesh_replay_round_trips_structured_content_and_canonical_digests() {
        let root = temp_workspace();
        fs::write(root.join("README.md"), "# Test").unwrap();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            let mesh = McpRuntimeMesh::for_workspace(&root).unwrap();
            let arguments = json!({"path": "README.md", "unused": {"b": 2, "a": 1}});
            let result = mesh
                .call_tool(tool_call(
                    "step-1",
                    "task",
                    Some("run-a"),
                    "filesystem.read",
                    arguments.clone(),
                ))
                .await
                .unwrap();
            assert!(result.success);
            assert!(result.trace_path.is_some());
            assert_eq!(result.run_id.as_deref(), Some("run-a"));
            let sequence = result.trace_sequence.unwrap();
            let original_content = result.content.clone();

            let trace = mesh
                .trace_recorder
                .load_exact("task", sequence)
                .await
                .unwrap();
            assert_eq!(trace.run_id.as_deref(), Some("run-a"));
            assert_eq!(trace.structured_output, original_content);
            assert_eq!(
                trace.input_digest,
                digest_tool_input("filesystem.read", &arguments)
            );
            assert_eq!(
                trace.output_digest,
                digest_tool_output(&original_content, "# Test", "")
            );

            let replayed = mesh
                .call_tool(replay_call(
                    "replay",
                    "task",
                    "filesystem.read",
                    arguments.clone(),
                    "task",
                    "step-1",
                    Some("run-a"),
                    Some(sequence),
                ))
                .await
                .unwrap();
            assert!(replayed.replayed);
            assert_eq!(replayed.stdout, "# Test");
            assert_eq!(replayed.content, original_content);
            assert_eq!(replayed.run_id.as_deref(), Some("run-a"));
            assert_eq!(replayed.trace_sequence, Some(sequence));

            let write_result = mesh
                .call_tool(tool_call(
                    "step-2",
                    "task",
                    Some("run-a"),
                    "filesystem.write",
                    json!({"path": "generated/nested.txt", "content": "ok"}),
                ))
                .await
                .unwrap();
            assert!(write_result.success);
            assert_eq!(
                fs::read_to_string(root.join("generated/nested.txt")).unwrap(),
                "ok"
            );
        });
    }

    #[test]
    fn replay_rejects_wrong_task_tool_run_sequence_and_arguments() {
        let root = temp_workspace();
        fs::write(root.join("README.md"), "# Test").unwrap();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            let mesh = McpRuntimeMesh::for_workspace(&root).unwrap();
            let arguments = json!({"path": "README.md"});
            let result = mesh
                .call_tool(tool_call(
                    "step",
                    "task",
                    Some("run-good"),
                    "filesystem.read",
                    arguments.clone(),
                ))
                .await
                .unwrap();
            let sequence = result.trace_sequence.unwrap();

            let wrong_task = mesh
                .call_tool(replay_call(
                    "replay",
                    "other-task",
                    "filesystem.read",
                    arguments.clone(),
                    "task",
                    "step",
                    Some("run-good"),
                    Some(sequence),
                ))
                .await
                .unwrap_err();
            assert!(wrong_task.contains("task identity mismatch"));

            let wrong_tool = mesh
                .call_tool(replay_call(
                    "replay",
                    "task",
                    "filesystem.list",
                    arguments.clone(),
                    "task",
                    "step",
                    Some("run-good"),
                    Some(sequence),
                ))
                .await
                .unwrap_err();
            assert!(wrong_tool.contains("tool identity mismatch"));

            let wrong_run = mesh
                .call_tool(replay_call(
                    "replay",
                    "task",
                    "filesystem.read",
                    arguments.clone(),
                    "task",
                    "step",
                    Some("run-wrong"),
                    Some(sequence),
                ))
                .await
                .unwrap_err();
            assert!(wrong_run.contains("run identity mismatch"));

            let wrong_sequence = mesh
                .call_tool(replay_call(
                    "replay",
                    "task",
                    "filesystem.read",
                    arguments.clone(),
                    "task",
                    "step",
                    Some("run-good"),
                    Some(sequence + 10_000),
                ))
                .await
                .unwrap_err();
            assert!(wrong_sequence.contains("sequence"));

            let wrong_arguments = mesh
                .call_tool(replay_call(
                    "replay",
                    "task",
                    "filesystem.read",
                    json!({"path": "different.md"}),
                    "task",
                    "step",
                    Some("run-good"),
                    Some(sequence),
                ))
                .await
                .unwrap_err();
            assert!(wrong_arguments.contains("input digest mismatch"));

            let imprecise_new_trace = mesh
                .call_tool(replay_call(
                    "replay",
                    "task",
                    "filesystem.read",
                    arguments,
                    "task",
                    "step",
                    None,
                    None,
                ))
                .await
                .unwrap_err();
            assert!(imprecise_new_trace.contains("new traces require sequence or runId"));
        });
    }

    #[test]
    fn imprecise_latest_replay_is_limited_to_legacy_unscoped_traces() {
        let root = temp_workspace();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            let mesh = McpRuntimeMesh::for_workspace(&root).unwrap();
            let legacy: crate::harness::tracing::TraceRecord = serde_json::from_value(json!({
                "taskId": "legacy",
                "stepId": "step",
                "eventName": "tool_called",
                "toolCall": "filesystem.list",
                "stdout": "legacy stdout",
                "stderr": "",
                "verification": "passed",
                "latencyMs": 1,
                "metadata": {}
            }))
            .unwrap();
            fs::create_dir_all(mesh.trace_recorder.root()).unwrap();
            fs::write(
                mesh.trace_recorder
                    .root()
                    .join("legacy__00000000000000000001__step__attempt-0001.json"),
                serde_json::to_vec_pretty(&legacy).unwrap(),
            )
            .unwrap();

            let replayed = mesh
                .call_tool(replay_call(
                    "replay",
                    "legacy",
                    "filesystem.list",
                    json!({}),
                    "legacy",
                    "step",
                    None,
                    None,
                ))
                .await
                .unwrap();
            assert!(replayed.replayed);
            assert!(replayed.success);
            assert_eq!(replayed.run_id, None);
            assert_eq!(replayed.stdout, "legacy stdout");
            // v1 had no first-class structured payload; compatibility must
            // not invent one from metadata.
            assert_eq!(replayed.content, serde_json::Value::Null);
        });
    }

    #[test]
    fn operation_permission_and_unknown_tool_failures_are_traced_results() {
        let root = temp_workspace();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            let mesh = McpRuntimeMesh::for_workspace(&root).unwrap();
            let operation = mesh
                .call_tool(tool_call(
                    "invalid-args",
                    "failures",
                    Some("run-failures"),
                    "filesystem.read",
                    json!({}),
                ))
                .await
                .unwrap();
            assert!(!operation.success);
            assert_eq!(operation.result_kind, TraceResultKind::Error);
            assert_eq!(operation.content["errorKind"], "operation_error");

            let permission = mesh
                .call_tool(tool_call(
                    "permission",
                    "failures",
                    Some("run-failures"),
                    "terminal.run",
                    json!({"command": "sudo echo unsafe"}),
                ))
                .await
                .unwrap();
            assert!(!permission.success);
            assert_eq!(permission.result_kind, TraceResultKind::Blocked);
            assert_eq!(permission.content["errorKind"], "permission_denied");

            let unknown = mesh
                .call_tool(tool_call(
                    "unknown",
                    "failures",
                    Some("run-failures"),
                    "unknown.tool",
                    json!({"value": 1}),
                ))
                .await
                .unwrap();
            assert!(!unknown.success);
            assert_eq!(unknown.result_kind, TraceResultKind::Error);
            assert_eq!(unknown.content["errorKind"], "unknown_tool");

            let traces = mesh
                .trace_recorder
                .replay_run("failures", "run-failures")
                .await
                .unwrap();
            assert_eq!(traces.len(), 3);
            assert_eq!(traces[0].structured_output, operation.content);
            assert_eq!(traces[1].result_kind, TraceResultKind::Blocked);
            assert_eq!(traces[1].structured_output, permission.content);
            assert_eq!(traces[2].structured_output, unknown.content);
            assert!(traces.iter().all(|trace| {
                trace.events == ["tool_called".to_string(), "tool_result".to_string()]
            }));
        });
    }

    #[test]
    fn task_graph_nodes_share_one_run_identity() {
        let root = temp_workspace();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            let mesh = McpRuntimeMesh::for_workspace(&root).unwrap();
            let runner = McpTaskGraphRunner::with_run_id(&mesh, "graph", "graph-run");
            assert_eq!(runner.run_id(), "graph-run");
            let graph = TaskGraph {
                id: "graph".to_string(),
                nodes: vec![
                    TaskNode {
                        id: "first".to_string(),
                        description: "first".to_string(),
                        agent: AgentRole::Executor,
                        dependencies: Vec::new(),
                        tool: Some("filesystem.list".to_string()),
                        input: json!({"path": "."}),
                    },
                    TaskNode {
                        id: "second".to_string(),
                        description: "second".to_string(),
                        agent: AgentRole::Critic,
                        dependencies: vec!["first".to_string()],
                        tool: Some("filesystem.list".to_string()),
                        input: json!({"path": ".MAIN"}),
                    },
                ],
            };

            let execution = graph.execute(&runner).await.unwrap();
            assert!(execution.success);
            assert_eq!(execution.run_id, "graph-run");
            let traces = mesh
                .trace_recorder
                .replay_run("graph", "graph-run")
                .await
                .unwrap();
            assert_eq!(traces.len(), 2);
            assert_eq!(traces[0].step_id, "first");
            assert_eq!(traces[1].step_id, "second");
            assert!(traces
                .iter()
                .all(|trace| trace.run_id.as_deref() == Some("graph-run")));
        });
    }

    #[test]
    fn replay_rejects_non_tool_event_and_tampered_structured_output_digest() {
        let root = temp_workspace();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            let mesh = McpRuntimeMesh::for_workspace(&root).unwrap();
            let arguments = json!({"path": "."});

            let mut wrong_event = crate::harness::tracing::TraceRecord::tool_result(
                "integrity",
                "wrong-event",
                "filesystem.list",
                "",
                "",
                "passed",
                1,
                true,
            );
            wrong_event.run_id = Some("run-integrity".to_string());
            wrong_event.event_name = "task_completed".to_string();
            wrong_event.input_digest = digest_tool_input("filesystem.list", &arguments);
            wrong_event.structured_output = json!({"path": ".", "entries": []});
            wrong_event.events = vec!["tool_called".to_string(), "tool_result".to_string()];
            wrong_event.metadata = json!({
                "traceKind": "mcp_tool_result",
                "inputDigestFormat": "mcp_tool_v1",
                "outputDigestFormat": "structured_tool_result_v1"
            });
            let (_, wrong_event_sequence) = mesh
                .trace_recorder
                .record_with_sequence(&wrong_event)
                .await
                .unwrap();
            let event_error = mesh
                .call_tool(replay_call(
                    "replay",
                    "integrity",
                    "filesystem.list",
                    arguments.clone(),
                    "integrity",
                    "wrong-event",
                    Some("run-integrity"),
                    Some(wrong_event_sequence),
                ))
                .await
                .unwrap_err();
            assert!(event_error.contains("event identity mismatch"));

            let mut tampered = wrong_event;
            tampered.step_id = "tampered".to_string();
            tampered.event_name = "tool_called".to_string();
            tampered.output_digest = "sha256:not-the-content".to_string();
            let (_, tampered_sequence) = mesh
                .trace_recorder
                .record_with_sequence(&tampered)
                .await
                .unwrap();
            let digest_error = mesh
                .call_tool(replay_call(
                    "replay",
                    "integrity",
                    "filesystem.list",
                    arguments,
                    "integrity",
                    "tampered",
                    Some("run-integrity"),
                    Some(tampered_sequence),
                ))
                .await
                .unwrap_err();
            assert!(digest_error.contains("output digest mismatch"));

            let mut missing_kind = tampered;
            missing_kind.step_id = "missing-kind".to_string();
            missing_kind.output_digest = String::new();
            missing_kind.metadata = json!({
                "inputDigestFormat": "mcp_tool_v1",
                "outputDigestFormat": "structured_tool_result_v1"
            });
            let (_, missing_kind_sequence) = mesh
                .trace_recorder
                .record_with_sequence(&missing_kind)
                .await
                .unwrap();
            let kind_error = mesh
                .call_tool(replay_call(
                    "replay",
                    "integrity",
                    "filesystem.list",
                    json!({"path": "."}),
                    "integrity",
                    "missing-kind",
                    Some("run-integrity"),
                    Some(missing_kind_sequence),
                ))
                .await
                .unwrap_err();
            assert!(kind_error.contains("trace kind mismatch"));
        });
    }
}
