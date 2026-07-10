import test from "node:test";
import assert from "node:assert/strict";
import fsSync from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

import ts from "typescript";

const require = createRequire(import.meta.url);
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

const { detectGameDevelopmentIntent } = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/lib/gameStudio/detection.ts"),
);

test("Unity project structure triggers an explicit Unity signal", () => {
  const signal = detectGameDevelopmentIntent("帮我分析这个项目结构", {
    workspaceTree: ["[D] Assets", "[D] ProjectSettings", "[D] Packages"].join("\n"),
  });

  assert.equal(signal.shouldSuggest, true);
  assert.equal(signal.engineStatus, "explicit");
  assert.equal(signal.engine, "unity");
});

test("Unity semantics triggers an explicit Unity signal", () => {
  const signal = detectGameDevelopmentIntent("帮我优化 Unity Prefab 和 MonoBehaviour 引用流程");

  assert.equal(signal.shouldSuggest, true);
  assert.equal(signal.engineStatus, "explicit");
  assert.equal(signal.engine, "unity");
});

test("game development semantics without engine asks for engine choice", () => {
  const signal = detectGameDevelopmentIntent("帮我设计一个角色控制器和战斗系统");

  assert.equal(signal.shouldSuggest, true);
  assert.equal(signal.engineStatus, "ambiguous");
  assert.equal(signal.engine, null);
});

test("ordinary casual chat does not trigger Game Studio suggestion", () => {
  const signal = detectGameDevelopmentIntent("我们来玩个猜数字游戏吧");

  assert.equal(signal.shouldSuggest, false);
  assert.equal(signal.engineStatus, "none");
});

test("ambiguous engine mentions ask the user instead of guessing", () => {
  const signal = detectGameDevelopmentIntent("Unity 和 Unreal 这个项目应该选哪个？");

  assert.equal(signal.shouldSuggest, true);
  assert.equal(signal.engineStatus, "ambiguous");
  assert.equal(signal.engine, null);
});

test("generic Assets directory alone is not enough project evidence", () => {
  const signal = detectGameDevelopmentIntent("帮我看一下资源目录", {
    workspaceTree: "[D] Assets\n[D] src",
  });

  assert.equal(signal.shouldSuggest, false);
});
