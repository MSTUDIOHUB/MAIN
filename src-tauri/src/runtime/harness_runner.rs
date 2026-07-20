use crate::harness::tracing::{new_trace_run_id, TraceRecord, TraceRecorder};
use crate::runtime::context::{ContextManager, RuntimeContext};
use crate::runtime::event_bus::{EventBus, RuntimeEvent, RuntimeEventName};
use crate::runtime::r#loop::{
    ActionResult, Observation, RuntimeExecutor, RuntimeFuture, RuntimeLoop, RuntimeObserver,
    RuntimePlanner, RuntimeRunResult, RuntimeStep, RuntimeVerifier, Verification,
};
use crate::runtime::retry::RetryPolicy;
use crate::runtime::verifier::{VerificationResult, Verifier};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet, VecDeque};
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};
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
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| format!("runtime-{}", new_trace_run_id()));
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
    // Consume while the loop runs. Waiting until completion can overflow the
    // bounded broadcast channel and silently lose the beginning of a large
    // deterministic conformance run.
    let event_collector = tokio::spawn(async move {
        let mut events = Vec::new();
        loop {
            match event_receiver.recv().await {
                Ok(event) => {
                    let terminal = event.name == RuntimeEventName::TaskCompleted;
                    events.push(event);
                    if terminal {
                        return Ok::<Vec<RuntimeEvent>, String>(events);
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(skipped)) => {
                    return Err(format!(
                        "runtime harness event capture lagged by {skipped} events"
                    ));
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                    return Err(
                        "runtime harness event stream closed before task_completed".to_string()
                    );
                }
            }
        }
    });
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

    let run_result = loop_runner
        .run(
            task_id.clone(),
            &mut planner,
            &mut executor,
            &mut observer,
            &mut runtime_verifier,
        )
        .await;
    let run = match run_result {
        Ok(run) => run,
        Err(error) => {
            event_collector.abort();
            return Err(error);
        }
    };
    let context = context_manager.build().await;
    let traces = trace_recorder.replay_run(&task_id, &run.run_id).await?;
    let events = event_collector
        .await
        .map_err(|error| format!("runtime harness event collector failed: {error}"))??;

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
        let mut seen_step_ids = HashSet::new();
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
            if !seen_step_ids.insert(step_id.to_string()) {
                return Err(format!("runtime harness step_id must be unique: {step_id}"));
            }
            let terminal = input.terminal.unwrap_or(index == last_index);
            if terminal && index != last_index {
                return Err(format!(
                    "runtime harness terminal step {step_id} cannot precede later steps"
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
                terminal,
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
                exit_code: result.exit_code,
                timed_out: result.timed_out,
                stdout_truncated: false,
                stderr_truncated: false,
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
                exit_code: action.exit_code,
                timed_out: action.timed_out,
                stdout_truncated: action.stdout_truncated,
                stderr_truncated: action.stderr_truncated,
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

#[cfg(test)]
mod tests {
    use super::{
        run_workspace_harness, CommandPlanner, RuntimeHarnessRequest, RuntimeHarnessStepInput,
    };
    use crate::harness::tracing::{
        compare_golden_traces, GoldenTrace, GoldenTraceRecord, TraceRecorder, TraceResultKind,
        GOLDEN_TRACE_SCHEMA_VERSION,
    };
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

            assert_eq!(report.run.result_kind, TraceResultKind::Success);
            assert_eq!(report.run.steps_executed, 1);
            assert_eq!(report.traces.len(), 2);
            assert!(report
                .traces
                .iter()
                .all(|trace| trace.run_id.as_deref() == Some(report.run.run_id.as_str())));
            assert_eq!(report.traces[1].event_name, "task_completed");
            assert_eq!(report.context.active_files, vec!["src/lib.rs"]);
            assert!(report
                .events
                .iter()
                .any(|event| event.event == "task_completed"));

            // This baseline is independent of the actual trace. The fixed
            // request is executed through the current RuntimeLoop, then its
            // run-scoped projection is compared to stable semantic evidence.
            let actual = TraceRecorder::for_workspace(&root)
                .golden_run("task", &report.run.run_id)
                .await
                .unwrap();
            let expected = GoldenTrace {
                schema_version: GOLDEN_TRACE_SCHEMA_VERSION,
                task_id: "task".to_string(),
                records: vec![
                    GoldenTraceRecord {
                        sequence: 1,
                        attempt: 1,
                        step_id: "step-1".to_string(),
                        event_name: "tool_called".to_string(),
                        tool_call: "printf ok".to_string(),
                        input_digest:
                            "sha256:ef867f3649ebd4e8f51c08adc29afc0a085e94009c8df5ea259a66f471c44620"
                                .to_string(),
                        output_digest:
                            "sha256:4de27676f0826a5b3483fb9895e5f6028b4be08a007ed821d9883134d27a3628"
                                .to_string(),
                        success: true,
                        result_kind: TraceResultKind::Success,
                        exit_code: Some(0),
                        timed_out: false,
                        stdout_truncated: false,
                        stderr_truncated: false,
                        verification: "verification: command=`printf verify` success=true exitCode=0 timedOut=false"
                            .to_string(),
                        events: vec![
                            "tool_called".to_string(),
                            "verification_completed".to_string(),
                        ],
                    },
                    GoldenTraceRecord {
                        sequence: 2,
                        attempt: 1,
                        step_id: "__run_conclusion__".to_string(),
                        event_name: "task_completed".to_string(),
                        tool_call: String::new(),
                        input_digest:
                            "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
                                .to_string(),
                        output_digest:
                            "sha256:41c8f2918097239e9935f5a75c2bef94312041cb888747bb556abc66c8067047"
                                .to_string(),
                        success: true,
                        result_kind: TraceResultKind::Success,
                        exit_code: None,
                        timed_out: false,
                        stdout_truncated: false,
                        stderr_truncated: false,
                        verification: "terminal_step_verified".to_string(),
                        events: vec!["task_completed".to_string()],
                    },
                ],
            };
            let comparison = compare_golden_traces(&expected, &actual);
            assert!(comparison.matches, "{:?}", comparison.differences);
        });
    }

    #[test]
    fn command_planner_rejects_duplicate_step_ids_and_early_terminal_steps() {
        let duplicate = CommandPlanner::from_request(
            "task".to_string(),
            vec![
                RuntimeHarnessStepInput {
                    step_id: "same".to_string(),
                    tool_call: "printf ok".to_string(),
                    verification_command: None,
                    terminal: Some(false),
                },
                RuntimeHarnessStepInput {
                    step_id: "same".to_string(),
                    tool_call: "printf ok".to_string(),
                    verification_command: None,
                    terminal: Some(true),
                },
            ],
        )
        .err()
        .expect("duplicate step identity must fail closed");
        assert!(duplicate.contains("unique"));

        let early_terminal = CommandPlanner::from_request(
            "task".to_string(),
            vec![
                RuntimeHarnessStepInput {
                    step_id: "first".to_string(),
                    tool_call: "printf ok".to_string(),
                    verification_command: None,
                    terminal: Some(true),
                },
                RuntimeHarnessStepInput {
                    step_id: "second".to_string(),
                    tool_call: "printf ok".to_string(),
                    verification_command: None,
                    terminal: Some(true),
                },
            ],
        )
        .err()
        .expect("terminal step must not skip later fixed steps");
        assert!(early_terminal.contains("cannot precede"));
    }

    #[test]
    fn repeated_logical_task_runs_are_isolated_by_unique_run_id() {
        let root = temp_workspace();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            let request = || RuntimeHarnessRequest {
                task_id: Some("repeatable-task".to_string()),
                steps: vec![RuntimeHarnessStepInput {
                    step_id: "step".to_string(),
                    tool_call: "printf ok".to_string(),
                    verification_command: None,
                    terminal: Some(true),
                }],
                active_files: Vec::new(),
                working_memory: Vec::new(),
                summaries: Vec::new(),
                max_attempts: Some(0),
                retry_backoff_ms: Some(0),
                timeout_ms: Some(5_000),
            };
            let first = run_workspace_harness(&root, request()).await.unwrap();
            let second = run_workspace_harness(&root, request()).await.unwrap();
            assert_ne!(first.run.run_id, second.run.run_id);
            assert_eq!(first.traces.len(), 2);
            assert_eq!(second.traces.len(), 2);
            assert!(first
                .traces
                .iter()
                .all(|trace| trace.run_id.as_deref() == Some(first.run.run_id.as_str())));
            assert!(second
                .traces
                .iter()
                .all(|trace| trace.run_id.as_deref() == Some(second.run.run_id.as_str())));
        });
    }
}
