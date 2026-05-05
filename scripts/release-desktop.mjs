#!/usr/bin/env node

import { spawnSync } from "node:child_process";

import { parseAppVersion } from "./release_tools.mjs";

const PRIVATE_REPO = "MSTUDIOHUB/MAIN";
const RELEASE_REPO = "MSTUDIOHUB/MAIN-Releases";
const WORKFLOW_FILE = "build-desktop.yml";
const WORKFLOW_REF = "main";
const REQUIRED_SECRET_NAMES = [
  "PUBLIC_RELEASES_TOKEN",
  "TAURI_SIGNING_PRIVATE_KEY",
  "TAURI_SIGNING_PRIVATE_KEY_PASSWORD",
];

function printHelp() {
  console.log(`Usage:
  npm run release:desktop -- <version> [options]
  node scripts/release-desktop.mjs <version> [options]

Examples:
  npm run release:desktop -- 1.4.2
  npm run release:desktop -- 1.4.2 --prerelease
  npm run release:desktop -- 1.4.2 --draft
  npm run release:desktop -- 1.4.2 --no-watch
  npm run release:desktop -- 1.4.2 --dry-run

Options:
  --draft       Create the public GitHub Release as a draft.
  --prerelease  Mark the public GitHub Release as a pre-release.
  --no-watch    Trigger the workflow but do not wait for completion.
  --dry-run     Print the workflow command without triggering it.
  -h, --help    Show this help message.

Notes:
  - The version is required and must not start with "v".
  - Default behavior publishes directly to ${RELEASE_REPO}.
  - The workflow requires PUBLIC_RELEASES_TOKEN and Tauri updater signing secrets in ${PRIVATE_REPO}.
`);
}

function fail(message, details = "") {
  console.error(`Error: ${message}`);
  if (details) {
    console.error(details.trim());
  }
  process.exit(1);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: options.stdio || "pipe",
    ...options,
  });

  if (result.error) {
    const commandText = [command, ...args].join(" ");
    fail(`Failed to run: ${commandText}`, result.error.message);
  }

  return {
    ...result,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
  };
}

function requireSuccess(command, args, message, options = {}) {
  const result = run(command, args, options);
  if (result.status !== 0) {
    fail(message, result.stderr || result.stdout);
  }
  return result;
}

function parseArgs(argv) {
  const options = {
    version: "",
    draft: false,
    prerelease: false,
    watch: true,
    dryRun: false,
    help: false,
  };

  for (const arg of argv) {
    if (arg === "-h" || arg === "--help") {
      options.help = true;
      continue;
    }

    if (arg === "--draft") {
      options.draft = true;
      continue;
    }

    if (arg === "--prerelease") {
      options.prerelease = true;
      continue;
    }

    if (arg === "--no-watch") {
      options.watch = false;
      continue;
    }

    if (arg === "--dry-run") {
      options.dryRun = true;
      options.watch = false;
      continue;
    }

    if (arg.startsWith("-")) {
      fail(`Unknown option: ${arg}`);
    }

    if (options.version) {
      fail(`Unexpected extra argument: ${arg}`);
    }

    options.version = arg;
  }

  return options;
}

function validateVersion(version) {
  if (!version) {
    fail("Missing version. Use: npm run release:desktop -- 1.4.2");
  }

  if (version.startsWith("v")) {
    fail(`Use "${version.slice(1)}" instead of "${version}". The script adds the "v" tag prefix automatically.`);
  }

  try {
    parseAppVersion(version);
  } catch (error) {
    fail(error.message);
  }
}

function quoteForDisplay(value) {
  if (/^[A-Za-z0-9_./:=@-]+$/.test(value)) {
    return value;
  }
  return JSON.stringify(value);
}

function workflowArgs(options) {
  return [
    "workflow",
    "run",
    WORKFLOW_FILE,
    "--repo",
    PRIVATE_REPO,
    "--ref",
    WORKFLOW_REF,
    "-f",
    `version=${options.version}`,
    "-f",
    `release_repo=${RELEASE_REPO}`,
    "-f",
    `draft=${String(options.draft)}`,
    "-f",
    `prerelease=${String(options.prerelease)}`,
  ];
}

function printReleaseLinks(version) {
  console.log("");
  console.log("Release URLs:");
  console.log(`- Release: https://github.com/${RELEASE_REPO}/releases/tag/v${version}`);
  console.log(`- Latest:  https://github.com/${RELEASE_REPO}/releases/latest`);
}

function ensureGhReady() {
  requireSuccess("gh", ["--version"], "GitHub CLI gh is not installed or not available in PATH.");
  requireSuccess("gh", ["auth", "status", "--hostname", "github.com"], "GitHub CLI is not logged in. Run: gh auth login");
}

function ensureRepoAccess() {
  requireSuccess("gh", ["repo", "view", PRIVATE_REPO, "--json", "nameWithOwner"], `Cannot access private repo: ${PRIVATE_REPO}`);
  requireSuccess("gh", ["repo", "view", RELEASE_REPO, "--json", "nameWithOwner"], `Cannot access public release repo: ${RELEASE_REPO}`);
}

function ensureSecretExists() {
  const result = requireSuccess(
    "gh",
    ["secret", "list", "--repo", PRIVATE_REPO, "--app", "actions"],
    `Cannot list Actions secrets for ${PRIVATE_REPO}`,
  );

  const secretNames = new Set(
    result.stdout
      .split("\n")
      .map((line) => line.split(/\s+/)[0])
      .filter(Boolean),
  );

  const missingSecrets = REQUIRED_SECRET_NAMES.filter((secretName) => !secretNames.has(secretName));
  if (missingSecrets.length > 0) {
    fail(`Missing Actions secrets in ${PRIVATE_REPO}: ${missingSecrets.join(", ")}.`);
  }
}

function ensureCleanWorktree() {
  const result = requireSuccess("git", ["status", "--porcelain"], "Cannot read git status.");
  if (result.stdout.trim()) {
    fail("Working tree is not clean. Commit or stash changes before publishing.", result.stdout);
  }
}

function currentHeadSha() {
  return requireSuccess("git", ["rev-parse", "HEAD"], "Cannot read current git HEAD.").stdout.trim();
}

function remoteMainSha() {
  const result = requireSuccess("git", ["ls-remote", "origin", "refs/heads/main"], "Cannot read origin/main. Check network and remote access.");
  const [sha] = result.stdout.trim().split(/\s+/);
  if (!sha) {
    fail("origin/main was not found.");
  }
  return sha;
}

function ensureHeadIsOriginMain() {
  const head = currentHeadSha();
  const remote = remoteMainSha();

  if (head !== remote) {
    fail(
      "Current HEAD is not pushed to origin/main.",
      `Current HEAD: ${head}\norigin/main:  ${remote}\nPush first with: git push origin main`,
    );
  }

  return head;
}

function ensureReleaseDoesNotExist(version) {
  const tag = `v${version}`;
  const result = run("gh", ["release", "view", tag, "--repo", RELEASE_REPO, "--json", "tagName,url"]);

  if (result.status === 0) {
    fail(`Release ${tag} already exists in ${RELEASE_REPO}. Pick a new version.`);
  }

  const output = `${result.stderr}\n${result.stdout}`.toLowerCase();
  if (!output.includes("not found") && !output.includes("release not found") && !output.includes("http 404")) {
    fail(`Could not check whether release ${tag} exists.`, result.stderr || result.stdout);
  }
}

function preflight(options) {
  console.log("Running preflight checks...");
  ensureGhReady();
  ensureRepoAccess();
  ensureSecretExists();
  ensureReleaseDoesNotExist(options.version);
  ensureCleanWorktree();
  const headSha = ensureHeadIsOriginMain();
  console.log("Preflight checks passed.");
  return headSha;
}

function findRun(headSha, startedAtMs) {
  const result = requireSuccess(
    "gh",
    [
      "run",
      "list",
      "--repo",
      PRIVATE_REPO,
      "--workflow",
      WORKFLOW_FILE,
      "--branch",
      WORKFLOW_REF,
      "--event",
      "workflow_dispatch",
      "--limit",
      "20",
      "--json",
      "databaseId,url,headSha,createdAt,status,conclusion",
    ],
    "Cannot list workflow runs.",
  );

  const runs = JSON.parse(result.stdout);
  return runs.find((runItem) => {
    const createdAtMs = Date.parse(runItem.createdAt);
    return runItem.headSha === headSha && createdAtMs >= startedAtMs - 120000;
  });
}

async function waitForRunToAppear(headSha, startedAtMs) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const runItem = findRun(headSha, startedAtMs);
    if (runItem) {
      return runItem;
    }
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }

  fail("Workflow was triggered, but the run did not appear in time. Check GitHub Actions manually.");
}

async function triggerWorkflow(options, headSha) {
  const args = workflowArgs(options);
  const startedAtMs = Date.now();

  console.log("Triggering GitHub Actions workflow...");
  const result = requireSuccess("gh", args, "Failed to trigger release workflow.");
  if (result.stdout.trim()) {
    console.log(result.stdout.trim());
  }

  const runItem = await waitForRunToAppear(headSha, startedAtMs);
  console.log(`GitHub Actions run: ${runItem.url}`);

  if (!options.watch) {
    console.log("Not watching the run because --no-watch was provided.");
    printReleaseLinks(options.version);
    return;
  }

  console.log("Watching workflow run...");
  const watchResult = run("gh", ["run", "watch", String(runItem.databaseId), "--repo", PRIVATE_REPO, "--compact", "--exit-status"], {
    stdio: "inherit",
  });

  if (watchResult.status !== 0) {
    console.error("");
    console.error(`Workflow failed: ${runItem.url}`);
    process.exit(watchResult.status || 1);
  }

  console.log("");
  console.log("Workflow completed successfully.");
  printReleaseLinks(options.version);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    printHelp();
    return;
  }

  validateVersion(options.version);

  const args = workflowArgs(options);
  const commandText = ["gh", ...args].map(quoteForDisplay).join(" ");

  if (options.dryRun) {
    console.log("Dry run only. The workflow will not be triggered.");
    console.log("");
    console.log("Workflow command:");
    console.log(commandText);
    printReleaseLinks(options.version);
    return;
  }

  const headSha = preflight(options);
  await triggerWorkflow(options, headSha);
}

await main();
