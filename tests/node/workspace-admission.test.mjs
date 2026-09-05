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
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
    fileName: normalized,
  }).outputText;
  const loaded = { exports: {} };
  moduleCache.set(normalized, loaded.exports);
  const localRequire = createRequire(normalized);
  const runtimeRequire = (specifier) => {
    if (specifier === "./ipc") {
      return {
        readFile: async () => {
          throw new Error("workspace admission must inject instruction reads");
        },
        globSearch: async () => {
          throw new Error("workspace admission must inject instruction globs");
        },
      };
    }
    if (specifier === "./agentSkills") {
      return {
        loadSkillCatalog: async () => Object.freeze({
          entries: Object.freeze([]),
          explicitSkillIds: Object.freeze([]),
          warnings: Object.freeze([]),
          loadedAt: 1,
        }),
      };
    }
    if (specifier.startsWith(".")) {
      const base = path.resolve(path.dirname(normalized), specifier);
      for (const candidate of [base, `${base}.ts`, path.join(base, "index.ts")]) {
        if (fs.existsSync(candidate) && candidate.endsWith(".ts")) {
          return loadTs(candidate);
        }
      }
    }
    return localRequire(specifier);
  };
  new Function("exports", "module", "require", output)(
    loaded.exports,
    loaded,
    runtimeRequire,
  );
  moduleCache.set(normalized, loaded.exports);
  return loaded.exports;
}

const admission = loadTs(
  path.join(workspaceRoot, "src/lib/workspaceAdmission.ts"),
);

function normalize(value) {
  return String(value || "")
    .replaceAll("\\", "/")
    .replace(/^\.\//, "")
    .replace(/\/$/, "");
}

function createMemoryIo(inputFiles, options = {}) {
  const files = new Map(
    Object.entries(inputFiles).map(([filePath, content]) => [
      normalize(filePath),
      String(content),
    ]),
  );
  const directories = new Set([""]);
  for (const filePath of files.keys()) {
    const parts = filePath.split("/");
    for (let index = 1; index < parts.length; index += 1) {
      directories.add(parts.slice(0, index).join("/"));
    }
  }
  for (const directory of options.directories || []) {
    directories.add(normalize(directory));
  }
  const readCounts = new Map();
  let canonicalizeCalls = 0;

  const childrenOf = (directoryPath) => {
    const parent = normalize(directoryPath);
    const prefix = parent ? `${parent}/` : "";
    const entries = new Map();
    for (const candidate of directories) {
      if (!candidate.startsWith(prefix) || candidate === parent) continue;
      const remainder = candidate.slice(prefix.length);
      if (!remainder || remainder.includes("/")) continue;
      entries.set(remainder, { name: remainder, kind: "directory" });
    }
    for (const candidate of files.keys()) {
      if (!candidate.startsWith(prefix)) continue;
      const remainder = candidate.slice(prefix.length);
      if (!remainder || remainder.includes("/")) continue;
      entries.set(remainder, { name: remainder, kind: "file" });
    }
    return [...entries.values()].reverse();
  };

  return {
    readCounts,
    get canonicalizeCalls() {
      return canonicalizeCalls;
    },
    async canonicalizeWorkspace(workspace) {
      canonicalizeCalls += 1;
      return normalize(workspace) || "/fixture/repo";
    },
    async resolveVcsRoot() {
      return "/fixture/repo";
    },
    async listDirectory(directoryPath) {
      return childrenOf(directoryPath);
    },
    async readFile(filePath) {
      const normalized = normalize(filePath);
      readCounts.set(normalized, (readCounts.get(normalized) || 0) + 1);
      if (!files.has(normalized)) throw new Error(`missing: ${normalized}`);
      return files.get(normalized);
    },
    async globSearch(pattern) {
      const normalizedPattern = normalize(pattern);
      if (normalizedPattern.endsWith("/**/*.md")) {
        const prefix = normalizedPattern.slice(0, -"**/*.md".length);
        return [...files.keys()].filter((filePath) =>
          filePath.startsWith(prefix) && filePath.endsWith(".md")
        );
      }
      if (normalizedPattern.endsWith("/*.md")) {
        const prefix = normalizedPattern.slice(0, -"*.md".length);
        return [...files.keys()].filter((filePath) => {
          if (!filePath.startsWith(prefix) || !filePath.endsWith(".md")) return false;
          return !filePath.slice(prefix.length).includes("/");
        });
      }
      return [];
    },
  };
}

const fixtureFiles = {
  "package.json": JSON.stringify({
    name: "workspace-admission-fixture",
    packageManager: "pnpm@9.15.0",
    engines: { node: ">=20" },
    scripts: {
      test: "TOKEN=must-not-render node --test",
      build: "vite build",
    },
  }),
  "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
  "AGENTS.md": "Run focused tests before reporting completion.\n",
  ".MAIN/steering/typescript.md": [
    "---",
    "inclusion: fileMatch",
    "fileMatchPattern: [\"src/**/*.ts\"]",
    "---",
    "Preserve strict TypeScript boundaries.",
  ].join("\n"),
  ".MAIN/rules/source.md": [
    "---",
    "paths: [src/**]",
    "---",
    "Keep source edits focused.",
  ].join("\n"),
  "src/main.ts": "export const value = 1;\n",
};

async function buildFixtureSnapshot() {
  const io = createMemoryIo(fixtureFiles, { directories: [".git"] });
  const snapshot = await admission.resolveWorkspaceAdmissionSnapshot({
    workspace: "/fixture/repo/",
    skills: [],
    associatedPaths: ["src/main.ts"],
    userPrompt: "Repair src/main.ts",
    io,
  });
  return { io, snapshot };
}

test("production IO composition shares baseline reads without importing Store state", async () => {
  const calls = [];
  const io = admission.createWorkspaceAdmissionIo({
    baselineIo: {
      async canonicalizeWorkspace(workspace) {
        calls.push(["canonicalize", workspace]);
        return "/repo";
      },
      async resolveVcsRoot(workspace) {
        calls.push(["vcs", workspace]);
        return "/repo";
      },
      async listDirectory(input) {
        calls.push(["list", input]);
        return [];
      },
      async readFile(input) {
        calls.push(["read", input]);
        return "source";
      },
    },
    async globSearch(pattern, workspace) {
      calls.push(["glob", { pattern, workspace }]);
      return [];
    },
  });

  assert.equal(await io.canonicalizeWorkspace("/repo/"), "/repo");
  assert.equal(await io.resolveVcsRoot("/repo"), "/repo");
  assert.deepEqual(await io.listDirectory("src", "/repo"), []);
  assert.equal(await io.readFile("AGENTS.md", "/repo"), "source");
  assert.deepEqual(await io.globSearch(".MAIN/rules/*.md", "/repo"), []);
  assert.deepEqual(calls, [
    ["canonicalize", "/repo/"],
    ["vcs", "/repo"],
    ["list", { path: "src", workspace: "/repo" }],
    ["read", { path: "AGENTS.md", workspace: "/repo" }],
    ["glob", { pattern: ".MAIN/rules/*.md", workspace: "/repo" }],
  ]);
  assert.equal(Object.isFrozen(io), true);
});

test("workspace admission shares exact raw reads and freezes one instruction/baseline snapshot", async () => {
  const { io, snapshot } = await buildFixtureSnapshot();

  assert.equal(snapshot.canonicalWorkspace, "/fixture/repo");
  assert.ok(snapshot.instructions);
  assert.ok(snapshot.baseline);
  assert.deepEqual(snapshot.warnings, []);
  assert.equal(io.canonicalizeCalls, 1, "canonical workspace identity is captured once");
  assert.equal(io.readCounts.get("AGENTS.md"), 1);
  assert.equal(io.readCounts.get(".MAIN/steering/typescript.md"), 1);
  assert.equal(io.readCounts.get(".MAIN/rules/source.md"), 1);

  const baselineRuleHashes = new Map(
    snapshot.baseline.anchors
      .filter((anchor) => anchor.kind === "rule")
      .map((anchor) => [anchor.path, anchor.contentHash]),
  );
  for (const source of snapshot.instructions.sources) {
    if (!baselineRuleHashes.has(source.path)) continue;
    assert.equal(
      source.contentHash,
      baselineRuleHashes.get(source.path),
      `${source.path} must use the shared raw-file hash, not parsed frontmatter body`,
    );
  }

  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.instructions), true);
  assert.equal(Object.isFrozen(snapshot.instructions.sources), true);
  assert.equal(Object.isFrozen(snapshot.baseline), true);
  assert.throws(() => snapshot.instructions.sources.push({}));
});

test("instruction and baseline failures are isolated instead of erasing the successful branch", async () => {
  const { snapshot: fixture } = await buildFixtureSnapshot();
  const shallowFrozenBaseline = Object.freeze({
    ...fixture.baseline,
    facts: {
      ...fixture.baseline.facts,
      languages: [...fixture.baseline.facts.languages],
    },
  });
  const first = await admission.resolveWorkspaceAdmissionSnapshot({
    workspace: "/fixture/repo",
    skills: [],
    io: createMemoryIo({}),
    loaders: {
      loadResolvedInstructions: async () => {
        throw new Error("instruction fixture failed");
      },
      buildProjectBaselineContext: async () => shallowFrozenBaseline,
    },
  });
  assert.equal(first.instructions, null);
  assert.equal(first.baseline, shallowFrozenBaseline);
  assert.equal(Object.isFrozen(first.baseline.facts), true);
  assert.equal(Object.isFrozen(first.baseline.facts.languages), true);
  assert.deepEqual(first.warnings.map((warning) => warning.code), [
    "instructions_failed",
  ]);

  const second = await admission.resolveWorkspaceAdmissionSnapshot({
    workspace: "/fixture/repo",
    skills: [],
    io: createMemoryIo({}),
    loaders: {
      loadResolvedInstructions: async () => fixture.instructions,
      buildProjectBaselineContext: async () => {
        throw new Error("baseline fixture failed");
      },
    },
  });
  assert.equal(second.instructions.layers.length, fixture.instructions.layers.length);
  assert.equal(second.baseline, null);
  assert.deepEqual(second.warnings.map((warning) => warning.code), [
    "baseline_failed",
  ]);
});

test("a defensive rule-anchor mismatch retains instructions and discards only baseline", async () => {
  const { snapshot: fixture } = await buildFixtureSnapshot();
  const originalSource = fixture.instructions.sources.find(
    (source) => source.path === "AGENTS.md",
  );
  assert.ok(originalSource);
  const mismatchedSource = {
    ...originalSource,
    contentHash: `sha256-${"0".repeat(64)}`,
  };
  const mismatchedInstructions = {
    ...fixture.instructions,
    sources: [mismatchedSource],
    layers: fixture.instructions.layers
      .filter((layer) => layer.source.path === "AGENTS.md")
      .map((layer) => ({ ...layer, source: mismatchedSource })),
    templates: [],
    matchedRules: [],
  };
  const result = await admission.resolveWorkspaceAdmissionSnapshot({
    workspace: "/fixture/repo",
    skills: [],
    io: createMemoryIo({}),
    loaders: {
      loadResolvedInstructions: async () => mismatchedInstructions,
      buildProjectBaselineContext: async () => fixture.baseline,
    },
  });

  assert.ok(result.instructions);
  assert.equal(result.baseline, null);
  assert.deepEqual(result.warnings, [{
    code: "rule_anchor_hash_mismatch",
    message:
      "Project baseline was discarded because its rule anchors did not match the exact instruction-source bytes captured for this admission.",
    paths: ["AGENTS.md"],
  }]);
});

test("baseline rendering is deterministic, bounded, and explicitly non-authoritative", async () => {
  const { snapshot } = await buildFixtureSnapshot();
  const rendered = admission.renderProjectBaselineContext(snapshot.baseline);
  const repeated = admission.renderProjectBaselineContext(snapshot.baseline);
  const bounded = admission.renderProjectBaselineContext(snapshot.baseline, 900);

  assert.equal(rendered, repeated);
  assert.match(rendered, /not instructions/i);
  assert.match(rendered, /does not grant permission/i);
  assert.match(rendered, /not mutation or validation evidence/i);
  assert.match(rendered, /project-baseline-sha256-/);
  assert.match(rendered, /invocation="pnpm run test"/);
  assert.doesNotMatch(rendered, /TOKEN=must-not-render/);
  assert.doesNotMatch(rendered, /Run focused tests before reporting completion/);
  assert.ok(bounded.length <= 900);
  assert.match(bounded, /PROJECT BASELINE TRUNCATED/);
  assert.match(bounded, /fingerprint=project-baseline-sha256-/);
  assert.equal(admission.renderProjectBaselineContext(null), "");
});

test("canonicalization failure performs no partial workspace reads", async () => {
  let readCalls = 0;
  let loaderCalls = 0;
  const result = await admission.resolveWorkspaceAdmissionSnapshot({
    workspace: "/missing",
    skills: [],
    io: {
      async canonicalizeWorkspace() {
        throw new Error("workspace unavailable");
      },
      async listDirectory() {
        readCalls += 1;
        return [];
      },
      async readFile() {
        readCalls += 1;
        return "";
      },
      async globSearch() {
        readCalls += 1;
        return [];
      },
    },
    loaders: {
      loadResolvedInstructions: async () => {
        loaderCalls += 1;
        throw new Error("must not run");
      },
      buildProjectBaselineContext: async () => {
        loaderCalls += 1;
        throw new Error("must not run");
      },
    },
  });

  assert.equal(result.canonicalWorkspace, null);
  assert.equal(result.instructions, null);
  assert.equal(result.baseline, null);
  assert.deepEqual(result.warnings.map((warning) => warning.code), [
    "workspace_canonicalize_failed",
  ]);
  assert.equal(loaderCalls, 0);
  assert.equal(readCalls, 0);
  assert.equal(Object.isFrozen(result), true);
});
