fn main() {
    let cwd = std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."));
    let exit_code = tauri_app_lib::eval::run_cli(std::env::args().skip(1), cwd);
    std::process::exit(exit_code);
}
