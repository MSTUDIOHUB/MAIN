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

const {
  resolveSessionModeAffinity,
  isImageStudioSessionAffinity,
  findLatestSessionForAffinity,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/imageStudioSessions.ts"));

test("resolveSessionModeAffinity prefers explicit session affinity", () => {
  assert.equal(resolveSessionModeAffinity({ sessionModeAffinity: "image_studio" }, "main_mode"), "image_studio");
  assert.equal(resolveSessionModeAffinity({
    runtimeSnapshot: {
      sessionModeAffinity: "game_studio",
      selectedMainModeKey: "main_mode",
    },
  }, "main_mode"), "game_studio");
  assert.equal(resolveSessionModeAffinity({}, "main_mode"), "main_mode");
});

test("isImageStudioSessionAffinity identifies image sessions from runtime metadata", () => {
  assert.equal(isImageStudioSessionAffinity("image_studio"), true);
  assert.equal(isImageStudioSessionAffinity({
    runtimeSnapshot: { selectedMainModeKey: "image_studio" },
  }), true);
  assert.equal(isImageStudioSessionAffinity({
    runtimeSnapshot: { selectedMainModeKey: "main_mode" },
  }), false);
});

test("findLatestSessionForAffinity returns the most recent matching session and respects exclusions", () => {
  const sessions = [
    { id: 11, updatedAtMs: 1000, sessionModeAffinity: "main_mode" },
    { id: 12, updatedAtMs: 1500, sessionModeAffinity: "image_studio" },
    { id: 13, updatedAtMs: 2000, runtimeSnapshot: { sessionModeAffinity: "image_studio" } },
    { id: 14, updatedAtMs: 2500, sessionModeAffinity: "game_studio" },
  ];

  assert.equal(findLatestSessionForAffinity(sessions, "image_studio")?.id, 13);
  assert.equal(findLatestSessionForAffinity(sessions, "image_studio", { excludeSessionId: 13 })?.id, 12);
  assert.equal(findLatestSessionForAffinity(sessions, "main_mode")?.id, 11);
});
