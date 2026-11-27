use super::{
    available_time, connected_editor_pid, inspect_editor_check_permission, playmode_command_result,
    project_argument, unity_cli_command, ProjectEditor,
};
use crate::{capture_command_output_with_limit, now_millis};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde_json::{json, Value};
use std::{path::Path, sync::atomic::AtomicBool};

const MAX_RESOLUTION: u32 = 1024;
const MAX_PNG_BYTES: usize = 5 * 1024 * 1024;
const MAX_CLI_OUTPUT_BYTES: usize = MAX_PNG_BYTES.div_ceil(3) * 4 + 8 * 1024;
const CAPTURE_BUDGET_MS: u64 = 15_000;

pub(super) fn unavailable(message: &str) -> Value {
    json!({"status": "unavailable", "message": message})
}

/// Capture only the connected project's actual Game View render target. The
/// PNG travels through the dedicated IPC and never through command history.
pub fn run_unity_game_view_capture(
    project: &Path,
    deadline_at: Option<u64>,
    canceled: &AtomicBool,
) -> Value {
    let default_deadline = now_millis().saturating_add(CAPTURE_BUDGET_MS);
    let deadline_at = deadline_at
        .unwrap_or(default_deadline)
        .min(default_deadline);
    capture(project, deadline_at, canceled).unwrap_or_else(|message| unavailable(&message))
}

fn capture(project: &Path, deadline_at: u64, canceled: &AtomicBool) -> Result<Value, String> {
    let editor = ProjectEditor::read(project)?
        .ok_or("Open a workspace with Unity ProjectSettings before capturing Game View.")?;
    inspect_editor_check_permission(project, "unity status")?;
    inspect_editor_check_permission(project, "unity command capture game_view")?;
    let pid = connected_editor_pid(project, &editor, deadline_at, canceled)?
        .ok_or("Open this workspace in Unity and wait for its Pipeline server to connect.")?;

    let process = unity_cli_command(
        project,
        &[
            "command",
            "capture",
            "game_view",
            "--project-path",
            &project_argument(project),
            "--pid",
            &pid.to_string(),
            "--caller",
            "plugin",
            "--skill",
            "unity-cli",
            "--",
            "--source",
            "screen",
            "--max-resolution",
            &MAX_RESOLUTION.to_string(),
        ],
    )?;
    let output = capture_command_output_with_limit(
        process,
        "Unity Game View",
        None,
        available_time(deadline_at, canceled, 8)?,
        Some(canceled),
        MAX_CLI_OUTPUT_BYTES,
    )?;
    if output.timed_out {
        return Err(
            "Unity did not capture Game View in time. Wait for Game View to render and try again."
                .into(),
        );
    }
    if output.stdout_truncated {
        return Err("The Unity Game View capture exceeded the image size limit.".into());
    }
    let reply = serde_json::from_str::<Value>(&output.stdout).unwrap_or(Value::Null);
    if !output.success {
        let detail = reply
            .pointer("/errors/0/message")
            .or_else(|| reply.get("message"))
            .or_else(|| reply.get("error"))
            .and_then(Value::as_str)
            .unwrap_or_default();
        let detail: String = crate::terminal_credentials::redact(detail)
            .chars()
            .take(300)
            .collect();
        return Err(format!("Unity could not capture Game View. Check that the Game tab is rendering and the connected Pipeline supports capture game_view. {detail}").trim_end().into());
    }
    captured_image(project, pid, &reply)
        .ok_or_else(|| "Unity did not return a usable PNG from this project's Game View. Try again after the Game tab renders.".into())
}

fn captured_image(project: &Path, pid: u64, reply: &Value) -> Option<Value> {
    if reply.get("data").is_some()
        && reply.pointer("/data/command").and_then(Value::as_str) != Some("capture game_view")
    {
        return None;
    }
    let result = playmode_command_result(project, pid, reply, true)?;
    if result.get("encoding")?.as_str()? != "png" || result.get("source")?.as_str()? != "screen" {
        return None;
    }
    let base64 = result.get("base64")?.as_str()?;
    let png = STANDARD.decode(base64).ok()?;
    let (width, height) = png_dimensions(&png)?;
    if result
        .get("bytes")
        .is_some_and(|size| size.as_u64() != Some(png.len() as u64))
        || result
            .get("inlineWidth")
            .or_else(|| result.get("width"))?
            .as_u64()?
            != u64::from(width)
        || result
            .get("inlineHeight")
            .or_else(|| result.get("height"))?
            .as_u64()?
            != u64::from(height)
    {
        return None;
    }
    Some(json!({
        "status": "captured",
        "imageDataUrl": format!("data:image/png;base64,{base64}"),
        "width": width,
        "height": height,
        "editorPid": pid,
    }))
}

fn png_dimensions(png: &[u8]) -> Option<(u32, u32)> {
    if png.len() > MAX_PNG_BYTES
        || !png.starts_with(b"\x89PNG\r\n\x1a\n\0\0\0\x0dIHDR")
        || !png.ends_with(b"\0\0\0\0IEND\xae\x42\x60\x82")
    {
        return None;
    }
    let width = u32::from_be_bytes(png.get(16..20)?.try_into().ok()?);
    let height = u32::from_be_bytes(png.get(20..24)?.try_into().ok()?);
    ((1..=MAX_RESOLUTION).contains(&width) && (1..=MAX_RESOLUTION).contains(&height))
        .then_some((width, height))
}

#[cfg(test)]
mod tests {
    use super::*;

    const IMAGE: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aEvEAAAAASUVORK5CYII=";

    fn game_view_result() -> Value {
        json!({"source": "screen", "encoding": "png", "width": 1, "height": 1, "base64": IMAGE})
    }

    #[test]
    fn delivers_png_with_dimensions_from_pinned_editor_stream() {
        let result = captured_image(Path::new("project"), 12, &game_view_result()).unwrap();
        assert_eq!(result["status"], "captured");
        assert_eq!(
            result["imageDataUrl"],
            format!("data:image/png;base64,{IMAGE}")
        );
        assert_eq!(result["width"], 1);
        assert_eq!(result["height"], 1);
        assert_eq!(result["editorPid"], 12);
    }

    #[test]
    fn rejects_wrong_project_and_non_screen_or_malformed_capture() {
        let workspace = tempfile::tempdir().unwrap();
        let other = tempfile::tempdir().unwrap();
        let exact = workspace.path().canonicalize().unwrap();
        let mut reply = json!({"success": true, "data": {
            "command": "capture game_view", "target": {"projectPath": other.path(), "pid": 12},
            "result": game_view_result(),
        }});
        assert!(captured_image(&exact, 12, &reply).is_none());
        reply["data"]["target"]["projectPath"] = json!(exact);
        assert!(captured_image(&exact, 13, &reply).is_none());
        assert!(captured_image(&exact, 12, &reply).is_some());

        reply["data"]["result"]["source"] = json!("camera");
        assert!(captured_image(&exact, 12, &reply).is_none());
        reply["data"]["result"]["source"] = json!("screen");
        reply["data"]["result"]["base64"] = json!("iVBORw0KGgo=");
        assert!(captured_image(&exact, 12, &reply).is_none());
    }
}
