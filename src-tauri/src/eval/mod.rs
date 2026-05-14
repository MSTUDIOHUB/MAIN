use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use walkdir::WalkDir;

const BENCHMARK_CATEGORIES: [&str; 4] = ["bugfix", "refactor", "planning", "long_horizon"];

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
        let cases = load_eval_cases(&self.benchmark_root)?;
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
                0
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

fn load_eval_cases(root: &Path) -> Result<Vec<EvalCaseResult>, String> {
    let mut cases = Vec::new();
    if !root.exists() {
        return Ok(cases);
    }

    for entry in WalkDir::new(root).min_depth(2).max_depth(2) {
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => continue,
        };
        let path = entry.path();
        if !entry.file_type().is_file()
            || path.extension().and_then(|extension| extension.to_str()) != Some("json")
        {
            continue;
        }
        let content = fs::read_to_string(path)
            .map_err(|error| format!("读取 eval case 失败 {}: {error}", path.display()))?;
        let mut case = serde_json::from_str::<EvalCaseResult>(&content)
            .map_err(|error| format!("解析 eval case 失败 {}: {error}", path.display()))?;
        if case.category.trim().is_empty() {
            case.category = path
                .parent()
                .and_then(|parent| parent.file_name())
                .and_then(|name| name.to_str())
                .unwrap_or("unknown")
                .to_string();
        }
        cases.push(case);
    }

    cases.sort_by(|left, right| left.id.cmp(&right.id));
    Ok(cases)
}

fn aggregate_report(root: &Path, cases: Vec<EvalCaseResult>) -> EvalReport {
    let mut by_category: BTreeMap<String, Vec<EvalCaseResult>> = BTreeMap::new();
    for category in BENCHMARK_CATEGORIES {
        by_category.entry(category.to_string()).or_default();
    }
    for case in cases {
        by_category
            .entry(case.category.clone())
            .or_default()
            .push(case);
    }

    let flattened = by_category
        .values()
        .flatten()
        .cloned()
        .collect::<Vec<EvalCaseResult>>();
    let categories = by_category
        .into_iter()
        .map(|(category, cases)| category_report(category, &cases))
        .collect::<Vec<_>>();

    let total = totals(&flattened);
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
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_benchmark() -> std::path::PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("main-eval-{unique}"));
        fs::create_dir_all(root.join("bugfix")).unwrap();
        root
    }

    #[test]
    fn eval_harness_aggregates_required_metrics() {
        let root = temp_benchmark();
        fs::write(
            root.join("bugfix").join("case.json"),
            r#"{
  "id": "case",
  "category": "bugfix",
  "success": true,
  "retries": 1,
  "hallucinations": 0,
  "latencyMs": 200,
  "toolCalls": 4
}"#,
        )
        .unwrap();

        let report = EvalHarness::new(&root).run().unwrap();
        assert_eq!(report.total_cases, 1);
        assert_eq!(report.success_rate, 1.0);
        assert_eq!(report.retry_rate, 1.0);
        assert_eq!(report.hallucination_rate, 0.0);
        assert_eq!(report.avg_latency, 200.0);
        assert_eq!(report.avg_tool_calls, 4.0);
        assert!(root.join("long_horizon").exists());
    }
}
