use crate::harness::tracing::{TraceRecord, TraceRecorder};
use crate::runtime::context::{ContextManager, RuntimeContext};
use crate::runtime::event_bus::{EventBus, RuntimeEvent};
use crate::runtime::r#loop::{
    ActionResult, Observation, RuntimeExecutor, RuntimeFuture, RuntimeLoop, RuntimeObserver,
    RuntimePlanner, RuntimeRunResult, RuntimeStep, RuntimeVerifier, Verification,
};
use crate::runtime::retry::RetryPolicy;
use crate::runtime::verifier::{VerificationResult, Verifier};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::sync::Mutex;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeHarnessStepInput {
    pub step_id: String,
    pub tool_call: String,
    #[serde(default)]
    pub verification_command: Option<String>,
    #[serde(default)]
    pub terminal: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeHarnessRequest {
    #[serde(default)]
    pub task_id: Option<String>,
    pub steps: Vec<RuntimeHarnessStepInput>,
    #[serde(default)]
    pub active_files: Vec<String>,
    #[serde(default)]
    pub working_memory: Vec<String>,
    #[serde(default)]
    pub summaries: Vec<String>,
    #[serde(default)]
    pub max_attempts: Option<usize>,
    #[serde(default)]
    pub retry_backoff_ms: Option<u64>,
    #[serde(default)]
    pub timeout_ms: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeHarnessReport {
    pub run: RuntimeRunResult,
    pub context: RuntimeContext,
    pub traces: Vec<TraceRecord>,
    pub events: Vec<RuntimeEvent>,
}

type StepResults = Arc<Mutex<HashMap<String, VerificationResult>>>;

pub async fn run_workspace_harness(
    workspace: &Path,
    request: RuntimeHarnessRequest,
) -> Result<RuntimeHarnessReport, String> {
    let task_id = request
        .task_id
        .clone()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| format!("runtime-{}", now_millis()));
    let timeout = Duration::from_millis(request.timeout_ms.unwrap_or(60_000).clamp(100, 600_000));
    let context_manager = ContextManager::new();
    for file in &request.active_files {
        context_manager.add_active_file(file.clone()).await;
    }
    for memory in &request.working_memory {
        context_manager.remember(memory.clone()).await;
    }
    for summary in &request.summaries {
        context_manager.summarize(summary.clone()).await;
    }

    let (mut planner, verification_commands) =
        CommandPlanner::from_request(task_id.clone(), request.steps)?;
    let verifier = Verifier::for_workspace(workspace)?;
    let step_results: StepResults = Arc::new(Mutex::new(HashMap::new()));
    let mut executor = CommandExecutor {
        verifier: verifier.clone(),
        timeout,
        step_results: Arc::clone(&step_results),
    };
    let mut observer = CommandObserver;
    let mut runtime_verifier = CommandVerifier {
        verifier,
        timeout,
        verification_commands,
        step_results,
    };
    let event_bus = EventBus::default();
    let mut event_receiver = event_bus.subscribe();
    let trace_recorder = TraceRecorder::for_workspace(workspace);
    let retry_policy = RetryPolicy::new(
        request.max_attempts.unwrap_or(1),
        request.retry_backoff_ms.unwrap_or(0),
    );
    let loop_runner = RuntimeLoop::new(
        context_manager.clone(),
        event_bus,
        trace_recorder.clone(),
        retry_policy,
    );

    let run = loop_runner
        .run(
            task_id.clone(),
            &mut planner,
            &mut executor,
            &mut observer,
            &mut runtime_verifier,
        )
        .await?;
    let context = context_manager.build().await;
    let traces = trace_recorder.replay(&task_id).await?;
    let mut events = Vec::new();
    while let Ok(event) = event_receiver.try_recv() {
        events.push(event);
    }

    Ok(RuntimeHarnessReport {
        run,
        context,
        traces,
        events,
    })
}

struct CommandPlanner {
    steps: VecDeque<RuntimeStep>,
}

impl CommandPlanner {
    fn from_request(
        task_id: String,
        steps: Vec<RuntimeHarnessStepInput>,
    ) -> Result<(Self, HashMap<String, String>), String> {
        if steps.is_empty() {
            return Err("runtime harness requires at least one step".to_string());
        }

        let last_index = steps.len().saturating_sub(1);
        let mut runtime_steps = VecDeque::new();
        let mut verification_commands = HashMap::new();
        for (index, input) in steps.into_iter().enumerate() {
            let step_id = input.step_id.trim();
            let tool_call = input.tool_call.trim();
            if step_id.is_empty() {
                return Err("runtime harness step_id cannot be empty".to_string());
            }
            if tool_call.is_empty() {
                return Err(format!(
                    "runtime harness step {step_id} has empty tool_call"
                ));
            }
            if let Some(command) = input
                .verification_command
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                verification_commands.insert(step_id.to_string(), command.to_string());
            }
            runtime_steps.push_back(RuntimeStep {
                task_id: task_id.clone(),
                step_id: step_id.to_string(),
                tool_call: tool_call.to_string(),
                terminal: input.terminal.unwrap_or(index == last_index),
            });
        }

        Ok((
            Self {
                steps: runtime_steps,
            },
            verification_commands,
        ))
    }
}

impl RuntimePlanner for CommandPlanner {
    fn next_step<'a>(
        &'a mut self,
        _context: RuntimeContext,
    ) -> RuntimeFuture<'a, Option<RuntimeStep>> {
        Box::pin(async move { self.steps.pop_front() })
    }
}

struct CommandExecutor {
    verifier: Verifier,
    timeout: Duration,
    step_results: StepResults,
}

impl RuntimeExecutor for CommandExecutor {
    fn execute<'a>(&'a mut self, step: &'a RuntimeStep) -> RuntimeFuture<'a, ActionResult> {
        Box::pin(async move {
            let started_at = Instant::now();
            let result = match self
                .verifier
                .verify_command(&step.tool_call, self.timeout)
                .await
            {
                Ok(result) => result,
                Err(error) => VerificationResult {
                    command: step.tool_call.clone(),
                    success: false,
                    exit_code: None,
                    stdout: String::new(),
                    stderr: error,
                    timed_out: false,
                    duration_ms: started_at.elapsed().as_millis(),
                },
            };
            self.step_results
                .lock()
                .await
                .insert(step.step_id.clone(), result.clone());
            ActionResult {
                stdout: result.stdout,
                stderr: result.stderr,
                latency_ms: result.duration_ms,
            }
        })
    }
}

struct CommandObserver;

impl RuntimeObserver for CommandObserver {
    fn observe<'a>(
        &'a mut self,
        step: &'a RuntimeStep,
        action: ActionResult,
    ) -> RuntimeFuture<'a, Observation> {
        Box::pin(async move {
            Observation {
                task_id: step.task_id.clone(),
                step_id: step.step_id.clone(),
                tool_call: step.tool_call.clone(),
                stdout: action.stdout,
                stderr: action.stderr,
                latency_ms: action.latency_ms,
            }
        })
    }
}

struct CommandVerifier {
    verifier: Verifier,
    timeout: Duration,
    verification_commands: HashMap<String, String>,
    step_results: StepResults,
}

impl RuntimeVerifier for CommandVerifier {
    fn verify<'a>(&'a mut self, observation: &'a Observation) -> RuntimeFuture<'a, Verification> {
        Box::pin(async move {
            let action_result = self
                .step_results
                .lock()
                .await
                .get(&observation.step_id)
                .cloned();
            let Some(action_result) = action_result else {
                return Verification {
                    success: false,
                    summary: format!("missing execution result for {}", observation.step_id),
                };
            };
            if !action_result.success {
                return Verification {
                    success: false,
                    summary: command_summary("action failed", &action_result),
                };
            }

            let Some(command) = self.verification_commands.get(&observation.step_id) else {
                return Verification {
                    success: true,
                    summary: command_summary("action succeeded", &action_result),
                };
            };
            match self.verifier.verify_command(command, self.timeout).await {
                Ok(result) => Verification {
                    success: result.success,
                    summary: command_summary("verification", &result),
                },
                Err(error) => Verification {
                    success: false,
                    summary: format!("verification command rejected: {error}"),
                },
            }
        })
    }
}

fn command_summary(label: &str, result: &VerificationResult) -> String {
    let exit_code = result
        .exit_code
        .map(|code| code.to_string())
        .unwrap_or_else(|| "none".to_string());
    format!(
        "{label}: command=`{}` success={} exitCode={} timedOut={}",
        result.command, result.success, exit_code, result.timed_out
    )
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_else(|_| Duration::from_secs(0))
        .as_millis() as u64
}

#[cfg(test)]
mod tests {
    use super::{run_workspace_harness, RuntimeHarnessRequest, RuntimeHarnessStepInput};
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_workspace() -> std::path::PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("main-runtime-harness-{unique}"));
        fs::create_dir_all(root.join(".MAIN")).unwrap();
        fs::write(
            root.join(".MAIN").join("permissions.yaml"),
            "shell:\n  allow:\n    - printf ok\n    - printf verify\n  deny:\n    - sudo\n",
        )
        .unwrap();
        root
    }

    #[test]
    fn workspace_harness_runs_traces_and_replays_steps() {
        let root = temp_workspace();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            let report = run_workspace_harness(
                &root,
                RuntimeHarnessRequest {
                    task_id: Some("task".to_string()),
                    steps: vec![RuntimeHarnessStepInput {
                        step_id: "step-1".to_string(),
                        tool_call: "printf ok".to_string(),
                        verification_command: Some("printf verify".to_string()),
                        terminal: Some(true),
                    }],
                    active_files: vec!["src/lib.rs".to_string()],
                    working_memory: vec!["memory".to_string()],
                    summaries: vec!["summary".to_string()],
                    max_attempts: Some(0),
                    retry_backoff_ms: Some(0),
                    timeout_ms: Some(5_000),
                },
            )
            .await
            .unwrap();

            assert!(report.run.completed);
            assert_eq!(report.run.steps_executed, 1);
            assert_eq!(report.traces.len(), 1);
            assert_eq!(report.context.active_files, vec!["src/lib.rs"]);
            assert!(report
                .events
                .iter()
                .any(|event| event.event == "task_completed"));
        });
    }
}
