use crate::harness::tracing::TraceResultKind;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use walkdir::WalkDir;

const BENCHMARK_CATEGORIES: [&str; 4] = ["bugfix", "refactor", "planning", "long_horizon"];
const EVAL_FIXTURE_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EvalTraceRecord {
    pub sequence: u64,
    #[serde(default = "default_attempt")]
    pub attempt: u32,
    pub event_name: String,
    #[serde(default)]
    pub step_id: Option<String>,
    #[serde(default)]
    pub tool_call: String,
    pub success: bool,
    pub result_kind: TraceResultKind,
    #[serde(default)]
    pub latency_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EvalExpectation {
    pub result_kind: TraceResultKind,
    #[serde(default)]
    pub event_order: Vec<String>,
    #[serde(default)]
    pub required_tools: Vec<String>,
    /// Every observed tool must be in this exact allow-list. An explicit empty
    /// list represents a no-tool fixture; omitting the field would make a zero
    /// hallucination count mean "unknown" instead of evidence.
    pub allowed_tools: Vec<String>,
    #[serde(default)]
    pub max_retries: u64,
    #[serde(default)]
    pub max_tool_calls: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EvalFixture {
    pub schema_version: u32,
    pub id: String,
    pub category: String,
    pub trace: Vec<EvalTraceRecord>,
    pub expect: EvalExpectation,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EvalCaseResult {
    pub id: String,
    pub category: String,
    pub success: bool,
    pub retries: u64,
    pub hallucinations: u64,
    pub latency_ms: u64,
    pub tool_calls: u64,
    pub result_kind: TraceResultKind,
    pub failures: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EvalReport {
    pub generated_at_ms: u64,
    pub benchmark_root: String,
    pub total_cases: u64,
    pub success_rate: f64,
    pub retry_rate: f64,
    pub hallucination_rate: f64,
    pub avg_latency: f64,
    pub avg_tool_calls: f64,
    pub categories: Vec<CategoryEvalReport>,
    pub cases: Vec<EvalCaseResult>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CategoryEvalReport {
    pub category: String,
    pub total_cases: u64,
    pub success_rate: f64,
    pub retry_rate: f64,
    pub hallucination_rate: f64,
    pub avg_latency: f64,
    pub avg_tool_calls: f64,
}

#[derive(Debug, Clone)]
pub struct EvalHarness {
    benchmark_root: PathBuf,
}

impl EvalHarness {
    pub fn for_workspace(workspace: impl AsRef<Path>) -> Self {
        Self {
            benchmark_root: workspace.as_ref().join("benchmark"),
        }
    }

    pub fn new(benchmark_root: impl Into<PathBuf>) -> Self {
        Self {
            benchmark_root: benchmark_root.into(),
        }
    }

    pub fn run(&self) -> Result<EvalReport, String> {
        ensure_benchmark_tree(&self.benchmark_root)?;
        let fixtures = load_eval_fixtures(&self.benchmark_root)?;
        if fixtures.is_empty() {
            return Err(format!(
                "eval fixture 为空: {}",
                self.benchmark_root.display()
            ));
        }
        let cases = fixtures
            .into_iter()
            .map(evaluate_fixture)
            .collect::<Vec<_>>();
        Ok(aggregate_report(&self.benchmark_root, cases))
    }
}

pub fn run_cli(args: impl IntoIterator<Item = String>, workspace: impl AsRef<Path>) -> i32 {
    let args = args.into_iter().collect::<Vec<_>>();
    if args.first().map(String::as_str) != Some("eval") {
        eprintln!("usage: main eval");
        return 2;
    }

    match EvalHarness::for_workspace(workspace).run() {
        Ok(report) => match serde_json::to_string_pretty(&report) {
            Ok(json) => {
                println!("{json}");
                if report.cases.iter().all(|case| case.success) {
                    0
                } else {
                    1
                }
            }
            Err(error) => {
                eprintln!("failed to serialize eval report: {error}");
                1
            }
        },
        Err(error) => {
            eprintln!("eval failed: {error}");
            1
        }
    }
}

fn ensure_benchmark_tree(root: &Path) -> Result<(), String> {
    for category in BENCHMARK_CATEGORIES {
        fs::create_dir_all(root.join(category))
            .map_err(|error| format!("创建 benchmark/{category} 失败: {error}"))?;
    }
    Ok(())
}

fn load_eval_fixtures(root: &Path) -> Result<Vec<EvalFixture>, String> {
    let mut fixtures = Vec::new();
    let mut fixture_ids = BTreeSet::new();
    if !root.exists() {
        return Ok(fixtures);
    }

    for entry in WalkDir::new(root).min_depth(2).max_depth(2) {
        let entry = entry.map_err(|error| format!("遍历 eval fixture 失败: {error}"))?;
        let path = entry.path();
        if !entry.file_type().is_file()
            || path.extension().and_then(|extension| extension.to_str()) != Some("json")
        {
            continue;
        }
        let content = fs::read_to_string(path)
            .map_err(|error| format!("读取 eval fixture 失败 {}: {error}", path.display()))?;
        let mut fixture = serde_json::from_str::<EvalFixture>(&content)
            .map_err(|error| format!("解析 eval fixture 失败 {}: {error}", path.display()))?;
        if fixture.schema_version != EVAL_FIXTURE_SCHEMA_VERSION {
            return Err(format!(
                "eval fixture schemaVersion 不受支持 {}: expected={} actual={}",
                path.display(),
                EVAL_FIXTURE_SCHEMA_VERSION,
                fixture.schema_version
            ));
        }
        if fixture.id.trim().is_empty() {
            return Err(format!("eval fixture id 不能为空: {}", path.display()));
        }
        if !fixture_ids.insert(fixture.id.clone()) {
            return Err(format!(
                "eval fixture id 重复: {} ({})",
                fixture.id,
                path.display()
            ));
        }
        let path_category = path
            .parent()
            .and_then(|parent| parent.file_name())
            .and_then(|name| name.to_str())
            .unwrap_or("unknown");
        if fixture.category.trim().is_empty() {
            fixture.category = path_category.to_string();
        } else if fixture.category != path_category {
            return Err(format!(
                "eval fixture category 与目录不一致 {}: declared={} directory={path_category}",
                path.display(),
                fixture.category,
            ));
        }
        fixtures.push(fixture);
    }

    fixtures.sort_by(|left, right| left.id.cmp(&right.id));
    Ok(fixtures)
}

fn evaluate_fixture(mut fixture: EvalFixture) -> EvalCaseResult {
    fixture.trace.sort_by_key(|record| record.sequence);
    let mut failures = Vec::new();
    let mut seen_sequences = BTreeSet::new();
    for record in &fixture.trace {
        if record.sequence == 0 || !seen_sequences.insert(record.sequence) {
            failures.push(format!(
                "trace sequence 必须唯一且大于 0: {}",
                record.sequence
            ));
        }
        if record.attempt == 0 {
            failures.push(format!(
                "trace attempt 必须大于 0: sequence={}",
                record.sequence
            ));
        }
        if record.event_name == "tool_called" {
            if record
                .step_id
                .as_deref()
                .is_none_or(|step_id| step_id.trim().is_empty())
            {
                failures.push(format!(
                    "tool_called stepId 必须非空: sequence={}",
                    record.sequence
                ));
            }
            if record.tool_call.trim().is_empty() {
                failures.push(format!(
                    "tool_called toolCall 必须非空: sequence={}",
                    record.sequence
                ));
            }
        }
    }

    let terminal_indexes = fixture
        .trace
        .iter()
        .enumerate()
        .filter_map(|(index, record)| (record.event_name == "task_completed").then_some(index))
        .collect::<Vec<_>>();
    if terminal_indexes.len() != 1 {
        failures.push(format!(
            "trace 必须且只能包含一个 task_completed: actual={}",
            terminal_indexes.len()
        ));
    }
    if terminal_indexes.last().copied() != fixture.trace.len().checked_sub(1) {
        failures.push("task_completed 必须是 trace 最后一个事件".to_string());
    }
    if fixture
        .trace
        .last()
        .is_some_and(|record| record.event_name == "task_completed" && !record.success)
    {
        failures.push("task_completed 必须确认结论已成功发布".to_string());
    }

    let actual_result_kind = fixture
        .trace
        .last()
        .map(|record| record.result_kind)
        .unwrap_or(TraceResultKind::Error);
    if actual_result_kind != fixture.expect.result_kind {
        failures.push(format!(
            "resultKind expected={:?} actual={:?}",
            fixture.expect.result_kind, actual_result_kind
        ));
    }

    let event_order = fixture
        .trace
        .iter()
        .map(|record| record.event_name.clone())
        .collect::<Vec<_>>();
    if !fixture.expect.event_order.is_empty() && event_order != fixture.expect.event_order {
        failures.push(format!(
            "eventOrder expected={:?} actual={:?}",
            fixture.expect.event_order, event_order
        ));
    }

    let observed_tool_records = fixture
        .trace
        .iter()
        .filter(|record| record.event_name == "tool_called")
        .collect::<Vec<_>>();
    let observed_tools = observed_tool_records
        .iter()
        .map(|record| record.tool_call.as_str())
        .collect::<BTreeSet<_>>();
    for required in &fixture.expect.required_tools {
        if !observed_tools.contains(required.as_str()) {
            failures.push(format!("missing required tool: {required}"));
        }
    }

    let allowed_tools = fixture
        .expect
        .allowed_tools
        .iter()
        .map(String::as_str)
        .collect::<BTreeSet<_>>();
    let unexpected_tools = observed_tool_records
        .iter()
        .filter(|record| !allowed_tools.contains(record.tool_call.as_str()))
        .map(|record| record.tool_call.as_str())
        .collect::<Vec<_>>();
    for unexpected in &unexpected_tools {
        failures.push(format!("unexpected tool: {unexpected}"));
    }

    // Attempts belong to a logical step, not a tool name. The same tool can be
    // used by independent steps and each step may have its own retry chain.
    let mut step_results = BTreeMap::<String, (String, u32, bool)>::new();
    for record in &observed_tool_records {
        let Some(step_id) = record
            .step_id
            .as_deref()
            .map(str::trim)
            .filter(|step_id| !step_id.is_empty())
        else {
            continue;
        };
        match step_results.get_mut(step_id) {
            Some((tool_call, previous_attempt, final_success)) => {
                if tool_call != &record.tool_call {
                    failures.push(format!(
                        "trace step toolCall changed: step={step_id} expected={tool_call} actual={}",
                        record.tool_call
                    ));
                }
                let expected_attempt = previous_attempt.saturating_add(1);
                if record.attempt != expected_attempt {
                    failures.push(format!(
                        "trace attempt 必须按 stepId 从 1 连续递增: step={step_id} expected={expected_attempt} actual={}",
                        record.attempt
                    ));
                }
                *previous_attempt = record.attempt;
                *final_success = record.success;
            }
            None => {
                if record.attempt != 1 {
                    failures.push(format!(
                        "trace step 首次 attempt 必须为 1: step={step_id} actual={}",
                        record.attempt
                    ));
                }
                step_results.insert(
                    step_id.to_string(),
                    (record.tool_call.clone(), record.attempt, record.success),
                );
            }
        }
    }

    if fixture.expect.result_kind == TraceResultKind::Success {
        for (step_id, (tool, _, success)) in &step_results {
            if !success {
                failures.push(format!(
                    "unrecovered tool failure before success: step={step_id} tool={tool}"
                ));
            }
        }
    }

    let retries = step_results
        .values()
        .map(|(_, attempt, _)| attempt.saturating_sub(1) as u64)
        .sum::<u64>();
    if retries > fixture.expect.max_retries {
        failures.push(format!(
            "retry budget exceeded: max={} actual={retries}",
            fixture.expect.max_retries
        ));
    }
    let tool_calls = fixture
        .trace
        .iter()
        .filter(|record| record.event_name == "tool_called")
        .count() as u64;
    if let Some(max_tool_calls) = fixture.expect.max_tool_calls {
        if tool_calls > max_tool_calls {
            failures.push(format!(
                "tool-call budget exceeded: max={max_tool_calls} actual={tool_calls}"
            ));
        }
    }
    let latency_ms = fixture
        .trace
        .iter()
        .map(|record| record.latency_ms)
        .sum::<u64>();
    let hallucinations = unexpected_tools.len() as u64;

    EvalCaseResult {
        id: fixture.id,
        category: fixture.category,
        success: failures.is_empty(),
        retries,
        hallucinations,
        latency_ms,
        tool_calls,
        result_kind: actual_result_kind,
        failures,
    }
}

fn aggregate_report(root: &Path, cases: Vec<EvalCaseResult>) -> EvalReport {
    let mut by_category: BTreeMap<String, Vec<EvalCaseResult>> = BTreeMap::new();
    for category in BENCHMARK_CATEGORIES {
        by_category.entry(category.to_string()).or_default();
    }
    for case in &cases {
        by_category
            .entry(case.category.clone())
            .or_default()
            .push(case.clone());
    }
    let categories = by_category
        .into_iter()
        .map(|(category, cases)| category_report(category, &cases))
        .collect::<Vec<_>>();
    let total = totals(&cases);
    EvalReport {
        generated_at_ms: now_millis(),
        benchmark_root: root.to_string_lossy().to_string(),
        total_cases: total.total_cases,
        success_rate: total.success_rate,
        retry_rate: total.retry_rate,
        hallucination_rate: total.hallucination_rate,
        avg_latency: total.avg_latency,
        avg_tool_calls: total.avg_tool_calls,
        categories,
        cases,
    }
}

fn category_report(category: String, cases: &[EvalCaseResult]) -> CategoryEvalReport {
    let total = totals(cases);
    CategoryEvalReport {
        category,
        total_cases: total.total_cases,
        success_rate: total.success_rate,
        retry_rate: total.retry_rate,
        hallucination_rate: total.hallucination_rate,
        avg_latency: total.avg_latency,
        avg_tool_calls: total.avg_tool_calls,
    }
}

#[derive(Debug, Clone, Copy)]
struct MetricTotals {
    total_cases: u64,
    success_rate: f64,
    retry_rate: f64,
    hallucination_rate: f64,
    avg_latency: f64,
    avg_tool_calls: f64,
}

fn totals(cases: &[EvalCaseResult]) -> MetricTotals {
    let total_cases = cases.len() as u64;
    if total_cases == 0 {
        return MetricTotals {
            total_cases: 0,
            success_rate: 0.0,
            retry_rate: 0.0,
            hallucination_rate: 0.0,
            avg_latency: 0.0,
            avg_tool_calls: 0.0,
        };
    }

    let denominator = total_cases as f64;
    MetricTotals {
        total_cases,
        success_rate: rounded_rate(
            cases.iter().filter(|case| case.success).count() as f64 / denominator,
        ),
        retry_rate: rounded_rate(
            cases.iter().map(|case| case.retries).sum::<u64>() as f64 / denominator,
        ),
        hallucination_rate: rounded_rate(
            cases.iter().map(|case| case.hallucinations).sum::<u64>() as f64 / denominator,
        ),
        avg_latency: rounded_rate(
            cases.iter().map(|case| case.latency_ms).sum::<u64>() as f64 / denominator,
        ),
        avg_tool_calls: rounded_rate(
            cases.iter().map(|case| case.tool_calls).sum::<u64>() as f64 / denominator,
        ),
    }
}

fn rounded_rate(value: f64) -> f64 {
    (value * 10_000.0).round() / 10_000.0
}

fn default_attempt() -> u32 {
    1
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_else(|_| Duration::from_secs(0))
        .as_millis() as u64
}

#[cfg(test)]
mod tests {
    use super::EvalHarness;
    use std::fs;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static TEMP_BENCHMARK_SEQUENCE: AtomicU64 = AtomicU64::new(1);

    fn temp_benchmark() -> std::path::PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let sequence = TEMP_BENCHMARK_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let root = std::env::temp_dir().join(format!(
            "main-eval-{}-{unique}-{sequence}",
            std::process::id()
        ));
        fs::create_dir_all(root.join("bugfix")).unwrap();
        root
    }

    #[test]
    fn eval_harness_derives_metrics_from_trace_and_golden_expectations() {
        let root = temp_benchmark();
        fs::write(
            root.join("bugfix").join("case.json"),
            r#"{
  "schemaVersion": 1,
  "id": "case",
  "category": "bugfix",
  "trace": [
    {"sequence": 1, "attempt": 1, "eventName": "tool_called", "stepId": "test", "toolCall": "cargo test", "success": true, "resultKind": "success", "latencyMs": 200},
    {"sequence": 2, "attempt": 1, "eventName": "task_completed", "success": true, "resultKind": "success", "latencyMs": 0}
  ],
  "expect": {
    "resultKind": "success",
    "eventOrder": ["tool_called", "task_completed"],
    "requiredTools": ["cargo test"],
    "allowedTools": ["cargo test"],
    "maxRetries": 0,
    "maxToolCalls": 1
  }
}"#,
        )
        .unwrap();

        let report = EvalHarness::new(&root).run().unwrap();
        assert_eq!(report.total_cases, 1);
        assert_eq!(report.success_rate, 1.0);
        assert_eq!(report.retry_rate, 0.0);
        assert_eq!(report.hallucination_rate, 0.0);
        assert_eq!(report.avg_latency, 200.0);
        assert_eq!(report.avg_tool_calls, 1.0);
        assert!(report.cases[0].failures.is_empty());
        assert!(root.join("long_horizon").exists());
    }

    #[test]
    fn eval_harness_fails_semantic_drift_instead_of_trusting_success_input() {
        let root = temp_benchmark();
        fs::write(
            root.join("bugfix").join("drift.json"),
            r#"{
  "schemaVersion": 1,
  "id": "drift",
  "category": "bugfix",
  "trace": [
    {"sequence": 1, "attempt": 2, "eventName": "tool_called", "stepId": "test", "toolCall": "cargo test", "success": false, "resultKind": "error", "latencyMs": 1},
    {"sequence": 2, "attempt": 1, "eventName": "task_completed", "success": false, "resultKind": "error", "latencyMs": 0}
  ],
  "expect": {
    "resultKind": "success",
    "eventOrder": ["tool_called", "task_completed"],
    "allowedTools": ["cargo test"],
    "maxRetries": 0
  }
}"#,
        )
        .unwrap();

        let report = EvalHarness::new(&root).run().unwrap();
        assert_eq!(report.success_rate, 0.0);
        assert!(report.cases[0]
            .failures
            .iter()
            .any(|failure| failure.contains("resultKind")));
        assert!(report.cases[0]
            .failures
            .iter()
            .any(|failure| failure.contains("retry budget")));
    }

    #[test]
    fn eval_harness_requires_an_explicit_allowed_tool_set() {
        let root = temp_benchmark();
        fs::write(
            root.join("bugfix").join("missing-allowlist.json"),
            r#"{
  "schemaVersion": 1,
  "id": "missing-allowlist",
  "category": "bugfix",
  "trace": [
    {"sequence": 1, "attempt": 1, "eventName": "task_completed", "success": true, "resultKind": "blocked"}
  ],
  "expect": {"resultKind": "blocked"}
}"#,
        )
        .unwrap();

        let error = EvalHarness::new(&root)
            .run()
            .expect_err("missing allowedTools must not produce a fake zero metric");
        assert!(error.contains("allowedTools"));
    }

    #[test]
    fn eval_retries_are_counted_per_step_even_when_tools_match() {
        let root = temp_benchmark();
        fs::write(
            root.join("bugfix").join("step-retries.json"),
            r#"{
  "schemaVersion": 1,
  "id": "step-retries",
  "category": "bugfix",
  "trace": [
    {"sequence": 1, "attempt": 1, "eventName": "tool_called", "stepId": "first", "toolCall": "cargo test", "success": false, "resultKind": "error"},
    {"sequence": 2, "attempt": 2, "eventName": "tool_called", "stepId": "first", "toolCall": "cargo test", "success": true, "resultKind": "success"},
    {"sequence": 3, "attempt": 1, "eventName": "tool_called", "stepId": "second", "toolCall": "cargo test", "success": false, "resultKind": "error"},
    {"sequence": 4, "attempt": 2, "eventName": "tool_called", "stepId": "second", "toolCall": "cargo test", "success": true, "resultKind": "success"},
    {"sequence": 5, "attempt": 1, "eventName": "task_completed", "success": true, "resultKind": "success"}
  ],
  "expect": {
    "resultKind": "success",
    "allowedTools": ["cargo test"],
    "maxRetries": 2,
    "maxToolCalls": 4
  }
}"#,
        )
        .unwrap();

        let report = EvalHarness::new(&root).run().unwrap();
        assert!(report.cases[0].success);
        assert_eq!(report.cases[0].retries, 2);
    }

    #[test]
    fn another_same_named_tool_step_cannot_mask_an_unrecovered_failure() {
        let root = temp_benchmark();
        fs::write(
            root.join("bugfix").join("step-recovery.json"),
            r#"{
  "schemaVersion": 1,
  "id": "step-recovery",
  "category": "bugfix",
  "trace": [
    {"sequence": 1, "attempt": 1, "eventName": "tool_called", "stepId": "failed", "toolCall": "cargo test", "success": false, "resultKind": "error"},
    {"sequence": 2, "attempt": 1, "eventName": "tool_called", "stepId": "other", "toolCall": "cargo test", "success": true, "resultKind": "success"},
    {"sequence": 3, "attempt": 1, "eventName": "task_completed", "success": true, "resultKind": "success"}
  ],
  "expect": {
    "resultKind": "success",
    "allowedTools": ["cargo test"],
    "maxRetries": 0
  }
}"#,
        )
        .unwrap();

        let report = EvalHarness::new(&root).run().unwrap();
        assert!(!report.cases[0].success);
        assert!(report.cases[0]
            .failures
            .iter()
            .any(|failure| failure.contains("step=failed")));
    }
}
