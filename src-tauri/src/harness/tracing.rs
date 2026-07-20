use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};
use tokio::fs;

pub const TRACE_SCHEMA_VERSION: u32 = 3;
pub const GOLDEN_TRACE_SCHEMA_VERSION: u32 = 2;
const EXPLICIT_RESULT_SCHEMA_VERSION: u32 = 2;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TraceResultKind {
    Success,
    Partial,
    Blocked,
    #[default]
    Error,
    Canceled,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TraceRecord {
    #[serde(default = "legacy_trace_schema_version")]
    pub schema_version: u32,
    /// A logical task may be executed more than once. New records always
    /// carry a run identity so replay and Golden comparison can select one
    /// execution without mixing prior task history. Legacy records remain
    /// readable as an unscoped run.
    #[serde(default)]
    pub run_id: Option<String>,
    #[serde(default)]
    pub sequence: u64,
    #[serde(default = "default_attempt")]
    pub attempt: u32,
    pub task_id: String,
    pub step_id: String,
    #[serde(default = "default_event_name")]
    pub event_name: String,
    pub tool_call: String,
    #[serde(default)]
    pub input_digest: String,
    pub stdout: String,
    pub stderr: String,
    /// The exact structured tool payload. Keeping it first-class makes replay
    /// semantically equivalent to the original operation instead of reducing
    /// a result to its textual streams.
    #[serde(default)]
    pub structured_output: Value,
    #[serde(default)]
    pub output_digest: String,
    #[serde(default)]
    pub success: bool,
    #[serde(default)]
    pub result_kind: TraceResultKind,
    #[serde(default)]
    pub exit_code: Option<i32>,
    #[serde(default)]
    pub timed_out: bool,
    #[serde(default)]
    pub stdout_truncated: bool,
    #[serde(default)]
    pub stderr_truncated: bool,
    pub verification: String,
    pub latency_ms: u128,
    #[serde(default)]
    pub events: Vec<String>,
    #[serde(default)]
    pub metadata: serde_json::Value,
}

impl TraceRecord {
    pub fn tool_result(
        task_id: impl Into<String>,
        step_id: impl Into<String>,
        tool_call: impl Into<String>,
        stdout: impl Into<String>,
        stderr: impl Into<String>,
        verification: impl Into<String>,
        latency_ms: u128,
        success: bool,
    ) -> Self {
        let result_kind = if success {
            TraceResultKind::Success
        } else {
            TraceResultKind::Error
        };
        Self {
            schema_version: TRACE_SCHEMA_VERSION,
            run_id: Some(new_trace_run_id()),
            sequence: 0,
            attempt: 1,
            task_id: task_id.into(),
            step_id: step_id.into(),
            event_name: default_event_name(),
            tool_call: tool_call.into(),
            input_digest: String::new(),
            stdout: stdout.into(),
            stderr: stderr.into(),
            structured_output: Value::Null,
            output_digest: String::new(),
            success,
            result_kind,
            exit_code: None,
            timed_out: false,
            stdout_truncated: false,
            stderr_truncated: false,
            verification: verification.into(),
            latency_ms,
            events: Vec::new(),
            metadata: serde_json::json!({}),
        }
    }

    /// Persisted v1 traces did not have an explicit success field. Their
    /// structured metadata or verification label is accepted for read
    /// compatibility; empty stderr is deliberately never treated as success.
    pub fn recorded_success(&self) -> bool {
        if self.schema_version >= EXPLICIT_RESULT_SCHEMA_VERSION {
            return self.success;
        }
        self.metadata
            .get("success")
            .and_then(serde_json::Value::as_bool)
            .or_else(|| {
                self.metadata
                    .get("verificationSuccess")
                    .and_then(serde_json::Value::as_bool)
            })
            .unwrap_or_else(|| {
                matches!(
                    self.verification.trim().to_ascii_lowercase().as_str(),
                    "success" | "passed" | "pass"
                )
            })
    }

    /// Recover the semantic result of a legacy trace without allowing the
    /// serde default (`error`) to contradict an explicitly successful v1
    /// verification. Failure subtypes are only recovered from structured
    /// metadata; free-form prose is not a lifecycle contract.
    pub fn recorded_result_kind(&self) -> TraceResultKind {
        if self.schema_version >= EXPLICIT_RESULT_SCHEMA_VERSION {
            return self.result_kind;
        }

        if self.result_kind != TraceResultKind::Error {
            return self.result_kind;
        }

        let structured = self
            .metadata
            .get("resultKind")
            .or_else(|| self.metadata.get("result_kind"))
            .and_then(serde_json::Value::as_str)
            .and_then(parse_result_kind);
        structured.unwrap_or_else(|| {
            if self.recorded_success() {
                TraceResultKind::Success
            } else {
                TraceResultKind::Error
            }
        })
    }

    pub fn conclusion(
        task_id: impl Into<String>,
        run_id: impl Into<String>,
        result_kind: TraceResultKind,
        reason: impl Into<String>,
        summary: impl Into<String>,
        owner_step_id: Option<&str>,
    ) -> Self {
        let reason = reason.into();
        let summary = summary.into();
        Self {
            schema_version: TRACE_SCHEMA_VERSION,
            run_id: Some(run_id.into()),
            sequence: 0,
            attempt: 1,
            task_id: task_id.into(),
            step_id: "__run_conclusion__".to_string(),
            event_name: "task_completed".to_string(),
            tool_call: String::new(),
            input_digest: String::new(),
            stdout: String::new(),
            stderr: String::new(),
            structured_output: Value::Null,
            output_digest: String::new(),
            // A terminal record confirms that a structured conclusion was
            // published; task semantics live in result_kind.
            success: true,
            result_kind,
            exit_code: None,
            timed_out: false,
            stdout_truncated: false,
            stderr_truncated: false,
            verification: summary.clone(),
            latency_ms: 0,
            events: vec!["task_completed".to_string()],
            metadata: serde_json::json!({
                "reason": reason,
                "summary": summary,
                "ownerStepId": owner_step_id,
            }),
        }
    }

    fn normalize_for_persistence(&mut self) {
        let recorded_success = self.recorded_success();
        let recorded_result_kind = self.recorded_result_kind();
        self.schema_version = TRACE_SCHEMA_VERSION;
        self.success = recorded_success;
        self.result_kind = recorded_result_kind;
        self.attempt = self.attempt.max(1);
        if self.input_digest.is_empty() {
            self.input_digest = digest_text(&self.tool_call);
        }
        if self.output_digest.is_empty() {
            self.output_digest =
                digest_tool_output(&self.structured_output, &self.stdout, &self.stderr);
        }
    }

    fn golden_record(&self) -> GoldenTraceRecord {
        GoldenTraceRecord {
            sequence: self.sequence,
            attempt: self.attempt.max(1),
            step_id: self.step_id.clone(),
            event_name: self.event_name.clone(),
            tool_call: self.tool_call.clone(),
            input_digest: if self.input_digest.is_empty() {
                digest_text(&self.tool_call)
            } else {
                self.input_digest.clone()
            },
            output_digest: if self.output_digest.is_empty() {
                digest_tool_output(&self.structured_output, &self.stdout, &self.stderr)
            } else {
                self.output_digest.clone()
            },
            success: self.recorded_success(),
            result_kind: self.recorded_result_kind(),
            exit_code: self.exit_code,
            timed_out: self.timed_out,
            stdout_truncated: self.stdout_truncated,
            stderr_truncated: self.stderr_truncated,
            verification: self.verification.clone(),
            events: self.events.clone(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoldenTraceRecord {
    pub sequence: u64,
    pub attempt: u32,
    pub step_id: String,
    pub event_name: String,
    pub tool_call: String,
    pub input_digest: String,
    pub output_digest: String,
    pub success: bool,
    pub result_kind: TraceResultKind,
    pub exit_code: Option<i32>,
    pub timed_out: bool,
    pub stdout_truncated: bool,
    pub stderr_truncated: bool,
    pub verification: String,
    pub events: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoldenTrace {
    pub schema_version: u32,
    pub task_id: String,
    pub records: Vec<GoldenTraceRecord>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoldenTraceComparison {
    pub matches: bool,
    pub differences: Vec<String>,
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
        self.record_with_sequence(record)
            .await
            .map(|(path, _sequence)| path)
    }

    /// Record a trace and return the task-global sequence allocated to this
    /// exact immutable record. Callers must not rediscover it via a later
    /// "latest" query because another operation may have been persisted in
    /// between.
    pub async fn record_with_sequence(
        &self,
        record: &TraceRecord,
    ) -> Result<(PathBuf, u64), String> {
        fs::create_dir_all(&self.root)
            .await
            .map_err(|error| format!("创建 trace 目录失败: {error}"))?;

        let mut persisted = record.clone();
        persisted.normalize_for_persistence();
        let mut sequence = if persisted.sequence == 0 {
            self.next_sequence(&persisted.task_id).await?
        } else {
            persisted.sequence
        };

        for _ in 0..1_024 {
            persisted.sequence = sequence;
            let path = self.trace_path(
                &persisted.task_id,
                persisted.sequence,
                &persisted.step_id,
                persisted.attempt,
            );
            let content = serde_json::to_vec_pretty(&persisted)
                .map_err(|error| format!("序列化 trace 失败: {error}"))?;
            match OpenOptions::new().write(true).create_new(true).open(&path) {
                Ok(mut file) => {
                    file.write_all(&content)
                        .and_then(|_| file.sync_all())
                        .map_err(|error| format!("写入 trace 失败 {}: {error}", path.display()))?;
                    return Ok((path, persisted.sequence));
                }
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                    sequence = sequence.saturating_add(1);
                }
                Err(error) => {
                    return Err(format!("写入 trace 失败 {}: {error}", path.display()));
                }
            }
        }
        Err("无法为 trace 分配唯一 sequence".to_string())
    }

    pub async fn load(&self, task_id: &str, step_id: &str) -> Result<TraceRecord, String> {
        self.replay(task_id)
            .await?
            .into_iter()
            .filter(|record| record.step_id == step_id)
            .max_by_key(|record| (record.sequence, record.attempt))
            .ok_or_else(|| format!("未找到 trace task={task_id} step={step_id}"))
    }

    pub async fn load_exact(&self, task_id: &str, sequence: u64) -> Result<TraceRecord, String> {
        self.replay(task_id)
            .await?
            .into_iter()
            .find(|record| record.sequence == sequence)
            .ok_or_else(|| format!("未找到 trace task={task_id} sequence={sequence}"))
    }

    pub async fn replay(&self, task_id: &str) -> Result<Vec<TraceRecord>, String> {
        let mut records = Vec::new();
        let mut entries = match fs::read_dir(&self.root).await {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(records),
            Err(error) => return Err(format!("读取 trace 目录失败: {error}")),
        };
        let prefix = format!("{}__", sanitize_trace_part(task_id));

        while let Some(entry) = entries
            .next_entry()
            .await
            .map_err(|error| format!("遍历 trace 目录失败: {error}"))?
        {
            let path = entry.path();
            let Some(file_name) = path.file_name().and_then(|value| value.to_str()) else {
                continue;
            };
            if !file_name.starts_with(&prefix)
                || file_name.ends_with(".golden.json")
                || path.extension().and_then(|value| value.to_str()) != Some("json")
            {
                continue;
            }
            let content = fs::read_to_string(&path)
                .await
                .map_err(|error| format!("读取 trace 失败 {}: {error}", path.display()))?;
            let record = serde_json::from_str::<TraceRecord>(&content)
                .map_err(|error| format!("解析 trace 失败 {}: {error}", path.display()))?;
            if record.task_id == task_id {
                records.push(record);
            }
        }

        records.sort_by(|left, right| {
            (left.sequence, left.attempt, &left.step_id).cmp(&(
                right.sequence,
                right.attempt,
                &right.step_id,
            ))
        });
        Ok(records)
    }

    pub async fn replay_run(
        &self,
        task_id: &str,
        run_id: &str,
    ) -> Result<Vec<TraceRecord>, String> {
        Ok(self
            .replay(task_id)
            .await?
            .into_iter()
            .filter(|record| record.run_id.as_deref() == Some(run_id))
            .collect())
    }

    pub async fn golden(&self, task_id: &str) -> Result<GoldenTrace, String> {
        let records = self
            .replay(task_id)
            .await?
            .into_iter()
            .map(|record| record.golden_record())
            .collect();
        Ok(GoldenTrace {
            schema_version: GOLDEN_TRACE_SCHEMA_VERSION,
            task_id: task_id.to_string(),
            records,
        })
    }

    /// Build a deterministic Golden for one execution. Persisted sequence is
    /// task-global, so it is normalized to run-local order before comparison.
    /// The volatile run_id is intentionally not part of GoldenTrace.
    pub async fn golden_run(&self, task_id: &str, run_id: &str) -> Result<GoldenTrace, String> {
        let records = self
            .replay_run(task_id, run_id)
            .await?
            .into_iter()
            .enumerate()
            .map(|(index, record)| {
                let mut golden = record.golden_record();
                golden.sequence = index as u64 + 1;
                golden
            })
            .collect();
        Ok(GoldenTrace {
            schema_version: GOLDEN_TRACE_SCHEMA_VERSION,
            task_id: task_id.to_string(),
            records,
        })
    }

    pub async fn write_golden(&self, task_id: &str, path: impl AsRef<Path>) -> Result<(), String> {
        let golden = self.golden(task_id).await?;
        let content = serde_json::to_vec_pretty(&golden)
            .map_err(|error| format!("序列化 golden trace 失败: {error}"))?;
        fs::write(path.as_ref(), content).await.map_err(|error| {
            format!(
                "写入 golden trace 失败 {}: {error}",
                path.as_ref().display()
            )
        })
    }

    pub async fn write_golden_run(
        &self,
        task_id: &str,
        run_id: &str,
        path: impl AsRef<Path>,
    ) -> Result<(), String> {
        let golden = self.golden_run(task_id, run_id).await?;
        let content = serde_json::to_vec_pretty(&golden)
            .map_err(|error| format!("序列化 golden trace 失败: {error}"))?;
        fs::write(path.as_ref(), content).await.map_err(|error| {
            format!(
                "写入 golden trace 失败 {}: {error}",
                path.as_ref().display()
            )
        })
    }

    pub async fn compare_golden(
        &self,
        task_id: &str,
        expected_path: impl AsRef<Path>,
    ) -> Result<GoldenTraceComparison, String> {
        let expected_content =
            fs::read_to_string(expected_path.as_ref())
                .await
                .map_err(|error| {
                    format!(
                        "读取 golden trace 失败 {}: {error}",
                        expected_path.as_ref().display()
                    )
                })?;
        let expected: GoldenTrace = serde_json::from_str(&expected_content)
            .map_err(|error| format!("解析 golden trace 失败: {error}"))?;
        let actual = self.golden(task_id).await?;
        Ok(compare_golden_traces(&expected, &actual))
    }

    pub async fn compare_golden_run(
        &self,
        task_id: &str,
        run_id: &str,
        expected_path: impl AsRef<Path>,
    ) -> Result<GoldenTraceComparison, String> {
        let expected_content =
            fs::read_to_string(expected_path.as_ref())
                .await
                .map_err(|error| {
                    format!(
                        "读取 golden trace 失败 {}: {error}",
                        expected_path.as_ref().display()
                    )
                })?;
        let expected: GoldenTrace = serde_json::from_str(&expected_content)
            .map_err(|error| format!("解析 golden trace 失败: {error}"))?;
        let actual = self.golden_run(task_id, run_id).await?;
        Ok(compare_golden_traces(&expected, &actual))
    }

    async fn next_sequence(&self, task_id: &str) -> Result<u64, String> {
        Ok(self
            .replay(task_id)
            .await?
            .iter()
            .map(|record| record.sequence)
            .max()
            .unwrap_or(0)
            .saturating_add(1))
    }

    fn trace_path(&self, task_id: &str, sequence: u64, step_id: &str, attempt: u32) -> PathBuf {
        self.root.join(format!(
            "{}__{:020}__{}__attempt-{:04}.json",
            sanitize_trace_part(task_id),
            sequence,
            sanitize_trace_part(step_id),
            attempt.max(1),
        ))
    }
}

pub fn compare_golden_traces(
    expected: &GoldenTrace,
    actual: &GoldenTrace,
) -> GoldenTraceComparison {
    let mut differences = Vec::new();
    if expected.schema_version != actual.schema_version {
        differences.push(format!(
            "schemaVersion expected={} actual={}",
            expected.schema_version, actual.schema_version
        ));
    }
    if expected.task_id != actual.task_id {
        differences.push(format!(
            "taskId expected={} actual={}",
            expected.task_id, actual.task_id
        ));
    }
    if expected.records.len() != actual.records.len() {
        differences.push(format!(
            "recordCount expected={} actual={}",
            expected.records.len(),
            actual.records.len()
        ));
    }
    for index in 0..expected.records.len().max(actual.records.len()) {
        match (expected.records.get(index), actual.records.get(index)) {
            (Some(expected_record), Some(actual_record)) if expected_record != actual_record => {
                differences.push(format!(
                    "record[{index}] expected={} actual={}",
                    serde_json::to_string(expected_record).unwrap_or_default(),
                    serde_json::to_string(actual_record).unwrap_or_default()
                ));
            }
            (Some(_), None) => differences.push(format!("record[{index}] missing")),
            (None, Some(_)) => differences.push(format!("record[{index}] unexpected")),
            _ => {}
        }
    }
    GoldenTraceComparison {
        matches: differences.is_empty(),
        differences,
    }
}

pub fn digest_text(value: &str) -> String {
    format!("sha256:{:x}", Sha256::digest(value.as_bytes()))
}

/// Serialize JSON with recursively sorted object keys before hashing. This is
/// deliberately independent of construction/insertion order so traces from
/// different providers or serde map implementations share one identity.
pub fn canonical_json(value: &Value) -> String {
    serde_json::to_string(&canonicalize_json(value))
        .expect("serializing serde_json::Value cannot fail")
}

pub fn digest_json(value: &Value) -> String {
    digest_text(&canonical_json(value))
}

pub fn digest_tool_input(tool: &str, arguments: &Value) -> String {
    digest_json(&serde_json::json!({
        "tool": tool,
        "arguments": arguments,
    }))
}

pub fn digest_tool_output(content: &Value, stdout: &str, stderr: &str) -> String {
    digest_json(&serde_json::json!({
        "content": content,
        "stdout": stdout,
        "stderr": stderr,
    }))
}

fn canonicalize_json(value: &Value) -> Value {
    match value {
        Value::Array(values) => Value::Array(values.iter().map(canonicalize_json).collect()),
        Value::Object(values) => {
            let mut keys = values.keys().collect::<Vec<_>>();
            keys.sort_unstable();
            let mut canonical = Map::new();
            for key in keys {
                canonical.insert(key.clone(), canonicalize_json(&values[key]));
            }
            Value::Object(canonical)
        }
        _ => value.clone(),
    }
}

pub fn new_trace_run_id() -> String {
    format!("run-{:032x}", rand::random::<u128>())
}

fn parse_result_kind(value: &str) -> Option<TraceResultKind> {
    match value.trim().to_ascii_lowercase().as_str() {
        "success" => Some(TraceResultKind::Success),
        "partial" => Some(TraceResultKind::Partial),
        "blocked" => Some(TraceResultKind::Blocked),
        "error" => Some(TraceResultKind::Error),
        "canceled" | "cancelled" => Some(TraceResultKind::Canceled),
        _ => None,
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

fn legacy_trace_schema_version() -> u32 {
    1
}

fn default_attempt() -> u32 {
    1
}

fn default_event_name() -> String {
    "tool_called".to_string()
}

#[cfg(test)]
mod tests {
    use super::{
        canonical_json, digest_tool_input, digest_tool_output, TraceRecord, TraceRecorder,
        TraceResultKind,
    };
    use serde_json::json;
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
    fn recorder_preserves_duplicate_step_attempts_in_sequence_order() {
        let root = temp_trace_root();
        let recorder = TraceRecorder::new(&root);
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();

        runtime.block_on(async {
            let mut first = TraceRecord::tool_result(
                "task-a",
                "01",
                "cargo check",
                "first",
                "",
                "failed",
                7,
                false,
            );
            first.attempt = 1;
            recorder.record(&first).await.unwrap();
            let mut second = TraceRecord::tool_result(
                "task-a",
                "01",
                "cargo check",
                "second",
                "",
                "passed",
                9,
                true,
            );
            second.attempt = 2;
            recorder.record(&second).await.unwrap();

            let replayed = recorder.replay("task-a").await.unwrap();
            assert_eq!(replayed.len(), 2);
            assert_eq!(replayed[0].sequence, 1);
            assert_eq!(replayed[1].sequence, 2);
            assert_eq!(replayed[0].attempt, 1);
            assert_eq!(replayed[1].attempt, 2);
            assert!(!replayed[0].recorded_success());
            assert!(replayed[1].recorded_success());
        });
    }

    #[test]
    fn replay_never_infers_success_from_empty_stderr() {
        let legacy: TraceRecord = serde_json::from_value(serde_json::json!({
            "taskId": "legacy",
            "stepId": "step",
            "toolCall": "command",
            "stdout": "",
            "stderr": "",
            "verification": "blocked",
            "latencyMs": 1,
            "metadata": {}
        }))
        .unwrap();
        assert!(!legacy.recorded_success());
    }

    #[test]
    fn canonical_digests_ignore_object_insertion_order_but_cover_all_tool_io() {
        let left = json!({"nested": {"b": 2, "a": 1}, "z": true});
        let right: serde_json::Value =
            serde_json::from_str(r#"{"z":true,"nested":{"a":1,"b":2}}"#).unwrap();
        assert_eq!(canonical_json(&left), canonical_json(&right));
        assert_eq!(
            digest_tool_input("filesystem.read", &left),
            digest_tool_input("filesystem.read", &right)
        );
        assert_ne!(
            digest_tool_input("filesystem.read", &left),
            digest_tool_input("filesystem.write", &left)
        );
        assert_ne!(
            digest_tool_output(&json!({"bytes": 2}), "ok", ""),
            digest_tool_output(&json!({"bytes": 3}), "ok", "")
        );
        assert_ne!(
            digest_tool_output(&json!({"bytes": 2}), "ok", ""),
            digest_tool_output(&json!({"bytes": 2}), "changed", "")
        );
        assert_ne!(
            digest_tool_output(&json!({"bytes": 2}), "ok", ""),
            digest_tool_output(&json!({"bytes": 2}), "ok", "error")
        );
    }

    #[test]
    fn persisted_output_digest_includes_structured_output() {
        let root = temp_trace_root();
        let recorder = TraceRecorder::new(&root);
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();

        runtime.block_on(async {
            let mut trace = TraceRecord::tool_result(
                "structured",
                "step",
                "filesystem.read",
                "same",
                "",
                "passed",
                1,
                true,
            );
            trace.structured_output = json!({"path": "README.md", "bytes": 4});
            recorder.record(&trace).await.unwrap();
            let persisted = recorder.load("structured", "step").await.unwrap();
            assert_eq!(persisted.structured_output, trace.structured_output);
            assert_eq!(
                persisted.output_digest,
                digest_tool_output(&trace.structured_output, "same", "")
            );
        });
    }

    #[test]
    fn legacy_success_preserves_success_result_kind_when_rewritten() {
        let root = temp_trace_root();
        let recorder = TraceRecorder::new(&root);
        let legacy: TraceRecord = serde_json::from_value(serde_json::json!({
            "taskId": "legacy-success",
            "stepId": "step",
            "toolCall": "command",
            "stdout": "ok",
            "stderr": "",
            "verification": "passed",
            "latencyMs": 1,
            "metadata": {}
        }))
        .unwrap();
        assert!(legacy.recorded_success());
        assert_eq!(legacy.recorded_result_kind(), TraceResultKind::Success);

        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            recorder.record(&legacy).await.unwrap();
            let rewritten = recorder.load("legacy-success", "step").await.unwrap();
            assert_eq!(rewritten.schema_version, super::TRACE_SCHEMA_VERSION);
            assert!(rewritten.recorded_success());
            assert_eq!(rewritten.recorded_result_kind(), TraceResultKind::Success);
        });
    }

    #[test]
    fn run_scoped_golden_detects_terminal_outcome_without_mixing_task_history() {
        let root = temp_trace_root();
        let recorder = TraceRecorder::new(&root);
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();

        runtime.block_on(async {
            for (run_id, result_kind, reason) in [
                ("run-success", TraceResultKind::Success, "verified"),
                ("run-partial", TraceResultKind::Partial, "work remains"),
            ] {
                let mut tool = TraceRecord::tool_result(
                    "task-scoped",
                    "step",
                    "cargo check",
                    "ok",
                    "",
                    "passed",
                    1,
                    true,
                );
                tool.run_id = Some(run_id.to_string());
                recorder.record(&tool).await.unwrap();
                recorder
                    .record(&TraceRecord::conclusion(
                        "task-scoped",
                        run_id,
                        result_kind,
                        reason,
                        reason,
                        Some("step"),
                    ))
                    .await
                    .unwrap();
            }

            let success = recorder
                .golden_run("task-scoped", "run-success")
                .await
                .unwrap();
            let partial = recorder
                .golden_run("task-scoped", "run-partial")
                .await
                .unwrap();
            assert_eq!(success.records.len(), 2);
            assert_eq!(partial.records.len(), 2);
            assert_eq!(success.records[0], partial.records[0]);
            assert_ne!(success.records[1], partial.records[1]);
            assert_eq!(success.records[0].sequence, 1);
            assert_eq!(partial.records[0].sequence, 1);
            assert_eq!(
                recorder
                    .replay_run("task-scoped", "run-success")
                    .await
                    .unwrap()
                    .len(),
                2
            );
        });
    }

    #[test]
    fn golden_comparison_detects_semantic_drift() {
        let root = temp_trace_root();
        let recorder = TraceRecorder::new(&root);
        let golden_path = root.join("expected.golden.json");
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();

        runtime.block_on(async {
            recorder
                .record(&TraceRecord::tool_result(
                    "task-golden",
                    "01",
                    "cargo check",
                    "ok",
                    "",
                    "passed",
                    1,
                    true,
                ))
                .await
                .unwrap();
            recorder
                .write_golden("task-golden", &golden_path)
                .await
                .unwrap();
            assert!(
                recorder
                    .compare_golden("task-golden", &golden_path)
                    .await
                    .unwrap()
                    .matches
            );

            let mut drift = TraceRecord::tool_result(
                "task-golden",
                "02",
                "cargo test",
                "",
                "denied",
                "blocked",
                1,
                false,
            );
            drift.result_kind = TraceResultKind::Blocked;
            recorder.record(&drift).await.unwrap();
            let comparison = recorder
                .compare_golden("task-golden", &golden_path)
                .await
                .unwrap();
            assert!(!comparison.matches);
            assert!(comparison
                .differences
                .iter()
                .any(|difference| difference.contains("recordCount")));
        });
    }
}
