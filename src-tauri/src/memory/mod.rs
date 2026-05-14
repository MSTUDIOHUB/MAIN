use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use walkdir::WalkDir;

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionMemory {
    pub build_flow: Vec<BuildFlowStep>,
    pub package_manager: Option<String>,
    pub repo_structure: Vec<String>,
    pub previous_failures: Vec<FailureRecord>,
    pub reflections: Vec<ReflectionRecord>,
    pub updated_at_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildFlowStep {
    pub command: String,
    pub purpose: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FailureRecord {
    pub step_id: String,
    pub tool_call: String,
    pub stderr: String,
    pub verification: String,
    pub timestamp_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReflectionRecord {
    pub failure_step_id: String,
    pub summary: String,
    pub adjusted_strategy: String,
    pub avoid_repeating: Vec<String>,
    pub timestamp_ms: u64,
}

#[derive(Debug, Clone)]
pub struct SessionMemoryStore {
    path: PathBuf,
}

impl SessionMemoryStore {
    pub fn for_workspace(workspace: impl AsRef<Path>) -> Self {
        Self {
            path: workspace
                .as_ref()
                .join(".MAIN")
                .join("memory")
                .join("session_memory.json"),
        }
    }

    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into() }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub async fn load(&self) -> Result<SessionMemory, String> {
        let content = match tokio::fs::read_to_string(&self.path).await {
            Ok(content) => content,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(SessionMemory::default());
            }
            Err(error) => {
                return Err(format!(
                    "读取 session memory 失败 {}: {error}",
                    self.path.display()
                ));
            }
        };
        serde_json::from_str(&content)
            .map_err(|error| format!("解析 session memory 失败 {}: {error}", self.path.display()))
    }

    pub async fn save(&self, memory: &SessionMemory) -> Result<(), String> {
        if let Some(parent) = self.path.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|error| format!("创建 session memory 目录失败: {error}"))?;
        }
        let json = serde_json::to_vec_pretty(memory)
            .map_err(|error| format!("序列化 session memory 失败: {error}"))?;
        tokio::fs::write(&self.path, json)
            .await
            .map_err(|error| format!("写入 session memory 失败 {}: {error}", self.path.display()))
    }

    pub async fn profile_repository(
        &self,
        workspace: impl AsRef<Path>,
    ) -> Result<SessionMemory, String> {
        let workspace = workspace.as_ref().to_path_buf();
        let mut memory = self.load().await?;
        let profile = tokio::task::spawn_blocking(move || {
            RepositoryMemoryProfile::from_workspace(&workspace)
        })
        .await
        .map_err(|error| format!("repository memory profile task failed: {error}"))??;
        memory.build_flow = profile.build_flow;
        memory.package_manager = profile.package_manager;
        memory.repo_structure = profile.repo_structure;
        memory.updated_at_ms = now_millis();
        self.save(&memory).await?;
        Ok(memory)
    }

    pub async fn record_failure(
        &self,
        failure: FailureRecord,
    ) -> Result<(SessionMemory, ReflectionRecord), String> {
        let mut memory = self.load().await?;
        let reflection = ReflectionEngine::reflect(&failure, &memory);
        memory.previous_failures.push(failure);
        memory.reflections.push(reflection.clone());
        memory.updated_at_ms = now_millis();
        self.save(&memory).await?;
        Ok((memory, reflection))
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct RepositoryMemoryProfile {
    build_flow: Vec<BuildFlowStep>,
    package_manager: Option<String>,
    repo_structure: Vec<String>,
}

impl RepositoryMemoryProfile {
    fn from_workspace(workspace: &Path) -> Result<Self, String> {
        let mut package_managers = Vec::new();
        let mut build_flow = Vec::new();

        if workspace.join("package-lock.json").exists() {
            package_managers.push("npm".to_string());
            build_flow.push(BuildFlowStep {
                command: "npm install".to_string(),
                purpose: "install JavaScript dependencies".to_string(),
            });
        } else if workspace.join("pnpm-lock.yaml").exists() {
            package_managers.push("pnpm".to_string());
            build_flow.push(BuildFlowStep {
                command: "pnpm install".to_string(),
                purpose: "install JavaScript dependencies".to_string(),
            });
        } else if workspace.join("yarn.lock").exists() {
            package_managers.push("yarn".to_string());
            build_flow.push(BuildFlowStep {
                command: "yarn install".to_string(),
                purpose: "install JavaScript dependencies".to_string(),
            });
        }

        if workspace.join("package.json").exists() {
            build_flow.push(BuildFlowStep {
                command: "npm run build".to_string(),
                purpose: "build frontend assets".to_string(),
            });
        }
        if workspace.join("src-tauri").join("Cargo.toml").exists() {
            package_managers.push("cargo".to_string());
            build_flow.push(BuildFlowStep {
                command: "cargo check".to_string(),
                purpose: "validate Rust backend".to_string(),
            });
            build_flow.push(BuildFlowStep {
                command: "cargo test --lib".to_string(),
                purpose: "run Rust unit tests".to_string(),
            });
        } else if workspace.join("Cargo.toml").exists() {
            package_managers.push("cargo".to_string());
            build_flow.push(BuildFlowStep {
                command: "cargo check".to_string(),
                purpose: "validate Rust package".to_string(),
            });
        }

        package_managers.sort();
        package_managers.dedup();

        Ok(Self {
            build_flow,
            package_manager: if package_managers.is_empty() {
                None
            } else {
                Some(package_managers.join("+"))
            },
            repo_structure: repo_structure(workspace),
        })
    }
}

pub struct ReflectionEngine;

impl ReflectionEngine {
    pub fn reflect(failure: &FailureRecord, memory: &SessionMemory) -> ReflectionRecord {
        let repeated = memory
            .previous_failures
            .iter()
            .any(|previous| previous.tool_call == failure.tool_call);
        let lower = format!(
            "{}\n{}",
            failure.stderr.to_ascii_lowercase(),
            failure.verification.to_ascii_lowercase()
        );
        let adjusted_strategy = if lower.contains("permission") || lower.contains("权限") {
            "Re-check permissions before re-running the command; use an allowed verifier or request an approval path.".to_string()
        } else if lower.contains("timeout") || lower.contains("超时") {
            "Reduce the command scope or increase timeout after confirming the process is expected to run long.".to_string()
        } else if lower.contains("not found") || lower.contains("no such file") {
            "Rebuild repo grounding from the index before retrying; confirm paths and generated files exist.".to_string()
        } else if repeated {
            "Change the approach before retrying because the same tool call already failed previously.".to_string()
        } else {
            "Inspect stderr and repository context, then retry with a narrower verification target."
                .to_string()
        };

        let mut avoid_repeating = vec![failure.tool_call.clone()];
        if repeated {
            avoid_repeating.push("same failing command without a changed hypothesis".to_string());
        }

        ReflectionRecord {
            failure_step_id: failure.step_id.clone(),
            summary: format!(
                "Step {} failed while running `{}`: {}",
                failure.step_id, failure.tool_call, failure.verification
            ),
            adjusted_strategy,
            avoid_repeating,
            timestamp_ms: now_millis(),
        }
    }
}

fn repo_structure(workspace: &Path) -> Vec<String> {
    let mut entries = Vec::new();
    for entry in WalkDir::new(workspace).min_depth(1).max_depth(2) {
        let Ok(entry) = entry else {
            continue;
        };
        let path = entry.path();
        if !should_include_structure_path(path) {
            continue;
        }
        let relative = path
            .strip_prefix(workspace)
            .unwrap_or(path)
            .to_string_lossy()
            .replace('\\', "/");
        entries.push(if entry.file_type().is_dir() {
            format!("{relative}/")
        } else {
            relative
        });
        if entries.len() >= 120 {
            break;
        }
    }
    entries.sort();
    entries
}

fn should_include_structure_path(path: &Path) -> bool {
    let normalized = path.to_string_lossy().replace('\\', "/");
    ![
        ".git",
        "node_modules",
        "dist",
        "target",
        ".MAIN/traces",
        "test-results",
        "playwright-report",
    ]
    .iter()
    .any(|part| normalized.contains(part))
}

pub fn failure_record(
    step_id: impl Into<String>,
    tool_call: impl Into<String>,
    stderr: impl Into<String>,
    verification: impl Into<String>,
) -> FailureRecord {
    FailureRecord {
        step_id: step_id.into(),
        tool_call: tool_call.into(),
        stderr: stderr.into(),
        verification: verification.into(),
        timestamp_ms: now_millis(),
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
    use super::{failure_record, SessionMemoryStore};
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_workspace(name: &str) -> std::path::PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("main-memory-{name}-{unique}"));
        fs::create_dir_all(root.join("src-tauri")).unwrap();
        root
    }

    #[test]
    fn memory_profiles_repo_and_records_reflection() {
        let root = temp_workspace("profile");
        fs::write(root.join("package.json"), "{}").unwrap();
        fs::write(root.join("package-lock.json"), "{}").unwrap();
        fs::write(
            root.join("src-tauri").join("Cargo.toml"),
            "[package]\nname = \"x\"",
        )
        .unwrap();
        let store = SessionMemoryStore::new(root.join(".MAIN/memory/session_memory.json"));

        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            let memory = store.profile_repository(&root).await.unwrap();
            assert_eq!(memory.package_manager.as_deref(), Some("cargo+npm"));
            assert!(memory
                .build_flow
                .iter()
                .any(|step| step.command == "cargo check"));

            let (_memory, reflection) = store
                .record_failure(failure_record(
                    "step-1",
                    "cargo check",
                    "error: no such file",
                    "verification failed",
                ))
                .await
                .unwrap();
            assert!(reflection.adjusted_strategy.contains("repo grounding"));
        });
    }
}
