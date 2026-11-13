//! Correlated synchronous Shader imports through the existing live Editor.
use super::{
    available_time, compile_diagnostic, project_argument, reports_exact_project, run_cli_result,
};
use serde_json::{json, Value};
use std::{path::Path, sync::atomic::AtomicBool};

fn shader_import_program(targets: &[String]) -> String {
    let paths = targets
        .iter()
        .map(|path| json!(path).to_string())
        .collect::<Vec<_>>()
        .join(", ");
    format!(
        "var paths = new string[] {{ {paths} }};\n{}\nreturn new {{ pid = System.Diagnostics.Process.GetCurrentProcess().Id, imports = results }};",
        include_str!("../Scripts/unity_shader_import.cs")
    )
}

pub(super) fn connected_shader_import_result(
    project: &Path,
    pid: u64,
    targets: &[String],
    envelope: &Value,
) -> Option<Value> {
    if envelope.get("success")?.as_bool()? != true || !reports_exact_project(project, envelope) {
        return None;
    }
    let result = envelope.pointer("/data/result")?;
    let result = if let Some(success) = result.get("success") {
        if success.as_bool()? != true {
            return None;
        }
        result.get("result")?
    } else {
        result
    };
    if result.get("pid")?.as_u64()? != pid {
        return None;
    }
    let imports = result.get("imports")?.as_array()?;
    if imports.len() != targets.len() {
        return None;
    }
    let mut complete = true;
    let mut diagnostics = Vec::new();
    let mut error_count = 0;
    for (entry, target) in imports.iter().zip(targets) {
        if entry.get("path")?.as_str()? != target {
            return None;
        }
        complete &= entry.get("completed")?.as_bool()?;
        for error in entry.get("diagnostics")?.as_array()? {
            error_count += 1;
            if diagnostics.len() < 12 {
                diagnostics.push(compile_diagnostic(
                    project,
                    target,
                    error.get("line").and_then(Value::as_u64).unwrap_or(0),
                    0,
                    "SHADER_IMPORT",
                    error.get("message")?.as_str()?,
                ));
            }
        }
    }
    Some(json!({
        "status": if error_count > 0 { "failed" } else if complete { "passed" } else { "unavailable" },
        "message": (!complete).then_some("UNITY_SHADER_IMPORT_UNVERIFIED: an imported Shader asset could not be read."),
        "diagnostics": diagnostics, "errorCount": error_count
    }))
}

pub(super) fn import_shaders_connected(
    project: &Path,
    pid: u64,
    targets: &[String],
    deadline_at: u64,
    canceled: &AtomicBool,
) -> Result<Value, String> {
    if targets.is_empty()
        || targets.iter().any(|path| {
            let extension = Path::new(path)
                .extension()
                .and_then(|ext| ext.to_str())
                .unwrap_or("");
            !["shader", "compute"]
                .iter()
                .any(|kind| extension.eq_ignore_ascii_case(kind))
        })
    {
        return Err("UNITY_SHADER_IMPORT_UNVERIFIED: a changed include needs an exact dependent Shader import.".to_string());
    }
    let project_path = project_argument(project);
    let program = shader_import_program(targets);
    let (exit, envelope) = run_cli_result(
        project,
        "Unity Shader import",
        &[
            "command",
            "script",
            "eval",
            "--project-path",
            &project_path,
            "--caller",
            "plugin",
            "--skill",
            "unity-cli",
            "--timeout",
            "65",
            "--code",
            &program,
        ],
        available_time(deadline_at, canceled, 72)?,
        Some(canceled),
    )?;
    if exit != 0 {
        return Err(
            "UNITY_SHADER_IMPORT_UNVERIFIED: the Editor did not complete the import.".to_string(),
        );
    }
    connected_shader_import_result(project, pid, targets, &envelope)
        .ok_or_else(|| "UNITY_SHADER_IMPORT_UNVERIFIED: no verified import receipt for this Editor and file set.".to_string())
}
