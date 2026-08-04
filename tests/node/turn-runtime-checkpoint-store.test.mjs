import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

import ts from "typescript";

const workspaceRoot = process.cwd();
const moduleCache = new Map();

function loadTranspiledModuleSync(sourcePath) {
  const normalizedPath = path.resolve(sourcePath);
  if (moduleCache.has(normalizedPath)) return moduleCache.get(normalizedPath);
  const source = fs.readFileSync(normalizedPath, "utf8").replace(
    /import\.meta\.glob\([\s\S]*?\)\s+as Record<string, string>/g,
    "({}) as Record<string, string>",
  );
  const localRequire = createRequire(normalizedPath);
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      jsx: ts.JsxEmit.ReactJSX,
    },
    fileName: normalizedPath,
  }).outputText;
  const module = { exports: {} };
  moduleCache.set(normalizedPath, module.exports);
  const runtimeRequire = (specifier) => {
    if (specifier.startsWith("@tauri-apps/")) {
      return {
        invoke: async () => "",
        isTauri: () => false,
        listen: async () => () => {},
        open: async () => null,
        relaunch: async () => {},
        exit: async () => {},
        check: async () => null,
      };
    }
    if (specifier.startsWith(".")) {
      const basePath = path.resolve(path.dirname(normalizedPath), specifier);
      for (const candidate of [
        basePath,
        `${basePath}.ts`,
        `${basePath}.tsx`,
        path.join(basePath, "index.ts"),
        path.join(basePath, "index.tsx"),
      ]) {
        if (fs.existsSync(candidate) && /\.tsx?$/.test(candidate)) {
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
  moduleCache.set(normalizedPath, module.exports);
  return module.exports;
}

const store = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/store/useAppStore.ts"),
);
const actionRequests = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/lib/actionRequest.ts"),
);
const planLifecycleRuntime = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/lib/planLifecycle.ts"),
);
const planApproval = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/lib/planApprovalIdentity.ts"),
);
const planContract = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/lib/planContract.ts"),
);
const planEvidenceReceipt = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/lib/planEvidenceReceipt.ts"),
);
const canonicalRuntime = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/lib/turnRuntimeContract.ts"),
);
const checkpointRuntime = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/lib/turnRuntimeCheckpoint.ts"),
);
const closureReceiptRuntime = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/lib/subagentClosureReceipts.ts"),
);

const workspace = "/repo/checkpoint-plan";
const sessionId = 7;
const sessionKey = `${workspace}:${sessionId}`;
const sessionEpoch = "checkpoint-plan-epoch-7";
const turnId = "turn-checkpoint-plan";
const runId = "run-checkpoint-plan";

function applyPlanTransition(state, command) {
  const result = planLifecycleRuntime.reducePlanLifecycle(state, command);
  assert.equal(result.disposition, "applied", result.reason);
  return result.state;
}

function applyCanonical(state, type, fields, at = state.lastEventAt + 1) {
  const result = canonicalRuntime.reduceCanonicalTurnRuntime(state, {
    schemaVersion: canonicalRuntime.TURN_RUNTIME_CONTRACT_SCHEMA_VERSION,
    type,
    sequence: state.nextSequence,
    at,
    ...fields,
  });
  assert.equal(result.disposition, "applied", result.reason);
  return result.state;
}

function buildPlanContent() {
  return [
    "# Plan 冷恢复审批边界",
    "",
    "## 用户目标",
    "- 恢复后只显示由同一会话 checkpoint 支撑的计划审批。",
    "",
    "## 摘要",
    "- 使用 canonical Turn checkpoint 绑定审批身份。",
    "",
    "## 已读证据",
    "- `src/store/useAppStore.ts`：恢复入口会核验会话 owner 与 artifact identity。",
    "",
    "## 关键改动",
    "- 修改 `src/main.js` 中的恢复投影。",
    "",
    "## 公共 API / 接口 / 类型",
    "- 保持 PlanArtifact 与 PlanApprovalIdentity 类型不变。",
    "",
    "## 执行步骤",
    "1. 核验 checkpoint owner。",
    "2. 仅恢复匹配的审批控件。",
    "",
    "## 验证标准",
    "- 精确身份恢复为 pending_review，过期身份恢复为 idle。",
    "",
    "## 测试方案",
    "- 运行 turn runtime checkpoint 定向测试。",
    "",
    "## 假设与默认值",
    "- 应用重启不会恢复进程内 resolver。",
    "",
  ].join("\n");
}

function buildSealedCandidate(content) {
  const bundleHash = "bundle-1";
  return {
    schemaVersion: planContract.PLAN_CANDIDATE_SCHEMA_VERSION,
    state: "sealed",
    contractId: "checkpoint-contract:bundle-1",
    authoringContractId: "checkpoint-contract",
    bundleHash,
    objective: "Restore only exact-owner Plan approval presentation.",
    goals: [{ id: "G1", index: 1, text: "Fence restored Plan approval by owner identity." }],
    diagnosisRequired: false,
    evidence: [],
    evidenceReceipt: planEvidenceReceipt.createPlanEvidenceReceipt({
      bundleId: bundleHash,
      hash: bundleHash,
      turnId,
      objective: "Restore only exact-owner Plan approval presentation.",
      constraints: [],
      facts: [],
      observedTargets: [],
      changeTargets: [],
      verificationTargets: [],
      coverageObligations: [],
    }),
    summary: ["Keep approval presentation separate from process-local execution authority."],
    diagnoses: [],
    findings: [],
    changes: [{
      id: "C1",
      text: "Modify src/main.js under the reviewed Plan.",
      targetRef: "src/main.js",
      evidenceRefs: [],
      diagnosisRefs: [],
      goalRefs: ["G1"],
      operation: "modify",
      expectedOutcome: "The reviewed restore projection is applied.",
      relationships: [],
      executionEvidence: [],
    }],
    decisions: [],
    interfaces: [],
    tests: ["Run the checkpoint restore regression."],
    validations: [{
      id: "V1",
      goalRefs: ["G1"],
      changeRefs: ["C1"],
      primitive: {
        kind: "finite_command",
        acceptance: "required",
        command: "node --test tests/node/turn-runtime-checkpoint-store.test.mjs",
        capability: "test",
        segments: [{
          command: "node --test tests/node/turn-runtime-checkpoint-store.test.mjs",
          connector: "start",
          role: "validator",
          capability: "test",
        }],
      },
      expectedOutcome: "The restore regression exits successfully.",
      blocking: true,
    }],
    assumptions: [],
    blockingChoices: [],
    projection: {
      format: "markdown",
      content,
      contentHash: planContract.hashPlanProjection(content),
    },
  };
}

function buildExactPendingReviewSnapshot() {
  const content = buildPlanContent();
  const candidate = buildSealedCandidate(content);
  const artifact = {
    kind: "plan",
    path: ".MAIN/plans/plan.md",
    title: "Plan",
    content,
    revision: 4,
    updatedAt: 100,
    candidate,
    candidateHash: planContract.hashPlanCandidate(candidate),
    authoringContractId: candidate.authoringContractId,
  };
  const identity = planApproval.buildTypedPlanApprovalIdentity([artifact]);
  assert.ok(identity, "fixture must retain typed Plan review authority");
  const request = actionRequests.buildPlanReviewActionRequest({
    sessionKey,
    turnId,
    runId,
    parentRunId: null,
    title: "Review Plan",
    planRevision: identity.revision,
    artifactHash: identity.artifactHash,
    artifactPaths: identity.artifactPaths,
    now: 120,
  });
  const artifactIdentity = {
    revision: identity.revision,
    artifactHash: identity.artifactHash,
    artifactPaths: identity.artifactPaths,
  };
  const reviewIdentity = {
    sessionKey,
    sessionEpoch,
    turnId,
    runId,
    parentRunId: null,
    requestId: request.requestId,
    planRevision: identity.revision,
    artifactHash: identity.artifactHash,
    artifactPaths: identity.artifactPaths,
  };
  let lifecycle = planLifecycleRuntime.createPlanLifecycleState({
    sessionKey,
    sessionEpoch,
    updatedAt: 10,
  });
  lifecycle = applyPlanTransition(lifecycle, {
    type: "start_drafting",
    expectedVersion: lifecycle.version,
    at: 20,
    planTurnId: turnId,
    artifactIdentity,
  });
  lifecycle = applyPlanTransition(lifecycle, {
    type: "request_review",
    expectedVersion: lifecycle.version,
    at: 120,
    artifactIdentity,
    reviewIdentity,
  });

  const turnOwner = {
    workspaceKey: workspace,
    sessionKey,
    sessionEpoch,
    clientSubmissionId: "submission-checkpoint-plan",
    turnId,
  };
  const runOwner = {
    sessionKey,
    sessionEpoch,
    turnId,
    runId,
    parentRunId: null,
    attemptId: runId,
  };
  let canonical = canonicalRuntime.createCanonicalTurnRuntime({
    turn: turnOwner,
    strategy: "plan",
    admittedAt: 10,
  });
  canonical = applyCanonical(canonical, "run.started", {
    run: runOwner,
    phase: "planning",
  }, 20);
  canonical = applyCanonical(canonical, "plan.artifact_accepted", {
    run: runOwner,
    artifact: {
      path: artifact.path,
      digest: identity.artifactHash,
      revision: identity.revision,
    },
  }, 120);
  const checkpoint = checkpointRuntime.createTurnRuntimeCheckpoint({
    canonical,
    updatedAt: 120,
  });

  return {
    currentTurnId: turnId,
    planArtifacts: [artifact],
    planStage: "plan",
    isPlanApproved: false,
    planLifecycle: lifecycle,
    activeActionRequest: request,
    turnRuntimeCheckpoints: { [turnId]: checkpoint },
    harnessRunMarker: {
      schemaVersion: 1,
      instanceId: "checkpoint-plan-instance",
      sessionKey,
      workspace,
      sessionId,
      turnId,
      runId,
      activeRunId: runId,
      activeParentRunId: null,
      parentRunId: null,
      status: "paused",
      workflowMode: "plan",
      runtimeIntent: "plan",
      planStage: "plan",
      isPlanApproved: false,
      iteration: 2,
      maxIterations: 50,
      messagesLen: 2,
      toolCount: 0,
      latestTool: null,
      latestToolTarget: null,
      activeStreamId: null,
      streamStatus: "closed",
      streamChunkCount: 0,
      streamByteCount: 0,
      streamElapsedMs: 0,
      streamLifecycleStatus: "completed",
      lastStreamError: null,
      startedAt: 10,
      updatedAt: 120,
      closedAt: 120,
      closeReason: "plan_review_required",
    },
    taskFlow: [{
      id: 1,
      type: "user",
      turnId,
      content: "请生成计划并等待审批",
    }],
    conversationTurns: [{
      id: turnId,
      clientSubmissionId: turnOwner.clientSubmissionId,
      userPrompt: "请生成计划并等待审批",
      title: "Plan checkpoint",
      mode: "plan",
      intent: "plan",
      displayIntent: "plan",
      status: "awaiting_approval",
      summary: "等待审批",
      blockIds: [1],
      collapsed: false,
      createdAt: 10,
    }],
  };
}

function restoreOptions(overrides = {}) {
  return {
    expectedSessionKey: sessionKey,
    expectedSessionEpoch: sessionEpoch,
    workspacePath: workspace,
    quarantineInterruptedLocalFast: true,
    ...overrides,
  };
}

test("cold restore exposes an exact Plan review without restoring execution authority", () => {
  const snapshot = buildExactPendingReviewSnapshot();
  const built = store.buildSessionRuntimeSnapshotFromStoreState({
    ...snapshot,
    currentWorkspace: workspace,
    currentSessionId: sessionId,
  });
  assert.ok(built.turnRuntimeCheckpoints[turnId]);
  assert.deepEqual(store.buildSessionRuntimeSnapshotFromStoreState({
    ...snapshot,
    currentWorkspace: "/repo/not-the-owner",
    currentSessionId: sessionId,
  }).turnRuntimeCheckpoints, {});
  const sanitized = store.sanitizeSessionRuntimeSnapshotForPersist(snapshot);
  assert.ok(sanitized.turnRuntimeCheckpoints[turnId]);
  assert.deepEqual(store.sanitizeSessionRuntimeSnapshotForPersist({
    ...snapshot,
    planLifecycle: {
      ...snapshot.planLifecycle,
      sessionEpoch: "stale-persist-epoch",
    },
  }).turnRuntimeCheckpoints, {});

  const restored = store.normalizeSessionRuntimeSnapshot(snapshot, restoreOptions());

  assert.equal(restored.activeActionRequest?.kind, "plan_review");
  assert.equal(restored.planLifecycle.status, "awaiting_approval");
  assert.equal(restored.conversationTurns[0].status, "awaiting_approval");
  assert.equal(
    restored.turnRuntimeCheckpoints[turnId].canonical.planReviewStatus,
    "pending",
  );
  assert.equal(restored.turnRuntimeCheckpoints[turnId].canonical.run.status, "paused");

  const patch = store.buildRestoredSessionRuntimePatch({
    snapshot,
    fallbackState: {
      ...store.useAppStore.getState(),
      currentWorkspace: workspace,
      currentSessionId: sessionId,
    },
    workspacePath: workspace,
    expectedSessionKey: sessionKey,
    expectedSessionEpoch: sessionEpoch,
  });
  assert.equal(patch.agentStatus, "pending_review");
  assert.equal(patch.isGenerating, false);
  assert.equal(patch.abortController, null);
  assert.equal(patch.pendingReviewResolve, null);
  assert.equal(patch.pendingReviewTaskId, null);
  assert.equal(patch.activeActionRequest?.kind, "plan_review");
});

test("session persistence drops recursive Store fields and stays size-stable", () => {
  const state = {
    ...buildExactPendingReviewSnapshot(),
    currentWorkspace: workspace,
    currentSessionId: sessionId,
  };
  state.sessionsByWorkspace = {
    [workspace]: [{
      id: sessionId,
      runtimeSnapshot: state,
    }],
  };
  state.runtimeBySessionKey = {
    [sessionKey]: state,
  };
  state.unknownStoreProjection = {
    previous: state,
  };

  const sanitized = store.sanitizeSessionRuntimeSnapshotForPersist(state);
  assert.equal("sessionsByWorkspace" in sanitized, false);
  assert.equal("runtimeBySessionKey" in sanitized, false);
  assert.equal("unknownStoreProjection" in sanitized, false);
  const firstEncoding = JSON.stringify(sanitized);
  const second = store.sanitizeSessionRuntimeSnapshotForPersist(sanitized);
  const secondEncoding = JSON.stringify(second);
  const thirdEncoding = JSON.stringify(
    store.sanitizeSessionRuntimeSnapshotForPersist(second),
  );
  assert.ok(secondEncoding.length <= firstEncoding.length);
  assert.equal(thirdEncoding.length, secondEncoding.length);
  assert.deepEqual(JSON.parse(thirdEncoding), JSON.parse(secondEncoding));
});

test("store round-trips only the exact Session-owned subagent closure receipt ledger", () => {
  const snapshot = buildExactPendingReviewSnapshot();
  const ledger = closureReceiptRuntime.createSubagentClosureReceiptLedger({
    owner: {
      workspaceKey: workspace,
      sessionKey,
      sessionEpoch,
    },
    now: 110,
  });
  snapshot.subagentClosureReceiptLedger = ledger;

  const built = store.buildSessionRuntimeSnapshotFromStoreState({
    ...snapshot,
    currentWorkspace: workspace,
    currentSessionId: sessionId,
  });
  assert.deepEqual(built.subagentClosureReceiptLedger, ledger);

  const sanitized = store.sanitizeSessionRuntimeSnapshotForPersist(snapshot);
  assert.deepEqual(sanitized.subagentClosureReceiptLedger, ledger);

  const restored = store.normalizeSessionRuntimeSnapshot(snapshot, restoreOptions());
  assert.deepEqual(restored.subagentClosureReceiptLedger, ledger);

  const crossWorkspace = store.normalizeSessionRuntimeSnapshot(
    snapshot,
    restoreOptions({ workspacePath: "/repo/other-workspace" }),
  );
  assert.equal(crossWorkspace.subagentClosureReceiptLedger, null);

  const crossEpoch = store.normalizeSessionRuntimeSnapshot(
    snapshot,
    restoreOptions({ expectedSessionEpoch: "checkpoint-plan-epoch-replaced" }),
  );
  assert.equal(crossEpoch.subagentClosureReceiptLedger, null);
});

test("cold restore revokes stale Plan approval identity and workspace ownership", () => {
  const staleRequestSnapshot = buildExactPendingReviewSnapshot();
  staleRequestSnapshot.activeActionRequest = {
    ...staleRequestSnapshot.activeActionRequest,
    artifactHash: "plan-sha256-stale",
  };
  const staleRequest = store.normalizeSessionRuntimeSnapshot(
    staleRequestSnapshot,
    restoreOptions(),
  );
  assert.equal(staleRequest.activeActionRequest, null);
  assert.deepEqual(staleRequest.turnRuntimeCheckpoints, {});
  assert.notEqual(staleRequest.planLifecycle.status, "awaiting_approval");
  assert.equal(staleRequest.conversationTurns[0].status, "paused");

  const staleWorkspaceSnapshot = buildExactPendingReviewSnapshot();
  const staleWorkspace = store.normalizeSessionRuntimeSnapshot(
    staleWorkspaceSnapshot,
    restoreOptions({ workspacePath: "/repo/other-workspace" }),
  );
  assert.deepEqual(staleWorkspace.turnRuntimeCheckpoints, {});
  assert.equal(staleWorkspace.activeActionRequest, null);
  assert.notEqual(staleWorkspace.planLifecycle.status, "awaiting_approval");
  assert.equal(staleWorkspace.conversationTurns[0].status, "paused");

  const stalePatch = store.buildRestoredSessionRuntimePatch({
    snapshot: staleWorkspaceSnapshot,
    fallbackState: {
      ...store.useAppStore.getState(),
      currentWorkspace: "/repo/other-workspace",
      currentSessionId: sessionId,
    },
    workspacePath: "/repo/other-workspace",
    expectedSessionKey: sessionKey,
    expectedSessionEpoch: sessionEpoch,
  });
  assert.equal(stalePatch.agentStatus, "idle");
  assert.equal(stalePatch.activeActionRequest, null);
});

test("persist sanitizer does not mis-fence a Chat checkpoint with the unbound Plan lifecycle", () => {
  const chatTurnId = "turn-checkpoint-chat";
  const chatRunId = "run-checkpoint-chat";
  const chatTurnOwner = {
    workspaceKey: workspace,
    sessionKey,
    sessionEpoch,
    clientSubmissionId: "submission-checkpoint-chat",
    turnId: chatTurnId,
  };
  const chatRunOwner = {
    sessionKey,
    sessionEpoch,
    turnId: chatTurnId,
    runId: chatRunId,
    parentRunId: null,
    attemptId: chatRunId,
  };
  let canonical = canonicalRuntime.createCanonicalTurnRuntime({
    turn: chatTurnOwner,
    strategy: "chat",
    admittedAt: 10,
  });
  canonical = applyCanonical(canonical, "run.started", {
    run: chatRunOwner,
    phase: "preparing",
  }, 20);
  const checkpoint = checkpointRuntime.createTurnRuntimeCheckpoint({
    canonical,
    updatedAt: 20,
  });
  const unboundLifecycle = planLifecycleRuntime.createPlanLifecycleState({
    sessionKey: "__MAIN_UNBOUND_PLAN_SESSION__",
    sessionEpoch: "__MAIN_UNBOUND_PLAN_EPOCH__",
    updatedAt: 10,
  });

  const sanitized = store.sanitizeSessionRuntimeSnapshotForPersist({
    planLifecycle: unboundLifecycle,
    turnRuntimeCheckpoints: { [chatTurnId]: checkpoint },
  });
  assert.ok(sanitized.turnRuntimeCheckpoints[chatTurnId]);
});
