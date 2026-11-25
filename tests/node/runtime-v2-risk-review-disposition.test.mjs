import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "./tsModuleLoader.mjs";

const load = createTsModuleLoader();
const kernel = load("src/lib/runtime-v2/index.ts");
const review = load("src/store/runtimeV2/workPlanAdapter.ts");
const { deriveProactiveCollaboration } = load("src/store/runtimeV2/proactiveSubagents.ts");
const { validateToolAgainstPhaseAndPlan, validateToolAgainstApprovedPlan } = (() => {
  const planAuth = load("src/store/runtimeV2/executionPlanAuthorization.ts");
  const auth = load("src/store/runtimeV2/executionAuthorization.ts");
  return {
    validateToolAgainstPhaseAndPlan: auth.validateToolAgainstPhaseAndPlan,
    validateToolAgainstApprovedPlan: planAuth.validateToolAgainstApprovedPlan,
  };
})();

const turn = {
  workspaceKey: "/fixture-pool",
  sessionKey: "session-pool",
  sessionEpoch: "epoch-pool",
  clientSubmissionId: "sub-pool",
  turnId: "turn-pool",
};

const run = {
  sessionKey: turn.sessionKey,
  sessionEpoch: turn.sessionEpoch,
  turnId: turn.turnId,
  runId: "run-pool",
  parentRunId: null,
  attemptId: "attempt-pool",
};

function ev(state, type, fields = {}) {
  return kernel.transition(state, {
    schemaVersion: kernel.RUNTIME_V2_EVENT_SCHEMA_VERSION,
    sequence: state ? state.nextSequence : 0,
    eventId: `pool-ev-${(state?.nextSequence ?? 0) + 1}`,
    at: (state?.updatedAt ?? 0) + 1,
    type,
    ...fields,
  });
}

function makePlanState({ sameTurnDefectCorrection = "authorized", automated = false } = {}) {
  const validations = automated
    ? [{ kind: "finite_command", stepIndexes: [0], command: "npm test", expectedOutcome: "Independent helper tests pass", required: true, criterionIds: ["c-helper"] }]
    : [{ kind: "advisory", stepIndexes: [0, 1, 2], command: "manual_verification", expectedOutcome: "Inspect in Unity", required: false }];

  const plan = kernel.sealWorkPlanV1({
    createdAt: 1,
    evidence: [],
    draft: {
      schemaVersion: kernel.WORK_PLAN_V1_SCHEMA_VERSION,
      objective: "Implement ObjectPoolBase, ObjectPoolManager, and independent Helper",
      summary: "ObjectPoolBase + ObjectPool<T> pool + independent Helper",
      findings: [],
      risks: [],
      assumptions: [],
      blockingQuestions: [],
      ...(sameTurnDefectCorrection ? { sameTurnDefectCorrection } : {}),
      steps: [
        { title: "Isolated helper", operation: "create", targets: ["Assets/MFramework/Util/Helper.cs"], basis: [], change: "Create Helper", expectedOutcome: "Helper created", dependsOn: [], criterionIds: ["c-helper"] },
        { title: "ObjectPoolBase", operation: "create", targets: ["Assets/MFramework/Pool/ObjectPoolBase.cs"], basis: [], change: "Define ObjectPoolBase", expectedOutcome: "ObjectPoolBase created", dependsOn: [], criterionIds: ["c-pool"] },
        { title: "ObjectPoolManager", operation: "create", targets: ["Assets/MFramework/Pool/ObjectPoolManager.cs"], basis: [], change: "Use ObjectPoolBase", expectedOutcome: "ObjectPoolManager assigns ObjectPool<T> to ObjectPoolBase map", dependsOn: [1], criterionIds: ["c-pool"] },
      ],
      validations,
    },
  });
  const commit = review.createRuntimeV2PlanReviewCommit({ plan, turn, run, requestId: "req-pool", createdAt: 1 });
  let state = ev(null, "turn.admitted", {
    turn,
    strategy: "plan",
    objective: plan.draft.objective,
    constraints: [],
    acceptanceCriteria: ["Helper works", "ObjectPool types match"],
    acceptanceCriterionIds: ["c-helper", "c-pool"],
  });
  state = ev(state, "run.started", { run, phase: "planning" });
  state = ev(state, "work_plan.sealed", { run, workPlan: review.toRuntimeV2WorkPlanReference(plan), sealedPlan: plan, reviewCommit: commit });
  state = ev(state, "work_plan.approved", { run, workPlan: review.toRuntimeV2WorkPlanReference(plan, "approved") });
  state = ev(state, "phase.changed", { run, phase: "acting", reason: "Start execution" });
  return state;
}

test("proactive review tracks mutation hashes and dispatches only high-risk cross-step or unverified steps with contract paths", () => {
  let state = makePlanState({ automated: true });

  // S0 (Helper.cs) has required automated validation and NO dependsOn edges -> NO routine review!
  state = ev(state, "command.scheduled", {
    run, command: { idempotencyKey: "mut-helper", kind: "execute_tool", run, phase: "acting", payload: { toolName: "write_file", arguments: { path: "Assets/MFramework/Util/Helper.cs" } } },
  });
  state = ev(state, "tool.completed", {
    run,
    idempotencyKey: "mut-helper",
    status: "succeeded",
    effectKind: "workspace_change",
    mutationRequests: [{ target: "Assets/MFramework/Util/Helper.cs", operation: "create" }],
    evidence: [{ id: "m-helper", kind: "mutation", target: "Assets/MFramework/Util/Helper.cs", version: "sha256-" + "1".repeat(64) }],
  });
  const afterHelper = deriveProactiveCollaboration({
    state,
    preference: "preferred",
    capacity: 2,
    requestMode: "parallel",
    workspace: turn.workspaceKey,
    language: "en",
    now: 50,
  });
  assert.deepEqual(afterHelper, { reason: "no_independent_scope" }, "isolated step with required validation does not trigger routine review");

  // S1 (ObjectPoolBase) finishes while S2 is ready -> risk review fires while S2 is ready!
  state = ev(state, "command.scheduled", {
    run, command: { idempotencyKey: "mut-base", kind: "execute_tool", run, phase: "acting", payload: { toolName: "write_file", arguments: { path: "Assets/MFramework/Pool/ObjectPoolBase.cs" } } },
  });
  state = ev(state, "tool.completed", {
    run,
    idempotencyKey: "mut-base",
    status: "succeeded",
    effectKind: "workspace_change",
    mutationRequests: [{ target: "Assets/MFramework/Pool/ObjectPoolBase.cs", operation: "create" }],
    evidence: [{ id: "m-base", kind: "mutation", target: "Assets/MFramework/Pool/ObjectPoolBase.cs", version: "sha256-" + "2".repeat(64) }],
  });
  const poolBaseReview = deriveProactiveCollaboration({
    state,
    preference: "preferred",
    capacity: 2,
    requestMode: "parallel",
    workspace: turn.workspaceKey,
    language: "en",
    now: 60,
  });
  assert.ok(poolBaseReview && "candidate" in poolBaseReview);
  assert.equal(poolBaseReview.candidate.taskKind, "review");

  // Complete poolBase review cleanly, then S2 completes and enters validating while S0 validation is pending
  state = ev(state, "command.scheduled", {
    run,
    command: { idempotencyKey: "sched-rev-base", kind: "schedule_subagents", run, phase: "acting", payload: { proactiveKey: poolBaseReview.candidate.proactiveKey } },
  });
  state = ev(state, "subagents.scheduled", {
    run,
    maxActiveSubagents: 3,
    jobs: [{
      id: "rev-base-1",
      run: { ...run, runId: "c-base", parentRunId: run.runId },
      parentRunId: run.runId,
      proactiveKey: poolBaseReview.candidate.proactiveKey,
      scopeKey: poolBaseReview.candidate.scopeKey,
      taskKind: "review",
      accessMode: "read",
      objective: poolBaseReview.candidate.objective,
      allowedPaths: poolBaseReview.candidate.allowedPaths,
      status: "queued",
      requestedAt: 61,
      firstTokenAt: null,
      closedAt: null,
      summary: null,
    }],
  });
  state = ev(state, "subagent.telemetry", { run, telemetry: { jobId: "rev-base-1", phase: "request_opened", at: 62 } });
  state = ev(state, "subagent.telemetry", { run, telemetry: { jobId: "rev-base-1", phase: "closed", at: 63 } });
  const baseRevEv = { id: "rev-base-ev", kind: "subagent", target: "Assets/MFramework/Pool/ObjectPoolBase.cs", version: "sha256-" + "2".repeat(64) };
  state = ev(state, "subagent.completed", {
    run,
    jobId: "rev-base-1",
    status: "completed",
    summary: "ObjectPoolBase ok (rev-base-ev)",
    evidence: [baseRevEv],
    report: kernel.compileRuntimeV2SubagentTextReport({ summary: "ObjectPoolBase ok (rev-base-ev)", evidence: [baseRevEv] }),
  });

  state = ev(state, "command.scheduled", {
    run, command: { idempotencyKey: "mut-mgr", kind: "execute_tool", run, phase: "acting", payload: { toolName: "write_file", arguments: { path: "Assets/MFramework/Pool/ObjectPoolManager.cs" } } },
  });
  state = ev(state, "tool.completed", {
    run,
    idempotencyKey: "mut-mgr",
    status: "succeeded",
    effectKind: "workspace_change",
    mutationRequests: [{ target: "Assets/MFramework/Pool/ObjectPoolManager.cs", operation: "create" }],
    evidence: [{ id: "m-mgr", kind: "mutation", target: "Assets/MFramework/Pool/ObjectPoolManager.cs", version: "sha256-" + "3".repeat(64) }],
  });
  state = ev(state, "phase.changed", { run, phase: "validating", reason: "All implementation targets created" });

  // S2 dependsOn [1] -> triggers cross-step contract risk review including ObjectPoolBase.cs + ObjectPoolManager.cs!
  const mgrReview = deriveProactiveCollaboration({
    state,
    preference: "preferred",
    capacity: 3,
    requestMode: "parallel",
    workspace: turn.workspaceKey,
    language: "en",
    now: 70,
  });
  assert.ok(mgrReview && "candidate" in mgrReview);
  assert.deepEqual(
    mgrReview.candidate.allowedPaths.slice().sort(),
    ["Assets/MFramework/Pool/ObjectPoolBase.cs", "Assets/MFramework/Pool/ObjectPoolManager.cs"],
  );
  assert.match(mgrReview.candidate.objective, /inheritance|interface|\[BLOCKING\]/i);

  // Dedupe: same mutation version is NOT scheduled twice when a job with the same scopeKey already ran
  state = ev(state, "command.scheduled", {
    run,
    command: { idempotencyKey: "sched-rev-mgr", kind: "schedule_subagents", run, phase: "validating", payload: { proactiveKey: mgrReview.candidate.proactiveKey } },
  });
  state = ev(state, "subagents.scheduled", {
    run,
    maxActiveSubagents: 3,
    jobs: [{
      id: "rev-mgr-1",
      run: { ...run, runId: "c-rev", parentRunId: run.runId },
      parentRunId: run.runId,
      proactiveKey: mgrReview.candidate.proactiveKey,
      scopeKey: mgrReview.candidate.scopeKey,
      taskKind: "review",
      accessMode: "read",
      objective: mgrReview.candidate.objective,
      allowedPaths: mgrReview.candidate.allowedPaths,
      status: "queued",
      requestedAt: 71,
      firstTokenAt: null,
      closedAt: null,
      summary: null,
    }],
  });
  state = ev(state, "subagent.telemetry", { run, telemetry: { jobId: "rev-mgr-1", phase: "request_opened", at: 72 } });
  state = ev(state, "subagent.telemetry", { run, telemetry: { jobId: "rev-mgr-1", phase: "closed", at: 73 } });
  state = ev(state, "subagent.completed", {
    run,
    jobId: "rev-mgr-1",
    status: "completed",
    summary: "No defects",
    evidence: [],
    inheritedEvidence: [{ id: "m-mgr", kind: "mutation", target: "Assets/MFramework/Pool/ObjectPoolManager.cs", version: "sha256-" + "3".repeat(64) }],
    report: { schemaVersion: "runtime-v2-subagent-report.v1", summary: "ok", findings: [{ statement: "[ADVISORY] ok", evidenceIds: ["m-mgr"] }], unresolved: [] },
  });
  const afterRepeat = deriveProactiveCollaboration({
    state,
    preference: "preferred",
    capacity: 3,
    requestMode: "parallel",
    workspace: turn.workspaceKey,
    language: "en",
    now: 80,
  });
  assert.deepEqual(afterRepeat, { reason: "no_independent_scope" });

  // After a NEW mutation hash on ObjectPoolManager.cs, review scopeKey refreshes!
  state = ev(state, "command.scheduled", {
    run, command: { idempotencyKey: "mut-mgr-v2", kind: "execute_tool", run, phase: "validating", payload: { toolName: "replace_in_file", arguments: { path: "Assets/MFramework/Pool/ObjectPoolManager.cs" } } },
  });
  state = ev(state, "tool.completed", {
    run,
    idempotencyKey: "mut-mgr-v2",
    status: "succeeded",
    effectKind: "workspace_change",
    evidence: [{ id: "m-mgr-2", kind: "mutation", target: "Assets/MFramework/Pool/ObjectPoolManager.cs", version: "sha256-" + "9".repeat(64) }],
  });
  const reReview = deriveProactiveCollaboration({
    state,
    preference: "preferred",
    capacity: 3,
    requestMode: "parallel",
    workspace: turn.workspaceKey,
    language: "en",
    now: 90,
  });
  assert.ok(reReview && "candidate" in reReview);
  assert.notEqual(reReview.candidate.proactiveKey, mgrReview.candidate.proactiveKey);
});

test("review disposition enforces hard verification evidence, allows new-plan same-turn repair (max 2 rounds), blocks legacy repairs, and maps confirmed breaking defects to partial", () => {
  const commitAllAndReview = (sameTurnDefectCorrection) => {
    let state = makePlanState({ sameTurnDefectCorrection, automated: false });
    const mutCmd = (id, target, version) => {
      state = ev(state, "command.scheduled", {
        run,
        command: { idempotencyKey: id, kind: "execute_tool", run, phase: "acting", payload: { toolName: "write_file", arguments: { path: target, content: "// code" } } },
      });
      state = ev(state, "tool.completed", {
        run,
        idempotencyKey: id,
        status: "succeeded",
        effectKind: "workspace_change",
        mutationRequests: [{ target, operation: "create" }],
        evidence: [{ id: `ev-${id}`, kind: "mutation", target, version }],
      });
    };
    const oldHelperHash = "sha256-" + "1".repeat(64);
    const mgrV1Hash = "sha256-" + "3".repeat(64);
    mutCmd("w1", "Assets/MFramework/Util/Helper.cs", oldHelperHash);
    mutCmd("w2", "Assets/MFramework/Pool/ObjectPoolBase.cs", "sha256-" + "2".repeat(64));
    mutCmd("w3", "Assets/MFramework/Pool/ObjectPoolManager.cs", mgrV1Hash);

    // Review job 1 finds real ObjectPool<T> -> ObjectPoolBase blocking defect; Review job 2 reports a false-positive advisory on Helper.cs
    state = ev(state, "subagents.scheduled", {
      run,
      maxActiveSubagents: 2,
      jobs: [
        {
          id: "rev-pool",
          run: { ...run, runId: "c1", parentRunId: run.runId },
          parentRunId: run.runId,
          scopeKey: "scope-pool",
          taskKind: "review",
          accessMode: "read",
          objective: "Audit ObjectPool inheritance",
          allowedPaths: ["Assets/MFramework/Pool/ObjectPoolManager.cs", "Assets/MFramework/Pool/ObjectPoolBase.cs"],
          status: "queued",
          requestedAt: 10,
          firstTokenAt: null,
          closedAt: null,
          summary: null,
        },
        {
          id: "rev-helper",
          run: { ...run, runId: "c2", parentRunId: run.runId },
          parentRunId: run.runId,
          scopeKey: "scope-helper",
          taskKind: "review",
          accessMode: "read",
          objective: "Audit Helper.cs",
          allowedPaths: ["Assets/MFramework/Util/Helper.cs"],
          status: "queued",
          requestedAt: 10,
          firstTokenAt: null,
          closedAt: null,
          summary: null,
        },
      ],
    });

    // Simulate helper edited again (new version) BEFORE stale source read test
    const curHelperHash = "sha256-" + "4".repeat(64);
    state = ev(state, "command.scheduled", {
      run, command: { idempotencyKey: "stale-helper-src", kind: "execute_tool", run, phase: "acting", payload: { toolName: "read_file", arguments: { path: "Assets/MFramework/Util/Helper.cs" } } },
    });
    state = ev(state, "tool.completed", {
      run,
      idempotencyKey: "stale-helper-src",
      status: "succeeded",
      evidence: [{ id: "src-helper-stale", kind: "source", target: "Assets/MFramework/Util/Helper.cs", version: oldHelperHash }],
    });
    mutCmd("w1b", "Assets/MFramework/Util/Helper.cs", curHelperHash);
    state = ev(state, "command.scheduled", {
      run, command: { idempotencyKey: "fresh-helper-src", kind: "execute_tool", run, phase: "acting", payload: { toolName: "read_file", arguments: { path: "Assets/MFramework/Util/Helper.cs" } } },
    });
    state = ev(state, "tool.completed", {
      run,
      idempotencyKey: "fresh-helper-src",
      status: "succeeded",
      evidence: [{ id: "src-helper-fresh", kind: "source", target: "Assets/MFramework/Util/Helper.cs", version: curHelperHash }],
    });

    const poolReport = kernel.compileRuntimeV2SubagentTextReport({
      summary: "[BLOCKING] Assets/MFramework/Pool/ObjectPoolManager.cs: ObjectPool<T> does not inherit ObjectPoolBase, incompatible dictionary value assignment (ev-w3).",
      evidence: [{ id: "rev-ev-1", kind: "subagent", target: "Assets/MFramework/Pool/ObjectPoolManager.cs", version: mgrV1Hash }],
      inheritedEvidence: [{ id: "ev-w3", kind: "mutation", target: "Assets/MFramework/Pool/ObjectPoolManager.cs", version: mgrV1Hash }],
    });
    state = ev(state, "subagent.telemetry", { run, telemetry: { jobId: "rev-pool", phase: "request_opened", at: 11 } });
    state = ev(state, "subagent.telemetry", { run, telemetry: { jobId: "rev-pool", phase: "closed", at: 12 } });
    state = ev(state, "subagent.completed", {
      run,
      jobId: "rev-pool",
      status: "completed",
      summary: poolReport.summary,
      evidence: [{ id: "rev-ev-1", kind: "subagent", target: "Assets/MFramework/Pool/ObjectPoolManager.cs", version: mgrV1Hash }],
      inheritedEvidence: [{ id: "ev-w3", kind: "mutation", target: "Assets/MFramework/Pool/ObjectPoolManager.cs", version: mgrV1Hash }],
      report: poolReport,
    });
    state = ev(state, "subagent.handoff_delivered", { run, jobId: "rev-pool", contextEntryId: "child:rev-pool", evidenceIds: ["rev-ev-1"] });

    const helperReport = kernel.compileRuntimeV2SubagentTextReport({
      summary: "[ADVISORY] Assets/MFramework/Util/Helper.cs: Check null guard (src-helper-stale).",
      evidence: [{ id: "rev-ev-2", kind: "subagent", target: "Assets/MFramework/Util/Helper.cs", version: curHelperHash }],
      inheritedEvidence: [{ id: "src-helper-stale", kind: "source", target: "Assets/MFramework/Util/Helper.cs", version: oldHelperHash }],
    });
    state = ev(state, "subagent.telemetry", { run, telemetry: { jobId: "rev-helper", phase: "request_opened", at: 11 } });
    state = ev(state, "subagent.telemetry", { run, telemetry: { jobId: "rev-helper", phase: "closed", at: 12 } });
    state = ev(state, "subagent.completed", {
      run,
      jobId: "rev-helper",
      status: "completed",
      summary: helperReport.summary,
      evidence: [{ id: "rev-ev-2", kind: "subagent", target: "Assets/MFramework/Util/Helper.cs", version: curHelperHash }],
      inheritedEvidence: [{ id: "src-helper-stale", kind: "source", target: "Assets/MFramework/Util/Helper.cs", version: oldHelperHash }],
      report: helperReport,
    });
    state = ev(state, "subagent.handoff_delivered", { run, jobId: "rev-helper", contextEntryId: "child:rev-helper", evidenceIds: ["rev-ev-2"] });
    return state;
  };

  // 1. Legacy plan (sameTurnDefectCorrection omitted): does NOT grant in-place repair permission
  const legacyState = commitAllAndReview(null);
  assert.equal(
    kernel.isApprovedSameTurnDefectCorrection({ aggregate: legacyState, targetPath: "Assets/MFramework/Pool/ObjectPoolManager.cs", operation: "modify" }),
    false,
  );
  const legacyPorts = {
    context: { turnId: turn.turnId, runWorkspace: turn.workspaceKey, runSessionKey: turn.sessionKey },
    live: { childWriteScopes: new Map(), latestProviderRequestSourceCoverage: [{ target: "Assets/MFramework/Pool/ObjectPoolManager.cs", version: "v", complete: true }] },
    get: () => ({
      currentTurnId: turn.turnId,
      conversationTurns: [{ id: turn.turnId }],
      runtimeV2Checkpoints: {
        [turn.turnId]: kernel.createRuntimeV2Checkpoint({ aggregate: legacyState, revision: legacyState.nextSequence, updatedAt: legacyState.updatedAt }),
      },
    }),
  };
  const legacyAuth = validateToolAgainstApprovedPlan({
    ports: legacyPorts,
    aggregate: legacyState,
    command: { idempotencyKey: "fix-legacy", kind: "execute_tool", run, phase: "acting", payload: {} },
    toolName: "replace_in_file",
    args: { path: "Assets/MFramework/Pool/ObjectPoolManager.cs", diff: "x" },
    target: "Assets/MFramework/Pool/ObjectPoolManager.cs",
  });
  assert.equal(legacyAuth.allowed, false);
  assert.equal(legacyAuth.reasonCode, "approved_plan_mutation_scope");

  // 2. New pre-authorized plan: blocking finding blocks conclusion until resolved
  let state = commitAllAndReview("authorized");
  assert.equal(kernel.canFinalizeApprovedWorkPlanWithoutModel(state), false);
  assert.equal(
    kernel.decideRuntimeV2TerminalOutcome(state, {
      canceled: false, mutationCount: 4, passedValidationCount: 0, hasAcceptanceValidation: false,
      failedValidationCount: 0, stalledValidationCount: 0, hasProviderConclusion: true,
    }),
    null,
    "pending [BLOCKING] finding prevents completion even with provider conclusion",
  );

  // Stale source cannot falsify Helper.cs finding; current source hash succeeds
  assert.equal(
    kernel.validateResolveReviewFindingCall({
      aggregate: state,
      args: { finding_id: "rev-helper:f1", disposition: "falsified", summary: "Stale check", verification_evidence_ids: ["src-helper-stale"] },
    }).ok,
    false,
  );
  assert.equal(
    kernel.validateResolveReviewFindingCall({
      aggregate: state,
      args: { finding_id: "rev-helper:f1", disposition: "falsified", summary: "Null guard present in current version", verification_evidence_ids: ["src-helper-fresh"] },
    }).ok,
    true,
  );

  // "repaired" rejected BEFORE repair mutation commits after report
  assert.equal(
    kernel.validateResolveReviewFindingCall({
      aggregate: state,
      args: { finding_id: "rev-pool:f1", disposition: "repaired", summary: "Fixed inheritance" },
    }).ok,
    false,
  );

  // Pre-authorized same-turn repair IS allowed on ObjectPoolManager.cs (round 1), but denied on unapproved target
  assert.equal(
    kernel.isApprovedSameTurnDefectCorrection({ aggregate: state, targetPath: "Assets/MFramework/Pool/ObjectPoolManager.cs", operation: "modify" }),
    true,
  );
  assert.equal(
    kernel.isApprovedSameTurnDefectCorrection({ aggregate: state, targetPath: "Assets/MFramework/Unplanned.cs", operation: "modify" }),
    false,
  );

  // Commit round 1 fix + round 2 fix; verify 3rd round is blocked by MAX_REVIEW_REPAIR_ROUNDS = 2
  const commitRepair = (id, version) => {
    state = ev(state, "command.scheduled", {
      run,
      command: { idempotencyKey: id, kind: "execute_tool", run, phase: "acting", payload: { toolName: "replace_in_file", arguments: { path: "Assets/MFramework/Pool/ObjectPoolManager.cs" } } },
    });
    state = ev(state, "tool.completed", {
      run,
      idempotencyKey: id,
      status: "succeeded",
      effectKind: "workspace_change",
      mutationRequests: [{ target: "Assets/MFramework/Pool/ObjectPoolManager.cs", operation: "modify" }],
      evidence: [{ id: `ev-${id}`, kind: "mutation", target: "Assets/MFramework/Pool/ObjectPoolManager.cs", version }],
    });
  };
  commitRepair("rep-1", "sha256-" + "7".repeat(64));
  assert.equal(
    kernel.isApprovedSameTurnDefectCorrection({ aggregate: state, targetPath: "Assets/MFramework/Pool/ObjectPoolManager.cs", operation: "modify" }),
    true,
    "round 2 repair still allowed",
  );
  commitRepair("rep-2", "sha256-" + "8".repeat(64));
  assert.equal(
    kernel.isApprovedSameTurnDefectCorrection({ aggregate: state, targetPath: "Assets/MFramework/Pool/ObjectPoolManager.cs", operation: "modify" }),
    false,
    "3rd repair round rejected cleanly at MAX_REVIEW_REPAIR_ROUNDS=2",
  );

  // Record dispositions for both findings
  const recordDisposition = (key, args) => {
    const valid = kernel.validateResolveReviewFindingCall({ aggregate: state, args });
    assert.equal(valid.ok, true, valid.message);
    state = ev(state, "command.scheduled", {
      run,
      command: { idempotencyKey: key, kind: "execute_tool", run, phase: "acting", payload: { toolName: "resolve_review_finding", arguments: args } },
    });
    state = ev(state, "tool.completed", {
      run,
      idempotencyKey: key,
      status: "succeeded",
      operationName: "resolve_review_finding",
      effectKind: "observation",
      evidence: [{ id: `disp-${key}`, kind: "tool", target: "resolve_review_finding", version: null }],
      modelContent: JSON.stringify({ ...args, target_hashes: valid.targetHashes }),
    });
  };
  recordDisposition("d-helper", { finding_id: "rev-helper:f1", disposition: "falsified", summary: "Verified null guard in current source", verification_evidence_ids: ["src-helper-fresh"] });
  recordDisposition("d-pool", { finding_id: "rev-pool:f1", disposition: "repaired", summary: "ObjectPool<T> now derives from ObjectPoolBase", verification_evidence_ids: ["ev-rep-2"] });

  const ledger = kernel.deriveRuntimeV2ReviewDispositionLedger(state);
  assert.equal(ledger.reviewDeliveredCount, 2);
  assert.equal(ledger.reviewAdoptedCount, 2);
  assert.equal(ledger.repairedFindings.length, 1);
  assert.equal(ledger.falsifiedFindings.length, 1);
  assert.equal(ledger.pendingBlockingCount, 0);
  assert.equal(kernel.canFinalizeApprovedWorkPlanWithoutModel(state), true);

  // Also verify deferred_unresolved with breaks_acceptance: true produces partial (never success)
  let brokenState = commitAllAndReview("authorized");
  const brokenArgs = {
    finding_id: "rev-helper:f1",
    disposition: "falsified",
    summary: "ok",
    verification_evidence_ids: ["src-helper-fresh"],
  };
  brokenState = ev(brokenState, "command.scheduled", {
    run,
    command: { idempotencyKey: "d-b1", kind: "execute_tool", run, phase: "acting", payload: { toolName: "resolve_review_finding", arguments: brokenArgs } },
  });
  brokenState = ev(brokenState, "tool.completed", {
    run, idempotencyKey: "d-b1", status: "succeeded", operationName: "resolve_review_finding", effectKind: "observation",
    evidence: [], modelContent: JSON.stringify(brokenArgs),
  });
  const deferArgs = {
    finding_id: "rev-pool:f1",
    disposition: "deferred_unresolved",
    summary: "Cannot compile against ObjectPoolBase in this environment",
    breaks_acceptance: true,
  };
  brokenState = ev(brokenState, "command.scheduled", {
    run,
    command: { idempotencyKey: "d-b2", kind: "execute_tool", run, phase: "acting", payload: { toolName: "resolve_review_finding", arguments: deferArgs } },
  });
  brokenState = ev(brokenState, "tool.completed", {
    run, idempotencyKey: "d-b2", status: "succeeded", operationName: "resolve_review_finding", effectKind: "observation",
    evidence: [], modelContent: JSON.stringify(deferArgs),
  });
  const brokenOutcome = kernel.decideRuntimeV2TerminalOutcome(brokenState, {
    canceled: false, mutationCount: 4, passedValidationCount: 0, hasAcceptanceValidation: false,
    failedValidationCount: 0, stalledValidationCount: 0, hasProviderConclusion: true,
  });
  assert.equal(brokenOutcome.resultKind, "partial");
  assert.match(brokenOutcome.resultReason, /rev-pool:f1/);
});
