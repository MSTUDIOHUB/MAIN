import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

const inputIcon = path.join(rootDir, "public", "LogoM_app.svg");
const outputDir = path.join(rootDir, "src-tauri", "icons");

const tauriCliPath = path.join(rootDir, "node_modules", "@tauri-apps/cli", "tauri.js");

const targetFiles = [
  path.join(outputDir, "icon.icns"),
  path.join(outputDir, "icon.ico"),
  path.join(outputDir, "32x32.png"),
  path.join(outputDir, "128x128.png"),
  path.join(outputDir, "128x128@2x.png"),
];

const force = process.argv.includes("--force");

function shouldGenerate() {
  if (force) {
    console.log("Forcing regeneration of icons (--force option passed).");
    return true;
  }

  if (!fs.existsSync(inputIcon)) {
    console.error(`Error: Source icon not found at ${inputIcon}`);
    return true;
  }

  const inputStat = fs.statSync(inputIcon);
  const inputMtime = inputStat.mtimeMs;

  for (const targetFile of targetFiles) {
    if (!fs.existsSync(targetFile)) {
      console.log(`Target file ${path.basename(targetFile)} does not exist. Generating icons...`);
      return true;
    }

    const targetStat = fs.statSync(targetFile);
    if (inputMtime > targetStat.mtimeMs) {
      console.log(`Source icon is newer than ${path.basename(targetFile)}. Re-generating icons...`);
      return true;
    }
  }

  return false;
}

if (!shouldGenerate()) {
  console.log("App icons are already up to date. Skipping icon generation.");
  process.exit(0);
}

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

