import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";

function loadPreflight(candidate) {
  const cache = new Map();
  function load(file) {
    const resolved = path.resolve(file);
    if (cache.has(resolved)) return cache.get(resolved);
    const module = { exports: {} };
    cache.set(resolved, module.exports);
    const localRequire = createRequire(resolved);
    const requireModule = (name) => {
      if (name === "./streaming") {
        return { streamChatCompletion: async () => ({ content: JSON.stringify(candidate) }) };
      }
      if (name.startsWith(".")) {
        const base = path.resolve(path.dirname(resolved), name);
        for (const source of [`${base}.ts`, path.join(base, "index.ts")]) {
          if (fs.existsSync(source)) return load(source);
        }
      }
      return localRequire(name);
    };
    new Function("exports", "module", "require", ts.transpileModule(fs.readFileSync(resolved, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }, fileName: resolved,
    }).outputText)(module.exports, module, requireModule);
    return module.exports;
  }
  return load("src/lib/intentPreflight.ts").runIntentPreflight;
}

const directive = { kind: "shell", action: "test", exactCommand: "npm test", requiresApproval: true };
const params = {
  input: "Only explain where the previous test result came from; do not execute tests.",
  language: "en",
  mainModeKey: "main_mode",
  config: { activeProfile: "local", local: { endpoint: "http://fixture.invalid/v1", model: "fixture" } },
};

test("preflight operation metadata and approval cannot override its read-only intent", async () => {
  const preflight = loadPreflight({ intent: "respond", requiresApproval: true, commandDirective: directive });
  const result = await preflight(params);
  assert.equal(result.intent, "respond");
  assert.equal(result.requiresApproval, false);
  assert.equal(result.commandDirective.kind, "none");
  assert.equal(result.commandDirective.exactCommand, undefined);
  assert.equal(result.riskLevel, "low");
});

test("preflight keeps requested execution and future Plan operation metadata", async () => {
  for (const intent of ["execute", "plan"]) {
    const preflight = loadPreflight({ intent, commandDirective: directive });
    const result = await preflight({ ...params, input: "npm test" });
    assert.equal(result.intent, intent);
    assert.equal(result.commandDirective.kind, "shell");
    assert.equal(result.commandDirective.exactCommand, "npm test");
  }
});
