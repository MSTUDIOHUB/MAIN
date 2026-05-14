use crate::task_graph::TaskGraphExecution;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CriticReport {
    pub hallucination_detected: bool,
    pub checked_steps: usize,
    pub missing_evidence: Vec<String>,
    pub summary: String,
}

#[derive(Debug, Clone, Default)]
pub struct CriticAgent;

impl CriticAgent {
    pub fn new() -> Self {
        Self
    }

    pub fn review_execution(&self, execution: &TaskGraphExecution) -> CriticReport {
        let mut missing_evidence = Vec::new();
        for result in &execution.results {
            if !result.success {
                missing_evidence.push(format!("{} failed", result.node_id));
                continue;
            }
            let empty_object = result
                .output
                .as_object()
                .map(|object| object.is_empty())
                .unwrap_or(false);
            let empty_string = result
                .output
                .as_str()
                .map(|value| value.trim().is_empty())
                .unwrap_or(false);
            if result.output.is_null() || empty_object || empty_string {
                missing_evidence.push(format!("{} has no evidence output", result.node_id));
            }
        }

        let hallucination_detected = !missing_evidence.is_empty();
        CriticReport {
            hallucination_detected,
            checked_steps: execution.results.len(),
            summary: if hallucination_detected {
                "Execution has missing or failed evidence; do not claim completion.".to_string()
            } else {
                "Execution evidence is present for all completed steps.".to_string()
            },
            missing_evidence,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::CriticAgent;
    use crate::task_graph::{TaskGraphExecution, TaskGraphStepResult};
    use serde_json::json;

    #[test]
    fn critic_flags_missing_evidence() {
        let execution = TaskGraphExecution {
            graph_id: "g".to_string(),
            success: true,
            waves: vec![vec!["a".to_string()]],
            results: vec![TaskGraphStepResult {
                node_id: "a".to_string(),
                success: true,
                output: json!({}),
                latency_ms: 1,
                tool_calls: 1,
            }],
            latency_ms: 1,
        };

        let report = CriticAgent::new().review_execution(&execution);

        assert!(report.hallucination_detected);
        assert_eq!(report.missing_evidence, vec!["a has no evidence output"]);
    }
}
