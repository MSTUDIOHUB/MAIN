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
    #[serde(default)]
    pub ask: Vec<String>,
    pub deny: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PermissionDecisionKind {
    Allow,
    Ask,
    Deny,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionSegmentDecision {
    pub command: String,
    pub decision: PermissionDecisionKind,
    pub matched_rule: Option<String>,
    pub suggested_rule: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionDecision {
    pub command: String,
    pub decision: PermissionDecisionKind,
    pub source: String,
    pub source_path: Option<String>,
    pub segment_decisions: Vec<PermissionSegmentDecision>,
    pub allowed_by: Option<String>,
    pub matched_rule: Option<String>,
    pub suggested_rule: Option<String>,
    pub requires_approval: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellPermissionApproval {
    pub command: String,
    #[serde(default)]
    pub approved_at_ms: Option<u64>,
    #[serde(default)]
    pub scope: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PermissionError {
    Denied {
        command: String,
        rule: String,
    },
    ApprovalRequired {
        command: String,
        suggested_rule: String,
    },
    NotAllowed {
        command: String,
    },
    InvalidConfig {
        path: PathBuf,
        message: String,
    },
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
            Self::ApprovalRequired {
                command,
                suggested_rule,
            } => {
                write!(
                    formatter,
                    "命令需要用户批准后才能执行: `{command}` (suggested rule `{suggested_rule}`)"
                )
            }
            Self::NotAllowed { command } => {
                write!(formatter, "命令未被当前 shell 权限策略允许: `{command}`")
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
    source: String,
    source_path: Option<PathBuf>,
}

impl PermissionConfig {
    pub fn default_runtime_foundation() -> Self {
        Self {
            shell: ShellPermissions {
                allow: vec![
                    "pwd".to_string(),
                    "ls".to_string(),
                    "rg".to_string(),
                    "which".to_string(),
                    "command -v".to_string(),
                    "cd".to_string(),
                    "git status".to_string(),
                    "git diff".to_string(),
                    "node --version".to_string(),
                    "npm --version".to_string(),
                    "cargo --version".to_string(),
                    "rustc --version".to_string(),
                    "cargo check".to_string(),
                    "cargo test".to_string(),
                    "npm run build".to_string(),
                    "npm run lint".to_string(),
                    "node scripts/plan_completion_check.mjs".to_string(),
                ],
                ask: vec![
                    "npm create".to_string(),
                    "npm install".to_string(),
                    "npm add".to_string(),
                    "npx".to_string(),
                    "npm run dev".to_string(),
                    "npm run tauri".to_string(),
                    "cargo tauri dev".to_string(),
                    "cargo tauri build".to_string(),
                    "cargo run".to_string(),
                    "cargo build".to_string(),
                ],
                deny: vec!["sudo".to_string(), "rm -rf /".to_string()],
            },
        }
    }

    pub fn from_yaml(input: &str, path: impl Into<PathBuf>) -> Result<Self, PermissionError> {
        let path = path.into();
        let mut allow = Vec::new();
        let mut ask = Vec::new();
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
                "ask:" if in_shell => {
                    list_name = Some("ask");
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
                    message: "列表项必须位于 shell.allow、shell.ask 或 shell.deny 下".to_string(),
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
                "ask" => ask.push(value),
                "deny" => deny.push(value),
                _ => {}
            }
        }

        Ok(Self {
            shell: ShellPermissions { allow, ask, deny },
        })
    }
}

impl PermissionGuard {
    pub fn new(config: PermissionConfig) -> Self {
        Self {
            config,
            source: "builtin_default".to_string(),
            source_path: None,
        }
    }

    pub fn with_source(
        config: PermissionConfig,
        source: impl Into<String>,
        source_path: Option<PathBuf>,
    ) -> Self {
        Self {
            config,
            source: source.into(),
            source_path,
        }
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
        let config = PermissionConfig::from_yaml(&content, permissions_path.clone())?;
        Ok(Self::with_source(
            config,
            "workspace_file",
            Some(permissions_path),
        ))
    }

    pub fn inspect(&self, command: &str) -> PermissionDecision {
        let trimmed = command.trim();
        let segments = split_shell_segments(trimmed);
        if segments.is_empty() {
            return self.build_decision(trimmed, PermissionDecisionKind::Deny, Vec::new());
        }

        let mut segment_decisions = Vec::new();
        let mut overall = PermissionDecisionKind::Allow;
        for segment in segments {
            if let Some(rule) = self
                .config
                .shell
                .deny
                .iter()
                .find(|rule| command_mentions_rule(&segment, rule))
            {
                overall = PermissionDecisionKind::Deny;
                segment_decisions.push(PermissionSegmentDecision {
                    command: segment,
                    decision: PermissionDecisionKind::Deny,
                    matched_rule: Some(rule.clone()),
                    suggested_rule: None,
                });
                continue;
            }

            if let Some(rule) = self
                .config
                .shell
                .allow
                .iter()
                .find(|rule| command_starts_with_rule(&segment, rule))
            {
                segment_decisions.push(PermissionSegmentDecision {
                    command: segment,
                    decision: PermissionDecisionKind::Allow,
                    matched_rule: Some(rule.clone()),
                    suggested_rule: None,
                });
                continue;
            }

            if let Some(rule) = self
                .config
                .shell
                .ask
                .iter()
                .find(|rule| command_starts_with_rule(&segment, rule))
            {
                overall = PermissionDecisionKind::Ask;
                segment_decisions.push(PermissionSegmentDecision {
                    command: segment,
                    decision: PermissionDecisionKind::Ask,
                    matched_rule: Some(rule.clone()),
                    suggested_rule: Some(rule.clone()),
                });
                continue;
            }

            overall = PermissionDecisionKind::Deny;
            segment_decisions.push(PermissionSegmentDecision {
                command: segment.clone(),
                decision: PermissionDecisionKind::Deny,
                matched_rule: None,
                suggested_rule: Some(suggest_shell_rule(&segment)),
            });
        }

        self.build_decision(trimmed, overall, segment_decisions)
    }

    pub fn validate(&self, command: &str) -> Result<PermissionDecision, PermissionError> {
        self.validate_with_approval(command, None)
    }

    pub fn validate_with_approval(
        &self,
        command: &str,
        approval: Option<&ShellPermissionApproval>,
    ) -> Result<PermissionDecision, PermissionError> {
        let decision = self.inspect(command);
        match decision.decision {
            PermissionDecisionKind::Allow => Ok(decision),
            PermissionDecisionKind::Ask => {
                let approved_command = approval.map(|value| value.command.trim()).unwrap_or("");
                if approved_command == decision.command {
                    Ok(decision)
                } else {
                    Err(PermissionError::ApprovalRequired {
                        command: decision.command,
                        suggested_rule: decision
                            .suggested_rule
                            .unwrap_or_else(|| suggest_shell_rule(command)),
                    })
                }
            }
            PermissionDecisionKind::Deny => {
                if let Some(segment) = decision.segment_decisions.iter().find(|segment| {
                    segment.decision == PermissionDecisionKind::Deny
                        && segment.matched_rule.is_some()
                }) {
                    return Err(PermissionError::Denied {
                        command: segment.command.clone(),
                        rule: segment.matched_rule.clone().unwrap_or_default(),
                    });
                }
                Err(PermissionError::NotAllowed {
                    command: decision
                        .segment_decisions
                        .iter()
                        .find(|segment| segment.decision == PermissionDecisionKind::Deny)
                        .or_else(|| decision.segment_decisions.first())
                        .map(|segment| segment.command.clone())
                        .unwrap_or(decision.command),
                })
            }
        }
    }

    fn build_decision(
        &self,
        command: &str,
        decision: PermissionDecisionKind,
        segment_decisions: Vec<PermissionSegmentDecision>,
    ) -> PermissionDecision {
        let primary_segment = match &decision {
            PermissionDecisionKind::Allow => segment_decisions.last(),
            PermissionDecisionKind::Ask => segment_decisions
                .iter()
                .rev()
                .find(|segment| segment.decision == PermissionDecisionKind::Ask),
            PermissionDecisionKind::Deny => segment_decisions
                .iter()
                .find(|segment| segment.decision == PermissionDecisionKind::Deny),
        };
        let matched_rule = primary_segment.and_then(|segment| segment.matched_rule.clone());
        let suggested_rule = primary_segment
            .and_then(|segment| segment.suggested_rule.clone())
            .or_else(|| {
                if matches!(
                    decision,
                    PermissionDecisionKind::Ask | PermissionDecisionKind::Deny
                ) {
                    Some(suggest_shell_rule(command))
                } else {
                    None
                }
            });
        let allowed_by = if matches!(decision, PermissionDecisionKind::Allow) {
            matched_rule.clone()
        } else {
            None
        };

        PermissionDecision {
            command: command.to_string(),
            decision: decision.clone(),
            source: self.source.clone(),
            source_path: self
                .source_path
                .as_ref()
                .map(|path| path.display().to_string()),
            segment_decisions,
            allowed_by,
            matched_rule,
            suggested_rule,
            requires_approval: matches!(decision, PermissionDecisionKind::Ask),
        }
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

fn suggest_shell_rule(command: &str) -> String {
    let words = split_shell_words(command);
    if words.is_empty() {
        return command.trim().to_string();
    }
    if words.len() >= 2 {
        let first_two = format!("{} {}", words[0], words[1]);
        if matches!(
            first_two.as_str(),
            "npm create"
                | "npm install"
                | "npm add"
                | "npm run"
                | "cargo tauri"
                | "cargo run"
                | "cargo build"
                | "git status"
                | "git diff"
                | "command -v"
                | "node --version"
                | "npm --version"
                | "cargo --version"
                | "rustc --version"
        ) {
            return first_two;
        }
    }
    words[0].clone()
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
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn make_temp_workspace(name: &str) -> std::path::PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("main-permissions-{name}-{unique}"));
        fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn validate_allows_each_shell_segment() {
        let guard = PermissionGuard::new(PermissionConfig::default_runtime_foundation());

        let decision = guard
            .validate("cargo test --lib && npm run build")
            .expect("allowed phase one commands should pass");

        assert_eq!(decision.command, "cargo test --lib && npm run build");
        assert_eq!(decision.decision, super::PermissionDecisionKind::Allow);
        assert_eq!(decision.source, "builtin_default");
    }

    #[test]
    fn validate_denies_rule_even_inside_chained_command() {
        let guard = PermissionGuard::new(PermissionConfig::default_runtime_foundation());
        let decision = guard.inspect("ls && sudo whoami");

        assert_eq!(decision.decision, super::PermissionDecisionKind::Deny);
        assert_eq!(decision.segment_decisions[1].command, "sudo whoami");
        assert_eq!(decision.matched_rule.as_deref(), Some("sudo"));

        let error = guard
            .validate("ls && sudo whoami")
            .expect_err("sudo must be denied");

        assert!(matches!(error, PermissionError::Denied { .. }));
    }

    #[test]
    fn missing_workspace_permissions_uses_builtin_default_source() {
        let workspace = make_temp_workspace("builtin-default");
        let guard = PermissionGuard::from_workspace(&workspace)
            .expect("missing permissions file should fall back to built-in defaults");

        let decision = guard.inspect("which cargo");

        assert_eq!(decision.source, "builtin_default");
        assert_eq!(decision.source_path, None);
        assert_eq!(decision.decision, super::PermissionDecisionKind::Allow);
    }

    #[test]
    fn chained_segments_report_per_segment_decisions() {
        let guard = PermissionGuard::new(PermissionConfig::default_runtime_foundation());

        let decision =
            guard.inspect("which cargo && npm create vite@latest . -- --template react-ts");

        assert_eq!(decision.decision, super::PermissionDecisionKind::Ask);
        assert_eq!(decision.segment_decisions.len(), 2);
        assert_eq!(
            decision.segment_decisions[0].decision,
            super::PermissionDecisionKind::Allow
        );
        assert_eq!(
            decision.segment_decisions[1].decision,
            super::PermissionDecisionKind::Ask
        );
        assert_eq!(decision.suggested_rule.as_deref(), Some("npm create"));
    }

    #[test]
    fn yaml_parser_reads_shell_permissions() {
        let parsed = PermissionConfig::from_yaml(
            r#"
shell:
  allow:
    - ls
    - "cargo test"
  ask:
    - "npm create"

  deny:
    - sudo
"#,
            ".MAIN/permissions.yaml",
        )
        .expect("valid permissions yaml should parse");

        assert_eq!(parsed.shell.allow, vec!["ls", "cargo test"]);
        assert_eq!(parsed.shell.ask, vec!["npm create"]);
        assert_eq!(parsed.shell.deny, vec!["sudo"]);
    }

    #[test]
    fn default_policy_marks_scaffolding_as_ask() {
        let guard = PermissionGuard::new(PermissionConfig::default_runtime_foundation());

        let decision = guard.inspect("npm create vite@latest . -- --template react-ts");

        assert_eq!(decision.decision, super::PermissionDecisionKind::Ask);
        assert!(decision.requires_approval);
        assert_eq!(decision.suggested_rule.as_deref(), Some("npm create"));
    }

    #[test]
    fn ask_commands_require_matching_approval() {
        let guard = PermissionGuard::new(PermissionConfig::default_runtime_foundation());
        let command = "npm create vite@latest . -- --template react-ts";

        let error = guard
            .validate(command)
            .expect_err("ask command should require approval");
        assert!(matches!(error, PermissionError::ApprovalRequired { .. }));

        let approval = super::ShellPermissionApproval {
            command: command.to_string(),
            approved_at_ms: Some(1),
            scope: Some("once".to_string()),
        };
        let decision = guard
            .validate_with_approval(command, Some(&approval))
            .expect("matching approval should satisfy ask command");
        assert_eq!(decision.decision, super::PermissionDecisionKind::Ask);
    }
}
