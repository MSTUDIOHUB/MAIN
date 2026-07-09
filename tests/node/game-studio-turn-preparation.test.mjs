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

const {
  prepareGameStudioTurn,
} = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/store/gameStudioTurnPreparation.ts"),
);

function studioConfig(overrides = {}) {
  return {
    engine: "unity",
    engineLanguage: "C#",
    reviewMode: "standard",
    activeStudioAgent: "unity-specialist",
    packVersion: "test-pack",
    ...overrides,
  };
}

function createRuntimeService(overrides = {}) {
  const calls = [];
  const service = {
    calls,
    async ensureInitialized(agent) {
      calls.push(["ensureInitialized", agent]);
      return studioConfig({ activeStudioAgent: agent || "studio_auto" });
    },
    async configureEngine(params) {
      calls.push(["configureEngine", params]);
      return studioConfig({
        engine: params.engine,
        engineVersion: params.version,
        activeStudioAgent: params.activeStudioAgent || "studio_auto",
      });
    },
    async loadConfig() {
      calls.push(["loadConfig"]);
      return null;
    },
    buildTurnEnvelope(params) {
      calls.push(["buildTurnEnvelope", params]);
      return `ENVELOPE:${params.activeStudioAgent}:${params.studioConfig?.engine || "none"}:${params.originalText}`;
    },
    ...overrides,
  };
  return service;
}

test("game studio turn preparation configures explicit setup-engine commands and builds an envelope", async () => {
  const service = createRuntimeService();
  const result = await prepareGameStudioTurn({
    currentMainModeKey: "game_studio",
    text: "/setup-engine unity 2022",
    userContent: "configure unity",
    parsedSetupEngineCommand: {
      mode: "configure",
      engine: "unity",
      version: "2022",
      raw: "unity 2022",
    },
    parsedStudioCommand: { type: "workflow", slug: "setup-engine", args: "unity 2022" },
    activeStudioAgentKey: "studio_auto",
    gameStudioInitialized: false,
    cachedWorkspaceTreeForGameDetection: "",
    preferredLanguage: "zh",
    runtimeService: service,
  });

  assert.equal(result.ok, true);
  assert.equal(result.activeStudioAgentKey, "unity-specialist");
  assert.equal(result.gameStudioInitialized, true);
  assert.equal(result.gameStudioConfigForTurn.engine, "unity");
  assert.equal(result.gameStudioConfigForTurn.engineVersion, "2022");
  assert.equal(result.shouldInvalidateWorkspaceTree, true);
  assert.equal(result.shouldBumpWorkspaceContentVersion, true);
  assert.deepEqual(result.runtimePatch, {
    gameStudioInitialized: true,
    activeStudioAgentKey: "unity-specialist",
  });
  assert.match(result.userContent, /^ENVELOPE:unity-specialist:unity:/);
  assert.deepEqual(service.calls.map((call) => call[0]), [
    "ensureInitialized",
    "configureEngine",
    "buildTurnEnvelope",
  ]);
});

test("game studio turn preparation auto-configures explicit engine signals when workspace config is missing", async () => {
  const service = createRuntimeService({
    async loadConfig() {
      this.calls.push(["loadConfig"]);
      return null;
    },
  });

  const result = await prepareGameStudioTurn({
    currentMainModeKey: "game_studio",
    text: "修复 Unity MonoBehaviour 引用",
    userContent: "fix camera",
    parsedSetupEngineCommand: null,
    parsedStudioCommand: null,
    activeStudioAgentKey: "studio_auto",
    gameStudioInitialized: false,
    cachedWorkspaceTreeForGameDetection: "[D] Assets\n[D] ProjectSettings\n[D] Packages",
    preferredLanguage: "zh",
    runtimeService: service,
  });

  assert.equal(result.ok, true);
  assert.equal(result.activeStudioAgentKey, "unity-specialist");
  assert.equal(result.gameStudioInitialized, true);
  assert.equal(result.gameStudioConfigForTurn.engine, "unity");
  assert.match(result.userContent, /^ENVELOPE:unity-specialist:unity:/);
  assert.deepEqual(service.calls.map((call) => call[0]), [
    "loadConfig",
    "ensureInitialized",
    "configureEngine",
    "buildTurnEnvelope",
  ]);
});

test("game studio turn preparation returns a failure when required initialization cannot start", async () => {
  const warnings = [];
  const service = createRuntimeService({
    async ensureInitialized(agent) {
      this.calls.push(["ensureInitialized", agent]);
      throw new Error("pack missing");
    },
    async loadConfig() {
      this.calls.push(["loadConfig"]);
      return null;
    },
  });

  const result = await prepareGameStudioTurn({
    currentMainModeKey: "game_studio",
    text: "/implement camera",
    userContent: "implement camera",
    parsedSetupEngineCommand: null,
    parsedStudioCommand: { type: "workflow", slug: "implement", args: "camera" },
    activeStudioAgentKey: "studio_auto",
    gameStudioInitialized: false,
    cachedWorkspaceTreeForGameDetection: "",
    preferredLanguage: "zh",
    runtimeService: service,
    logWarning: (event, data) => warnings.push({ event, data }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.errorMessage, "Game Studio 初始化失败：pack missing");
  assert.equal(result.userContent, "implement camera");
  assert.equal(warnings.length, 0);
  assert.deepEqual(service.calls.map((call) => call[0]), [
    "loadConfig",
    "ensureInitialized",
  ]);
});
