#!/usr/bin/env node

import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

import { syncReleaseVersions } from "./release_tools.mjs";

export function readVersionArg(argv) {
  const [, , ...args] = argv;
  const versionFromFlagIndex = args.findIndex((arg) => arg === "--version" || arg === "-v");
  if (versionFromFlagIndex >= 0) {
    const value = args[versionFromFlagIndex + 1];
    if (!value || value.startsWith("-")) {
      throw new Error("Missing value for --version.");
    }
    return value;
  }
  return args.find((arg) => !arg.startsWith("-")) || "";
}

async function readCurrentPackageVersion(rootDir) {
  const packageJsonPath = path.join(rootDir, "package.json");
  const packageJson = JSON.parse(await fs.readFile(packageJsonPath, "utf8"));
  const version = String(packageJson.version || "").trim();
  if (!version) {
    throw new Error(`Missing package version in ${packageJsonPath}`);
  }
  return version;
}

export async function resolveReleaseMacVersion({ argv = process.argv, rootDir }) {
  const explicitVersion = readVersionArg(argv);
  if (explicitVersion) {
    return {
      version: explicitVersion,
      source: "argument",
    };
  }

  return {
    version: await readCurrentPackageVersion(rootDir),
    source: "package.json",
  };
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

export async function main(argv = process.argv) {
  const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  const { version, source } = await resolveReleaseMacVersion({ argv, rootDir });
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

  if (source === "package.json") {
    console.log(`Using current package version ${result.version}`);
  } else {
    console.log(`Updated app version to ${result.version}`);
  }
  console.log(`- macOS bundleVersion: ${result.macBundleVersion}`);
  console.log(`- Windows wix version: ${result.windowsWixVersion}`);
  console.log("");

  await runCommand(npmCommand, ["run", "build:mac:share"], { cwd: rootDir });
  await fs.access(zipPath);

  console.log("");
  console.log(`Ready to share: ${zipPath}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
