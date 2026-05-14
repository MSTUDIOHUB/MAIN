use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tokio::fs;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TraceRecord {
    pub task_id: String,
    pub step_id: String,
    #[serde(default = "default_event_name")]
    pub event_name: String,
    pub tool_call: String,
    pub stdout: String,
    pub stderr: String,
    pub verification: String,
    pub latency_ms: u128,
    #[serde(default)]
    pub metadata: serde_json::Value,
}

#[derive(Debug, Clone)]
pub struct TraceRecorder {
    root: PathBuf,
}

impl TraceRecorder {
    pub fn for_workspace(workspace: impl AsRef<Path>) -> Self {
        Self {
            root: workspace.as_ref().join(".MAIN").join("traces"),
        }
    }

    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub async fn record(&self, record: &TraceRecord) -> Result<PathBuf, String> {
        fs::create_dir_all(&self.root)
            .await
            .map_err(|error| format!("创建 trace 目录失败: {error}"))?;
        let path = self.trace_path(&record.task_id, &record.step_id);
        let content = serde_json::to_vec_pretty(record)
            .map_err(|error| format!("序列化 trace 失败: {error}"))?;
        fs::write(&path, content)
            .await
            .map_err(|error| format!("写入 trace 失败 {}: {error}", path.display()))?;
        Ok(path)
    }

    pub async fn load(&self, task_id: &str, step_id: &str) -> Result<TraceRecord, String> {
        let path = self.trace_path(task_id, step_id);
        let content = fs::read_to_string(&path)
            .await
            .map_err(|error| format!("读取 trace 失败 {}: {error}", path.display()))?;
        serde_json::from_str(&content)
            .map_err(|error| format!("解析 trace 失败 {}: {error}", path.display()))
    }

    pub async fn replay(&self, task_id: &str) -> Result<Vec<TraceRecord>, String> {
        let mut records = Vec::new();
        let mut entries = match fs::read_dir(&self.root).await {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(records),
            Err(error) => return Err(format!("读取 trace 目录失败: {error}")),
        };

        while let Some(entry) = entries
            .next_entry()
            .await
            .map_err(|error| format!("遍历 trace 目录失败: {error}"))?
        {
            let path = entry.path();
            let Some(file_name) = path.file_name().and_then(|value| value.to_str()) else {
                continue;
            };
            if !file_name.starts_with(&format!("{}__", sanitize_trace_part(task_id))) {
                continue;
            }
            let content = fs::read_to_string(&path)
                .await
                .map_err(|error| format!("读取 trace 失败 {}: {error}", path.display()))?;
            let record = serde_json::from_str::<TraceRecord>(&content)
                .map_err(|error| format!("解析 trace 失败 {}: {error}", path.display()))?;
            records.push(record);
        }

        records.sort_by(|left, right| left.step_id.cmp(&right.step_id));
        Ok(records)
    }

    fn trace_path(&self, task_id: &str, step_id: &str) -> PathBuf {
        self.root.join(format!(
            "{}__{}.json",
            sanitize_trace_part(task_id),
            sanitize_trace_part(step_id)
        ))
    }
}

fn sanitize_trace_part(value: &str) -> String {
    let sanitized: String = value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_') {
                ch
            } else {
                '_'
            }
        })
        .collect();

    if sanitized.is_empty() {
        "trace".to_string()
    } else {
        sanitized
    }
}

fn default_event_name() -> String {
    "tool_called".to_string()
}

#[cfg(test)]
mod tests {
    use super::{TraceRecord, TraceRecorder};
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_trace_root() -> std::path::PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("main-traces-{unique}"));
        fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn recorder_writes_json_and_replays_steps() {
        let root = temp_trace_root();
        let recorder = TraceRecorder::new(&root);
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();

        runtime.block_on(async {
            recorder
                .record(&TraceRecord {
                    task_id: "task-a".to_string(),
                    step_id: "02".to_string(),
                    event_name: "tool_called".to_string(),
                    tool_call: "cargo test".to_string(),
                    stdout: "ok".to_string(),
                    stderr: String::new(),
                    verification: "passed".to_string(),
                    latency_ms: 9,
                    metadata: serde_json::json!({}),
                })
                .await
                .unwrap();
            recorder
                .record(&TraceRecord {
                    task_id: "task-a".to_string(),
                    step_id: "01".to_string(),
                    event_name: "tool_called".to_string(),
                    tool_call: "cargo check".to_string(),
                    stdout: "ok".to_string(),
                    stderr: String::new(),
                    verification: "passed".to_string(),
                    latency_ms: 7,
                    metadata: serde_json::json!({}),
                })
                .await
                .unwrap();

            let replayed = recorder.replay("task-a").await.unwrap();
            assert_eq!(replayed.len(), 2);
            assert_eq!(replayed[0].step_id, "01");
            assert_eq!(replayed[1].step_id, "02");
        });
    }
}
