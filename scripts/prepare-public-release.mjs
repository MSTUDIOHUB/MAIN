#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { preparePublicRelease } from "./release_tools.mjs";

function parseArgs(argv) {
  const [, , ...args] = argv;
  const result = {
    repo: "",
    version: "",
    channel: "beta",
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if ((arg === "--repo" || arg === "-r") && args[index + 1]) {
      result.repo = args[index + 1];
      index += 1;
      continue;
    }
    if ((arg === "--version" || arg === "-v") && args[index + 1]) {
      result.version = args[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--channel" && args[index + 1]) {
      result.channel = args[index + 1];
      index += 1;
    }
  }

  return result;
}

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const options = parseArgs(process.argv);

if (!options.repo) {
  console.error("Usage: node scripts/prepare-public-release.mjs --repo <owner/repo> [--version <version>] [--channel beta]");
  process.exit(1);
}

const packageJson = JSON.parse(await fs.readFile(path.join(rootDir, "package.json"), "utf8"));
const version = options.version || packageJson.version;

const result = await preparePublicRelease({
  rootDir,
  version,
  publicRepo: options.repo,
  channel: options.channel,
});

console.log(`Prepared public release package for MAIN ${version}`);
console.log(`- Public repo: ${result.publicRepo}`);
console.log(`- Stage dir: ${result.stageDir}`);
console.log(`- Latest URL: ${result.latestUrl}`);
console.log(`- Assets:`);
result.assets.forEach((asset) => {
  console.log(`  - ${asset.fileName} (${asset.label})`);
});
console.log(`- Release notes: ${result.notesPath}`);
console.log(`- Metadata: ${result.metadataPath}`);
console.log(`- Website links: ${result.websiteLinksPath}`);
console.log("");
console.log(`Suggested upload command:`);
console.log(`gh release create v${version} release-output/public/v${version}/assets/* --repo ${result.publicRepo} --title \"MAIN ${version}\" --notes-file release-output/public/v${version}/release-notes.md`);
