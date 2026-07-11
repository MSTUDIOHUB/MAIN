import test from "node:test";
import assert from "node:assert/strict";
import fsSync from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

import ts from "typescript";

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

const completionGuardsModule = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/lib/orchestrator/loop/completionGuards.ts"),
);

const {
  resolveNonActionableStopOutcome,
  runApprovedPlanCompletionGuard,
  runExecutionEvidenceCompletionGuard,
} = completionGuardsModule;

function loadAgentLoopRunnerWithFake(FakeAgentOrchestrator, logEvents) {
  const sourcePath = path.join(workspaceRoot, "src/lib/orchestrator/loop/AgentLoopRunner.ts");
  const source = fsSync.readFileSync(sourcePath, "utf8");
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
    fileName: sourcePath,
  }).outputText;
  const module = { exports: {} };
  const localRequire = createRequire(sourcePath);
  const runtimeRequire = (specifier) => {
    if (specifier === "../../orchestrator") {
      return {
        logAgentEvent: (event, data) => logEvents.push({ event, data }),
      };
    }
    if (specifier === "./AgentOrchestrator") {
      return { AgentOrchestrator: FakeAgentOrchestrator };
    }
    if (specifier === "./completionGuards") {
      return completionGuardsModule;
    }
    return localRequire(specifier);
  };
  const factory = new Function("exports", "module", "require", transpiled);
  factory(module.exports, module, runtimeRequire);
  return module.exports;
}

function createCallbacks(overrides = {}) {
  const events = {
    stops: [],
    statuses: [],
  };
  const callbacks = {
    getPreferredLanguage: () => "zh",
    getWorkflowMode: () => "chat",
    getIsPlanApproved: () => false,
    getPlanTasks: () => [],
    getPlanExecutionEvidenceLedger: () => [],
    onNonActionableStop: (message, reason, progress) => {
      events.stops.push({ message, reason, progress });
    },
    onStatusChange: (status) => {
      events.statuses.push(status);
    },
    ...overrides,
  };
  return { callbacks, events };
}

test("completion guard maps non-actionable stops to structured loop outcomes", () => {
  assert.deepEqual(resolveNonActionableStopOutcome("no_output"), {
    status: "stopped_no_output",
    reason: "no_output",
  });
  assert.deepEqual(resolveNonActionableStopOutcome("incomplete_plan"), {
    status: "paused",
    reason: "incomplete_plan",
  });
  assert.deepEqual(
    resolveNonActionableStopOutcome("incomplete_plan", {
      recoveryReason: "approved_plan_completion_guard_no_evidence",
    }),
    {
      status: "stopped_no_action",
      reason: "approved_plan_completion_guard_no_evidence",
    },
  );
  assert.deepEqual(
    resolveNonActionableStopOutcome("incomplete_plan", {
      recoveryReason: "preapproval_plan_quality_recovery_stream_timeout",
    }),
    {
      status: "paused",
      reason: "preapproval_plan_quality_recovery_stream_timeout",
    },
  );
});

test("execution evidence completion guard pauses completed execute turns without evidence", () => {
  const { callbacks, events } = createCallbacks();
  const result = runExecutionEvidenceCompletionGuard({
    outcome: { status: "completed", reason: "agent_loop_completed" },
    callbacks,
    finalTurnContract: {
      conversationIntent: "execute",
      runtimeIntent: "execute",
      approvalState: "approved",
      mutationExpected: true,
      completionEvidenceRequired: "execution_evidence",
    },
    approvedPlanAlreadyAudited: false,
    sawExecutionEvidence: false,
  });

  assert.deepEqual(result, {
    status: "stopped_no_action",
    reason: "execution_evidence_required",
  });
  assert.equal(events.stops.length, 1);
  assert.equal(events.stops[0].reason, "no_action");
  assert.equal(events.statuses.at(-1), "idle");
});

test("execution evidence completion guard allows turns that already have evidence", () => {
  const { callbacks, events } = createCallbacks();
  const result = runExecutionEvidenceCompletionGuard({
    outcome: { status: "completed", reason: "agent_loop_completed" },
    callbacks,
    finalTurnContract: {
      conversationIntent: "execute",
      runtimeIntent: "execute",
      approvalState: "approved",
      mutationExpected: true,
      completionEvidenceRequired: "execution_evidence",
    },
    approvedPlanAlreadyAudited: false,
    sawExecutionEvidence: true,
  });

  assert.equal(result, null);
  assert.equal(events.stops.length, 0);
});

test("approved plan completion guard pauses completed plan execution without audit evidence", () => {
  const { callbacks, events } = createCallbacks({
    getWorkflowMode: () => "plan",
    getIsPlanApproved: () => true,
  });
  const result = runApprovedPlanCompletionGuard({
    outcome: { status: "completed", reason: "agent_loop_completed" },
    callbacks,
    sawExecutionEvidence: false,
  });

  assert.deepEqual(result, {
    status: "stopped_no_action",
    reason: "approved_plan_completion_guard",
  });
  assert.equal(events.stops.length, 1);
  assert.equal(events.stops[0].reason, "incomplete_plan");
  assert.equal(events.stops[0].progress.recoveryReason, "approved_plan_completion_guard_no_evidence");
  assert.equal(events.statuses.at(-1), "idle");
});

test("approved plan completion is deferred until the current loop consumes the execution transition", () => {
  const { callbacks, events } = createCallbacks({
    getWorkflowMode: () => "plan",
    getIsPlanApproved: () => true,
    getIsApprovedPlanExecutionTransitionPending: () => true,
  });
  const result = runApprovedPlanCompletionGuard({
    outcome: { status: "completed", reason: "agent_loop_completed" },
    callbacks,
    sawExecutionEvidence: false,
  });

  assert.deepEqual(result, {
    status: "paused",
    reason: "approved_plan_same_turn_execution_pending",
  });
  assert.equal(events.stops.length, 0);
  assert.equal(events.statuses.length, 0);
});

test("approved plan recovery without a pending approval transition still runs the evidence guard", () => {
  const { callbacks, events } = createCallbacks({
    getWorkflowMode: () => "plan",
    getIsPlanApproved: () => true,
    getIsApprovedPlanExecutionTransitionPending: () => false,
  });
  const result = runApprovedPlanCompletionGuard({
    outcome: { status: "completed", reason: "agent_loop_completed" },
    callbacks,
    sawExecutionEvidence: false,
  });

  assert.deepEqual(result, {
    status: "stopped_no_action",
    reason: "approved_plan_completion_guard",
  });
  assert.equal(events.stops.length, 1);
});

test("agent loop runner preserves awaiting-choice pauses as a structured outcome", async () => {
  const logs = [];
  const finals = [];
  class AwaitingChoiceOrchestrator {
    async execute(callbacks) {
      callbacks.onAssistantFinalText(
        "Choose a path",
        [{ id: "continue", label: "Continue", value: "continue" }],
        { awaitingInput: true },
      );
    }

    getLatestTurnContract() {
      return {
        conversationIntent: "respond",
        runtimeIntent: "respond",
        approvalState: "not_required",
        mutationExpected: false,
        completionEvidenceRequired: "none",
      };
    }

    hasExecuteOperationEvidence() {
      return false;
    }
  }
  const { executeAgentLoop } = loadAgentLoopRunnerWithFake(
    AwaitingChoiceOrchestrator,
    logs,
  );
  const outcome = await executeAgentLoop({
    getWorkflowMode: () => "chat",
    getIsPlanApproved: () => false,
    onAssistantFinalText: (...args) => finals.push(args),
    onNonActionableStop: () => {},
    onError: () => {},
  }, new AbortController());

  assert.deepEqual(outcome, {
    status: "paused",
    reason: "awaiting_user_choice",
  });
  assert.equal(finals.length, 1);
  assert.deepEqual(logs, [{
    event: "agent_loop_awaiting_user_choice",
    data: { replyOptions: 1 },
  }]);
});

test("agent loop runner preserves a bounded error reason for Goal Runtime diagnostics", async () => {
  class FailingOrchestrator {
    async execute(callbacks) {
      callbacks.onError("STREAM_NO_VISIBLE_PROGRESS_TIMEOUT: model stream stalled");
    }

    getLatestTurnContract() {
      return {
        conversationIntent: "execute",
        runtimeIntent: "goal",
        approvalState: "approved",
        mutationExpected: true,
        completionEvidenceRequired: "execution_evidence",
      };
    }

    hasExecuteOperationEvidence() {
      return false;
    }
  }
  const { executeAgentLoop } = loadAgentLoopRunnerWithFake(FailingOrchestrator, []);
  const errors = [];
  const outcome = await executeAgentLoop({
    getWorkflowMode: () => "edit",
    getIsPlanApproved: () => false,
    onAssistantFinalText: () => {},
    onNonActionableStop: () => {},
    onError: (error) => errors.push(error),
  }, new AbortController());

  assert.deepEqual(outcome, {
    status: "error",
    reason: "agent_loop_error: STREAM_NO_VISIBLE_PROGRESS_TIMEOUT: model stream stalled",
  });
  assert.deepEqual(errors, ["STREAM_NO_VISIBLE_PROGRESS_TIMEOUT: model stream stalled"]);
});

test("a run.paused boundary cannot fall through as agent_loop_completed", async () => {
  class ReviewPausedOrchestrator {
    async execute() {}

    getLatestRunPauseReason() {
      return "plan_review_required";
    }

    getLatestTurnContract() {
      return {
        conversationIntent: "plan",
        runtimeIntent: "plan",
        approvalState: "required",
        mutationExpected: false,
        completionEvidenceRequired: "none",
      };
    }

    hasExecuteOperationEvidence() {
      return false;
    }
  }
  const { executeAgentLoop } = loadAgentLoopRunnerWithFake(ReviewPausedOrchestrator, []);
  const outcome = await executeAgentLoop({
    getWorkflowMode: () => "plan",
    getIsPlanApproved: () => false,
    onAssistantFinalText: () => {},
    onNonActionableStop: () => {},
    onError: () => {},
  }, new AbortController());

  assert.deepEqual(outcome, {
    status: "paused",
    reason: "plan_review_required",
  });
});

test("agent loop runner returns aborted before completion guards read final state", async () => {
  class AbortingOrchestrator {
    async execute(_callbacks, abortController) {
      abortController.abort();
    }

    getLatestTurnContract() {
      throw new Error("completion guards must not run after abort");
    }

    hasExecuteOperationEvidence() {
      throw new Error("completion guards must not run after abort");
    }
  }
  const { executeAgentLoop } = loadAgentLoopRunnerWithFake(
    AbortingOrchestrator,
    [],
  );
  const outcome = await executeAgentLoop({
    onAssistantFinalText: () => {},
    onNonActionableStop: () => {},
    onError: () => {},
  }, new AbortController());

  assert.deepEqual(outcome, {
    status: "aborted",
    reason: "agent_loop_aborted",
  });
});
