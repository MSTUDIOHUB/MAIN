import test from "node:test";
import assert from "node:assert/strict";
import fsSync from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

import ts from "typescript";

const workspaceRoot = process.cwd();
const moduleCache = new Map();

function loadTranspiledModuleSync(sourcePath) {
  const normalizedPath = path.resolve(sourcePath);
  if (moduleCache.has(normalizedPath)) return moduleCache.get(normalizedPath);

  const source = fsSync.readFileSync(normalizedPath, "utf8");
  const localRequire = createRequire(normalizedPath);
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
    fileName: normalizedPath,
  }).outputText;

  const module = { exports: {} };
  moduleCache.set(normalizedPath, module.exports);
  const runtimeRequire = (specifier) => {
    if (specifier.startsWith(".")) {
      const basePath = path.resolve(path.dirname(normalizedPath), specifier);
      const candidates = [
        basePath,
        `${basePath}.ts`,
        `${basePath}.tsx`,
        path.join(basePath, "index.ts"),
      ];
      for (const candidate of candidates) {
        if (!fsSync.existsSync(candidate)) continue;
        if (candidate.endsWith(".ts") || candidate.endsWith(".tsx")) {
          return loadTranspiledModuleSync(candidate);
        }
      }
    }
    return localRequire(specifier);
  };
  const factory = new Function("exports", "module", "require", transpiled);
  factory(module.exports, module, runtimeRequire);
  moduleCache.set(normalizedPath, module.exports);
  return module.exports;
}

const { applySubmitSessionBootstrap } = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/store/submitSessionBootstrap.ts"),
);

function createState(overrides = {}) {
  return {
    currentWorkspace: "/repo",
    currentSessionId: null,
    sessionsByWorkspace: {},
    activeSessionByWorkspace: {},
    autoApproveTools: false,
    autoApproveToolScopes: [],
    webSearchEnabled: false,
    webSearchProvider: "off",
    config: {
      language: "zh",
      sessionRecordingEnabled: true,
    },
    ...overrides,
  };
}

function createHarness(state) {
  const updates = [];
  return {
    updates,
    set: (patch) => {
      const next = typeof patch === "function" ? patch(state) : patch;
      if (next && typeof next === "object") Object.assign(state, next);
    },
    updateSession: (scopeKey, sessionId, patch) => {
      updates.push({ scopeKey, sessionId, patch });
    },
  };
}

test("submit session bootstrap creates an auto session and touches the run session", () => {
  const state = createState();
  const harness = createHarness(state);

  const decision = applySubmitSessionBootstrap({
    state,
    set: harness.set,
    updateSession: harness.updateSession,
    autoSessionNowMs: 1000,
    commandIssuedAtMs: 2000,
  });

  assert.equal(decision.ensuredSessionId, 1000);
  assert.equal(decision.runSessionKey, "/repo:1000");
  assert.equal(state.currentSessionId, 1000);
  assert.equal(state.sessionsByWorkspace["/repo"][0].title, "新会话");
  assert.deepEqual(state.approvedLocalFileReadPaths, []);
  assert.deepEqual(harness.updates, [
    {
      scopeKey: "/repo",
      sessionId: 1000,
      patch: {
        updatedAt: new Date(2000).toISOString(),
        updatedAtMs: 2000,
        active: true,
      },
    },
  ]);
});

test("submit session bootstrap reuses a valid current session without creating one", () => {
  const state = createState({
    currentSessionId: 7,
    sessionsByWorkspace: {
      "/repo": [{ id: 7, active: true, title: "Existing" }],
    },
    activeSessionByWorkspace: { "/repo": 7 },
  });
  const harness = createHarness(state);

  const decision = applySubmitSessionBootstrap({
    state,
    set: harness.set,
    updateSession: harness.updateSession,
    autoSessionNowMs: 1000,
    commandIssuedAtMs: 2000,
  });

  assert.equal(decision.ensuredSessionId, 7);
  assert.equal(decision.autoSession, null);
  assert.equal(state.sessionsByWorkspace["/repo"].length, 1);
  assert.equal(harness.updates[0].sessionId, 7);
});
