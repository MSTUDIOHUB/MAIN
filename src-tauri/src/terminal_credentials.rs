use regex::bytes::Regex;
use std::{borrow::Cow, collections::HashSet, ops::Range, sync::OnceLock};

pub const REDACTED: &str = "[REDACTED]";

fn argument_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(concat!(
            r#"(?i-u)(?:^|[\s\"'`(=\[\]{,:])(?P<argument>--?access[-_]?token)"#,
            r#"(?:(?:[ \t]|\\t)*=(?:[ \t]|\\t)*|(?:[ \t]|\\t)+)"#,
            r#"(?:(?:\\?\")(?P<double>[^\"\r\n]*?)\\?\"|(?:\\?')(?P<single>[^'\r\n]*?)\\?'|"#,
            r#"(?P<plain>\[REDACTED\]|[^\s\\\"',;\]\})]+)|\\?[\"'](?P<open>[^\r\n]+))"#,
        ))
        .expect("valid terminal argument pattern")
    })
}

fn control_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(
            r"(?-u:\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\n]*(?:\x07|\x1b\\)|\x1bP[^\n]*?\x1b\\)",
        )
        .expect("valid terminal control pattern")
    })
}

pub struct CredentialMatch {
    pub argument_start: usize,
    pub value: Range<usize>,
}

/// Ranges use raw byte offsets so PTY resume cursors remain valid.
pub fn credential_matches(raw: &[u8]) -> Vec<CredentialMatch> {
    let mut controls = control_pattern().find_iter(raw).peekable();
    let (visible, offsets) = if controls.peek().is_some() {
        let mut visible = Vec::with_capacity(raw.len());
        let mut offsets = Vec::with_capacity(raw.len());
        let mut start = 0;
        for control in controls {
            visible.extend_from_slice(&raw[start..control.start()]);
            offsets.extend(start..control.start());
            start = control.end();
        }
        visible.extend_from_slice(&raw[start..]);
        offsets.extend(start..raw.len());
        (Cow::Owned(visible), offsets)
    } else {
        (Cow::Borrowed(raw), Vec::new())
    };

    argument_pattern()
        .captures_iter(&visible)
        .filter_map(|capture| {
            let value = ["double", "single", "plain", "open"]
                .into_iter()
                .find_map(|name| capture.name(name))?;
            if value.is_empty() {
                return None;
            }
            let argument_start = capture.name("argument")?.start();
            Some(if offsets.is_empty() {
                CredentialMatch {
                    argument_start,
                    value: value.range(),
                }
            } else {
                CredentialMatch {
                    argument_start: offsets[argument_start],
                    value: offsets[value.start()]..(offsets[value.end() - 1] + 1),
                }
            })
        })
        .collect()
}

pub fn credential_ranges(raw: &[u8]) -> Vec<Range<usize>> {
    credential_matches(raw)
        .into_iter()
        .map(|matched| matched.value)
        .collect()
}

pub fn redact_window(raw: &[u8], start: usize, ranges: &[Range<usize>]) -> Vec<u8> {
    let mut result = Vec::new();
    let mut cursor = start;
    for range in ranges.iter().filter(|range| range.end > start) {
        result.extend_from_slice(&raw[cursor..range.start.max(cursor)]);
        result.extend_from_slice(REDACTED.as_bytes());
        cursor = range.end;
    }
    result.extend_from_slice(&raw[cursor..]);
    result
}

pub fn redact(value: &str) -> Cow<'_, str> {
    let ranges = credential_ranges(value.as_bytes());
    if ranges.is_empty() {
        Cow::Borrowed(value)
    } else {
        Cow::Owned(
            String::from_utf8_lossy(&redact_window(value.as_bytes(), 0, &ranges)).into_owned(),
        )
    }
}

/// Historic debug lines can include verbatim echoes of a token first seen in
/// a process listing. Learn and replace exact values inside this log only.
pub fn redact_history(value: &str) -> Cow<'_, str> {
    let ranges = credential_ranges(value.as_bytes());
    if ranges.is_empty() {
        return Cow::Borrowed(value);
    }
    let mut secrets = ranges
        .iter()
        .filter_map(|range| value.get(range.clone()))
        .filter(|part| {
            part.len() >= 16
                && part
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"._~+/=-".contains(&b))
        })
        .collect::<HashSet<&str>>()
        .into_iter()
        .collect::<Vec<_>>();
    secrets.sort_unstable_by_key(|secret| std::cmp::Reverse(secret.len()));
    let mut clean =
        String::from_utf8_lossy(&redact_window(value.as_bytes(), 0, &ranges)).into_owned();
    for secret in secrets {
        clean = clean.replace(secret, REDACTED);
    }
    Cow::Owned(clean)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_unity_access_token_variants_and_preserves_diagnostics() {
        let input = concat!(
            "/Unity -accessToken synthetic.a.b -projectPath /TestCli\n",
            "--ACCESS_TOKEN=\"synthetic with spaces\"\n",
            "-access-token='other synthetic' -x\n",
            "-accessToken \\\"json synthetic\\\" -x\n",
            "Assets/Test.cs(5,1): error CS1002: 缺少分号\n",
            "-access\x1b[31mToken synthetic\x1b[0m.secret -ok\n",
        );
        let expected = concat!(
            "/Unity -accessToken [REDACTED] -projectPath /TestCli\n",
            "--ACCESS_TOKEN=\"[REDACTED]\"\n",
            "-access-token='[REDACTED]' -x\n",
            "-accessToken \\\"[REDACTED]\\\" -x\n",
            "Assets/Test.cs(5,1): error CS1002: 缺少分号\n",
            "-access\x1b[31mToken [REDACTED] -ok\n",
        );
        assert_eq!(redact(input), expected);
        assert_eq!(redact(expected), expected);
    }

    #[test]
    fn a_tail_starting_inside_a_credential_never_exposes_the_suffix() {
        let input = b"-accessToken synthetic-suffix -ok";
        let ranges = credential_ranges(input);
        assert_eq!(redact_window(input, 24, &ranges), b"[REDACTED] -ok");
    }
}
