#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { APP_NAME, parseAppVersion, syncReleaseVersions, writeUpdaterManifest } from "./release_tools.mjs";

const DEFAULT_RELEASE_REPO = "MSTUDIOHUB/MAIN-Releases";
const DEFAULT_UPDATE_REPO = "MSTUDIOHUB/MAIN-UpdateFeed";
const WINDOWS_X64_TARGET = "x86_64-pc-windows-msvc";
const RELEASE_NOTES_FILE_NAME = "release_notes.md";

function printHelp() {
  console.log(`Usage:
  npm run release:local:mac -- <version> [options]
  npm run release:local:windows -- <version> [options]
  npm run release:mac:upload -- <version> [options]
  npm run release:windows:x64 -- <version> [options]
  node scripts/release-local.mjs mac <version> [options]
  node scripts/release-local.mjs windows <version> [options]

Options:
  --release-repo <owner/repo>  Public downloads repo. Default: ${DEFAULT_RELEASE_REPO}
  --update-repo <owner/repo>   Public updater feed repo. Default: ${DEFAULT_UPDATE_REPO}
  --draft                     Create or update GitHub Releases as drafts.
  --prerelease                Mark GitHub Releases as pre-releases.
  --no-upload                 Build and stage assets without uploading.
  --skip-build                Reuse existing target artifacts and only stage/sign/upload.
  --signing-key-file <path>   Read TAURI_SIGNING_PRIVATE_KEY from a local file outside the repo.
  --signing-password-file <path>
                              Read TAURI_SIGNING_PRIVATE_KEY_PASSWORD from a local file.
  --no-merge-existing-latest  Do not merge an existing updater latest.json before upload.
  --update-existing-notes     Update existing GitHub Release notes even for Windows uploads.
  --keep-existing-notes       Keep existing GitHub Release notes and only upload assets.
  -h, --help                  Show this help message.

Environment:
  TAURI_SIGNING_PRIVATE_KEY or TAURI_SIGNING_PRIVATE_KEY_PATH is required.
  TAURI_SIGNING_PRIVATE_KEY_PASSWORD is only required when the key has a password.

Windows:
  Windows release builds always target ${WINDOWS_X64_TARGET}, so running inside a Windows
  ARM VM still produces packages for Windows 11 x64 users.
  Install Visual Studio Build Tools with the C++ desktop and MSVC x64 toolchain in the VM.
`);
}

function fail(message, details = "") {
  console.error(`Error: ${message}`);
  if (details) {
    console.error(details.trim());
  }
  process.exit(1);
}

function parseArgs(argv) {
  const [platform, ...args] = argv;
  const options = {
    platform,
    version: "",
    releaseRepo: DEFAULT_RELEASE_REPO,
    updateRepo: DEFAULT_UPDATE_REPO,
    draft: false,
    prerelease: false,
    upload: true,
    skipBuild: false,
    mergeExistingLatest: true,
    signingKeyFile: "",
    signingPasswordFile: "",
    releaseNotesMode: "auto",
    help: false,
  };

  if (!platform || platform === "-h" || platform === "--help") {
    options.help = true;
    return options;
  }

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "-h" || arg === "--help") {
      options.help = true;
      continue;
    }

    if ((arg === "--release-repo" || arg === "--repo") && args[index + 1]) {
      options.releaseRepo = args[index + 1];
      index += 1;
      continue;
    }

    if (arg === "--update-repo" && args[index + 1]) {
      options.updateRepo = args[index + 1];
      index += 1;
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

    if (arg === "--no-upload") {
      options.upload = false;
      continue;
    }

    if (arg === "--skip-build") {
      options.skipBuild = true;
      continue;
    }

    if (arg === "--signing-key-file" && args[index + 1]) {
      options.signingKeyFile = args[index + 1];
      index += 1;
      continue;
    }

    if (arg === "--signing-password-file" && args[index + 1]) {
      options.signingPasswordFile = args[index + 1];
      index += 1;
      continue;
    }

    if (arg === "--no-merge-existing-latest") {
      options.mergeExistingLatest = false;
      continue;
    }

    if (arg === "--update-existing-notes") {
      options.releaseNotesMode = "update";
      continue;
    }

    if (arg === "--keep-existing-notes") {
      options.releaseNotesMode = "keep";
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

function validateOptions(options) {
  if (!["mac", "windows"].includes(options.platform)) {
    fail(`Unsupported local release platform: ${options.platform || "(missing)"}`);
  }

  if (!options.version) {
    fail("Missing version. Use a version like 2.0.2, without the leading v.");
  }

  if (options.version.startsWith("v")) {
    fail(`Use "${options.version.slice(1)}" instead of "${options.version}". The script adds the v tag prefix.`);
  }

  try {
    parseAppVersion(options.version);
  } catch (error) {
    fail(error.message);
  }

  const repoPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
  if (!repoPattern.test(options.releaseRepo)) {
    fail(`Invalid downloads repo: ${options.releaseRepo}`);
  }
  if (!repoPattern.test(options.updateRepo)) {
    fail(`Invalid updater repo: ${options.updateRepo}`);
  }

  if (options.platform === "mac" && process.platform !== "darwin") {
    fail("macOS local release assets must be built on macOS.");
  }

  if (options.platform === "windows" && process.platform !== "win32") {
    fail("Windows local release assets should be built inside a Windows VM or Windows machine.");
  }

  if (!process.env.TAURI_SIGNING_PRIVATE_KEY) {
    fail(
      "Missing Tauri updater signing environment.",
      [
        "Set TAURI_SIGNING_PRIVATE_KEY_PATH or pass --signing-key-file before running this release command.",
        "Set TAURI_SIGNING_PRIVATE_KEY_PASSWORD only if the private key has a password.",
      ].join("\n"),
    );
  }
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    env: options.env,
    stdio: options.stdio || "inherit",
  });

  if (result.error) {
    fail(`Failed to run: ${[command, ...args].join(" ")}`, result.error.message);
  }

  if (result.status !== 0 && !options.allowFailure) {
    fail(`Command failed: ${[command, ...args].join(" ")}`);
  }

  return {
    ...result,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
  };
}

function runOutput(command, args, options = {}) {
  return run(command, args, {
    ...options,
    stdio: "pipe",
  });
}

function npmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function hasAppleSigningIdentity() {
  return Boolean(process.env.APPLE_CERTIFICATE || process.env.APPLE_SIGNING_IDENTITY);
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function resolveLocalPath(rootDir, filePath) {
  if (!filePath) {
    return "";
  }

  if (filePath === "~") {
    return process.env.HOME || process.env.USERPROFILE || filePath;
  }

  if (filePath.startsWith("~/") || filePath.startsWith("~\\")) {
    const homeDir = process.env.HOME || process.env.USERPROFILE;
    return homeDir ? path.join(homeDir, filePath.slice(2)) : filePath;
  }

  return path.isAbsolute(filePath) ? filePath : path.resolve(rootDir, filePath);
}

function signingKeyPath(options, rootDir) {
  let keyFile = options.signingKeyFile || process.env.TAURI_SIGNING_PRIVATE_KEY_PATH || "";
  if (!keyFile) {
    const homeDir = process.env.HOME || process.env.USERPROFILE || "";
    if (homeDir) {
      keyFile = path.join(homeDir, ".config", "main", "tauri-updater.key");
    }
  }
  return resolveLocalPath(rootDir, keyFile);
}

async function loadSigningEnvironment(options, rootDir) {
  const keyFile = signingKeyPath(options, rootDir);
  const passwordFile = options.signingPasswordFile || process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD_PATH || "";

  if (!process.env.TAURI_SIGNING_PRIVATE_KEY && keyFile) {
    process.env.TAURI_SIGNING_PRIVATE_KEY = (await fs.readFile(keyFile, "utf8")).replace(/\r\n/g, "\n").trimEnd();
  }

  if (!process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD && passwordFile) {
    const resolvedPasswordFile = resolveLocalPath(rootDir, passwordFile);
    process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD = (await fs.readFile(resolvedPasswordFile, "utf8")).trimEnd();
  }

  if (process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD === undefined) {
    process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD = "";
  }
}

async function ensureUpdaterPublicKeyMatches(options, rootDir) {
  const privateKeyFile = signingKeyPath(options, rootDir);
  if (!privateKeyFile) {
    return;
  }

  const publicKeyFile = `${privateKeyFile}.pub`;
  if (!(await pathExists(publicKeyFile))) {
    return;
  }

  const generatedPublicKey = (await fs.readFile(publicKeyFile, "utf8")).trim();
  const tauriConfigPath = path.join(rootDir, "src-tauri", "tauri.conf.json");
  const tauriConfig = JSON.parse(await fs.readFile(tauriConfigPath, "utf8"));
  const configuredPublicKey = String(tauriConfig.plugins?.updater?.pubkey || "").trim();

  if (generatedPublicKey && configuredPublicKey && generatedPublicKey !== configuredPublicKey) {
    fail(
      "Updater public key mismatch.",
      [
        `Private key file: ${privateKeyFile}`,
        `Public key file:  ${publicKeyFile}`,
        `Config file:      ${tauriConfigPath}`,
        "Update plugins.updater.pubkey to the contents of the .pub file before publishing with this key.",
      ].join("\n"),
    );
  }
}

function cleanXattrs(paths, rootDir) {
  if (process.platform !== "darwin") {
    return;
  }

  for (const itemPath of paths) {
    if (spawnSync("test", ["-e", itemPath]).status === 0) {
      run("xattr", ["-cr", itemPath], { cwd: rootDir, allowFailure: true });
    }
  }
}

async function ensureMacExecutableName(appPath) {
  const infoPlistPath = path.join(appPath, "Contents", "Info.plist");
  const macosDir = path.join(appPath, "Contents", "MacOS");
  const expectedName = runOutput("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleExecutable", infoPlistPath]).stdout.trim();
  const entries = await fs.readdir(macosDir, { withFileTypes: true });
  const executableFiles = [];

  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }

    const filePath = path.join(macosDir, entry.name);
    const stat = await fs.stat(filePath);
    if ((stat.mode & 0o111) !== 0) {
      executableFiles.push(filePath);
    }
  }

  if (executableFiles.length !== 1) {
    fail(`Expected exactly one bundled executable in ${macosDir}, found ${executableFiles.length}.`);
  }

  const currentPath = executableFiles[0];
  const expectedPath = path.join(macosDir, expectedName);

  if (path.basename(currentPath) !== expectedName) {
    const tempPath = path.join(macosDir, `.${expectedName}.rename-tmp`);
    await fs.rm(tempPath, { force: true });
    await fs.rename(currentPath, tempPath);
    await fs.rename(tempPath, expectedPath);
  }

  await fs.chmod(expectedPath, 0o755);
}

async function signMacAppIfNeeded(appPath) {
  await ensureMacExecutableName(appPath);
  cleanXattrs([appPath], path.dirname(appPath));

  if (!hasAppleSigningIdentity()) {
    run("codesign", ["--force", "--deep", "--sign", "-", appPath]);
  }

  run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath]);
}

function buildMacTarget(rootDir, target) {
  const args = ["run", "tauri", "build", "--", "--target", target, "--bundles", "app"];
  if (!hasAppleSigningIdentity()) {
    args.push("--no-sign");
  }
  run(npmCommand(), args, { cwd: rootDir });
}

function ensureRustTargets(rootDir, targets) {
  const result = runOutput("rustup", ["target", "list", "--installed"], {
    cwd: rootDir,
    allowFailure: true,
  });

  if (result.status !== 0) {
    return;
  }

  const installedTargets = new Set(result.stdout.split(/\s+/).filter(Boolean));
  const missingTargets = targets.filter((target) => !installedTargets.has(target));
  if (missingTargets.length > 0) {
    fail(
      `Missing Rust target${missingTargets.length === 1 ? "" : "s"}: ${missingTargets.join(", ")}`,
      `Install with: rustup target add ${missingTargets.join(" ")}`,
    );
  }
}

function zipMacApp({ rootDir, appPath, outputPath }) {
  run("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", appPath, outputPath], { cwd: rootDir });
}

function createTarGz({ rootDir, appPath, outputPath }) {
  run("tar", ["-czf", outputPath, "-C", path.dirname(appPath), path.basename(appPath)], {
    cwd: rootDir,
    env: {
      ...process.env,
      COPYFILE_DISABLE: "1",
    },
  });
  validateMacUpdaterArchive({ rootDir, archivePath: outputPath, appName: path.basename(appPath) });
}

function listTarEntries(rootDir, archivePath) {
  const script = [
    "import sys, tarfile",
    "with tarfile.open(sys.argv[1], 'r:*') as archive:",
    "    for name in archive.getnames():",
    "        print(name)",
  ].join("\n");

  return runOutput("python3", ["-c", script, archivePath], { cwd: rootDir })
    .stdout
    .split("\n")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function normalizeTarEntryName(entry) {
  return String(entry || "")
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "")
    .replace(/\/+$/, "");
}

function isAppleDoubleEntry(entry) {
  const normalized = normalizeTarEntryName(entry);
  if (!normalized) {
    return false;
  }

  return (
    normalized === "__MACOSX" ||
    normalized.startsWith("__MACOSX/") ||
    normalized.split("/").some((part) => part.startsWith("._"))
  );
}

function validateMacUpdaterArchive({ rootDir, archivePath, appName }) {
  const entries = listTarEntries(rootDir, archivePath);
  const forbiddenEntries = entries.filter(isAppleDoubleEntry);

  if (forbiddenEntries.length > 0) {
    fail(
      `macOS updater archive contains AppleDouble metadata: ${archivePath}`,
      forbiddenEntries.slice(0, 20).join("\n"),
    );
  }

  const topLevelEntries = new Set(
    entries
      .map((entry) => normalizeTarEntryName(entry).split("/")[0])
      .filter(Boolean),
  );

  if (topLevelEntries.size !== 1 || !topLevelEntries.has(appName)) {
    fail(
      `macOS updater archive must contain only ${appName} at the top level: ${archivePath}`,
      [...topLevelEntries].sort().join("\n"),
    );
  }
}

async function signUpdaterArtifact(rootDir, artifactPath) {
  await fs.rm(`${artifactPath}.sig`, { force: true });
  run("npx", ["tauri", "signer", "sign", artifactPath], { cwd: rootDir });
}

async function buildMacAssets({ rootDir, version, assetsDir, skipBuild }) {
  cleanXattrs(
    [
      path.join(rootDir, "public", "LogoM.png"),
      path.join(rootDir, "public", "LogoM_app.svg"),
      path.join(rootDir, "public", "logoM_black.svg"),
      path.join(rootDir, "src-tauri", "icons"),
    ],
    rootDir,
  );

  if (!skipBuild) {
    ensureRustTargets(rootDir, ["aarch64-apple-darwin", "x86_64-apple-darwin"]);
    run(npmCommand(), ["run", "icon:app"], { cwd: rootDir });
    buildMacTarget(rootDir, "universal-apple-darwin");
    buildMacTarget(rootDir, "aarch64-apple-darwin");
  }

  const targets = [
    {
      appPath: path.join(rootDir, "src-tauri", "target", "universal-apple-darwin", "release", "bundle", "macos", `${APP_NAME}.app`),
      zipName: `${APP_NAME}_${version}_macOS_universal.zip`,
      updaterName: `${APP_NAME}_${version}_updater_darwin_x86_64.app.tar.gz`,
    },
    {
      appPath: path.join(rootDir, "src-tauri", "target", "aarch64-apple-darwin", "release", "bundle", "macos", `${APP_NAME}.app`),
      zipName: `${APP_NAME}_${version}_macOS_apple_silicon.zip`,
      updaterName: `${APP_NAME}_${version}_updater_darwin_aarch64.app.tar.gz`,
    },
  ];

  for (const target of targets) {
    if (!(await pathExists(target.appPath))) {
      fail(`Missing macOS app bundle: ${target.appPath}`);
    }

    await signMacAppIfNeeded(target.appPath);

    const zipPath = path.join(assetsDir, target.zipName);
    const updaterPath = path.join(assetsDir, target.updaterName);
    await fs.rm(zipPath, { force: true });
    await fs.rm(updaterPath, { force: true });

    zipMacApp({ rootDir, appPath: target.appPath, outputPath: zipPath });
    createTarGz({ rootDir, appPath: target.appPath, outputPath: updaterPath });
    await signUpdaterArtifact(rootDir, updaterPath);

    if (!(await pathExists(`${updaterPath}.sig`))) {
      fail(`Failed to sign macOS updater artifact: ${updaterPath}`);
    }
  }
}

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function compressArchive(sourcePath, destinationPath, rootDir) {
  run(
    "powershell",
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      `Compress-Archive -LiteralPath ${psQuote(sourcePath)} -DestinationPath ${psQuote(destinationPath)} -Force`,
    ],
    { cwd: rootDir },
  );
}

function windowsReleaseDir(rootDir) {
  return path.join(rootDir, "src-tauri", "target", WINDOWS_X64_TARGET, "release");
}

async function listFilesRecursive(directoryPath) {
  const entries = await fs.readdir(directoryPath, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const entryPath = path.join(directoryPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFilesRecursive(entryPath)));
    } else if (entry.isFile()) {
      files.push(entryPath);
    }
  }

  return files;
}

async function findLatestNsisInstaller(rootDir) {
  const candidateDirs = [
    path.join(windowsReleaseDir(rootDir), "bundle", "nsis"),
    path.join(rootDir, "src-tauri", "target", "release", "bundle", "nsis"),
  ];
  let nsisDir = "";

  for (const candidateDir of candidateDirs) {
    if (await pathExists(candidateDir)) {
      nsisDir = candidateDir;
      break;
    }
  }

  if (!nsisDir) {
    fail(`Missing Windows NSIS output directory. Checked:\n${candidateDirs.join("\n")}`);
  }

  const files = await listFilesRecursive(nsisDir);
  const installers = [];
  for (const filePath of files) {
    if (!filePath.toLowerCase().endsWith(".exe") || filePath.toLowerCase().endsWith(".sig")) {
      continue;
    }
    const stat = await fs.stat(filePath);
    installers.push({ filePath, mtimeMs: stat.mtimeMs });
  }

  installers.sort((left, right) => right.mtimeMs - left.mtimeMs);

  if (installers.length === 0) {
    fail(`Missing Windows updater NSIS artifact under ${nsisDir}`);
  }

  return installers[0].filePath;
}

async function buildWindowsAssets({ rootDir, version, assetsDir, skipBuild }) {
  if (!skipBuild) {
    run("rustup", ["target", "add", WINDOWS_X64_TARGET], { cwd: rootDir });
    run(
      "powershell",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        "scripts/build-windows-portable.ps1",
        "-Target",
        WINDOWS_X64_TARGET,
      ],
      { cwd: rootDir },
    );
    run(npmCommand(), ["run", "tauri", "build", "--", "--target", WINDOWS_X64_TARGET, "--bundles", "nsis"], { cwd: rootDir });
  }

  const portableExe = path.join(rootDir, "src-tauri", "target", "release", "portable", `${APP_NAME}-${version}-windows-portable.exe`);
  if (!(await pathExists(portableExe))) {
    fail(`Missing Windows portable exe: ${portableExe}`);
  }

  const zipPath = path.join(assetsDir, `${APP_NAME}_${version}_windows_x64.zip`);
  await fs.rm(zipPath, { force: true });
  compressArchive(portableExe, zipPath, rootDir);

  const nsisInstaller = await findLatestNsisInstaller(rootDir);
  const updaterPath = path.join(assetsDir, `${APP_NAME}_${version}_updater_windows_x86_64.exe`);
  await fs.copyFile(nsisInstaller, updaterPath);
  await signUpdaterArtifact(rootDir, updaterPath);

  if (!(await pathExists(`${updaterPath}.sig`))) {
    fail(`Failed to sign Windows updater artifact: ${updaterPath}`);
  }
}

function gitText(rootDir, args) {
  const result = runOutput("git", args, { cwd: rootDir, allowFailure: true });
  return result.status === 0 ? result.stdout.trim() : "";
}

async function writeReleaseNotes({ rootDir, version, outputPath }) {
  const latestTag = gitText(rootDir, ["describe", "--tags", "--abbrev=0", "--match", "v[0-9]*"]);
  const logRange = latestTag ? `${latestTag}..HEAD` : "-8";
  const recentCommits = gitText(rootDir, ["log", "--pretty=format:%h %s", logRange]);
  const changedSinceTag = latestTag
    ? gitText(rootDir, ["diff", "--name-status", `${latestTag}..HEAD`])
    : gitText(rootDir, ["show", "--name-status", "--format=", "--find-renames", "HEAD"]);
  const workingTreeChanges = gitText(rootDir, ["status", "--short"]);
  const commitSha = gitText(rootDir, ["rev-parse", "--short", "HEAD"]);
  const commitSubject = gitText(rootDir, ["log", "-1", "--pretty=%s"]);
  const commitBody = gitText(rootDir, ["log", "-1", "--pretty=%b"]);
  const commitAuthor = gitText(rootDir, ["log", "-1", "--pretty=%an"]);
  const commitDate = gitText(rootDir, ["log", "-1", "--date=iso-strict", "--pretty=%cd"]);
  const lines = [
    `# ${APP_NAME} ${version}`,
    "",
    "## Downloads",
    "",
    `- macOS Universal: download \`${APP_NAME}_${version}_macOS_universal.zip\``,
    `- macOS Apple Silicon: download \`${APP_NAME}_${version}_macOS_apple_silicon.zip\``,
    `- Windows: download \`${APP_NAME}_${version}_windows_x64.zip\``,
    "",
    "## Changelog",
    "",
    commitSha ? `- Commit: \`${commitSha}\`` : "- Commit: local build",
    commitAuthor ? `- Author: ${commitAuthor}` : "",
    commitDate ? `- Date: ${commitDate}` : "",
    commitSubject ? `- Summary: ${commitSubject}` : "",
  ].filter(Boolean);

  if (latestTag || recentCommits) {
    lines.push("", "### Recent changes", "");
    if (latestTag) {
      lines.push(`Changes since \`${latestTag}\`:`);
    }
    if (recentCommits) {
      lines.push("", "```text", recentCommits, "```");
    }
  }

  if (commitBody) {
    lines.push("", "### Commit details", "", "```text", commitBody, "```");
  }

  if (changedSinceTag) {
    lines.push("", "### Changed files", "", "```text", changedSinceTag, "```");
  }

  if (workingTreeChanges) {
    lines.push("", "### Local release-time changes", "", "```text", workingTreeChanges, "```");
  }

  lines.push(
    "",
    "## Privacy boundary",
    "",
    "This public release contains only packaged desktop binaries and a commit summary. Source code remains in the private MAIN repository.",
  );

  await fs.writeFile(outputPath, `${lines.join("\n")}\n`, "utf8");
}

function ensureGhReady() {
  run("gh", ["--version"], { stdio: "pipe" });
  run("gh", ["auth", "status", "--hostname", "github.com"], { stdio: "pipe" });
}

function releaseExists(tag, repo) {
  const result = run("gh", ["release", "view", tag, "--repo", repo, "--json", "tagName"], {
    stdio: "pipe",
    allowFailure: true,
  });
  return result.status === 0;
}

function releaseFlags(options) {
  const flags = [];
  if (options.draft) {
    flags.push("--draft");
  }
  if (options.prerelease) {
    flags.push("--prerelease");
  }
  return flags;
}

function createOrUpdateRelease({ tag, repo, title, notesPath, assetPaths, options, updateExistingNotes }) {
  if (releaseExists(tag, repo)) {
    if (updateExistingNotes) {
      run("gh", [
        "release",
        "edit",
        tag,
        "--repo",
        repo,
        "--title",
        title,
        "--notes-file",
        notesPath,
        `--draft=${String(options.draft)}`,
        `--prerelease=${String(options.prerelease)}`,
      ]);
    } else {
      console.log(`Keeping existing release notes for ${repo} ${tag}; uploading assets only.`);
    }

    run("gh", ["release", "upload", tag, ...assetPaths, "--repo", repo, "--clobber"]);
    return;
  }

  run("gh", [
    "release",
    "create",
    tag,
    ...assetPaths,
    "--repo",
    repo,
    "--title",
    title,
    "--notes-file",
    notesPath,
    ...releaseFlags(options),
  ]);
}

function shouldUpdateExistingNotes(options) {
  if (options.releaseNotesMode === "update") {
    return true;
  }
  if (options.releaseNotesMode === "keep") {
    return false;
  }
  return options.platform === "mac";
}

async function downloadExistingLatestJson({ tag, updateRepo, stageDir }) {
  const latestDir = path.join(stageDir, "existing-latest");
  await fs.rm(latestDir, { recursive: true, force: true });
  await fs.mkdir(latestDir, { recursive: true });

  if (!releaseExists(tag, updateRepo)) {
    return "";
  }

  const result = run("gh", ["release", "download", tag, "--repo", updateRepo, "--pattern", "latest.json", "--dir", latestDir, "--clobber"], {
    stdio: "pipe",
    allowFailure: true,
  });

  const latestPath = path.join(latestDir, "latest.json");
  return result.status === 0 && (await pathExists(latestPath)) ? latestPath : "";
}

async function publishAssets({ tag, stageDir, assetsDir, notesPath, options }) {
  ensureGhReady();

  const updateExistingNotes = shouldUpdateExistingNotes(options);
  const existingManifestPath = options.mergeExistingLatest
    ? await downloadExistingLatestJson({ tag, updateRepo: options.updateRepo, stageDir })
    : "";

  const manifestResult = await writeUpdaterManifest({
    assetsDir,
    version: options.version,
    updateRepo: options.updateRepo,
    notesPath,
    existingManifestPath,
    preserveExistingNotes: !updateExistingNotes,
  });

  const assetNames = await fs.readdir(assetsDir);
  const downloadAssets = assetNames
    .filter((fileName) => fileName.endsWith(".zip"))
    .map((fileName) => path.join(assetsDir, fileName));
  const updaterAssets = assetNames
    .filter((fileName) => fileName.includes("_updater_") || fileName === "latest.json")
    .map((fileName) => path.join(assetsDir, fileName));

  if (downloadAssets.length === 0) {
    fail(`No downloadable zip assets found in ${assetsDir}`);
  }
  if (updaterAssets.length === 0) {
    fail(`No updater assets found in ${assetsDir}`);
  }

  createOrUpdateRelease({
    tag,
    repo: options.releaseRepo,
    title: `${APP_NAME} ${options.version}`,
    notesPath,
    assetPaths: updateExistingNotes ? [...downloadAssets, notesPath] : downloadAssets,
    options,
    updateExistingNotes,
  });
  createOrUpdateRelease({
    tag,
    repo: options.updateRepo,
    title: `${APP_NAME} Updater ${options.version}`,
    notesPath,
    assetPaths: updaterAssets,
    options,
    updateExistingNotes,
  });

  return manifestResult;
}

async function stageManifestOnly({ assetsDir, notesPath, options }) {
  return writeUpdaterManifest({
    assetsDir,
    version: options.version,
    updateRepo: options.updateRepo,
    notesPath,
  });
}

function printLocalSummary({ stageDir, assetsDir, options, tag, uploaded }) {
  console.log("");
  console.log(`Local ${options.platform} release assets are ready.`);
  console.log(`- Stage dir: ${stageDir}`);
  console.log(`- Assets dir: ${assetsDir}`);
  console.log(`- Downloads: https://github.com/${options.releaseRepo}/releases/tag/${tag}`);
  console.log(`- Updater:   https://github.com/${options.updateRepo}/releases/tag/${tag}`);
  console.log(`- Manifest:  https://github.com/${options.updateRepo}/releases/latest/download/latest.json`);

  if (!uploaded) {
    console.log("");
    console.log("Upload was skipped because --no-upload was provided.");
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  await loadSigningEnvironment(options, rootDir);
  validateOptions(options);
  await ensureUpdaterPublicKeyMatches(options, rootDir);

  const stageDir = path.join(rootDir, "release-output", "local", `v${options.version}`);
  const assetsDir = path.join(stageDir, "assets");
  const notesPath = path.join(stageDir, RELEASE_NOTES_FILE_NAME);
  const tag = `v${options.version}`;

  console.log(`Preparing local ${options.platform} release for ${APP_NAME} ${options.version}...`);
  if (options.platform === "windows") {
    console.log(`- Windows build target: ${WINDOWS_X64_TARGET} (Windows 11 x64 compatible)`);
  }
  const versionResult = await syncReleaseVersions({ rootDir, version: options.version });
  console.log(`- macOS bundleVersion: ${versionResult.macBundleVersion}`);
  console.log(`- Windows wix version: ${versionResult.windowsWixVersion}`);

  await fs.rm(stageDir, { recursive: true, force: true });
  await fs.mkdir(assetsDir, { recursive: true });

  if (options.platform === "mac") {
    await buildMacAssets({ rootDir, version: options.version, assetsDir, skipBuild: options.skipBuild });
  } else {
    await buildWindowsAssets({ rootDir, version: options.version, assetsDir, skipBuild: options.skipBuild });
  }

  await writeReleaseNotes({ rootDir, version: options.version, outputPath: notesPath });

  if (options.upload) {
    await publishAssets({ tag, stageDir, assetsDir, notesPath, options });
  } else {
    await stageManifestOnly({ assetsDir, notesPath, options });
  }

  printLocalSummary({ stageDir, assetsDir, options, tag, uploaded: options.upload });
}

await main();
