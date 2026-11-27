use crate::{
    capture_command_output,
    unity_editor::{parse_unity_cli_version, resolve_unity_cli, unity_cli_process},
    TerminalCommandOutput, WorkspaceState,
};
use semver::Version;
use serde::Serialize;
use serde_json::Value;
use std::{fs, path::Path, sync::Mutex, time::Duration};
use tauri::State;

static UPDATE_IN_PROGRESS: Mutex<()> = Mutex::new(());

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnityCliUpdateStatus {
    executable_path: String,
    current_version: String,
    latest_version: Option<String>,
    update_available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    package_manager_command: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    check_error: Option<String>,
}

fn run_cli(
    executable: &Path,
    label: &str,
    args: &[&str],
    timeout: Duration,
) -> Result<TerminalCommandOutput, String> {
    let directory = executable.parent().ok_or("UNITY_CLI_UNAVAILABLE")?;
    capture_command_output(
        unity_cli_process(executable, directory, args),
        label,
        None,
        timeout,
    )
    .map_err(|_| "UNITY_CLI_START_FAILED".into())
}

fn installed_version(executable: &Path) -> Result<Version, String> {
    let output = run_cli(
        executable,
        "unity --version",
        &["--version"],
        Duration::from_secs(5),
    )?;
    if !output.success {
        return Err("UNITY_CLI_VERSION_UNAVAILABLE".into());
    }
    parse_unity_cli_version(&output.stdout).ok_or_else(|| "UNITY_CLI_VERSION_UNAVAILABLE".into())
}

fn stable_version(version: &str) -> Option<Version> {
    if version.len() > 96 {
        return None;
    }
    let version = Version::parse(version).ok()?;
    version.pre.is_empty().then_some(version)
}

fn parse_stable_check(output: &str, current: &Version) -> Option<Version> {
    let response: Value = serde_json::from_str(output).ok()?;
    if response["success"] != true {
        return None;
    }
    if parse_unity_cli_version(response.pointer("/data/currentVersion")?.as_str()?)? != *current {
        return None;
    }
    stable_version(response.pointer("/data/latestVersion")?.as_str()?)
}

fn latest_stable(executable: &Path, current: &Version) -> Result<Version, String> {
    let output = run_cli(
        executable,
        "unity upgrade --check",
        &["upgrade", "--check", "--channel", "stable"],
        Duration::from_secs(20),
    )?;
    if output.timed_out {
        return Err("UNITY_CLI_UPDATE_CHECK_TIMEOUT".into());
    }
    if !output.success {
        return Err("UNITY_CLI_UPDATE_CHECK_FAILED".into());
    }
    parse_stable_check(&output.stdout, current)
        .ok_or_else(|| "UNITY_CLI_UPDATE_CHECK_INVALID".into())
}

fn managed_command(output: &str) -> Option<&'static str> {
    let response: Value = serde_json::from_str(output).ok()?;
    match (
        response
            .pointer("/data/installMethod")
            .and_then(Value::as_str),
        response
            .pointer("/data/updateCommand")
            .and_then(Value::as_str),
    ) {
        (Some("homebrew" | "brew" | "cask"), _)
        | (_, Some("brew upgrade unity-cli" | "brew upgrade --cask unity-cli")) => {
            Some("brew upgrade unity-cli")
        }
        (Some("apt" | "deb" | "dpkg"), _)
        | (
            _,
            Some("sudo apt upgrade unity-cli" | "sudo apt update && sudo apt upgrade unity-cli"),
        ) => Some("sudo apt update && sudo apt upgrade unity-cli"),
        (Some("dnf" | "rpm"), _) | (_, Some("sudo dnf upgrade unity-cli")) => {
            Some("sudo dnf upgrade unity-cli")
        }
        _ => None,
    }
}

fn package_manager_command(executable: &Path) -> Option<&'static str> {
    let output = run_cli(
        executable,
        "unity diagnose update",
        &["diagnose", "update"],
        Duration::from_secs(5),
    )
    .ok()?;
    output
        .success
        .then(|| managed_command(&output.stdout))
        .flatten()
}

fn update_status(
    executable: &Path,
    current: &Version,
    stable: Result<Version, String>,
    package_manager_command: Option<&'static str>,
) -> UnityCliUpdateStatus {
    let (latest_version, update_available, check_error) = match stable {
        Ok(latest) => (
            Some(latest.to_string()),
            latest.cmp_precedence(current).is_gt(),
            None,
        ),
        Err(error) => (None, false, Some(error)),
    };
    UnityCliUpdateStatus {
        executable_path: executable.to_string_lossy().into_owned(),
        current_version: current.to_string(),
        latest_version,
        update_available,
        package_manager_command,
        check_error,
    }
}

pub fn check_unity_cli_updates(workspace: &Path) -> Result<UnityCliUpdateStatus, String> {
    let executable = resolve_unity_cli(workspace_exclusion(workspace))?;
    let current = installed_version(&executable)?;
    let stable = latest_stable(&executable, &current);
    Ok(update_status(
        &executable,
        &current,
        stable,
        package_manager_command(&executable),
    ))
}

pub fn apply_unity_cli_update(
    workspace: &Path,
    expected_path: &str,
    expected_version: &str,
    target_version: &str,
) -> Result<UnityCliUpdateStatus, String> {
    let _update = UPDATE_IN_PROGRESS
        .try_lock()
        .map_err(|_| "UNITY_CLI_UPDATE_BUSY")?;
    let exclusion = workspace_exclusion(workspace);
    let executable = resolve_unity_cli(exclusion)?;
    let current = installed_version(&executable)?;
    let target = stable_version(target_version).ok_or("UNITY_CLI_UPDATE_TARGET_INVALID")?;
    if executable.to_str() != Some(expected_path)
        || current.to_string() != expected_version
        || !target.cmp_precedence(&current).is_gt()
    {
        return Err("UNITY_CLI_UPDATE_STALE".into());
    }

    let latest = latest_stable(&executable, &current)?;
    if target != latest {
        return Err("UNITY_CLI_UPDATE_STALE".into());
    }
    if let Some(command) = package_manager_command(&executable) {
        return Ok(update_status(
            &executable,
            &current,
            Ok(latest),
            Some(command),
        ));
    }

    let target_arg = target.to_string();
    let output = run_cli(
        &executable,
        "unity upgrade",
        &[
            "upgrade",
            "--channel",
            "stable",
            "--target",
            &target_arg,
            "--yes",
        ],
        Duration::from_secs(300),
    )?;
    if output.timed_out {
        return Err("UNITY_CLI_UPDATE_TIMEOUT".into());
    }
    if !output.success {
        return Err("UNITY_CLI_UPDATE_FAILED".into());
    }
    let effective = resolve_unity_cli(exclusion)?;
    if installed_version(&effective)? != target {
        return Err("UNITY_CLI_UPDATE_UNVERIFIED".into());
    }
    Ok(update_status(&effective, &target, Ok(latest), None))
}

fn workspace_exclusion(workspace: &Path) -> Option<&Path> {
    // Without a project, Tauri's startup root can be the filesystem root or
    // home directory, which also contains normal user-installed binaries.
    let home_variable = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    let home = std::env::var_os(home_variable).and_then(|path| fs::canonicalize(path).ok());
    (workspace.parent().is_some() && home.as_deref() != Some(workspace)).then_some(workspace)
}

#[tauri::command]
pub async fn unity_cli_check_update(
    state: State<'_, WorkspaceState>,
) -> Result<UnityCliUpdateStatus, String> {
    let workspace = state.get_root()?;
    tauri::async_runtime::spawn_blocking(move || check_unity_cli_updates(&workspace))
        .await
        .map_err(|_| "UNITY_CLI_UPDATE_CHECK_FAILED".to_string())?
}

#[tauri::command]
pub async fn unity_cli_apply_update(
    state: State<'_, WorkspaceState>,
    expected_path: String,
    expected_version: String,
    target_version: String,
) -> Result<UnityCliUpdateStatus, String> {
    let workspace = state.get_root()?;
    tauri::async_runtime::spawn_blocking(move || {
        apply_unity_cli_update(
            &workspace,
            &expected_path,
            &expected_version,
            &target_version,
        )
    })
    .await
    .map_err(|_| "UNITY_CLI_UPDATE_FAILED".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn checks_stable_semver_and_keeps_installed_version_offline() {
        let executable = Path::new("/usr/local/bin/unity");
        let beta = Version::parse("1.0.0-beta.14").unwrap();
        let stable = Version::new(1, 0, 0);
        let response = json!({"success":true,"data":{"currentVersion":beta.to_string(),"latestVersion":stable.to_string()}});
        assert_eq!(
            parse_stable_check(&response.to_string(), &beta),
            Some(stable.clone())
        );
        assert!(parse_stable_check(&response.to_string(), &stable).is_none());
        assert!(update_status(executable, &beta, Ok(stable.clone()), None).update_available);
        let newer_beta = Version::parse("1.1.0-beta.1").unwrap();
        assert!(!update_status(executable, &newer_beta, Ok(stable), None).update_available);
        assert!(stable_version("1.2.0-beta.1").is_none());
        let offline = update_status(executable, &beta, Err("offline".into()), None);
        assert_eq!(offline.current_version, beta.to_string());
        assert!(offline.latest_version.is_none());
        assert_eq!(offline.check_error.as_deref(), Some("offline"));
    }

    #[test]
    fn provides_package_manager_guidance_without_accepting_unrelated_commands() {
        assert_eq!(
            managed_command(r#"{"data":{"installMethod":"homebrew"}}"#),
            Some("brew upgrade unity-cli")
        );
        assert_eq!(
            managed_command(r#"{"data":{"updateCommand":"sudo dnf upgrade unity-cli"}}"#),
            Some("sudo dnf upgrade unity-cli")
        );
        assert!(managed_command(
            r#"{"data":{"installMethod":"msix","updateCommand":"unity self-update"}}"#
        )
        .is_none());
        assert!(managed_command(r#"{"data":{"updateCommand":"echo unexpected"}}"#).is_none());
    }
}
