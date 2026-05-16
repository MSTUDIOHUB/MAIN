use crate::harness::permissions::PermissionGuard;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};
use tokio::process::Command;
use tokio::time::timeout;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VerificationKind {
    CargoCheck,
    CargoTest,
    NpmRunBuild,
    NpmRunLint,
}

impl VerificationKind {
    pub fn command(&self) -> &'static str {
        match self {
            Self::CargoCheck => "cargo check",
            Self::CargoTest => "cargo test",
            Self::NpmRunBuild => "npm run build",
            Self::NpmRunLint => "npm run lint",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VerificationResult {
    pub command: String,
    pub success: bool,
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub timed_out: bool,
    pub duration_ms: u128,
}

#[derive(Debug, Clone)]
pub struct Verifier {
    workspace_root: PathBuf,
    permission_guard: PermissionGuard,
}

impl Verifier {
    pub fn for_workspace(workspace: impl AsRef<Path>) -> Result<Self, String> {
        let workspace_root = workspace.as_ref().to_path_buf();
        let permission_guard =
            PermissionGuard::from_workspace(&workspace_root).map_err(|error| error.to_string())?;
        Ok(Self {
            workspace_root,
            permission_guard,
        })
    }

    pub fn new(workspace_root: impl Into<PathBuf>, permission_guard: PermissionGuard) -> Self {
        Self {
            workspace_root: workspace_root.into(),
            permission_guard,
        }
    }

    pub async fn verify(
        &self,
        kind: VerificationKind,
        timeout_duration: Duration,
    ) -> Result<VerificationResult, String> {
        self.verify_command(kind.command(), timeout_duration).await
    }

    pub async fn verify_command(
        &self,
        command: &str,
        timeout_duration: Duration,
    ) -> Result<VerificationResult, String> {
        self.permission_guard
            .validate(command)
            .map_err(|error| error.to_string())?;

        let started_at = Instant::now();
        let mut process = build_shell_command(command);
        process
            .current_dir(&self.workspace_root)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);

        let output = match timeout(timeout_duration, process.output()).await {
            Ok(output) => output.map_err(|error| format!("执行验证命令失败: {error}"))?,
            Err(_) => {
                return Ok(VerificationResult {
                    command: command.to_string(),
                    success: false,
                    exit_code: None,
                    stdout: String::new(),
                    stderr: format!("验证命令超时: {}ms", timeout_duration.as_millis()),
                    timed_out: true,
                    duration_ms: started_at.elapsed().as_millis(),
                })
            }
        };

        Ok(VerificationResult {
            command: command.to_string(),
            success: output.status.success(),
            exit_code: output.status.code(),
            stdout: String::from_utf8_lossy(&output.stdout).to_string(),
            stderr: String::from_utf8_lossy(&output.stderr).to_string(),
            timed_out: false,
            duration_ms: started_at.elapsed().as_millis(),
        })
    }

    pub async fn verify_all(
        &self,
        kinds: &[VerificationKind],
        timeout_duration: Duration,
    ) -> Result<Vec<VerificationResult>, String> {
        let mut results = Vec::with_capacity(kinds.len());
        for kind in kinds {
            results.push(self.verify(kind.clone(), timeout_duration).await?);
        }
        Ok(results)
    }
}

fn build_shell_command(command: &str) -> Command {
    if cfg!(target_os = "windows") {
        let mut process = Command::new("cmd");
        process.args(["/C", command]);
        process
    } else {
        let mut process = Command::new("/bin/sh");
        process.args(["-lc", command]);
        process
    }
}

#[cfg(test)]
mod tests {
    use super::{VerificationKind, Verifier};
    use crate::harness::permissions::{PermissionConfig, PermissionGuard};
    use std::time::Duration;

    #[test]
    fn verifier_rejects_commands_outside_permissions() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            let verifier = Verifier::new(
                std::env::temp_dir(),
                PermissionGuard::new(PermissionConfig::default_runtime_foundation()),
            );

            let error = verifier
                .verify_command("python -c 'print(1)'", Duration::from_millis(100))
                .await
                .expect_err("unlisted shell command must not run");

            assert!(
                error.contains("权限") || error.contains("批准") || error.contains("permission")
            );
        });
    }

    #[test]
    fn verification_kind_maps_to_phase_one_commands() {
        assert_eq!(VerificationKind::CargoCheck.command(), "cargo check");
        assert_eq!(VerificationKind::CargoTest.command(), "cargo test");
        assert_eq!(VerificationKind::NpmRunBuild.command(), "npm run build");
        assert_eq!(VerificationKind::NpmRunLint.command(), "npm run lint");
    }
}
