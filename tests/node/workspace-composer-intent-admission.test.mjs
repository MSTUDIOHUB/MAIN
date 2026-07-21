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
  const transpiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    fileName: normalizedPath,
  }).outputText;
  const module = { exports: {} };
  moduleCache.set(normalizedPath, module.exports);
  const localRequire = createRequire(normalizedPath);
  const runtimeRequire = (specifier) => {
    if (specifier.startsWith(".")) {
      const basePath = path.resolve(path.dirname(normalizedPath), specifier);
      for (const candidate of [
        basePath,
        `${basePath}.ts`,
        `${basePath}.tsx`,
        path.join(basePath, "index.ts"),
      ]) {
        if (fsSync.existsSync(candidate) && /\.tsx?$/.test(candidate)) {
          return loadTranspiledModuleSync(candidate);
        }
      }
    }
    return localRequire(specifier);
  };
  new Function("exports", "module", "require", transpiled)(
    module.exports,
    module,
    runtimeRequire,
  );
  moduleCache.set(normalizedPath, module.exports);
  return module.exports;
}

const { buildWorkspaceComposerIntentDispatchHints } = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/store/workspaceComposerIntentAdmission.ts"),
);

function build(input = {}) {
  const defaultSnapshot = {
    mainModeKey: "main_mode",
    lockedComposerIntent: null,
    subagentPreference: "unspecified",
  };
  return buildWorkspaceComposerIntentDispatchHints({
    text: "Inspect the runtime",
    language: "en",
    ...input,
    snapshot: {
      ...defaultSnapshot,
      ...(input.snapshot || {}),
    },
  });
}

test("ordinary Composer text captures an explicit immutable subagent preference", () => {
  assert.deepEqual(build(), { subagentPreference: "unspecified" });
  assert.deepEqual(build({
    snapshot: { subagentPreference: "preferred" },
  }), { subagentPreference: "preferred" });
});

test("a locked Composer intent becomes an immutable dispatch decision", () => {
  const hints = build({
    text: "Inspect the runtime before changing it",
    snapshot: {
      mainModeKey: "main_mode",
      lockedComposerIntent: "plan",
    },
  });

  assert.equal(hints.resolvedIntent, "plan");
  assert.equal(hints.runtimeIntentOverride, "plan");
  assert.equal(hints.skipIntentResolution, true);
  assert.equal(hints.turnTitle, "Inspect the runtime before changing it");
  assert.match(hints.intentSummary, /^Plan:/);
});

test("Chinese and English Plan shortcuts converge on the same structured intent", () => {
  const english = build({ text: "/plan inspect the runtime" });
  const chinese = build({
    text: "/计划 检查运行时",
    language: "zh",
  });

  assert.equal(english.resolvedIntent, "plan");
  assert.equal(chinese.resolvedIntent, "plan");
  assert.equal(english.skipIntentResolution, true);
  assert.equal(chinese.skipIntentResolution, true);
  assert.doesNotMatch(english.turnTitle, /^\/plan/i);
  assert.doesNotMatch(chinese.turnTitle, /^\/计划/);
});

test("the Image Studio shortcut is preserved as a typed intent instead of an unknown string", () => {
  const hints = build({ text: "/image draw a runtime architecture diagram" });

  assert.equal(hints.resolvedIntent, "image_studio");
  assert.equal(hints.runtimeIntentOverride, "image_studio");
  assert.equal(hints.skipIntentResolution, true);
});

test("ordinary Studio input retains the exact workspace mode while waiting in FIFO", () => {
  const image = build({
    text: "draw a runtime architecture diagram",
    snapshot: {
      mainModeKey: "image_studio",
      lockedComposerIntent: null,
    },
  });
  const game = build({
    text: "inspect the active Unity scene",
    snapshot: {
      mainModeKey: "game_studio",
      lockedComposerIntent: null,
    },
  });

  assert.equal(image.resolvedIntent, "image_studio");
  assert.equal(image.runtimeIntentOverride, "image_studio");
  assert.equal(game.resolvedIntent, "studio_workflow");
  assert.equal(game.runtimeIntentOverride, "studio_workflow");
});

test("MDEBUG is durably classified as Plan with its canonical metadata", () => {
  const hints = build({
    text: "/MDEBUG\nTerminal output is missing",
  });

  assert.deepEqual(hints, {
    subagentPreference: "unspecified",
    resolvedIntent: "plan",
    runtimeIntentOverride: "plan",
    skipIntentResolution: true,
    turnTitle: "MDEBUG：用户反馈自修复",
    intentSummary: "MDEBUG：用户反馈自修复",
  });
});

test("mode policy rejects an incompatible locked intent without phrase heuristics", () => {
  assert.equal(build({
    text: "Inspect the game runtime",
    snapshot: {
      mainModeKey: "game_studio",
      lockedComposerIntent: "report",
    },
  }).resolvedIntent, "studio_workflow");

  assert.equal(build({
    text: "/plan inspect the game runtime",
    snapshot: {
      mainModeKey: "game_studio",
      lockedComposerIntent: null,
    },
  }).resolvedIntent, "plan");
});
