import { spawnSync } from "node:child_process";

// The browser delegates Web reads to production Rust; only native desktop IPC
// is replaced. The shared runner verifies a single already-loaded model.
const build = spawnSync("cargo", ["build", "--manifest-path", "src-tauri/Cargo.toml", "--example", "read_only_web_bridge"], { stdio: "inherit" });
if (build.error || build.status !== 0) process.exit(build.status || 1);
const result = spawnSync(process.execPath, ["scripts/run-real-omlx-plan-e2e.mjs"], {
  stdio: "inherit",
  env: { ...process.env, REAL_OMLX_TEST_GREP: "Chat web and ordinary" },
});
if (result.error) console.error(result.error.message);
process.exit(result.status ?? 1);
