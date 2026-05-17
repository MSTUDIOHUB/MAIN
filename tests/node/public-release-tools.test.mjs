import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  collectPublicReleaseArtifacts,
  preparePublicRelease,
  syncReleaseVersions,
  toMacBundleVersion,
  toWindowsWixVersion,
  writeUpdaterManifest,
} from "../../scripts/release_tools.mjs";
import { resolveReleaseMacVersion } from "../../scripts/release-mac.mjs";

async function createTempWorkspace() {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "main-release-tools-"));
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
