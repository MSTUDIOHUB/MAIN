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
  revokeAllSessionRuntimesBeforeSettingsReset,
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

test("settings reset revokes the active projection and every cached Session owner", () => {
  const order = [];
  const results = revokeAllSessionRuntimesBeforeSettingsReset({
    activeSessionKey: "workspace-a:1",
    activeRuntime: {
      currentTurnId: "turn-active",
      agentStatus: "running",
      abortController: { abort: () => order.push("active:abort") },
    },
    runtimeBySessionKey: {
      // The live projection must replace this stale snapshot for the same owner.
      "workspace-a:1": {
        abortController: { abort: () => order.push("stale-active:abort") },
      },
      "workspace-a:2": {
        currentTurnId: "turn-review",
        agentStatus: "pending_review",
        pendingReviewResolve: (decision) => order.push(`review:${decision.action}`),
      },
      "workspace-b:3": {
        currentTurnId: "turn-background",
        agentStatus: "running",
        abortController: { abort: () => order.push("background:abort") },
      },
      "workspace-b:empty": null,
    },
    closeHarness: () => {
      order.push("unexpected:harness");
      return true;
    },
  });

  assert.deepEqual(order, ["active:abort", "review:reject", "background:abort"]);
  assert.deepEqual(
    results.map(({ identity }) => ({
      ownerId: identity.ownerId,
      source: identity.source,
      sessionKey: identity.sessionKey,
      turnId: identity.currentTurnId,
    })),
    [
      {
        ownerId: "active:workspace-a:1",
        source: "active",
        sessionKey: "workspace-a:1",
        turnId: "turn-active",
      },
      {
        ownerId: "cached:workspace-a:2",
        source: "cached",
        sessionKey: "workspace-a:2",
        turnId: "turn-review",
      },
      {
        ownerId: "cached:workspace-b:3",
        source: "cached",
        sessionKey: "workspace-b:3",
        turnId: "turn-background",
      },
    ],
  );
  assert.deepEqual(results.map((result) => ({
    aborted: result.aborted,
    runDecisionSettled: result.runDecisionSettled,
    reviewSettled: result.reviewSettled,
    harnessClosed: result.harnessClosed,
  })), [
    { aborted: true, runDecisionSettled: false, reviewSettled: false, harnessClosed: false },
    { aborted: false, runDecisionSettled: false, reviewSettled: true, harnessClosed: false },
    { aborted: true, runDecisionSettled: false, reviewSettled: false, harnessClosed: false },
  ]);
});

test("settings reset safely revokes an unbound active runtime and its exact Harness marker", () => {
  const order = [];
  const activeMarker = marker({
    sessionKey: "workspace-a:9",
    runId: "run-unbound",
    turnId: "turn-unbound",
    status: "paused",
  });
  const results = revokeAllSessionRuntimesBeforeSettingsReset({
    activeSessionKey: null,
    activeRuntime: {
      currentTurnId: "turn-unbound",
      agentStatus: "pending_review",
      abortController: { abort: () => order.push("abort") },
      pendingRunDecisionResolver: (choice) => order.push(`decision:${choice}`),
      pendingReviewResolve: (decision) => order.push(`review:${decision.action}`),
      harnessRunMarker: activeMarker,
    },
    runtimeBySessionKey: {},
    closeHarness: (ownedMarker) => {
      order.push(`harness:${ownedMarker.sessionKey}:${ownedMarker.runId}`);
      return true;
    },
  });

  assert.deepEqual(order, [
    "abort",
    "decision:cancel",
    "review:reject",
    "harness:workspace-a:9:run-unbound",
  ]);
  assert.deepEqual(results, [{
    identity: {
      ownerId: "active:unbound",
      source: "active",
      sessionKey: null,
      currentTurnId: "turn-unbound",
      agentStatus: "pending_review",
      harnessRunId: "run-unbound",
      harnessSessionKey: "workspace-a:9",
      harnessTurnId: "turn-unbound",
    },
    aborted: true,
    runDecisionSettled: true,
    reviewSettled: true,
    harnessClosed: true,
  }]);
});

test("settings reset never settles aliased capability references twice", () => {
  const calls = [];
  const sharedAbortController = { abort: () => calls.push("abort") };
  const sharedRunDecisionResolver = (choice) => calls.push(`decision:${choice}`);
  const sharedReviewResolver = (decision) => calls.push(`review:${decision.action}`);
  const aliasedRuntime = {
    currentTurnId: "turn-shared",
    agentStatus: "pending_review",
    abortController: sharedAbortController,
    pendingRunDecisionResolver: sharedRunDecisionResolver,
    pendingReviewResolve: sharedReviewResolver,
  };

  const results = revokeAllSessionRuntimesBeforeSettingsReset({
    activeSessionKey: "workspace-a:1",
    activeRuntime: aliasedRuntime,
    runtimeBySessionKey: {
      // A different key can briefly alias the same live runtime during a switch.
      "workspace-b:2": aliasedRuntime,
    },
    closeHarness: () => true,
  });

  assert.deepEqual(calls, ["abort", "decision:cancel", "review:reject"]);
  assert.equal(results.length, 2);
  assert.deepEqual(results[0], {
    identity: {
      ownerId: "active:workspace-a:1",
      source: "active",
      sessionKey: "workspace-a:1",
      currentTurnId: "turn-shared",
      agentStatus: "pending_review",
      harnessRunId: null,
      harnessSessionKey: null,
      harnessTurnId: null,
    },
    aborted: true,
    runDecisionSettled: true,
    reviewSettled: true,
    harnessClosed: false,
  });
  assert.deepEqual(results[1], {
    identity: {
      ownerId: "cached:workspace-b:2",
      source: "cached",
      sessionKey: "workspace-b:2",
      currentTurnId: "turn-shared",
      agentStatus: "pending_review",
      harnessRunId: null,
      harnessSessionKey: null,
      harnessTurnId: null,
    },
    aborted: false,
    runDecisionSettled: false,
    reviewSettled: false,
    harnessClosed: false,
  });
});

test("settings reset reports the exact owner identity when one revocation phase throws", () => {
  const errors = [];
  const results = revokeAllSessionRuntimesBeforeSettingsReset({
    activeRuntime: null,
    runtimeBySessionKey: {
      "workspace-a:7": {
        currentTurnId: "turn-7",
        agentStatus: "running",
        abortController: { abort: () => { throw new Error("cannot abort"); } },
      },
    },
    closeHarness: () => true,
    onError: (identity, phase, error) => {
      errors.push({ identity, phase, message: error.message });
    },
  });

  assert.equal(results[0].aborted, false);
  assert.deepEqual(errors, [{
    identity: results[0].identity,
    phase: "abort",
    message: "cannot abort",
  }]);
});
