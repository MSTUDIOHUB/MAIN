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
    cancellations: [],
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
        closeTurnAsCanceled: (turnId, options) => {
          calls.cancellations.push({ turnId, options });
          return true;
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
    queuedWorkflowContext: {
      runtimeIntentOverride: "goal",
      goalSourceContextSnapshot: "[plan_artifact]\n- 修复批准生命周期",
      goalCreationAuthorization: {
        kind: "goal_creation_authorization",
        intent: "goal",
        source: "visible_goal_composer_capsule",
      },
    },
  });

  assert.equal(result.shouldContinue, false);
  assert.equal(result.returnValue, false);
  assert.equal(result.decision.action.kind, "queue");
  assert.equal(harness.calls.queued.length, 1);
  assert.deepEqual(harness.calls.queued[0].images, ["data:image/png;base64,a"]);
  assert.deepEqual(harness.calls.queued[0].options.contextMentions, ["src/App.tsx"]);
  assert.equal(harness.calls.queued[0].options.attachedFiles[0].path, "/tmp/report.csv");
  assert.equal(harness.calls.queued[0].options.attachedFiles[0].kind, "tabular");
  assert.equal(harness.calls.queued[0].options.runtimeIntentOverride, "goal");
  assert.match(harness.calls.queued[0].options.goalSourceContextSnapshot, /plan_artifact/);
  assert.equal(
    harness.calls.queued[0].options.goalCreationAuthorization.source,
    "visible_goal_composer_capsule",
  );
  assert.equal(harness.calls.logs.at(-1).event, "send_queued");
  assert.equal(harness.calls.logs.at(-1).data.reason, "generation_in_progress");
});

test("send gate effects preserve authorized Goal guidance without rebuilding it from text", () => {
  const harness = createHarness({
    isGenerating: true,
    agentStatus: "running",
    abortController: {},
  });
  const authorization = {
    kind: "goal_continuation_authorization",
    source: "goal_user_choice",
    workspaceKey: "/repo",
    sessionKey: "/repo:7",
    goalId: "goal-1",
    goalRevision: 2,
    ownerTurnId: "turn-goal",
    requestId: "request-1",
  };
  const result = harness.apply({
    text: "显示给用户的选择文本",
    queuedWorkflowContext: {
      runtimeIntentOverride: "goal",
      goalContinuationAuthorization: authorization,
      goalContinuationGuidance: "精确注入 Goal 的用户指导",
    },
  });

  assert.equal(result.shouldContinue, false);
  assert.equal(harness.calls.queued.length, 1);
  assert.equal(
    harness.calls.queued[0].options.goalContinuationGuidance,
    "精确注入 Goal 的用户指导",
  );
  assert.deepEqual(
    harness.calls.queued[0].options.goalContinuationAuthorization,
    authorization,
  );
});

test("send gate effects reject hidden execution resumes while an owner is running without queueing internal prompts", () => {
  const harness = createHarness({
    isGenerating: true,
    agentStatus: "running",
    abortController: {},
  });
  const result = harness.apply({
    text: "internal approved plan resume",
    isHidden: true,
    options: {
      executionConsentGranted: true,
      runtimeIntentOverride: "execute",
      turnIdOverride: "turn-1",
    },
  });

  assert.equal(result.shouldContinue, false);
  assert.equal(result.returnValue, false);
  assert.equal(result.decision.action.kind, "queue");
  assert.deepEqual(harness.calls.queued, []);
  assert.deepEqual(harness.calls.logs.at(-1), {
    event: "send_busy_hidden_execution_rejected",
    data: {
      reason: "generation_in_progress",
      runtimeIntentOverride: "execute",
      turnIdOverride: "turn-1",
    },
  });
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

test("a durable workspace claim never leaks into the legacy latest-wins queue", () => {
  const harness = createHarness({
    agentStatus: "pending_review",
    abortController: {},
  });
  const result = harness.apply({
    text: "durable queued instruction",
    options: {
      workspaceInstructionClaim: {
        claimId: "claim-a",
        turnId: "turn-a",
        receiptId: "receipt-a",
      },
    },
  });

  assert.equal(result.shouldContinue, false);
  assert.equal(result.returnValue, false);
  assert.equal(result.decision.action.kind, "queue");
  assert.deepEqual(harness.calls.queued, []);
  assert.deepEqual(harness.calls.logs, [{
    event: "workspace_turn_send_gate_queue_rejected",
    data: {
      reason: "agent_running_or_pending_review",
      claimId: "claim-a",
      turnId: "turn-a",
      receiptId: "receipt-a",
    },
  }]);
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
  assert.deepEqual(harness.calls.patches, []);
  assert.deepEqual(harness.calls.cancellations, [{
    turnId: "turn-stuck",
    options: {
      reason: "stale_runtime_superseded",
      message: "检测到旧回合的运行租约已经丢失；旧回合已取消并完成收口。",
    },
  }]);
  assert.equal(harness.calls.logs[0].event, "send_stuck_state_reset");
  assert.equal(harness.calls.logs[0].data.previousStatus, "running");
});

test("send gate effects still releases a stuck status when no logical turn can be closed", () => {
  const harness = createHarness({
    agentStatus: "running",
    abortController: null,
    currentTurnId: null,
  });
  const result = harness.apply({ text: "continue" });

  assert.equal(result.shouldContinue, true);
  assert.equal(result.decision.action.kind, "reset_stuck_state");
  assert.deepEqual(harness.calls.cancellations, []);
  assert.deepEqual(harness.calls.patches, [{ agentStatus: "idle", isGenerating: false }]);
});
