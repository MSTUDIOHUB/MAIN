use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::RwLock;

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeContext {
    pub active_files: Vec<String>,
    pub recent_steps: Vec<RuntimeStepSummary>,
    pub working_memory: Vec<String>,
    pub summaries: Vec<String>,
    pub mistakes: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeStepSummary {
    pub step_id: String,
    pub tool_call: String,
    pub verification: String,
    pub success: bool,
}

#[derive(Debug, Clone, Default)]
pub struct ContextManager {
    state: Arc<RwLock<RuntimeContext>>,
}

impl ContextManager {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn build(&self) -> RuntimeContext {
        self.state.read().await.clone()
    }

    pub async fn add_active_file(&self, path: impl Into<String>) {
        let path = path.into();
        let mut state = self.state.write().await;
        if !state.active_files.contains(&path) {
            state.active_files.push(path);
        }
    }

    pub async fn record_step(&self, step: RuntimeStepSummary) {
        let mut state = self.state.write().await;
        state.recent_steps.push(step);
        const RECENT_STEP_LIMIT: usize = 20;
        if state.recent_steps.len() > RECENT_STEP_LIMIT {
            let overflow = state.recent_steps.len() - RECENT_STEP_LIMIT;
            state.recent_steps.drain(0..overflow);
        }
    }

    pub async fn remember(&self, value: impl Into<String>) {
        self.state.write().await.working_memory.push(value.into());
    }

    pub async fn summarize(&self, value: impl Into<String>) {
        self.state.write().await.summaries.push(value.into());
    }

    pub async fn record_mistake(&self, value: impl Into<String>) {
        self.state.write().await.mistakes.push(value.into());
    }
}

#[cfg(test)]
mod tests {
    use super::{ContextManager, RuntimeStepSummary};

    #[test]
    fn context_manager_tracks_phase_one_state() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            let manager = ContextManager::new();
            manager.add_active_file("src-tauri/src/lib.rs").await;
            manager.remember("working note").await;
            manager.summarize("summary").await;
            manager.record_mistake("mistake").await;
            manager
                .record_step(RuntimeStepSummary {
                    step_id: "1".to_string(),
                    tool_call: "cargo check".to_string(),
                    verification: "passed".to_string(),
                    success: true,
                })
                .await;

            let context = manager.build().await;
            assert_eq!(context.active_files, vec!["src-tauri/src/lib.rs"]);
            assert_eq!(context.working_memory, vec!["working note"]);
            assert_eq!(context.summaries, vec!["summary"]);
            assert_eq!(context.mistakes, vec!["mistake"]);
            assert_eq!(context.recent_steps.len(), 1);
        });
    }
}
