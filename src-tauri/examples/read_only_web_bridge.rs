//! Test-only stdin/stdout bridge to the production Web commands.
//! Used by the browser real-model test, which has no native Tauri IPC host.
use serde_json::{json, Value};
use std::io::{self, Read};

fn main() {
    let mut input = String::new();
    io::stdin().read_to_string(&mut input).unwrap();
    let request: Value = serde_json::from_str(&input).unwrap();
    let args = &request["args"];
    let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    let result = runtime.block_on(async {
        match request["cmd"].as_str() {
            Some("web_search") => tauri_app_lib::web_search::web_search(
                args["query"].as_str().unwrap_or_default().into(),
                args["provider"].as_str().map(str::to_string),
                args["maxResults"].as_u64().map(|value| value as usize),
                args["allowFallback"].as_bool(),
            ).await.map(|value| serde_json::to_value(value).unwrap()),
            Some("web_fetch") => tauri_app_lib::web_search::web_fetch(
                args["url"].as_str().unwrap_or_default().into(),
                args["maxChars"].as_u64().map(|value| value as usize),
            ).await.map(|value| serde_json::to_value(value).unwrap()),
            _ => Err("Unsupported test bridge command".into()),
        }
    });
    println!("{}", match result { Ok(body) => json!({"ok": true, "body": body}), Err(error) => json!({"ok": false, "error": error}) });
}
