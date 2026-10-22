use serde::{Deserialize, Serialize};
use std::fmt;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::Command;
use tokio::task::JoinHandle;
use tokio::time::timeout;

#[cfg(unix)]
const SIGKILL_SIGNAL: i32 = 9;

#[cfg(unix)]
extern "C" {
    fn kill(pid: i32, signal: i32) -> i32;
}

const DEFAULT_MAX_OUTPUT_BYTES: usize = 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TrustedExecutionRisk {
    Low,
    Medium,
    High,
    Critical,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ShellConnector {
    And,
    Or,
    Pipe,
    Sequence,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ShellRedirectionKind {
    Input,
    Output,
    Append,
    /// Duplicate only the existing stdout/stderr streams; target is an fd.
    StdioDuplication,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellRedirection {
    pub kind: ShellRedirectionKind,
    pub target: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_fd: Option<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrustedShellSegment {
    pub command: String,
    pub connector_after: Option<ShellConnector>,
    pub words: Vec<String>,
    pub redirections: Vec<ShellRedirection>,
    pub risk: TrustedExecutionRisk,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrustedShellInspection {
    pub command: String,
    pub segments: Vec<TrustedShellSegment>,
    pub risk: TrustedExecutionRisk,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ShellViolationKind {
    EmptyCommand,
    NulByte,
    Newline,
    UnterminatedQuote,
    DanglingEscape,
    EmptySegment,
    BackgroundExecution,
    UnsupportedControlOperator,
    CommandSubstitution,
    VariableExpansion,
    PathnameExpansion,
    NestedShell,
    WorkingDirectoryChange,
    WorkspacePathEscape,
    DangerousRedirection,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellValidationError {
    pub kind: ShellViolationKind,
    pub segment: Option<String>,
    pub message: String,
    pub risk: TrustedExecutionRisk,
}

impl ShellValidationError {
    fn critical(
        kind: ShellViolationKind,
        segment: Option<impl Into<String>>,
        message: impl Into<String>,
    ) -> Self {
        Self {
            kind,
            segment: segment.map(Into::into),
            message: message.into(),
            risk: TrustedExecutionRisk::Critical,
        }
    }
}

impl fmt::Display for ShellValidationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "trusted shell validation rejected command: {}",
            self.message
        )
    }
}

impl std::error::Error for ShellValidationError {}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum QuoteState {
    Single,
    Double,
}

/// Parse the complete shell string before policy matching. Unsupported shell
/// expansion fails closed so an approval can never authorize a different
/// command than the one that was inspected.
pub fn inspect_shell_command(
    command: &str,
) -> Result<TrustedShellInspection, ShellValidationError> {
    inspect_shell_command_with_workspace(command, None)
}

/// Absolute argv paths require a concrete workspace and canonical containment.
/// The context-free inspector deliberately keeps its stricter lexical policy.
pub fn inspect_shell_command_in_workspace(
    command: &str,
    workspace_root: impl AsRef<Path>,
) -> Result<TrustedShellInspection, ShellValidationError> {
    inspect_shell_command_with_workspace(command, Some(workspace_root.as_ref()))
}

fn inspect_shell_command_with_workspace(
    command: &str,
    workspace_root: Option<&Path>,
) -> Result<TrustedShellInspection, ShellValidationError> {
    let trimmed = command.trim();
    if trimmed.is_empty() {
        return Err(ShellValidationError::critical(
            ShellViolationKind::EmptyCommand,
            None::<String>,
            "command is empty",
        ));
    }
    if command.contains('\0') {
        return Err(ShellValidationError::critical(
            ShellViolationKind::NulByte,
            None::<String>,
            "NUL bytes are not valid shell input",
        ));
    }
    // Scan the original bytes so leading/trailing shell newlines cannot be
    // hidden by trim. Quoted line breaks are ordinary argument data.
    let raw_segments = split_structured_segments(command)?;
    let mut segments = Vec::with_capacity(raw_segments.len());
    let mut overall_risk = TrustedExecutionRisk::Low;
    for (raw, connector_after) in raw_segments {
        let (words, redirections) = parse_segment_words_and_redirections(&raw)?;
        validate_segment_semantics(&raw, &words, workspace_root)?;
        let risk = if !redirections.is_empty() {
            TrustedExecutionRisk::High
        } else if connector_after.is_some() {
            TrustedExecutionRisk::Medium
        } else {
            TrustedExecutionRisk::Low
        };
        overall_risk = overall_risk.max(risk);
        segments.push(TrustedShellSegment {
            command: raw,
            connector_after,
            words,
            redirections,
            risk,
        });
    }

    Ok(TrustedShellInspection {
        command: trimmed.to_string(),
        segments,
        risk: overall_risk,
    })
}

fn split_structured_segments(
    command: &str,
) -> Result<Vec<(String, Option<ShellConnector>)>, ShellValidationError> {
    let chars: Vec<char> = command.chars().collect();
    let mut parts = Vec::new();
    let mut current = String::new();
    let mut quote = None;
    let mut escaped = false;
    let mut index = 0;

    while index < chars.len() {
        let ch = chars[index];
        if matches!(ch, '\n' | '\r') && (quote.is_none() || escaped) {
            return Err(ShellValidationError::critical(
                ShellViolationKind::Newline,
                Some(current),
                "unquoted shell line breaks and escaped line continuations are not permitted",
            ));
        }
        if escaped {
            current.push(ch);
            escaped = false;
            index += 1;
            continue;
        }
        if ch == '\\' && quote != Some(QuoteState::Single) {
            current.push(ch);
            escaped = true;
            index += 1;
            continue;
        }
        match quote {
            Some(QuoteState::Single) => {
                current.push(ch);
                if ch == '\'' {
                    quote = None;
                }
                index += 1;
                continue;
            }
            Some(QuoteState::Double) => {
                if ch == '`' || (ch == '$' && chars.get(index + 1) == Some(&'(')) {
                    return Err(ShellValidationError::critical(
                        ShellViolationKind::CommandSubstitution,
                        Some(current.clone()),
                        "command substitution is not permitted",
                    ));
                }
                if ch == '$' {
                    return Err(ShellValidationError::critical(
                        ShellViolationKind::VariableExpansion,
                        Some(current.clone()),
                        "unresolved shell variables are not permitted",
                    ));
                }
                if looks_like_windows_variable(&chars, index, ch) {
                    return Err(ShellValidationError::critical(
                        ShellViolationKind::VariableExpansion,
                        Some(current.clone()),
                        "unresolved shell variables are not permitted",
                    ));
                }
                current.push(ch);
                if ch == '"' {
                    quote = None;
                }
                index += 1;
                continue;
            }
            None => {}
        }

        if ch == '\'' {
            quote = Some(QuoteState::Single);
            current.push(ch);
            index += 1;
            continue;
        }
        if ch == '"' {
            quote = Some(QuoteState::Double);
            current.push(ch);
            index += 1;
            continue;
        }
        if ch == '`' || (ch == '$' && chars.get(index + 1) == Some(&'(')) {
            return Err(ShellValidationError::critical(
                ShellViolationKind::CommandSubstitution,
                Some(current.clone()),
                "command substitution is not permitted",
            ));
        }
        if ch == '$' {
            return Err(ShellValidationError::critical(
                ShellViolationKind::VariableExpansion,
                Some(current.clone()),
                "unresolved shell variables are not permitted",
            ));
        }
        if matches!(ch, '*' | '?' | '[') {
            return Err(ShellValidationError::critical(
                ShellViolationKind::PathnameExpansion,
                Some(current.clone()),
                "unresolved shell pathname expansion is not permitted",
            ));
        }
        if looks_like_windows_variable(&chars, index, ch) {
            return Err(ShellValidationError::critical(
                ShellViolationKind::VariableExpansion,
                Some(current.clone()),
                "unresolved shell variables are not permitted",
            ));
        }
        if matches!(ch, '(' | ')') {
            return Err(ShellValidationError::critical(
                ShellViolationKind::UnsupportedControlOperator,
                Some(current.clone()),
                "subshell and shell grouping operators are not permitted",
            ));
        }
        if ch == '{' {
            if chars.get(index + 1) == Some(&'}') {
                current.push(ch);
                current.push('}');
                index += 2;
                continue;
            }
            return Err(ShellValidationError::critical(
                ShellViolationKind::UnsupportedControlOperator,
                Some(current.clone()),
                "shell brace expansion is not permitted",
            ));
        }
        if ch == '}' {
            return Err(ShellValidationError::critical(
                ShellViolationKind::UnsupportedControlOperator,
                Some(current.clone()),
                "shell brace expansion is not permitted",
            ));
        }

        // The ampersand in an unquoted output-descriptor operator belongs to
        // that operator, not to shell background execution. The word parser
        // below still validates both descriptor numbers and rejects all other
        // descriptor forms before policy matching or execution.
        if ch == '>' && chars.get(index + 1) == Some(&'&') {
            current.push_str(">&");
            index += 2;
            continue;
        }

        let connector = match ch {
            ';' => {
                if matches!(chars.get(index + 1), Some(';' | '&')) {
                    return Err(ShellValidationError::critical(
                        ShellViolationKind::UnsupportedControlOperator,
                        Some(current.clone()),
                        "unsupported semicolon control operator",
                    ));
                }
                Some((ShellConnector::Sequence, 1))
            }
            '|' => {
                if chars.get(index + 1) == Some(&'|') {
                    if chars.get(index + 2) == Some(&'|') {
                        return Err(ShellValidationError::critical(
                            ShellViolationKind::UnsupportedControlOperator,
                            Some(current.clone()),
                            "unsupported pipe control operator",
                        ));
                    }
                    Some((ShellConnector::Or, 2))
                } else if chars.get(index + 1) == Some(&'&') {
                    return Err(ShellValidationError::critical(
                        ShellViolationKind::UnsupportedControlOperator,
                        Some(current.clone()),
                        "combined stdout/stderr pipelines are not permitted",
                    ));
                } else {
                    Some((ShellConnector::Pipe, 1))
                }
            }
            '&' => {
                if chars.get(index + 1) == Some(&'&') {
                    Some((ShellConnector::And, 2))
                } else {
                    return Err(ShellValidationError::critical(
                        ShellViolationKind::BackgroundExecution,
                        Some(current.clone()),
                        "background shell execution is not permitted",
                    ));
                }
            }
            _ => None,
        };

        if let Some((connector, consumed)) = connector {
            push_structured_segment(&mut parts, &mut current, Some(connector))?;
            index += consumed;
            continue;
        }

        current.push(ch);
        index += 1;
    }

    if escaped {
        return Err(ShellValidationError::critical(
            ShellViolationKind::DanglingEscape,
            Some(current),
            "command ends with an incomplete escape",
        ));
    }
    if quote.is_some() {
        return Err(ShellValidationError::critical(
            ShellViolationKind::UnterminatedQuote,
            Some(current),
            "command contains an unterminated quote",
        ));
    }
    push_structured_segment(&mut parts, &mut current, None)?;
    Ok(parts)
}

fn looks_like_windows_variable(chars: &[char], index: usize, ch: char) -> bool {
    if !matches!(ch, '%' | '!') {
        return false;
    }
    let Some(closing_offset) = chars[index + 1..].iter().position(|next| *next == ch) else {
        return false;
    };
    let name = &chars[index + 1..index + 1 + closing_offset];
    !name.is_empty()
        && name
            .iter()
            .all(|value| *value == '_' || value.is_ascii_alphanumeric())
}

fn push_structured_segment(
    parts: &mut Vec<(String, Option<ShellConnector>)>,
    current: &mut String,
    connector_after: Option<ShellConnector>,
) -> Result<(), ShellValidationError> {
    let segment = current.trim();
    if segment.is_empty() {
        return Err(ShellValidationError::critical(
            ShellViolationKind::EmptySegment,
            None::<String>,
            "shell control operators must have a command on both sides",
        ));
    }
    parts.push((segment.to_string(), connector_after));
    current.clear();
    Ok(())
}

fn parse_segment_words_and_redirections(
    segment: &str,
) -> Result<(Vec<String>, Vec<ShellRedirection>), ShellValidationError> {
    let chars: Vec<char> = segment.chars().collect();
    let mut words = Vec::new();
    let mut redirections = Vec::new();
    let mut current = String::new();
    let mut word_has_quoting = false;
    let mut quote = None;
    let mut escaped = false;
    let mut index = 0;

    while index < chars.len() {
        let ch = chars[index];
        if escaped {
            current.push(ch);
            escaped = false;
            index += 1;
            continue;
        }
        if ch == '\\' && quote != Some(QuoteState::Single) {
            word_has_quoting = true;
            escaped = true;
            index += 1;
            continue;
        }
        if let Some(active_quote) = quote {
            if (active_quote == QuoteState::Single && ch == '\'')
                || (active_quote == QuoteState::Double && ch == '"')
            {
                quote = None;
            } else {
                current.push(ch);
            }
            index += 1;
            continue;
        }
        if ch == '\'' {
            word_has_quoting = true;
            quote = Some(QuoteState::Single);
            index += 1;
            continue;
        }
        if ch == '"' {
            word_has_quoting = true;
            quote = Some(QuoteState::Double);
            index += 1;
            continue;
        }
        if ch.is_whitespace() {
            push_word(&mut words, &mut current);
            word_has_quoting = false;
            index += 1;
            continue;
        }
        if matches!(ch, '<' | '>') {
            // An IO number is unquoted digits immediately before the operator.
            // Quoted/escaped digits are ordinary argv, as is a spaced `2 >`.
            let source_fd = if !word_has_quoting
                && !current.is_empty()
                && current.chars().all(|value| value.is_ascii_digit())
            {
                let source = match current.as_str() {
                    "0" if ch == '<' => 0,
                    "1" if ch == '>' => 1,
                    "2" if ch == '>' => 2,
                    _ => {
                        return Err(ShellValidationError::critical(
                            ShellViolationKind::DangerousRedirection,
                            Some(segment),
                            "only standard input, stdout and stderr redirections are permitted",
                        ))
                    }
                };
                current.clear();
                Some(source)
            } else {
                push_word(&mut words, &mut current);
                None
            };
            word_has_quoting = false;
            let (kind, consumed) = match (ch, chars.get(index + 1)) {
                ('>', Some('>')) => (ShellRedirectionKind::Append, 2),
                ('>', Some('&')) => (ShellRedirectionKind::StdioDuplication, 2),
                ('>', Some('|' | '(')) | ('<', Some('<' | '>' | '&' | '(')) => {
                    return Err(ShellValidationError::critical(
                        ShellViolationKind::DangerousRedirection,
                        Some(segment),
                        "input-descriptor, heredoc, process, and clobber redirections are not permitted",
                    ));
                }
                ('>', _) => (ShellRedirectionKind::Output, 1),
                ('<', _) => (ShellRedirectionKind::Input, 1),
                _ => unreachable!(),
            };
            index += consumed;
            while chars.get(index).is_some_and(|value| value.is_whitespace()) {
                index += 1;
            }
            let (target, next_index) = read_shell_word(&chars, index, segment)?;
            if target.is_empty() {
                return Err(ShellValidationError::critical(
                    ShellViolationKind::DangerousRedirection,
                    Some(segment),
                    "redirection target is missing",
                ));
            }
            let source_fd = if kind == ShellRedirectionKind::StdioDuplication {
                if !matches!(target.as_str(), "1" | "2") {
                    return Err(ShellValidationError::critical(
                        ShellViolationKind::DangerousRedirection,
                        Some(segment),
                        "only stdout/stderr duplication is permitted; descriptor close, move and arbitrary targets are not",
                    ));
                }
                Some(source_fd.unwrap_or(1))
            } else {
                validate_workspace_path_token(&target, segment, true, None)?;
                words.push(target.clone());
                source_fd
            };
            redirections.push(ShellRedirection {
                kind,
                target,
                source_fd,
            });
            index = next_index;
            continue;
        }
        current.push(ch);
        index += 1;
    }
    push_word(&mut words, &mut current);
    if words.is_empty() {
        return Err(ShellValidationError::critical(
            ShellViolationKind::EmptySegment,
            Some(segment),
            "shell segment has no executable",
        ));
    }
    Ok((words, redirections))
}

fn read_shell_word(
    chars: &[char],
    mut index: usize,
    segment: &str,
) -> Result<(String, usize), ShellValidationError> {
    let mut word = String::new();
    let mut quote = None;
    let mut escaped = false;
    while index < chars.len() {
        let ch = chars[index];
        if escaped {
            word.push(ch);
            escaped = false;
            index += 1;
            continue;
        }
        if ch == '\\' && quote != Some(QuoteState::Single) {
            escaped = true;
            index += 1;
            continue;
        }
        if let Some(active_quote) = quote {
            if (active_quote == QuoteState::Single && ch == '\'')
                || (active_quote == QuoteState::Double && ch == '"')
            {
                quote = None;
            } else {
                word.push(ch);
            }
            index += 1;
            continue;
        }
        if ch == '\'' {
            quote = Some(QuoteState::Single);
            index += 1;
            continue;
        }
        if ch == '"' {
            quote = Some(QuoteState::Double);
            index += 1;
            continue;
        }
        if ch.is_whitespace() || matches!(ch, '<' | '>' | ';' | '|' | '&') {
            break;
        }
        word.push(ch);
        index += 1;
    }
    if escaped || quote.is_some() {
        return Err(ShellValidationError::critical(
            ShellViolationKind::DangerousRedirection,
            Some(segment),
            "redirection target is not a complete shell word",
        ));
    }
    Ok((word, index))
}

fn push_word(words: &mut Vec<String>, current: &mut String) {
    if !current.is_empty() {
        words.push(std::mem::take(current));
    }
}

fn validate_segment_semantics(
    segment: &str,
    words: &[String],
    workspace_root: Option<&Path>,
) -> Result<(), ShellValidationError> {
    let executable_index = words
        .iter()
        .position(|word| !is_environment_assignment(word))
        .unwrap_or(0);
    let executable = words
        .get(executable_index)
        .map(|word| command_basename(word).to_ascii_lowercase())
        .unwrap_or_default();
    let next = words
        .get(executable_index + 1)
        .map(|word| command_basename(word).to_ascii_lowercase());

    if matches!(executable.as_str(), "cd" | "pushd" | "popd")
        || (matches!(executable.as_str(), "command" | "builtin")
            && next
                .as_deref()
                .is_some_and(|word| matches!(word, "cd" | "pushd" | "popd")))
    {
        return Err(ShellValidationError::critical(
            ShellViolationKind::WorkingDirectoryChange,
            Some(segment),
            "working-directory changes are not permitted inside a trusted command",
        ));
    }

    let wrapped_shell = matches!(executable.as_str(), "env" | "command" | "builtin" | "xargs")
        && words
            .iter()
            .skip(executable_index + 1)
            .any(|word| is_shell_interpreter(command_basename(word)));
    let nested_shell_command = words.iter().enumerate().any(|(index, word)| {
        is_shell_interpreter(command_basename(word))
            && words
                .iter()
                .skip(index + 1)
                .take_while(|argument| argument.starts_with('-') || argument.starts_with('/'))
                .any(|argument| is_shell_command_flag(argument))
    });
    if matches!(executable.as_str(), "eval" | "source" | ".")
        || is_shell_interpreter(&executable)
        || wrapped_shell
        || nested_shell_command
    {
        return Err(ShellValidationError::critical(
            ShellViolationKind::NestedShell,
            Some(segment),
            "nested shell evaluation is not permitted",
        ));
    }

    for word in words {
        validate_workspace_path_token(word, segment, false, workspace_root)?;
    }
    Ok(())
}

fn is_environment_assignment(word: &str) -> bool {
    let Some((name, _)) = word.split_once('=') else {
        return false;
    };
    !name.is_empty()
        && name.chars().enumerate().all(|(index, ch)| {
            ch == '_' || ch.is_ascii_alphanumeric() && (index > 0 || !ch.is_ascii_digit())
        })
}

fn command_basename(word: &str) -> &str {
    word.rsplit(['/', '\\']).next().unwrap_or(word)
}

fn is_shell_interpreter(word: &str) -> bool {
    matches!(
        word.to_ascii_lowercase().as_str(),
        "sh" | "bash"
            | "zsh"
            | "fish"
            | "dash"
            | "ksh"
            | "cmd"
            | "cmd.exe"
            | "powershell"
            | "powershell.exe"
            | "pwsh"
            | "pwsh.exe"
    )
}

fn is_shell_command_flag(word: &str) -> bool {
    let lower = word.to_ascii_lowercase();
    lower == "/c"
        || lower == "--command"
        || lower == "-command"
        || lower == "-encodedcommand"
        || (lower.starts_with('-')
            && !lower.starts_with("--")
            && lower[1..].chars().any(|flag| flag == 'c'))
}

fn validate_workspace_path_token(
    word: &str,
    segment: &str,
    redirection: bool,
    workspace_root: Option<&Path>,
) -> Result<(), ShellValidationError> {
    let Some(candidate) = normalized_workspace_path_candidate(word) else {
        return Ok(());
    };
    let looks_like_path = redirection
        || candidate.starts_with(['/', '~', '.'])
        || candidate.contains('/')
        || candidate.contains('\\');
    if !looks_like_path {
        return Ok(());
    }
    let path = Path::new(&candidate);
    let trusted_absolute = !redirection
        && path.is_absolute()
        && workspace_root.is_some_and(|root| {
            resolve_workspace_path(root, path, WorkspacePathMode::AllowMissing).is_ok()
        });
    let escapes = ((path.is_absolute() || is_windows_absolute_path(&candidate))
        && !trusted_absolute)
        || candidate.starts_with('~')
        || candidate
            .split(['/', '\\'])
            .any(|component| component == "..")
        || path
            .components()
            .any(|component| matches!(component, Component::ParentDir))
        || (!trusted_absolute
            && path
                .components()
                .any(|component| matches!(component, Component::RootDir | Component::Prefix(_))));
    if escapes {
        return Err(ShellValidationError::critical(
            if redirection {
                ShellViolationKind::DangerousRedirection
            } else {
                ShellViolationKind::WorkspacePathEscape
            },
            Some(segment),
            if redirection {
                "redirection target must be a workspace-relative path"
            } else {
                if workspace_root.is_some() {
                    "shell path must remain within the canonical workspace"
                } else {
                    "shell path must remain workspace-relative"
                }
            },
        ));
    }
    Ok(())
}

fn normalized_workspace_path_candidate(word: &str) -> Option<String> {
    let mut candidate = word
        .strip_prefix("--")
        .and_then(|value| value.split_once('=').map(|(_, path)| path))
        .or_else(|| word.split_once('=').map(|(_, value)| value))
        .unwrap_or(word);
    if candidate.starts_with('-') {
        // For compact short options such as `-Cpath` or `-Ipath`, remove only
        // the option letter. Stripping every leading alphabetic character
        // would misclassify an ordinary path beginning with a letter and let
        // a symlink-valued attached argument evade the execution boundary.
        let short = candidate.strip_prefix('-').unwrap_or(candidate);
        if short.starts_with('-') {
            return None;
        }
        let attached = short.get(1..).unwrap_or_default();
        if attached.is_empty() {
            return None;
        }
        candidate = attached;
    }
    if candidate.is_empty() || candidate.contains("://") || candidate == "." {
        return None;
    }
    Some(candidate.to_string())
}

fn is_windows_absolute_path(candidate: &str) -> bool {
    let bytes = candidate.as_bytes();
    candidate.starts_with("\\\\")
        || candidate.starts_with("//")
        || (bytes.len() >= 3
            && bytes[0].is_ascii_alphabetic()
            && bytes[1] == b':'
            && matches!(bytes[2], b'/' | b'\\'))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkspacePathMode {
    Existing,
    AllowMissing,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TrustedWorkspacePath {
    canonical_root: PathBuf,
    resolved_path: PathBuf,
    mode: WorkspacePathMode,
}

impl TrustedWorkspacePath {
    pub fn root(&self) -> &Path {
        &self.canonical_root
    }

    pub fn path(&self) -> &Path {
        &self.resolved_path
    }

    /// Re-run canonical parent validation immediately before a filesystem
    /// operation. Callers should not retain the result across unrelated awaits.
    pub fn revalidate(&self) -> Result<PathBuf, WorkspacePathError> {
        resolve_workspace_path(&self.canonical_root, &self.resolved_path, self.mode)
            .map(|path| path.resolved_path)
    }
}

#[derive(Debug)]
pub enum WorkspacePathError {
    InvalidRoot { path: PathBuf, message: String },
    Escape { path: PathBuf },
    Missing { path: PathBuf },
    NotDirectory { path: PathBuf },
    Io { path: PathBuf, message: String },
}

impl fmt::Display for WorkspacePathError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidRoot { path, message } => {
                write!(
                    formatter,
                    "invalid workspace root {}: {message}",
                    path.display()
                )
            }
            Self::Escape { path } => {
                write!(
                    formatter,
                    "path escapes canonical workspace: {}",
                    path.display()
                )
            }
            Self::Missing { path } => {
                write!(formatter, "workspace path is missing: {}", path.display())
            }
            Self::NotDirectory { path } => {
                write!(
                    formatter,
                    "working directory is not a directory: {}",
                    path.display()
                )
            }
            Self::Io { path, message } => {
                write!(formatter, "workspace path {}: {message}", path.display())
            }
        }
    }
}

impl std::error::Error for WorkspacePathError {}

pub fn canonical_workspace_root(root: impl AsRef<Path>) -> Result<PathBuf, WorkspacePathError> {
    let root = root.as_ref();
    let canonical = fs::canonicalize(root).map_err(|error| WorkspacePathError::InvalidRoot {
        path: root.to_path_buf(),
        message: error.to_string(),
    })?;
    if !canonical.is_dir() {
        return Err(WorkspacePathError::InvalidRoot {
            path: canonical,
            message: "root is not a directory".to_string(),
        });
    }
    Ok(canonical)
}

pub fn resolve_workspace_path(
    root: impl AsRef<Path>,
    requested: impl AsRef<Path>,
    mode: WorkspacePathMode,
) -> Result<TrustedWorkspacePath, WorkspacePathError> {
    let raw_root = root.as_ref();
    let canonical_root = canonical_workspace_root(raw_root)?;
    let requested = requested.as_ref();
    let relative = if requested.is_absolute() {
        requested
            .strip_prefix(raw_root)
            .or_else(|_| requested.strip_prefix(&canonical_root))
            .map_err(|_| WorkspacePathError::Escape {
                path: requested.to_path_buf(),
            })?
            .to_path_buf()
    } else {
        requested.to_path_buf()
    };
    if relative.components().any(|component| {
        matches!(
            component,
            Component::ParentDir | Component::RootDir | Component::Prefix(_)
        )
    }) {
        return Err(WorkspacePathError::Escape {
            path: requested.to_path_buf(),
        });
    }

    let candidate = canonical_root.join(relative);
    let resolved_path = match mode {
        WorkspacePathMode::Existing => {
            let canonical = fs::canonicalize(&candidate).map_err(|error| {
                if error.kind() == std::io::ErrorKind::NotFound {
                    WorkspacePathError::Missing {
                        path: candidate.clone(),
                    }
                } else {
                    WorkspacePathError::Io {
                        path: candidate.clone(),
                        message: error.to_string(),
                    }
                }
            })?;
            ensure_path_within_root(&canonical_root, &canonical)?;
            canonical
        }
        WorkspacePathMode::AllowMissing => {
            resolve_missing_workspace_path(&canonical_root, &candidate)?
        }
    };

    Ok(TrustedWorkspacePath {
        canonical_root,
        resolved_path,
        mode,
    })
}

pub fn resolve_workspace_working_directory(
    root: impl AsRef<Path>,
    working_directory: impl AsRef<Path>,
) -> Result<TrustedWorkspacePath, WorkspacePathError> {
    let trusted = resolve_workspace_path(root, working_directory, WorkspacePathMode::Existing)?;
    if !trusted.path().is_dir() {
        return Err(WorkspacePathError::NotDirectory {
            path: trusted.path().to_path_buf(),
        });
    }
    Ok(trusted)
}

fn resolve_missing_workspace_path(
    canonical_root: &Path,
    candidate: &Path,
) -> Result<PathBuf, WorkspacePathError> {
    let mut existing = candidate.to_path_buf();
    let mut missing_tail = Vec::new();
    while match fs::symlink_metadata(&existing) {
        Ok(_) => false,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => true,
        Err(error) => {
            return Err(WorkspacePathError::Io {
                path: existing.clone(),
                message: error.to_string(),
            })
        }
    } {
        let name = existing
            .file_name()
            .ok_or_else(|| WorkspacePathError::Escape {
                path: candidate.to_path_buf(),
            })?
            .to_os_string();
        missing_tail.push(name);
        if !existing.pop() {
            return Err(WorkspacePathError::Escape {
                path: candidate.to_path_buf(),
            });
        }
    }
    let canonical_parent = fs::canonicalize(&existing).map_err(|error| WorkspacePathError::Io {
        path: existing.clone(),
        message: error.to_string(),
    })?;
    ensure_path_within_root(canonical_root, &canonical_parent)?;
    let mut resolved = canonical_parent;
    for component in missing_tail.into_iter().rev() {
        resolved.push(component);
    }
    ensure_path_within_root(canonical_root, &resolved)?;
    Ok(resolved)
}

fn ensure_path_within_root(root: &Path, candidate: &Path) -> Result<(), WorkspacePathError> {
    if candidate == root || candidate.starts_with(root) {
        Ok(())
    } else {
        Err(WorkspacePathError::Escape {
            path: candidate.to_path_buf(),
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionResult {
    pub command: String,
    pub success: bool,
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub timed_out: bool,
    pub stdout_truncated: bool,
    pub stderr_truncated: bool,
    pub truncated: bool,
    pub duration_ms: u128,
}

#[derive(Debug)]
pub enum TrustedExecutionError {
    Shell(ShellValidationError),
    Workspace(WorkspacePathError),
    Io(String),
}

impl fmt::Display for TrustedExecutionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Shell(error) => error.fmt(formatter),
            Self::Workspace(error) => error.fmt(formatter),
            Self::Io(message) => write!(formatter, "trusted process execution failed: {message}"),
        }
    }
}

impl std::error::Error for TrustedExecutionError {}

impl From<ShellValidationError> for TrustedExecutionError {
    fn from(error: ShellValidationError) -> Self {
        Self::Shell(error)
    }
}

impl From<WorkspacePathError> for TrustedExecutionError {
    fn from(error: WorkspacePathError) -> Self {
        Self::Workspace(error)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreparedTrustedShellExecution {
    inspection: TrustedShellInspection,
    working_directory: TrustedWorkspacePath,
}

impl PreparedTrustedShellExecution {
    pub fn inspection(&self) -> &TrustedShellInspection {
        &self.inspection
    }

    pub fn working_directory(&self) -> &Path {
        self.working_directory.path()
    }
}

/// Perform the final, execution-adjacent shell and workspace checks shared by
/// built-in commands, PTY commands, hooks, and the MCP execution boundary.
pub fn prepare_trusted_shell_execution(
    workspace_root: impl AsRef<Path>,
    working_directory: impl AsRef<Path>,
    command: &str,
) -> Result<PreparedTrustedShellExecution, TrustedExecutionError> {
    let inspection = inspect_shell_command_in_workspace(command, workspace_root.as_ref())?;
    let trusted_working_directory =
        resolve_workspace_working_directory(workspace_root.as_ref(), working_directory)?;
    for segment in &inspection.segments {
        let executable_index = segment
            .words
            .iter()
            .position(|word| !is_environment_assignment(word))
            .unwrap_or(0);
        for (index, word) in segment.words.iter().enumerate() {
            let Some(candidate) = normalized_workspace_path_candidate(word) else {
                continue;
            };
            // Bare executable names are resolved through PATH and therefore
            // are not workspace paths. Explicit executable paths (`./tool`,
            // `bin/tool`) must be canonicalized exactly like argv values so a
            // workspace symlink cannot select a program outside the boundary.
            if index == executable_index
                && !candidate.starts_with('.')
                && !candidate.contains('/')
                && !candidate.contains('\\')
            {
                continue;
            }
            let candidate_path = trusted_working_directory.path().join(&candidate);
            let obvious_path = candidate.starts_with(['/', '~', '.'])
                || candidate.contains('/')
                || candidate.contains('\\');
            let existing_path = fs::symlink_metadata(&candidate_path).is_ok();
            if obvious_path || existing_path {
                resolve_workspace_path(
                    workspace_root.as_ref(),
                    candidate_path,
                    WorkspacePathMode::AllowMissing,
                )?;
            }
        }
        for redirection in &segment.redirections {
            if redirection.kind == ShellRedirectionKind::StdioDuplication {
                continue;
            }
            resolve_workspace_path(
                trusted_working_directory.root(),
                trusted_working_directory.path().join(&redirection.target),
                WorkspacePathMode::AllowMissing,
            )?;
        }
    }
    Ok(PreparedTrustedShellExecution {
        inspection,
        working_directory: trusted_working_directory,
    })
}

/// Execute an already policy-admitted command with a final structural check.
/// Timeout handling explicitly kills and reaps the child before returning.
pub async fn execute_trusted_shell(
    workspace_root: impl AsRef<Path>,
    working_directory: impl AsRef<Path>,
    command: &str,
    timeout_duration: Duration,
    max_output_bytes: Option<usize>,
) -> Result<ExecutionResult, TrustedExecutionError> {
    let prepared =
        prepare_trusted_shell_execution(workspace_root.as_ref(), working_directory, command)?;

    let max_output_bytes = max_output_bytes.unwrap_or(DEFAULT_MAX_OUTPUT_BYTES).max(1);
    let started_at = Instant::now();
    let mut process = build_shell_command(command);
    #[cfg(unix)]
    process.process_group(0);
    process
        .current_dir(prepared.working_directory())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = process
        .spawn()
        .map_err(|error| TrustedExecutionError::Io(format!("spawn child: {error}")))?;
    let stdout = child.stdout.take().ok_or_else(|| {
        TrustedExecutionError::Io("capture stdout pipe: missing pipe".to_string())
    })?;
    let stderr = child.stderr.take().ok_or_else(|| {
        TrustedExecutionError::Io("capture stderr pipe: missing pipe".to_string())
    })?;
    let stdout_task = tokio::spawn(capture_bounded_output(stdout, max_output_bytes, "stdout"));
    let stderr_task = tokio::spawn(capture_bounded_output(stderr, max_output_bytes, "stderr"));
    #[cfg(unix)]
    let process_group_id = child.id();
    #[cfg(not(unix))]
    let process_group_id = None;

    let mut timed_out = false;
    let status = match timeout(timeout_duration, child.wait()).await {
        Ok(status) => {
            status.map_err(|error| TrustedExecutionError::Io(format!("wait for child: {error}")))?
        }
        Err(_) => {
            timed_out = true;
            terminate_process_group(process_group_id);
            if child
                .try_wait()
                .map_err(|error| {
                    TrustedExecutionError::Io(format!("inspect timed-out child: {error}"))
                })?
                .is_none()
            {
                child.start_kill().map_err(|error| {
                    TrustedExecutionError::Io(format!("kill timed-out child: {error}"))
                })?;
            }
            child.wait().await.map_err(|error| {
                TrustedExecutionError::Io(format!("reap timed-out child: {error}"))
            })?
        }
    };

    let ((stdout, stdout_truncated), (stderr, stderr_truncated)) =
        finish_bounded_captures(stdout_task, stderr_task, process_group_id).await?;
    Ok(ExecutionResult {
        command: command.to_string(),
        success: !timed_out && status.success(),
        exit_code: status.code(),
        stdout,
        stderr,
        timed_out,
        stdout_truncated,
        stderr_truncated,
        truncated: stdout_truncated || stderr_truncated,
        duration_ms: started_at.elapsed().as_millis(),
    })
}

async fn capture_bounded_output<R>(
    mut pipe: R,
    max_output_bytes: usize,
    label: &'static str,
) -> Result<(String, bool), TrustedExecutionError>
where
    R: AsyncRead + Unpin,
{
    let mut captured = Vec::with_capacity(max_output_bytes.min(8 * 1024));
    let mut chunk = [0_u8; 8 * 1024];
    let mut truncated = false;
    loop {
        let read = pipe
            .read(&mut chunk)
            .await
            .map_err(|error| TrustedExecutionError::Io(format!("read {label}: {error}")))?;
        if read == 0 {
            break;
        }
        let remaining = max_output_bytes.saturating_sub(captured.len());
        let retained = remaining.min(read);
        captured.extend_from_slice(&chunk[..retained]);
        if retained < read {
            truncated = true;
        }
    }
    Ok((String::from_utf8_lossy(&captured).to_string(), truncated))
}

async fn finish_bounded_captures(
    mut stdout_task: JoinHandle<Result<(String, bool), TrustedExecutionError>>,
    mut stderr_task: JoinHandle<Result<(String, bool), TrustedExecutionError>>,
    process_group_id: Option<u32>,
) -> Result<((String, bool), (String, bool)), TrustedExecutionError> {
    let captures = async {
        let stdout = (&mut stdout_task).await.map_err(|error| {
            TrustedExecutionError::Io(format!("join stdout capture: {error}"))
        })??;
        let stderr = (&mut stderr_task).await.map_err(|error| {
            TrustedExecutionError::Io(format!("join stderr capture: {error}"))
        })??;
        Ok::<_, TrustedExecutionError>((stdout, stderr))
    };
    match timeout(Duration::from_secs(2), captures).await {
        Ok(result) => result,
        Err(_) => {
            // A descendant retaining an inherited pipe after the shell exits
            // is still part of this execution. Kill that group and never
            // leave detached capture tasks behind.
            terminate_process_group(process_group_id);
            stdout_task.abort();
            stderr_task.abort();
            let _ = stdout_task.await;
            let _ = stderr_task.await;
            Err(TrustedExecutionError::Io(
                "output pipes remained open after process exit".to_string(),
            ))
        }
    }
}

#[cfg(unix)]
fn terminate_process_group(process_group_id: Option<u32>) {
    let Some(process_group_id) = process_group_id.and_then(|value| i32::try_from(value).ok())
    else {
        return;
    };
    // A negative pid targets the complete process group created above,
    // including pipeline and script descendants.
    unsafe {
        let _ = kill(-process_group_id, SIGKILL_SIGNAL);
    }
}

#[cfg(not(unix))]
fn terminate_process_group(_process_group_id: Option<u32>) {}

fn build_shell_command(command: &str) -> Command {
    if cfg!(target_os = "windows") {
        let mut process = Command::new("cmd");
        process.args(["/C", command]);
        process
    } else {
        let mut process = Command::new("/bin/sh");
        // A login shell may replace the caller-selected working directory,
        // defeating the workspace boundary. Trusted execution uses the
        // already-resolved environment and preserves the exact cwd.
        process.args(["-c", command]);
        process
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn workspace() -> tempfile::TempDir {
        tempfile::tempdir().expect("temp workspace")
    }

    #[test]
    fn structured_shell_parser_preserves_connectors_and_risk() {
        let inspection = inspect_shell_command(
            "cargo check && printf 'ok;still-one-word' > reports/status.txt | wc -c",
        )
        .expect("safe structured command");
        assert_eq!(inspection.segments.len(), 3);
        assert_eq!(
            inspection.segments[0].connector_after,
            Some(ShellConnector::And)
        );
        assert_eq!(
            inspection.segments[1].connector_after,
            Some(ShellConnector::Pipe)
        );
        assert_eq!(inspection.segments[1].redirections.len(), 1);
        assert_eq!(inspection.risk, TrustedExecutionRisk::High);
    }

    #[test]
    fn shell_parser_rejects_control_and_expansion_bypasses() {
        let cases = [
            ("pwd\nrm -rf .", ShellViolationKind::Newline),
            ("pwd & rm -rf .", ShellViolationKind::BackgroundExecution),
            ("echo $HOME", ShellViolationKind::VariableExpansion),
            ("echo ${HOME}", ShellViolationKind::VariableExpansion),
            ("echo $(whoami)", ShellViolationKind::CommandSubstitution),
            ("echo `whoami`", ShellViolationKind::CommandSubstitution),
            ("cat *", ShellViolationKind::PathnameExpansion),
            ("cat escape-dir/?", ShellViolationKind::PathnameExpansion),
            ("cat [ab].txt", ShellViolationKind::PathnameExpansion),
            ("sh -c 'pwd'", ShellViolationKind::NestedShell),
            ("cd src && pwd", ShellViolationKind::WorkingDirectoryChange),
            (
                "pwd ||| echo no",
                ShellViolationKind::UnsupportedControlOperator,
            ),
        ];
        for (command, expected) in cases {
            let error = inspect_shell_command(command).expect_err(command);
            assert_eq!(error.kind, expected, "{command}");
            assert_eq!(error.risk, TrustedExecutionRisk::Critical);
        }
    }

    #[test]
    fn shell_parser_rejects_workspace_and_redirection_escapes() {
        for command in [
            "ls ../outside",
            "cat /etc/passwd",
            "printf ok > /tmp/out",
            "printf ok >> ../out",
            "cat < ~/.ssh/id_rsa",
            "cat <<EOF",
            "printf ok 2>&3",
        ] {
            inspect_shell_command(command).expect_err(command);
        }
        inspect_shell_command("printf ok > reports/out.txt")
            .expect("workspace-relative redirection should remain inspectable");
    }

    #[test]
    fn stdio_duplication_preserves_shell_connectors_and_argv() {
        let command = "which example && example --version 2>&1 || echo \"EXAMPLE_CLI_NOT_FOUND\"";
        let inspection =
            inspect_shell_command(command).expect("stderr-to-stdout is not background execution");
        assert_eq!(inspection.command, command);
        assert_eq!(inspection.segments.len(), 3);
        assert_eq!(
            inspection.segments[0].connector_after,
            Some(ShellConnector::And)
        );
        assert_eq!(
            inspection.segments[1].connector_after,
            Some(ShellConnector::Or)
        );
        assert_eq!(inspection.segments[1].words, ["example", "--version"]);
        assert_eq!(inspection.risk, TrustedExecutionRisk::High);
        for command in [
            "printf ok 2>&1",
            "printf ok 1>&2",
            "printf ok >&2",
            "printf ok 2>& 1",
        ] {
            let segment = &inspect_shell_command(command).expect(command).segments[0];
            assert_eq!(segment.words, ["printf", "ok"], "{command}");
            assert_eq!(segment.redirections.len(), 1);
            assert_eq!(
                serde_json::to_value(&segment.redirections[0]).unwrap()["kind"],
                "stdio_duplication"
            );
        }
        for command in ["printf '%s' '2>&1'", "printf '%s' 2\\>\\&1"] {
            let inspection = inspect_shell_command(command).expect(command);
            assert!(inspection.segments[0].redirections.is_empty());
            assert_eq!(inspection.segments[0].words.last().unwrap(), "2>&1");
        }
        for command in [
            "printf '%s' '2'>&1",
            "printf '%s' \\2>&1",
            "printf '%s' 2 >&1",
        ] {
            let inspection = inspect_shell_command(command).expect(command);
            assert_eq!(inspection.segments[0].words, ["printf", "%s", "2"]);
            assert_eq!(inspection.segments[0].redirections[0].source_fd, Some(1));
        }
    }

    #[test]
    fn stdio_duplication_keeps_background_and_descriptor_escapes_closed() {
        for command in [
            "printf ok 2>&1 &",
            "printf ok 2>&1& echo no",
            "printf ok 2> &1",
            "printf ok 3>&1",
            "printf ok 2>&3",
            "printf ok 2>&0",
            "printf ok 0>&1",
            "printf ok 3>captured.txt",
            "printf ok 9>>captured.txt",
            "cat 9<captured.txt",
            "printf ok 2>&-",
            "printf ok 2>&1-",
            "printf ok 2>&file",
            "printf ok 2<&1",
            "printf ok 2>>&1",
            "printf ok 2>&1$(pwd)",
            "printf ok 2>&1; sh -c pwd",
            "printf ok 2>&1 > ../outside",
            "printf ok 2>&1 > /tmp/outside",
        ] {
            inspect_shell_command(command).expect_err(command);
        }
    }

    #[cfg(unix)]
    #[test]
    fn stdio_duplication_is_not_a_workspace_file_but_file_redirects_still_are() {
        let root = workspace();
        let outside = workspace();
        fs::write(outside.path().join("secret"), "untouched").unwrap();
        std::os::unix::fs::symlink(outside.path().join("secret"), root.path().join("1")).unwrap();
        prepare_trusted_shell_execution(root.path(), root.path(), "printf ok 2>&1")
            .expect("descriptor 1 is not the symlink named 1");
        prepare_trusted_shell_execution(root.path(), root.path(), "printf ok 2>1")
            .expect_err("a file redirect through the same symlink still escapes");
        assert_eq!(
            fs::read_to_string(outside.path().join("secret")).unwrap(),
            "untouched"
        );
    }

    #[cfg(unix)]
    #[test]
    fn stdio_duplication_executes_original_stderr_routing_and_file_order() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let root = workspace();
        runtime.block_on(async {
            let result = execute_trusted_shell(
                root.path(),
                root.path(),
                "ls definitely-missing-stdio-duplication 2>&1 || printf FALLBACK",
                Duration::from_secs(2),
                None,
            )
            .await
            .expect("execute merged stderr");
            assert!(result.success);
            assert!(result
                .stdout
                .contains("definitely-missing-stdio-duplication"));
            assert!(result.stdout.ends_with("FALLBACK"));
            assert!(result.stderr.is_empty());
            let reversed = execute_trusted_shell(
                root.path(),
                root.path(),
                "printf stdout 1>&2",
                Duration::from_secs(2),
                None,
            )
            .await
            .expect("execute stdout-to-stderr");
            assert!(reversed.success);
            assert_eq!(reversed.stdout, "");
            assert_eq!(reversed.stderr, "stdout");
            let to_file = execute_trusted_shell(
                root.path(),
                root.path(),
                "ls definitely-missing-stdio-duplication > captured.txt 2>&1 || printf FALLBACK",
                Duration::from_secs(2),
                None,
            )
            .await
            .expect("file target remains workspace-bound");
            assert_eq!(to_file.stdout, "FALLBACK");
            assert!(to_file.stderr.is_empty());
            assert!(fs::read_to_string(root.path().join("captured.txt"))
                .unwrap()
                .contains("definitely-missing-stdio-duplication"));
            let from_original_stdout = execute_trusted_shell(
                root.path(),
                root.path(),
                "ls definitely-missing-stdio-duplication 2>&1 > captured.txt || printf FALLBACK",
                Duration::from_secs(2),
                None,
            )
            .await
            .expect("descriptor duplication keeps its original position");
            assert!(from_original_stdout
                .stdout
                .contains("definitely-missing-stdio-duplication"));
            assert!(from_original_stdout.stdout.ends_with("FALLBACK"));
            assert!(from_original_stdout.stderr.is_empty());
            assert_eq!(
                fs::read_to_string(root.path().join("captured.txt")).unwrap(),
                ""
            );
        });
    }

    #[test]
    fn quoted_newline_is_literal_argv_without_additional_shell_segments() {
        for quote in ['\'', '"'] {
            let body = "first line\nsecond line\r\nthird line";
            let command = format!("printf '%s' {quote}{body}{quote}");
            let inspection =
                inspect_shell_command(&command).expect("quoted line breaks are argv data");
            assert_eq!(inspection.segments.len(), 1);
            assert_eq!(inspection.segments[0].words, ["printf", "%s", body]);
            assert_eq!(inspection.command, command);
        }
        let script = "var score = 0;\nscore += 1;\n";
        let inspection = inspect_shell_command(&format!("tool --eval '{script}'"))
            .expect("multiline language snippets remain one argument");
        assert_eq!(inspection.segments[0].words, ["tool", "--eval", script]);
    }

    #[test]
    fn quoted_newline_keeps_unquoted_controls_and_expansion_rejected() {
        for command in [
            "printf ok\nprintf bad",
            "printf ok\r\nprintf bad",
            "\nprintf ok",
            "printf ok\n",
            "printf 'literal\nnewline'\nprintf bad",
            "printf ok \\\nprintf bad",
            "printf \"literal\\\ncontinuation\"",
            "printf \"literal\n$(pwd)\"",
            "printf \"literal\n$HOME\"",
            "printf \"literal\n`pwd`\"",
            "printf 'literal\n\0'",
            "printf 'unterminated\n",
            "printf \"unterminated\n",
        ] {
            inspect_shell_command(command).expect_err(command);
        }
    }

    #[cfg(unix)]
    #[test]
    fn quoted_newline_executes_literal_bytes_and_a_multiline_python_filter() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let root = workspace();
        runtime.block_on(async {
            let body = "first line\nsecond line\r\nthird line";
            let output = execute_trusted_shell(root.path(), root.path(), &format!("printf '%s' '{body}'"),
                Duration::from_secs(2), None).await.expect("quoted bytes reach the real process unchanged");
            assert!(output.success);
            assert_eq!(output.stdout, body);
            assert_eq!(output.stderr, "");
            let command = r#"printf '%s' '{"data":{"items":[{"name":"pipeline","version":"0.9"}]}}' | python3 -c "
import json,sys
for item in json.load(sys.stdin)['data']['items']:
    if 'pipeline' in item['name']:
        print(item['name'] + ': ' + item['version'])
""#;
            let inspection = inspect_shell_command(command).expect("quoted Python is not a multiline shell program");
            assert_eq!(inspection.segments.len(), 2);
            assert_eq!(inspection.segments[0].connector_after, Some(ShellConnector::Pipe));
            assert_eq!(inspection.segments[1].words[0..2], ["python3", "-c"]);
            assert!(inspection.segments[1].words[2].starts_with("\nimport json,sys\n"));
            let output = execute_trusted_shell(root.path(), root.path(), command,
                Duration::from_secs(3), None).await.expect("a real Python filter can consume the pipeline");
            assert!(output.success, "{}", output.stderr);
            assert_eq!(output.stdout, "pipeline: 0.9\n");
            assert_eq!(output.stderr, "");
        });
    }

    #[test]
    fn workspace_bound_shell_accepts_absolute_argv_inside_the_canonical_root() {
        let temp = workspace();
        let root = temp.path().join("Workspace With Spaces");
        fs::create_dir_all(root.join("Assets")).unwrap();
        fs::write(root.join("Assets/input.txt"), "input").unwrap();
        let canonical = canonical_workspace_root(&root).unwrap();
        let canonical_text = canonical.display().to_string();
        for command in [
            format!(
                "tool inspect --project-path '{}' --format json",
                canonical_text
            ),
            format!(
                "tool inspect --project-path '{}' --format json",
                root.display()
            ),
            format!("tool inspect --project-path='{}'", canonical_text),
            format!("tool inspect -C'{}'", canonical_text),
            format!("PROJECT_PATH='{}' tool inspect", canonical_text),
            format!("cat '{}/Assets/input.txt'", canonical_text),
            format!("tool inspect --output='{}/Assets/new.txt'", canonical_text),
        ] {
            inspect_shell_command(&command).expect_err("unbound inspection remains strict");
            let prepared = prepare_trusted_shell_execution(&root, &root, &command)
                .unwrap_or_else(|error| panic!("{command}: {error}"));
            assert_eq!(prepared.inspection().command, command);
            assert_eq!(prepared.working_directory(), canonical);
        }
    }

    #[test]
    fn workspace_bound_shell_rejects_absolute_escapes_and_redirections() {
        let temp = workspace();
        let root = temp.path().join("project");
        let sibling = temp.path().join("project-other");
        fs::create_dir_all(root.join("safe")).unwrap();
        fs::create_dir_all(&sibling).unwrap();
        let canonical = canonical_workspace_root(&root).unwrap();
        let sibling = fs::canonicalize(sibling).unwrap();
        for command in [
            format!("tool inspect --project-path '{}'", sibling.display()),
            format!("tool inspect --project-path='{}'", sibling.display()),
            format!("tool inspect -C'{}'", sibling.display()),
            format!("tool inspect '{}/safe/../safe'", canonical.display()),
            format!("printf ok > '{}/out.txt'", canonical.display()),
            "tool inspect ../outside".to_string(),
        ] {
            prepare_trusted_shell_execution(&root, &root, &command).expect_err(&command);
        }
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&sibling, root.join("escape")).unwrap();
            fs::write(sibling.join("secret.txt"), "secret").unwrap();
            std::os::unix::fs::symlink(sibling.join("secret.txt"), root.join("escape-file "))
                .unwrap();
            for command in [
                format!("cat '{}/escape-file '", canonical.display()),
                "cat 'escape-file '".to_string(),
            ] {
                prepare_trusted_shell_execution(&root, &root, &command).expect_err(&command);
            }
            for suffix in ["escape", "escape/missing.txt"] {
                let command = format!(
                    "tool inspect --project-path='{}/{}'",
                    canonical.display(),
                    suffix
                );
                prepare_trusted_shell_execution(&root, &root, &command).expect_err(&command);
            }
        }
    }

    #[test]
    fn workspace_path_rejects_parent_and_symlink_escape() {
        let workspace = workspace();
        let outside = tempfile::tempdir().expect("outside temp dir");
        fs::create_dir_all(workspace.path().join("safe")).unwrap();
        assert!(resolve_workspace_path(
            workspace.path(),
            "safe/new.txt",
            WorkspacePathMode::AllowMissing
        )
        .is_ok());
        assert!(matches!(
            resolve_workspace_path(
                workspace.path(),
                "../outside.txt",
                WorkspacePathMode::AllowMissing
            ),
            Err(WorkspacePathError::Escape { .. })
        ));

        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(outside.path(), workspace.path().join("escape")).unwrap();
            assert!(matches!(
                resolve_workspace_path(
                    workspace.path(),
                    "escape/secret.txt",
                    WorkspacePathMode::AllowMissing
                ),
                Err(WorkspacePathError::Escape { .. })
            ));
        }
    }

    #[cfg(unix)]
    #[test]
    fn execution_boundary_rejects_symlink_path_arguments_and_missing_children() {
        let workspace = workspace();
        let outside = tempfile::tempdir().expect("outside temp dir");
        fs::write(outside.path().join("secret.txt"), "secret").unwrap();
        fs::write(workspace.path().join("inside.txt"), "inside").unwrap();
        std::os::unix::fs::symlink(
            outside.path().join("secret.txt"),
            workspace.path().join("link-file"),
        )
        .unwrap();
        std::os::unix::fs::symlink(outside.path(), workspace.path().join("escape-dir")).unwrap();
        std::os::unix::fs::symlink(
            outside.path().join("secret.txt"),
            workspace.path().join("link-script"),
        )
        .unwrap();

        prepare_trusted_shell_execution(workspace.path(), workspace.path(), "cat inside.txt")
            .expect("ordinary in-workspace path remains valid");
        for command in [
            "cat link-file",
            "cat escape-dir/secret.txt",
            "cat escape-dir/missing.txt",
            "cat --input=escape-dir/missing.txt",
            "git -C escape-dir status",
            "git -Cescape-dir status",
            "./link-script",
        ] {
            prepare_trusted_shell_execution(workspace.path(), workspace.path(), command)
                .expect_err(command);
        }
    }

    #[cfg(unix)]
    #[test]
    fn execution_result_reports_timeout_reap_and_truncation() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let workspace = workspace();
        runtime.block_on(async {
            let output = execute_trusted_shell(
                workspace.path(),
                workspace.path(),
                "printf abcdef",
                Duration::from_secs(2),
                Some(4),
            )
            .await
            .expect("bounded output");
            assert!(output.success);
            assert_eq!(output.exit_code, Some(0));
            assert_eq!(output.stdout, "abcd");
            assert!(output.truncated);
            assert!(output.stdout_truncated);
            assert!(!output.stderr_truncated);
            assert!(!output.timed_out);

            let stderr_output = execute_trusted_shell(
                workspace.path(),
                workspace.path(),
                "ls definitely-missing-trusted-execution-path",
                Duration::from_secs(2),
                Some(4),
            )
            .await
            .expect("stderr has an independent output bound");
            assert!(!stderr_output.success);
            assert!(!stderr_output.stdout_truncated);
            assert!(stderr_output.stderr_truncated);
            assert_eq!(stderr_output.stderr.len(), 4);

            let high_volume = execute_trusted_shell(
                workspace.path(),
                workspace.path(),
                "yes x | head -c 1000000",
                Duration::from_secs(2),
                Some(32),
            )
            .await
            .expect("high-volume output is drained without retaining it");
            assert_eq!(high_volume.stdout.len(), 32);
            assert!(high_volume.stdout_truncated);

            let timed_out = execute_trusted_shell(
                workspace.path(),
                workspace.path(),
                "sleep 2",
                Duration::from_millis(25),
                Some(1024),
            )
            .await
            .expect("timeout is a structured result");
            assert!(!timed_out.success);
            assert!(timed_out.timed_out);
            assert!(!timed_out.truncated);
        });
    }

    #[cfg(unix)]
    #[test]
    fn timeout_kills_and_reaps_the_complete_process_group() {
        use std::os::unix::fs::PermissionsExt;

        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .start_paused(true)
            .build()
            .unwrap();
        let workspace = workspace();
        let script = workspace.path().join("spawn-child.sh");
        fs::write(
            &script,
            "#!/bin/sh\nsleep 30 &\necho $! > child.pid\nwait\n",
        )
        .unwrap();
        let mut permissions = fs::metadata(&script).unwrap().permissions();
        permissions.set_mode(0o700);
        fs::set_permissions(&script, permissions).unwrap();
        let workspace_path = workspace.path().to_path_buf();

        let child_pid = runtime.block_on(async {
            let execution_workspace = workspace_path.clone();
            let execution = tokio::spawn(execute_trusted_shell(
                execution_workspace.clone(),
                execution_workspace,
                "./spawn-child.sh",
                Duration::from_secs(30),
                Some(1024),
            ));
            let pid_path = workspace_path.join("child.pid");
            let handshake_started = Instant::now();
            let child_pid = loop {
                if let Ok(raw_pid) = fs::read_to_string(&pid_path) {
                    if let Ok(pid) = raw_pid.trim().parse::<i32>() {
                        break pid;
                    }
                }
                assert!(
                    handshake_started.elapsed() < Duration::from_secs(5),
                    "script must publish its child pid before virtual timeout"
                );
                std::thread::sleep(Duration::from_millis(1));
                tokio::task::yield_now().await;
            };

            // Start the timeout clock only after the descendant is observable.
            // Virtual time makes the process-group assertion deterministic
            // even while the complete suite is under CPU or process pressure.
            tokio::time::advance(Duration::from_secs(31)).await;
            // The execution timeout is now elapsed. Resume wall time before
            // awaiting OS pipe closure so the independent two-second capture
            // cleanup budget is not auto-advanced ahead of SIGKILL delivery.
            tokio::time::resume();
            let result = execution
                .await
                .expect("trusted execution task must join")
                .expect("timeout is reported after group termination");
            assert!(result.timed_out);
            child_pid
        });

        let started = Instant::now();
        while unsafe { kill(child_pid, 0) } == 0 && started.elapsed() < Duration::from_secs(1) {
            std::thread::sleep(Duration::from_millis(10));
        }
        assert_ne!(
            unsafe { kill(child_pid, 0) },
            0,
            "timed-out descendant process must not survive its execution group"
        );
    }
}
