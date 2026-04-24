#!/usr/bin/env node

import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { syncReleaseVersions } from "./release_tools.mjs";

function readVersionArg(argv) {
  const [, , ...args] = argv;
  const versionFromFlagIndex = args.findIndex((arg) => arg === "--version" || arg === "-v");
  if (versionFromFlagIndex >= 0 && args[versionFromFlagIndex + 1]) {
    return args[versionFromFlagIndex + 1];
  }
  return args.find((arg) => !arg.startsWith("-")) || "";
}

function runCommand(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      ...options,
    });

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} exited with code ${code}`));
    });
  });
}

const version = readVersionArg(process.argv);

if (!version) {
  console.error("Usage: npm run release:mac -- <version>");
  process.exit(1);
}

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const result = await syncReleaseVersions({ rootDir, version });
const zipPath = path.join(
  rootDir,
  "src-tauri",
  "target",
  "release",
  "bundle",
  "macos",
  `MAIN-${result.version}-macOS-unsigned-share.zip`,
);

console.log(`Updated app version to ${result.version}`);
console.log(`- macOS bundleVersion: ${result.macBundleVersion}`);
console.log(`- Windows wix version: ${result.windowsWixVersion}`);
console.log("");

await runCommand(npmCommand, ["run", "build:mac:share"], { cwd: rootDir });
await fs.access(zipPath);

console.log("");
console.log(`Ready to share: ${zipPath}`);
