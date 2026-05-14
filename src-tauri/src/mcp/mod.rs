pub mod browser;
pub mod filesystem;
pub mod git;
pub mod terminal;
pub mod unity;

use crate::harness::permissions::PermissionGuard;
use crate::harness::tracing::{TraceRecord, TraceRecorder};
use crate::task_graph::{TaskGraphFuture, TaskGraphRunner, TaskGraphStepResult, TaskNode};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::{Component, Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};
use tokio::process::Command;
use tokio::time::timeout;

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
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpToolCall {
    pub id: String,
    pub task_id: String,
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
    pub content: Value,
    pub stdout: String,
    pub stderr: String,
    pub latency_ms: u128,
    pub trace_path: Option<String>,
    pub replayed: bool,
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
            let trace = self
                .trace_recorder
                .load(&replay.task_id, &replay.step_id)
                .await?;
            return Ok(McpToolResult {
                id: call.id,
                task_id: replay.task_id.clone(),
                tool: call.tool,
                success: trace.stderr.trim().is_empty(),
                content: json!({
                    "replayed": true,
                    "verification": trace.verification,
                }),
                stdout: trace.stdout,
                stderr: trace.stderr,
                latency_ms: trace.latency_ms,
                trace_path: None,
                replayed: true,
            });
        }

        let mut result = match call.tool.split('.').next().unwrap_or_default() {
            "unity" => unity::call(&self.workspace, &self.permission_guard, &call).await?,
            "browser" => browser::call(&self.workspace, &self.permission_guard, &call).await?,
            "git" => git::call(&self.workspace, &self.permission_guard, &call).await?,
            "filesystem" => {
                filesystem::call(&self.workspace, &self.permission_guard, &call).await?
            }
            "terminal" => terminal::call(&self.workspace, &self.permission_guard, &call).await?,
            _ => return Err(format!("unknown MCP tool: {}", call.tool)),
        };

        let trace_path = self
            .trace_recorder
            .record(&TraceRecord {
                task_id: result.task_id.clone(),
                step_id: result.id.clone(),
                event_name: "tool_called".to_string(),
                tool_call: result.tool.clone(),
                stdout: result.stdout.clone(),
                stderr: result.stderr.clone(),
                verification: if result.success { "success" } else { "failed" }.to_string(),
                latency_ms: result.latency_ms,
                metadata: json!({
                    "mcpTool": result.tool,
                    "success": result.success,
                    "traceAware": true,
                    "replayAware": true,
                }),
            })
            .await?;
        result.trace_path = Some(trace_path.to_string_lossy().to_string());
        Ok(result)
    }
}

pub struct McpTaskGraphRunner<'a> {
    mesh: &'a McpRuntimeMesh,
    graph_task_id: String,
}

impl<'a> McpTaskGraphRunner<'a> {
    pub fn new(mesh: &'a McpRuntimeMesh, graph_task_id: impl Into<String>) -> Self {
        Self {
            mesh,
            graph_task_id: graph_task_id.into(),
        }
    }
}

impl TaskGraphRunner for McpTaskGraphRunner<'_> {
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
        content,
        stdout: stdout.into(),
        stderr: stderr.into(),
        latency_ms,
        trace_path: None,
        replayed: false,
    }
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

pub(crate) fn workspace_path(workspace: &Path, raw_path: &str) -> Result<PathBuf, String> {
    let candidate = if raw_path.trim().is_empty() {
        workspace.to_path_buf()
    } else {
        let path = Path::new(raw_path);
        if path.is_absolute() {
            path.to_path_buf()
        } else {
            workspace.join(path)
        }
    };
    ensure_no_parent_escape(&candidate)?;
    let normalized_workspace = workspace
        .canonicalize()
        .map_err(|error| format!("解析 workspace 失败 {}: {error}", workspace.display()))?;
    let normalized = if candidate.exists() {
        candidate
            .canonicalize()
            .map_err(|error| format!("解析路径失败 {}: {error}", candidate.display()))?
    } else {
        let (existing_parent, missing_tail) = nearest_existing_parent(&candidate, workspace)?;
        let parent = existing_parent
            .canonicalize()
            .map_err(|error| format!("解析父路径失败 {}: {error}", existing_parent.display()))?;
        missing_tail
            .into_iter()
            .rev()
            .fold(parent, |path, component| path.join(component))
    };
    if !normalized.starts_with(&normalized_workspace) {
        return Err(format!(
            "MCP path escapes workspace: {}",
            candidate.display()
        ));
    }
    Ok(normalized)
}

fn nearest_existing_parent(
    candidate: &Path,
    workspace: &Path,
) -> Result<(PathBuf, Vec<PathBuf>), String> {
    let mut current = candidate.to_path_buf();
    let mut missing_tail = Vec::new();
    while !current.exists() {
        let Some(name) = current.file_name() else {
            return Err(format!(
                "MCP path has no existing parent: {}",
                candidate.display()
            ));
        };
        missing_tail.push(PathBuf::from(name));
        let Some(parent) = current.parent() else {
            return Err(format!("MCP path has no parent: {}", candidate.display()));
        };
        current = parent.to_path_buf();
        if current.as_os_str().is_empty() {
            return Err(format!(
                "MCP path has no existing parent: {}",
                candidate.display()
            ));
        }
    }
    if !current.starts_with(workspace) {
        return Err(format!(
            "MCP path escapes workspace: {}",
            candidate.display()
        ));
    }
    Ok((current, missing_tail))
}

fn ensure_no_parent_escape(path: &Path) -> Result<(), String> {
    let mut depth = 0_i32;
    for component in path.components() {
        match component {
            Component::ParentDir => {
                depth -= 1;
                if depth < 0 {
                    return Err(format!(
                        "MCP path contains parent escape: {}",
                        path.display()
                    ));
                }
            }
            Component::Normal(_) => depth += 1,
            _ => {}
        }
    }
    Ok(())
}

pub(crate) async fn run_permissioned_shell(
    workspace: &Path,
    permission_guard: &PermissionGuard,
    command: &str,
    timeout_ms: u64,
) -> Result<(bool, String, String, u128), String> {
    permission_guard
        .validate(command)
        .map_err(|error| error.to_string())?;
    let started_at = Instant::now();
    let mut process = if cfg!(target_os = "windows") {
        let mut command_process = Command::new("cmd");
        command_process.args(["/C", command]);
        command_process
    } else {
        let mut command_process = Command::new("/bin/sh");
        command_process.args(["-lc", command]);
        command_process
    };
    process
        .current_dir(workspace)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    let output = match timeout(Duration::from_millis(timeout_ms), process.output()).await {
        Ok(output) => output.map_err(|error| format!("MCP shell command failed: {error}"))?,
        Err(_) => {
            return Ok((
                false,
                String::new(),
                format!("MCP shell command timed out after {timeout_ms}ms"),
                started_at.elapsed().as_millis(),
            ))
        }
    };
    Ok((
        output.status.success(),
        String::from_utf8_lossy(&output.stdout).to_string(),
        String::from_utf8_lossy(&output.stderr).to_string(),
        started_at.elapsed().as_millis(),
    ))
}

#[cfg(test)]
mod tests {
    use super::{McpRuntimeMesh, McpToolCall};
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

    #[test]
    fn mesh_traces_and_replays_filesystem_tool() {
        let root = temp_workspace();
        fs::write(root.join("README.md"), "# Test").unwrap();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            let mesh = McpRuntimeMesh::for_workspace(&root).unwrap();
            let call = McpToolCall {
                id: "step-1".to_string(),
                task_id: "task".to_string(),
                tool: "filesystem.read".to_string(),
                arguments: json!({"path": "README.md"}),
                replay: None,
            };
            let result = mesh.call_tool(call).await.unwrap();
            assert!(result.success);
            assert!(result.trace_path.is_some());

            let replayed = mesh
                .call_tool(McpToolCall {
                    id: "replay".to_string(),
                    task_id: "task".to_string(),
                    tool: "filesystem.read".to_string(),
                    arguments: json!({}),
                    replay: Some(super::McpReplayRef {
                        task_id: "task".to_string(),
                        step_id: "step-1".to_string(),
                    }),
                })
                .await
                .unwrap();
            assert!(replayed.replayed);
            assert_eq!(replayed.stdout, "# Test");

            let write_result = mesh
                .call_tool(McpToolCall {
                    id: "step-2".to_string(),
                    task_id: "task".to_string(),
                    tool: "filesystem.write".to_string(),
                    arguments: json!({"path": "generated/nested.txt", "content": "ok"}),
                    replay: None,
                })
                .await
                .unwrap();
            assert!(write_result.success);
            assert_eq!(
                fs::read_to_string(root.join("generated/nested.txt")).unwrap(),
                "ok"
            );
        });
    }
}
