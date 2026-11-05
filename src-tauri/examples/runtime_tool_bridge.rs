//! Headless test host for production tool boundaries. No desktop installation.
use serde_json::{json, Value};
use std::{
    io::{self, Read},
    path::{Path, PathBuf},
    time::Duration,
};
use tauri_app_lib::{
    harness::permissions::{PermissionGuard, ShellPermissionApproval},
    session_store::{CompareAndSwapSessionSnapshotRequest, SessionKey, SessionStore},
    skill_packages, trusted_execution,
};

async fn dispatch(request: &Value) -> Result<Value, String> {
    let args = &request["args"];
    let workspace = request["workspace"]
        .as_str()
        .ok_or("Missing test workspace")?;
    let root = trusted_execution::canonical_workspace_root(workspace).map_err(|e| e.to_string())?;
    let command = args["command"].as_str().unwrap_or_default();
    match request["cmd"].as_str().unwrap_or_default() {
        "shell_permission_preflight" => {
            let guard = PermissionGuard::from_workspace(&root).map_err(|e| e.to_string())?;
            serde_json::to_value(guard.inspect(command)).map_err(|e| e.to_string())
        }
        "run_command" => {
            let approval: Option<ShellPermissionApproval> = args
                .get("permissionApproval")
                .or_else(|| args.get("permission_approval"))
                .filter(|v| !v.is_null())
                .map(|v| serde_json::from_value(v.clone()))
                .transpose()
                .map_err(|e| e.to_string())?;
            let cwd = args["workingDirectory"].as_str().unwrap_or(".");
            let directory = trusted_execution::resolve_workspace_working_directory(&root, cwd)
                .map_err(|e| e.to_string())?;
            let result = tauri_app_lib::run_workspace_shell_command(
                &root,
                &directory.revalidate().map_err(|e| e.to_string())?,
                command.to_string(),
                args["input"].as_str().map(str::to_string),
                Duration::from_millis(
                    args["timeoutMs"]
                        .as_u64()
                        .unwrap_or(60_000)
                        .clamp(100, 600_000),
                ),
                approval,
            )
            .map_err(|e| e.to_string())?;
            serde_json::to_value(result).map_err(|e| e.to_string())
        }
        "validate_workspace_path" => {
            let path = trusted_execution::resolve_workspace_path(
                &root,
                args["path"].as_str().unwrap_or("."),
                trusted_execution::WorkspacePathMode::AllowMissing,
            )
            .map_err(|e| e.to_string())?;
            Ok(json!(path
                .revalidate()
                .map_err(|e| e.to_string())?
                .to_string_lossy()))
        }
        "get_system_memory" => {
            let mut system = sysinfo::System::new();
            system.refresh_memory();
            Ok(
                json!({"total_bytes":system.total_memory(),"available_bytes":system.available_memory(),"total_gb":system.total_memory() as f64/1073741824.0,"available_gb":system.available_memory() as f64/1073741824.0}),
            )
        }
        "inspect_global_skill_package" | "read_global_skill_package_file" => {
            let data = Path::new(
                request["skillAppData"]
                    .as_str()
                    .ok_or("Missing admitted Skill store")?,
            );
            let id = args["packageId"].as_str().ok_or("Missing package id")?;
            if request["cmd"] == "inspect_global_skill_package" {
                serde_json::to_value(skill_packages::inspect_global_skill_package_at(data, id)?)
                    .map_err(|e| e.to_string())
            } else {
                Ok(json!(skill_packages::read_global_skill_package_file_at(
                    data,
                    id,
                    args["relativePath"].as_str().ok_or("Missing resource")?
                )?))
            }
        }
        cmd @ ("save_project_session"
        | "load_project_session"
        | "load_project_session_meta"
        | "list_project_sessions") => {
            // Existing-project runs keep their disposable store in the owned
            // evidence directory. This host setting is outside model args.
            // Other tests retain the isolated-workspace default.
            let database_path = request["sessionStorePath"]
                .as_str()
                .map(PathBuf::from)
                .unwrap_or_else(|| root.join(".MAIN-test-session.sqlite3"));
            if !database_path.is_absolute() {
                return Err("Test Session store path must be absolute".into());
            }
            let store = SessionStore::open(database_path)
                .map_err(|e| serde_json::to_string(&e).unwrap_or_else(|_| e.to_string()))?;
            let project = root.to_string_lossy().to_string();
            if cmd == "list_project_sessions" {
                let rows = store
                    .list_session_snapshots(&project)
                    .map_err(|e| serde_json::to_string(&e).unwrap_or_else(|_| e.to_string()))?;
                return Ok(Value::Array(
                    rows.into_iter()
                        .map(|r| {
                            let mut value = r.snapshot;
                            value["storageRevision"] = json!(r.revision);
                            value
                        })
                        .collect(),
                ));
            }
            let mut snapshot = args["session"].clone();
            let id = if cmd == "save_project_session" {
                &snapshot["id"]
            } else {
                &args["sessionId"]
            };
            let id = id
                .as_str()
                .map(str::to_string)
                .unwrap_or_else(|| id.to_string());
            let key = SessionKey {
                workspace: project,
                session_id: id,
            };
            let record = if cmd == "save_project_session" {
                let expected_revision = snapshot["storageRevision"].as_u64().unwrap_or(0);
                let now = snapshot["updatedAtMs"].as_i64().unwrap_or(0);
                Some(
                    store
                        .compare_and_swap_session_snapshot_before(
                            CompareAndSwapSessionSnapshotRequest {
                                key,
                                expected_revision,
                                snapshot,
                                updated_at_ms: now,
                            },
                            args["mutationDeadlineMs"].as_i64(),
                        )
                        .map_err(|e| serde_json::to_string(&e).unwrap())?
                        .snapshot,
                )
            } else {
                store
                    .get_session_snapshot(&key)
                    .map_err(|e| serde_json::to_string(&e).unwrap_or_else(|_| e.to_string()))?
            };
            match record {
                Some(record) => {
                    snapshot = record.snapshot;
                    snapshot["storageRevision"] = json!(record.revision);
                    snapshot["storageStatus"] = json!("ok");
                    Ok(snapshot)
                }
                None => Ok(Value::Null),
            }
        }
        _ => Err("Unsupported production test bridge command".into()),
    }
}

fn main() {
    let mut input = String::new();
    io::stdin().read_to_string(&mut input).unwrap();
    let request: Value = serde_json::from_str(&input).unwrap();
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let result = runtime.block_on(dispatch(&request));
    println!(
        "{}",
        match result {
            Ok(body) => json!({"ok":true,"body":body}),
            Err(error) => json!({"ok":false,"error":error}),
        }
    );
}
