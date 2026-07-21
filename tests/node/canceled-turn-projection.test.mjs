import test from "node:test";
import assert from "node:assert/strict";
import fsSync from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";

const moduleCache = new Map();

function loadTranspiledModuleSync(sourcePath) {
  const normalizedPath = path.resolve(sourcePath);
  if (moduleCache.has(normalizedPath)) return moduleCache.get(normalizedPath);
  const source = fsSync.readFileSync(normalizedPath, "utf8");
  const localRequire = createRequire(normalizedPath);
  const transpiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    fileName: normalizedPath,
  }).outputText;
  const module = { exports: {} };
  moduleCache.set(normalizedPath, module.exports);
  const runtimeRequire = (specifier) => {
    if (specifier.startsWith(".")) {
      const basePath = path.resolve(path.dirname(normalizedPath), specifier);
      for (const candidate of [basePath, `${basePath}.ts`, `${basePath}.tsx`, path.join(basePath, "index.ts")]) {
        if (fsSync.existsSync(candidate) && /\.tsx?$/.test(candidate)) {
          return loadTranspiledModuleSync(candidate);
        }
      }
    }
    return localRequire(specifier);
  };
  new Function("exports", "module", "require", transpiled)(module.exports, module, runtimeRequire);
  moduleCache.set(normalizedPath, module.exports);
  return module.exports;
}

const {
  captureCanceledTurnControlPlaneFence,
  projectCanceledTurn,
} = loadTranspiledModuleSync(
  path.join(process.cwd(), "src/lib/canceledTurnProjection.ts"),
);

function turn(overrides = {}) {
  return {
    id: "turn-1",
    userPrompt: "Run a task",
    title: "Run a task",
    mode: "edit",
    intent: "execute",
    status: "executing",
    summary: "",
    blockIds: [1],
    collapsed: false,
    createdAt: 1,
    ...overrides,
  };
}

function pendingRequest(overrides = {}) {
  return {
    schemaVersion: 1,
    requestId: "request-1",
    kind: "tool_permission",
    sessionKey: "session-1",
    turnId: "turn-1",
    runId: "run-1",
    parentRunId: null,
    title: "Approve tool",
    status: "pending",
    createdAt: 2,
    taskId: 1,
    toolName: "shell",
    target: "pwd",
    ...overrides,
  };
}

function state(overrides = {}) {
  return {
    currentTurnId: "turn-1",
    taskFlow: [{
      id: 1,
      turnId: "turn-1",
      type: "agent",
      content: "Working",
      streaming: false,
      visibility: "assistant_update",
    }],
    conversationTurns: [turn()],
    runtimeEvents: [{
      schemaVersion: 2,
      type: "run.started",
      threadId: "session-1",
      turnId: "turn-1",
      timestampMs: 2,
      runId: "run-1",
      parentRunId: null,
    }],
    activeActionRequest: pendingRequest(),
    harnessRunMarker: {
      schemaVersion: 1,
      runId: "lease-1",
      activeRunId: "run-1",
      activeParentRunId: null,
      instanceId: "instance-1",
      sessionKey: "session-1",
      turnId: "turn-1",
      status: "running",
      updatedAt: 2,
      closedAt: null,
      closeReason: null,
    },
    agentStatus: "running",
    isGenerating: true,
    abortController: { abort() {} },
    pendingReviewResolve() {},
    pendingReviewTaskId: 1,
    pendingToolCall: { id: "tool-1" },
    ...overrides,
  };
}

test("cross-Session control residue cannot keep the canceled Session busy", () => {
  const foreignMarker = {
    ...state().harnessRunMarker,
    sessionKey: "session-old",
    turnId: "turn-old",
    status: "paused",
  };
  const foreignAction = pendingRequest({
    requestId: "request-old",
    sessionKey: "session-old",
    turnId: "turn-old",
    runId: "run-old",
  });
  const initial = state({
    harnessRunMarker: foreignMarker,
    activeActionRequest: foreignAction,
  });

  const result = projectCanceledTurn({
    state: initial,
    sessionKey: "session-1",
    turnId: "turn-1",
    reason: "user_cancelled",
    message: "Canceled and closed.",
    nextTaskId: () => 2,
    nowMs: 10,
  });

  assert.equal(result.disposition, "committed");
  assert.equal(result.state.conversationTurns[0].status, "done");
  assert.equal(result.state.agentStatus, "idle");
  assert.equal(result.state.isGenerating, false);
  assert.equal(result.state.abortController, null);
  assert.equal(result.state.harnessRunMarker, foreignMarker);
  assert.equal(result.state.activeActionRequest, foreignAction);
  assert.equal(result.state.pendingReviewResolve, initial.pendingReviewResolve);
  assert.equal(result.state.pendingReviewTaskId, initial.pendingReviewTaskId);
  assert.equal(result.state.pendingToolCall, initial.pendingToolCall);
  assert.equal(
    result.state.runtimeEvents.filter((event) =>
      event.type === "turn.completed" && event.threadId === "session-1"
    ).length,
    1,
  );
});

test("canceling a running run closes the same run and publishes one visible conclusion", () => {
  const initial = state();
  const result = projectCanceledTurn({
    state: initial,
    sessionKey: "session-1",
    turnId: "turn-1",
    reason: "user_cancelled",
    message: "Canceled and closed.",
    nextTaskId: () => 2,
    nowMs: 10,
  });

  assert.notEqual(result.state, initial);
  assert.equal(result.cancellationRunId, "run-1");
  assert.deepEqual(result.state.runtimeEvents.map((event) => event.type), [
    "run.started",
    "run.aborted",
    "run.completed",
    "turn.completed",
  ]);
  assert.equal(result.state.runtimeEvents.at(-3).runId, "run-1");
  assert.equal(result.state.runtimeEvents.at(-3).reason, "user_cancelled");
  assert.equal(result.state.runtimeEvents.at(-2).runId, "run-1");
  assert.equal(result.state.runtimeEvents.at(-2).resultKind, "canceled");
  assert.equal(result.state.runtimeEvents.at(-1).resultKind, "canceled");
  assert.equal(result.state.conversationTurns[0].status, "done");
  assert.deepEqual(result.state.conversationTurns[0].runtimeOutcome, {
    status: "completed",
    reason: "user_cancelled",
    resultKind: "canceled",
    runId: "run-1",
    parentRunId: null,
    updatedAt: 10,
  });
  assert.deepEqual(result.state.conversationTurns[0].blockIds, [1, 2]);
  assert.equal(result.state.taskFlow.filter((block) => block.visibility === "assistant_final").length, 1);
  assert.equal(result.state.taskFlow.at(-1).content, "Canceled and closed.");
  assert.equal(result.state.activeActionRequest, null);
  assert.equal(result.state.pendingReviewResolve, null);
  assert.equal(result.state.pendingReviewTaskId, null);
  assert.equal(result.state.pendingToolCall, null);
  assert.equal(result.state.agentStatus, "idle");
  assert.equal(result.state.isGenerating, false);
  assert.equal(result.state.abortController, null);
  assert.equal(result.harnessRunMarker.status, "completed");
  assert.equal(result.harnessRunMarker.activeRunId, "run-1");
  assert.equal(result.harnessRunMarker.closeReason, "user_cancelled");
});

test("canceling a pending user choice archives only its exact capability block", () => {
  const choiceRequest = {
    schemaVersion: 1,
    requestId: "choice-request-1",
    kind: "user_choice",
    sessionKey: "session-1",
    turnId: "turn-1",
    runId: "run-1",
    parentRunId: null,
    title: "Choose a direction",
    status: "pending",
    createdAt: 2,
    optionValues: ["Continue", "Pause"],
    allowCustomReply: true,
  };
  const staleChoiceRequest = {
    ...choiceRequest,
    requestId: "choice-request-stale",
  };
  const initial = state({
    activeActionRequest: choiceRequest,
    taskFlow: [
      {
        id: 1,
        turnId: "turn-1",
        type: "agent",
        content: "Choose the next step.",
        streaming: false,
        options: [
          { label: "Continue", value: "Continue" },
          { label: "Pause", value: "Pause" },
        ],
        choiceRequest,
      },
      {
        id: 2,
        turnId: "turn-1",
        type: "agent",
        content: "Stale choice must remain untouched.",
        streaming: false,
        options: [{ label: "Old", value: "Old" }],
        choiceRequest: staleChoiceRequest,
      },
    ],
    conversationTurns: [turn({ blockIds: [1, 2] })],
    pendingReviewResolve: null,
    pendingReviewTaskId: null,
    pendingToolCall: null,
  });

  const result = projectCanceledTurn({
    state: initial,
    sessionKey: "session-1",
    turnId: "turn-1",
    reason: "goal_cleared",
    message: "Goal cleared; turn closed.",
    nextTaskId: () => 3,
    nowMs: 10,
  });

  assert.equal(result.disposition, "committed");
  assert.equal(result.state.activeActionRequest, null);
  assert.equal(result.state.taskFlow[0].options, undefined);
  assert.equal(result.state.taskFlow[0].choiceRequest, undefined);
  assert.equal(result.state.taskFlow[0].archivedAfterChoice, true);
  assert.deepEqual(result.state.taskFlow[1].options, [{ label: "Old", value: "Old" }]);
  assert.equal(result.state.taskFlow[1].choiceRequest.requestId, "choice-request-stale");
  assert.equal(result.state.conversationTurns[0].status, "done");
  assert.equal(result.state.conversationTurns[0].runtimeOutcome.resultKind, "canceled");
});

test("canceling a paused run concludes that same run through the canonical cancellation sequence", () => {
  const initial = state({
    runtimeEvents: [
      {
        schemaVersion: 2,
        type: "run.started",
        threadId: "session-1",
        turnId: "turn-1",
        timestampMs: 2,
        runId: "run-1",
        parentRunId: null,
      },
      {
        schemaVersion: 2,
        type: "run.paused",
        threadId: "session-1",
        turnId: "turn-1",
        timestampMs: 3,
        runId: "run-1",
        parentRunId: null,
        reason: "awaiting_approval",
        message: "Approve the tool.",
      },
    ],
    harnessRunMarker: {
      ...state().harnessRunMarker,
      status: "paused",
    },
  });
  const result = projectCanceledTurn({
    state: initial,
    sessionKey: "session-1",
    turnId: "turn-1",
    reason: "approval_rejected",
    message: "Approval rejected; turn closed.",
    nextTaskId: () => 2,
    nowMs: 10,
  });

  assert.equal(result.cancellationRunId, "run-1");
  assert.deepEqual(result.state.runtimeEvents.map((event) => event.type), [
    "run.started",
    "run.paused",
    "run.aborted",
    "run.completed",
    "turn.completed",
  ]);
  const aborted = result.state.runtimeEvents.at(-3);
  const completed = result.state.runtimeEvents.at(-2);
  assert.equal(aborted.runId, "run-1");
  assert.equal(aborted.parentRunId, null);
  assert.equal(completed.runId, "run-1");
  assert.equal(completed.parentRunId, null);
  assert.equal(completed.resultKind, "canceled");
  assert.equal(result.state.conversationTurns[0].runtimeOutcome.runId, "run-1");
  assert.equal(result.state.conversationTurns[0].runtimeOutcome.parentRunId, null);
  assert.equal(result.harnessRunMarker.activeRunId, "run-1");
  assert.equal(result.harnessRunMarker.activeParentRunId, null);
});

test("an already completed logical turn is immutable under a late cancel", () => {
  const initial = state({
    conversationTurns: [turn({ status: "done" })],
    harnessRunMarker: null,
    activeActionRequest: null,
    agentStatus: "idle",
    isGenerating: false,
    abortController: null,
    pendingReviewResolve: null,
    pendingReviewTaskId: null,
    pendingToolCall: null,
    runtimeEvents: [{
      schemaVersion: 2,
      type: "turn.completed",
      threadId: "session-1",
      turnId: "turn-1",
      timestampMs: 9,
      resultKind: "success",
    }],
  });
  const result = projectCanceledTurn({
    state: initial,
    sessionKey: "session-1",
    turnId: "turn-1",
    reason: "late_cancel",
    message: "Should not overwrite.",
    nextTaskId: () => 2,
    nowMs: 10,
    runId: "run-late",
  });

  assert.equal(result.state, initial);
  assert.equal(result.cancellationRunId, "run-late");
  assert.deepEqual(result.state.runtimeEvents, initial.runtimeEvents);
  assert.equal(result.state.conversationTurns[0].status, "done");
});

test("an already closed current Turn repairs only stale transient controls", () => {
  const initial = state({
    conversationTurns: [turn({ status: "done" })],
    taskFlow: [{
      id: 1,
      turnId: "turn-1",
      type: "agent",
      content: "Canceled and closed.",
      streaming: false,
      visibility: "assistant_final",
    }],
    runtimeEvents: [
      state().runtimeEvents[0],
      {
        schemaVersion: 2,
        type: "run.completed",
        threadId: "session-1",
        turnId: "turn-1",
        timestampMs: 8,
        runId: "run-1",
        parentRunId: null,
        resultKind: "canceled",
        summary: "Canceled and closed.",
      },
      {
        schemaVersion: 2,
        type: "turn.completed",
        threadId: "session-1",
        turnId: "turn-1",
        timestampMs: 9,
        resultKind: "canceled",
      },
    ],
  });
  const result = projectCanceledTurn({
    state: initial,
    sessionKey: "session-1",
    turnId: "turn-1",
    runId: "run-1",
    reason: "user_cancelled",
    message: "Canceled and closed.",
    nextTaskId: () => 2,
    nowMs: 10,
    controlPlaneFence: captureCanceledTurnControlPlaneFence({
      state: initial,
      sessionKey: "session-1",
      turnId: "turn-1",
      runId: "run-1",
    }),
  });

  assert.equal(result.disposition, "already_closed");
  assert.notEqual(result.state, initial);
  assert.deepEqual(result.state.runtimeEvents, initial.runtimeEvents);
  assert.deepEqual(result.state.taskFlow, initial.taskFlow);
  assert.equal(result.state.agentStatus, "idle");
  assert.equal(result.state.isGenerating, false);
  assert.equal(result.state.abortController, null);
});

test("an already closed Turn cannot clear a successor controller before its marker is visible", () => {
  const capturedController = { abort() {} };
  const successorController = { abort() {} };
  const initial = state({
    conversationTurns: [turn({ status: "done" })],
    taskFlow: [{
      id: 1,
      turnId: "turn-1",
      type: "agent",
      content: "Already complete.",
      streaming: false,
      visibility: "assistant_final",
    }],
    runtimeEvents: [
      state().runtimeEvents[0],
      {
        schemaVersion: 2,
        type: "run.completed",
        threadId: "session-1",
        turnId: "turn-1",
        timestampMs: 8,
        runId: "run-1",
        parentRunId: null,
        resultKind: "success",
        summary: "Already complete.",
      },
      {
        schemaVersion: 2,
        type: "turn.completed",
        threadId: "session-1",
        turnId: "turn-1",
        timestampMs: 9,
        resultKind: "success",
      },
    ],
    harnessRunMarker: null,
    activeActionRequest: null,
    abortController: successorController,
  });
  const result = projectCanceledTurn({
    state: initial,
    sessionKey: "session-1",
    turnId: "turn-1",
    runId: "run-1",
    reason: "late_cancel",
    message: "Must not clear successor.",
    nextTaskId: () => 2,
    nowMs: 10,
    controlPlaneFence: captureCanceledTurnControlPlaneFence({
      state: { ...initial, abortController: capturedController },
      sessionKey: "session-1",
      turnId: "turn-1",
      runId: "run-1",
    }),
  });

  assert.equal(result.disposition, "already_closed");
  assert.equal(result.state, initial);
  assert.equal(result.state.abortController, successorController);
  assert.equal(result.state.isGenerating, true);
  assert.equal(result.state.agentStatus, "running");
});

test("an already closed Turn preserves cross-Session residue while converging its own busy flags", () => {
  const foreignMarker = {
    ...state().harnessRunMarker,
    sessionKey: "session-foreign",
    turnId: "turn-foreign",
    runId: "lease-foreign",
    activeRunId: "run-foreign",
  };
  const foreignAction = pendingRequest({
    requestId: "request-foreign",
    sessionKey: "session-foreign",
    turnId: "turn-foreign",
    runId: "run-foreign",
  });
  const initial = state({
    conversationTurns: [turn({ status: "done" })],
    taskFlow: [{
      id: 1,
      turnId: "turn-1",
      type: "agent",
      content: "Already complete.",
      streaming: false,
      visibility: "assistant_final",
    }],
    runtimeEvents: [
      state().runtimeEvents[0],
      {
        schemaVersion: 2,
        type: "run.completed",
        threadId: "session-1",
        turnId: "turn-1",
        timestampMs: 8,
        runId: "run-1",
        parentRunId: null,
        resultKind: "success",
        summary: "Already complete.",
      },
      {
        schemaVersion: 2,
        type: "turn.completed",
        threadId: "session-1",
        turnId: "turn-1",
        timestampMs: 9,
        resultKind: "success",
      },
    ],
    harnessRunMarker: foreignMarker,
    activeActionRequest: foreignAction,
  });
  const result = projectCanceledTurn({
    state: initial,
    sessionKey: "session-1",
    turnId: "turn-1",
    runId: "run-1",
    reason: "late_cancel",
    message: "Must not rewrite the conclusion.",
    nextTaskId: () => 2,
    nowMs: 10,
    controlPlaneFence: captureCanceledTurnControlPlaneFence({
      state: initial,
      sessionKey: "session-1",
      turnId: "turn-1",
      runId: "run-1",
    }),
  });

  assert.equal(result.disposition, "already_closed");
  assert.deepEqual(result.state.runtimeEvents, initial.runtimeEvents);
  assert.deepEqual(result.state.taskFlow, initial.taskFlow);
  assert.equal(result.state.isGenerating, false);
  assert.equal(result.state.agentStatus, "idle");
  assert.equal(result.state.abortController, null);
  assert.equal(result.state.harnessRunMarker, foreignMarker);
  assert.equal(result.state.activeActionRequest, foreignAction);
  assert.equal(result.state.pendingReviewResolve, initial.pendingReviewResolve);
  assert.equal(result.state.pendingReviewTaskId, initial.pendingReviewTaskId);
  assert.equal(result.state.pendingToolCall, initial.pendingToolCall);
});

test("an already closed Turn cannot clear a newer attempt that reuses its Run and controller", () => {
  const terminalState = state({
    conversationTurns: [turn({ status: "done" })],
    taskFlow: [{
      id: 1,
      turnId: "turn-1",
      type: "agent",
      content: "Already complete.",
      streaming: false,
      visibility: "assistant_final",
    }],
    runtimeEvents: [
      state().runtimeEvents[0],
      {
        schemaVersion: 2,
        type: "run.completed",
        threadId: "session-1",
        turnId: "turn-1",
        timestampMs: 8,
        runId: "run-1",
        parentRunId: null,
        resultKind: "success",
        summary: "Already complete.",
      },
      {
        schemaVersion: 2,
        type: "turn.completed",
        threadId: "session-1",
        turnId: "turn-1",
        timestampMs: 9,
        resultKind: "success",
      },
    ],
  });
  const fence = captureCanceledTurnControlPlaneFence({
    state: terminalState,
    sessionKey: "session-1",
    turnId: "turn-1",
    runId: "run-1",
  });
  const successorMarker = {
    ...terminalState.harnessRunMarker,
    runId: "lease-attempt-2",
    activeRunId: "run-1",
    instanceId: "instance-attempt-2",
  };
  const successorState = {
    ...terminalState,
    harnessRunMarker: successorMarker,
  };
  const result = projectCanceledTurn({
    state: successorState,
    sessionKey: "session-1",
    turnId: "turn-1",
    runId: "run-1",
    reason: "late_cancel",
    message: "Must not clear the replacement attempt.",
    nextTaskId: () => 2,
    nowMs: 10,
    controlPlaneFence: fence,
  });

  assert.equal(result.disposition, "already_closed");
  assert.equal(result.state, successorState);
  assert.equal(result.state.harnessRunMarker, successorMarker);
  assert.equal(result.state.isGenerating, true);
  assert.equal(result.state.abortController, terminalState.abortController);
});

test("a late Stop cannot rewrite a successful Turn's Harness meaning as cancellation", () => {
  const initial = state({
    conversationTurns: [turn({
      status: "done",
      summary: "Work completed successfully.",
      runtimeOutcome: {
        status: "completed",
        resultKind: "success",
        reason: "agent_loop_completed",
        runId: "run-1",
        parentRunId: null,
        updatedAt: 9,
      },
    })],
    taskFlow: [{
      id: 1,
      turnId: "turn-1",
      type: "agent",
      content: "Work completed successfully.",
      streaming: false,
      visibility: "assistant_final",
    }],
    runtimeEvents: [
      state().runtimeEvents[0],
      {
        schemaVersion: 2,
        type: "run.completed",
        threadId: "session-1",
        turnId: "turn-1",
        timestampMs: 9,
        runId: "run-1",
        parentRunId: null,
        resultKind: "success",
        summary: "Work completed successfully.",
      },
      {
        schemaVersion: 2,
        type: "turn.completed",
        threadId: "session-1",
        turnId: "turn-1",
        timestampMs: 9,
        resultKind: "success",
      },
    ],
  });
  const result = projectCanceledTurn({
    state: initial,
    sessionKey: "session-1",
    turnId: "turn-1",
    runId: "run-1",
    reason: "late_user_cancelled",
    message: "Must not become canceled.",
    nextTaskId: () => 2,
    nowMs: 10,
    controlPlaneFence: captureCanceledTurnControlPlaneFence({
      state: initial,
      sessionKey: "session-1",
      turnId: "turn-1",
      runId: "run-1",
    }),
  });

  assert.equal(result.disposition, "already_closed");
  assert.deepEqual(result.state.runtimeEvents, initial.runtimeEvents);
  assert.deepEqual(result.state.taskFlow, initial.taskFlow);
  assert.equal(result.state.harnessRunMarker?.status, "completed");
  assert.equal(result.state.harnessRunMarker?.closeReason, "agent_loop_completed");
  assert.equal(result.state.isGenerating, false);
});

for (const [resultKind, expectedCloseReason] of [
  ["partial", "agent_loop_partial"],
  ["blocked", "agent_loop_blocked"],
]) {
  test(`a late Stop preserves an event-owned ${resultKind} terminal meaning`, () => {
    const initial = state({
      conversationTurns: [turn({
        status: "done",
        summary: `Turn ended as ${resultKind}.`,
      })],
      runtimeEvents: [
        state().runtimeEvents[0],
        {
          schemaVersion: 2,
          type: "run.completed",
          threadId: "session-1",
          turnId: "turn-1",
          timestampMs: 9,
          runId: "run-1",
          parentRunId: null,
          resultKind,
          summary: `Turn ended as ${resultKind}.`,
        },
        {
          schemaVersion: 2,
          type: "turn.completed",
          threadId: "session-1",
          turnId: "turn-1",
          timestampMs: 9,
          resultKind,
        },
      ],
    });
    const result = projectCanceledTurn({
      state: initial,
      sessionKey: "session-1",
      turnId: "turn-1",
      runId: "run-1",
      reason: "late_user_cancelled",
      message: "Must not rewrite the terminal meaning.",
      nextTaskId: () => 2,
      nowMs: 10,
      controlPlaneFence: captureCanceledTurnControlPlaneFence({
        state: initial,
        sessionKey: "session-1",
        turnId: "turn-1",
        runId: "run-1",
      }),
    });

    assert.equal(result.disposition, "already_closed");
    assert.deepEqual(result.state.runtimeEvents, initial.runtimeEvents);
    assert.equal(result.state.harnessRunMarker?.status, "completed");
    assert.equal(result.state.harnessRunMarker?.terminalResultKind, resultKind);
    assert.equal(result.state.harnessRunMarker?.closeReason, expectedCloseReason);
    assert.equal(result.state.isGenerating, false);
  });
}

test("closing an old turn preserves the control plane owned by a newer turn", () => {
  const newerAbortController = { abort() {} };
  const newerPendingResolve = () => {};
  const newerRequest = pendingRequest({
    requestId: "request-new",
    turnId: "turn-2",
    runId: "run-new",
    taskId: 22,
  });
  const newerMarker = {
    ...state().harnessRunMarker,
    runId: "lease-new",
    activeRunId: "run-new",
    turnId: "turn-2",
  };
  const initial = state({
    conversationTurns: [
      turn(),
      turn({ id: "turn-2", status: "executing", blockIds: [] }),
    ],
    activeActionRequest: newerRequest,
    harnessRunMarker: newerMarker,
    abortController: newerAbortController,
    pendingReviewResolve: newerPendingResolve,
    pendingReviewTaskId: 22,
    pendingToolCall: { id: "tool-new" },
  });
  const result = projectCanceledTurn({
    state: initial,
    sessionKey: "session-1",
    turnId: "turn-1",
    runId: "run-old",
    reason: "late_cancel",
    message: "Old turn closed.",
    nextTaskId: () => 2,
    nowMs: 10,
  });

  assert.equal(result.state.conversationTurns[0].status, "done");
  assert.equal(result.state.conversationTurns[1].status, "executing");
  assert.equal(result.state.harnessRunMarker, newerMarker);
  assert.equal(result.state.activeActionRequest, newerRequest);
  assert.equal(result.state.agentStatus, "running");
  assert.equal(result.state.isGenerating, true);
  assert.equal(result.state.abortController, newerAbortController);
  assert.equal(result.state.pendingReviewResolve, newerPendingResolve);
  assert.equal(result.state.pendingReviewTaskId, 22);
  assert.deepEqual(result.state.pendingToolCall, { id: "tool-new" });
  assert.equal(result.state.runtimeEvents.at(-3).type, "run.aborted");
  assert.equal(result.state.runtimeEvents.at(-3).runId, "run-old");
  assert.equal(result.state.runtimeEvents.at(-2).type, "run.completed");
  assert.equal(result.state.runtimeEvents.at(-2).resultKind, "canceled");
  assert.equal(result.state.runtimeEvents.at(-1).type, "turn.completed");
});

test("an explicit stale run cannot close or inherit lineage from a newer owner on the same logical turn", () => {
  const newerAbortController = { abort() {} };
  const newerRequest = pendingRequest({
    requestId: "request-new",
    runId: "run-new",
    parentRunId: "run-new-parent",
  });
  const newerMarker = {
    ...state().harnessRunMarker,
    runId: "lease-new",
    activeRunId: "run-new",
    activeParentRunId: "run-new-parent",
    parentRunId: "run-new-parent",
  };
  const initial = state({
    activeActionRequest: newerRequest,
    harnessRunMarker: newerMarker,
    abortController: newerAbortController,
  });
  const result = projectCanceledTurn({
    state: initial,
    sessionKey: "session-1",
    turnId: "turn-1",
    runId: "run-old",
    reason: "late_cancel",
    message: "Old run closed.",
    nextTaskId: () => 2,
    nowMs: 10,
  });

  assert.equal(result.disposition, "ownership_lost");
  assert.equal(result.state, initial);
  assert.equal(result.state.conversationTurns[0].status, "executing");
  assert.equal(result.state.harnessRunMarker, newerMarker);
  assert.equal(result.state.activeActionRequest, newerRequest);
  assert.equal(result.state.abortController, newerAbortController);
  assert.equal(result.state.agentStatus, "running");
  assert.equal(result.state.runtimeEvents.length, initial.runtimeEvents.length);
  assert.equal(result.state.runtimeEvents.some((event) => event.type === "turn.completed"), false);
  assert.equal(result.state.taskFlow.length, initial.taskFlow.length);
});

test("an existing aborted run remains the canonical reason when the missing Turn terminal is repaired", () => {
  const initial = state({
    runtimeEvents: [
      {
        schemaVersion: 2,
        type: "run.started",
        threadId: "session-1",
        turnId: "turn-1",
        timestampMs: 2,
        runId: "run-1",
        parentRunId: null,
      },
      {
        schemaVersion: 2,
        type: "run.aborted",
        threadId: "session-1",
        turnId: "turn-1",
        timestampMs: 3,
        runId: "run-1",
        parentRunId: null,
        reason: "provider_cancelled",
        message: "Provider request was canceled.",
      },
    ],
  });
  const result = projectCanceledTurn({
    state: initial,
    sessionKey: "session-1",
    turnId: "turn-1",
    reason: "different_late_reason",
    message: "A conflicting late message.",
    nextTaskId: () => 2,
    nowMs: 10,
  });

  assert.deepEqual(result.state.runtimeEvents.map((event) => event.type), [
    "run.started",
    "run.aborted",
    "run.completed",
    "turn.completed",
  ]);
  assert.equal(result.state.runtimeEvents.at(-2).resultKind, "canceled");
  assert.equal(result.state.conversationTurns[0].runtimeOutcome.reason, "provider_cancelled");
  assert.equal(result.state.conversationTurns[0].summary, "Provider request was canceled.");
  assert.equal(result.state.taskFlow.at(-1).content, "Provider request was canceled.");
  assert.equal(result.harnessRunMarker.closeReason, "provider_cancelled");
});
