import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";

const cache = new Map();

function loadTypeScript(sourcePath) {
  const normalized = path.resolve(sourcePath);
  if (cache.has(normalized)) return cache.get(normalized);
  const source = fs.readFileSync(normalized, "utf8");
  const transpiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    fileName: normalized,
  }).outputText;
  const module = { exports: {} };
  cache.set(normalized, module.exports);
  const localRequire = createRequire(normalized);
  const runtimeRequire = (specifier) => {
    if (specifier.startsWith(".")) {
      const base = path.resolve(path.dirname(normalized), specifier);
      for (const candidate of [base, `${base}.ts`, path.join(base, "index.ts")]) {
        if (fs.existsSync(candidate) && candidate.endsWith(".ts")) {
          return loadTypeScript(candidate);
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
  cache.set(normalized, module.exports);
  return module.exports;
}

const {
  resolveWorkspaceInstructionActionDecision,
  resolveWorkspaceInstructionExecutionConsent,
  shouldDeferWorkspaceInstructionDispatchForActiveOwner,
} = loadTypeScript(
  path.join(process.cwd(), "src/store/workspaceInstructionApproval.ts"),
);

const sessionKey = "/workspace:7";
const identity = {
  sessionKey,
  turnId: "source-turn",
  runId: "source-run",
  requestId: "choice-request",
  parentRunId: null,
  optionValues: ["Run once", "Cancel"],
  allowCustomReply: false,
  status: "pending",
};
const activeRequest = {
  ...identity,
  schemaVersion: 1,
  kind: "user_choice",
  title: "Run it?",
  createdAt: 1,
};
const sourceBlock = {
  id: 41,
  turnId: "source-turn",
  type: "agent",
  content: "Run it?",
  options: [
    { id: "run", label: "Run once", value: "Run once", action: "execute_once" },
    { id: "cancel", label: "Cancel", value: "Cancel", action: "cancel_operation" },
  ],
  choiceRequest: identity,
};

function hints(overrides = {}) {
  return {
    executionConsentGranted: true,
    replyOptionSourceTurnId: "source-turn",
    selectedReplyOptionText: "Run once",
    replyOptionRequestIdentity: identity,
    ...overrides,
  };
}

test("execution consent is granted only for the exact pending execute-once choice", () => {
  const decision = resolveWorkspaceInstructionExecutionConsent({
    sessionKey,
    taskFlow: [sourceBlock],
    hints: hints(),
    activeActionRequest: activeRequest,
  });
  assert.equal(decision.granted, true);
  assert.equal(decision.reason, "exact_pending_choice");
});

test("a restored stale, archived, or foreign choice cannot replay consent", () => {
  for (const input of [
    { taskFlow: [{ ...sourceBlock, archivedAfterChoice: true }], hints: hints() },
    { taskFlow: [sourceBlock], hints: hints({ replyOptionRequestIdentity: { ...identity, requestId: "newer" } }) },
    { taskFlow: [sourceBlock], hints: hints({ replyOptionRequestIdentity: { ...identity, sessionKey: "/foreign:9" } }) },
  ]) {
    const decision = resolveWorkspaceInstructionExecutionConsent({
      sessionKey,
      taskFlow: input.taskFlow,
      hints: input.hints,
      activeActionRequest: activeRequest,
    });
    assert.equal(decision.granted, false);
  }
});

test("a non-authorizing reply option never inherits a persisted consent boolean", () => {
  const decision = resolveWorkspaceInstructionExecutionConsent({
    sessionKey,
    taskFlow: [sourceBlock],
    hints: hints({ selectedReplyOptionText: "Cancel" }),
    activeActionRequest: activeRequest,
  });
  assert.deepEqual(decision, { granted: false, reason: "option_not_authorized" });
});

test("exact pending approval and cancellation choices resolve pending-review actions", () => {
  const approve = resolveWorkspaceInstructionActionDecision({
    sessionKey,
    taskFlow: [sourceBlock],
    hints: hints(),
    activeActionRequest: activeRequest,
  });
  assert.equal(approve.actionDecision, "approve");
  assert.equal(approve.reason, "exact_pending_choice");

  const reject = resolveWorkspaceInstructionActionDecision({
    sessionKey,
    taskFlow: [sourceBlock],
    hints: hints({
      executionConsentGranted: false,
      selectedReplyOptionText: "Cancel",
    }),
    activeActionRequest: activeRequest,
  });
  assert.equal(reject.actionDecision, "reject");
  assert.equal(reject.reason, "exact_pending_choice");
});

test("an older choice in the same Turn cannot grant consent after a newer request becomes active", () => {
  const newerIdentity = {
    ...identity,
    runId: "newer-run",
    requestId: "newer-choice-request",
  };
  const newerRequest = {
    ...activeRequest,
    ...newerIdentity,
    createdAt: 2,
  };
  const newerBlock = {
    ...sourceBlock,
    id: 42,
    content: "Run the newer request?",
    choiceRequest: newerIdentity,
  };

  const decision = resolveWorkspaceInstructionExecutionConsent({
    sessionKey,
    taskFlow: [sourceBlock, newerBlock],
    hints: hints(),
    activeActionRequest: newerRequest,
  });

  assert.deepEqual(decision, { granted: false, reason: "stale_request" });

  const actionDecision = resolveWorkspaceInstructionActionDecision({
    sessionKey,
    taskFlow: [sourceBlock, newerBlock],
    hints: hints(),
    activeActionRequest: newerRequest,
  });
  assert.deepEqual(actionDecision, {
    actionDecision: null,
    reason: "stale_request",
  });
});

test("running and ordinary pending-review owners defer FIFO while exact review actions resolve in place", () => {
  assert.equal(shouldDeferWorkspaceInstructionDispatchForActiveOwner({
    isGenerating: false,
    agentStatus: "pending_review",
    hasPendingActionRequest: true,
    hasExactPendingReviewActionDecision: false,
    cancellationFenceFailed: false,
  }), true);
  assert.equal(shouldDeferWorkspaceInstructionDispatchForActiveOwner({
    isGenerating: true,
    agentStatus: "pending_review",
    hasPendingActionRequest: true,
    hasExactPendingReviewActionDecision: true,
    cancellationFenceFailed: false,
  }), false);
  assert.equal(shouldDeferWorkspaceInstructionDispatchForActiveOwner({
    isGenerating: true,
    agentStatus: "running",
    hasPendingActionRequest: false,
    hasExactPendingReviewActionDecision: true,
    cancellationFenceFailed: false,
  }), true);
  assert.equal(shouldDeferWorkspaceInstructionDispatchForActiveOwner({
    isGenerating: true,
    agentStatus: "idle",
    hasPendingActionRequest: false,
    hasExactPendingReviewActionDecision: false,
    cancellationFenceFailed: false,
  }), true);
  assert.equal(shouldDeferWorkspaceInstructionDispatchForActiveOwner({
    isGenerating: true,
    agentStatus: "running",
    hasPendingActionRequest: false,
    hasExactPendingReviewActionDecision: false,
    cancellationFenceFailed: true,
  }), false);
  assert.equal(shouldDeferWorkspaceInstructionDispatchForActiveOwner({
    isGenerating: false,
    agentStatus: "idle",
    hasPendingActionRequest: true,
    hasExactPendingReviewActionDecision: false,
    cancellationFenceFailed: false,
  }), true);
  assert.equal(shouldDeferWorkspaceInstructionDispatchForActiveOwner({
    isGenerating: false,
    agentStatus: "idle",
    hasPendingActionRequest: false,
    hasExactPendingReviewActionDecision: false,
    cancellationFenceFailed: false,
  }), false);
});
