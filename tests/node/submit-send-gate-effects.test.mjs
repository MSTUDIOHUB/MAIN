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

const { applySubmitSendGateEffects } = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/store/submitSendGateEffects.ts"),
);

function createHarness(stateOverrides = {}) {
  const calls = {
    queued: [],
    approvedPendingReview: 0,
    approvedPlans: [],
    patches: [],
    statuses: [],
    logs: [],
  };
  const state = {
    isGenerating: false,
    agentStatus: "idle",
    abortController: null,
    currentTurnId: "turn-1",
    pendingReviewResolve: null,
    pendingReviewTaskId: null,
    ...stateOverrides,
  };

  return {
    state,
    calls,
    apply(extra = {}) {
      return applySubmitSendGateEffects({
        text: "继续",
        images: undefined,
        hasSupplementalInput: false,
        isHidden: false,
        options: {},
        shouldExecuteOnceFromReplyOption: false,
        state,
        mentionSnapshot: [],
        attachedFilesSnapshot: [],
        queueUserMessage: (text, images, options) => {
          calls.queued.push({ text, images, options });
        },
        approvePendingReviewOnce: () => {
          calls.approvedPendingReview += 1;
        },
        approvePlan: (choice) => {
          calls.approvedPlans.push(choice);
        },
        setState: (patch) => {
          calls.patches.push(patch);
        },
        setConversationTurnStatus: (turnId, status) => {
          calls.statuses.push({ turnId, status });
        },
        logStoreEvent: (event, data) => {
          calls.logs.push({ event, data });
        },
        ...extra,
      });
    },
  };
}

test("send gate effects block empty input before busy effects", () => {
  const harness = createHarness({
    isGenerating: true,
    agentStatus: "running",
    abortController: {},
  });
  const result = harness.apply({
    text: "   ",
  });

  assert.equal(result.shouldContinue, false);
  assert.equal(result.returnValue, false);
  assert.equal(result.decision.action.kind, "block_empty");
  assert.deepEqual(harness.calls.queued, []);
  assert.deepEqual(harness.calls.logs, [
    {
      event: "send_blocked",
      data: { reason: "empty_text_no_images_no_context" },
    },
  ]);
});

test("send gate effects queue visible submissions while preserving context snapshots", () => {
  const harness = createHarness({
    isGenerating: true,
    agentStatus: "running",
    abortController: {},
  });
  const result = harness.apply({
    text: "新需求",
    images: ["data:image/png;base64,a"],
    mentionSnapshot: ["src/App.tsx"],
    attachedFilesSnapshot: ["/tmp/report.csv"],
  });

  assert.equal(result.shouldContinue, false);
  assert.equal(result.returnValue, false);
  assert.equal(result.decision.action.kind, "queue");
  assert.equal(harness.calls.queued.length, 1);
  assert.deepEqual(harness.calls.queued[0].images, ["data:image/png;base64,a"]);
  assert.deepEqual(harness.calls.queued[0].options.contextMentions, ["src/App.tsx"]);
  assert.equal(harness.calls.queued[0].options.attachedFiles[0].path, "/tmp/report.csv");
  assert.equal(harness.calls.queued[0].options.attachedFiles[0].kind, "tabular");
  assert.equal(harness.calls.logs.at(-1).event, "send_queued");
  assert.equal(harness.calls.logs.at(-1).data.reason, "generation_in_progress");
});

test("send gate effects approve pending review reply options without queueing", () => {
  const harness = createHarness({
    agentStatus: "pending_review",
    abortController: {},
    pendingReviewResolve: () => {},
    pendingReviewTaskId: 42,
  });
  const result = harness.apply({
    text: "执行一次",
    shouldExecuteOnceFromReplyOption: true,
  });

  assert.equal(result.shouldContinue, false);
  assert.equal(result.returnValue, true);
  assert.equal(result.decision.action.kind, "approve_pending_review");
  assert.equal(harness.calls.approvedPendingReview, 1);
  assert.deepEqual(harness.calls.approvedPlans, []);
  assert.deepEqual(harness.calls.queued, []);
  assert.equal(harness.calls.logs[0].event, "send_pending_review_approve_bypass");
  assert.equal(harness.calls.logs[0].data.pendingReviewTaskId, 42);
});

test("send gate effects reset stuck running state and continue submission", () => {
  const harness = createHarness({
    agentStatus: "running",
    abortController: null,
    currentTurnId: "turn-stuck",
  });
  const result = harness.apply({
    text: "继续修复",
  });

  assert.equal(result.shouldContinue, true);
  assert.equal(result.returnValue, undefined);
  assert.equal(result.decision.action.kind, "reset_stuck_state");
  assert.deepEqual(harness.calls.patches, [
    { agentStatus: "idle", isGenerating: false },
  ]);
  assert.deepEqual(harness.calls.statuses, [
    { turnId: "turn-stuck", status: "stopped_no_action" },
  ]);
  assert.equal(harness.calls.logs[0].event, "send_stuck_state_reset");
  assert.equal(harness.calls.logs[0].data.previousStatus, "running");
});
