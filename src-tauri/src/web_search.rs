use futures_util::StreamExt;
use regex::Regex;
use reqwest::{Client, Response};
use serde::Serialize;
use serde_json::Value;
use std::time::Duration;
use url::Url;

const DEFAULT_SEARCH_PROVIDER: &str = "duckduckgo";
const DEFAULT_MAX_RESULTS: usize = 5;
const MAX_SEARCH_RESULTS: usize = 8;
const DEFAULT_MAX_CHARS: usize = 12_000;
const MAX_FETCH_CHARS: usize = 30_000;
const MAX_RESPONSE_BYTES: usize = 2 * 1024 * 1024;
const USER_AGENT: &str = "MAIN/2.2 web-search (+https://github.com/)";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebSearchResultItem {
    pub title: String,
    pub url: String,
    pub snippet: String,
    pub source: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebSearchResponse {
    pub query: String,
    pub provider: String,
    pub results: Vec<WebSearchResultItem>,
    pub truncated: bool,
    pub source_url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fallback_provider: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fallback_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebFetchResponse {
    pub url: String,
    pub final_url: String,
    pub title: String,
    pub content: String,
    pub content_type: String,
    pub char_count: usize,
    pub truncated: bool,
    pub source: String,
}

struct FetchedBody {
    final_url: String,
    content_type: String,
    text: String,
    truncated: bool,
}

struct SearchAttempt {
    provider: String,
    source_url: String,
    html: String,
    truncated: bool,
}

#[tauri::command]
pub async fn web_search(
    query: String,
    provider: Option<String>,
    max_results: Option<usize>,
) -> Result<WebSearchResponse, String> {
    let query = query.trim().to_string();
    if query.is_empty() {
        return Err("web_search query is required".to_string());
    }

    let provider = normalize_provider(provider.as_deref());
    let max_results = clamp_search_limit(max_results);
    let client = build_client()?;
    let mut attempt = search_provider(&client, &provider, &query).await?;
    let mut results = parse_search_results(&attempt.provider, &attempt.html);
    let mut fallback_provider = None;
    let mut fallback_reason = None;

    if should_fallback_search(&attempt, &results) {
        let reason = build_search_fallback_reason(&attempt, &results);
        let mut last_reason = reason.clone();
        for fallback in fallback_providers(&provider) {
            match search_provider(&client, fallback, &query).await {
                Ok(next_attempt) => {
                    let next_results =
                        parse_search_results(&next_attempt.provider, &next_attempt.html);
                    if !should_fallback_search(&next_attempt, &next_results) {
                        attempt = next_attempt;
                        results = next_results;
                        fallback_provider = Some(fallback.to_string());
                        fallback_reason = Some(last_reason.clone());
                        break;
                    } else {
                        last_reason = format!(
                            "{last_reason}; fallback provider {fallback} also returned no usable results"
                        );
                    }
                }
                Err(error) => {
                    last_reason =
                        format!("{last_reason}; fallback provider {fallback} failed: {error}");
                }
            }
        }
        if fallback_provider.is_none() {
            fallback_reason = Some(last_reason);
        }
    }

    if results.is_empty()
        && is_search_challenge(&attempt.provider, &attempt.source_url, &attempt.html)
    {
        return Err(
            fallback_reason.unwrap_or_else(|| build_search_fallback_reason(&attempt, &results))
        );
    }
    if results.is_empty() && fallback_reason.is_some() {
        return Err(
            fallback_reason.unwrap_or_else(|| build_search_fallback_reason(&attempt, &results))
        );
    }

    let truncated = attempt.truncated || results.len() > max_results;
    results.truncate(max_results);

    Ok(WebSearchResponse {
        query,
        provider,
        results,
        truncated,
        source_url: attempt.source_url,
        fallback_provider,
        fallback_reason,
    })
}

#[tauri::command]
pub async fn web_fetch(url: String, max_chars: Option<usize>) -> Result<WebFetchResponse, String> {
    let requested_url = validate_http_url(&url)?.to_string();
    let max_chars = clamp_fetch_chars(max_chars);
    let client = build_client()?;

    if let Some(response) = fetch_github_url(&client, &requested_url, max_chars).await? {
        return Ok(response);
    }

    let (fetched, source) = match fetch_text(&client, &requested_url, MAX_RESPONSE_BYTES).await {
        Ok(body) => (body, "web"),
        Err(primary_error) => {
            let reader_url = jina_reader_url(&requested_url);
            match fetch_text(&client, &reader_url, MAX_RESPONSE_BYTES).await {
                Ok(body) => (body, "jina_reader"),
                Err(reader_error) => {
                    return Err(format!(
                        "Direct fetch failed: {primary_error}; Jina Reader fallback failed: {reader_error}"
                    ));
                }
            }
        }
    };
    let (title, content) = if looks_like_html(&fetched.content_type, &fetched.text) {
        (
            extract_html_title(&fetched.text),
            html_to_text(&fetched.text),
        )
    } else {
        (
            if source == "jina_reader" {
                extract_jina_title(&fetched.text)
            } else {
                "".to_string()
            },
            normalize_plain_text(&fetched.text),
        )
    };
    let (content, char_count, char_truncated) = truncate_chars(&content, max_chars);
    let truncated = fetched.truncated || char_truncated;

    Ok(WebFetchResponse {
        url: requested_url,
        final_url: fetched.final_url,
        title,
        content,
        content_type: fetched.content_type,
        char_count,
        truncated,
        source: source.to_string(),
    })
}

fn build_client() -> Result<Client, String> {
    Client::builder()
        .timeout(Duration::from_secs(15))
        .connect_timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::limited(8))
        .user_agent(USER_AGENT)
        .build()
        .map_err(|e| format!("Failed to create web client: {e}"))
}

fn normalize_provider(provider: Option<&str>) -> String {
    match provider
        .unwrap_or(DEFAULT_SEARCH_PROVIDER)
        .trim()
        .to_lowercase()
        .as_str()
    {
        "bing" => "bing".to_string(),
        "baidu" => "baidu".to_string(),
        _ => DEFAULT_SEARCH_PROVIDER.to_string(),
    }
}

fn clamp_search_limit(value: Option<usize>) -> usize {
    value
        .unwrap_or(DEFAULT_MAX_RESULTS)
        .clamp(1, MAX_SEARCH_RESULTS)
}

fn clamp_fetch_chars(value: Option<usize>) -> usize {
    value
        .unwrap_or(DEFAULT_MAX_CHARS)
        .clamp(1_000, MAX_FETCH_CHARS)
}

fn encode_query(query: &str) -> String {
    url::form_urlencoded::byte_serialize(query.as_bytes()).collect()
}

fn jina_reader_url(target_url: &str) -> String {
    format!("https://r.jina.ai/{target_url}")
}

fn validate_http_url(raw: &str) -> Result<Url, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("URL is required".to_string());
    }
    let parsed = Url::parse(trimmed).map_err(|e| format!("Invalid URL: {e}"))?;
    match parsed.scheme() {
        "http" | "https" => Ok(parsed),
        _ => Err("Only http and https URLs are allowed".to_string()),
    }
}

async fn fetch_search_page(client: &Client, url: &str) -> Result<(String, String, bool), String> {
    validate_http_url(url)?;
    let fetched = fetch_text(client, url, MAX_RESPONSE_BYTES).await?;
    Ok((fetched.final_url, fetched.text, fetched.truncated))
}

async fn search_provider(
    client: &Client,
    provider: &str,
    query: &str,
) -> Result<SearchAttempt, String> {
    let url = search_url(provider, query);
    let (source_url, html, truncated) = fetch_search_page(client, &url).await?;
    Ok(SearchAttempt {
        provider: provider.to_string(),
        source_url,
        html,
        truncated,
    })
}

fn search_url(provider: &str, query: &str) -> String {
    match provider {
        "bing" => format!("https://www.bing.com/search?q={}", encode_query(query)),
        "baidu" => format!("https://www.baidu.com/s?wd={}", encode_query(query)),
        _ => format!("https://duckduckgo.com/html/?q={}", encode_query(query)),
    }
}

fn parse_search_results(provider: &str, html: &str) -> Vec<WebSearchResultItem> {
    match provider {
        "duckduckgo" => parse_duckduckgo_results(html),
        "bing" => parse_bing_results(html),
        "baidu" => parse_baidu_results(html),
        _ => Vec::new(),
    }
}

fn fallback_providers(provider: &str) -> Vec<&'static str> {
    match provider {
        "baidu" => vec!["duckduckgo", "bing"],
        "duckduckgo" => vec!["bing"],
        "bing" => vec!["duckduckgo"],
        _ => vec!["duckduckgo", "bing"],
    }
}

fn should_fallback_search(attempt: &SearchAttempt, results: &[WebSearchResultItem]) -> bool {
    is_search_challenge(&attempt.provider, &attempt.source_url, &attempt.html) || results.is_empty()
}

fn build_search_fallback_reason(
    attempt: &SearchAttempt,
    results: &[WebSearchResultItem],
) -> String {
    if is_search_challenge(&attempt.provider, &attempt.source_url, &attempt.html) {
        format!(
            "{} search returned an anti-bot verification page: {}",
            attempt.provider, attempt.source_url
        )
    } else if results.is_empty() {
        format!(
            "{} search returned no parseable results: {}",
            attempt.provider, attempt.source_url
        )
    } else {
        format!("{} search needed fallback", attempt.provider)
    }
}

fn is_search_challenge(provider: &str, source_url: &str, html: &str) -> bool {
    let source = source_url.to_ascii_lowercase();
    let body = html.to_ascii_lowercase();
    if provider == "baidu" && (source.contains("wappass.baidu.com") || source.contains("captcha")) {
        return true;
    }
    if provider == "baidu"
        && (html.contains("百度安全验证")
            || html.contains("网络不给力")
            || body.contains("wappass")
            || body.contains("captcha"))
    {
        return true;
    }
    if provider == "duckduckgo"
        && (body.contains("anomaly-modal")
            || body.contains("anomaly.js")
            || body.contains("challenge-form")
            || body.contains("bots use duckduckgo")
            || body.contains("confirm this search was made by a human"))
    {
        return true;
    }
    if body.contains("challenge-form")
        || body.contains("verify you are human")
        || body.contains("human verification")
        || body.contains("confirm this search was made by a human")
        || body.contains("unusual traffic")
    {
        return true;
    }
    body.contains("captcha") && (body.contains("verify") || body.contains("verification"))
}

async fn fetch_text(client: &Client, url: &str, max_bytes: usize) -> Result<FetchedBody, String> {
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("Network request failed: {e}"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("HTTP request failed with status {status}"));
    }
    let final_url = response.url().to_string();
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let (bytes, truncated) = read_limited_response(response, max_bytes).await?;
    let text = String::from_utf8_lossy(&bytes).to_string();
    Ok(FetchedBody {
        final_url,
        content_type,
        text,
        truncated,
    })
}

async fn read_limited_response(
    response: Response,
    max_bytes: usize,
) -> Result<(Vec<u8>, bool), String> {
    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("Failed to read response body: {e}"))?;
        if bytes.len() + chunk.len() > max_bytes {
            let remaining = max_bytes.saturating_sub(bytes.len());
            bytes.extend_from_slice(&chunk[..remaining]);
            return Ok((bytes, true));
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok((bytes, false))
}

fn looks_like_html(content_type: &str, body: &str) -> bool {
    content_type.to_ascii_lowercase().contains("html")
        || body.contains("<html")
        || body.contains("<!DOCTYPE")
}

fn extract_html_title(html: &str) -> String {
    let re = Regex::new(r"(?is)<title[^>]*>(.*?)</title>").unwrap();
    re.captures(html)
        .and_then(|caps| {
            caps.get(1)
                .map(|m| decode_html_entities(&strip_tags(m.as_str())))
        })
        .map(|s| normalize_whitespace(&s))
        .unwrap_or_default()
}

fn html_to_text(html: &str) -> String {
    let mut text = html.to_string();
    for pattern in [
        r"(?is)<script[^>]*>.*?</script>",
        r"(?is)<style[^>]*>.*?</style>",
        r"(?is)<noscript[^>]*>.*?</noscript>",
        r"(?is)<svg[^>]*>.*?</svg>",
        r"(?is)<!--.*?-->",
    ] {
        text = Regex::new(pattern)
            .unwrap()
            .replace_all(&text, " ")
            .to_string();
    }
    text = Regex::new(r"(?is)<(br|p|div|li|tr|h[1-6])\b[^>]*>")
        .unwrap()
        .replace_all(&text, "\n")
        .to_string();
    let text = strip_tags(&text);
    normalize_whitespace(&decode_html_entities(&text))
}

fn strip_tags(value: &str) -> String {
    Regex::new(r"(?is)<[^>]+>")
        .unwrap()
        .replace_all(value, " ")
        .to_string()
}

fn normalize_whitespace(value: &str) -> String {
    value
        .replace('\u{00a0}', " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn normalize_plain_text(value: &str) -> String {
    value
        .replace("\r\n", "\n")
        .replace('\r', "\n")
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

fn extract_jina_title(value: &str) -> String {
    value
        .lines()
        .find_map(|line| line.trim().strip_prefix("Title:").map(str::trim))
        .unwrap_or("")
        .to_string()
}

fn decode_html_entities(value: &str) -> String {
    let numeric = Regex::new(r"&#(x?[0-9A-Fa-f]+);").unwrap();
    let decoded = numeric.replace_all(value, |caps: &regex::Captures| {
        let raw = caps.get(1).map(|m| m.as_str()).unwrap_or("");
        let parsed = if let Some(hex) = raw.strip_prefix('x').or_else(|| raw.strip_prefix('X')) {
            u32::from_str_radix(hex, 16).ok()
        } else {
            raw.parse::<u32>().ok()
        };
        parsed
            .and_then(char::from_u32)
            .map(|ch| ch.to_string())
            .unwrap_or_else(|| caps.get(0).map(|m| m.as_str()).unwrap_or("").to_string())
    });
    decoded
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&apos;", "'")
        .replace("&nbsp;", " ")
}

fn truncate_chars(value: &str, max_chars: usize) -> (String, usize, bool) {
    let total = value.chars().count();
    if total <= max_chars {
        return (value.to_string(), total, false);
    }
    let truncated = value.chars().take(max_chars).collect::<String>();
    (truncated, total, true)
}

fn parse_duckduckgo_results(html: &str) -> Vec<WebSearchResultItem> {
    let link_re = Regex::new(
        r#"(?is)<a[^>]+class=["'][^"']*result__a[^"']*["'][^>]+href=["']([^"']+)["'][^>]*>(.*?)</a>"#,
    )
    .unwrap();
    let snippets = Regex::new(r#"(?is)<a[^>]+class=["'][^"']*result__snippet[^"']*["'][^>]*>(.*?)</a>|<div[^>]+class=["'][^"']*result__snippet[^"']*["'][^>]*>(.*?)</div>"#)
        .unwrap()
        .captures_iter(html)
        .map(|caps| {
            caps.get(1)
                .or_else(|| caps.get(2))
                .map(|m| cleanup_html_fragment(m.as_str()))
                .unwrap_or_default()
        })
        .collect::<Vec<_>>();
    link_re
        .captures_iter(html)
        .enumerate()
        .filter_map(|(index, caps)| {
            let title = cleanup_html_fragment(caps.get(2)?.as_str());
            let url = normalize_duckduckgo_url(caps.get(1)?.as_str());
            if title.is_empty() || url.is_empty() {
                return None;
            }
            Some(WebSearchResultItem {
                title,
                url,
                snippet: snippets.get(index).cloned().unwrap_or_default(),
                source: "DuckDuckGo".to_string(),
            })
        })
        .collect()
}

fn parse_bing_results(html: &str) -> Vec<WebSearchResultItem> {
    let block_re =
        Regex::new(r#"(?is)<li[^>]+class=["'][^"']*b_algo[^"']*["'][^>]*>(.*?)</li>"#).unwrap();
    let link_re = Regex::new(r#"(?is)<a[^>]+href=["']([^"']+)["'][^>]*>(.*?)</a>"#).unwrap();
    let snippet_re = Regex::new(r#"(?is)<p[^>]*>(.*?)</p>"#).unwrap();
    block_re
        .captures_iter(html)
        .filter_map(|caps| {
            let block = caps.get(1)?.as_str();
            let link = link_re.captures(block)?;
            let url = cleanup_url(link.get(1)?.as_str());
            let title = cleanup_html_fragment(link.get(2)?.as_str());
            if title.is_empty() || url.is_empty() {
                return None;
            }
            let snippet = snippet_re
                .captures(block)
                .and_then(|m| m.get(1).map(|v| cleanup_html_fragment(v.as_str())))
                .unwrap_or_default();
            Some(WebSearchResultItem {
                title,
                url,
                snippet,
                source: "Bing".to_string(),
            })
        })
        .collect()
}

fn parse_baidu_results(html: &str) -> Vec<WebSearchResultItem> {
    let block_re = Regex::new(
        r#"(?is)<div[^>]+class=["'][^"']*(?:result|c-container)[^"']*["'][^>]*>(.*?)</div>"#,
    )
    .unwrap();
    let link_re = Regex::new(r#"(?is)<a[^>]+href=["']([^"']+)["'][^>]*>(.*?)</a>"#).unwrap();
    let content_re = Regex::new(r#"(?is)<div[^>]+class=["'][^"']*(?:c-abstract|content-right|result-desc)[^"']*["'][^>]*>(.*?)</div>"#).unwrap();
    block_re
        .captures_iter(html)
        .filter_map(|caps| {
            let block = caps.get(1)?.as_str();
            let link = link_re.captures(block)?;
            let url = cleanup_url(link.get(1)?.as_str());
            let title = cleanup_html_fragment(link.get(2)?.as_str());
            if title.is_empty() || url.is_empty() {
                return None;
            }
            let snippet = content_re
                .captures(block)
                .and_then(|m| m.get(1).map(|v| cleanup_html_fragment(v.as_str())))
                .unwrap_or_default();
            Some(WebSearchResultItem {
                title,
                url,
                snippet,
                source: "Baidu".to_string(),
            })
        })
        .collect()
}

fn cleanup_html_fragment(fragment: &str) -> String {
    normalize_whitespace(&decode_html_entities(&strip_tags(fragment)))
}

fn cleanup_url(raw: &str) -> String {
    let trimmed = decode_html_entities(raw).trim().to_string();
    if trimmed.starts_with("//") {
        return format!("https:{trimmed}");
    }
    trimmed
}

fn normalize_duckduckgo_url(raw: &str) -> String {
    let cleaned = cleanup_url(raw);
    if let Ok(parsed) = Url::parse(&cleaned) {
        if parsed
            .host_str()
            .is_some_and(|host| host.contains("duckduckgo.com"))
        {
            for (key, value) in parsed.query_pairs() {
                if key == "uddg" && !value.is_empty() {
                    return value.to_string();
                }
            }
        }
    }
    cleaned
}

async fn fetch_github_url(
    client: &Client,
    requested_url: &str,
    max_chars: usize,
) -> Result<Option<WebFetchResponse>, String> {
    let parsed = validate_http_url(requested_url)?;
    let host = parsed.host_str().unwrap_or("").to_ascii_lowercase();
    if host == "raw.githubusercontent.com" {
        let fetched = fetch_text(client, requested_url, MAX_RESPONSE_BYTES).await?;
        let (content, char_count, char_truncated) = truncate_chars(&fetched.text, max_chars);
        return Ok(Some(WebFetchResponse {
            url: requested_url.to_string(),
            final_url: fetched.final_url,
            title: github_title_from_url(&parsed),
            content,
            content_type: fetched.content_type,
            char_count,
            truncated: fetched.truncated || char_truncated,
            source: "github_raw".to_string(),
        }));
    }
    if host != "github.com" {
        return Ok(None);
    }

    let segments = parsed
        .path_segments()
        .map(|segments| segments.collect::<Vec<_>>())
        .unwrap_or_default();
    if segments.len() < 2 {
        return Ok(None);
    }
    let owner = segments[0];
    let repo = segments[1];
    if owner.is_empty() || repo.is_empty() {
        return Ok(None);
    }

    if segments.len() >= 5 && segments[2] == "blob" {
        let reference = segments[3];
        let path = segments[4..].join("/");
        let raw_url = format!(
            "https://raw.githubusercontent.com/{}/{}/{}/{}",
            owner, repo, reference, path
        );
        let fetched = fetch_text(client, &raw_url, MAX_RESPONSE_BYTES).await?;
        let (content, char_count, char_truncated) = truncate_chars(&fetched.text, max_chars);
        return Ok(Some(WebFetchResponse {
            url: requested_url.to_string(),
            final_url: raw_url,
            title: path,
            content,
            content_type: fetched.content_type,
            char_count,
            truncated: fetched.truncated || char_truncated,
            source: "github_blob".to_string(),
        }));
    }

    if segments.len() >= 4 && segments[2] == "tree" {
        let reference = segments[3];
        let prefix = if segments.len() > 4 {
            Some(segments[4..].join("/"))
        } else {
            None
        };
        let response =
            fetch_github_tree(client, owner, repo, reference, prefix.as_deref(), max_chars).await?;
        return Ok(Some(WebFetchResponse {
            url: requested_url.to_string(),
            ..response
        }));
    }

    if segments.len() == 2 {
        let repo_info = fetch_github_repo_info(client, owner, repo).await?;
        let branch = repo_info
            .get("default_branch")
            .and_then(Value::as_str)
            .unwrap_or("main");
        let mut response = fetch_github_tree(client, owner, repo, branch, None, max_chars).await?;
        response.url = requested_url.to_string();
        if let Some(description) = repo_info.get("description").and_then(Value::as_str) {
            if !description.trim().is_empty() {
                response.content = format!(
                    "Repository: {owner}/{repo}\nDescription: {description}\n\n{}",
                    response.content
                );
            }
        }
        return Ok(Some(response));
    }

    Ok(None)
}

async fn fetch_github_repo_info(client: &Client, owner: &str, repo: &str) -> Result<Value, String> {
    let api_url = format!("https://api.github.com/repos/{owner}/{repo}");
    let fetched = fetch_text(client, &api_url, MAX_RESPONSE_BYTES).await?;
    serde_json::from_str(&fetched.text)
        .map_err(|e| format!("Failed to parse GitHub repository metadata: {e}"))
}

async fn fetch_github_tree(
    client: &Client,
    owner: &str,
    repo: &str,
    reference: &str,
    prefix: Option<&str>,
    max_chars: usize,
) -> Result<WebFetchResponse, String> {
    let api_url = format!(
        "https://api.github.com/repos/{owner}/{repo}/git/trees/{}?recursive=1",
        encode_query(reference)
    );
    let fetched = fetch_text(client, &api_url, MAX_RESPONSE_BYTES).await?;
    let json: Value = serde_json::from_str(&fetched.text)
        .map_err(|e| format!("Failed to parse GitHub tree response: {e}"))?;
    let tree = json
        .get("tree")
        .and_then(Value::as_array)
        .ok_or_else(|| "GitHub tree response did not include a file tree".to_string())?;
    let mut lines = Vec::new();
    for item in tree {
        let path = item.get("path").and_then(Value::as_str).unwrap_or("");
        if path.is_empty() {
            continue;
        }
        if let Some(prefix) = prefix {
            if !path.starts_with(prefix) {
                continue;
            }
        }
        let kind = item.get("type").and_then(Value::as_str).unwrap_or("file");
        let size = item.get("size").and_then(Value::as_u64);
        let line = match size {
            Some(size) if kind == "blob" => format!("file {path} ({size} bytes)"),
            _ => format!("{kind} {path}"),
        };
        lines.push(line);
        if lines.len() >= 500 {
            break;
        }
    }
    let header = format!("Repository tree for {owner}/{repo}@{reference}");
    let content = if lines.is_empty() {
        format!("{header}\nNo files matched.")
    } else {
        format!("{header}\n{}", lines.join("\n"))
    };
    let (content, char_count, char_truncated) = truncate_chars(&content, max_chars);
    Ok(WebFetchResponse {
        url: format!("https://github.com/{owner}/{repo}"),
        final_url: api_url,
        title: format!("{owner}/{repo}"),
        content,
        content_type: "application/json".to_string(),
        char_count,
        truncated: fetched.truncated || char_truncated || tree.len() > lines.len(),
        source: "github_tree".to_string(),
    })
}

fn github_title_from_url(url: &Url) -> String {
    url.path_segments()
        .and_then(|segments| segments.last().map(|s| s.to_string()))
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_only_http_urls() {
        assert!(validate_http_url("https://example.com/path").is_ok());
        assert!(validate_http_url("http://example.com/path").is_ok());
        assert!(validate_http_url("file:///tmp/a").is_err());
        assert!(validate_http_url("ftp://example.com/a").is_err());
    }

    #[test]
    fn extracts_readable_html_text() {
        let html = r#"
          <html><head><title>A &amp; B</title><style>.x{}</style></head>
          <body><h1>Hello&nbsp;world</h1><script>alert(1)</script><p>One<br>Two</p></body></html>
        "#;
        assert_eq!(extract_html_title(html), "A & B");
        let text = html_to_text(html);
        assert!(text.contains("Hello world"));
        assert!(text.contains("One Two"));
        assert!(!text.contains("alert"));
    }

    #[test]
    fn parses_duckduckgo_result_links() {
        let html = r#"
          <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa">Example &amp; Result</a>
          <a class="result__snippet">Short <b>summary</b></a>
        "#;
        let results = parse_duckduckgo_results(html);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].title, "Example & Result");
        assert_eq!(results[0].url, "https://example.com/a");
        assert_eq!(results[0].snippet, "Short summary");
    }

    #[test]
    fn detects_baidu_captcha_as_fallback_condition() {
        let attempt = SearchAttempt {
            provider: "baidu".to_string(),
            source_url: "https://wappass.baidu.com/static/captcha/tuxing_v2.html".to_string(),
            html: "百度安全验证 captcha".to_string(),
            truncated: false,
        };
        let results = Vec::new();

        assert!(is_search_challenge(
            &attempt.provider,
            &attempt.source_url,
            &attempt.html
        ));
        assert!(should_fallback_search(&attempt, &results));
        assert!(build_search_fallback_reason(&attempt, &results).contains("anti-bot"));
    }

    #[test]
    fn detects_duckduckgo_anomaly_as_fallback_condition() {
        let attempt = SearchAttempt {
            provider: "duckduckgo".to_string(),
            source_url: "https://html.duckduckgo.com/html/?q=test".to_string(),
            html: "Unfortunately, bots use DuckDuckGo too. confirm this search was made by a human"
                .to_string(),
            truncated: false,
        };
        let results = Vec::new();

        assert!(is_search_challenge(
            &attempt.provider,
            &attempt.source_url,
            &attempt.html
        ));
        assert!(should_fallback_search(&attempt, &results));
    }

    #[test]
    fn truncates_by_chars() {
        let (value, count, truncated) = truncate_chars("abcdef", 3);
        assert_eq!(value, "abc");
        assert_eq!(count, 6);
        assert!(truncated);
    }

    #[test]
    fn builds_jina_reader_url_and_extracts_title() {
        assert_eq!(
            jina_reader_url("https://example.com/a"),
            "https://r.jina.ai/https://example.com/a"
        );
        assert_eq!(
            extract_jina_title("Title: Example page\nURL Source: https://example.com\nBody"),
            "Example page"
        );
    }

    #[test]
    fn normalizes_search_provider() {
        assert_eq!(normalize_provider(Some("BING")), "bing");
        assert_eq!(normalize_provider(Some("reader")), "duckduckgo");
        assert_eq!(normalize_provider(Some("jina")), "duckduckgo");
        assert_eq!(normalize_provider(Some("google")), "duckduckgo");
    }

    #[test]
    fn baidu_falls_back_through_free_search_sources() {
        assert_eq!(fallback_providers("baidu"), vec!["duckduckgo", "bing"]);
    }
}
