use crate::harness::tracing::{TraceRecord, TraceRecorder};
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
    pub completed: bool,
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
        let task_id = task_id.into();
        let _ = self.event_bus.emit(
            RuntimeEventName::TaskStarted,
            task_id.clone(),
            None,
            json!({}),
        );

        let mut retry_state = RetryState::new();
        let mut steps_executed = 0;

        loop {
            let context = self.context_manager.build().await;
            let Some(step) = planner.next_step(context).await else {
                let _ = self.event_bus.emit(
                    RuntimeEventName::TaskCompleted,
                    task_id.clone(),
                    None,
                    json!({"completed": true, "reason": "planner_exhausted"}),
                );
                return Ok(RuntimeRunResult {
                    task_id,
                    completed: true,
                    steps_executed,
                });
            };

            let _ = self.event_bus.emit(
                RuntimeEventName::ToolCalled,
                task_id.clone(),
                Some(step.step_id.clone()),
                json!({"toolCall": step.tool_call}),
            );

            let action = executor.execute(&step).await;
            let observation = observer.observe(&step, action).await;
            let verification = verifier.verify(&observation).await;
            steps_executed += 1;

            self.trace_recorder
                .record(&TraceRecord {
                    task_id: step.task_id.clone(),
                    step_id: step.step_id.clone(),
                    tool_call: step.tool_call.clone(),
                    stdout: observation.stdout.clone(),
                    stderr: observation.stderr.clone(),
                    verification: verification.summary.clone(),
                    latency_ms: observation.latency_ms,
                })
                .await?;

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
                    let _ = self.event_bus.emit(
                        RuntimeEventName::TaskCompleted,
                        task_id.clone(),
                        Some(step.step_id.clone()),
                        json!({"completed": true}),
                    );
                    return Ok(RuntimeRunResult {
                        task_id,
                        completed: true,
                        steps_executed,
                    });
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
                json!({"verification": verification.summary}),
            );

            match self.retry_policy.handle(&mut retry_state).await {
                RetryDecision::Retry { attempt } => {
                    let _ = self.event_bus.emit(
                        RuntimeEventName::RetryStarted,
                        task_id.clone(),
                        Some(step.step_id.clone()),
                        json!({"attempt": attempt}),
                    );
                }
                RetryDecision::Stop => {
                    return Ok(RuntimeRunResult {
                        task_id,
                        completed: false,
                        steps_executed,
                    });
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        ActionResult, Observation, RuntimeExecutor, RuntimeLoop, RuntimeObserver, RuntimePlanner,
        RuntimeStep, RuntimeVerifier, Verification,
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

            assert!(result.completed);
            assert_eq!(result.steps_executed, 2);
            assert_eq!(
                TraceRecorder::new(&trace_root)
                    .replay("task")
                    .await
                    .unwrap()
                    .len(),
                2
            );
        });
    }

    #[test]
    fn runtime_loop_emits_retry_after_failed_verification() {
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
                steps: vec![
                    RuntimeStep {
                        task_id: "task".to_string(),
                        step_id: "01".to_string(),
                        tool_call: "cargo check".to_string(),
                        terminal: false,
                    },
                    RuntimeStep {
                        task_id: "task".to_string(),
                        step_id: "01-retry".to_string(),
                        tool_call: "cargo check".to_string(),
                        terminal: true,
                    },
                ],
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

            assert!(result.completed);
            assert_eq!(result.steps_executed, 2);
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
}
