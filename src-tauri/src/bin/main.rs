fn main() {
    let cwd = std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."));
    let workspace = resolve_workspace_root(cwd);
    let exit_code = tauri_app_lib::eval::run_cli(std::env::args().skip(1), workspace);
    std::process::exit(exit_code);
}

fn resolve_workspace_root(cwd: std::path::PathBuf) -> std::path::PathBuf {
    for candidate in cwd.ancestors() {
        if candidate.join("package.json").exists()
            && candidate.join("src-tauri").join("Cargo.toml").exists()
        {
            return candidate.to_path_buf();
        }
    }
    cwd
}
