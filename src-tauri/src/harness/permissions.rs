use serde::{Deserialize, Serialize};
use std::fmt;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionConfig {
    pub shell: ShellPermissions,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellPermissions {
    pub allow: Vec<String>,
    pub deny: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionDecision {
    pub command: String,
    pub allowed_by: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PermissionError {
    Denied { command: String, rule: String },
    NotAllowed { command: String },
    InvalidConfig { path: PathBuf, message: String },
}

impl fmt::Display for PermissionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Denied { command, rule } => {
                write!(
                    formatter,
                    "命令被权限规则拒绝: `{command}` matches `{rule}`"
                )
            }
            Self::NotAllowed { command } => {
                write!(
                    formatter,
                    "命令未在 .MAIN/permissions.yaml allow 列表中: `{command}`"
                )
            }
            Self::InvalidConfig { path, message } => {
                write!(formatter, "权限配置无效 {}: {message}", path.display())
            }
        }
    }
}

impl std::error::Error for PermissionError {}

#[derive(Debug, Clone)]
pub struct PermissionGuard {
    config: PermissionConfig,
}

impl PermissionConfig {
    pub fn default_runtime_foundation() -> Self {
        Self {
            shell: ShellPermissions {
                allow: vec![
                    "ls".to_string(),
                    "rg".to_string(),
                    "cargo check".to_string(),
                    "cargo test".to_string(),
                    "npm run build".to_string(),
                    "npm run lint".to_string(),
                    "node scripts/plan_completion_check.mjs".to_string(),
                ],
                deny: vec!["sudo".to_string(), "rm -rf /".to_string()],
            },
        }
    }

    pub fn from_yaml(input: &str, path: impl Into<PathBuf>) -> Result<Self, PermissionError> {
        let path = path.into();
        let mut allow = Vec::new();
        let mut deny = Vec::new();
        let mut in_shell = false;
        let mut list_name: Option<&str> = None;

        for raw_line in input.lines() {
            let line = raw_line.split('#').next().unwrap_or("").trim_end();
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }

            match trimmed {
                "shell:" => {
                    in_shell = true;
                    list_name = None;
                    continue;
                }
                "allow:" if in_shell => {
                    list_name = Some("allow");
                    continue;
                }
                "deny:" if in_shell => {
                    list_name = Some("deny");
                    continue;
                }
                _ => {}
            }

            let Some(rest) = trimmed.strip_prefix("- ") else {
                continue;
            };
            let Some(target_list) = list_name else {
                return Err(PermissionError::InvalidConfig {
                    path,
                    message: "列表项必须位于 shell.allow 或 shell.deny 下".to_string(),
                });
            };

            let value =
                unquote_yaml_scalar(rest.trim()).ok_or_else(|| PermissionError::InvalidConfig {
                    path: path.clone(),
                    message: format!("无法解析权限项: {rest}"),
                })?;

            if value.is_empty() {
                return Err(PermissionError::InvalidConfig {
                    path,
                    message: "权限项不能为空".to_string(),
                });
            }

            match target_list {
                "allow" => allow.push(value),
                "deny" => deny.push(value),
                _ => {}
            }
        }

        Ok(Self {
            shell: ShellPermissions { allow, deny },
        })
    }
}

impl PermissionGuard {
    pub fn new(config: PermissionConfig) -> Self {
        Self { config }
    }

    pub fn from_workspace(workspace: impl AsRef<Path>) -> Result<Self, PermissionError> {
        let permissions_path = workspace.as_ref().join(".MAIN").join("permissions.yaml");
        if !permissions_path.exists() {
            return Ok(Self::new(PermissionConfig::default_runtime_foundation()));
        }

        let content = fs::read_to_string(&permissions_path).map_err(|error| {
            PermissionError::InvalidConfig {
                path: permissions_path.clone(),
                message: error.to_string(),
            }
        })?;
        let config = PermissionConfig::from_yaml(&content, permissions_path)?;
        Ok(Self::new(config))
    }

    pub fn validate(&self, command: &str) -> Result<PermissionDecision, PermissionError> {
        let trimmed = command.trim();
        for deny_rule in &self.config.shell.deny {
            if command_mentions_rule(trimmed, deny_rule) {
                return Err(PermissionError::Denied {
                    command: trimmed.to_string(),
                    rule: deny_rule.clone(),
                });
            }
        }

        let segments = split_shell_segments(trimmed);
        if segments.is_empty() {
            return Err(PermissionError::NotAllowed {
                command: trimmed.to_string(),
            });
        }

        let mut matched_rule = None;
        for segment in segments {
            let Some(rule) = self
                .config
                .shell
                .allow
                .iter()
                .find(|rule| command_starts_with_rule(&segment, rule))
            else {
                return Err(PermissionError::NotAllowed { command: segment });
            };
            matched_rule = Some(rule.clone());
        }

        Ok(PermissionDecision {
            command: trimmed.to_string(),
            allowed_by: matched_rule,
        })
    }
}

fn unquote_yaml_scalar(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.len() >= 2 {
        if let Some(inner) = trimmed
            .strip_prefix('"')
            .and_then(|value| value.strip_suffix('"'))
        {
            return Some(inner.replace("\\\"", "\""));
        }
        if let Some(inner) = trimmed
            .strip_prefix('\'')
            .and_then(|value| value.strip_suffix('\''))
        {
            return Some(inner.to_string());
        }
    }
    Some(trimmed.to_string())
}

fn command_starts_with_rule(command: &str, rule: &str) -> bool {
    let command = command.trim();
    let rule = rule.trim();
    command == rule
        || command
            .strip_prefix(rule)
            .and_then(|tail| tail.chars().next())
            .is_some_and(char::is_whitespace)
}

fn command_mentions_rule(command: &str, rule: &str) -> bool {
    let command = command.trim();
    let rule = rule.trim();
    if rule.contains(char::is_whitespace) {
        return command == rule
            || command.contains(&format!(" {rule}"))
            || command.starts_with(&format!("{rule} "))
            || command.contains(&format!(";{rule}"))
            || command.contains(&format!("&&{rule}"))
            || command.contains(&format!("||{rule}"));
    }

    split_shell_words(command)
        .iter()
        .any(|word| word == rule || word.starts_with(&format!("{rule};")))
}

fn split_shell_segments(command: &str) -> Vec<String> {
    let mut segments = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    let mut chars = command.chars().peekable();

    while let Some(ch) = chars.next() {
        if matches!(ch, '\'' | '"') {
            quote = match quote {
                Some(existing) if existing == ch => None,
                None => Some(ch),
                other => other,
            };
            current.push(ch);
            continue;
        }

        if quote.is_none() && matches!(ch, ';' | '|') {
            push_segment(&mut segments, &mut current);
            if ch == '|' && chars.peek().is_some_and(|next| *next == '|') {
                let _ = chars.next();
            }
            continue;
        }

        if quote.is_none() && ch == '&' && chars.peek().is_some_and(|next| *next == '&') {
            push_segment(&mut segments, &mut current);
            let _ = chars.next();
            continue;
        }

        current.push(ch);
    }

    push_segment(&mut segments, &mut current);
    segments
}

fn push_segment(segments: &mut Vec<String>, current: &mut String) {
    let segment = current.trim();
    if !segment.is_empty() {
        segments.push(segment.to_string());
    }
    current.clear();
}

fn split_shell_words(command: &str) -> Vec<String> {
    let mut words = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;

    for ch in command.chars() {
        if matches!(ch, '\'' | '"') {
            quote = match quote {
                Some(existing) if existing == ch => None,
                None => Some(ch),
                other => other,
            };
            continue;
        }

        if quote.is_none() && (ch.is_whitespace() || matches!(ch, ';' | '|' | '&')) {
            if !current.is_empty() {
                words.push(std::mem::take(&mut current));
            }
            continue;
        }

        current.push(ch);
    }

    if !current.is_empty() {
        words.push(current);
    }
    words
}

#[cfg(test)]
mod tests {
    use super::{PermissionConfig, PermissionError, PermissionGuard};

    #[test]
    fn validate_allows_each_shell_segment() {
        let guard = PermissionGuard::new(PermissionConfig::default_runtime_foundation());

        let decision = guard
            .validate("cargo test --lib && npm run build")
            .expect("allowed phase one commands should pass");

        assert_eq!(decision.command, "cargo test --lib && npm run build");
    }

    #[test]
    fn validate_denies_rule_even_inside_chained_command() {
        let guard = PermissionGuard::new(PermissionConfig::default_runtime_foundation());

        let error = guard
            .validate("ls && sudo whoami")
            .expect_err("sudo must be denied");

        assert!(matches!(error, PermissionError::Denied { .. }));
    }

    #[test]
    fn yaml_parser_reads_shell_permissions() {
        let parsed = PermissionConfig::from_yaml(
            r#"
shell:
  allow:
    - ls
    - "cargo test"

  deny:
    - sudo
"#,
            ".MAIN/permissions.yaml",
        )
        .expect("valid permissions yaml should parse");

        assert_eq!(parsed.shell.allow, vec!["ls", "cargo test"]);
        assert_eq!(parsed.shell.deny, vec!["sudo"]);
    }
}
