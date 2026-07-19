import test from "node:test";
import assert from "node:assert/strict";
import fsSync from "node:fs";
import path from "node:path";
import ts from "typescript";

const sourcePath = path.join(process.cwd(), "src/store/sessionRuntimeRevocation.ts");
const source = fsSync.readFileSync(sourcePath, "utf8");
const transpiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  fileName: sourcePath,
}).outputText;
const module = { exports: {} };
new Function("exports", "module", "require", transpiled)(module.exports, module, () => ({}));
const {
  revokeSessionRuntimeBeforeDelete,
  revokeWorkspaceSessionRuntimesBeforeClear,
} = module.exports;

function marker(overrides = {}) {
  return {
    schemaVersion: 1,
    instanceId: "instance-1",
    runId: "run-1",
    sessionKey: "session-1",
    turnId: "turn-1",
    status: "running",
    startedAt: 1,
    updatedAt: 1,
    closedAt: null,
    closeReason: null,
    ...overrides,
  };
}

test("deleting a live Session revokes abort, review, and harness leases first", () => {
  const order = [];
  const result = revokeSessionRuntimeBeforeDelete({
    sessionKey: "session-1",
    runtime: {
      abortController: { abort: () => order.push("abort") },
      pendingReviewResolve: (decision) => order.push(`review:${decision.action}`),
      harnessRunMarker: marker(),
    },
    closeHarness: () => {
      order.push("harness");
      return true;
    },
  });

  assert.deepEqual(order, ["abort", "review:reject", "harness"]);
  assert.deepEqual(result, {
    aborted: true,
    runDecisionSettled: false,
    reviewSettled: true,
    harnessClosed: true,
  });
});

test("deleting one Session never closes a foreign harness owner", () => {
  let closeCount = 0;
  const result = revokeSessionRuntimeBeforeDelete({
    sessionKey: "session-1",
    runtime: { harnessRunMarker: marker({ sessionKey: "session-2" }) },
    closeHarness: () => {
      closeCount += 1;
      return true;
    },
  });

  assert.equal(closeCount, 0);
  assert.equal(result.harnessClosed, false);
});

test("deleting a paused Session revokes its exact harness marker", () => {
  const closed = [];
  const pausedMarker = marker({ status: "paused" });
  const result = revokeSessionRuntimeBeforeDelete({
    sessionKey: "session-1",
    runtime: { harnessRunMarker: pausedMarker },
    closeHarness: (ownedMarker) => {
      closed.push(ownedMarker);
      return true;
    },
  });

  assert.deepEqual(closed, [pausedMarker]);
  assert.equal(result.harnessClosed, true);
});

test("Session deletion does not treat an already-terminal harness marker as a revocable lease", () => {
  let closeCount = 0;
  const result = revokeSessionRuntimeBeforeDelete({
    sessionKey: "session-1",
    runtime: { harnessRunMarker: marker({ status: "completed" }) },
    closeHarness: () => {
      closeCount += 1;
      return true;
    },
  });

  assert.equal(closeCount, 0);
  assert.equal(result.harnessClosed, false);
});

test("revocation isolates failures so Session deletion can continue", () => {
  const phases = [];
  const result = revokeSessionRuntimeBeforeDelete({
    sessionKey: "session-1",
    runtime: {
      abortController: { abort: () => { throw new Error("abort failed"); } },
      pendingReviewResolve: () => { throw new Error("review failed"); },
      harnessRunMarker: marker(),
    },
    closeHarness: () => { throw new Error("harness failed"); },
    onError: (phase) => phases.push(phase),
  });

  assert.deepEqual(phases, ["abort", "review", "harness"]);
  assert.deepEqual(result, {
    aborted: false,
    runDecisionSettled: false,
    reviewSettled: false,
    harnessClosed: false,
  });
});

test("workspace history clear revokes Execute, Goal, approval, and Harness owners exactly once", () => {
  const order = [];
  const executeRuntime = {
    currentTurnId: "turn-execute",
    agentStatus: "running",
    abortController: { abort: () => order.push("execute:abort") },
  };
  const goalRuntime = {
    currentTurnId: "turn-goal",
    agentStatus: "running",
    abortController: { abort: () => order.push("goal:abort") },
  };
  const approvalRuntime = {
    currentTurnId: "turn-approval",
    agentStatus: "pending_review",
    pendingRunDecisionResolver: (choice) => order.push(`approval:run:${choice}`),
    pendingReviewResolve: (decision) => order.push(`approval:tool:${decision.action}`),
  };
  const harnessRuntime = {
    currentTurnId: "turn-harness",
    agentStatus: "running",
    harnessRunMarker: marker({
      sessionKey: "workspace-a:4",
      turnId: "turn-harness",
      runId: "run-harness",
    }),
  };
  const foreignRuntime = {
    abortController: { abort: () => order.push("foreign:abort") },
    harnessRunMarker: marker({ sessionKey: "workspace-ab:5" }),
  };

  const results = revokeWorkspaceSessionRuntimesBeforeClear({
    workspaceKey: "workspace-a",
    activeSessionKey: "workspace-a:1",
    // The active runtime must override a stale cached snapshot for this owner.
    activeRuntime: executeRuntime,
    runtimeBySessionKey: {
      "workspace-a:1": { abortController: { abort: () => order.push("stale-active:abort") } },
      "workspace-a:2": goalRuntime,
      "workspace-a:3": approvalRuntime,
      "workspace-a:4": harnessRuntime,
      "workspace-ab:5": foreignRuntime,
    },
    closeHarness: (ownedMarker) => {
      order.push(`harness:${ownedMarker.sessionKey}:${ownedMarker.runId}`);
      return true;
    },
  });

  assert.deepEqual(order, [
    "execute:abort",
    "goal:abort",
    "approval:run:cancel",
    "approval:tool:reject",
    "harness:workspace-a:4:run-harness",
  ]);
  assert.deepEqual(results.map((result) => result.sessionKey), [
    "workspace-a:1",
    "workspace-a:2",
    "workspace-a:3",
    "workspace-a:4",
  ]);
  assert.deepEqual(results[2], {
    sessionKey: "workspace-a:3",
    aborted: false,
    runDecisionSettled: true,
    reviewSettled: true,
    harnessClosed: false,
  });
});
