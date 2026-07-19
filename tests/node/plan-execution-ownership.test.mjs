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
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
    fileName: normalizedPath,
  }).outputText;
  const module = { exports: {} };
  transpiledModuleCache.set(normalizedPath, module.exports);
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
  transpiledModuleCache.set(normalizedPath, module.exports);
  return module.exports;
}

const { isHarnessMarkerOwnedByPlanExecution } = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/lib/planExecutionOwnership.ts"),
);

const identity = Object.freeze({
  sessionKey: "workspace-a::session-7",
  sessionEpoch: "session-epoch-3",
  planTurnId: "turn-plan-4",
  reviewRunId: "run-review-4",
  reviewParentRunId: "run-plan-author-4",
  requestId: "request-review-4",
  approvalLeaseId: "approval-lease-4",
  executionLeaseId: "execution-lease-2",
  executionRunId: "run-execution-2",
  parentRunId: "run-review-4",
  planRevision: 4,
  artifactHash: "sha256:plan-four",
  instructionHash: "sha256:instruction-two",
  attempt: 2,
});

function planExecutionProvenance(overrides = {}) {
  return {
    schemaVersion: 1,
    sessionKey: identity.sessionKey,
    sessionEpoch: identity.sessionEpoch,
    planTurnId: identity.planTurnId,
    approvalLeaseId: identity.approvalLeaseId,
    planRevision: identity.planRevision,
    artifactHash: identity.artifactHash,
    executionLeaseId: identity.executionLeaseId,
    executionTurnId: identity.planTurnId,
    executionRunId: identity.executionRunId,
    parentRunId: identity.parentRunId,
    attempt: identity.attempt,
    instructionHash: identity.instructionHash,
    ...overrides,
  };
}

function planExecutionLifecycle(overrides = {}) {
  const artifactPaths = [".MAIN/plans/plan.md", ".MAIN/plans/tasks.md"];
  const reviewIdentity = {
    sessionKey: identity.sessionKey,
    sessionEpoch: identity.sessionEpoch,
    turnId: identity.planTurnId,
    runId: identity.reviewRunId,
    parentRunId: identity.reviewParentRunId,
    requestId: identity.requestId,
    planRevision: identity.planRevision,
    artifactHash: identity.artifactHash,
    artifactPaths,
  };

  return {
    schemaVersion: 2,
    version: 6,
    status: "executing",
    sessionKey: identity.sessionKey,
    sessionEpoch: identity.sessionEpoch,
    planTurnId: identity.planTurnId,
    artifactIdentity: {
      revision: identity.planRevision,
      artifactHash: identity.artifactHash,
      artifactPaths,
    },
    reviewIdentity,
    approvalLease: {
      schemaVersion: 2,
      leaseId: identity.approvalLeaseId,
      sessionKey: identity.sessionKey,
      sessionEpoch: identity.sessionEpoch,
      planTurnId: identity.planTurnId,
      reviewRunId: identity.reviewRunId,
      requestId: identity.requestId,
      planRevision: identity.planRevision,
      artifactHash: identity.artifactHash,
      artifactPaths,
      approvedAt: 40,
      approvalTurnId: identity.planTurnId,
      approvalRunId: identity.reviewRunId,
      approvalDecisionKind: "action_decision",
    },
    executionLease: {
      schemaVersion: 2,
      executionLeaseId: identity.executionLeaseId,
      approvalLeaseId: identity.approvalLeaseId,
      sessionKey: identity.sessionKey,
      sessionEpoch: identity.sessionEpoch,
      planTurnId: identity.planTurnId,
      executionTurnId: identity.planTurnId,
      executionRunId: identity.executionRunId,
      parentRunId: identity.parentRunId,
      attempt: identity.attempt,
      issuedAt: 41,
      reason: "explicit_resume",
      instructionHash: identity.instructionHash,
      authorization: {
        kind: "action_decision",
        sessionKey: identity.sessionKey,
        sessionEpoch: identity.sessionEpoch,
        turnId: identity.planTurnId,
        runId: identity.reviewRunId,
        requestId: identity.requestId,
      },
    },
    lastIssuedAttempt: identity.attempt,
    execution: {
      turnId: identity.planTurnId,
      runId: identity.executionRunId,
      parentRunId: identity.parentRunId,
      attempt: identity.attempt,
      startedAt: 42,
    },
    pause: null,
    updatedAt: 42,
    ...overrides,
  };
}

function planHarnessMarker(overrides = {}) {
  return {
    schemaVersion: 1,
    runId: "run-outer-harness",
    activeRunId: identity.executionRunId,
    activeParentRunId: identity.parentRunId,
    activePlanExecutionProvenance: planExecutionProvenance(),
    instanceId: "instance-1",
    sessionKey: identity.sessionKey,
    workspace: "/workspace-a",
    sessionId: 7,
    turnId: identity.planTurnId,
    status: "running",
    workflowMode: "plan",
    runtimeIntent: "execute",
    planStage: "executing",
    isPlanApproved: true,
    iteration: 2,
    maxIterations: 50,
    messagesLen: 3,
    toolCount: 1,
    latestTool: "read_file",
    latestToolTarget: "src/main.ts",
    activeStreamId: null,
    streamStatus: null,
    streamChunkCount: 0,
    streamByteCount: 0,
    streamElapsedMs: null,
    streamLifecycleStatus: null,
    lastStreamError: null,
    startedAt: 42,
    updatedAt: 43,
    closedAt: null,
    closeReason: null,
    ...overrides,
  };
}

test("exact executing and paused Harness owners retain Plan execution ownership", () => {
  const executingLifecycle = planExecutionLifecycle();
  const runningMarker = planHarnessMarker();
  assert.equal(isHarnessMarkerOwnedByPlanExecution({
    lifecycle: executingLifecycle,
    marker: runningMarker,
  }), true);

  const pausedLifecycle = planExecutionLifecycle({
    status: "paused",
    pause: {
      reason: "awaiting_user_input",
      resultKind: "blocked",
      resumeCondition: "user_confirms_next_step",
    },
  });
  const pausedMarker = planHarnessMarker({ status: "paused" });
  assert.equal(isHarnessMarkerOwnedByPlanExecution({
    lifecycle: pausedLifecycle,
    marker: pausedMarker,
  }), true);
});

test("missing provenance, generic markers, and mismatched action owners are rejected", () => {
  const lifecycle = planExecutionLifecycle();
  const exactMarker = planHarnessMarker();

  const rejectedMarkers = [
    ["missing provenance", { ...exactMarker, activePlanExecutionProvenance: undefined }],
    ["wrong active run", { ...exactMarker, activeRunId: "run-unrelated" }],
    ["wrong active parent", { ...exactMarker, activeParentRunId: "run-unrelated-parent" }],
    ["wrong session", { ...exactMarker, sessionKey: "workspace-b::session-9" }],
    ["generic marker", {
      ...exactMarker,
      runId: "run-generic-chat",
      activeRunId: null,
      activeParentRunId: null,
      activePlanExecutionProvenance: null,
      workflowMode: "chat",
      runtimeIntent: "respond",
      planStage: "idle",
      isPlanApproved: false,
    }],
  ];

  for (const [label, marker] of rejectedMarkers) {
    assert.equal(
      isHarnessMarkerOwnedByPlanExecution({ lifecycle, marker }),
      false,
      label,
    );
  }
});

test("revoked Plan lifecycle cannot retain stale Harness ownership", () => {
  const revokedLifecycle = planExecutionLifecycle({
    status: "completed",
    pause: null,
  });

  assert.equal(isHarnessMarkerOwnedByPlanExecution({
    lifecycle: revokedLifecycle,
    marker: planHarnessMarker(),
  }), false);
});
