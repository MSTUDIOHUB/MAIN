import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

const inputIcon = path.join(rootDir, "public", "LogoM_app.svg");
const outputDir = path.join(rootDir, "src-tauri", "icons");

const tauriCliPath = path.join(rootDir, "node_modules", "@tauri-apps/cli", "tauri.js");

console.log(`Generating app icons from: ${inputIcon}`);
console.log(`Output directory: ${outputDir}`);
console.log(`Running Tauri CLI via: ${process.execPath} ${tauriCliPath}`);

const result = spawnSync(process.execPath, [tauriCliPath, "icon", inputIcon, "--output", outputDir], {
  cwd: rootDir,
  stdio: "inherit",
});

if (result.status !== 0) {
  console.error(`Failed to generate icons (exit code ${result.status}).`);
}
process.exit(result.status ?? 0);
