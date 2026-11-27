use super::{
    available_time, inspect_editor_check_permission, playmode_command_result, project_argument,
    run_cli_result,
};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::Read,
    path::Path,
    sync::atomic::AtomicBool,
    time::Duration,
};
use tree_sitter::{Node, Parser};

const MAX_SOURCE_BYTES: u64 = 256 * 1024;
const MAX_SUITES: usize = 16;
const MAX_CASES: usize = 256;

fn node_text<'a>(node: Node, source: &'a str) -> &'a str {
    source.get(node.byte_range()).unwrap_or_default()
}

fn has_test_attribute(method: Node, source: &str) -> bool {
    let mut cursor = method.walk();
    let found = method
        .named_children(&mut cursor)
        .filter(|node| node.kind() == "attribute_list")
        .any(|attributes| {
            let mut cursor = attributes.walk();
            let found = attributes
                .named_children(&mut cursor)
                .filter(|node| node.kind() == "attribute")
                .any(|attribute| {
                    let name = attribute
                        .child_by_field_name("name")
                        .map(|name| node_text(name, source))
                        .unwrap_or_default();
                    let name = name.rsplit(['.', ':']).next().unwrap_or_default();
                    matches!(
                        name.strip_suffix("Attribute").unwrap_or(name),
                        "Test" | "UnityTest" | "TestCase" | "TestCaseSource" | "Theory"
                    )
                });
            found
        });
    found
}

fn fixture_names(source: &str, parser: &mut Parser, names: &mut BTreeSet<String>) {
    fn visit(node: Node, source: &str, prefix: &str, in_type: bool, names: &mut BTreeSet<String>) {
        let mut scope = prefix.to_owned();
        let mut cursor = node.walk();
        for item in node.named_children(&mut cursor) {
            if item.kind() == "method_declaration" && in_type && has_test_attribute(item, source) {
                names.insert(scope.clone());
            }
            let namespace = matches!(
                item.kind(),
                "namespace_declaration" | "file_scoped_namespace_declaration"
            );
            if !namespace && item.kind() != "class_declaration" {
                continue;
            }
            let Some(name) = item
                .child_by_field_name("name")
                .map(|name| node_text(name, source))
            else {
                continue;
            };
            let separator = if scope.is_empty() {
                ""
            } else if in_type {
                "+"
            } else {
                "."
            };
            let qualified = format!("{scope}{separator}{name}");
            if item.kind() == "file_scoped_namespace_declaration" {
                scope = qualified;
            } else if let Some(body) = item.child_by_field_name("body") {
                visit(body, source, &qualified, !namespace, names);
            }
        }
    }
    if let Some(tree) = parser.parse(source, None) {
        visit(tree.root_node(), source, "", false, names);
    }
}

fn test_assembly(bytes: &[u8]) -> Option<String> {
    let value: Value =
        serde_json::from_slice(bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(bytes)).ok()?;
    let contains = |key: &str, name: &str| {
        value
            .get(key)
            .and_then(Value::as_array)
            .is_some_and(|values| values.iter().any(|value| value.as_str() == Some(name)))
    };
    let tests = contains("optionalUnityReferences", "TestAssemblies")
        || contains("references", "UnityEngine.TestRunner")
        || contains("precompiledReferences", "nunit.framework.dll");
    tests
        .then(|| value.get("name")?.as_str().map(str::to_owned))
        .flatten()
}

fn candidates(project: &Path, targets: &[String]) -> (BTreeSet<String>, BTreeSet<String>) {
    let mut fixtures = BTreeSet::new();
    let mut assemblies = BTreeSet::new();
    let mut parser = Parser::new();
    if parser
        .set_language(&tree_sitter_c_sharp::LANGUAGE.into())
        .is_err()
    {
        return (fixtures, assemblies);
    }
    for target in targets {
        let path = project.join(target);
        if !fs::symlink_metadata(&path)
            .is_ok_and(|meta| meta.is_file() && meta.len() <= MAX_SOURCE_BYTES)
            || !path
                .canonicalize()
                .is_ok_and(|actual| super::same_lexical_path(&actual, &path))
        {
            continue;
        }
        let mut bytes = Vec::new();
        if !fs::File::open(&path)
            .and_then(|file| file.take(MAX_SOURCE_BYTES + 1).read_to_end(&mut bytes))
            .is_ok()
            || bytes.len() as u64 > MAX_SOURCE_BYTES
        {
            continue;
        }
        if path
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("cs"))
        {
            if let Ok(source) = std::str::from_utf8(&bytes) {
                fixture_names(source, &mut parser, &mut fixtures);
            }
        } else if path
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("asmdef"))
        {
            if let Some(name) = test_assembly(&bytes) {
                assemblies.insert(name);
            }
        }
    }
    (fixtures, assemblies)
}

fn selected_suites(
    result: &Value,
    fixtures: &BTreeSet<String>,
    assemblies: &BTreeSet<String>,
) -> Option<Value> {
    fn field<'a>(value: &'a Value, name: &str) -> Option<&'a Value> {
        value
            .get(name)
            .or_else(|| value.get(name.to_ascii_lowercase()))
    }
    let tests = field(result, "Tests")?.as_array()?;
    if result
        .get("success")
        .or_else(|| result.get("Success"))
        .and_then(Value::as_bool)
        != Some(true)
        || field(result, "Mode")?.as_str()? != "PlayMode"
        || field(result, "Count")?.as_u64()? as usize != tests.len()
    {
        return None;
    }
    let mut all = Vec::new();
    let mut selected: BTreeMap<&str, BTreeSet<&str>> = BTreeMap::new();
    for test in tests {
        if field(test, "Mode")?.as_str()? != "PlayMode" || field(test, "Explicit")?.as_bool()? {
            continue;
        }
        let full_name = test
            .get("FullName")
            .or_else(|| test.get("fullName"))?
            .as_str()?;
        all.push(full_name);
        let Some((fixture, _)) = full_name.split('(').next()?.rsplit_once('.') else {
            continue;
        };
        let assembly = field(test, "Assembly").and_then(Value::as_str);
        if fixtures.contains(fixture) || assembly.is_some_and(|name| assemblies.contains(name)) {
            selected.entry(fixture).or_default().insert(full_name);
        }
    }
    if selected.len() > MAX_SUITES
        || selected.values().map(BTreeSet::len).sum::<usize>() > MAX_CASES
    {
        return None;
    }
    let mut suites = Vec::new();
    for (fixture, names) in selected {
        let matched = all
            .iter()
            .filter(|name| {
                name.to_ascii_lowercase()
                    .contains(&fixture.to_ascii_lowercase())
            })
            .count();
        if !super::valid_playmode_filter(fixture)
            || matched != names.len()
            || names.iter().any(|name| name.len() > 500)
        {
            return None;
        }
        suites.push(json!({"filter":fixture, "cases":names}));
    }
    Some(json!({"status":"discovered", "suites":suites}))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_real_csharp_fixtures_and_ignores_comment_lookalikes() {
        let mut parser = Parser::new();
        parser
            .set_language(&tree_sitter_c_sharp::LANGUAGE.into())
            .unwrap();
        let mut names = BTreeSet::new();
        fixture_names("namespace Field.Suite; class Driver { [NUnit.Framework.TestCase(1)] public void Case(int n) {} } class Helper { /* [Test] */ public void Run() {} }", &mut parser, &mut names);
        fixture_names("namespace Project { class Group { class Inner { [UnityTest] public IEnumerator Go() { yield break; } } } }", &mut parser, &mut names);
        assert_eq!(
            names,
            [
                "Field.Suite.Driver".to_string(),
                "Project.Group+Inner".to_string()
            ]
            .into_iter()
            .collect()
        );
    }

    #[test]
    fn keeps_exact_discovered_cases_and_rejects_partial_filter_collisions() {
        let item = |full_name: &str, assembly: &str, explicit| json!({"Mode":"PlayMode", "FullName":full_name,"Assembly":assembly,"Explicit":explicit});
        let mut report = json!({"Success":true,"Mode":"PlayMode","Count":3,"Tests":[
            item("Controls.Receiver.Works(1)", "Controls.TestAssembly", false),
            item("Controls.Receiver.Works(2)", "Controls.TestAssembly", true),
            item("Other.Receiver.Works", "Other.Tests", false),
        ]});
        let candidates = ["Controls.Receiver".to_string()].into_iter().collect();
        assert_eq!(
            selected_suites(&report, &candidates, &BTreeSet::new()).unwrap()["suites"],
            json!([{"filter":"Controls.Receiver","cases":["Controls.Receiver.Works(1)"]}])
        );
        report["Tests"][2] = item("Controls.ReceiverMock.Works", "Other.Tests", false);
        assert!(selected_suites(&report, &candidates, &BTreeSet::new()).is_none());
    }
}

pub(super) fn affected_playmode(
    project: &Path,
    pid: u64,
    targets: &[String],
    deadline_at: u64,
    canceled: &AtomicBool,
) -> Option<Value> {
    let (fixtures, assemblies) = candidates(project, targets);
    if fixtures.is_empty() && assemblies.is_empty() {
        return None;
    }
    let result = (|| {
        inspect_editor_check_permission(project, "unity command test list").ok()?;
        let root = project_argument(project);
        let pid_arg = pid.to_string();
        let args = [
            "command",
            "test",
            "list",
            "--project-path",
            &root,
            "--pid",
            &pid_arg,
            "--caller",
            "plugin",
            "--skill",
            "unity-cli",
            "--mode",
            "playmode",
        ];
        let (code, envelope) = run_cli_result(
            project,
            "Unity PlayMode discovery",
            &args,
            available_time(deadline_at, canceled, 100)
                .ok()?
                .min(Duration::from_secs(10)),
            Some(canceled),
        )
        .ok()?;
        if code != 0 {
            return None;
        }
        selected_suites(playmode_command_result(project, pid, &envelope, true)?, &fixtures, &assemblies)
    })();
    Some(result.unwrap_or_else(|| json!({"status":"unavailable", "suites":[]})))
}
