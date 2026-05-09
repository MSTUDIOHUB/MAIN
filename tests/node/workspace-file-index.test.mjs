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

const { createWorkspaceFileIndexController } = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/lib/workspaceFileIndex.ts"),
);

test("workspace file index controller lazily loads and caches by workspace+version", async () => {
  let calls = 0;
  const controller = createWorkspaceFileIndexController(async (workspacePath) => {
    calls += 1;
    return workspacePath === "/repo-a" ? ["src/App.tsx"] : ["README.md"];
  });

  const first = await controller.ensureLoaded({ workspacePath: "/repo-a", contentVersion: 1 });
  assert.deepEqual(first, ["src/App.tsx"]);
  assert.equal(calls, 1);

  const cached = await controller.ensureLoaded({ workspacePath: "/repo-a", contentVersion: 1 });
  assert.deepEqual(cached, ["src/App.tsx"]);
  assert.equal(calls, 1);
  assert.deepEqual(controller.getCachedFiles("/repo-a", 1), ["src/App.tsx"]);
  assert.equal(controller.getCachedFiles("/repo-a", 2), null);
});

test("workspace file index controller uses single-flight for concurrent loads", async () => {
  let calls = 0;
  let release = null;
  const gate = new Promise((resolve) => {
    release = resolve;
  });

  const controller = createWorkspaceFileIndexController(async () => {
    calls += 1;
    await gate;
    return ["src/index.ts"];
  });

  const one = controller.ensureLoaded({ workspacePath: "/repo-b", contentVersion: 8 });
  const two = controller.ensureLoaded({ workspacePath: "/repo-b", contentVersion: 8 });
  release?.();

  const [oneResult, twoResult] = await Promise.all([one, two]);
  assert.deepEqual(oneResult, ["src/index.ts"]);
  assert.deepEqual(twoResult, ["src/index.ts"]);
  assert.equal(calls, 1);
});

test("workspace file index controller invalidates on content version and force refresh", async () => {
  let calls = 0;
  const controller = createWorkspaceFileIndexController(async () => {
    calls += 1;
    return [`file-${calls}.ts`];
  });

  const v1 = await controller.ensureLoaded({ workspacePath: "/repo-c", contentVersion: 1 });
  assert.deepEqual(v1, ["file-1.ts"]);
  assert.equal(calls, 1);

  const v2 = await controller.ensureLoaded({ workspacePath: "/repo-c", contentVersion: 2 });
  assert.deepEqual(v2, ["file-2.ts"]);
  assert.equal(calls, 2);

  const forced = await controller.ensureLoaded({
    workspacePath: "/repo-c",
    contentVersion: 2,
    forceRefresh: true,
  });
  assert.deepEqual(forced, ["file-3.ts"]);
  assert.equal(calls, 3);
});
