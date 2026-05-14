use crate::task_graph::{AgentRole, TaskGraph, TaskNode};
use serde::{Deserialize, Serialize};
use serde_json::json;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MultiAgentPlan {
    pub objective: String,
    pub graph: TaskGraph,
}

#[derive(Debug, Clone, Default)]
pub struct PlannerAgent;

impl PlannerAgent {
    pub fn new() -> Self {
        Self
    }

    pub fn plan(&self, objective: impl Into<String>) -> MultiAgentPlan {
        let objective = objective.into();
        let steps = split_objective(&objective);
        let mut nodes = Vec::new();

        for (index, step) in steps.iter().enumerate() {
            let id = format!("task-{:02}", index + 1);
            nodes.push(TaskNode {
                id,
                description: step.clone(),
                agent: AgentRole::Executor,
                dependencies: if index == 0 {
                    Vec::new()
                } else {
                    vec![format!("task-{:02}", index)]
                },
                tool: None,
                input: json!({"instruction": step}),
            });
        }

        nodes.push(TaskNode {
            id: "critic-review".to_string(),
            description: "Critic checks execution evidence and hallucination risk".to_string(),
            agent: AgentRole::Critic,
            dependencies: nodes.iter().map(|node| node.id.clone()).collect(),
            tool: None,
            input: json!({"objective": objective}),
        });

        MultiAgentPlan {
            objective,
            graph: TaskGraph {
                id: "multi-agent-plan".to_string(),
                nodes,
            },
        }
    }
}

fn split_objective(objective: &str) -> Vec<String> {
    let mut steps = objective
        .lines()
        .map(|line| {
            line.trim()
                .trim_start_matches(['-', '*'])
                .trim_start_matches(|ch: char| ch.is_ascii_digit() || ch == '.' || ch == ')')
                .trim()
                .to_string()
        })
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>();

    if steps.is_empty() {
        steps = objective
            .split(['.', '。', ';', '；'])
            .map(str::trim)
            .filter(|part| !part.is_empty())
            .map(str::to_string)
            .collect();
    }

    if steps.is_empty() {
        steps.push(objective.trim().to_string());
    }
    steps
}

#[cfg(test)]
mod tests {
    use super::PlannerAgent;
    use crate::task_graph::AgentRole;

    #[test]
    fn planner_splits_objective_and_adds_critic() {
        let plan = PlannerAgent::new().plan("- inspect scene\n- edit prefab");

        assert_eq!(plan.graph.nodes.len(), 3);
        assert_eq!(plan.graph.nodes[0].agent, AgentRole::Executor);
        assert_eq!(plan.graph.nodes[2].agent, AgentRole::Critic);
        assert_eq!(plan.graph.nodes[1].dependencies, vec!["task-01"]);
    }
}
