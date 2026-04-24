import test from "node:test";
import assert from "node:assert/strict";
import fsSync from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

import ts from "typescript";

const require = createRequire(import.meta.url);
const workspaceRoot = process.cwd();

const transpiledModuleCache = new Map();

function loadTranspiledModuleSync(sourcePath) {
  const normalizedPath = path.resolve(sourcePath);
  if (transpiledModuleCache.has(normalizedPath)) {
    return transpiledModuleCache.get(normalizedPath);
  }

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
  transpiledModuleCache.set(normalizedPath, module.exports);

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
  transpiledModuleCache.set(normalizedPath, module.exports);
  return module.exports;
}

const { resolveTurnRunIntent } = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/lib/runIntent.ts"),
);

function createContext(overrides = {}) {
  return {
    language: "zh",
    mainModeKey: "main_mode",
    parsedStudioCommand: null,
    hasPlanArtifacts: false,
    planStage: "idle",
    isPlanApproved: false,
    ...overrides,
  };
}

test("explicit Chinese planning request resolves to plan", () => {
  const result = resolveTurnRunIntent("先给我一个方案再实现", createContext());
  assert.equal(result.intent, "plan");
  assert.equal(result.needsDecision, undefined);
});

test("explicit English implementation request resolves to execute", () => {
  const result = resolveTurnRunIntent("Please implement it directly and fix the bug", createContext());
  assert.equal(result.intent, "execute");
  assert.equal(result.needsDecision, undefined);
});

test("weak plan keyword triggers a decision instead of forcing plan", () => {
  const result = resolveTurnRunIntent("maybe we need a plan for this", createContext());
  assert.equal(result.intent, "discuss");
  assert.equal(result.needsDecision, true);
  assert.equal(result.suggestedIntent, "plan");
});

test("ordinary analysis question defaults to discuss", () => {
  const result = resolveTurnRunIntent("帮我解释一下这个模块现在在做什么", createContext());
  assert.equal(result.intent, "discuss");
  assert.equal(result.needsDecision, undefined);
});

test("high-risk multi-step implementation suggests planning first", () => {
  const result = resolveTurnRunIntent(
    "帮我从零搭建整个项目，包含前端后端、数据库 API、安装依赖和部署 pipeline",
    createContext(),
  );
  assert.equal(result.intent, "execute");
  assert.equal(result.needsDecision, true);
  assert.equal(result.suggestedIntent, "plan");
  assert.equal(result.riskLevel, "high");
});

test("game studio workflow slash bypasses MAIN plan interception", () => {
  const result = resolveTurnRunIntent(
    "/setup-engine unity",
    createContext({
      mainModeKey: "game_studio",
      parsedStudioCommand: {
        type: "workflow",
        slug: "setup-engine",
        args: "unity",
        canonicalCommand: "/setup-engine",
      },
    }),
  );
  assert.equal(result.intent, "studio_workflow");
  assert.equal(result.bypassMainRouter, true);
});
