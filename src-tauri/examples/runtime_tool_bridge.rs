//! Headless test host for production tool boundaries. No desktop installation.
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{self, Read},
    path::{Path, PathBuf},
    time::Duration,
};
use tauri_app_lib::{
    harness::permissions::{PermissionGuard, ShellPermissionApproval},
    session_store::{CompareAndSwapSessionSnapshotRequest, SessionKey, SessionStore},
    skill_packages, trusted_execution,
};

fn attachment_fixture_root(
    request: &Value,
    field: &str,
    workspace: &Path,
) -> Result<PathBuf, String> {
    let Some(raw) = request[field].as_str() else {
        return Ok(workspace.to_path_buf());
    };
    let path = Path::new(raw);
    if !path.is_absolute() {
        return Err("Attachment fixture roots must be absolute".into());
    }
    let root = trusted_execution::canonical_workspace_root(path).map_err(|e| e.to_string())?;
    let temporary = fs::canonicalize(std::env::temp_dir()).map_err(|e| e.to_string())?;
    if !root.starts_with(workspace) && !root.starts_with(temporary) {
        return Err("Attachment fixture roots must remain in the admitted workspace or test temporary directory".into());
    }
    Ok(root)
}

fn fixture_path_hash(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))[..16].to_string()
}

fn ingest_fixture_attachment(request: &Value, workspace: &Path) -> Result<Value, String> {
    // This is an isolated host adapter, not a call to the desktop's private
    // ingest_attachment_file command. It copies actual admitted bytes through
    // the same public trusted path guard; it never reads or writes app data.
    let args = &request["args"];
    let session = args["sessionKey"]
        .as_str()
        .filter(|s| !s.trim().is_empty())
        .ok_or("Missing attachment Session key")?;
    let source_root = attachment_fixture_root(request, "attachmentSourceRoot", workspace)?;
    let store_root = attachment_fixture_root(request, "attachmentStorePath", workspace)?;
    let raw_source = args["sourcePath"]
        .as_str()
        .ok_or("Missing admitted attachment source")?;
    // Native pickers and Node's temporary directory may use the /var alias on
    // macOS. Canonicalize it before admission; the guard still rejects a
    // resolved source outside the explicitly admitted fixture root.
    let source_input = if Path::new(raw_source).is_absolute() {
        fs::canonicalize(raw_source).map_err(|e| e.to_string())?
    } else {
        source_root.join(raw_source)
    };
    let source = trusted_execution::resolve_workspace_path(
        &source_root,
        &source_input,
        trusted_execution::WorkspacePathMode::Existing,
    )
    .map_err(|e| e.to_string())?;
    let source_path = source.revalidate().map_err(|e| e.to_string())?;
    if !source_path.is_file() {
        return Err("Attachment source must be a file".into());
    }
    let extension = source_path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if ![
        "txt",
        "log",
        "md",
        "markdown",
        "js",
        "ts",
        "tsx",
        "jsx",
        "py",
        "cs",
        "java",
        "c",
        "cpp",
        "h",
        "hpp",
        "json",
        "yaml",
        "yml",
        "toml",
        "xml",
        "html",
        "css",
        "scss",
        "less",
        "sh",
        "bash",
        "zsh",
        "fish",
        "rs",
        "go",
        "rb",
        "php",
        "swift",
        "kt",
        "dart",
        "lua",
        "sql",
        "graphql",
        "env",
        "gitignore",
        "ignore",
        "pdf",
        "docx",
        "xlsx",
        "xls",
        "csv",
        "tsv",
    ]
    .contains(&extension.as_str())
    {
        return Err("Unsupported attachment format in the test host".into());
    }
    let display_name = source_path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("attachment");
    let safe_name: String = display_name
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-' | '_') {
                ch
            } else {
                '_'
            }
        })
        .collect::<String>()
        .trim_matches('_')
        .chars()
        .take(120)
        .collect();
    let relative = format!(
        ".MAIN-chat-attachments/{}/{}-{}",
        fixture_path_hash(session),
        fixture_path_hash(&source_path.to_string_lossy()),
        if safe_name.is_empty() {
            "attachment"
        } else {
            &safe_name
        }
    );
    let destination = trusted_execution::resolve_workspace_path(
        &store_root,
        &relative,
        trusted_execution::WorkspacePathMode::AllowMissing,
    )
    .map_err(|e| e.to_string())?;
    if let Some(parent) = destination
        .revalidate()
        .map_err(|e| e.to_string())?
        .parent()
    {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let destination = destination.revalidate().map_err(|e| e.to_string())?;
    fs::copy(
        source.revalidate().map_err(|e| e.to_string())?,
        &destination,
    )
    .map_err(|e| e.to_string())?;
    let bytes = fs::metadata(&destination).map_err(|e| e.to_string())?.len();
    Ok(
        json!({"path":relative,"workspace":store_root.to_string_lossy(),
        "originalPath":source_path.to_string_lossy(),"displayName":display_name,"sizeBytes":bytes}),
    )
}

async fn dispatch(request: &Value) -> Result<Value, String> {
    let args = &request["args"];
    let workspace = request["workspace"]
        .as_str()
        .ok_or("Missing test workspace")?;
    let root = trusted_execution::canonical_workspace_root(workspace).map_err(|e| e.to_string())?;
    let command = args["command"].as_str().unwrap_or_default();
    match request["cmd"].as_str().unwrap_or_default() {
        "save_plan_document" => {
            let input: tauri_app_lib::plan_documents::SavePlanDocumentInput = serde_json::from_value(args["input"].clone()).map_err(|e| e.to_string())?;
            if let Some(workspace) = &input.owner.workspace {
                if trusted_execution::canonical_workspace_root(workspace).map_err(|e| e.to_string())? != root {
                    return Err("Document fixture owner must match its admitted workspace".into());
                }
            }
            serde_json::to_value(tauri_app_lib::plan_documents::save(&root.join(".MAIN-test-appdata"), input)?).map_err(|e| e.to_string())
        }
        "read_plan_document" => {
            let reference = serde_json::from_value(args["reference"].clone()).map_err(|e| e.to_string())?;
            serde_json::to_value(tauri_app_lib::plan_documents::read(&root.join(".MAIN-test-appdata"), reference)?).map_err(|e| e.to_string())
        }
        "list_plan_documents" => {
            let scope = serde_json::from_value(args["scope"].clone()).map_err(|e| e.to_string())?;
            serde_json::to_value(tauri_app_lib::plan_documents::list(&root.join(".MAIN-test-appdata"), scope)?).map_err(|e| e.to_string())
        }
        "inspect_project_init_target" => serde_json::to_value(tauri_app_lib::inspect_project_init_target_in_workspace(&root)?).map_err(|e| e.to_string()),
        "commit_project_init" => serde_json::to_value(tauri_app_lib::commit_project_init_in_workspace(&root,
            args["expectedTargetPath"].as_str().unwrap_or("AGENTS.md"), args["expectedBaseVersion"].as_str(), args["content"].as_str().unwrap_or_default().to_owned())?).map_err(|e| e.to_string()),
        "knowledge_list_bases" => serde_json::to_value(tauri_app_lib::knowledge::list_knowledge_bases(&root.join(".MAIN-test-appdata"))?).map_err(|e| e.to_string()),
        "knowledge_list_presets" => serde_json::to_value(tauri_app_lib::knowledge::presets::list_engine_manual_presets()).map_err(|e| e.to_string()),
        "knowledge_bootstrap_preset" => {
            let preset_id = args["presetId"].as_str().unwrap_or_default();
            serde_json::to_value(tauri_app_lib::bootstrap_preset_in_app_data(&root.join(".MAIN-test-appdata"), preset_id, None).await?).map_err(|e| e.to_string())
        }
        "knowledge_set_base_enabled" => {
            let kb_id = args["kbId"].as_str().unwrap_or_default();
            let enabled = args["enabled"].as_bool().unwrap_or(true);
            serde_json::to_value(tauri_app_lib::knowledge::set_knowledge_base_enabled(&root.join(".MAIN-test-appdata"), kb_id, enabled)?).map_err(|e| e.to_string())
        }
        "knowledge_list_sources" => serde_json::to_value(tauri_app_lib::knowledge::list_sources(&root.join(".MAIN-test-appdata"), args["kbId"].as_str().unwrap_or_default())?).map_err(|e| e.to_string()),
        "knowledge_create_base" => serde_json::to_value(tauri_app_lib::knowledge::create_knowledge_base(&root.join(".MAIN-test-appdata"), args["name"].as_str().unwrap_or_default(), args["description"].as_str().unwrap_or_default())?).map_err(|e| e.to_string()),
        "knowledge_import_source" => {
            let path = trusted_execution::resolve_workspace_path(&root, args["path"].as_str().unwrap_or_default(), trusted_execution::WorkspacePathMode::Existing).map_err(|e| e.to_string())?;
            let path = path.revalidate().map_err(|e| e.to_string())?;
            let text = fs::read_to_string(&path).map_err(|e| e.to_string())?;
            let extracted = json!({"title":path.file_name().and_then(|v|v.to_str()).unwrap_or("Source"),"content":text,"blocks":[{"text":text}],"metadata":{"source":"plaintext_fixture"}});
            serde_json::to_value(tauri_app_lib::knowledge::index_extracted_source(&root.join(".MAIN-test-appdata"), args["kbId"].as_str().unwrap_or_default(), &path, &path, &extracted, false)?).map_err(|e| e.to_string())
        }
        "knowledge_search" => {
            let references: Vec<tauri_app_lib::knowledge::KnowledgeReference> = serde_json::from_value(args["references"].clone()).map_err(|e| e.to_string())?;
            let limit = args["limit"].as_u64().map(|v| v as usize);
            let policy = if args["policy"].is_null() {
                tauri_app_lib::KnowledgeLookupPolicy::Local
            } else {
                serde_json::from_value(args["policy"].clone()).map_err(|e| e.to_string())?
            };
            serde_json::to_value(tauri_app_lib::search_with_tier_penetration_in_app_data(&root.join(".MAIN-test-appdata"), args["query"].as_str().unwrap_or_default(), &references, limit, policy).await?).map_err(|e| e.to_string())
        }
        "knowledge_get_excerpt" => {
            let references: Vec<tauri_app_lib::knowledge::KnowledgeReference> = serde_json::from_value(args["references"].clone()).map_err(|e| e.to_string())?;
            serde_json::to_value(tauri_app_lib::knowledge::get_excerpt(&root.join(".MAIN-test-appdata"), args["sourceId"].as_str().unwrap_or_default(), args["chunkId"].as_str().unwrap_or_default(), &references)?).map_err(|e| e.to_string())
        }
        "ingest_attachment_file" => ingest_fixture_attachment(request, &root),
        "get_chat_temp_root" => Ok(json!(attachment_fixture_root(
            request,
            "attachmentStorePath",
            &root
        )?
        .to_string_lossy())),
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
