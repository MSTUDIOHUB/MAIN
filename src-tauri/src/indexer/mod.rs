use regex::Regex;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use walkdir::WalkDir;

const MAX_INDEX_FILE_BYTES: u64 = 512 * 1024;
const EMBEDDING_DIMS: usize = 32;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryIndex {
    pub root: String,
    pub generated_at_ms: u64,
    pub symbols: Vec<SymbolEntry>,
    pub imports: Vec<ImportEdge>,
    pub calls: Vec<CallEdge>,
    pub dependencies: Vec<DependencyEdge>,
    pub embeddings: Vec<EmbeddingRecord>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SymbolEntry {
    pub name: String,
    pub kind: String,
    pub file: String,
    pub line: usize,
    pub signature: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportEdge {
    pub from: String,
    pub to: String,
    pub kind: String,
    pub line: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CallEdge {
    pub from: String,
    pub symbol: String,
    pub line: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DependencyEdge {
    pub manifest: String,
    pub package: String,
    pub source: String,
    pub requirement: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddingRecord {
    pub file: String,
    pub chunk_id: String,
    pub text_hash: String,
    pub vector: Vec<f32>,
}

#[derive(Debug, Clone)]
pub struct RepositoryIndexer {
    root: PathBuf,
}

impl RepositoryIndexer {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    pub async fn build(&self) -> Result<RepositoryIndex, String> {
        let root = self.root.clone();
        tokio::task::spawn_blocking(move || build_repository_index_sync(&root))
            .await
            .map_err(|error| format!("repository index task failed: {error}"))?
    }

    pub async fn build_and_store(&self) -> Result<(RepositoryIndex, PathBuf), String> {
        let index = self.build().await?;
        let path = self
            .root
            .join(".MAIN")
            .join("index")
            .join("repository_index.json");
        let repo_map_path = self.root.join(".MAIN").join("index").join("repo_map.db");
        if let Some(parent) = path.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|error| format!("创建 repository index 目录失败: {error}"))?;
        }
        let json = serde_json::to_vec_pretty(&index)
            .map_err(|error| format!("序列化 repository index 失败: {error}"))?;
        tokio::fs::write(&path, json)
            .await
            .map_err(|error| format!("写入 repository index 失败 {}: {error}", path.display()))?;
        let repo_map_json =
            serde_json::to_vec(&index).map_err(|error| format!("序列化 repo_map 失败: {error}"))?;
        tokio::fs::write(&repo_map_path, repo_map_json)
            .await
            .map_err(|error| format!("写入 repo_map 失败 {}: {error}", repo_map_path.display()))?;
        Ok((index, path))
    }
}

fn build_repository_index_sync(root: &Path) -> Result<RepositoryIndex, String> {
    let root = root
        .canonicalize()
        .map_err(|error| format!("解析 repository root 失败 {}: {error}", root.display()))?;
    let mut symbols = Vec::new();
    let mut imports = Vec::new();
    let mut calls = Vec::new();
    let mut dependencies = Vec::new();
    let mut embeddings = Vec::new();

    for entry in WalkDir::new(&root)
        .into_iter()
        .filter_entry(|entry| should_visit(entry.path()))
    {
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => continue,
        };
        let path = entry.path();
        if !entry.file_type().is_file() || !is_indexable_file(path) {
            continue;
        }
        if fs::metadata(path)
            .map(|metadata| metadata.len() > MAX_INDEX_FILE_BYTES)
            .unwrap_or(true)
        {
            continue;
        }

        let relative = relative_path(&root, path);
        let content = match fs::read_to_string(path) {
            Ok(content) => content,
            Err(_) => continue,
        };

        symbols.extend(extract_symbols(&relative, path, &content));
        imports.extend(extract_imports(&relative, path, &content));
        calls.extend(extract_calls(&relative, path, &content));
        dependencies.extend(extract_dependencies(&relative, path, &content));
        if should_embed_file(path) {
            embeddings.push(EmbeddingRecord {
                file: relative.clone(),
                chunk_id: "file:0".to_string(),
                text_hash: text_hash(&content),
                vector: local_embedding(&content),
            });
        }
    }

    Ok(RepositoryIndex {
        root: root.to_string_lossy().to_string(),
        generated_at_ms: now_millis(),
        symbols,
        imports,
        calls,
        dependencies,
        embeddings,
    })
}

fn should_visit(path: &Path) -> bool {
    let ignored = [
        ".git",
        "node_modules",
        "dist",
        "dist-ssr",
        "target",
        ".MAIN/traces",
        "test-results",
        "playwright-report",
    ];
    let normalized = path.to_string_lossy().replace('\\', "/");
    !ignored.iter().any(|part| normalized.contains(part))
}

fn is_indexable_file(path: &Path) -> bool {
    matches!(
        path.extension().and_then(|extension| extension.to_str()),
        Some("rs")
            | Some("ts")
            | Some("tsx")
            | Some("js")
            | Some("jsx")
            | Some("mjs")
            | Some("cjs")
            | Some("py")
            | Some("json")
            | Some("toml")
            | Some("md")
    )
}

fn should_embed_file(path: &Path) -> bool {
    !matches!(
        path.extension().and_then(|extension| extension.to_str()),
        Some("json") | Some("toml")
    )
}

fn relative_path(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

fn extract_symbols(relative: &str, path: &Path, content: &str) -> Vec<SymbolEntry> {
    let Some(extension) = path.extension().and_then(|extension| extension.to_str()) else {
        return Vec::new();
    };
    let patterns: &[(&str, &str)] = match extension {
        "rs" => &[
            (
                "function",
                r"^\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*)",
            ),
            (
                "struct",
                r"^\s*(?:pub\s+)?struct\s+([A-Za-z_][A-Za-z0-9_]*)",
            ),
            ("enum", r"^\s*(?:pub\s+)?enum\s+([A-Za-z_][A-Za-z0-9_]*)"),
            ("trait", r"^\s*(?:pub\s+)?trait\s+([A-Za-z_][A-Za-z0-9_]*)"),
            ("module", r"^\s*(?:pub\s+)?mod\s+([A-Za-z_][A-Za-z0-9_]*)"),
        ],
        "ts" | "tsx" | "js" | "jsx" | "mjs" | "cjs" => &[
            (
                "function",
                r"^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)",
            ),
            (
                "class",
                r"^\s*(?:export\s+)?class\s+([A-Za-z_$][A-Za-z0-9_$]*)",
            ),
            (
                "interface",
                r"^\s*(?:export\s+)?interface\s+([A-Za-z_$][A-Za-z0-9_$]*)",
            ),
            (
                "type",
                r"^\s*(?:export\s+)?type\s+([A-Za-z_$][A-Za-z0-9_$]*)",
            ),
            (
                "constant",
                r"^\s*(?:export\s+)?const\s+([A-Za-z_$][A-Za-z0-9_$]*)",
            ),
        ],
        "py" => &[
            ("function", r"^\s*def\s+([A-Za-z_][A-Za-z0-9_]*)"),
            ("class", r"^\s*class\s+([A-Za-z_][A-Za-z0-9_]*)"),
        ],
        _ => &[],
    };

    let mut entries = Vec::new();
    for (line_index, line) in content.lines().enumerate() {
        for (kind, pattern) in patterns {
            let regex = Regex::new(pattern).expect("static symbol regex must compile");
            if let Some(capture) = regex.captures(line) {
                let Some(name) = capture.get(1).map(|value| value.as_str()) else {
                    continue;
                };
                entries.push(SymbolEntry {
                    name: name.to_string(),
                    kind: (*kind).to_string(),
                    file: relative.to_string(),
                    line: line_index + 1,
                    signature: line.trim().to_string(),
                });
            }
        }
    }
    entries
}

fn extract_imports(relative: &str, path: &Path, content: &str) -> Vec<ImportEdge> {
    let Some(extension) = path.extension().and_then(|extension| extension.to_str()) else {
        return Vec::new();
    };
    let patterns: &[(&str, &str)] = match extension {
        "rs" => &[
            ("use", r"^\s*use\s+([^;]+);"),
            ("mod", r"^\s*(?:pub\s+)?mod\s+([A-Za-z_][A-Za-z0-9_]*);?"),
        ],
        "ts" | "tsx" | "js" | "jsx" | "mjs" | "cjs" => &[
            ("import", r#"^\s*import\s+.*?\s+from\s+["']([^"']+)["']"#),
            ("import", r#"^\s*import\s+["']([^"']+)["']"#),
            ("export", r#"^\s*export\s+.*?\s+from\s+["']([^"']+)["']"#),
            ("require", r#"require\(["']([^"']+)["']\)"#),
        ],
        "py" => &[
            ("import", r"^\s*import\s+([A-Za-z0-9_.,\s]+)"),
            ("from", r"^\s*from\s+([A-Za-z0-9_.]+)\s+import\s+"),
        ],
        _ => &[],
    };

    let mut edges = Vec::new();
    for (line_index, line) in content.lines().enumerate() {
        for (kind, pattern) in patterns {
            let regex = Regex::new(pattern).expect("static import regex must compile");
            if let Some(capture) = regex.captures(line) {
                let Some(target) = capture.get(1).map(|value| value.as_str().trim()) else {
                    continue;
                };
                if target.is_empty() {
                    continue;
                }
                edges.push(ImportEdge {
                    from: relative.to_string(),
                    to: target.to_string(),
                    kind: (*kind).to_string(),
                    line: line_index + 1,
                });
            }
        }
    }
    edges
}

fn extract_calls(relative: &str, path: &Path, content: &str) -> Vec<CallEdge> {
    let Some(extension) = path.extension().and_then(|extension| extension.to_str()) else {
        return Vec::new();
    };
    if !matches!(
        extension,
        "ts" | "tsx" | "js" | "jsx" | "mjs" | "cjs" | "rs" | "py"
    ) {
        return Vec::new();
    }

    let call_regex =
        Regex::new(r"\b([A-Za-z_$][A-Za-z0-9_$]*)\s*\(").expect("static call regex must compile");
    let skip: HashSet<&str> = [
        "if", "for", "while", "switch", "catch", "function", "return", "typeof", "sizeof", "match",
        "loop", "async", "await", "def", "class", "new",
    ]
    .into_iter()
    .collect();
    let mut edges = Vec::new();
    for (line_index, line) in content.lines().enumerate() {
        let trimmed = line.trim_start();
        if trimmed.starts_with("//") || trimmed.starts_with('#') || trimmed.starts_with('*') {
            continue;
        }
        for capture in call_regex.captures_iter(line) {
            let Some(symbol) = capture.get(1).map(|value| value.as_str()) else {
                continue;
            };
            if skip.contains(symbol) {
                continue;
            }
            edges.push(CallEdge {
                from: relative.to_string(),
                symbol: symbol.to_string(),
                line: line_index + 1,
            });
        }
    }
    edges
}

fn extract_dependencies(relative: &str, path: &Path, content: &str) -> Vec<DependencyEdge> {
    match path.file_name().and_then(|name| name.to_str()) {
        Some("package.json") => extract_package_json_dependencies(relative, content),
        Some("Cargo.toml") => extract_cargo_dependencies(relative, content),
        _ => Vec::new(),
    }
}

fn extract_package_json_dependencies(relative: &str, content: &str) -> Vec<DependencyEdge> {
    let parsed = match serde_json::from_str::<serde_json::Value>(content) {
        Ok(parsed) => parsed,
        Err(_) => return Vec::new(),
    };
    let mut edges = Vec::new();
    for source in ["dependencies", "devDependencies", "optionalDependencies"] {
        let Some(dependencies) = parsed.get(source).and_then(|value| value.as_object()) else {
            continue;
        };
        for (package, requirement) in dependencies {
            edges.push(DependencyEdge {
                manifest: relative.to_string(),
                package: package.to_string(),
                source: source.to_string(),
                requirement: requirement.as_str().unwrap_or("*").to_string(),
            });
        }
    }
    edges
}

fn extract_cargo_dependencies(relative: &str, content: &str) -> Vec<DependencyEdge> {
    let mut edges = Vec::new();
    let mut section = String::new();
    let dependency_sections: HashSet<&str> = [
        "dependencies",
        "dev-dependencies",
        "build-dependencies",
        "target.'cfg(target_os = \"macos\")'.dependencies",
    ]
    .into_iter()
    .collect();

    for raw_line in content.lines() {
        let line = raw_line.split('#').next().unwrap_or("").trim();
        if line.is_empty() {
            continue;
        }
        if line.starts_with('[') && line.ends_with(']') {
            section = line.trim_matches(['[', ']']).to_string();
            continue;
        }
        if !dependency_sections.contains(section.as_str()) {
            continue;
        }
        let Some((name, requirement)) = line.split_once('=') else {
            continue;
        };
        let package = name.trim();
        if package.is_empty() || package.starts_with('[') {
            continue;
        }
        edges.push(DependencyEdge {
            manifest: relative.to_string(),
            package: package.to_string(),
            source: section.clone(),
            requirement: requirement.trim().trim_matches('"').to_string(),
        });
    }
    edges
}

fn local_embedding(content: &str) -> Vec<f32> {
    let mut vector = vec![0.0_f32; EMBEDDING_DIMS];
    let mut token_count = 0.0_f32;
    for token in content
        .split(|ch: char| !ch.is_alphanumeric() && ch != '_')
        .filter(|token| token.len() > 1)
    {
        token_count += 1.0;
        let digest = Sha256::digest(token.to_ascii_lowercase().as_bytes());
        let dim = digest[0] as usize % EMBEDDING_DIMS;
        let sign = if digest[1] & 1 == 0 { 1.0 } else { -1.0 };
        vector[dim] += sign;
    }
    if token_count > 0.0 {
        let norm = vector.iter().map(|value| value * value).sum::<f32>().sqrt();
        if norm > 0.0 {
            for value in &mut vector {
                *value = (*value / norm * 10_000.0).round() / 10_000.0;
            }
        }
    }
    vector
}

fn text_hash(content: &str) -> String {
    let digest = Sha256::digest(content.as_bytes());
    digest
        .iter()
        .take(12)
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>()
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_else(|_| Duration::from_secs(0))
        .as_millis() as u64
}

#[cfg(test)]
mod tests {
    use super::RepositoryIndexer;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_repo(name: &str) -> std::path::PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("main-indexer-{name}-{unique}"));
        fs::create_dir_all(root.join("src")).unwrap();
        root
    }

    #[test]
    fn indexer_builds_symbols_imports_dependencies_and_embeddings() {
        let root = temp_repo("basic");
        fs::write(
            root.join("src").join("lib.rs"),
            "use crate::runtime;\npub struct AgentRuntime {}\npub fn run_agent() {}\n",
        )
        .unwrap();
        fs::write(
            root.join("package.json"),
            r#"{"dependencies":{"react":"^19.0.0"},"devDependencies":{"vite":"^7.0.0"}}"#,
        )
        .unwrap();

        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            let index = RepositoryIndexer::new(&root).build().await.unwrap();
            assert!(index
                .symbols
                .iter()
                .any(|symbol| symbol.name == "AgentRuntime"));
            assert!(index.imports.iter().any(|edge| edge.to == "crate::runtime"));
            assert!(index.calls.iter().any(|edge| edge.symbol == "run_agent"));
            assert!(index
                .dependencies
                .iter()
                .any(|dependency| dependency.package == "react"));
            assert!(index
                .embeddings
                .iter()
                .any(|embedding| embedding.file == "src/lib.rs" && embedding.vector.len() == 32));
        });
    }
}
