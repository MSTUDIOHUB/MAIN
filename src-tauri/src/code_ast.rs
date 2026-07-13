use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use tree_sitter::{Language, Node, Parser};
use walkdir::WalkDir;

const MAX_AST_FILE_BYTES: u64 = 2 * 1024 * 1024;
const MAX_REFERENCE_FILE_BYTES: u64 = 768 * 1024;
const MAX_REFERENCE_FILES: usize = 500;
const DEFAULT_RESULT_LIMIT: usize = 80;
const MAX_RESULT_LIMIT: usize = 200;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AstSymbol {
    pub name: String,
    pub kind: String,
    pub syntax_kind: String,
    pub start_line: usize,
    pub start_column: usize,
    pub end_line: usize,
    pub signature: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AstQueryResult {
    pub path: String,
    pub language: String,
    pub root_kind: String,
    pub has_errors: bool,
    pub error_count: usize,
    pub symbols: Vec<AstSymbol>,
    pub truncated: bool,
    pub note: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SymbolOccurrence {
    pub path: String,
    pub language: String,
    pub role: String,
    pub syntax_kind: String,
    pub line: usize,
    pub column: usize,
    pub context: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SymbolReferencesResult {
    pub symbol: String,
    pub scope: String,
    pub scanned_files: usize,
    pub skipped_files: usize,
    pub parse_failures: usize,
    pub occurrences: Vec<SymbolOccurrence>,
    pub truncated: bool,
    pub note: String,
}

fn language_for_path(path: &Path) -> Option<(&'static str, Language)> {
    let extension = path.extension()?.to_str()?.to_ascii_lowercase();
    match extension.as_str() {
        "ts" => Some((
            "typescript",
            tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into(),
        )),
        "tsx" => Some(("tsx", tree_sitter_typescript::LANGUAGE_TSX.into())),
        "js" | "jsx" | "mjs" | "cjs" => {
            Some(("javascript", tree_sitter_javascript::LANGUAGE.into()))
        }
        "rs" => Some(("rust", tree_sitter_rust::LANGUAGE.into())),
        "py" => Some(("python", tree_sitter_python::LANGUAGE.into())),
        "cs" => Some(("csharp", tree_sitter_c_sharp::LANGUAGE.into())),
        "go" => Some(("go", tree_sitter_go::LANGUAGE.into())),
        _ => None,
    }
}

fn relative_path(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

fn compact_text(value: &str, max_chars: usize) -> String {
    let normalized = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if normalized.chars().count() <= max_chars {
        return normalized;
    }
    let prefix = normalized.chars().take(max_chars).collect::<String>();
    format!("{}...", prefix.trim_end())
}

fn node_text<'a>(node: Node<'a>, source: &'a [u8]) -> &'a str {
    node.utf8_text(source).unwrap_or_default()
}

fn is_declaration_kind(kind: &str) -> bool {
    matches!(
        kind,
        "function_declaration"
            | "function_definition"
            | "method_definition"
            | "method_declaration"
            | "constructor_declaration"
            | "class_declaration"
            | "class_definition"
            | "interface_declaration"
            | "type_alias_declaration"
            | "enum_declaration"
            | "struct_item"
            | "enum_item"
            | "trait_item"
            | "function_item"
            | "mod_item"
            | "const_item"
            | "static_item"
            | "type_item"
            | "impl_item"
            | "struct_declaration"
            | "record_declaration"
            | "property_declaration"
            | "field_declaration"
            | "namespace_declaration"
            | "type_declaration"
            | "type_spec"
            | "variable_declarator"
    )
}

fn normalized_symbol_kind(kind: &str) -> &'static str {
    if kind.contains("function") || kind.contains("method") || kind == "constructor_declaration" {
        "function"
    } else if kind.contains("class") || kind == "record_declaration" {
        "class"
    } else if kind.contains("interface") || kind == "trait_item" {
        "interface"
    } else if kind.contains("struct") {
        "struct"
    } else if kind.contains("enum") {
        "enum"
    } else if kind.contains("namespace") || kind == "mod_item" {
        "module"
    } else if kind.contains("property") || kind.contains("field") {
        "property"
    } else if kind.contains("type") {
        "type"
    } else if kind.contains("const") || kind.contains("static") || kind == "variable_declarator" {
        "variable"
    } else if kind == "impl_item" {
        "implementation"
    } else {
        "symbol"
    }
}

fn find_named_descendant<'a>(node: Node<'a>, field: &str, max_depth: usize) -> Option<Node<'a>> {
    if let Some(found) = node.child_by_field_name(field) {
        return Some(found);
    }
    if max_depth == 0 {
        return None;
    }
    let mut cursor = node.walk();
    for child in node.named_children(&mut cursor) {
        if let Some(found) = find_named_descendant(child, field, max_depth - 1) {
            return Some(found);
        }
    }
    None
}

fn symbol_name_node<'a>(node: Node<'a>) -> Option<Node<'a>> {
    node.child_by_field_name("name")
        .or_else(|| node.child_by_field_name("type"))
        .or_else(|| find_named_descendant(node, "name", 2))
}

fn signature_for_node(node: Node<'_>, source: &[u8]) -> String {
    let end = node
        .child_by_field_name("body")
        .map(|body| body.start_byte())
        .unwrap_or_else(|| node.end_byte());
    let start = node.start_byte().min(source.len());
    let end = end.min(source.len()).max(start);
    let mut signature = String::from_utf8_lossy(&source[start..end]).to_string();
    if node.kind() == "variable_declarator" {
        signature = signature
            .split('=')
            .next()
            .unwrap_or(&signature)
            .trim()
            .to_string();
    }
    compact_text(&signature, 360)
}

fn parse_source(path: &Path, source: &[u8]) -> Result<(&'static str, tree_sitter::Tree), String> {
    let (language_name, language) = language_for_path(path).ok_or_else(|| {
        format!(
            "AST_UNSUPPORTED_LANGUAGE: {}. Supported extensions: ts, tsx, js, jsx, mjs, cjs, rs, py, cs, go.",
            path.display()
        )
    })?;
    let mut parser = Parser::new();
    parser
        .set_language(&language)
        .map_err(|error| format!("AST_LANGUAGE_INIT_FAILED: {error}"))?;
    let tree = parser
        .parse(source, None)
        .ok_or_else(|| "AST_PARSE_FAILED: parser returned no syntax tree.".to_string())?;
    Ok((language_name, tree))
}

fn count_errors(root: Node<'_>) -> usize {
    let mut count = 0;
    let mut stack = vec![root];
    while let Some(node) = stack.pop() {
        if node.is_error() || node.is_missing() {
            count += 1;
        }
        let mut cursor = node.walk();
        stack.extend(node.children(&mut cursor));
    }
    count
}

pub fn query_file(
    workspace: &Path,
    path: &Path,
    query: Option<&str>,
    kinds: Option<&str>,
    max_results: Option<usize>,
) -> Result<AstQueryResult, String> {
    let metadata =
        fs::metadata(path).map_err(|error| format!("AST_FILE_METADATA_FAILED: {error}"))?;
    if metadata.len() > MAX_AST_FILE_BYTES {
        return Err(format!(
            "AST_FILE_TOO_LARGE: {} bytes exceeds the {} byte parser limit.",
            metadata.len(),
            MAX_AST_FILE_BYTES
        ));
    }
    let source = fs::read(path).map_err(|error| format!("AST_FILE_READ_FAILED: {error}"))?;
    let (language, tree) = parse_source(path, &source)?;
    let root = tree.root_node();
    let query = query.unwrap_or_default().trim().to_ascii_lowercase();
    let kind_filter = kinds
        .unwrap_or_default()
        .split(',')
        .map(|kind| kind.trim().to_ascii_lowercase())
        .filter(|kind| !kind.is_empty())
        .collect::<Vec<_>>();
    let limit = max_results
        .unwrap_or(DEFAULT_RESULT_LIMIT)
        .clamp(1, MAX_RESULT_LIMIT);
    let mut symbols = Vec::new();
    let mut matched_count = 0;
    let mut stack = vec![root];
    while let Some(node) = stack.pop() {
        if node.is_named() && is_declaration_kind(node.kind()) {
            if let Some(name_node) = symbol_name_node(node) {
                let name = compact_text(node_text(name_node, &source), 160);
                let kind = normalized_symbol_kind(node.kind()).to_string();
                let signature = signature_for_node(node, &source);
                let matches_query = query.is_empty()
                    || name.to_ascii_lowercase().contains(&query)
                    || signature.to_ascii_lowercase().contains(&query)
                    || node.kind().to_ascii_lowercase().contains(&query);
                let matches_kind = kind_filter.is_empty()
                    || kind_filter
                        .iter()
                        .any(|expected| expected == &kind || expected == node.kind());
                if !name.is_empty() && matches_query && matches_kind {
                    matched_count += 1;
                    if symbols.len() < limit {
                        let start = node.start_position();
                        symbols.push(AstSymbol {
                            name,
                            kind,
                            syntax_kind: node.kind().to_string(),
                            start_line: start.row + 1,
                            start_column: start.column + 1,
                            end_line: node.end_position().row + 1,
                            signature,
                        });
                    }
                }
            }
        }
        let mut cursor = node.walk();
        stack.extend(node.named_children(&mut cursor));
    }
    symbols.sort_by_key(|symbol| (symbol.start_line, symbol.start_column));
    let error_count = count_errors(root);
    Ok(AstQueryResult {
        path: relative_path(workspace, path),
        language: language.to_string(),
        root_kind: root.kind().to_string(),
        has_errors: root.has_error(),
        error_count,
        symbols,
        truncated: matched_count > limit,
        note: "Tree-sitter syntax tree query. Results are parser-backed but do not include compiler type resolution."
            .to_string(),
    })
}

fn should_visit(path: &Path) -> bool {
    let normalized = path.to_string_lossy().replace('\\', "/");
    ![
        "/.git/",
        "/node_modules/",
        "/dist/",
        "/target/",
        "/.MAIN/traces/",
        "/test-results/",
        "/playwright-report/",
    ]
    .iter()
    .any(|part| normalized.contains(part))
}

fn collect_reference_files(scope: &Path) -> Vec<PathBuf> {
    if scope.is_file() {
        return language_for_path(scope)
            .map(|_| vec![scope.to_path_buf()])
            .unwrap_or_default();
    }
    WalkDir::new(scope)
        .into_iter()
        .filter_entry(|entry| should_visit(entry.path()))
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_file() && language_for_path(entry.path()).is_some())
        .map(|entry| entry.into_path())
        .take(MAX_REFERENCE_FILES)
        .collect()
}

fn is_identifier_kind(kind: &str) -> bool {
    kind == "identifier"
        || kind == "type_identifier"
        || kind == "field_identifier"
        || kind == "property_identifier"
        || kind == "namespace_identifier"
}

fn occurrence_role(node: Node<'_>) -> &'static str {
    let Some(parent) = node.parent() else {
        return "reference";
    };
    if is_declaration_kind(parent.kind()) {
        if let Some(name) = symbol_name_node(parent) {
            if name.start_byte() == node.start_byte() && name.end_byte() == node.end_byte() {
                return "definition";
            }
        }
    }
    if parent.kind().contains("import") || parent.kind().contains("use_") {
        return "import";
    }
    if parent.kind().contains("call") || parent.kind() == "macro_invocation" {
        return "call";
    }
    "reference"
}

fn source_line(source: &[u8], row: usize) -> String {
    let text = String::from_utf8_lossy(source);
    compact_text(text.lines().nth(row).unwrap_or_default(), 260)
}

pub fn find_references(
    workspace: &Path,
    scope: &Path,
    symbol: &str,
    max_results: Option<usize>,
) -> Result<SymbolReferencesResult, String> {
    let symbol = symbol.trim();
    if symbol.is_empty() {
        return Err("AST_SYMBOL_REQUIRED: symbol cannot be empty.".to_string());
    }
    let limit = max_results
        .unwrap_or(DEFAULT_RESULT_LIMIT)
        .clamp(1, MAX_RESULT_LIMIT);
    let files = collect_reference_files(scope);
    let mut occurrences = Vec::new();
    let mut total_matches = 0;
    let mut scanned_files = 0;
    let mut skipped_files = 0;
    let mut parse_failures = 0;

    for path in files {
        let metadata = match fs::metadata(&path) {
            Ok(metadata) if metadata.len() <= MAX_REFERENCE_FILE_BYTES => metadata,
            _ => {
                skipped_files += 1;
                continue;
            }
        };
        if metadata.len() == 0 {
            continue;
        }
        let source = match fs::read(&path) {
            Ok(source) => source,
            Err(_) => {
                skipped_files += 1;
                continue;
            }
        };
        let (language, tree) = match parse_source(&path, &source) {
            Ok(parsed) => parsed,
            Err(_) => {
                parse_failures += 1;
                continue;
            }
        };
        scanned_files += 1;
        let mut stack = vec![tree.root_node()];
        while let Some(node) = stack.pop() {
            if is_identifier_kind(node.kind()) && node_text(node, &source) == symbol {
                total_matches += 1;
                if occurrences.len() < limit {
                    let position = node.start_position();
                    occurrences.push(SymbolOccurrence {
                        path: relative_path(workspace, &path),
                        language: language.to_string(),
                        role: occurrence_role(node).to_string(),
                        syntax_kind: node.kind().to_string(),
                        line: position.row + 1,
                        column: position.column + 1,
                        context: source_line(&source, position.row),
                    });
                }
            }
            let mut cursor = node.walk();
            stack.extend(node.named_children(&mut cursor));
        }
    }
    occurrences.sort_by(|left, right| {
        left.path
            .cmp(&right.path)
            .then(left.line.cmp(&right.line))
            .then(left.column.cmp(&right.column))
    });
    Ok(SymbolReferencesResult {
        symbol: symbol.to_string(),
        scope: relative_path(workspace, scope),
        scanned_files,
        skipped_files,
        parse_failures,
        occurrences,
        truncated: total_matches > limit,
        note: "Tree-sitter syntax-level references. Same-name identifiers may refer to different semantic symbols; verify compiler/type information when ambiguity matters."
            .to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::{find_references, query_file};
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn typescript_ast_query_returns_real_declarations() {
        let root = tempdir().unwrap();
        let path = root.path().join("sample.ts");
        fs::write(
            &path,
            "export class Greeter { greet(name: string) { return name; } }\nexport function buildGreeter() { return new Greeter(); }\n",
        )
        .unwrap();
        let result = query_file(root.path(), &path, None, None, Some(20)).unwrap();
        assert_eq!(result.language, "typescript");
        assert!(result.symbols.iter().any(|symbol| symbol.name == "Greeter"));
        assert!(result
            .symbols
            .iter()
            .any(|symbol| symbol.name == "buildGreeter"));
    }

    #[test]
    fn syntax_reference_search_ignores_comments_and_strings() {
        let root = tempdir().unwrap();
        let path = root.path().join("sample.ts");
        fs::write(
            &path,
            "function target() { return 1; }\nconst value = target();\n// target\nconst text = 'target';\n",
        )
        .unwrap();
        let result = find_references(root.path(), root.path(), "target", Some(20)).unwrap();
        assert_eq!(result.occurrences.len(), 2);
        assert!(result
            .occurrences
            .iter()
            .any(|item| item.role == "definition"));
        assert!(result.occurrences.iter().any(|item| item.role == "call"));
    }
}
