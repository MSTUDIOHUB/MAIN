//! MAIN-owned Unity authoring and verification against an exact project.
#[path = "unity_shader_includes.rs"]
mod shader_includes;
pub(crate) use shader_includes::check_shader_includes;
#[path = "unity_shader_import.rs"]
mod shader_import;
#[cfg(test)]
use shader_import::connected_shader_import_result;
use shader_import::import_shaders_connected;

use std::{
    collections::{HashMap, HashSet},
    fs,
    io::{BufRead, BufReader, Read},
    path::{Path, PathBuf},
    process::Command,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, OnceLock,
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

type EditorCancellation = Arc<AtomicBool>;
fn editor_cancellations() -> &'static Mutex<HashMap<String, (Instant, EditorCancellation)>> {
    static CANCELLATIONS: OnceLock<Mutex<HashMap<String, (Instant, EditorCancellation)>>> =
        OnceLock::new();
    CANCELLATIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn editor_cancellation(operation_id: &str) -> Result<EditorCancellation, String> {
    if operation_id.len() != 36
        || !operation_id
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() || byte == b'-')
    {
        return Err("UNITY_INVALID_OPERATION_ID".to_string());
    }
    let mut active = editor_cancellations()
        .lock()
        .map_err(|_| "Unity cancellation registry unavailable")?;
    active.retain(|_, (started, _)| started.elapsed() < Duration::from_secs(600));
    Ok(active
        .entry(operation_id.to_owned())
        .or_insert_with(|| (Instant::now(), Arc::new(AtomicBool::new(false))))
        .1
        .clone())
}

#[tauri::command]
pub fn cancel_unity_editor_operation(operation_id: String) -> Result<(), String> {
    editor_cancellation(&operation_id)?.store(true, Ordering::Release);
    Ok(())
}

fn available_time(deadline_at: u64, canceled: &AtomicBool, cap: u64) -> Result<Duration, String> {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    if canceled.load(Ordering::Acquire) || now >= deadline_at {
        return Err("UNITY_OPERATION_CANCELED: no new Editor action was dispatched".to_string());
    }
    Ok(Duration::from_millis((deadline_at - now).min(cap * 1_000)))
}

use quick_xml::{
    events::{BytesStart, Event},
    Reader,
};
use regex::Regex;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::State;

use crate::{
    apply_process_terminal_env, capture_command_output_with_cancel, get_workspace_write_lock,
    isolate_process_group, resolve_workspace_root,
    trusted_execution::{resolve_workspace_path, TrustedShellInspection, WorkspacePathMode},
    TerminalCommandOutput, WorkspaceState,
};

pub(crate) struct BatchReportExpectation {
    path: PathBuf,
    before: Option<SystemTime>,
    started: SystemTime,
    filter: Vec<(bool, Regex)>,
}

fn exact_argument<'a>(args: &[&'a str], flag: &str) -> Option<Option<&'a str>> {
    let mut result = None;
    for (index, arg) in args.iter().enumerate() {
        let (name, inline) = arg
            .split_once('=')
            .map_or((*arg, None), |(name, value)| (name, Some(value)));
        if !name.eq_ignore_ascii_case(flag) {
            continue;
        }
        if result.is_some() {
            return None;
        }
        let value = inline.or_else(|| args.get(index + 1).copied())?;
        if value.is_empty() || value.starts_with('-') {
            return None;
        }
        result = Some(value);
    }
    Some(result)
}

fn nunit_filter(value: &str) -> Option<Vec<(bool, Regex)>> {
    value
        .split(';')
        .filter(|part| !part.is_empty())
        .map(|part| {
            let negated = part.starts_with('!');
            Regex::new(part.strip_prefix('!').unwrap_or(part))
                .ok()
                .map(|regex| (negated, regex))
        })
        .collect()
}

pub(crate) fn batch_report_expectations(
    project: &Path,
    working_directory: &Path,
    inspection: &TrustedShellInspection,
) -> Vec<Option<BatchReportExpectation>> {
    inspection
        .segments
        .iter()
        .filter_map(|segment| {
            let mut words = segment.words.iter().map(String::as_str).peekable();
            while words
                .peek()
                .is_some_and(|word| matches!(*word, "command" | "env") || word.contains('='))
            {
                words.next();
            }
            let executable = words.next()?.rsplit(['/', '\\']).next()?;
            if !["unity", "unity.exe", "tuanjie", "tuanjie.exe"]
                .iter()
                .any(|name| executable.eq_ignore_ascii_case(name))
            {
                return None;
            }
            let args = words.collect::<Vec<_>>();
            if args
                .iter()
                .any(|arg| matches!(*arg, "--help" | "-h" | "--version"))
            {
                return None;
            }
            let cli_test = args.first() == Some(&"test");
            let editor_test = args.iter().any(|arg| arg.eq_ignore_ascii_case("-runTests"))
                && args
                    .iter()
                    .any(|arg| arg.eq_ignore_ascii_case("-batchmode"));
            if !cli_test && !editor_test {
                return None;
            }
            let expectation = (|| {
                let selected_project = if cli_test {
                    args.get(1).copied()
                } else {
                    exact_argument(&args, "-projectPath")?
                }?;
                if selected_project.starts_with('-')
                    || fs::canonicalize(working_directory.join(selected_project))
                        .ok()
                        .as_deref()
                        != Some(project)
                {
                    return None;
                }
                let flag = if cli_test { "--output" } else { "-testResults" };
                let output =
                    exact_argument(&args, flag)?.or(cli_test.then_some("test-results.xml"))?;
                let filter_flag = if cli_test { "--filter" } else { "-testFilter" };
                let filter = nunit_filter(exact_argument(&args, filter_flag)?.unwrap_or(""))?;
                let path = working_directory.join(output);
                let trusted =
                    resolve_workspace_path(project, &path, WorkspacePathMode::AllowMissing).ok()?;
                if trusted.path() != path
                    || path.extension().and_then(|ext| ext.to_str()) != Some("xml")
                {
                    return None;
                }
                let before = match fs::symlink_metadata(&path) {
                    Ok(metadata) if metadata.is_file() => Some(metadata.modified().ok()?),
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
                    _ => return None,
                };
                Some(BatchReportExpectation {
                    path,
                    before,
                    started: SystemTime::now(),
                    filter,
                })
            })();
            Some(expectation)
        })
        .collect()
}

pub(crate) fn verify_batch_reports(
    project: &Path,
    checks: Vec<Option<BatchReportExpectation>>,
) -> Option<Value> {
    if checks.is_empty() {
        return None;
    }
    let mut paths = HashSet::new();
    if checks
        .iter()
        .flatten()
        .any(|check| !paths.insert(&check.path))
    {
        return Some(json!([{ "status": "ambiguous_report_path" }]));
    }
    let reports: Vec<_> = checks.into_iter().map(|expectation| {
        let Some(check) = expectation else { return json!({ "status": "report_path_unavailable" }); };
        let relative = check.path.strip_prefix(project).ok();
        let report = (|| {
            let path = resolve_workspace_path(project, &check.path, WorkspacePathMode::Existing).ok()?;
            if path.path() != check.path {
                return None;
            }
            let metadata = fs::symlink_metadata(path.path()).ok()?;
            let modified = metadata.modified().ok()?;
            if !metadata.is_file() || check.before.is_some_and(|before| modified <= before) ||
                modified + Duration::from_secs(1) < check.started {
                return None;
            }
            const MAX_REPORT_BYTES: u64 = 4 * 1024 * 1024;
            let mut bytes = Vec::new();
            fs::File::open(path.path()).ok()?.take(MAX_REPORT_BYTES + 1).read_to_end(&mut bytes).ok()?;
            if bytes.len() as u64 > MAX_REPORT_BYTES {
                return None;
            }
            parse_nunit_pass(&bytes, &check.filter)
        })();
        match report {
            Some(passed) => json!({ "status": "verified", "path": relative, "passed": passed }),
            None => json!({ "status": "fresh_nonempty_passing_report_unavailable", "path": relative }),
        }
    }).collect();
    Some(json!(reports))
}

fn attribute(start: &BytesStart<'_>, key: &[u8]) -> Option<String> {
    start
        .try_get_attribute(key)
        .ok()
        .flatten()?
        .unescape_value()
        .ok()
        .map(|value| value.into_owned())
}

fn parse_nunit_pass(xml: &[u8], filter: &[(bool, Regex)]) -> Option<usize> {
    let mut reader = Reader::from_reader(xml);
    reader.config_mut().expand_empty_elements = true;
    let mut total = None;
    let mut passed = 0;
    let mut depth = 0usize;
    let mut root_closed = false;
    loop {
        match reader.read_event().ok()? {
            Event::DocType(_) => return None,
            Event::Start(start) if depth == 0 => {
                if total.is_some()
                    || start.name().as_ref() != b"test-run"
                    || attribute(&start, b"result").as_deref() != Some("Passed")
                    || [b"failed".as_slice(), b"skipped", b"inconclusive"]
                        .iter()
                        .any(|key| attribute(&start, key).as_deref() != Some("0"))
                {
                    return None;
                }
                let expected: usize = attribute(&start, b"total")?.parse().ok()?;
                if expected == 0 || attribute(&start, b"passed")?.parse::<usize>().ok()? != expected
                {
                    return None;
                }
                total = Some(expected);
                depth = 1;
            }
            Event::Start(start) if start.name().as_ref() == b"test-case" => {
                let name = attribute(&start, b"fullname")?;
                let needs_include = filter.iter().any(|(negated, _)| !negated);
                if attribute(&start, b"result").as_deref() != Some("Passed")
                    || name.is_empty()
                    || (needs_include
                        && !filter
                            .iter()
                            .any(|(negated, pattern)| !negated && pattern.is_match(&name)))
                    || filter
                        .iter()
                        .any(|(negated, pattern)| *negated && pattern.is_match(&name))
                {
                    return None;
                }
                passed += 1;
                depth += 1;
            }
            Event::Start(_) => depth += 1,
            Event::End(_) => {
                depth = depth.checked_sub(1)?;
                root_closed |= depth == 0;
            }
            Event::Eof => {
                return (root_closed && depth == 0 && total == Some(passed)).then_some(passed)
            }
            _ => {}
        }
    }
}

fn nunit_report_summary(xml: &[u8]) -> Option<String> {
    let mut reader = Reader::from_reader(xml);
    reader.config_mut().expand_empty_elements = true;
    let mut counts = None;
    let mut failures = Vec::new();
    loop {
        match reader.read_event().ok()? {
            Event::DocType(_) => return None,
            Event::Start(start) if start.name().as_ref() == b"test-run" && counts.is_none() => {
                let count = |name| attribute(&start, name)?.parse::<usize>().ok();
                counts = Some(format!(
                    "PlayMode: {} total, {} passed, {} failed, {} skipped.",
                    count(b"total")?,
                    count(b"passed")?,
                    count(b"failed")?,
                    count(b"skipped")?
                ));
            }
            Event::Start(start) if start.name().as_ref() == b"test-case" && failures.len() < 8 => {
                if let Some(result @ ("Failed" | "Skipped" | "Inconclusive")) =
                    attribute(&start, b"result").as_deref()
                {
                    if let Some(name) = attribute(&start, b"fullname") {
                        failures.push(format!(
                            "{result}: {}",
                            name.chars().take(240).collect::<String>()
                        ));
                    }
                }
            }
            Event::Eof => break,
            _ => {}
        }
    }
    Some(
        std::iter::once(counts?)
            .chain(failures)
            .collect::<Vec<_>>()
            .join("\n"),
    )
}

fn asset_path<'a>(value: &'a str, extension: &str) -> Result<&'a str, String> {
    let path = Path::new(value);
    if !value.starts_with("Assets/")
        || value.contains('\\')
        || value.contains(':')
        || value.chars().any(char::is_control)
        || value
            .split('/')
            .any(|part| part.is_empty() || part == "." || part == "..")
        || path.extension().and_then(|part| part.to_str()) != Some(extension)
    {
        return Err(format!(
            "UNITY_INVALID_ASSET_PATH: expected a workspace-relative Assets/*.{} path",
            extension
        ));
    }
    Ok(value)
}

fn project_argument(project: &Path) -> String {
    let text = project.to_string_lossy();
    if let Some(unc) = text.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{unc}");
    }
    text.strip_prefix(r"\\?\").unwrap_or(&text).to_owned()
}

fn reports_exact_project(project: &Path, envelope: &Value) -> bool {
    envelope
        .pointer("/data/target/projectPath")
        .and_then(Value::as_str)
        .and_then(|path| fs::canonicalize(path).ok())
        .as_deref()
        == Some(project)
}

fn run_cli(project: &Path, label: &str, args: &[&str], timeout: Duration) -> Result<Value, String> {
    let (code, envelope) = run_cli_result(project, label, args, timeout, None)?;
    if code != 0 || envelope.get("success").and_then(Value::as_bool) != Some(true) {
        let diagnostics: String = envelope
            .get("errors")
            .unwrap_or(&envelope)
            .to_string()
            .chars()
            .take(2_000)
            .collect();
        return Err(format!(
            "UNITY_COMMAND_FAILED: {label} (exit {code}): {diagnostics}"
        ));
    }
    Ok(envelope)
}

fn run_cli_result(
    project: &Path,
    label: &str,
    args: &[&str],
    timeout: Duration,
    canceled: Option<&AtomicBool>,
) -> Result<(i32, Value), String> {
    let command = unity_cli_command(project, args)?;
    let output = capture_command_output_with_cancel(command, label, None, timeout, canceled)
        .map_err(|error| format!("UNITY_CLI_UNAVAILABLE: {label}: {error}"))?;
    if output.timed_out {
        return Err(format!("UNITY_COMMAND_TIMEOUT: {label}"));
    }
    let envelope = serde_json::from_str::<Value>(&output.stdout).map_err(|_| {
        format!(
            "UNITY_COMMAND_RESULT_UNAVAILABLE: {label} (exit {})",
            output.exit_code
        )
    })?;
    Ok((output.exit_code, envelope))
}

fn unity_cli_command(project: &Path, args: &[&str]) -> Result<Command, String> {
    let mut command = Command::new("unity");
    apply_process_terminal_env(&mut command);
    let executable = command
        .get_envs()
        .find_map(|(name, value)| (name == "PATH").then_some(value).flatten())
        .and_then(|path| {
            std::env::split_paths(path)
                .filter(|dir| dir.is_absolute())
                .find_map(|dir| {
                    let path = dir.join(if cfg!(windows) { "unity.exe" } else { "unity" });
                    let path = fs::canonicalize(path).ok()?;
                    (path.is_file() && !path.starts_with(project)).then_some(path)
                })
        })
        .ok_or_else(|| "UNITY_CLI_UNAVAILABLE: install Unity CLI on the login PATH".to_string())?;
    command = Command::new(executable);
    apply_process_terminal_env(&mut command);
    let forward = args
        .iter()
        .position(|arg| *arg == "--")
        .unwrap_or(args.len());
    command
        .current_dir(project)
        .args(&args[..forward])
        .args(["--format", "json", "--non-interactive", "--no-pager"])
        .args(&args[forward..])
        .env("UNITY_NO_UPDATE_CHECK", "1");
    isolate_process_group(&mut command);
    Ok(command)
}

#[derive(Clone, Copy)]
enum EditorRoute {
    Connected { pid: u64 },
    Closed,
}

struct ProjectEditor {
    version: String,
    tuanjie_version: Option<String>,
}

impl ProjectEditor {
    fn name(&self) -> &'static str {
        if self.tuanjie_version.is_some() {
            "Tuanjie"
        } else {
            "Unity"
        }
    }

    fn read(project: &Path) -> Result<Option<Self>, String> {
        let version_path = project.join("ProjectSettings/ProjectVersion.txt");
        match fs::symlink_metadata(&version_path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            _ => {}
        }
        let trusted = resolve_workspace_path(project, &version_path, WorkspacePathMode::Existing)
            .map_err(|_| "UNITY_PROJECT_VERSION_UNAVAILABLE".to_string())?;
        if trusted.path() != version_path {
            return Err(
                "UNITY_PROJECT_VERSION_UNAVAILABLE: project version must belong to this workspace"
                    .to_string(),
            );
        }
        let file = fs::File::open(trusted.path())
            .map_err(|_| "UNITY_PROJECT_VERSION_UNAVAILABLE".to_string())?;
        let mut text = String::new();
        file.take(4096)
            .read_to_string(&mut text)
            .map_err(|_| "UNITY_PROJECT_VERSION_UNAVAILABLE".to_string())?;
        Self::parse(&text).map(Some)
    }

    fn parse(text: &str) -> Result<Self, String> {
        let field = |key: &str| {
            text.lines()
                .filter_map(|line| line.split_once(':'))
                .find_map(|(name, value)| (name.trim() == key).then(|| value.trim().to_owned()))
        };
        let valid_version = |value: &String| {
            value.len() <= 64
                && value.as_bytes().first().is_some_and(u8::is_ascii_digit)
                && value
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'.' || byte == b'-')
        };
        let version = field("m_EditorVersion")
            .filter(valid_version)
            .ok_or_else(|| "UNITY_PROJECT_VERSION_INVALID".to_string())?;
        let tuanjie_version = field("m_TuanjieEditorVersion");
        if tuanjie_version
            .as_ref()
            .is_some_and(|version| !valid_version(version))
        {
            return Err("UNITY_PROJECT_VERSION_INVALID".to_string());
        }
        Ok(Self {
            version,
            tuanjie_version,
        })
    }

    fn matches_binary_version(&self, version: &str) -> bool {
        version == self.version
            || version
                .strip_prefix(&self.version)
                .is_some_and(|suffix| suffix.starts_with(".git."))
    }
}

/// Batch compilation errors can leave the lock file behind. Only an active
/// handle prevents batch mode; an inconclusive probe never authorizes it.
fn project_editor_closed(
    project: &Path,
    editor: &ProjectEditor,
    deadline_at: u64,
    canceled: &AtomicBool,
) -> bool {
    let expected = if editor.tuanjie_version.is_some() {
        "TuanjieLockfile"
    } else {
        "UnityLockfile"
    };
    let other = if expected == "UnityLockfile" {
        "TuanjieLockfile"
    } else {
        "UnityLockfile"
    };
    [expected, other].iter().all(|name| {
        let lock = project.join("Temp").join(name);
        match fs::symlink_metadata(&lock) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => true,
            Ok(metadata) if metadata.is_file() => {
                editor_lock_inactive(&lock, deadline_at, canceled)
            }
            _ => false,
        }
    })
}

fn editor_lock_inactive(lock: &Path, deadline_at: u64, canceled: &AtomicBool) -> bool {
    if fs::canonicalize(lock).ok().as_deref() != Some(lock) {
        return false;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        return available_time(deadline_at, canceled, 1).is_ok()
            && fs::OpenOptions::new()
                .read(true)
                .share_mode(0)
                .open(lock)
                .is_ok();
    }
    #[cfg(not(windows))]
    {
        let Ok(timeout) = available_time(deadline_at, canceled, 3) else {
            return false;
        };
        let mut probe = if cfg!(target_os = "macos") {
            let mut lsof = Command::new("/usr/sbin/lsof");
            lsof.args(["-n", "-P", "-t", "--"]);
            lsof
        } else {
            let mut fuser = Command::new("/usr/bin/fuser");
            fuser.args(["-s", "--"]);
            fuser
        };
        probe.arg(lock);
        isolate_process_group(&mut probe);
        capture_command_output_with_cancel(
            probe,
            "Editor project lock",
            None,
            timeout,
            Some(canceled),
        )
        .is_ok_and(|output| {
            output.exit_code == 1
                && !output.timed_out
                && output.stdout.trim().is_empty()
                && output.stderr.trim().is_empty()
        })
    }
}

fn editor_route(
    project: &Path,
    editor: &ProjectEditor,
    deadline_at: u64,
    canceled: &AtomicBool,
) -> Result<EditorRoute, String> {
    // A locked project cannot be started in batch mode. Discover only its
    // connected Editor, without collecting process arguments or credentials.
    if project_editor_closed(project, editor, deadline_at, canceled) {
        return Ok(EditorRoute::Closed);
    }
    let project_path = project_argument(project);
    let (exit, status) = run_cli_result(
        project,
        "unity status",
        &["status", "--project-path", &project_path],
        available_time(deadline_at, canceled, 8)?,
        Some(canceled),
    )?;
    if exit == 0 && status.get("success") == Some(&json!(true)) {
        if let Some(pid) = exact_editor_instance(project, editor, &status) {
            return Ok(EditorRoute::Connected { pid });
        }
    }
    Err(format!("UNITY_EDITOR_UNREACHABLE: {} {} has a project lock but its connector is unavailable. Wait for the exact Editor to become ready or close it to use batch mode.",
        editor.name(), editor.version))
}

fn exact_editor_instance(project: &Path, editor: &ProjectEditor, status: &Value) -> Option<u64> {
    let mut matching = status
        .pointer("/data/instances")?
        .as_array()?
        .iter()
        .filter(|instance| {
            instance
                .get("projectPath")
                .or_else(|| instance.get("project"))
                .and_then(Value::as_str)
                .and_then(|path| fs::canonicalize(path).ok())
                .as_deref()
                == Some(project)
                && instance
                    .get("editorVersion")
                    .or_else(|| instance.get("version"))
                    .and_then(Value::as_str)
                    .is_some_and(|version| {
                        editor.matches_binary_version(version)
                            || editor.tuanjie_version.as_deref() == Some(version)
                    })
        });
    let instance = matching.next()?;
    if matching.next().is_some() {
        return None;
    }
    instance
        .get("pid")
        .or_else(|| instance.get("processId"))?
        .as_u64()
        .filter(|pid| *pid > 0)
}

fn hub_install_root(product: &str) -> Option<PathBuf> {
    let mut config = if cfg!(target_os = "windows") {
        PathBuf::from(std::env::var_os("APPDATA")?)
    } else {
        let home = PathBuf::from(std::env::var_os("HOME")?);
        home.join(if cfg!(target_os = "macos") {
            "Library/Application Support"
        } else {
            ".config"
        })
    };
    config.push(format!("{product}Hub/secondaryInstallPath.json"));
    let file = fs::File::open(config).ok()?;
    let root = PathBuf::from(serde_json::from_reader::<_, String>(file.take(16 * 1024)).ok()?);
    root.is_absolute().then_some(root)
}

fn editor_executable(install: &Path, product: &str) -> PathBuf {
    if cfg!(target_os = "macos") {
        return install.join(format!("{product}.app/Contents/MacOS/{product}"));
    }
    let name = if cfg!(windows) {
        format!("{product}.exe")
    } else {
        product.to_string()
    };
    install.join("Editor").join(name)
}

fn editor_install_candidates(editor: &ProjectEditor) -> Vec<PathBuf> {
    let product = editor.name();
    let home = std::env::var_os("HOME").map(PathBuf::from);
    let mut standard = if cfg!(target_os = "macos") {
        vec![PathBuf::from("/Applications")]
    } else if cfg!(windows) {
        ["ProgramFiles", "ProgramFiles(x86)"]
            .into_iter()
            .filter_map(std::env::var_os)
            .map(PathBuf::from)
            .collect()
    } else {
        vec![PathBuf::from("/opt")]
    };
    if let Some(home) = home {
        standard.push(if cfg!(target_os = "macos") {
            home.join("Applications")
        } else {
            home
        });
    }
    let mut candidates = Vec::new();
    let install = |root: &Path| editor_executable(&root.join(&editor.version), product);
    if let Some(root) = hub_install_root(product) {
        candidates.push(install(&root));
    }
    for root in standard {
        let root = root.join(product);
        candidates.push(install(&root.join("Hub/Editor")));
        candidates.push(editor_executable(&root, product));
    }
    candidates
}

fn batch_editor_executable(
    project: &Path,
    editor: &ProjectEditor,
    deadline_at: u64,
    canceled: &AtomicBool,
) -> Result<PathBuf, String> {
    let product = editor.name();
    let mut candidates = editor_install_candidates(editor);
    if editor.tuanjie_version.is_none() && !candidates.iter().any(|path| path.is_file()) {
        if let Ok((0, inventory)) = run_cli_result(
            project,
            "unity editors --installed",
            &["editors", "--installed"],
            available_time(deadline_at, canceled, 8)?,
            Some(canceled),
        ) {
            if let Some(entries) = inventory.get("data").and_then(Value::as_array) {
                candidates.extend(entries.iter().filter_map(|entry| {
                    if entry.get("version")?.as_str()? != editor.version {
                        return None;
                    }
                    let location = PathBuf::from(entry.get("location")?.as_str()?);
                    if !location.is_absolute() {
                        return None;
                    }
                    Some(
                        if cfg!(target_os = "macos")
                            && location.extension().is_some_and(|ext| ext == "app")
                        {
                            location.join("Contents/MacOS/Unity")
                        } else if location.is_file() {
                            location
                        } else {
                            editor_executable(&location, product)
                        },
                    )
                }));
            }
        }
    }
    let mut checked = HashSet::new();
    for candidate in candidates
        .into_iter()
        .filter_map(|path| fs::canonicalize(path).ok())
    {
        if !candidate.is_file()
            || candidate.starts_with(project)
            || !checked.insert(candidate.clone())
        {
            continue;
        }
        let mut probe = Command::new(&candidate);
        probe.current_dir(project).arg("-version");
        isolate_process_group(&mut probe);
        let output = capture_command_output_with_cancel(
            probe,
            "Editor -version",
            None,
            available_time(deadline_at, canceled, 5)?,
            Some(canceled),
        );
        if output.is_ok_and(|output| {
            output.success
                && output
                    .stdout
                    .lines()
                    .any(|line| editor.matches_binary_version(line.trim()))
        }) {
            return Ok(candidate);
        }
    }
    Err(format!(
        "UNITY_EDITOR_VERSION_UNAVAILABLE: install {product} {} for this project.",
        editor.version
    ))
}

fn run_batch_editor(
    project: &Path,
    editor: &ProjectEditor,
    log: &Path,
    args: &[&str],
    deadline_at: u64,
    canceled: &AtomicBool,
) -> Result<TerminalCommandOutput, String> {
    let binary = batch_editor_executable(project, editor, deadline_at, canceled)?;
    if !project_editor_closed(project, editor, deadline_at, canceled) {
        return Err("UNITY_PROJECT_LOCKED: the exact project is already open.".to_string());
    }
    let mut command = Command::new(binary);
    apply_process_terminal_env(&mut command);
    command
        .current_dir(project)
        .args([
            "-batchmode",
            "-projectPath",
            &project_argument(project),
            "-logFile",
            &project_argument(log),
            "-forgetProjectPath",
        ])
        .args(args);
    isolate_process_group(&mut command);
    capture_command_output_with_cancel(
        command,
        "Unity-family Editor batch",
        None,
        available_time(deadline_at, canceled, 300)?,
        Some(canceled),
    )
}

fn compile_diagnostic(
    project: &Path,
    file: &str,
    line: u64,
    column: u64,
    code: &str,
    message: &str,
) -> Value {
    let path = Path::new(file);
    let relative = if path.is_absolute() {
        path.strip_prefix(project).ok()
    } else {
        Some(path)
    };
    let safe = relative.filter(|path| {
        path.components()
            .all(|part| matches!(part, std::path::Component::Normal(_)))
    });
    json!({ "file": safe.map(|path| path.to_string_lossy().replace('\\', "/").chars().take(512).collect::<String>()),
        "line": line, "column": column, "code": code.chars().take(24).collect::<String>(),
        "message": message.chars().take(320).collect::<String>() })
}

fn connected_compilation_result(project: &Path, exit: i32, envelope: &Value) -> Option<Value> {
    if envelope.get("command")?.as_str()? != "recompile"
        || !matches!(
            envelope.pointer("/data/status")?.as_str()?,
            "completed" | "up_to_date"
        )
    {
        return None;
    }
    let failed = envelope.pointer("/data/failed")?.as_bool()?;
    if !failed && (exit != 0 || envelope.get("success")?.as_bool()? != true) {
        return None;
    }
    let errors = envelope.pointer("/data/errors").and_then(Value::as_array);
    let diagnostics = errors
        .into_iter()
        .flatten()
        .take(12)
        .map(|error| {
            compile_diagnostic(
                project,
                error.get("file").and_then(Value::as_str).unwrap_or(""),
                error.get("line").and_then(Value::as_u64).unwrap_or(0),
                error.get("column").and_then(Value::as_u64).unwrap_or(0),
                error.get("code").and_then(Value::as_str).unwrap_or(""),
                error
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("Unity reported a compiler error."),
            )
        })
        .collect::<Vec<_>>();
    Some(
        json!({"status": if failed { "failed" } else { "passed" }, "editor": "connected",
        "errorCount": envelope.pointer("/data/summary/errors").and_then(Value::as_u64).unwrap_or(diagnostics.len() as u64),
        "diagnostics": diagnostics,
        "warnings": envelope.pointer("/data/warnings").and_then(Value::as_array)
            .map(|warnings| warnings.iter().take(8).cloned().collect::<Vec<_>>()).unwrap_or_default() }),
    )
}

fn compile_connected(
    project: &Path,
    deadline_at: u64,
    canceled: &AtomicBool,
) -> Result<Value, String> {
    let timeout = available_time(deadline_at, canceled, 125)?;
    let seconds = timeout.as_secs().saturating_sub(3).max(1).to_string();
    let project_path = project_argument(project);
    let (exit, envelope) = run_cli_result(
        project,
        "unity recompile",
        &[
            "recompile",
            "--project-path",
            &project_path,
            "--timeout",
            &seconds,
        ],
        timeout,
        Some(canceled),
    )?;
    connected_compilation_result(project, exit, &envelope).ok_or_else(||
        "UNITY_COMPILE_VERDICT_UNAVAILABLE: the connected Editor did not return a completed compilation result.".to_string())
}

fn batch_compile_diagnostics(project: &Path, log: impl Read) -> Vec<Value> {
    static COMPILER_ERROR: OnceLock<Regex> = OnceLock::new();
    let pattern = COMPILER_ERROR.get_or_init(|| {
        Regex::new(r"^(.+?)\((\d+),(\d+)\): error ([A-Z]+[0-9]+): (.+)$")
            .expect("compiler diagnostic regex")
    });
    let mut seen = HashSet::new();
    BufReader::new(log.take(8 * 1024 * 1024))
        .lines()
        .map_while(Result::ok)
        .filter_map(|line| {
            let diagnostic = pattern.captures(line.trim())?;
            let (_, [file, row, column, code, message]) = diagnostic.extract();
            seen.insert(line.trim().to_owned()).then(|| {
                compile_diagnostic(
                    project,
                    file,
                    row.parse().unwrap_or(0),
                    column.parse().unwrap_or(0),
                    code,
                    message,
                )
            })
        })
        .take(12)
        .collect()
}

fn compile_closed(
    project: &Path,
    editor: &ProjectEditor,
    deadline_at: u64,
    canceled: &AtomicBool,
) -> Result<Value, String> {
    let temp = tempfile::tempdir().map_err(|_| "UNITY_COMPILE_LOG_UNAVAILABLE".to_string())?;
    let log_path = temp.path().join("unity-compile.log");
    let result = run_batch_editor(
        project,
        editor,
        &log_path,
        &["-nographics", "-quit"],
        deadline_at,
        canceled,
    )?;
    let exit = result.exit_code;
    let log = fs::File::open(log_path)
        .map_err(|_| format!("UNITY_BATCH_COMPILE_LOG_UNAVAILABLE (exit {exit})"))?;
    let diagnostics = batch_compile_diagnostics(project, log);
    if !diagnostics.is_empty() {
        return Ok(json!({"status": "failed", "editor": "closed", "diagnostics": diagnostics}));
    }
    if result.success && exit == 0 {
        return Ok(json!({"status": "passed", "editor": "closed", "diagnostics": []}));
    }
    Err(format!(
        "UNITY_BATCH_COMPILE_VERDICT_UNAVAILABLE (exit {exit})"
    ))
}

const EDITOR_CHECK_TARGET_LIMIT: usize = 24;
const EDITOR_CHECK_FILE_BYTES: u64 = 16 * 1024 * 1024;

fn editor_check_versions(project: &Path, targets: &[String]) -> Result<Vec<Value>, String> {
    if targets.len() > EDITOR_CHECK_TARGET_LIMIT {
        return Err("UNITY_CHECK_TARGET_LIMIT".to_string());
    }
    targets
        .iter()
        .map(|target| {
            let relative = Path::new(target);
            let extension = relative
                .extension()
                .and_then(|ext| ext.to_str())
                .unwrap_or("")
                .to_ascii_lowercase();
            if !(relative.starts_with("Assets") || relative.starts_with("Packages"))
                || !relative
                    .components()
                    .all(|part| matches!(part, std::path::Component::Normal(_)))
                || !matches!(
                    extension.as_str(),
                    "cs" | "asmdef" | "asmref" | "shader" | "hlsl" | "cginc" | "compute"
                )
            {
                return Err("UNITY_INVALID_CHECK_TARGET".to_string());
            }
            let resolved =
                resolve_workspace_path(project, relative, WorkspacePathMode::AllowMissing)
                    .map_err(|_| "UNITY_CHECK_TARGET_UNAVAILABLE".to_string())?;
            if resolved.path() != project.join(relative) {
                return Err("UNITY_INVALID_CHECK_TARGET".to_string());
            }
            let version = match fs::File::open(resolved.path()) {
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
                Ok(file) if file.metadata().is_ok_and(|meta| meta.is_file()) => {
                    let mut bytes = Vec::new();
                    file.take(EDITOR_CHECK_FILE_BYTES + 1)
                        .read_to_end(&mut bytes)
                        .map_err(|_| "UNITY_CHECK_TARGET_UNAVAILABLE".to_string())?;
                    if bytes.len() as u64 > EDITOR_CHECK_FILE_BYTES {
                        return Err("UNITY_CHECK_TARGET_TOO_LARGE".to_string());
                    }
                    Some(format!("sha256-{:x}", Sha256::digest(bytes)))
                }
                _ => return Err("UNITY_CHECK_TARGET_UNAVAILABLE".to_string()),
            };
            Ok(json!({"path":target, "version":version}))
        })
        .collect()
}

fn run_editor_check(
    project: &Path,
    defer_closed: bool,
    kind: &str,
    targets: &[String],
    expected_versions: &HashMap<String, Option<String>>,
    shader_import_targets: Option<&[String]>,
    deadline_at: u64,
    canceled: &AtomicBool,
) -> Result<Value, String> {
    available_time(deadline_at, canceled, 1)?;
    let Some(editor) = ProjectEditor::read(project)? else {
        return Ok(json!({"status":"not_unity_project", "kind":kind}));
    };
    let before = editor_check_versions(project, targets)?;
    if expected_versions.iter().any(|(path, expected)| {
        !before.iter().any(|target| {
            target.get("path").and_then(Value::as_str) == Some(path.as_str())
                && target.get("version") == Some(&json!(expected))
        })
    }) {
        return Ok(json!({
            "status":"unavailable", "kind":kind,
            "message":"UNITY_CHECK_TARGET_CHANGED: checked bytes differ from the committed mutation."
        }));
    }
    let route = editor_route(project, &editor, deadline_at, canceled)?;
    let pid = match route {
        EditorRoute::Connected { pid } => Some(pid),
        EditorRoute::Closed => None,
    };
    if defer_closed && pid.is_none() {
        return Ok(
            json!({"status":"deferred_closed", "editor":"closed", "kind":kind, "targets":before}),
        );
    }
    let route_name = if pid.is_some() { "connected" } else { "closed" };
    let outcome = if kind == "shader_import" {
        if let Some(pid) = pid {
            let import_targets = targets
                .iter()
                .zip(&before)
                .filter_map(|(path, item)| {
                    let extension = Path::new(path).extension().and_then(|ext| ext.to_str())?;
                    (matches!(
                        extension.to_ascii_lowercase().as_str(),
                        "shader" | "compute"
                    ) && item.get("version") != Some(&Value::Null))
                    .then(|| path.clone())
                })
                .collect::<Vec<_>>();
            // The runtime only supplies a subset when current source evidence
            // links each versioned include to an exact Shader owner.
            let include_scope_proven = shader_import_targets == Some(import_targets.as_slice())
                && targets.iter().all(|path| expected_versions.get(path).is_some_and(Option::is_some));
            inspect_editor_check_permission(project, "unity command script eval")
                .and_then(|_| import_shaders_connected(project, pid, &import_targets, deadline_at, canceled))
                .map(|mut result| {
                    if import_targets.len() != targets.len() && !include_scope_proven && result["status"] == "passed" {
                        result["status"] = json!("unavailable");
                        result["message"] = json!("UNITY_SHADER_IMPORT_UNVERIFIED: changed includes or deleted assets need exact dependent Shader imports.");
                    }
                    result["importedPaths"] = json!(import_targets);
                    result
                })
        } else {
            Err("UNITY_SHADER_IMPORT_UNVERIFIED: a connected Editor is required for verified Shader import.".to_string())
        }
    } else {
        let operation = if pid.is_some() {
            "unity recompile"
        } else {
            "unity run ."
        };
        inspect_editor_check_permission(project, operation)?;
        match pid {
            Some(_) => compile_connected(project, deadline_at, canceled),
            None => compile_closed(project, &editor, deadline_at, canceled),
        }
    };
    let mut result = match outcome {
        Ok(result) if editor_check_versions(project, targets)? == before => {
            if let Some(pid) = pid {
                if !matches!(editor_route(project, &editor, deadline_at, canceled), Ok(EditorRoute::Connected { pid: current }) if current == pid)
                {
                    json!({"status":"unavailable", "message":"UNITY_EDITOR_INSTANCE_CHANGED: the Editor instance could not be revalidated."})
                } else {
                    result
                }
            } else {
                result
            }
        }
        Ok(_) => {
            json!({"status":"unavailable", "message":"UNITY_CHECK_TARGET_CHANGED: a checked file changed during validation."})
        }
        Err(error) => json!({"status":"unavailable", "message":error}),
    };
    result["editor"] = json!(route_name);
    result["editorPid"] = json!(pid);
    result["editorVersion"] = json!(editor.version);
    result["kind"] = json!(kind);
    result["targets"] = json!(before);
    Ok(result)
}

fn inspect_editor_check_permission(project: &Path, operation: &str) -> Result<(), String> {
    let guard = crate::harness::permissions::PermissionGuard::from_workspace(project)
        .map_err(|error| error.to_string())?;
    let decision = guard.inspect(operation);
    use crate::harness::permissions::PermissionDecisionKind;
    if decision.decision == PermissionDecisionKind::Deny
        || decision.segment_decisions.iter().any(|segment| {
            segment.decision == PermissionDecisionKind::Ask && segment.matched_rule.is_some()
        })
    {
        return Err(
            "UNITY_COMPILE_POLICY_DENIED: project permissions deny the Editor check.".to_string(),
        );
    }
    Ok(())
}

pub(crate) fn live_playmode_filter(inspection: &TrustedShellInspection) -> Option<&str> {
    let [segment] = inspection.segments.as_slice() else {
        return None;
    };
    let [program, action, tests, start, args @ ..] = segment.words.as_slice() else {
        return None;
    };
    if !segment.redirections.is_empty()
        || !program.rsplit(['/', '\\']).next().is_some_and(|name| {
            name.eq_ignore_ascii_case("unity") || name.eq_ignore_ascii_case("unity.exe")
        })
        || (action.as_str(), tests.as_str(), start.as_str()) != ("command", "test", "run")
        || !args.iter().any(|argument| argument == "--async-tests")
    {
        return None;
    }
    let args = args.iter().map(String::as_str).collect::<Vec<_>>();
    if exact_argument(&args, "--project-path")? != Some(".")
        || !exact_argument(&args, "--mode")?
            .is_some_and(|mode| mode.eq_ignore_ascii_case("playmode"))
    {
        return None;
    }
    exact_argument(&args, "--filter")?
}

pub(crate) fn run_live_playmode(
    project: &Path,
    directory: &Path,
    filter: &str,
    timeout: Duration,
    canceled: Option<&AtomicBool>,
    start: impl FnOnce(Duration) -> Result<TerminalCommandOutput, String>,
) -> Result<TerminalCommandOutput, String> {
    if project != directory {
        return Err("UNITY_PLAYMODE_PROJECT_SCOPE: run the reviewed check from the exact Unity workspace root".to_string());
    }
    let started = Instant::now();
    let remaining = || {
        if canceled.is_some_and(|flag| flag.load(Ordering::Acquire)) {
            Duration::ZERO
        } else {
            timeout.saturating_sub(started.elapsed())
        }
    };
    let project_arg = project_argument(project);
    let common = [
        "--project-path",
        &project_arg,
        "--caller",
        "plugin",
        "--skill",
        "unity-cli",
    ];
    let query = ["command", "test", "status"]
        .into_iter()
        .chain(common)
        .collect::<Vec<_>>();
    let status = run_cli(
        project,
        "unity test status",
        &query,
        remaining().min(Duration::from_secs(8)),
    )?;
    if !reports_exact_project(project, &status)
        || !matches!(
            status
                .pointer("/data/result/status")
                .and_then(Value::as_str),
            Some("no_tests" | "completed" | "error")
        )
    {
        return Err(
            "UNITY_PLAYMODE_BUSY: an Editor test run is already active or its state is unavailable"
                .to_string(),
        );
    }
    let busy_probe = "return UnityEditor.EditorApplication.isPlayingOrWillChangePlaymode || UnityEditor.EditorApplication.isCompiling || (bool)(typeof(UnityEditor.TestTools.TestRunner.Api.TestRunnerApi).GetMethod(\"IsRunActive\", System.Reflection.BindingFlags.Static | System.Reflection.BindingFlags.NonPublic)?.Invoke(null, null) ?? true);";
    let query = ["command", "script", "eval", "--code", busy_probe]
        .into_iter()
        .chain(common)
        .collect::<Vec<_>>();
    let editor = run_cli(
        project,
        "unity Editor readiness",
        &query,
        remaining().min(Duration::from_secs(8)),
    )?;
    if !reports_exact_project(project, &editor)
        || editor
            .pointer("/data/result/result")
            .and_then(Value::as_bool)
            != Some(false)
        || remaining().is_zero()
    {
        return Err(
            "UNITY_PLAYMODE_BUSY: the Editor is compiling, playing, or running tests".to_string(),
        );
    }
    const STATUS_FILE: &str = "Temp/pipeline_test_status.json";
    let status_path = project.join(STATUS_FILE);
    let before = fs::symlink_metadata(&status_path)
        .ok()
        .and_then(|metadata| metadata.modified().ok());
    let invoked = SystemTime::now();
    let mut output = start(remaining())?;
    if !output.success {
        return Ok(output);
    }
    let envelope = serde_json::from_str::<Value>(&output.stdout)
        .ok()
        .filter(|envelope| reports_exact_project(project, envelope));
    let ack = envelope
        .as_ref()
        .and_then(|envelope| envelope.pointer("/data/result"));
    let filter_applied = ack
        .as_ref()
        .and_then(|result| result.get("FilterApplied"))
        .and_then(Value::as_str)
        .and_then(|applied| applied.split_once(": "));
    if ack
        .as_ref()
        .and_then(|result| result.get("success"))
        .and_then(Value::as_bool)
        != Some(true)
        || ack
            .as_ref()
            .and_then(|result| result.get("StatusPath"))
            .and_then(Value::as_str)
            != Some(STATUS_FILE)
        || ack
            .as_ref()
            .and_then(|result| result.get("Mode"))
            .and_then(Value::as_str)
            != Some("PlayMode")
        || !filter_applied
            .is_some_and(|(kind, value)| kind.eq_ignore_ascii_case("testname") && value == filter)
    {
        return Ok(output); // A dispatch without the exact acknowledgment cannot pass validation.
    }
    while !remaining().is_zero() {
        if let Some(mut report) = fresh_live_report(project, &status_path, before, invoked) {
            match report.get("status").and_then(Value::as_str) {
                Some("completed") => {
                    report["success"] = json!(true);
                    report["mode"] = json!("PlayMode");
                    report["filterApplied"] = json!(format!("testname: {filter}"));
                    output.stdout =
                        json!({"success": true, "data": {"result": report}}).to_string();
                    output.duration_ms = started.elapsed().as_millis();
                    return Ok(output);
                }
                Some("error" | "cancelled" | "canceled") => {
                    output.success = false;
                    output.stderr = format!("Unity PlayMode did not finish successfully: {report}");
                    return Ok(output);
                }
                _ => {}
            }
        }
        thread::sleep(remaining().min(Duration::from_millis(250)));
    }
    output.success = false;
    output.timed_out = true;
    output.stderr =
        "Unity PlayMode did not publish a fresh completed report within the bounded check."
            .to_string();
    Ok(output)
}

fn managed_playmode_filter(command: &str) -> Option<&str> {
    let words = command.split_ascii_whitespace().collect::<Vec<_>>();
    let [unity, test, ".", "--mode", mode, "--filter", filter] = words.as_slice() else {
        return None;
    };
    (unity.eq_ignore_ascii_case("unity")
        && test.eq_ignore_ascii_case("test")
        && mode.eq_ignore_ascii_case("playmode")
        && filter.len() <= 200
        && filter
            .as_bytes()
            .first()
            .is_some_and(|byte| byte.is_ascii_alphabetic() || *byte == b'_')
        && filter
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_')))
    .then_some(*filter)
}

fn test_project_playmode(
    project: &Path,
    filter: &str,
    deadline_at: u64,
    canceled: &AtomicBool,
) -> Result<TerminalCommandOutput, String> {
    let editor = ProjectEditor::read(project)?
        .ok_or_else(|| "UNITY_PROJECT_REQUIRED: ProjectVersion.txt is unavailable".to_string())?;
    if matches!(
        editor_route(project, &editor, deadline_at, canceled)?,
        EditorRoute::Connected { .. }
    ) {
        let compilation = compile_connected(project, deadline_at, canceled)?;
        if compilation.get("status").and_then(Value::as_str) != Some("passed") {
            return Err(format!("UNITY_COMPILE_FAILED: {compilation}"));
        }
        let project_path = project_argument(project);
        let args = [
            "command",
            "test",
            "run",
            "--project-path",
            &project_path,
            "--caller",
            "plugin",
            "--skill",
            "unity-cli",
            "--mode",
            "playmode",
            "--filter",
            filter,
            "--async-tests",
            "--timeout",
            "90",
        ];
        let process = unity_cli_command(project, &args)?;
        return run_live_playmode(
            project,
            project,
            filter,
            available_time(deadline_at, canceled, 100)?,
            Some(canceled),
            |remaining| {
                capture_command_output_with_cancel(
                    process,
                    "Editor PlayMode",
                    None,
                    remaining,
                    Some(canceled),
                )
            },
        );
    }

    let temp = tempfile::tempdir().map_err(|_| "UNITY_TEST_REPORT_UNAVAILABLE".to_string())?;
    let report = temp.path().join("tests.xml");
    let log = temp.path().join("editor.log");
    let escaped_filter = regex::escape(filter);
    let mut output = run_batch_editor(
        project,
        &editor,
        &log,
        &[
            "-runTests",
            "-testPlatform",
            "PlayMode",
            "-testFilter",
            &escaped_filter,
            "-testResults",
            &project_argument(&report),
        ],
        deadline_at,
        canceled,
    )?;
    let matched = nunit_filter(&escaped_filter).unwrap_or_default();
    let report_bytes = (|| {
        let metadata = fs::symlink_metadata(&report).ok()?;
        if !metadata.is_file() || metadata.len() > 4 * 1024 * 1024 {
            return None;
        }
        fs::read(report).ok()
    })();
    let verified = report_bytes
        .as_deref()
        .filter(|_| output.success)
        .and_then(|bytes| parse_nunit_pass(bytes, &matched));
    output.unity_test_reports = Some(match verified {
        Some(passed) => json!([{ "status": "verified", "passed": passed }]),
        None => json!([{ "status": "fresh_nonempty_passing_report_unavailable" }]),
    });
    output.stdout = match verified {
        Some(passed) => format!("PlayMode: {passed} matching tests passed ({filter})."),
        None => report_bytes
            .as_deref()
            .and_then(nunit_report_summary)
            .unwrap_or_else(|| {
                format!("PlayMode did not return a fresh nonempty passing report for {filter}.")
            }),
    };
    if let Ok(log) = fs::File::open(log) {
        let diagnostics = batch_compile_diagnostics(project, log);
        if !diagnostics.is_empty() {
            output.success = false;
            output.stderr = serde_json::to_string(&diagnostics).unwrap_or_default();
        }
    }
    Ok(output)
}

fn fresh_live_report(
    project: &Path,
    path: &Path,
    before: Option<SystemTime>,
    invoked: SystemTime,
) -> Option<Value> {
    let resolved = resolve_workspace_path(project, path, WorkspacePathMode::Existing).ok()?;
    if resolved.path() != path {
        return None;
    }
    let metadata = fs::symlink_metadata(path).ok()?;
    let modified = metadata.modified().ok()?;
    if !metadata.is_file()
        || metadata.len() > 1_048_576
        || modified < invoked
        || before.is_some_and(|stamp| modified <= stamp)
    {
        return None;
    }
    serde_json::from_str(&fs::read_to_string(path).ok()?).ok()
}

fn scene_program(path: &str, root_name: &str, script_path: &str) -> String {
    let path = json!(path);
    let root_name = json!(root_name);
    let script_path = json!(script_path);
    format!(
        r#"
var path = {path};
var absolutePath = System.IO.Path.Combine(UnityEngine.Application.dataPath, path.Substring(7));
if (UnityEditor.EditorApplication.isPlayingOrWillChangePlaymode || UnityEditor.EditorApplication.isCompiling)
    throw new System.InvalidOperationException("The Editor is playing or compiling.");
if (System.IO.File.Exists(absolutePath) || !string.IsNullOrEmpty(UnityEditor.AssetDatabase.AssetPathToGUID(path, UnityEditor.AssetPathToGUIDOptions.OnlyExistingAssets)))
    throw new System.InvalidOperationException("The target scene already exists.");
var script = UnityEditor.AssetDatabase.LoadAssetAtPath<UnityEditor.MonoScript>({script_path});
var componentType = script == null ? null : script.GetClass();
if (componentType == null || componentType.IsAbstract || !typeof(UnityEngine.MonoBehaviour).IsAssignableFrom(componentType))
    throw new System.InvalidOperationException("The script has no compiled concrete MonoBehaviour.");
var active = UnityEngine.SceneManagement.SceneManager.GetActiveScene();
for (int index = 0; index < UnityEngine.SceneManagement.SceneManager.sceneCount; index++)
    if (string.IsNullOrEmpty(UnityEngine.SceneManagement.SceneManager.GetSceneAt(index).path))
        throw new System.InvalidOperationException("Save or close the untitled scene before adding a new scene. Existing scenes are left alone.");
var scene = UnityEditor.SceneManagement.EditorSceneManager.NewScene(UnityEditor.SceneManagement.NewSceneSetup.EmptyScene, UnityEditor.SceneManagement.NewSceneMode.Additive);
try {{
    var root = new UnityEngine.GameObject({root_name});
    UnityEngine.SceneManagement.SceneManager.MoveGameObjectToScene(root, scene);
    var component = root.AddComponent(componentType);
    if (component == null || root.GetComponent(componentType) == null || scene.rootCount != 1)
        throw new System.InvalidOperationException("The scene did not receive the requested component and single root.");
    if (System.IO.File.Exists(absolutePath) || !UnityEditor.SceneManagement.EditorSceneManager.SaveScene(scene, path))
        throw new System.InvalidOperationException("The exact new scene could not be saved.");
    return path;
}} finally {{
    if (active.IsValid() && active.isLoaded) UnityEngine.SceneManagement.SceneManager.SetActiveScene(active);
    if (scene.IsValid() && scene.isLoaded) UnityEditor.SceneManagement.EditorSceneManager.CloseScene(scene, true);
}}
"#
    )
}

fn create_scene(
    project: &Path,
    path: &str,
    root_name: &str,
    script_path: &str,
    deadline_at: u64,
    canceled: &AtomicBool,
) -> Result<Value, String> {
    let path = asset_path(path, "unity")?;
    let script_path = asset_path(script_path, "cs")?;
    if root_name.trim().is_empty()
        || root_name.len() > 128
        || root_name.chars().any(char::is_control)
    {
        return Err("UNITY_INVALID_ROOT_NAME: use a nonempty single-line name".to_string());
    }
    let editor = ProjectEditor::read(project)?
        .ok_or_else(|| "UNITY_PROJECT_REQUIRED: ProjectVersion.txt is unavailable".to_string())?;
    let target = resolve_workspace_path(project, path, WorkspacePathMode::AllowMissing)
        .map_err(|error| format!("UNITY_INVALID_ASSET_PATH: {error}"))?;
    let script = resolve_workspace_path(project, script_path, WorkspacePathMode::Existing)
        .map_err(|error| format!("UNITY_SCRIPT_UNAVAILABLE: {error}"))?;
    if target.path() != project.join(path)
        || script.path() != project.join(script_path)
        || !script.path().is_file()
        || !target.path().parent().is_some_and(Path::is_dir)
    {
        return Err("UNITY_INVALID_ASSET_PATH: the script and scene parent must be real paths in this project".to_string());
    }
    if target.path().exists() {
        return Err(
            "UNITY_SCENE_ALREADY_EXISTS: inspect the scene before making further changes"
                .to_string(),
        );
    }
    if !matches!(
        editor_route(project, &editor, deadline_at, canceled)?,
        EditorRoute::Connected { .. }
    ) {
        return Err(
            "UNITY_EDITOR_NOT_READY: open this project in a compatible Pipeline Editor".to_string(),
        );
    }
    let project_path = project_argument(project);
    let discovery = run_cli(
        project,
        "unity command discovery",
        &[
            "command",
            "--project-path",
            &project_path,
            "--caller",
            "plugin",
            "--skill",
            "unity-cli",
            "--group-by",
            "flat",
            "--limit",
            "1",
        ],
        available_time(deadline_at, canceled, 10)?,
    )?;
    if !reports_exact_project(project, &discovery) {
        return Err(
            "UNITY_EDITOR_NOT_READY: open this project in a ready Unity Editor and retry"
                .to_string(),
        );
    }
    let compile = compile_connected(project, deadline_at, canceled)?;
    if compile.get("status").and_then(Value::as_str) != Some("passed") {
        return Err(format!("UNITY_COMPILE_FAILED: {compile}"));
    }
    let program = scene_program(path, root_name, script_path);
    let result = run_cli(
        project,
        "unity create scene",
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
            "25",
            "--code",
            &program,
        ],
        available_time(deadline_at, canceled, 30)?,
    );
    if let Err(error) = &result {
        if target.path().exists() {
            return Err(format!("UNITY_SCENE_RESULT_UNCERTAIN: {error}. The target now exists. Inspect it before continuing."));
        }
    }
    let result = result?;
    if result
        .pointer("/data/result/success")
        .and_then(Value::as_bool)
        != Some(true)
        || result
            .pointer("/data/result/result")
            .and_then(Value::as_str)
            != Some(path)
        || !fs::symlink_metadata(target.path())
            .is_ok_and(|metadata| metadata.is_file() && metadata.len() > 0)
    {
        return Err("UNITY_SCENE_RESULT_UNCERTAIN: the CLI did not verify the new scene. Inspect it before continuing.".to_string());
    }
    let version = fs::read(target.path())
        .map(|bytes| format!("sha256-{:x}", Sha256::digest(bytes)))
        .map_err(|error| format!("UNITY_SCENE_RESULT_UNCERTAIN: {error}"))?;
    Ok(
        json!({"success": true, "path": path, "version": version, "scriptPath": script_path,
        "changedPaths": [path], "warnings": compile.get("warnings")}),
    )
}

#[tauri::command]
pub async fn unity_create_scene(
    state: State<'_, WorkspaceState>,
    workspace: String,
    path: String,
    root_name: String,
    script_path: String,
    operation_id: String,
    deadline_at: u64,
) -> Result<Value, String> {
    if workspace.trim().is_empty() {
        return Err("UNITY_PROJECT_REQUIRED: no admitted workspace".to_string());
    }
    let project: PathBuf = resolve_workspace_root(&state, Some(workspace))?;
    let canceled = editor_cancellation(&operation_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let _lock = get_workspace_write_lock()
            .lock()
            .map_err(|_| "Workspace write lock is unavailable".to_string())?;
        let result = create_scene(
            &project,
            &path,
            &root_name,
            &script_path,
            deadline_at,
            &canceled,
        );
        if let Ok(mut active) = editor_cancellations().lock() {
            active.remove(&operation_id);
        }
        result
    })
    .await
    .map_err(|error| format!("UNITY_SCENE_TASK_FAILED: {error}"))?
}

#[tauri::command]
pub async fn unity_probe_editor(
    state: State<'_, WorkspaceState>,
    workspace: String,
    operation_id: String,
    deadline_at: u64,
) -> Result<Value, String> {
    if workspace.trim().is_empty() {
        return Err("UNITY_PROJECT_REQUIRED".to_string());
    }
    let project = resolve_workspace_root(&state, Some(workspace))?;
    let canceled = editor_cancellation(&operation_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let result = (|| {
            let Some(editor) = ProjectEditor::read(&project)? else {
                return Ok(json!({"route": "unavailable"}));
            };
            inspect_editor_check_permission(&project, "unity status")?;
            let route = editor_route(&project, &editor, deadline_at, &canceled)?;
            Ok(match route {
                EditorRoute::Connected { pid } => json!({"route": "connected", "pid": pid, "version": editor.version}),
                EditorRoute::Closed => json!({"route": "closed", "version": editor.version}),
            })
        })();
        if let Ok(mut active) = editor_cancellations().lock() {
            active.remove(&operation_id);
        }
        result
    })
    .await
    .map_err(|error| format!("UNITY_EDITOR_PROBE_FAILED: {error}"))?
}

#[tauri::command]
pub async fn unity_compile_project(
    state: State<'_, WorkspaceState>,
    workspace: String,
    defer_closed: bool,
    check_kind: Option<String>,
    targets: Option<Vec<String>>,
    expected_versions: Option<HashMap<String, Option<String>>>,
    shader_import_targets: Option<Vec<String>>,
    operation_id: String,
    deadline_at: u64,
) -> Result<Value, String> {
    if workspace.trim().is_empty() {
        return Err("UNITY_PROJECT_REQUIRED: no admitted workspace".to_string());
    }
    let project = resolve_workspace_root(&state, Some(workspace))?;
    let canceled = editor_cancellation(&operation_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let kind = check_kind.as_deref().unwrap_or("csharp");
        let result = match kind {
            "csharp" | "shader_import" => run_editor_check(
                &project,
                defer_closed,
                kind,
                targets.as_deref().unwrap_or_default(),
                &expected_versions.unwrap_or_default(),
                shader_import_targets.as_deref(),
                deadline_at,
                &canceled,
            ),
            _ => Err("UNITY_INVALID_CHECK_KIND".to_string()),
        };
        if let Ok(mut active) = editor_cancellations().lock() {
            active.remove(&operation_id);
        }
        result
    })
    .await
    .map_err(|error| format!("UNITY_COMPILE_TASK_FAILED: {error}"))?
}

#[tauri::command]
pub async fn unity_test_project(
    state: State<'_, WorkspaceState>,
    workspace: String,
    approved_command: String,
    permission_approval: Option<crate::harness::permissions::ShellPermissionApproval>,
    operation_id: String,
    deadline_at: u64,
) -> Result<TerminalCommandOutput, String> {
    if workspace.trim().is_empty() {
        return Err("UNITY_PROJECT_REQUIRED: no admitted workspace".to_string());
    }
    let project = resolve_workspace_root(&state, Some(workspace))?;
    let canceled = editor_cancellation(&operation_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let result = (|| {
            let filter = managed_playmode_filter(&approved_command)
                .ok_or_else(|| "UNITY_PLAYMODE_COMMAND_INVALID: expected the reviewed exact project PlayMode command".to_string())?;
            crate::harness::permissions::PermissionGuard::from_workspace(&project)
                .and_then(|guard| guard.validate_with_approval(&approved_command, permission_approval.as_ref()))
                .map_err(|error| error.to_string())?;
            test_project_playmode(&project, filter, deadline_at, &canceled)
        })();
        if let Ok(mut active) = editor_cancellations().lock() {
            active.remove(&operation_id);
        }
        result
    }).await.map_err(|error| format!("UNITY_PLAYMODE_TASK_FAILED: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::trusted_execution::inspect_shell_command_in_workspace;

    const REPORT: &str = r#"<?xml version="1.0" encoding="utf-8"?>
<test-run total="1" passed="1" failed="0" skipped="0" inconclusive="0" result="Passed">
  <test-suite><test-case result="Passed" fullname="Fixture.SceneLoads" /></test-suite>
</test-run>"#;

    #[test]
    fn engine_and_exact_editor_version_come_from_the_project() {
        let unity = ProjectEditor::parse("m_EditorVersion: 6000.6.5f1\n").unwrap();
        assert_eq!(unity.name(), "Unity");
        assert!(unity.matches_binary_version("6000.6.5f1"));
        assert!(!unity.matches_binary_version("6000.6.5f10"));
        let tuanjie =
            ProjectEditor::parse("m_EditorVersion: 2022.3.62t16\nm_TuanjieEditorVersion: 1.10.4\n")
                .unwrap();
        assert_eq!(tuanjie.name(), "Tuanjie");
        assert!(tuanjie.matches_binary_version("2022.3.62t16.git.tuanjie/1.10/staging.11212648"));
        assert!(!tuanjie.matches_binary_version("2022.3.62t12"));
        assert!(ProjectEditor::parse("m_EditorVersion: ../../Unity").is_err());
        assert!(
            ProjectEditor::parse("m_EditorVersion: 2022.3.62t16\nm_TuanjieEditorVersion: ")
                .is_err()
        );
    }

    #[test]
    fn tuanjie_lock_prevents_batch_when_the_lock_state_is_inconclusive() {
        let fixture = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(fixture.path()).unwrap();
        let editor =
            ProjectEditor::parse("m_EditorVersion: 2022.3.62t16\nm_TuanjieEditorVersion: 1.10.4")
                .unwrap();
        let canceled = AtomicBool::new(false);
        assert!(project_editor_closed(&root, &editor, u64::MAX, &canceled));
        fs::create_dir_all(root.join("Temp/TuanjieLockfile")).unwrap();
        assert!(!project_editor_closed(&root, &editor, u64::MAX, &canceled));
    }

    #[test]
    fn connected_shader_import_requires_the_same_instance_and_completed_file_set() {
        let fixture = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(fixture.path()).unwrap();
        let editor = ProjectEditor::parse("m_EditorVersion: 6000.6.5f1").unwrap();
        let status = json!({"data":{"instances":[
            {"project":root, "version":"6000.6.5f0", "pid":99},
            {"project":root, "version":"6000.6.5f1", "pid":42}
        ]}});
        assert_eq!(exact_editor_instance(&root, &editor, &status), Some(42));
        let target = "Assets/Atmosphere.shader".to_string();
        let paths = std::slice::from_ref(&target);
        let mut result = json!({"success":true,"data":{"target":{"projectPath":root},"result":{
            "success":true,"result":{"pid":42,"imports":[
                {"path":target,"completed":true,"diagnostics":[{"line":17,"message":"Couldn't open include file."}]}
            ]}
        }}});
        assert!(connected_shader_import_result(&root, 99, paths, &result).is_none());
        let failed = connected_shader_import_result(&root, 42, paths, &result).unwrap();
        assert_eq!(failed["status"], "failed");
        assert_eq!(failed["diagnostics"][0]["file"], target);
        result["data"]["result"]["result"]["imports"][0]["diagnostics"] = json!([]);
        assert_eq!(
            connected_shader_import_result(&root, 42, paths, &result).unwrap()["status"],
            "passed"
        );
        result["data"]["result"]["result"]["imports"][0]["completed"] = json!(false);
        assert_eq!(
            connected_shader_import_result(&root, 42, paths, &result).unwrap()["status"],
            "unavailable"
        );
    }

    #[test]
    fn editor_check_rejects_changed_committed_bytes_before_connecting() {
        let fixture = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(fixture.path()).unwrap();
        fs::create_dir(root.join("Assets")).unwrap();
        fs::create_dir(root.join("ProjectSettings")).unwrap();
        fs::write(
            root.join("ProjectSettings/ProjectVersion.txt"),
            "m_EditorVersion: 6000.6.5f1",
        )
        .unwrap();
        fs::write(root.join("Assets/Changed.cs"), "different contents").unwrap();
        let path = "Assets/Changed.cs".to_string();
        let expected = HashMap::from([(path.clone(), Some(format!("sha256-{}", "b".repeat(64))))]);
        let result = run_editor_check(
            &root,
            false,
            "csharp",
            &[path],
            &expected,
            None,
            u64::MAX,
            &AtomicBool::new(false),
        )
        .unwrap();
        assert_eq!(result["status"], "unavailable");
        assert!(result["message"]
            .as_str()
            .unwrap()
            .contains("UNITY_CHECK_TARGET_CHANGED"));
    }

    #[test]
    fn compile_failure_keeps_structured_source_diagnostics() {
        let envelope = json!({"success": false, "command": "recompile", "data": {
            "status": "completed", "failed": true, "errors": [{
                "file": "Assets/Tests/BreakoutTests.cs", "line": 88, "column": 10, "code": "CS0246",
                "message": "The type or namespace name UnityTest could not be found."
            }]
        }});
        let root = Path::new("/fixture");
        let result = connected_compilation_result(root, 6, &envelope).unwrap();
        assert_eq!(result.get("status").and_then(Value::as_str), Some("failed"));
        assert_eq!(
            result
                .pointer("/diagnostics/0/line")
                .and_then(Value::as_u64),
            Some(88)
        );
        let log = b"Assets/Tests/BreakoutTests.cs(88,10): error CS0246: Missing reference\n";
        let result = batch_compile_diagnostics(root, &log[..]);
        assert_eq!(
            result[0].get("code").and_then(Value::as_str),
            Some("CS0246")
        );
        assert_eq!(
            managed_playmode_filter("unity test . --mode PlayMode --filter BreakoutTests"),
            Some("BreakoutTests")
        );
        assert!(managed_playmode_filter(
            "unity test . --mode PlayMode --filter BreakoutTests && echo ok"
        )
        .is_none());
    }

    #[test]
    #[ignore = "launches a matching batch Editor on a newly created disposable project"]
    fn disposable_project_batch_compiles_bad_then_fixed_csharp() {
        let version = std::env::var("MAIN_DISPOSABLE_EDITOR_VERSION").unwrap();
        let tuanjie = std::env::var("MAIN_DISPOSABLE_TUANJIE_VERSION").ok();
        let root = tempfile::tempdir().unwrap();
        let root_path = fs::canonicalize(root.path()).unwrap();
        fs::create_dir(root_path.join("Assets")).unwrap();
        fs::create_dir(root_path.join("Packages")).unwrap();
        fs::create_dir(root_path.join("ProjectSettings")).unwrap();
        let mut version_file = format!("m_EditorVersion: {version}\n");
        if let Some(tuanjie) = tuanjie {
            version_file.push_str(&format!("m_TuanjieEditorVersion: {tuanjie}\n"));
        }
        fs::write(
            root_path.join("ProjectSettings/ProjectVersion.txt"),
            version_file,
        )
        .unwrap();
        fs::write(
            root_path.join("Packages/manifest.json"),
            r#"{"dependencies":{}}"#,
        )
        .unwrap();
        assert_disposable_csharp_results(&root_path, "closed");
    }

    #[test]
    #[ignore = "requires a disposable project with a connected Pipeline Editor"]
    fn disposable_connected_editor_compiles_bad_then_fixed_csharp() {
        let project =
            fs::canonicalize(std::env::var_os("MAIN_DISPOSABLE_UNITY_FIXTURE").unwrap()).unwrap();
        assert_eq!(
            fs::read_to_string(project.join(".main-unity-disposable"))
                .unwrap()
                .trim(),
            "isolated test workspace",
        );
        assert_disposable_csharp_results(&project, "connected");
    }

    fn assert_disposable_csharp_results(project: &Path, route: &str) {
        let target = "Assets/CompileProbe.cs".to_string();
        let target_path = project.join(&target);
        let canceled = AtomicBool::new(false);
        for (content, expected) in [
            (
                "public class CompileProbe { public MissingFixtureType Value; }",
                "failed",
            ),
            (
                "public class CompileProbe { public int Value => 7; }",
                "passed",
            ),
        ] {
            fs::write(&target_path, content).unwrap();
            let version = format!("sha256-{:x}", Sha256::digest(content.as_bytes()));
            let versions = HashMap::from([(target.clone(), Some(version.clone()))]);
            let now = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_millis() as u64;
            let result = run_editor_check(
                project,
                false,
                "csharp",
                std::slice::from_ref(&target),
                &versions,
                None,
                now + 150_000,
                &canceled,
            )
            .unwrap();
            assert_eq!(result["status"], expected, "{result}");
            assert_eq!(result["editor"], route);
            if route == "connected" {
                assert!(result["editorPid"].as_u64().unwrap() > 0);
            }
            assert_eq!(result["targets"][0]["version"], version);
            if expected == "failed" {
                assert_eq!(result["diagnostics"][0]["file"], target, "{result}");
                assert_eq!(result["diagnostics"][0]["code"], "CS0246", "{result}");
            }
        }
    }

    #[test]
    #[ignore = "requires a disposable project with a connected Pipeline Editor"]
    fn disposable_connected_editor_imports_bad_then_fixed_shader() {
        let project =
            fs::canonicalize(std::env::var_os("MAIN_DISPOSABLE_UNITY_FIXTURE").unwrap()).unwrap();
        assert_eq!(
            fs::read_to_string(project.join(".main-unity-disposable"))
                .unwrap()
                .trim(),
            "isolated test workspace",
        );
        let target = "Assets/ImportProbe.shader".to_string();
        let source = r#"Shader "Fixture/ImportProbe" {
            SubShader { Pass {
                CGPROGRAM
                #pragma vertex vert
                #pragma fragment frag
                INJECT_INCLUDE
                float4 vert(float4 position : POSITION) : SV_POSITION { return position; }
                float4 frag() : SV_Target { return float4(1, 0, 0, 1); }
                ENDCG
            } }
        }"#;
        let canceled = AtomicBool::new(false);
        for (include, expected) in [
            ("#include \"MAIN_MissingShaderFixture.hlsl\"", "failed"),
            ("", "passed"),
        ] {
            let content = source.replace("INJECT_INCLUDE", include);
            fs::write(project.join(&target), &content).unwrap();
            let version = format!("sha256-{:x}", Sha256::digest(content.as_bytes()));
            let versions = HashMap::from([(target.clone(), Some(version.clone()))]);
            let now = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_millis() as u64;
            let result = run_editor_check(
                &project,
                false,
                "shader_import",
                std::slice::from_ref(&target),
                &versions,
                None,
                now + 100_000,
                &canceled,
            )
            .unwrap();
            assert_eq!(result["status"], expected, "{result}");
            assert_eq!(result["editor"], "connected");
            assert!(result["editorPid"].as_u64().unwrap() > 0);
            assert_eq!(result["targets"][0]["version"], version);
            if expected == "failed" {
                assert_eq!(result["diagnostics"][0]["file"], target, "{result}");
                assert_eq!(
                    result["diagnostics"][0]["code"], "SHADER_IMPORT",
                    "{result}"
                );
            }
        }
    }

    #[test]
    #[ignore = "requires a disposable Unity or Tuanjie project with the fixture PlayMode suite"]
    fn project_editor_compiles_and_verifies_playmode() {
        let project =
            fs::canonicalize(std::env::var_os("MAIN_DISPOSABLE_UNITY_FIXTURE").unwrap()).unwrap();
        assert_eq!(
            fs::read_to_string(project.join(".main-unity-disposable"))
                .unwrap()
                .trim(),
            "isolated test workspace"
        );
        let route = std::env::var("MAIN_FIXTURE_EDITOR_ROUTE").unwrap();
        let deadline = || {
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_millis() as u64
                + 120_000
        };
        let canceled = AtomicBool::new(false);
        let probe = project.join("Assets/CompileProbe.cs");
        fs::write(
            &probe,
            "public class CompileProbe { public MissingFixtureType Value; }",
        )
        .unwrap();
        let failed = run_editor_check(
            &project,
            false,
            "csharp",
            &["Assets/CompileProbe.cs".to_string()],
            &HashMap::new(),
            None,
            deadline(),
            &canceled,
        )
        .unwrap();
        assert_eq!(
            failed.get("status").and_then(Value::as_str),
            Some("failed"),
            "{failed}"
        );
        assert_eq!(
            failed.get("editor").and_then(Value::as_str),
            Some(route.as_str())
        );
        assert_eq!(
            failed
                .pointer("/diagnostics/0/code")
                .and_then(Value::as_str),
            Some("CS0246"),
            "{failed}"
        );
        fs::write(
            &probe,
            "public class CompileProbe { public int Value => 7; }",
        )
        .unwrap();
        let passed = run_editor_check(
            &project,
            false,
            "csharp",
            &["Assets/CompileProbe.cs".to_string()],
            &HashMap::new(),
            None,
            deadline(),
            &canceled,
        )
        .unwrap();
        assert_eq!(
            passed.get("status").and_then(Value::as_str),
            Some("passed"),
            "{passed}"
        );
        let tests =
            test_project_playmode(&project, "FixturePlayModeTests", deadline(), &canceled).unwrap();
        assert!(
            tests.success,
            "{}",
            tests.stderr.chars().take(1200).collect::<String>()
        );
        if route == "connected" {
            let data: Value = serde_json::from_str(&tests.stdout).unwrap();
            assert_eq!(
                data.pointer("/data/result/summary/passed")
                    .and_then(Value::as_u64),
                Some(1),
                "{data}"
            );
        } else {
            assert_eq!(
                tests
                    .unity_test_reports
                    .unwrap()
                    .pointer("/0/passed")
                    .and_then(Value::as_u64),
                Some(1)
            );
        }
        let missing = test_project_playmode(
            &project,
            "NoSuchFixturePlayModeSuite",
            deadline(),
            &canceled,
        )
        .unwrap();
        if route == "connected" {
            assert!(
                serde_json::from_str::<Value>(&missing.stdout)
                    .unwrap()
                    .pointer("/data/result/summary/passed")
                    .and_then(Value::as_u64)
                    .unwrap_or(0)
                    == 0
            );
        } else {
            assert_eq!(
                missing
                    .unity_test_reports
                    .unwrap()
                    .pointer("/0/status")
                    .and_then(Value::as_str),
                Some("fresh_nonempty_passing_report_unavailable")
            );
        }
    }

    #[test]
    #[ignore = "requires a disposable Unity 6 fixture with a connected Pipeline Editor"]
    fn connected_editor_creates_and_verifies_exact_scene() {
        let workspace =
            fs::canonicalize(std::env::var_os("MAIN_DISPOSABLE_UNITY_FIXTURE").unwrap()).unwrap();
        assert_eq!(
            fs::read_to_string(workspace.join(".main-unity-disposable"))
                .unwrap()
                .trim(),
            "isolated test workspace"
        );
        let result = create_scene(
            &workspace,
            "Assets/Scenes/MainFixture.unity",
            "Bootstrap",
            "Assets/Scripts/ProbeBootstrap.cs",
            u64::MAX,
            &AtomicBool::new(false),
        )
        .unwrap();
        assert_eq!(result["success"], true);
        assert!(workspace.join("Assets/Scenes/MainFixture.unity").is_file());
        assert!(create_scene(
            &workspace,
            "Assets/Scenes/MainFixture.unity",
            "Bootstrap",
            "Assets/Scripts/ProbeBootstrap.cs",
            u64::MAX,
            &AtomicBool::new(false)
        )
        .unwrap_err()
        .starts_with("UNITY_SCENE_ALREADY_EXISTS"));
    }

    #[test]
    fn nunit_verdict_needs_a_complete_nonempty_pass() {
        assert_eq!(parse_nunit_pass(REPORT.as_bytes(), &[]), Some(1));
        assert_eq!(
            parse_nunit_pass(
                REPORT.as_bytes(),
                &nunit_filter("Fixture;!Unrelated").unwrap()
            ),
            Some(1)
        );
        assert_eq!(
            parse_nunit_pass(REPORT.as_bytes(), &nunit_filter("OtherFixture").unwrap()),
            None
        );
        assert_eq!(
            parse_nunit_pass(
                REPORT.as_bytes(),
                &nunit_filter("Fixture;!SceneLoads").unwrap()
            ),
            None
        );
        for bad in [
            REPORT.replace("total=\"1\"", "total=\"0\""),
            REPORT.replace("failed=\"0\"", "failed=\"1\""),
            REPORT.replace("fullname=\"Fixture.SceneLoads\"", ""),
            REPORT.replace("</test-run>", ""),
            REPORT.replace("result=\"Passed\" fullname", "result=\"Skipped\" fullname"),
        ] {
            assert_eq!(parse_nunit_pass(bad.as_bytes(), &[]), None, "{bad}");
        }
    }

    #[test]
    fn batch_verification_uses_the_report_from_this_invocation_only() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let file = root.join("playmode.xml");
        let inspection = inspect_shell_command_in_workspace(
            "unity test . --mode PlayMode --filter Fixture --output playmode.xml",
            &root,
        )
        .unwrap();
        let before = batch_report_expectations(&root, &root, &inspection);
        fs::write(&file, REPORT).unwrap();
        assert_eq!(verify_batch_reports(&root, before).unwrap()[0]["passed"], 1);
        let before = batch_report_expectations(&root, &root, &inspection);
        assert_eq!(
            verify_batch_reports(&root, before).unwrap()[0]["status"],
            "fresh_nonempty_passing_report_unavailable"
        );
        let second = inspect_shell_command_in_workspace(
            "unity test . --mode PlayMode --output missing.xml",
            &root,
        )
        .unwrap();
        let before = batch_report_expectations(&root, &root, &second);
        assert_eq!(
            verify_batch_reports(&root, before).unwrap()[0]["status"],
            "fresh_nonempty_passing_report_unavailable"
        );
    }

    #[test]
    fn scene_target_and_script_are_literal_assets_and_authoring_can_expire() {
        assert_eq!(
            asset_path("Assets/Scenes/Fixture.unity", "unity").unwrap(),
            "Assets/Scenes/Fixture.unity"
        );
        for path in [
            "Assets/../Outside.unity",
            "Assets//Empty.unity",
            "/Assets/Escape.unity",
            "Assets/Scene.cs",
        ] {
            assert!(asset_path(path, "unity").is_err(), "{path}");
        }
        let program = scene_program(
            "Assets/Scene.unity",
            "Root\"; breakout",
            "Assets/Bootstrap.cs",
        );
        assert!(program.contains(r#"new UnityEngine.GameObject("Root\"; breakout")"#));
        assert_eq!(program.matches("SaveScene(scene, path)").count(), 1);
        assert!(available_time(0, &AtomicBool::new(false), 30).is_err());
        assert!(available_time(u64::MAX, &AtomicBool::new(true), 30).is_err());
    }
}
