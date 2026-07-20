use futures_util::future::join_all;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::pin::Pin;
use std::time::Instant;

pub type TaskGraphFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentRole {
    Planner,
    Executor,
    Critic,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskNode {
    pub id: String,
    pub description: String,
    pub agent: AgentRole,
    pub dependencies: Vec<String>,
    pub tool: Option<String>,
    pub input: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskGraph {
    pub id: String,
    pub nodes: Vec<TaskNode>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskGraphStepResult {
    pub node_id: String,
    pub success: bool,
    pub output: Value,
    pub latency_ms: u128,
    pub tool_calls: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskGraphExecution {
    pub graph_id: String,
    /// Legacy serialized executions had no run identity. Deserialize them as
    /// explicitly unscoped instead of inventing an identity that has no trace.
    #[serde(default)]
    pub run_id: String,
    pub success: bool,
    pub waves: Vec<Vec<String>>,
    pub results: Vec<TaskGraphStepResult>,
    pub latency_ms: u128,
}

pub trait TaskGraphRunner {
    fn run_id(&self) -> Option<&str> {
        None
    }

    fn run<'a>(&'a self, node: TaskNode) -> TaskGraphFuture<'a, TaskGraphStepResult>;
}

impl TaskGraph {
    pub fn validate(&self) -> Result<(), String> {
        let mut ids = HashSet::new();
        for node in &self.nodes {
            if node.id.trim().is_empty() {
                return Err("task graph node id cannot be empty".to_string());
            }
            if !ids.insert(node.id.clone()) {
                return Err(format!("duplicate task graph node id: {}", node.id));
            }
        }
        for node in &self.nodes {
            for dependency in &node.dependencies {
                if !ids.contains(dependency) {
                    return Err(format!(
                        "task graph node {} depends on missing node {}",
                        node.id, dependency
                    ));
                }
            }
        }
        Ok(())
    }

    pub fn execution_waves(&self) -> Result<Vec<Vec<TaskNode>>, String> {
        self.validate()?;
        let mut remaining = self
            .nodes
            .iter()
            .cloned()
            .map(|node| (node.id.clone(), node))
            .collect::<HashMap<_, _>>();
        let mut completed = HashSet::new();
        let mut waves = Vec::new();

        while !remaining.is_empty() {
            let mut ready = remaining
                .values()
                .filter(|node| {
                    node.dependencies
                        .iter()
                        .all(|dependency| completed.contains(dependency))
                })
                .cloned()
                .collect::<Vec<_>>();
            ready.sort_by(|left, right| left.id.cmp(&right.id));

            if ready.is_empty() {
                let blocked = remaining.keys().cloned().collect::<Vec<_>>().join(", ");
                return Err(format!("task graph has a dependency cycle: {blocked}"));
            }

            for node in &ready {
                completed.insert(node.id.clone());
                remaining.remove(&node.id);
            }
            waves.push(ready);
        }

        Ok(waves)
    }

    pub async fn execute<R>(&self, runner: &R) -> Result<TaskGraphExecution, String>
    where
        R: TaskGraphRunner + Sync,
    {
        let started_at = Instant::now();
        let waves = self.execution_waves()?;
        let mut completed_waves = Vec::new();
        let mut results = Vec::new();
        let mut success = true;

        for wave in waves {
            completed_waves.push(wave.iter().map(|node| node.id.clone()).collect::<Vec<_>>());
            let wave_results = join_all(wave.into_iter().map(|node| runner.run(node))).await;
            let wave_success = wave_results.iter().all(|result| result.success);
            results.extend(wave_results);
            if !wave_success {
                success = false;
                break;
            }
        }

        Ok(TaskGraphExecution {
            graph_id: self.id.clone(),
            run_id: runner
                .run_id()
                .map(str::to_string)
                .unwrap_or_else(new_task_graph_run_id),
            success,
            waves: completed_waves,
            results,
            latency_ms: started_at.elapsed().as_millis(),
        })
    }
}

fn new_task_graph_run_id() -> String {
    format!("graph-run-{:032x}", rand::random::<u128>())
}

#[cfg(test)]
mod tests {
    use super::{AgentRole, TaskGraph, TaskGraphRunner, TaskGraphStepResult, TaskNode};
    use serde_json::json;

    struct EchoRunner;

    impl TaskGraphRunner for EchoRunner {
        fn run<'a>(&'a self, node: TaskNode) -> super::TaskGraphFuture<'a, TaskGraphStepResult> {
            Box::pin(async move {
                TaskGraphStepResult {
                    node_id: node.id,
                    success: true,
                    output: json!({"ok": true}),
                    latency_ms: 1,
                    tool_calls: 1,
                }
            })
        }
    }

    fn node(id: &str, dependencies: Vec<&str>) -> TaskNode {
        TaskNode {
            id: id.to_string(),
            description: id.to_string(),
            agent: AgentRole::Executor,
            dependencies: dependencies.into_iter().map(str::to_string).collect(),
            tool: None,
            input: json!({}),
        }
    }

    #[test]
    fn task_graph_schedules_parallel_dependency_waves() {
        let graph = TaskGraph {
            id: "graph".to_string(),
            nodes: vec![
                node("a", vec![]),
                node("b", vec![]),
                node("c", vec!["a", "b"]),
            ],
        };

        let waves = graph.execution_waves().unwrap();

        assert_eq!(
            waves
                .iter()
                .map(|wave| wave.iter().map(|node| node.id.clone()).collect::<Vec<_>>())
                .collect::<Vec<_>>(),
            vec![
                vec!["a".to_string(), "b".to_string()],
                vec!["c".to_string()]
            ]
        );
    }

    #[test]
    fn task_graph_executes_all_waves() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            let graph = TaskGraph {
                id: "graph".to_string(),
                nodes: vec![node("a", vec![]), node("b", vec!["a"])],
            };

            let execution = graph.execute(&EchoRunner).await.unwrap();

            assert!(execution.success);
            assert!(execution.run_id.starts_with("graph-run-"));
            assert_eq!(execution.results.len(), 2);
            assert_eq!(execution.waves, vec![vec!["a"], vec!["b"]]);
        });
    }
}
