import fs from "node:fs/promises";
import path from "node:path";

export const APP_NAME = "MAIN";

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function parseAppVersion(version) {
  const normalized = String(version || "").trim();
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(normalized);

  if (!match) {
    throw new Error(`Unsupported app version: ${version}`);
  }

  const prerelease = match[4] || "";
  const prereleaseNumberMatch = prerelease.match(/(?:^|[.-])(\d+)(?:$|[.-])/);

  return {
    raw: normalized,
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease,
    prereleaseNumber: prereleaseNumberMatch ? Number(prereleaseNumberMatch[1]) : prerelease ? 1 : 0,
  };
}

export function toMacBundleVersion(version) {
  const { major, minor, patch } = parseAppVersion(version);
  return `${major}.${minor}.${patch}`;
}

export function toWindowsWixVersion(version) {
  const { major, minor, patch, prerelease, prereleaseNumber } = parseAppVersion(version);
  return `${major}.${minor}.${patch}.${prerelease ? prereleaseNumber : 0}`;
}

async function readJson(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  return JSON.parse(raw);
}

async function writeJson(filePath, value) {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function updateCargoTomlVersion(filePath, version) {
  const raw = await fs.readFile(filePath, "utf8");
  const lines = raw.split("\n");
  let inPackageSection = false;
  let updated = false;

  const nextLines = lines.map((line) => {
    if (/^\s*\[package\]\s*$/.test(line)) {
      inPackageSection = true;
      return line;
    }

    if (/^\s*\[.+\]\s*$/.test(line)) {
      inPackageSection = false;
      return line;
    }

    if (inPackageSection && /^version\s*=\s*".*"\s*$/.test(line) && !updated) {
      updated = true;
      return `version = "${version}"`;
    }

    return line;
  });

  if (!updated) {
    throw new Error(`Could not update package version in ${filePath}`);
  }

  await fs.writeFile(filePath, nextLines.join("\n"), "utf8");
}

export async function syncReleaseVersions({ rootDir, version }) {
  const packageJsonPath = path.join(rootDir, "package.json");
  const packageLockPath = path.join(rootDir, "package-lock.json");
  const tauriConfigPath = path.join(rootDir, "src-tauri", "tauri.conf.json");
  const tauriMacConfigPath = path.join(rootDir, "src-tauri", "tauri.macos.conf.json");
  const tauriWindowsConfigPath = path.join(rootDir, "src-tauri", "tauri.windows.conf.json");
  const cargoTomlPath = path.join(rootDir, "src-tauri", "Cargo.toml");

  const packageJson = await readJson(packageJsonPath);
  const packageLock = await readJson(packageLockPath);
  const tauriConfig = await readJson(tauriConfigPath);
  const tauriMacConfig = await readJson(tauriMacConfigPath);
  const tauriWindowsConfig = await readJson(tauriWindowsConfigPath);

  packageJson.version = version;
  packageLock.version = version;
  if (packageLock.packages?.[""]) {
    packageLock.packages[""].version = version;
  }
  tauriConfig.version = version;
  tauriMacConfig.bundle = tauriMacConfig.bundle || {};
  tauriMacConfig.bundle.macOS = tauriMacConfig.bundle.macOS || {};
  tauriMacConfig.bundle.macOS.bundleVersion = toMacBundleVersion(version);
  tauriWindowsConfig.bundle = tauriWindowsConfig.bundle || {};
  tauriWindowsConfig.bundle.windows = tauriWindowsConfig.bundle.windows || {};
  tauriWindowsConfig.bundle.windows.wix = tauriWindowsConfig.bundle.windows.wix || {};
  tauriWindowsConfig.bundle.windows.wix.version = toWindowsWixVersion(version);

  await Promise.all([
    writeJson(packageJsonPath, packageJson),
    writeJson(packageLockPath, packageLock),
    writeJson(tauriConfigPath, tauriConfig),
    writeJson(tauriMacConfigPath, tauriMacConfig),
    writeJson(tauriWindowsConfigPath, tauriWindowsConfig),
    updateCargoTomlVersion(cargoTomlPath, version),
  ]);

  return {
    version,
    macBundleVersion: tauriMacConfig.bundle.macOS.bundleVersion,
    windowsWixVersion: tauriWindowsConfig.bundle.windows.wix.version,
  };
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function findMatchesInDirectory(directoryPath, regex) {
  if (!(await pathExists(directoryPath))) {
    return [];
  }

  const entries = await fs.readdir(directoryPath, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && regex.test(entry.name))
    .map((entry) => path.join(directoryPath, entry.name))
    .sort((left, right) => left.localeCompare(right));
}

export async function collectPublicReleaseArtifacts({ rootDir, version, appName = APP_NAME }) {
  const escapedVersion = escapeRegex(version);
  const specs = [
    {
      id: "mac-share-zip",
      label: "macOS unsigned share zip",
      exactPath: path.join(rootDir, "src-tauri", "target", "release", "bundle", "macos", `${appName}-${version}-macOS-unsigned-share.zip`),
    },
    {
      id: "mac-dmg",
      label: "macOS dmg",
      directoryPath: path.join(rootDir, "src-tauri", "target", "release", "bundle", "dmg"),
      regex: new RegExp(`^${escapeRegex(appName)}_${escapedVersion}_.+\\.dmg$`, "i"),
    },
    {
      id: "windows-portable",
      label: "Windows portable exe",
      exactPath: path.join(rootDir, "src-tauri", "target", "release", "portable", `${appName}-${version}-windows-portable.exe`),
    },
    {
      id: "windows-nsis",
      label: "Windows NSIS installer",
      directoryPath: path.join(rootDir, "src-tauri", "target", "release", "bundle", "nsis"),
      regex: new RegExp(`^${escapeRegex(appName)}_${escapedVersion}_.+\\.exe$`, "i"),
    },
    {
      id: "windows-msi",
      label: "Windows MSI installer",
      directoryPath: path.join(rootDir, "src-tauri", "target", "release", "bundle", "msi"),
      regex: new RegExp(`^${escapeRegex(appName)}_${escapedVersion}_.+\\.msi$`, "i"),
    },
  ];

  const artifacts = [];

  for (const spec of specs) {
    if (spec.exactPath && (await pathExists(spec.exactPath))) {
      artifacts.push({
        id: spec.id,
        label: spec.label,
        sourcePath: spec.exactPath,
        fileName: path.basename(spec.exactPath),
      });
      continue;
    }

    if (spec.directoryPath && spec.regex) {
      const matches = await findMatchesInDirectory(spec.directoryPath, spec.regex);
      matches.forEach((matchPath) => {
        artifacts.push({
          id: spec.id,
          label: spec.label,
          sourcePath: matchPath,
          fileName: path.basename(matchPath),
        });
      });
    }
  }

  return artifacts;
}

function buildReleaseNotes({ version, channel, publicRepo, repositoryUrl, latestUrl, tagUrl, assets }) {
  const assetLines = assets
    .map((asset) => `- ${asset.fileName} (${asset.label}, ${(asset.size / (1024 * 1024)).toFixed(2)} MB)`)
    .join("\n");

  return [
    `# MAIN ${version}`,
    "",
    `- Release channel: ${channel}`,
    `- Public repo: ${publicRepo}`,
    `- Latest download page: ${latestUrl}`,
    `- Versioned release page: ${tagUrl}`,
    "",
    "## Assets",
    assetLines,
    "",
    "## What's New",
    "- TODO: summarize the main changes for this release.",
    "",
    "## Rollout",
    "- Upload the generated assets to the public GitHub Release.",
    "- Keep the homepage download button pointing at the stable latest URL.",
    "- Leave the private source repository closed; only publish binaries here.",
    "",
    "## Suggested gh CLI",
    "```bash",
    `gh release create v${version} release-output/public/v${version}/assets/* --repo ${publicRepo} --title \"MAIN ${version}\" --notes-file release-output/public/v${version}/release-notes.md`,
    "```",
    "",
    `Repository: ${repositoryUrl}`,
  ].join("\n");
}

export async function preparePublicRelease({
  rootDir,
  version,
  publicRepo,
  outputDir = path.join(rootDir, "release-output", "public"),
  channel = "beta",
}) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(publicRepo || "")) {
    throw new Error(`Invalid public repo: ${publicRepo}`);
  }

  const artifacts = await collectPublicReleaseArtifacts({ rootDir, version });
  if (artifacts.length === 0) {
    throw new Error(`No release artifacts found for version ${version}`);
  }

  const stageDir = path.join(outputDir, `v${version}`);
  const assetsDir = path.join(stageDir, "assets");
  const repositoryUrl = `https://github.com/${publicRepo}`;
  const latestUrl = `${repositoryUrl}/releases/latest`;
  const tagUrl = `${repositoryUrl}/releases/tag/v${version}`;

  await fs.rm(stageDir, { recursive: true, force: true });
  await fs.mkdir(assetsDir, { recursive: true });

  const copiedAssets = [];

  for (const artifact of artifacts) {
    const destinationPath = path.join(assetsDir, artifact.fileName);
    await fs.copyFile(artifact.sourcePath, destinationPath);
    const stats = await fs.stat(destinationPath);

    copiedAssets.push({
      ...artifact,
      destinationPath,
      relativePath: path.relative(stageDir, destinationPath),
      size: stats.size,
    });
  }

  const metadata = {
    appName: APP_NAME,
    version,
    channel,
    publicRepo,
    repositoryUrl,
    latestUrl,
    tagUrl,
    generatedAt: new Date().toISOString(),
    assets: copiedAssets.map((asset) => ({
      id: asset.id,
      label: asset.label,
      fileName: asset.fileName,
      relativePath: asset.relativePath,
      size: asset.size,
    })),
  };

  const metadataPath = path.join(stageDir, "release-metadata.json");
  await fs.writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");

  const websiteLinksPath = path.join(stageDir, "website-links.json");
  await fs.writeFile(
    websiteLinksPath,
    `${JSON.stringify({ publicRepo, repositoryUrl, latestUrl, tagUrl }, null, 2)}\n`,
    "utf8",
  );

  const notesPath = path.join(stageDir, "release-notes.md");
  await fs.writeFile(
    notesPath,
    `${buildReleaseNotes({
      version,
      channel,
      publicRepo,
      repositoryUrl,
      latestUrl,
      tagUrl,
      assets: copiedAssets,
    })}\n`,
    "utf8",
  );

  return {
    version,
    publicRepo,
    stageDir,
    assetsDir,
    latestUrl,
    tagUrl,
    repositoryUrl,
    assets: copiedAssets,
    metadataPath,
    notesPath,
    websiteLinksPath,
  };
}

export const UPDATER_PLATFORM_ASSETS = [
  {
    id: "darwin-x86_64",
    fileName: ({ appName, version }) => `${appName}_${version}_updater_darwin_x86_64.app.tar.gz`,
    aliases: ["darwin-x86_64", "darwin-x86_64-app"],
  },
  {
    id: "darwin-aarch64",
    fileName: ({ appName, version }) => `${appName}_${version}_updater_darwin_aarch64.app.tar.gz`,
    aliases: ["darwin-aarch64", "darwin-aarch64-app"],
  },
  {
    id: "windows-x86_64",
    fileName: ({ appName, version }) => `${appName}_${version}_updater_windows_x86_64.exe`,
    aliases: ["windows-x86_64", "windows-x86_64-nsis"],
  },
];

function assetDownloadUrl({ updateRepo, version, fileName }) {
  return `https://github.com/${updateRepo}/releases/download/v${version}/${encodeURIComponent(fileName)}`;
}

async function readExistingManifest(existingManifestPath, version) {
  if (!existingManifestPath || !(await pathExists(existingManifestPath))) {
    return null;
  }

  const manifest = JSON.parse(await fs.readFile(existingManifestPath, "utf8"));
  if (manifest.version !== version || !manifest.platforms || typeof manifest.platforms !== "object") {
    return null;
  }

  return manifest;
}

export async function buildUpdaterManifest({
  assetsDir,
  version,
  updateRepo,
  notes,
  appName = APP_NAME,
  existingManifestPath = "",
  generatedAt = new Date(),
}) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(updateRepo || "")) {
    throw new Error(`Invalid updater repo: ${updateRepo}`);
  }

  const existingManifest = await readExistingManifest(existingManifestPath, version);
  const platforms = {
    ...(existingManifest?.platforms || {}),
  };
  const discoveredPlatformIds = [];

  for (const spec of UPDATER_PLATFORM_ASSETS) {
    const fileName = spec.fileName({ appName, version });
    const assetPath = path.join(assetsDir, fileName);

    if (!(await pathExists(assetPath))) {
      continue;
    }

    const signaturePath = `${assetPath}.sig`;
    if (!(await pathExists(signaturePath))) {
      throw new Error(`Missing updater signature: ${signaturePath}`);
    }

    const entry = {
      signature: (await fs.readFile(signaturePath, "utf8")).trim(),
      url: assetDownloadUrl({ updateRepo, version, fileName }),
    };

    spec.aliases.forEach((alias) => {
      platforms[alias] = entry;
    });
    discoveredPlatformIds.push(spec.id);
  }

  if (Object.keys(platforms).length === 0) {
    throw new Error(`No updater assets found for version ${version}`);
  }

  return {
    manifest: {
      version,
      notes,
      pub_date: generatedAt.toISOString().replace(/\.\d{3}Z$/, "Z"),
      platforms,
    },
    discoveredPlatformIds,
  };
}

export async function writeUpdaterManifest({
  assetsDir,
  version,
  updateRepo,
  notesPath,
  outputPath = path.join(assetsDir, "latest.json"),
  appName = APP_NAME,
  existingManifestPath = "",
  generatedAt,
}) {
  const notes = await fs.readFile(notesPath, "utf8");
  const result = await buildUpdaterManifest({
    assetsDir,
    version,
    updateRepo,
    notes,
    appName,
    existingManifestPath,
    generatedAt,
  });

  await fs.writeFile(outputPath, `${JSON.stringify(result.manifest, null, 2)}\n`, "utf8");

  return {
    ...result,
    outputPath,
  };
}
