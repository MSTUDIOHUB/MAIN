use crate::task_graph::{TaskGraph, TaskGraphExecution, TaskGraphRunner};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutorSummary {
    pub graph_id: String,
    pub success: bool,
    pub completed_steps: usize,
    pub waves: Vec<Vec<String>>,
}

#[derive(Debug, Clone, Default)]
pub struct ExecutorAgent;

impl ExecutorAgent {
    pub fn new() -> Self {
        Self
    }

    pub async fn execute<R>(
        &self,
        graph: &TaskGraph,
        runner: &R,
    ) -> Result<TaskGraphExecution, String>
    where
        R: TaskGraphRunner + Sync,
    {
        graph.execute(runner).await
    }

    pub fn summarize(execution: &TaskGraphExecution) -> ExecutorSummary {
        ExecutorSummary {
            graph_id: execution.graph_id.clone(),
            success: execution.success,
            completed_steps: execution.results.len(),
            waves: execution.waves.clone(),
        }
    }
}
