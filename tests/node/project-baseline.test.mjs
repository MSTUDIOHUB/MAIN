import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";

const workspaceRoot = process.cwd();
const moduleCache = new Map();

function loadTs(sourcePath) {
  const normalized = path.resolve(sourcePath);
  if (moduleCache.has(normalized)) return moduleCache.get(normalized);
  const source = fs.readFileSync(normalized, "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    fileName: normalized,
  }).outputText;
  const localRequire = createRequire(normalized);
  const loaded = { exports: {} };
  moduleCache.set(normalized, loaded.exports);
  const runtimeRequire = (specifier) => {
    if (specifier.startsWith(".")) {
      const base = path.resolve(path.dirname(normalized), specifier);
      for (const candidate of [base, `${base}.ts`, path.join(base, "index.ts")]) {
        if (fs.existsSync(candidate) && candidate.endsWith(".ts")) return loadTs(candidate);
      }
    }
    return localRequire(specifier);
  };
  new Function("exports", "module", "require", output)(loaded.exports, loaded, runtimeRequire);
  moduleCache.set(normalized, loaded.exports);
  return loaded.exports;
}

const baseline = loadTs(path.join(workspaceRoot, "src/lib/projectBaseline.ts"));

function normalize(input) {
  return String(input || "").replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
}

function createMemoryIo(inputFiles, options = {}) {
  const files = new Map(
    Object.entries(inputFiles).map(([filePath, content]) => [normalize(filePath), String(content)]),
  );
  const directoryPaths = new Set([""]);
  for (const filePath of files.keys()) {
    const parts = filePath.split("/");
    for (let index = 1; index < parts.length; index += 1) {
      directoryPaths.add(parts.slice(0, index).join("/"));
    }
  }
  for (const directoryPath of options.directories || []) {
    directoryPaths.add(normalize(directoryPath));
  }
  const symlinks = new Set((options.symlinks || []).map(normalize));
  const reads = [];

  return {
    reads,
    async canonicalizeWorkspace(workspace) {
      return normalize(workspace) || "/fixture/repo";
    },
    async resolveVcsRoot() {
      return options.vcsRoot === undefined ? "/fixture/repo" : options.vcsRoot;
    },
    async getFileByteSize({ path: filePath }) {
      const normalized = normalize(filePath);
      if (!files.has(normalized)) throw new Error("not found");
      return new TextEncoder().encode(files.get(normalized)).byteLength;
    },
    async listDirectory({ path: directoryPath }) {
      const parent = normalize(directoryPath);
      const prefix = parent ? `${parent}/` : "";
      const names = new Map();
      for (const candidate of directoryPaths) {
        if (!candidate.startsWith(prefix) || candidate === parent) continue;
        const remainder = candidate.slice(prefix.length);
        if (!remainder || remainder.includes("/")) continue;
        names.set(remainder, { name: remainder, kind: symlinks.has(`${prefix}${remainder}`) ? "symlink" : "directory" });
      }
      for (const candidate of files.keys()) {
        if (!candidate.startsWith(prefix)) continue;
        const remainder = candidate.slice(prefix.length);
        if (!remainder || remainder.includes("/")) continue;
        names.set(remainder, { name: remainder, kind: symlinks.has(`${prefix}${remainder}`) ? "symlink" : "file" });
      }
      const entries = [...names.values()];
      return options.reverseListings ? entries.reverse() : entries;
    },
    async readFile({ path: filePath }) {
      const normalized = normalize(filePath);
      reads.push(normalized);
      if (!files.has(normalized)) throw new Error("not found");
      return files.get(normalized);
    },
  };
}

const packageManifest = JSON.stringify({
  name: "fixture-project",
  packageManager: "pnpm@9.15.0",
  engines: { node: ">=20" },
  scripts: {
    test: "TOKEN=must-not-leak node --test",
    build: "vite build",
    lint: "tsc --noEmit",
  },
});

const fixtureFiles = {
  "package.json": packageManifest,
  "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
  "tsconfig.json": "{\"compilerOptions\":{\"strict\":true}}\n",
  ".gitignore": "node_modules\n.env\ndist\n",
  "AGENTS.md": "Run tests before reporting completion.\n",
  ".github/copilot-instructions.md": "Keep changes focused.\n",
  ".MAIN/rules/project.md": "---\npaths: [src/**]\n---\nUse strict TypeScript.\n",
  "src/index.ts": "export const current = 1;\n",
  "src/lib/value.ts": "export const value = 2;\n",
  "docs/guide.md": "# Guide\n",
  "node_modules/pkg/index.js": "generated\n",
  "dist/bundle.js": "generated\n",
  ".env": "TOP_SECRET=must-not-leak\n",
  ".ssh/id_ed25519": "must-not-leak\n",
};

test("baseline is deterministic, bounded, provenance-rich, and contains no secret or script body", async () => {
  const firstIo = createMemoryIo(fixtureFiles, {
    directories: [".git", "empty", "src/components"],
  });
  const secondIo = createMemoryIo(fixtureFiles, {
    directories: [".git", "empty", "src/components"],
    reverseListings: true,
  });

  const first = await baseline.buildProjectBaselineContext({
    workspace: "/fixture/repo/",
    io: firstIo,
  });
  const second = await baseline.buildProjectBaselineContext({
    workspace: "/fixture/repo",
    io: secondIo,
  });

  assert.deepEqual(first, second, "filesystem enumeration order cannot affect the baseline");
  assert.equal(first.kind, "project_baseline_context");
  assert.equal(first.schemaVersion, baseline.PROJECT_BASELINE_SCHEMA_VERSION);
  assert.equal(first.parserVersion, baseline.PROJECT_BASELINE_PARSER_VERSION);
  assert.equal(first.workspace.canonicalPath, "/fixture/repo");
  assert.match(first.workspace.identity, /^project-workspace-sha256-[a-f0-9]{64}$/);
  assert.equal(first.workspace.vcs?.kind, "git");
  assert.equal(first.workspace.vcs?.canonicalRoot, "/fixture/repo");
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.anchors), true);
  assert.equal(Object.isFrozen(first.facts.scripts), true);
  assert.equal(Object.isFrozen(first.limits), true);

  assert.deepEqual(first.anchors.map((anchor) => anchor.path), [
    ".MAIN/rules/project.md",
    ".github/copilot-instructions.md",
    ".gitignore",
    "AGENTS.md",
    "package.json",
    "pnpm-lock.yaml",
    "tsconfig.json",
  ]);
  assert.ok(first.anchors.every((anchor) => /^sha256-[a-f0-9]{64}$/.test(anchor.contentHash)));
  assert.ok(first.anchors.every((anchor) => anchor.byteSize > 0));

  assert.deepEqual(first.facts.scripts.map((script) => script.name), ["build", "lint", "test"]);
  assert.deepEqual(first.facts.scripts.map((script) => script.invocation), [
    "pnpm run build",
    "pnpm run lint",
    "pnpm run test",
  ]);
  assert.ok(first.facts.scripts.every((script) => script.provenance.path === "package.json"));
  assert.ok(first.facts.languages.some((fact) => fact.name === "TypeScript"));
  assert.ok(first.facts.packageManagers.some((fact) => fact.name === "pnpm"));
  assert.ok(first.facts.runtimes.some((fact) => fact.name === "node" && fact.constraint === ">=20"));

  const serialized = JSON.stringify(first);
  assert.doesNotMatch(serialized, /must-not-leak|TOP_SECRET|TOKEN=/);
  assert.doesNotMatch(serialized, /generatedAt|mtime/i);
  assert.doesNotMatch(serialized, /node_modules|dist\/bundle|\.env|\.ssh/);
  assert.ok(first.topology.some((entry) => entry.path === "src/lib" && entry.kind === "directory"));
  assert.match(first.fingerprints.overall, /^project-baseline-sha256-[a-f0-9]{64}$/);
});

test("ordinary source edits remain fresh while anchor or shallow-topology changes become stale", async () => {
  const original = await baseline.buildProjectBaselineContext({
    workspace: "/fixture/repo",
    io: createMemoryIo(fixtureFiles),
  });
  const sourceEdited = await baseline.buildProjectBaselineContext({
    workspace: "/fixture/repo",
    io: createMemoryIo({ ...fixtureFiles, "src/index.ts": "export const current = 99;\n" }),
  });
  assert.deepEqual(baseline.compareProjectBaselineContexts(original, sourceEdited), {
    status: "fresh",
    reasons: [],
    previousFingerprint: original.fingerprints.overall,
    currentFingerprint: sourceEdited.fingerprints.overall,
  });
  assert.equal(baseline.isProjectBaselineFresh(original, sourceEdited), true);

  const manifestEdited = await baseline.buildProjectBaselineContext({
    workspace: "/fixture/repo",
    io: createMemoryIo({ ...fixtureFiles, "package.json": packageManifest.replace("vite build", "vite build --mode production") }),
  });
  const anchorComparison = baseline.compareProjectBaselineContexts(original, manifestEdited);
  assert.equal(anchorComparison.status, "stale");
  assert.deepEqual(anchorComparison.reasons, ["anchors", "facts"]);

  const topologyEdited = await baseline.buildProjectBaselineContext({
    workspace: "/fixture/repo",
    io: createMemoryIo({ ...fixtureFiles, "src/new-file.ts": "export {};\n" }),
  });
  const topologyComparison = baseline.compareProjectBaselineContexts(original, topologyEdited);
  assert.equal(topologyComparison.status, "stale");
  assert.ok(topologyComparison.reasons.includes("topology"));
});

test("secret paths, ignored trees, unsafe directory names, and symlinks are never read or traversed", async () => {
  const io = createMemoryIo({
    "package.json": packageManifest,
    ".env.production": "SECRET=hidden\n",
    ".npmrc": "//registry/:_authToken=hidden\n",
    "node_modules/pkg/package.json": "{\"name\":\"ignored\"}",
    "linked/package.json": "{\"name\":\"linked\"}",
  }, {
    directories: ["node_modules", "linked"],
    symlinks: ["linked"],
  });
  const originalListDirectory = io.listDirectory;
  io.listDirectory = async (input) => {
    const entries = await originalListDirectory(input);
    return input.path === "" ? [...entries, { name: "../escape", kind: "directory" }, { name: "bad/name", kind: "file" }] : entries;
  };

  const result = await baseline.buildProjectBaselineContext({ workspace: "/fixture/repo", io });
  assert.ok(io.reads.includes("package.json"));
  assert.ok(!io.reads.some((entry) => entry.includes(".env") || entry.includes(".npmrc") || entry.includes("linked/")));
  assert.ok(!result.topology.some((entry) => /node_modules|linked|escape|bad/.test(entry.path)));
  assert.ok(result.omissions.some((entry) => entry.reason === "unsafe_entry"));
});

test("limits produce deterministic omissions instead of oversized context", async () => {
  const io = createMemoryIo({
    "package.json": packageManifest,
    "AGENTS.md": "x".repeat(200),
    "src/a.ts": "a",
    "src/b.ts": "b",
    "src/c.ts": "c",
  });
  const result = await baseline.buildProjectBaselineContext({
    workspace: "/fixture/repo",
    io,
    limits: {
      maxAnchorBytes: 100,
      maxTotalAnchorBytes: 120,
      maxAnchors: 2,
      maxTopologyEntries: 2,
      maxDirectoryEntries: 10,
      maxTopologyDepth: 2,
      maxScripts: 2,
      maxPathLength: 128,
    },
  });

  assert.ok(result.omissions.some((entry) => entry.path === "package.json" && entry.reason === "anchor_too_large"));
  assert.ok(result.omissions.some((entry) => entry.path === "AGENTS.md" && entry.reason === "anchor_too_large"));
  assert.ok(!io.reads.includes("package.json"), "oversized anchors are rejected before content read");
  assert.ok(!io.reads.includes("AGENTS.md"), "oversized rule files are rejected before content read");
  assert.equal(result.topology.length, 2);
  assert.equal(result.truncated.topology, true);
  assert.deepEqual(result.facts.scripts, [], "an omitted manifest cannot create unproven facts");
});

test("invalid manifests stay anchors but emit stable parser diagnostics", async () => {
  const io = createMemoryIo({ "package.json": "{ invalid json", "src/main.js": "export {};\n" });
  const result = await baseline.buildProjectBaselineContext({ workspace: "/fixture/repo", io });
  assert.equal(result.anchors[0]?.path, "package.json");
  assert.deepEqual(result.diagnostics, [{ code: "manifest_parse_failed", path: "package.json" }]);
  assert.deepEqual(result.facts.scripts, []);
});

test("missing prior baselines and workspace/parser identity changes are explicitly stale", async () => {
  const current = await baseline.buildProjectBaselineContext({
    workspace: "/fixture/repo",
    io: createMemoryIo({ "go.mod": "module example.test/repo\n\ngo 1.23\n", "go.sum": "sum\n" }),
  });
  assert.deepEqual(baseline.compareProjectBaselineContexts(null, current).reasons, ["missing_previous"]);
  assert.equal(baseline.isProjectBaselineFresh(null, current), false);
  assert.ok(current.facts.languages.some((fact) => fact.name === "Go"));
  assert.ok(current.facts.packageManagers.some((fact) => fact.name === "go_modules"));
  assert.ok(current.facts.runtimes.some((fact) => fact.name === "go" && fact.constraint === "1.23"));

  const moved = structuredClone(current);
  moved.workspace.identity = "project-workspace-sha256-moved";
  moved.parserVersion += 1;
  const comparison = baseline.compareProjectBaselineContexts(moved, current);
  assert.equal(comparison.status, "stale");
  assert.deepEqual(comparison.reasons, ["parser_version", "workspace_identity"]);
});

test("the injected canonicalizer must prove an absolute workspace identity", async () => {
  const io = createMemoryIo({});
  io.canonicalizeWorkspace = async () => "relative/workspace";
  await assert.rejects(
    baseline.buildProjectBaselineContext({ workspace: "relative", io }),
    /PROJECT_BASELINE_INVALID_WORKSPACE/,
  );
});
