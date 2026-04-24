#!/usr/bin/env node

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

const version = readVersionArg(process.argv);

if (!version) {
  console.error("Usage: node scripts/release-bump.mjs <version>");
  process.exit(1);
}

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const result = await syncReleaseVersions({ rootDir, version });

console.log(`Updated app version to ${result.version}`);
console.log(`- macOS bundleVersion: ${result.macBundleVersion}`);
console.log(`- Windows wix version: ${result.windowsWixVersion}`);
