import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

import ts from "typescript";

const workspaceRoot = process.cwd();

function loadTypeScriptModule(sourcePath) {
  const source = fs.readFileSync(sourcePath, "utf8");
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
    fileName: sourcePath,
  }).outputText;
  const module = { exports: {} };
  const localRequire = createRequire(sourcePath);
  new Function("exports", "module", "require", transpiled)(
    module.exports,
    module,
    localRequire,
  );
  return module.exports;
}

const {
  captureSessionRestoreRevisionFence,
  isSessionRestoreRevisionFenceCurrent,
} = loadTypeScriptModule(
  path.join(workspaceRoot, "src/store/sessionRestoreRevisionFence.ts"),
);

test("Session restore fence follows the exact target runtime object", () => {
  const targetRuntime = { turnId: "turn-target" };
  const otherRuntime = { turnId: "turn-other" };
  const fence = captureSessionRestoreRevisionFence({
    runtimeBySessionKey: {
      "/repo:1": targetRuntime,
      "/repo:2": otherRuntime,
    },
  }, "/repo:1");

  assert.deepEqual(fence, {
    sessionKey: "/repo:1",
    runtimeRef: targetRuntime,
  });
  assert.equal(isSessionRestoreRevisionFenceCurrent(fence, {
    runtimeBySessionKey: {
      "/repo:1": targetRuntime,
      "/repo:2": otherRuntime,
    },
  }), true);
  assert.equal(isSessionRestoreRevisionFenceCurrent(fence, {
    runtimeBySessionKey: {
      "/repo:1": { turnId: "turn-target" },
      "/repo:2": otherRuntime,
    },
  }), false, "an equal-looking replacement is a newer target Session revision");
});

test("unrelated Session mutations do not invalidate a restore fence", () => {
  const targetRuntime = { turnId: "turn-target" };
  const fence = captureSessionRestoreRevisionFence({
    runtimeBySessionKey: { "/repo:1": targetRuntime },
  }, "/repo:1");

  assert.equal(isSessionRestoreRevisionFenceCurrent(fence, {
    runtimeBySessionKey: {
      "/repo:1": targetRuntime,
      "/repo:2": { turnId: "turn-other-new" },
    },
  }), true);
});

test("an absent target entry remains current until that Session publishes", () => {
  const fence = captureSessionRestoreRevisionFence({
    runtimeBySessionKey: { "/repo:2": { turnId: "turn-other" } },
  }, "/repo:1");

  assert.equal(isSessionRestoreRevisionFenceCurrent(fence, {
    runtimeBySessionKey: { "/repo:2": { turnId: "turn-other-new" } },
  }), true);
  assert.equal(isSessionRestoreRevisionFenceCurrent(fence, {
    runtimeBySessionKey: {
      "/repo:1": { turnId: "turn-target-new" },
      "/repo:2": { turnId: "turn-other-new" },
    },
  }), false);
});

test("App restore captures after bootstrap and gates replay readiness on revision", () => {
  const source = fs.readFileSync(path.join(workspaceRoot, "src/App.tsx"), "utf8");
  const start = source.indexOf("const restoreSessionState = async");
  const end = source.indexOf("const openSessionScope", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const body = source.slice(start, end);

  const bootstrapReset = body.indexOf("resetToEmptyChatView();");
  const capture = body.indexOf("captureSessionRestoreRevisionFence(");
  const conflictLog = body.indexOf('mode: "skipped_revision_conflict"');
  const replayReady = body.indexOf("markWorkspaceClearSubmissionReplayReady");
  assert.ok(bootstrapReset >= 0 && capture > bootstrapReset);
  assert.ok(conflictLog > capture);
  assert.ok(replayReady > conflictLog);
  assert.match(body, /if \(!canPublishRestore\("finish"\)\) return;/);
});

test("App empty Session reset uses the canonical owner-isolated runtime snapshot", () => {
  const source = fs.readFileSync(path.join(workspaceRoot, "src/App.tsx"), "utf8");
  const start = source.indexOf("const resetToEmptyChatView = useCallback");
  const end = source.indexOf("const hydrateWorkspacePlanForEmptySession", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const body = source.slice(start, end);

  assert.match(body, /buildEmptySessionRuntimeSnapshot\(/);
  assert.match(body, /\.\.\.emptyRuntime/);
  assert.doesNotMatch(body, /subagentClosureReceiptLedger\s*:/);
  assert.doesNotMatch(body, /turnRuntimeCheckpoints\s*:/);
});
