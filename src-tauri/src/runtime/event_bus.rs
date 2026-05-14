use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::sync::broadcast;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeEventName {
    TaskStarted,
    ToolCalled,
    VerificationFailed,
    RetryStarted,
    TaskCompleted,
}

impl RuntimeEventName {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::TaskStarted => "task_started",
            Self::ToolCalled => "tool_called",
            Self::VerificationFailed => "verification_failed",
            Self::RetryStarted => "retry_started",
            Self::TaskCompleted => "task_completed",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeEvent {
    pub name: RuntimeEventName,
    pub event: String,
    pub task_id: String,
    pub step_id: Option<String>,
    pub payload: Value,
    pub timestamp_ms: u64,
}

#[derive(Debug, Clone)]
pub struct EventBus {
    sender: broadcast::Sender<RuntimeEvent>,
}

impl Default for EventBus {
    fn default() -> Self {
        Self::new(256)
    }
}

impl EventBus {
    pub fn new(capacity: usize) -> Self {
        let (sender, _) = broadcast::channel(capacity);
        Self { sender }
    }

    pub fn emit(
        &self,
        name: RuntimeEventName,
        task_id: impl Into<String>,
        step_id: Option<String>,
        payload: Value,
    ) -> Result<usize, broadcast::error::SendError<RuntimeEvent>> {
        let event = RuntimeEvent {
            event: name.as_str().to_string(),
            name,
            task_id: task_id.into(),
            step_id,
            payload,
            timestamp_ms: now_millis(),
        };
        self.sender.send(event)
    }

    pub fn subscribe(&self) -> broadcast::Receiver<RuntimeEvent> {
        self.sender.subscribe()
    }
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_else(|_| Duration::from_secs(0))
        .as_millis() as u64
}

#[cfg(test)]
mod tests {
    use super::{EventBus, RuntimeEventName};
    use serde_json::json;

    #[test]
    fn bus_emits_named_runtime_events() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            let bus = EventBus::default();
            let mut receiver = bus.subscribe();

            bus.emit(
                RuntimeEventName::ToolCalled,
                "task",
                Some("step".to_string()),
                json!({"tool": "cargo check"}),
            )
            .unwrap();

            let event = receiver.recv().await.unwrap();
            assert_eq!(event.event, "tool_called");
            assert_eq!(event.task_id, "task");
            assert_eq!(event.step_id.as_deref(), Some("step"));
        });
    }
}
