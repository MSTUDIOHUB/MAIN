import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

import ts from "typescript";

const require = createRequire(import.meta.url);
const workspaceRoot = process.cwd();

async function loadOnboardingModule() {
  const sourcePath = path.join(workspaceRoot, "src/lib/gameStudioOnboarding.ts");
  const source = await fs.readFile(sourcePath, "utf8");
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
    fileName: sourcePath,
  }).outputText;

  const module = { exports: {} };
  const factory = new Function("exports", "module", "require", transpiled);
  factory(module.exports, module, require);
  return module.exports;
}

const {
  resolveGameStudioOnboardingAction,
  shouldShowGameStudioOnboarding,
} = await loadOnboardingModule();

test("game studio onboarding actions resolve to initialization or trailing-space drafts", () => {
  assert.deepEqual(resolveGameStudioOnboardingAction("init"), { kind: "initialize" });
  assert.deepEqual(resolveGameStudioOnboardingAction("start"), { kind: "draft", value: "/start " });
  assert.deepEqual(resolveGameStudioOnboardingAction("brainstorm"), { kind: "draft", value: "/brainstorm " });
  assert.deepEqual(resolveGameStudioOnboardingAction("setup-engine"), { kind: "draft", value: "/setup-engine " });
});

test("game studio onboarding only appears for empty fresh studio sessions", () => {
  const base = {
    isGameStudioMode: true,
    hasWorkspace: true,
    gameStudioInitialized: false,
    nonPackFileCount: 2,
    input: "",
    hasConversationHistory: false,
    showSlashMenu: false,
    dismissed: false,
    used: false,
    forceVisible: false,
  };

  assert.equal(shouldShowGameStudioOnboarding(base), true);
  assert.equal(shouldShowGameStudioOnboarding({ ...base, input: "/setup-engine " }), false);
  assert.equal(shouldShowGameStudioOnboarding({ ...base, hasConversationHistory: true }), false);
  assert.equal(shouldShowGameStudioOnboarding({ ...base, showSlashMenu: true }), false);
  assert.equal(shouldShowGameStudioOnboarding({ ...base, dismissed: true }), false);
  assert.equal(shouldShowGameStudioOnboarding({ ...base, used: true }), false);
  assert.equal(shouldShowGameStudioOnboarding({ ...base, gameStudioInitialized: true }), false);
  assert.equal(shouldShowGameStudioOnboarding({ ...base, nonPackFileCount: 5 }), false);
  assert.equal(shouldShowGameStudioOnboarding({ ...base, isGameStudioMode: false }), false);
  assert.equal(
    shouldShowGameStudioOnboarding({
      ...base,
      gameStudioInitialized: true,
      nonPackFileCount: 12,
      hasConversationHistory: true,
      forceVisible: true,
    }),
    true,
  );
  assert.equal(
    shouldShowGameStudioOnboarding({
      ...base,
      gameStudioInitialized: true,
      nonPackFileCount: 12,
      hasConversationHistory: true,
      forceVisible: true,
      input: "/setup-engine ",
    }),
    false,
  );
});
