use crate::harness::permissions::PermissionGuard;
use crate::mcp::{
    arg_bool, arg_str, descriptor, result, workspace_path, McpToolCall, McpToolDescriptor,
    McpToolDomain, McpToolResult,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::time::Instant;
use walkdir::WalkDir;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UnityProjectSnapshot {
    pub scenes: Vec<String>,
    pub prefabs: Vec<String>,
    pub shaders: Vec<String>,
    pub scripts: Vec<String>,
}

pub fn tools() -> Vec<McpToolDescriptor> {
    vec![
        descriptor(
            "unity.inspect_scene",
            McpToolDomain::Unity,
            "Inspect Unity scenes and project assets.",
            "unity:read",
            json!({"type": "object", "properties": {"scene": {"type": "string"}}}),
        ),
        descriptor(
            "unity.edit_prefab",
            McpToolDomain::Unity,
            "Edit a text-serialized Unity prefab.",
            "unity:write",
            json!({
                "type": "object",
                "properties": {
                    "path": {"type": "string"},
                    "find": {"type": "string"},
                    "replace": {"type": "string"},
                    "dryRun": {"type": "boolean"}
                },
                "required": ["path", "find", "replace"]
            }),
        ),
        descriptor(
            "unity.read_console",
            McpToolDomain::Unity,
            "Read Unity editor console logs from common log locations.",
            "unity:read",
            json!({"type": "object", "properties": {"maxBytes": {"type": "number"}}}),
        ),
        descriptor(
            "unity.play_mode",
            McpToolDomain::Unity,
            "Create a replayable play mode execution request.",
            "unity:execute",
            json!({"type": "object", "properties": {"enabled": {"type": "boolean"}}}),
        ),
        descriptor(
            "unity.asset_pipeline",
            McpToolDomain::Unity,
            "Inspect Unity asset pipeline state.",
            "unity:read",
            json!({"type": "object", "properties": {}}),
        ),
        descriptor(
            "unity.shader_iteration",
            McpToolDomain::Unity,
            "Patch text-serialized shader source for iteration workflows.",
            "unity:write",
            json!({
                "type": "object",
                "properties": {
                    "path": {"type": "string"},
                    "find": {"type": "string"},
                    "replace": {"type": "string"},
                    "dryRun": {"type": "boolean"}
                },
                "required": ["path", "find", "replace"]
            }),
        ),
    ]
}

pub async fn call(
    workspace: &Path,
    _permission_guard: &PermissionGuard,
    call: &McpToolCall,
) -> Result<McpToolResult, String> {
    let started_at = Instant::now();
    match call.tool.as_str() {
        "unity.inspect_scene" => {
            let snapshot = inspect_project(workspace)?;
            let scene = arg_str(&call.arguments, "scene");
            let scene_preview = scene
                .and_then(|path| read_workspace_text(workspace, path).ok())
                .map(|content| content.chars().take(8_000).collect::<String>());
            Ok(result(
                call,
                true,
                json!({"snapshot": snapshot, "scenePreview": scene_preview}),
                serde_json::to_string_pretty(&snapshot).unwrap_or_default(),
                "",
                started_at.elapsed().as_millis(),
            ))
        }
        "unity.edit_prefab" => patch_text_asset(workspace, call, ".prefab", started_at),
        "unity.read_console" => {
            let max_bytes = call
                .arguments
                .get("maxBytes")
                .and_then(Value::as_u64)
                .unwrap_or(64 * 1024) as usize;
            let console = read_console_logs(workspace, max_bytes)?;
            Ok(result(
                call,
                true,
                json!({"bytes": console.len()}),
                console,
                "",
                started_at.elapsed().as_millis(),
            ))
        }
        "unity.play_mode" => {
            let enabled = arg_bool(&call.arguments, "enabled", true);
            let request_path = workspace
                .join(".MAIN")
                .join("unity")
                .join("play_mode_request.json");
            let request = json!({
                "enabled": enabled,
                "status": "pending_unity_editor_bridge",
                "note": "Phase 3 records a replayable Unity play mode request; a future bridge can consume it."
            });
            if let Some(parent) = request_path.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|error| format!("create Unity request dir failed: {error}"))?;
            }
            std::fs::write(
                &request_path,
                serde_json::to_vec_pretty(&request).map_err(|error| {
                    format!("serialize Unity play mode request failed: {error}")
                })?,
            )
            .map_err(|error| format!("write Unity play mode request failed: {error}"))?;
            Ok(result(
                call,
                true,
                json!({"requestPath": request_path.to_string_lossy(), "enabled": enabled}),
                format!(
                    "Unity play mode request written: {}",
                    request_path.display()
                ),
                "",
                started_at.elapsed().as_millis(),
            ))
        }
        "unity.asset_pipeline" => {
            let snapshot = inspect_project(workspace)?;
            Ok(result(
                call,
                true,
                json!({
                    "assetCounts": {
                        "scenes": snapshot.scenes.len(),
                        "prefabs": snapshot.prefabs.len(),
                        "shaders": snapshot.shaders.len(),
                        "scripts": snapshot.scripts.len()
                    }
                }),
                serde_json::to_string_pretty(&snapshot).unwrap_or_default(),
                "",
                started_at.elapsed().as_millis(),
            ))
        }
        "unity.shader_iteration" => patch_text_asset(workspace, call, ".shader", started_at),
        _ => Err(format!("unknown Unity MCP tool: {}", call.tool)),
    }
}

fn inspect_project(workspace: &Path) -> Result<UnityProjectSnapshot, String> {
    let assets = workspace.join("Assets");
    let scan_root = if assets.exists() {
        assets
    } else {
        workspace.to_path_buf()
    };
    let mut snapshot = UnityProjectSnapshot {
        scenes: Vec::new(),
        prefabs: Vec::new(),
        shaders: Vec::new(),
        scripts: Vec::new(),
    };

    for entry in WalkDir::new(&scan_root).into_iter().filter_map(Result::ok) {
        if !entry.file_type().is_file() {
            continue;
        }
        let path = entry.path();
        let relative = path
            .strip_prefix(workspace)
            .unwrap_or(path)
            .to_string_lossy()
            .replace('\\', "/");
        match path.extension().and_then(|extension| extension.to_str()) {
            Some("unity") => snapshot.scenes.push(relative),
            Some("prefab") => snapshot.prefabs.push(relative),
            Some("shader") | Some("hlsl") | Some("compute") => snapshot.shaders.push(relative),
            Some("cs") => snapshot.scripts.push(relative),
            _ => {}
        }
    }

    snapshot.scenes.sort();
    snapshot.prefabs.sort();
    snapshot.shaders.sort();
    snapshot.scripts.sort();
    Ok(snapshot)
}

fn patch_text_asset(
    workspace: &Path,
    call: &McpToolCall,
    expected_extension: &str,
    started_at: Instant,
) -> Result<McpToolResult, String> {
    let raw_path = arg_str(&call.arguments, "path").ok_or("Unity patch tool requires path")?;
    let find = arg_str(&call.arguments, "find").ok_or("Unity patch tool requires find")?;
    let replace = arg_str(&call.arguments, "replace").ok_or("Unity patch tool requires replace")?;
    let dry_run = arg_bool(&call.arguments, "dryRun", false);
    let path = workspace_path(workspace, raw_path)?;
    if path.extension().and_then(|extension| extension.to_str())
        != Some(expected_extension.trim_start_matches('.'))
    {
        return Err(format!(
            "Unity patch expected {expected_extension} asset, got {}",
            path.display()
        ));
    }

    let content = std::fs::read_to_string(&path)
        .map_err(|error| format!("read Unity asset failed {}: {error}", path.display()))?;
    let replacements = content.matches(find).count();
    if replacements == 0 {
        return Ok(result(
            call,
            false,
            json!({"path": raw_path, "replacements": 0, "dryRun": dry_run}),
            "",
            format!("pattern not found in {raw_path}"),
            started_at.elapsed().as_millis(),
        ));
    }
    let updated = content.replace(find, replace);
    if !dry_run {
        std::fs::write(&path, updated)
            .map_err(|error| format!("write Unity asset failed {}: {error}", path.display()))?;
    }
    Ok(result(
        call,
        true,
        json!({"path": raw_path, "replacements": replacements, "dryRun": dry_run}),
        format!("patched {replacements} occurrence(s) in {raw_path}"),
        "",
        started_at.elapsed().as_millis(),
    ))
}

fn read_workspace_text(workspace: &Path, raw_path: &str) -> Result<String, String> {
    let path = workspace_path(workspace, raw_path)?;
    std::fs::read_to_string(&path)
        .map_err(|error| format!("read scene failed {}: {error}", path.display()))
}

fn read_console_logs(workspace: &Path, max_bytes: usize) -> Result<String, String> {
    let candidates = console_candidates(workspace);
    for candidate in candidates {
        if !candidate.exists() {
            continue;
        }
        let bytes = std::fs::read(&candidate).map_err(|error| {
            format!("read Unity console failed {}: {error}", candidate.display())
        })?;
        let start = bytes.len().saturating_sub(max_bytes);
        return Ok(String::from_utf8_lossy(&bytes[start..]).to_string());
    }
    Ok(String::new())
}

fn console_candidates(workspace: &Path) -> Vec<PathBuf> {
    let mut candidates = vec![
        workspace
            .join("Library")
            .join("Logs")
            .join("Unity")
            .join("Editor.log"),
        workspace.join("Editor.log"),
    ];
    if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
        candidates.push(home.join("Library/Logs/Unity/Editor.log"));
    }
    candidates
}

#[cfg(test)]
mod tests {
    use super::{call, inspect_project};
    use crate::harness::permissions::{PermissionConfig, PermissionGuard};
    use crate::mcp::McpToolCall;
    use serde_json::json;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_unity_project() -> std::path::PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("main-unity-{unique}"));
        fs::create_dir_all(root.join("Assets")).unwrap();
        root
    }

    #[test]
    fn unity_inspection_and_prefab_patch_work_on_text_assets() {
        let root = temp_unity_project();
        fs::write(root.join("Assets/Main.unity"), "%YAML scene").unwrap();
        fs::write(root.join("Assets/Cube.prefab"), "m_Name: OldCube").unwrap();
        let snapshot = inspect_project(&root).unwrap();
        assert_eq!(snapshot.scenes, vec!["Assets/Main.unity"]);
        assert_eq!(snapshot.prefabs, vec!["Assets/Cube.prefab"]);

        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            let result = call(
                &root,
                &PermissionGuard::new(PermissionConfig::default_runtime_foundation()),
                &McpToolCall {
                    id: "prefab".to_string(),
                    task_id: "task".to_string(),
                    tool: "unity.edit_prefab".to_string(),
                    arguments: json!({
                        "path": "Assets/Cube.prefab",
                        "find": "OldCube",
                        "replace": "NewCube"
                    }),
                    replay: None,
                },
            )
            .await
            .unwrap();

            assert!(result.success);
            assert!(fs::read_to_string(root.join("Assets/Cube.prefab"))
                .unwrap()
                .contains("NewCube"));
        });
    }
}
