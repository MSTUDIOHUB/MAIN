#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { brotliDecompressSync } from "node:zlib";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BUILD_APP = path.join(ROOT, "src-tauri/target/release/bundle/macos/MAIN.app");
const INSTALLED_APP = "/Applications/MAIN.app";
const DEFAULT_MANIFEST = path.join(ROOT, "test-results/native-app-install/build-manifest.json");
const SOURCE_PATHS = ["src", "public", "src-tauri", "scripts", "docs/main-manual", "index.html",
  "package.json", "package-lock.json", "vite.config.ts", "tsconfig.json", "tsconfig.node.json"];

function help() {
  console.log(`Usage: node scripts/verify-install-native-app.mjs [options]

Default: build the native macOS app with --bundles app --no-sign, prove frontend
embedding, ad-hoc sign and verify it, back up the stopped installed app, then
install a verified whole bundle through a fresh staging directory and rename.
Does not change versions, launch MAIN, upload, or request elevated privileges.

Options:
  --manifest <path>  Receipt under ignored test-results/.
                     Default: test-results/native-app-install/build-manifest.json
  --verify-only     Read an existing successful receipt; recheck source, dist,
                     embedded Brotli bytes, both signed bundles and all tree hashes.
                     Never builds, signs, installs, creates directories or writes files.
  -h, --help        Show this help without inspecting or changing anything.

Quit MAIN before running either mode. Process checks use ps executable paths,
not substring searches or automatic killing. Existing apps are backed up to
~/Library/Application Support/MAIN/App Backups/<timestamp>/MAIN.app.
Build: ${BUILD_APP}
Install: ${INSTALLED_APP}
`);
}

function options(argv) {
  const result = { verifyOnly: false, manifest: DEFAULT_MANIFEST, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    if (["-h", "--help"].includes(argv[index])) result.help = true;
    else if (argv[index] === "--verify-only") result.verifyOnly = true;
    else if (argv[index] === "--manifest" && argv[index + 1] && !argv[index + 1].startsWith("-")) {
      result.manifest = path.resolve(ROOT, argv[++index]);
    } else throw new Error(`Unknown or incomplete option: ${argv[index]}`);
  }
  return result;
}

function command(program, args, { inherit = false, env } = {}) {
  const result = spawnSync(program, args, { cwd: ROOT, env: env || process.env,
    encoding: "utf8", stdio: inherit ? "inherit" : "pipe", maxBuffer: 32 * 1024 * 1024 });
  if (result.error || result.status !== 0) {
    throw new Error(`${program} ${args.join(" ")} failed: ${result.error?.message || result.stderr?.trim() || `exit ${result.status}`}`);
  }
  return { stdout: result.stdout || "", stderr: result.stderr || "" };
}

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const same = (left, right, label) => {
  if (JSON.stringify(left) !== JSON.stringify(right)) throw new Error(`${label} changed or does not match.`);
};

async function exists(file) {
  try { await fs.lstat(file); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; }
}

async function entry(file, relative) {
  const stat = await fs.lstat(file);
  const base = { path: relative, mode: stat.mode & 0o7777 };
  if (stat.isSymbolicLink()) return { ...base, type: "symlink", target: await fs.readlink(file) };
  if (stat.isFile()) return { ...base, type: "file", bytes: stat.size, sha256: sha256(await fs.readFile(file)) };
  if (stat.isDirectory()) return { ...base, type: "directory" };
  throw new Error(`Unsupported special filesystem entry: ${file}`);
}

async function tree(directory) {
  const entries = [];
  async function visit(file, relative) {
    const item = await entry(file, relative);
    entries.push(item);
    if (item.type === "directory") {
      for (const name of (await fs.readdir(file)).sort()) await visit(path.join(file, name), relative ? `${relative}/${name}` : name);
    }
  }
  await visit(directory, "");
  return { sha256: sha256(JSON.stringify(entries)), entries };
}

async function sourceFingerprint() {
  const list = (extra) => command("git", ["ls-files", "-z", ...extra, "--", ...SOURCE_PATHS]).stdout.split("\0").filter(Boolean).sort();
  const tracked = list(["--cached"]);
  const untracked = list(["--others", "--exclude-standard"]);
  const files = [];
  for (const name of [...new Set([...tracked, ...untracked])].sort()) files.push(await entry(path.join(ROOT, name), name));
  return { sha256: sha256(JSON.stringify(files)), trackedSha256: sha256(JSON.stringify(files.filter((item) => tracked.includes(item.path)))),
    trackedPaths: tracked, untrackedPaths: untracked, files };
}

function stopped() {
  const roots = [BUILD_APP, INSTALLED_APP];
  const binaries = [path.join(ROOT, "src-tauri/target/release/MAIN"), ...roots.map((app) => path.join(app, "Contents/MacOS/MAIN"))];
  const matches = command("/bin/ps", ["-ww", "-axo", "pid=,comm="]).stdout.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
    if (!match) return [];
    const executable = match[2];
    if (executable === "MAIN" || binaries.includes(executable) ||
      roots.some((app) => executable.startsWith(`${app}/`)) || executable.endsWith("/MAIN.app/Contents/MacOS/MAIN")) {
      return [{ pid: Number(match[1]), executable }];
    }
    return [];
  });
  if (matches.length) throw new Error(`Quit MAIN before proceeding; matching executable paths: ${JSON.stringify(matches)}`);
}

async function bundleInfo(app) {
  const stat = await fs.lstat(app);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Expected a real app directory: ${app}`);
  const plist = path.join(app, "Contents/Info.plist");
  const value = (key) => command("/usr/libexec/PlistBuddy", ["-c", `Print :${key}`, plist]).stdout.trim();
  const executable = value("CFBundleExecutable");
  if (executable !== "MAIN") throw new Error(`Unexpected app executable: ${executable}`);
  const config = JSON.parse(await fs.readFile(path.join(ROOT, "src-tauri/tauri.conf.json"), "utf8"));
  const identifier = value("CFBundleIdentifier");
  const version = value("CFBundleShortVersionString");
  if (identifier !== config.identifier || version !== config.version) throw new Error(`App identity/version differs from source config: ${app}`);
  return { executable, identifier, version, bundleVersion: value("CFBundleVersion"), binary: path.join(app, "Contents/MacOS", executable) };
}

function signature(app) {
  const verify = command("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--verbose=2", app]);
  const display = command("/usr/bin/codesign", ["-d", "--verbose=4", app]);
  const description = `${display.stdout}${display.stderr}`;
  if (!/^Signature=adhoc\s*$/m.test(description)) throw new Error(`Expected the explicit ad-hoc test signature: ${app}`);
  const cdHash = /^CDHash=(\S+)/m.exec(description)?.[1];
  if (!cdHash) throw new Error(`codesign did not report a CDHash: ${app}`);
  return { verified: true, cdHash, verification: `${verify.stdout}${verify.stderr}`.trim(), description: description.trim() };
}

async function embeddedFrontend(binaryFile) {
  const html = await fs.readFile(path.join(ROOT, "dist/index.html"));
  const scriptTags = html.toString("utf8").match(/<script\b[^>]*>/gi) || [];
  const entryUrls = scriptTags.filter((tag) => /\btype\s*=\s*["']module["']/i.test(tag))
    .map((tag) => /\bsrc\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1]).filter(Boolean);
  if (entryUrls.length !== 1 || !/^\/?assets\/index-[^/]+\.js$/.test(entryUrls[0])) throw new Error("dist/index.html must reference exactly one main index-*.js module.");
  const entryPath = path.join(ROOT, "dist", entryUrls[0].replace(/^\//, ""));
  const wanted = [{ file: "dist/index.html", bytes: html }, { file: path.relative(ROOT, entryPath), bytes: await fs.readFile(entryPath) }];
  const binary = await fs.readFile(binaryFile);
  const buildRoot = path.join(ROOT, "src-tauri/target/release/build");
  const candidates = [];
  for (const directory of (await fs.readdir(buildRoot)).sort()) {
    if (!directory.startsWith("tauri-app-")) continue;
    const assets = path.join(buildRoot, directory, "out/tauri-codegen-assets");
    if (!(await exists(assets))) continue;
    for (const name of (await fs.readdir(assets)).sort()) if (/\.(?:js|html)$/.test(name)) candidates.push(path.join(assets, name));
  }
  const evidence = [];
  for (const expected of wanted) {
    const matches = [];
    for (const candidate of candidates.filter((file) => path.extname(file) === path.extname(expected.file))) {
      const compressed = await fs.readFile(candidate);
      let decoded;
      try { decoded = brotliDecompressSync(compressed, { maxOutputLength: expected.bytes.length + 1 }); } catch { continue; }
      if (!decoded.equals(expected.bytes)) continue;
      const offset = binary.indexOf(compressed);
      if (offset >= 0) matches.push({ codegenAsset: path.relative(ROOT, candidate), compressedSha256: sha256(compressed), compressedBytes: compressed.length, binaryOffset: offset });
    }
    if (!matches.length) throw new Error(`No byte-identical Brotli embedding of ${expected.file} was found in ${binaryFile}`);
    evidence.push({ file: expected.file, sha256: sha256(expected.bytes), bytes: expected.bytes.length, matches });
  }
  return { verified: true, assets: evidence };
}

async function signedBundle(app) {
  const info = await bundleInfo(app);
  const signing = signature(app);
  return { info, signing, binarySha256: sha256(await fs.readFile(info.binary)), tree: await tree(app) };
}

async function writeManifest(file, manifest) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temporary, file);
}

async function verifyOnly(manifestPath) {
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  if (manifest.schemaVersion !== 1 || manifest.status !== "installed_verified" || manifest.repository !== ROOT ||
    manifest.buildApp !== BUILD_APP || manifest.installedApp !== INSTALLED_APP) throw new Error("A successful receipt for this repository and app paths is required.");
  same(await sourceFingerprint(), manifest.source, "App source fingerprint");
  stopped();
  const built = await signedBundle(BUILD_APP);
  const installed = await signedBundle(INSTALLED_APP);
  same(built.tree, manifest.signedBuild.tree, "Signed build bundle tree");
  same(installed.tree, manifest.installed.tree, "Installed bundle tree");
  same(installed.tree, built.tree, "Build/installed complete bundle trees");
  same(built.binarySha256, manifest.signedBuild.binarySha256, "Signed build executable hash");
  same(installed.binarySha256, manifest.installed.binarySha256, "Installed executable hash");
  same(built.signing.cdHash, manifest.signedBuild.signing.cdHash, "Signed build CDHash");
  same(installed.signing.cdHash, built.signing.cdHash, "Installed CDHash");
  const frontend = await embeddedFrontend(built.info.binary);
  same(frontend.assets.map(({ file, sha256: digest, bytes }) => ({ file, sha256: digest, bytes })),
    manifest.frontend.assets.map(({ file, sha256: digest, bytes }) => ({ file, sha256: digest, bytes })), "Embedded frontend bytes");
  console.log(`Verified, read-only: ${manifestPath}\nSource ${manifest.source.sha256}\nBundle ${built.tree.sha256}\nCDHash ${built.signing.cdHash}`);
}

async function buildAndInstall(manifestPath) {
  const source = await sourceFingerprint();
  const manifest = { schemaVersion: 1, status: "prepared", startedAt: new Date().toISOString(), repository: ROOT,
    buildCommit: command("git", ["rev-parse", "HEAD"]).stdout.trim(), buildApp: BUILD_APP, installedApp: INSTALLED_APP,
    buildCommand: ["npm", "run", "tauri", "build", "--", "--bundles", "app", "--no-sign"], source };
  let stageRoot;
  let previousApp;
  let installedNew = false;
  try {
    stopped();
    await writeManifest(manifestPath, manifest);
    command("npm", ["run", "tauri", "build", "--", "--bundles", "app", "--no-sign"], {
      inherit: true, env: { ...process.env, CARGO_TARGET_DIR: path.join(ROOT, "src-tauri/target") },
    });
    same(await sourceFingerprint(), source, "App sources during build");
    same(command("git", ["rev-parse", "HEAD"]).stdout.trim(), manifest.buildCommit, "Build commit");
    const info = await bundleInfo(BUILD_APP);
    manifest.frontend = await embeddedFrontend(info.binary);
    stopped();
    // Same explicit local-signing boundary as release-local.mjs. --no-sign alone
    // does not guarantee a complete bundle signature suitable for macOS/TCC.
    command("/usr/bin/xattr", ["-cr", BUILD_APP]);
    command("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", BUILD_APP]);
    manifest.signedBuild = await signedBundle(BUILD_APP);
    await embeddedFrontend(manifest.signedBuild.info.binary);
    manifest.status = "signed_verified";
    await writeManifest(manifestPath, manifest);

    stageRoot = await fs.mkdtemp(path.join(path.dirname(INSTALLED_APP), ".MAIN-native-stage-"));
    const stagedApp = path.join(stageRoot, "MAIN.app");
    command("/usr/bin/ditto", [BUILD_APP, stagedApp]); // Fresh destination only.
    const staged = await signedBundle(stagedApp);
    same(staged.tree, manifest.signedBuild.tree, "Staged complete bundle tree");
    same(staged.signing.cdHash, manifest.signedBuild.signing.cdHash, "Staged CDHash");
    stopped();
    if (await exists(INSTALLED_APP)) {
      const installedStat = await fs.lstat(INSTALLED_APP);
      if (!installedStat.isDirectory() || installedStat.isSymbolicLink()) throw new Error("Installed MAIN.app must be a real directory.");
      const oldTree = await tree(INSTALLED_APP);
      const backupDirectory = path.join(os.homedir(), "Library/Application Support/MAIN/App Backups",
        `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`);
      await fs.mkdir(backupDirectory, { recursive: true });
      const backupApp = path.join(backupDirectory, "MAIN.app");
      command("/usr/bin/ditto", [INSTALLED_APP, backupApp]);
      same(await tree(backupApp), oldTree, "Preserved old-app backup");
      same(await tree(INSTALLED_APP), oldTree, "Old app during backup");
      manifest.backup = { app: backupApp, tree: oldTree };
    }
    same(await sourceFingerprint(), source, "App sources before installation");
    same(await tree(BUILD_APP), manifest.signedBuild.tree, "Signed build before installation");
    await writeManifest(manifestPath, manifest);
    stopped();
    if (await exists(INSTALLED_APP)) {
      previousApp = path.join(stageRoot, "previous-MAIN.app");
      await fs.rename(INSTALLED_APP, previousApp);
    }
    await fs.rename(stagedApp, INSTALLED_APP);
    installedNew = true;
    manifest.installed = await signedBundle(INSTALLED_APP);
    same(manifest.installed.tree, manifest.signedBuild.tree, "Installed complete bundle tree");
    same(manifest.installed.signing.cdHash, manifest.signedBuild.signing.cdHash, "Installed CDHash");
    same(await sourceFingerprint(), source, "App sources after installation");
    manifest.status = "installed_verified";
    manifest.completedAt = new Date().toISOString();
    await writeManifest(manifestPath, manifest);
    await fs.rm(stageRoot, { recursive: true });
    console.log(`Installed and verified ${INSTALLED_APP}\nReceipt: ${manifestPath}\nBackup: ${manifest.backup?.app || "no previous app"}`);
  } catch (error) {
    manifest.status = "failed";
    manifest.error = error.message;
    // Retain failed/staged artifacts and the durable backup for diagnosis.
    // Roll back only with a stopped process and the exact previous bundle.
    if (previousApp) {
      try {
        stopped();
        if (installedNew && await exists(INSTALLED_APP)) await fs.rename(INSTALLED_APP, path.join(stageRoot, "failed-MAIN.app"));
        if (!(await exists(INSTALLED_APP))) await fs.rename(previousApp, INSTALLED_APP);
        manifest.rollback = "previous_bundle_restored";
      } catch (rollbackError) { manifest.rollback = `not restored: ${rollbackError.message}`; }
    }
    if (stageRoot) manifest.retainedStage = stageRoot;
    await writeManifest(manifestPath, manifest);
    throw error;
  }
}

async function main() {
  const args = options(process.argv.slice(2));
  if (args.help) { help(); return; }
  if (process.platform !== "darwin") throw new Error("This script only supports local macOS native testing.");
  const relativeManifest = path.relative(path.join(ROOT, "test-results"), args.manifest);
  if (!relativeManifest || relativeManifest.startsWith("..") || path.isAbsolute(relativeManifest) || path.extname(args.manifest) !== ".json") {
    throw new Error("--manifest must name a JSON receipt under this repository's ignored test-results/.");
  }
  command("git", ["check-ignore", "--quiet", args.manifest]);
  if (args.verifyOnly) await verifyOnly(args.manifest);
  else await buildAndInstall(args.manifest);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(`Native app verification failed: ${error.message}`); process.exitCode = 1; });
}
