use crate::harness::tracing::{new_trace_run_id, TraceRecord, TraceRecorder, TraceResultKind};
use crate::runtime::context::{ContextManager, RuntimeContext, RuntimeStepSummary};
use crate::runtime::event_bus::{EventBus, RuntimeEventName};
use crate::runtime::retry::{RetryDecision, RetryPolicy, RetryState};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::future::Future;
use std::pin::Pin;

pub type RuntimeFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeStep {
    pub task_id: String,
    pub step_id: String,
    pub tool_call: String,
    pub terminal: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionResult {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<i32>,
    pub timed_out: bool,
    pub stdout_truncated: bool,
    pub stderr_truncated: bool,
    pub latency_ms: u128,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Observation {
    pub task_id: String,
    pub step_id: String,
    pub tool_call: String,
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<i32>,
    pub timed_out: bool,
    pub stdout_truncated: bool,
    pub stderr_truncated: bool,
    pub latency_ms: u128,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Verification {
    pub success: bool,
    pub summary: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeRunResult {
    pub task_id: String,
    pub run_id: String,
    pub result_kind: TraceResultKind,
    pub summary: String,
    pub steps_executed: usize,
}

pub trait RuntimePlanner {
    fn next_step<'a>(
        &'a mut self,
        context: RuntimeContext,
    ) -> RuntimeFuture<'a, Option<RuntimeStep>>;
}

pub trait RuntimeExecutor {
    fn execute<'a>(&'a mut self, step: &'a RuntimeStep) -> RuntimeFuture<'a, ActionResult>;
}

pub trait RuntimeObserver {
    fn observe<'a>(
        &'a mut self,
        step: &'a RuntimeStep,
        action: ActionResult,
    ) -> RuntimeFuture<'a, Observation>;
}

pub trait RuntimeVerifier {
    fn verify<'a>(&'a mut self, observation: &'a Observation) -> RuntimeFuture<'a, Verification>;
}

#[derive(Debug, Clone)]
pub struct RuntimeLoop {
    pub context_manager: ContextManager,
    pub event_bus: EventBus,
    pub trace_recorder: TraceRecorder,
    pub retry_policy: RetryPolicy,
}

impl RuntimeLoop {
    pub fn new(
        context_manager: ContextManager,
        event_bus: EventBus,
        trace_recorder: TraceRecorder,
        retry_policy: RetryPolicy,
    ) -> Self {
        Self {
            context_manager,
            event_bus,
            trace_recorder,
            retry_policy,
        }
    }

    pub async fn run<P, E, O, V>(
        &self,
        task_id: impl Into<String>,
        planner: &mut P,
        executor: &mut E,
        observer: &mut O,
        verifier: &mut V,
    ) -> Result<RuntimeRunResult, String>
    where
        P: RuntimePlanner + Send,
        E: RuntimeExecutor + Send,
        O: RuntimeObserver + Send,
        V: RuntimeVerifier + Send,
    {
        self.run_with_id(
            task_id,
            new_trace_run_id(),
            planner,
            executor,
            observer,
            verifier,
        )
        .await
    }

    pub async fn run_with_id<P, E, O, V>(
        &self,
        task_id: impl Into<String>,
        run_id: impl Into<String>,
        planner: &mut P,
        executor: &mut E,
        observer: &mut O,
        verifier: &mut V,
    ) -> Result<RuntimeRunResult, String>
    where
        P: RuntimePlanner + Send,
        E: RuntimeExecutor + Send,
        O: RuntimeObserver + Send,
        V: RuntimeVerifier + Send,
    {
        let task_id = task_id.into();
        let run_id = run_id.into();
        let _ = self.event_bus.emit(
            RuntimeEventName::TaskStarted,
            task_id.clone(),
            None,
            json!({"runId": &run_id}),
        );

        let mut retry_state = RetryState::new();
        let mut pending_retry_step: Option<RuntimeStep> = None;
        let mut steps_executed = 0;

        loop {
            let context = self.context_manager.build().await;
            let next_step = match pending_retry_step.take() {
                Some(step) => Some(step),
                None => planner.next_step(context).await,
            };
            let Some(step) = next_step else {
                let (result_kind, reason) = if retry_state.attempts > 0 {
                    (
                        TraceResultKind::Error,
                        "planner_exhausted_with_unresolved_verification",
                    )
                } else if steps_executed == 0 {
                    (TraceResultKind::Blocked, "planner_exhausted_without_steps")
                } else {
                    (
                        TraceResultKind::Partial,
                        "planner_exhausted_without_terminal_verification",
                    )
                };
                return self
                    .complete_run(
                        &task_id,
                        &run_id,
                        result_kind,
                        reason,
                        reason,
                        steps_executed,
                        None,
                    )
                    .await;
            };

            if step.task_id != task_id {
                let summary = format!(
                    "planner step task identity mismatch: expected={} actual={} step={}",
                    task_id, step.task_id, step.step_id
                );
                return self
                    .complete_run(
                        &task_id,
                        &run_id,
                        TraceResultKind::Error,
                        "planner_step_task_identity_mismatch",
                        summary,
                        steps_executed,
                        Some(&step.step_id),
                    )
                    .await;
            }

            let _ = self.event_bus.emit(
                RuntimeEventName::ToolCalled,
                task_id.clone(),
                Some(step.step_id.clone()),
                json!({"runId": &run_id, "toolCall": step.tool_call}),
            );

            let action = executor.execute(&step).await;
            let observation = observer.observe(&step, action).await;
            let verification = verifier.verify(&observation).await;
            steps_executed += 1;

            let mut trace = TraceRecord::tool_result(
                step.task_id.clone(),
                step.step_id.clone(),
                step.tool_call.clone(),
                observation.stdout.clone(),
                observation.stderr.clone(),
                verification.summary.clone(),
                observation.latency_ms,
                verification.success,
            );
            trace.run_id = Some(run_id.clone());
            trace.attempt = retry_state.attempts.saturating_add(1) as u32;
            trace.event_name = RuntimeEventName::ToolCalled.as_str().to_string();
            trace.result_kind = if verification.success {
                TraceResultKind::Success
            } else {
                TraceResultKind::Error
            };
            trace.exit_code = observation.exit_code;
            trace.timed_out = observation.timed_out;
            trace.stdout_truncated = observation.stdout_truncated;
            trace.stderr_truncated = observation.stderr_truncated;
            trace.events = vec![
                RuntimeEventName::ToolCalled.as_str().to_string(),
                if verification.success {
                    "verification_completed".to_string()
                } else {
                    RuntimeEventName::VerificationFailed.as_str().to_string()
                },
            ];
            trace.metadata = json!({
                "verificationSuccess": verification.success,
            });
            self.trace_recorder.record(&trace).await?;

            self.context_manager
                .record_step(RuntimeStepSummary {
                    step_id: step.step_id.clone(),
                    tool_call: step.tool_call.clone(),
                    verification: verification.summary.clone(),
                    success: verification.success,
                })
                .await;

            if verification.success {
                retry_state = RetryState::new();
                if step.terminal {
                    return self
                        .complete_run(
                            &task_id,
                            &run_id,
                            TraceResultKind::Success,
                            "terminal_step_verified",
                            "terminal_step_verified",
                            steps_executed,
                            Some(&step.step_id),
                        )
                        .await;
                }
                continue;
            }

            self.context_manager
                .record_mistake(format!("{}: {}", step.step_id, verification.summary))
                .await;
            let _ = self.event_bus.emit(
                RuntimeEventName::VerificationFailed,
                task_id.clone(),
                Some(step.step_id.clone()),
                json!({"runId": &run_id, "verification": verification.summary}),
            );

            match self.retry_policy.handle(&mut retry_state).await {
                RetryDecision::Retry { attempt } => {
                    // A retry belongs to the exact failed step. Asking the
                    // planner for another step here can skip the failure and
                    // later publish a false success from unrelated evidence.
                    pending_retry_step = Some(step.clone());
                    let _ = self.event_bus.emit(
                        RuntimeEventName::RetryStarted,
                        task_id.clone(),
                        Some(step.step_id.clone()),
                        json!({"runId": &run_id, "attempt": attempt}),
                    );
                }
                RetryDecision::Stop => {
                    let summary = format!(
                        "verification retry budget exhausted at step {}: {}",
                        step.step_id, verification.summary
                    );
                    return self
                        .complete_run(
                            &task_id,
                            &run_id,
                            TraceResultKind::Error,
                            "verification_retry_exhausted",
                            summary,
                            steps_executed,
                            Some(&step.step_id),
                        )
                        .await;
                }
            }
        }
    }

    async fn complete_run(
        &self,
        task_id: &str,
        run_id: &str,
        result_kind: TraceResultKind,
        reason: &str,
        summary: impl Into<String>,
        steps_executed: usize,
        owner_step_id: Option<&str>,
    ) -> Result<RuntimeRunResult, String> {
        let summary = summary.into();
        let conclusion = TraceRecord::conclusion(
            task_id,
            run_id,
            result_kind,
            reason,
            summary.clone(),
            owner_step_id,
        );
        self.trace_recorder.record(&conclusion).await?;
        let _ = self.event_bus.emit(
            RuntimeEventName::TaskCompleted,
            task_id.to_string(),
            owner_step_id.map(str::to_string),
            json!({
                "runId": run_id,
                "resultKind": result_kind,
                "reason": reason,
                "summary": summary,
            }),
        );
        Ok(RuntimeRunResult {
            task_id: task_id.to_string(),
            run_id: run_id.to_string(),
            result_kind,
            summary,
            steps_executed,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::{
        ActionResult, Observation, RuntimeExecutor, RuntimeLoop, RuntimeObserver, RuntimePlanner,
        RuntimeStep, RuntimeVerifier, TraceResultKind, Verification,
    };
    use crate::harness::tracing::TraceRecorder;
    use crate::runtime::context::{ContextManager, RuntimeContext};
    use crate::runtime::event_bus::EventBus;
    use crate::runtime::retry::RetryPolicy;
    use std::fs;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static TEMP_TRACE_COUNTER: AtomicU64 = AtomicU64::new(0);

    struct VecPlanner {
        steps: Vec<RuntimeStep>,
    }

    impl RuntimePlanner for VecPlanner {
        fn next_step<'a>(
            &'a mut self,
            _context: RuntimeContext,
        ) -> super::RuntimeFuture<'a, Option<RuntimeStep>> {
            Box::pin(async move {
                if self.steps.is_empty() {
                    None
                } else {
                    Some(self.steps.remove(0))
                }
            })
        }
    }

    struct EchoExecutor;

    impl RuntimeExecutor for EchoExecutor {
        fn execute<'a>(
            &'a mut self,
            step: &'a RuntimeStep,
        ) -> super::RuntimeFuture<'a, ActionResult> {
            Box::pin(async move {
                ActionResult {
                    stdout: step.tool_call.clone(),
                    stderr: String::new(),
                    exit_code: Some(0),
                    timed_out: false,
                    stdout_truncated: false,
                    stderr_truncated: false,
                    latency_ms: 1,
                }
            })
        }
    }

    struct PassthroughObserver;

    impl RuntimeObserver for PassthroughObserver {
        fn observe<'a>(
            &'a mut self,
            step: &'a RuntimeStep,
            action: ActionResult,
        ) -> super::RuntimeFuture<'a, Observation> {
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

    struct AlwaysPassVerifier;

    impl RuntimeVerifier for AlwaysPassVerifier {
        fn verify<'a>(
            &'a mut self,
            _observation: &'a Observation,
        ) -> super::RuntimeFuture<'a, Verification> {
            Box::pin(async move {
                Verification {
                    success: true,
                    summary: "passed".to_string(),
                }
            })
        }
    }

    struct SequenceVerifier {
        results: Vec<bool>,
    }

    impl RuntimeVerifier for SequenceVerifier {
        fn verify<'a>(
            &'a mut self,
            _observation: &'a Observation,
        ) -> super::RuntimeFuture<'a, Verification> {
            Box::pin(async move {
                let success = if self.results.is_empty() {
                    true
                } else {
                    self.results.remove(0)
                };
                Verification {
                    success,
                    summary: if success { "passed" } else { "failed" }.to_string(),
                }
            })
        }
    }

    fn temp_trace_root() -> std::path::PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let counter = TEMP_TRACE_COUNTER.fetch_add(1, Ordering::Relaxed);
        let root = std::env::temp_dir().join(format!(
            "main-runtime-loop-{}-{unique}-{counter}",
            std::process::id()
        ));
        fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn runtime_loop_executes_multiple_steps_and_records_trace() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            let trace_root = temp_trace_root();
            let loop_runner = RuntimeLoop::new(
                ContextManager::new(),
                EventBus::default(),
                TraceRecorder::new(&trace_root),
                RetryPolicy::new(0, 0),
            );
            let mut planner = VecPlanner {
                steps: vec![
                    RuntimeStep {
                        task_id: "task".to_string(),
                        step_id: "01".to_string(),
                        tool_call: "cargo check".to_string(),
                        terminal: false,
                    },
                    RuntimeStep {
                        task_id: "task".to_string(),
                        step_id: "02".to_string(),
                        tool_call: "cargo test".to_string(),
                        terminal: true,
                    },
                ],
            };
            let mut executor = EchoExecutor;
            let mut observer = PassthroughObserver;
            let mut verifier = AlwaysPassVerifier;

            let result = loop_runner
                .run(
                    "task",
                    &mut planner,
                    &mut executor,
                    &mut observer,
                    &mut verifier,
                )
                .await
                .unwrap();

            assert_eq!(result.result_kind, TraceResultKind::Success);
            assert_eq!(result.steps_executed, 2);
            let traces = TraceRecorder::new(&trace_root)
                .replay_run("task", &result.run_id)
                .await
                .unwrap();
            assert_eq!(traces.len(), 3);
            assert_eq!(traces[2].event_name, "task_completed");
            assert_eq!(traces[2].result_kind, TraceResultKind::Success);
        });
    }

    #[test]
    fn runtime_loop_retries_the_exact_failed_step() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            let trace_root = temp_trace_root();
            let event_bus = EventBus::default();
            let mut receiver = event_bus.subscribe();
            let loop_runner = RuntimeLoop::new(
                ContextManager::new(),
                event_bus,
                TraceRecorder::new(&trace_root),
                RetryPolicy::new(1, 0),
            );
            let mut planner = VecPlanner {
                steps: vec![RuntimeStep {
                    task_id: "task".to_string(),
                    step_id: "01".to_string(),
                    tool_call: "cargo check".to_string(),
                    terminal: true,
                }],
            };
            let mut executor = EchoExecutor;
            let mut observer = PassthroughObserver;
            let mut verifier = SequenceVerifier {
                results: vec![false, true],
            };

            let result = loop_runner
                .run(
                    "task",
                    &mut planner,
                    &mut executor,
                    &mut observer,
                    &mut verifier,
                )
                .await
                .unwrap();

            assert_eq!(result.result_kind, TraceResultKind::Success);
            assert_eq!(result.steps_executed, 2);
            let traces = TraceRecorder::new(&trace_root)
                .replay("task")
                .await
                .unwrap();
            assert_eq!(traces.len(), 3);
            assert_eq!(traces[0].step_id, "01");
            assert_eq!(traces[1].step_id, "01");
            assert_eq!(traces[0].attempt, 1);
            assert_eq!(traces[1].attempt, 2);
            assert_eq!(traces[2].step_id, "__run_conclusion__");
            assert_eq!(traces[2].result_kind, TraceResultKind::Success);
            let context = loop_runner.context_manager.build().await;
            assert_eq!(context.mistakes.len(), 1);

            let mut event_names = Vec::new();
            while let Ok(event) = receiver.try_recv() {
                event_names.push(event.event);
            }
            assert!(event_names.contains(&"verification_failed".to_string()));
            assert!(event_names.contains(&"retry_started".to_string()));
        });
    }

    #[test]
    fn verified_nonterminal_exhaustion_concludes_partial() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            let trace_root = temp_trace_root();
            let event_bus = EventBus::default();
            let mut receiver = event_bus.subscribe();
            let loop_runner = RuntimeLoop::new(
                ContextManager::new(),
                event_bus,
                TraceRecorder::new(&trace_root),
                RetryPolicy::new(0, 0),
            );
            let mut planner = VecPlanner {
                steps: vec![RuntimeStep {
                    task_id: "task-partial".to_string(),
                    step_id: "01".to_string(),
                    tool_call: "cargo check".to_string(),
                    terminal: false,
                }],
            };
            let mut executor = EchoExecutor;
            let mut observer = PassthroughObserver;
            let mut verifier = AlwaysPassVerifier;

            let result = loop_runner
                .run(
                    "task-partial",
                    &mut planner,
                    &mut executor,
                    &mut observer,
                    &mut verifier,
                )
                .await
                .unwrap();

            assert_eq!(result.result_kind, TraceResultKind::Partial);
            assert_eq!(
                result.summary,
                "planner_exhausted_without_terminal_verification"
            );
            let conclusions = std::iter::from_fn(|| receiver.try_recv().ok())
                .filter(|event| event.event == "task_completed")
                .collect::<Vec<_>>();
            assert_eq!(conclusions.len(), 1);
            assert_eq!(conclusions[0].payload["resultKind"], "partial");
            let traces = TraceRecorder::new(&trace_root)
                .replay_run("task-partial", &result.run_id)
                .await
                .unwrap();
            assert_eq!(traces.len(), 2);
            assert_eq!(traces[1].event_name, "task_completed");
            assert_eq!(traces[1].result_kind, TraceResultKind::Partial);
        });
    }

    #[test]
    fn planner_exhaustion_without_execution_concludes_blocked() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            let trace_root = temp_trace_root();
            let event_bus = EventBus::default();
            let mut receiver = event_bus.subscribe();
            let loop_runner = RuntimeLoop::new(
                ContextManager::new(),
                event_bus,
                TraceRecorder::new(&trace_root),
                RetryPolicy::new(1, 0),
            );
            let mut planner = VecPlanner { steps: Vec::new() };
            let mut executor = EchoExecutor;
            let mut observer = PassthroughObserver;
            let mut verifier = AlwaysPassVerifier;

            let result = loop_runner
                .run(
                    "task-empty",
                    &mut planner,
                    &mut executor,
                    &mut observer,
                    &mut verifier,
                )
                .await
                .unwrap();

            assert_eq!(result.result_kind, TraceResultKind::Blocked);
            assert_eq!(result.summary, "planner_exhausted_without_steps");
            assert_eq!(result.steps_executed, 0);
            let mut conclusion = None;
            while let Ok(event) = receiver.try_recv() {
                if event.event == "task_completed" {
                    conclusion = Some(event);
                    break;
                }
            }
            let conclusion = conclusion.expect("task conclusion");
            assert_eq!(conclusion.payload["resultKind"], "blocked");
            let traces = TraceRecorder::new(&trace_root)
                .replay_run("task-empty", &result.run_id)
                .await
                .unwrap();
            assert_eq!(traces.len(), 1);
            assert_eq!(traces[0].result_kind, TraceResultKind::Blocked);
        });
    }

    #[test]
    fn an_unresolved_retry_concludes_error_instead_of_fake_success() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            let trace_root = temp_trace_root();
            let event_bus = EventBus::default();
            let mut receiver = event_bus.subscribe();
            let loop_runner = RuntimeLoop::new(
                ContextManager::new(),
                event_bus,
                TraceRecorder::new(&trace_root),
                RetryPolicy::new(1, 0),
            );
            let mut planner = VecPlanner {
                steps: vec![RuntimeStep {
                    task_id: "task-missing-retry".to_string(),
                    step_id: "01".to_string(),
                    tool_call: "cargo test".to_string(),
                    terminal: false,
                }],
            };
            let mut executor = EchoExecutor;
            let mut observer = PassthroughObserver;
            let mut verifier = SequenceVerifier {
                results: vec![false, false],
            };

            let result = loop_runner
                .run(
                    "task-missing-retry",
                    &mut planner,
                    &mut executor,
                    &mut observer,
                    &mut verifier,
                )
                .await
                .unwrap();

            assert_eq!(result.result_kind, TraceResultKind::Error);
            assert!(result.summary.contains("retry budget exhausted"));
            assert_eq!(result.steps_executed, 2);
            let mut conclusions = Vec::new();
            while let Ok(event) = receiver.try_recv() {
                if event.event == "task_completed" {
                    conclusions.push(event);
                }
            }
            assert_eq!(conclusions.len(), 1);
            assert_eq!(conclusions[0].payload["resultKind"], "error");
        });
    }

    #[test]
    fn retry_exhaustion_still_emits_one_structured_conclusion() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            let trace_root = temp_trace_root();
            let event_bus = EventBus::default();
            let mut receiver = event_bus.subscribe();
            let loop_runner = RuntimeLoop::new(
                ContextManager::new(),
                event_bus,
                TraceRecorder::new(&trace_root),
                RetryPolicy::new(0, 0),
            );
            let mut planner = VecPlanner {
                steps: vec![RuntimeStep {
                    task_id: "task-exhausted".to_string(),
                    step_id: "01".to_string(),
                    tool_call: "cargo test".to_string(),
                    terminal: true,
                }],
            };
            let mut executor = EchoExecutor;
            let mut observer = PassthroughObserver;
            let mut verifier = SequenceVerifier {
                results: vec![false],
            };

            let result = loop_runner
                .run(
                    "task-exhausted",
                    &mut planner,
                    &mut executor,
                    &mut observer,
                    &mut verifier,
                )
                .await
                .unwrap();

            assert_eq!(result.result_kind, TraceResultKind::Error);
            assert!(result.summary.contains("retry budget exhausted"));
            let mut conclusions = Vec::new();
            while let Ok(event) = receiver.try_recv() {
                if event.event == "task_completed" {
                    conclusions.push(event);
                }
            }
            assert_eq!(conclusions.len(), 1);
            assert_eq!(conclusions[0].payload["resultKind"], "error");
            let traces = TraceRecorder::new(&trace_root)
                .replay("task-exhausted")
                .await
                .unwrap();
            assert_eq!(traces.len(), 2);
            assert!(!traces[0].recorded_success());
            assert_eq!(traces[1].event_name, "task_completed");
            assert_eq!(traces[1].result_kind, TraceResultKind::Error);
        });
    }
}
