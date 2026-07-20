use crate::harness::permissions::PermissionGuard;
use crate::trusted_execution::execute_trusted_shell;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::Duration;

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

        // Verification is production execution too: it must share the exact
        // shell parser, argv path containment, canonical cwd, output bounds,
        // process-group timeout, and child-reaping boundary used by tools.
        let output = execute_trusted_shell(
            &self.workspace_root,
            &self.workspace_root,
            command,
            timeout_duration,
            None,
        )
        .await
        .map_err(|error| format!("执行验证命令失败: {error}"))?;

        Ok(VerificationResult {
            command: command.to_string(),
            success: output.success,
            exit_code: output.exit_code,
            stdout: output.stdout,
            stderr: if output.timed_out && output.stderr.is_empty() {
                format!("验证命令超时: {}ms", timeout_duration.as_millis())
            } else {
                output.stderr
            },
            timed_out: output.timed_out,
            duration_ms: output.duration_ms,
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

    #[cfg(unix)]
    #[test]
    fn verifier_rejects_argv_symlink_escape_after_permission_admission() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(outside.path(), workspace.path().join("escape")).unwrap();
        let verifier = Verifier::new(
            workspace.path(),
            PermissionGuard::new(PermissionConfig::default_runtime_foundation()),
        );

        runtime.block_on(async {
            verifier
                .verify_command("ls escape", Duration::from_secs(1))
                .await
                .expect_err("verification argv must not escape through a symlink");
        });
    }
}
