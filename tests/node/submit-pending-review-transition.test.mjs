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

const { applySubmitPendingReviewTransition } = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/store/submitPendingReviewTransition.ts"),
);
const { projectCanceledTurn } = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/lib/canceledTurnProjection.ts"),
);

function conversationTurn(overrides = {}) {
  return {
    id: "turn-1",
    userPrompt: "修复问题",
    title: "修复问题",
    mode: "edit",
    intent: "execute",
    status: "awaiting_approval",
    summary: "",
    blockIds: [1],
    collapsed: false,
    createdAt: 1,
    ...overrides,
  };
}

function createState(overrides = {}) {
  return {
    agentStatus: "pending_review",
    currentTurnId: "turn-1",
    conversationTurns: [conversationTurn()],
    taskFlow: [
      {
        id: 1,
        turnId: "turn-1",
        type: "agent",
        content: "是否执行？",
        options: [
          { label: "执行一次", value: "执行一次", action: "execute_once" },
        ],
      },
    ],
    pendingReviewTaskId: 99,
    runtimeEvents: [],
    activeActionRequest: {
      schemaVersion: 1,
      requestId: "request-review-1",
      kind: "tool_permission",
      sessionKey: "workspace::1",
      turnId: "turn-1",
      runId: "run-review-1",
      parentRunId: null,
      title: "Approve tool",
      status: "pending",
      createdAt: 1,
      taskId: 1,
      toolName: "shell",
      target: "pwd",
    },
    harnessRunMarker: null,
    abortController: null,
    pendingReviewResolve: null,
    pendingToolCall: { id: "tool-1" },
    isGenerating: true,
    ...overrides,
  };
}

function createHarness(state) {
  let nextTaskId = 1_000;
  return {
    logs: [],
    errors: [],
    cancellations: [],
    setState(patch) {
      const next = typeof patch === "function" ? patch(state) : patch;
      if (next && typeof next === "object") Object.assign(state, next);
    },
    closeTurnAsCanceled(turnId, options) {
      const projection = projectCanceledTurn({
        state,
        sessionKey: "workspace::1",
        turnId,
        reason: options.reason,
        message: options.message,
        nextTaskId: () => nextTaskId++,
        nowMs: 100,
      });
      this.cancellations.push({
        turnId,
        options,
        cancellationRunId: projection.cancellationRunId,
      });
      if (projection.state === state) return false;
      Object.assign(state, projection.state);
      return true;
    },
    logStoreEvent(event, data) {
      this.logs.push({ event, data });
    },
    logError(message, error) {
      this.errors.push({ message, error });
    },
  };
}

test("pending review transition closes the superseded source turn as canceled", () => {
  let abortCount = 0;
  const rejected = [];
  const state = createState({
    abortController: {
      abort() {
        abortCount += 1;
      },
    },
    pendingReviewResolve(decision) {
      rejected.push(decision);
    },
  });
  const harness = createHarness(state);

  const result = applySubmitPendingReviewTransition({
    text: "这是一个新的普通需求",
    state,
    getState: () => state,
    setState: harness.setState.bind(harness),
    closeTurnAsCanceled: harness.closeTurnAsCanceled.bind(harness),
    logStoreEvent: harness.logStoreEvent.bind(harness),
    logError: harness.logError.bind(harness),
  });

  assert.equal(result.aborted, true);
  assert.equal(result.state, state);
  assert.equal(result.decision.shouldAbortAndStartNewTurn, true);
  assert.equal(abortCount, 1);
  assert.deepEqual(rejected, [{ action: "reject" }]);
  assert.deepEqual(harness.logs, [
    {
      event: "send_pending_review_abort_and_new_turn",
      data: {
        textChars: 10,
        pendingReviewTaskId: 99,
      },
    },
  ]);
  assert.deepEqual(harness.errors, []);
  assert.equal(state.agentStatus, "idle");
  assert.equal(state.isGenerating, false);
  assert.equal(state.abortController, null);
  assert.equal(state.pendingReviewResolve, null);
  assert.equal(state.pendingReviewTaskId, null);
  assert.equal(state.pendingToolCall, null);
  assert.equal(state.activeActionRequest, null);
  assert.equal(state.conversationTurns[0].status, "done");
  assert.deepEqual(state.conversationTurns[0].runtimeOutcome, {
    status: "aborted",
    reason: "superseded_by_new_user_turn",
    resultKind: "canceled",
    runId: "run-review-1",
    parentRunId: null,
    updatedAt: 100,
  });
  assert.deepEqual(
    state.runtimeEvents.map((event) => ({
      type: event.type,
      runId: event.runId,
      resultKind: event.resultKind,
      reason: event.reason,
    })),
    [
      { type: "run.started", runId: "run-review-1", resultKind: undefined, reason: undefined },
      {
        type: "run.aborted",
        runId: "run-review-1",
        resultKind: undefined,
        reason: "superseded_by_new_user_turn",
      },
      { type: "turn.completed", runId: undefined, resultKind: "canceled", reason: undefined },
    ],
  );
  assert.equal(state.taskFlow.at(-1).visibility, "assistant_final");
  assert.match(state.taskFlow.at(-1).content, /旧回合已取消并完成收口/);
  assert.deepEqual(harness.cancellations, [{
    turnId: "turn-1",
    options: {
      reason: "superseded_by_new_user_turn",
      message: "新的用户指令已取代待审核操作；旧回合已取消并完成收口。",
    },
    cancellationRunId: "run-review-1",
  }]);
});

test("pending review transition keeps approval reply options on the existing review path", () => {
  let abortCount = 0;
  const state = createState({
    abortController: {
      abort() {
        abortCount += 1;
      },
    },
  });
  const harness = createHarness(state);

  const result = applySubmitPendingReviewTransition({
    text: "执行一次",
    state,
    getState: () => state,
    setState: harness.setState.bind(harness),
    closeTurnAsCanceled: harness.closeTurnAsCanceled.bind(harness),
    logStoreEvent: harness.logStoreEvent.bind(harness),
    logError: harness.logError.bind(harness),
  });

  assert.equal(result.aborted, false);
  assert.equal(result.decision.isApprovalBypass, true);
  assert.equal(abortCount, 0);
  assert.deepEqual(harness.logs, []);
  assert.equal(state.agentStatus, "pending_review");
  assert.equal(state.pendingReviewTaskId, 99);
  assert.equal(state.conversationTurns[0].status, "awaiting_approval");
});
