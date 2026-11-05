import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import YAML from "yaml";

import {
  collectPublicReleaseArtifacts,
  preparePublicRelease,
  syncReleaseVersions,
  toMacBundleVersion,
  toWindowsWixVersion,
  writeUpdaterManifest,
} from "../../scripts/release_tools.mjs";
import { resolveReleaseMacVersion } from "../../scripts/release-mac.mjs";
import { writeReleaseNotes } from "../../scripts/release-local.mjs";

const temporaryRoots = new Set();

async function createTempWorkspace() {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "main-release-tools-"));
  temporaryRoots.add(rootDir);
  await fs.mkdir(path.join(rootDir, "src-tauri"), { recursive: true });
  await fs.writeFile(path.join(rootDir, "package.json"), JSON.stringify({ version: "1.1.1" }, null, 2));
  await fs.writeFile(
    path.join(rootDir, "package-lock.json"),
    JSON.stringify({ version: "1.1.1", packages: { "": { version: "1.1.1" } } }, null, 2),
  );
  await fs.writeFile(path.join(rootDir, "src-tauri", "tauri.conf.json"), JSON.stringify({ version: "1.1.1" }, null, 2));
  await fs.writeFile(
    path.join(rootDir, "src-tauri", "tauri.macos.conf.json"),
    JSON.stringify({ bundle: { macOS: { bundleVersion: "1.1.1" } } }, null, 2),
  );
  await fs.writeFile(
    path.join(rootDir, "src-tauri", "tauri.windows.conf.json"),
    JSON.stringify({ bundle: { windows: { wix: { version: "1.1.1.0" } } } }, null, 2),
  );
  await fs.writeFile(
    path.join(rootDir, "src-tauri", "Cargo.toml"),
    [
      "[package]",
      'name = "main"',
      'version = "1.1.1"',
      "",
      "[dependencies]",
      'serde = "1"',
      "",
    ].join("\n"),
  );
  return rootDir;
}

test.afterEach(async () => {
  if (process.env.MAIN_KEEP_RELEASE_TOOL_FIXTURES === "1") return;
  await Promise.all([...temporaryRoots].map((rootDir) => fs.rm(rootDir, { recursive: true, force: true })));
  temporaryRoots.clear();
});

test("version helpers derive platform-compatible versions", () => {
  assert.equal(toMacBundleVersion("1.2.3-beta.4"), "1.2.3");
  assert.equal(toWindowsWixVersion("1.2.3-beta.4"), "1.2.3.4");
  assert.equal(toWindowsWixVersion("2.0.0"), "2.0.0.0");
});

test("release:mac uses the current package version when no version is passed", async () => {
  const rootDir = await createTempWorkspace();

  const result = await resolveReleaseMacVersion({
    rootDir,
    argv: ["node", "scripts/release-mac.mjs"],
  });

  assert.deepEqual(result, {
    version: "1.1.1",
    source: "package.json",
  });
});

test("release:mac prefers an explicit version argument", async () => {
  const rootDir = await createTempWorkspace();

  const result = await resolveReleaseMacVersion({
    rootDir,
    argv: ["node", "scripts/release-mac.mjs", "1.2.3"],
  });

  assert.deepEqual(result, {
    version: "1.2.3",
    source: "argument",
  });
});

test("syncReleaseVersions updates all version sources", async () => {
  const rootDir = await createTempWorkspace();

  await syncReleaseVersions({ rootDir, version: "1.2.0-beta.2" });

  const packageJson = JSON.parse(await fs.readFile(path.join(rootDir, "package.json"), "utf8"));
  const packageLock = JSON.parse(await fs.readFile(path.join(rootDir, "package-lock.json"), "utf8"));
  const tauriConfig = JSON.parse(await fs.readFile(path.join(rootDir, "src-tauri", "tauri.conf.json"), "utf8"));
  const tauriMacConfig = JSON.parse(await fs.readFile(path.join(rootDir, "src-tauri", "tauri.macos.conf.json"), "utf8"));
  const tauriWindowsConfig = JSON.parse(await fs.readFile(path.join(rootDir, "src-tauri", "tauri.windows.conf.json"), "utf8"));
  const cargoToml = await fs.readFile(path.join(rootDir, "src-tauri", "Cargo.toml"), "utf8");

  assert.equal(packageJson.version, "1.2.0-beta.2");
  assert.equal(packageLock.version, "1.2.0-beta.2");
  assert.equal(packageLock.packages[""].version, "1.2.0-beta.2");
  assert.equal(tauriConfig.version, "1.2.0-beta.2");
  assert.equal(tauriMacConfig.bundle.macOS.bundleVersion, "1.2.0");
  assert.equal(tauriWindowsConfig.bundle.windows.wix.version, "1.2.0.2");
  assert.match(cargoToml, /^version = "1.2.0-beta.2"$/m);
});

test("collectPublicReleaseArtifacts discovers built assets", async () => {
  const rootDir = await createTempWorkspace();
  const version = "1.1.1";
  const baseDir = path.join(rootDir, "src-tauri", "target", "release");

  await fs.mkdir(path.join(baseDir, "bundle", "macos"), { recursive: true });
  await fs.mkdir(path.join(baseDir, "bundle", "dmg"), { recursive: true });
  await fs.mkdir(path.join(baseDir, "portable"), { recursive: true });
  await fs.mkdir(path.join(baseDir, "bundle", "nsis"), { recursive: true });

  await fs.writeFile(path.join(baseDir, "bundle", "macos", `MAIN-${version}-macOS-unsigned-share.zip`), "zip");
  await fs.writeFile(path.join(baseDir, "bundle", "dmg", `MAIN_${version}_aarch64.dmg`), "dmg");
  await fs.writeFile(path.join(baseDir, "portable", `MAIN-${version}-windows-portable.exe`), "portable");
  await fs.writeFile(path.join(baseDir, "bundle", "nsis", `MAIN_${version}_x64-setup.exe`), "nsis");

  const artifacts = await collectPublicReleaseArtifacts({ rootDir, version });
  assert.deepEqual(
    artifacts.map((artifact) => artifact.fileName),
    [
      `MAIN-${version}-macOS-unsigned-share.zip`,
      `MAIN_${version}_aarch64.dmg`,
      `MAIN-${version}-windows-portable.exe`,
      `MAIN_${version}_x64-setup.exe`,
    ],
  );
});

test("preparePublicRelease copies assets and writes metadata", async () => {
  const rootDir = await createTempWorkspace();
  const version = "1.1.1";
  const baseDir = path.join(rootDir, "src-tauri", "target", "release");

  await fs.mkdir(path.join(baseDir, "bundle", "macos"), { recursive: true });
  await fs.mkdir(path.join(baseDir, "portable"), { recursive: true });

  await fs.writeFile(path.join(baseDir, "bundle", "macos", `MAIN-${version}-macOS-unsigned-share.zip`), "zip-content");
  await fs.writeFile(path.join(baseDir, "portable", `MAIN-${version}-windows-portable.exe`), "exe-content");

  const result = await preparePublicRelease({
    rootDir,
    version,
    publicRepo: "mstudiohub/MAIN-Releases",
  });

  const metadata = JSON.parse(await fs.readFile(result.metadataPath, "utf8"));
  const notes = await fs.readFile(result.notesPath, "utf8");
  const copiedAssetNames = (await fs.readdir(result.assetsDir)).sort();
  const stageFileNames = (await fs.readdir(result.stageDir)).sort();

  assert.equal(metadata.latestUrl, "https://github.com/mstudiohub/MAIN-Releases/releases/latest");
  assert.equal(metadata.assets.length, 2);
  assert.deepEqual(copiedAssetNames, [
    `MAIN-${version}-macOS-unsigned-share.zip`,
    `MAIN-${version}-windows-portable.exe`,
  ]);
  assert.deepEqual(stageFileNames, ["assets", "release-metadata.json", "release-notes.md", "website-links.json"]);
  assert.doesNotMatch(notes, /SHA256SUMS/);
  assert.match(notes, /gh release create v1\.1\.1/);
});

test("writeUpdaterManifest writes local updater entries and preserves existing platforms", async () => {
  const rootDir = await createTempWorkspace();
  const version = "1.1.1";
  const assetsDir = path.join(rootDir, "release-assets");
  const notesPath = path.join(assetsDir, "release-notes.md");
  const existingManifestPath = path.join(rootDir, "existing-latest.json");

  await fs.mkdir(assetsDir, { recursive: true });
  await fs.writeFile(notesPath, "# MAIN 1.1.1\n");
  await fs.writeFile(path.join(assetsDir, `MAIN_${version}_updater_darwin_aarch64.app.tar.gz`), "mac-updater");
  await fs.writeFile(path.join(assetsDir, `MAIN_${version}_updater_darwin_aarch64.app.tar.gz.sig`), "mac-signature\n");
  await fs.writeFile(
    existingManifestPath,
    `${JSON.stringify(
      {
        version,
        notes: "old notes",
        pub_date: "2026-01-01T00:00:00Z",
        platforms: {
          "windows-x86_64": {
            signature: "windows-signature",
            url: `https://github.com/mstudiohub/MAIN-UpdateFeed/releases/download/v${version}/MAIN_${version}_updater_windows_x86_64.exe`,
          },
          "windows-x86_64-nsis": {
            signature: "windows-signature",
            url: `https://github.com/mstudiohub/MAIN-UpdateFeed/releases/download/v${version}/MAIN_${version}_updater_windows_x86_64.exe`,
          },
        },
      },
      null,
      2,
    )}\n`,
  );

  const result = await writeUpdaterManifest({
    rootDir,
    assetsDir,
    version,
    updateRepo: "mstudiohub/MAIN-UpdateFeed",
    notesPath,
    existingManifestPath,
    generatedAt: new Date("2026-05-17T00:00:00Z"),
  });

  const manifest = JSON.parse(await fs.readFile(result.outputPath, "utf8"));

  assert.deepEqual(result.discoveredPlatformIds, ["darwin-aarch64"]);
  assert.equal(manifest.version, version);
  assert.equal(manifest.pub_date, "2026-05-17T00:00:00Z");
  assert.equal(manifest.notes, "# MAIN 1.1.1\n");
  assert.equal(manifest.platforms["darwin-aarch64"].signature, "mac-signature");
  assert.equal(manifest.platforms["darwin-aarch64-app"].signature, "mac-signature");
  assert.equal(manifest.platforms["windows-x86_64"].signature, "windows-signature");
  assert.match(
    manifest.platforms["darwin-aarch64"].url,
    /https:\/\/github\.com\/mstudiohub\/MAIN-UpdateFeed\/releases\/download\/v1\.1\.1\/MAIN_1\.1\.1_updater_darwin_aarch64\.app\.tar\.gz/,
  );
});

test("writeUpdaterManifest can preserve existing notes for asset-only platform uploads", async () => {
  const rootDir = await createTempWorkspace();
  const version = "1.1.1";
  const assetsDir = path.join(rootDir, "release-assets");
  const notesPath = path.join(assetsDir, "release_notes.md");
  const existingManifestPath = path.join(rootDir, "existing-latest.json");

  await fs.mkdir(assetsDir, { recursive: true });
  await fs.writeFile(notesPath, "# Windows upload notes\n");
  await fs.writeFile(path.join(assetsDir, `MAIN_${version}_updater_windows_x86_64.exe`), "windows-updater");
  await fs.writeFile(path.join(assetsDir, `MAIN_${version}_updater_windows_x86_64.exe.sig`), "windows-signature\n");
  await fs.writeFile(
    existingManifestPath,
    `${JSON.stringify(
      {
        version,
        notes: "# Mac release notes\n",
        pub_date: "2026-01-01T00:00:00Z",
        platforms: {
          "darwin-aarch64": {
            signature: "mac-signature",
            url: `https://github.com/mstudiohub/MAIN-UpdateFeed/releases/download/v${version}/MAIN_${version}_updater_darwin_aarch64.app.tar.gz`,
          },
        },
      },
      null,
      2,
    )}\n`,
  );

  const result = await writeUpdaterManifest({
    rootDir,
    assetsDir,
    version,
    updateRepo: "mstudiohub/MAIN-UpdateFeed",
    notesPath,
    existingManifestPath,
    preserveExistingNotes: true,
  });

  const manifest = JSON.parse(await fs.readFile(result.outputPath, "utf8"));

  assert.equal(manifest.notes, "# Mac release notes\n");
  assert.equal(manifest.platforms["darwin-aarch64"].signature, "mac-signature");
  assert.equal(manifest.platforms["windows-x86_64"].signature, "windows-signature");
  assert.equal(manifest.platforms["windows-x86_64-nsis"].signature, "windows-signature");
});

async function writeArchivedNotes(rootDir, version, text) {
  const directory = path.join(rootDir, "docs", "releases");
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, `Release_Notes_${version}_ZH.md`), text, "utf8");
}

async function writePublicArtifact(rootDir, version) {
  const directory = path.join(rootDir, "src-tauri", "target", "release", "portable");
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, `MAIN-${version}-windows-portable.exe`), "portable");
}

async function writeWindowsUpdater(assetsDir, version) {
  await fs.mkdir(assetsDir, { recursive: true });
  const updaterPath = path.join(assetsDir, `MAIN_${version}_updater_windows_x86_64.exe`);
  await fs.writeFile(updaterPath, "windows updater bytes");
  await fs.writeFile(`${updaterPath}.sig`, "new-windows-signature\n");
}

test("public staging and a merged updater publish the same exact authored notes", async () => {
  const rootDir = await createTempWorkspace();
  const version = "1.2.3";
  const authored = "# MAIN 1.2.3\r\n\r\n修复与功能说明。  \r\n\r\n";
  await writeArchivedNotes(rootDir, version, authored);
  await writeArchivedNotes(rootDir, "1.2.2", "WRONG_VERSION_NOTES");
  await writePublicArtifact(rootDir, version);
  const staged = await preparePublicRelease({ rootDir, version, publicRepo: "owner/releases" });
  assert.equal(await fs.readFile(staged.notesPath, "utf8"), authored);
  await writeWindowsUpdater(staged.assetsDir, version);
  const existingManifestPath = path.join(rootDir, "existing.json");
  const preservedMac = { signature: "preserved-mac-signature", url: "https://example.invalid/mac.tar.gz" };
  await fs.writeFile(existingManifestPath, JSON.stringify({ version, notes: "OLD_INCORRECT_NOTES", platforms: {
    "darwin-aarch64": preservedMac, "darwin-aarch64-app": preservedMac,
  } }));
  await fs.writeFile(staged.notesPath, "STALE_STAGED_NOTES");
  const result = await writeUpdaterManifest({ rootDir, assetsDir: staged.assetsDir, version,
    updateRepo: "owner/updates", notesPath: staged.notesPath, existingManifestPath, preserveExistingNotes: true });
  const manifest = JSON.parse(await fs.readFile(result.outputPath, "utf8"));
  assert.equal(manifest.notes, authored, "an asset-only Windows merge cannot preserve incorrect notes over the archive");
  assert.equal(await fs.readFile(staged.notesPath, "utf8"), authored);
  assert.deepEqual(manifest.platforms["darwin-aarch64"], preservedMac);
  assert.deepEqual(manifest.platforms["darwin-aarch64-app"], preservedMac);
  assert.equal(manifest.platforms["windows-x86_64"].signature, "new-windows-signature");
  assert.deepEqual(manifest.platforms["windows-x86_64-nsis"], manifest.platforms["windows-x86_64"]);
  assert.doesNotMatch(JSON.stringify(manifest), /WRONG_VERSION_NOTES|OLD_INCORRECT_NOTES|STALE_STAGED_NOTES/);
});

test("an empty authored archive rejects staging and manifest generation without replacing prior outputs", async () => {
  for (const authored of ["", " \r\n\t\n"]) {
    const rootDir = await createTempWorkspace();
    const version = "1.1.1";
    await writeArchivedNotes(rootDir, version, authored);
    await writePublicArtifact(rootDir, version);
    const stageDir = path.join(rootDir, "release-output", "public", `v${version}`);
    await fs.mkdir(stageDir, { recursive: true });
    const sentinel = path.join(stageDir, "previous-output.txt");
    await fs.writeFile(sentinel, "previous output");
    await assert.rejects(preparePublicRelease({ rootDir, version, publicRepo: "owner/releases" }), /empty.*release notes|release notes.*empty/i);
    assert.equal(await fs.readFile(sentinel, "utf8"), "previous output");
    const assetsDir = path.join(rootDir, "release-assets");
    await writeWindowsUpdater(assetsDir, version);
    const notesPath = path.join(assetsDir, "release_notes.md");
    await fs.writeFile(notesPath, "previous notes");
    await assert.rejects(writeUpdaterManifest({ rootDir, assetsDir, version, updateRepo: "owner/updates", notesPath }), /empty.*release notes|release notes.*empty/i);
    assert.equal(await fs.readFile(notesPath, "utf8"), "previous notes");
    await assert.rejects(fs.access(path.join(assetsDir, "latest.json")), { code: "ENOENT" });
  }
});

test("release notes cannot read a different version or accept path-shaped versions", async () => {
  const rootDir = await createTempWorkspace();
  await writeArchivedNotes(rootDir, "1.1.0", "WRONG_ARCHIVE");
  await writePublicArtifact(rootDir, "1.1.1");
  const staged = await preparePublicRelease({ rootDir, version: "1.1.1", publicRepo: "owner/releases" });
  const notes = await fs.readFile(staged.notesPath, "utf8");
  assert.match(notes, /MAIN 1\.1\.1/);
  assert.match(notes, /TODO: summarize/);
  assert.doesNotMatch(notes, /WRONG_ARCHIVE/);
  await writeWindowsUpdater(staged.assetsDir, "1.1.1");
  for (const version of ["../1.1.0", "1.1.1/../../outside", ""]) {
    await assert.rejects(preparePublicRelease({ rootDir, version, publicRepo: "owner/releases" }), /Unsupported app version/);
    await assert.rejects(writeUpdaterManifest({ rootDir, assetsDir: staged.assetsDir, version, updateRepo: "owner/updates", notesPath: staged.notesPath }), /Unsupported app version/);
  }
});

test("an updater merge cannot import another version's notes or platform signatures", async () => {
  const rootDir = await createTempWorkspace();
  const version = "1.1.1";
  const authored = "# MAIN 1.1.1\nExact current release notes.\n";
  await writeArchivedNotes(rootDir, version, authored);
  const assetsDir = path.join(rootDir, "release-assets");
  await writeWindowsUpdater(assetsDir, version);
  const notesPath = path.join(assetsDir, "release_notes.md");
  await fs.writeFile(notesPath, "outdated generated notes");
  const existingManifestPath = path.join(rootDir, "existing.json");
  await fs.writeFile(existingManifestPath, JSON.stringify({ version: "1.1.0", notes: "WRONG_VERSION_NOTES",
    platforms: { "darwin-aarch64": { signature: "WRONG_VERSION_SIGNATURE", url: "https://example.invalid/old" } } }));
  const result = await writeUpdaterManifest({ rootDir, assetsDir, version, updateRepo: "owner/updates",
    notesPath, existingManifestPath, preserveExistingNotes: true });
  const manifest = JSON.parse(await fs.readFile(result.outputPath, "utf8"));
  assert.equal(manifest.notes, authored);
  assert.deepEqual(Object.keys(manifest.platforms).sort(), ["windows-x86_64", "windows-x86_64-nsis"]);
  assert.doesNotMatch(JSON.stringify(manifest), /WRONG_VERSION/);
});

test("local release generation and its updater use exact authored notes without reading git history", async () => {
  const rootDir = await createTempWorkspace();
  const version = "1.1.1";
  const authored = "# MAIN 1.1.1\r\n\r\n完整发布说明。  \r\n\r\n";
  await writeArchivedNotes(rootDir, version, authored);
  const assetsDir = path.join(rootDir, "release-assets");
  await writeWindowsUpdater(assetsDir, version);
  const notesPath = path.join(assetsDir, "release_notes.md");
  assert.deepEqual(await writeReleaseNotes({ rootDir, version, outputPath: notesPath }), { authored: true });
  assert.equal(await fs.readFile(notesPath, "utf8"), authored);
  const result = await writeUpdaterManifest({ rootDir, assetsDir, version, updateRepo: "owner/updates", notesPath });
  assert.equal(JSON.parse(await fs.readFile(result.outputPath, "utf8")).notes, authored);
});

test("local release fallback remains version-specific and a blank archive never falls back", async () => {
  const rootDir = await createTempWorkspace();
  const version = "1.1.1";
  const notesPath = path.join(rootDir, "release_notes.md");
  await writeArchivedNotes(rootDir, "1.1.0", "WRONG_VERSION_NOTES");
  execFileSync("git", ["init", "-q"], { cwd: rootDir });
  execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
    "commit", "--allow-empty", "-qm", "Fallback release fixture change"], { cwd: rootDir });
  assert.deepEqual(await writeReleaseNotes({ rootDir, version, outputPath: notesPath }), { authored: false });
  const fallback = await fs.readFile(notesPath, "utf8");
  assert.match(fallback, /MAIN 1\.1\.1/);
  assert.match(fallback, /Fallback release fixture change/);
  assert.doesNotMatch(fallback, /WRONG_VERSION_NOTES/);
  await writeArchivedNotes(rootDir, version, " \n\t");
  await assert.rejects(writeReleaseNotes({ rootDir, version, outputPath: notesPath }), /Empty authored release notes/);
  assert.equal(await fs.readFile(notesPath, "utf8"), fallback);
  await assert.rejects(writeReleaseNotes({ rootDir, version: "../../outside", outputPath: notesPath }), /Unsupported app version/);
});

test("desktop Actions generation preserves the same canonical notes in its actual updater manifest", async () => {
  const workflow = YAML.parse(await fs.readFile(new URL("../../.github/workflows/build-desktop.yml", import.meta.url), "utf8"));
  const steps = Object.values(workflow.jobs).flatMap((job) => job.steps);
  const notesStep = steps.find((step) => step.name === "Generate release notes");
  const manifestStep = steps.find((step) => step.name === "Generate updater manifest");
  const rootDir = await createTempWorkspace();
  const version = "1.1.1";
  const authored = "# MAIN 1.1.1\r\n\r\n完整 Actions 说明。  \r\n\r\n";
  await writeArchivedNotes(rootDir, version, authored);
  await writeArchivedNotes(rootDir, "1.1.0", "WRONG_VERSION_NOTES");
  await fs.mkdir(path.join(rootDir, "scripts"), { recursive: true });
  await fs.copyFile(new URL("../../scripts/release_tools.mjs", import.meta.url), path.join(rootDir, "scripts", "release_tools.mjs"));
  const assetsDir = path.join(rootDir, "release-assets");
  await writeWindowsUpdater(assetsDir, version);
  for (const architecture of ["x86_64", "aarch64"]) {
    const file = path.join(assetsDir, `MAIN_${version}_updater_darwin_${architecture}.app.tar.gz`);
    await fs.writeFile(file, `${architecture} bytes`);
    await fs.writeFile(`${file}.sig`, `${architecture}-signature\n`);
  }
  const options = { cwd: rootDir, env: { ...process.env, VERSION: version, APP_NAME: "MAIN", UPDATE_REPO: "owner/updates" }, stdio: "pipe" };
  execFileSync("bash", ["-c", notesStep.run], options);
  const notesPath = path.join(assetsDir, "release_notes.md");
  assert.equal(await fs.readFile(notesPath, "utf8"), authored);
  execFileSync("bash", ["-c", manifestStep.run], options);
  const manifest = JSON.parse(await fs.readFile(path.join(assetsDir, "latest.json"), "utf8"));
  assert.equal(manifest.notes, authored);
  assert.equal(manifest.platforms["darwin-aarch64"].signature, "aarch64-signature");
  assert.equal(manifest.platforms["darwin-x86_64"].signature, "x86_64-signature");
  assert.equal(manifest.platforms["windows-x86_64"].signature, "new-windows-signature");
  await writeArchivedNotes(rootDir, version, " \n\t");
  assert.throws(() => execFileSync("bash", ["-c", notesStep.run], options));
  assert.equal(await fs.readFile(notesPath, "utf8"), authored);
  assert.throws(() => execFileSync("bash", ["-c", notesStep.run], { ...options, env: { ...options.env, VERSION: "../../outside" } }));
});
