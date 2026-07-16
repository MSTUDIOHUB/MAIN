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

const {
  MAX_EXECUTE_RECOVERY_ITERATIONS,
  activateExecuteRecoveryRuntimeState,
  advanceExecuteRecoveryRuntimeIteration,
  buildExecuteRecoveryMaxIterationsPrompt,
  clearExecuteRecoveryRuntimeState,
  createExecuteRecoveryRuntimeState,
  refundExecuteRecoveryRuntimeIteration,
  registerExecuteRecoveryProtocolNoProgress,
  resolvePtyObservationPolicyDeferral,
  transitionExecuteRecoveryRuntimeState,
} = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/lib/orchestrator/loop/executeRecoveryRuntime.ts"),
);
const { buildApprovedPlanScopeConflictFingerprint } = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/lib/approvedPlanExecutionScope.ts"),
);
const { resolveDirectMutationPreflightRecovery } = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/lib/orchestrator/loop/mutationFailureRecovery.ts"),
);

test("PTY observation policy deferral is recognized only from structured browser preflight feedback", () => {
  assert.deepEqual(resolvePtyObservationPolicyDeferral([{
    name: "browser_evaluate",
    target: "http://localhost:1420/",
    internalFeedback: true,
    qualityGateReason: "pty_observation_required",
  }]), {
    requestedUrl: "http://localhost:1420/",
  });

  assert.equal(resolvePtyObservationPolicyDeferral([{
    name: "browser_evaluate",
    target: "http://localhost:1420/",
    internalFeedback: false,
    qualityGateReason: "pty_observation_required",
  }]), null, "an actual browser result must not be reclassified as a policy deferral");
  assert.equal(resolvePtyObservationPolicyDeferral([{
    name: "browser_evaluate",
    target: "http://localhost:1420/",
    internalFeedback: true,
    qualityGateReason: "browser_preflight_deferred",
  }]), null, "other browser preflight outcomes keep their own recovery policy");
});

test("execute recovery state restores forced edit and approved-Plan continuation transactions", () => {
  const forcedEdit = createExecuteRecoveryRuntimeState({
    workflowMode: "edit",
    forcedMode: "patch_recovery_read",
  });
  assert.equal(forcedEdit.mode, "mutation_first");
  assert.equal(forcedEdit.reason, "forced_execute_recovery");
  assert.equal(forcedEdit.expectedTarget, null);
  assert.equal(forcedEdit.attempts, 1);

  const restoredTransaction = createExecuteRecoveryRuntimeState({
    workflowMode: "edit",
    forcedState: {
      mode: "validation_only",
      reason: "goal_slice_recovery_restored",
      expectedTarget: "src/App.tsx",
      attempts: 5,
      phaseNoProgressCount: 3,
      protocolNoProgressCount: 4,
      protocolNoProgressFingerprint: "validation_only::src/app.tsx::read_unchanged",
      readLease: {
        purpose: "post_mutation_verify",
        target: "src/App.tsx",
        state: "active",
      },
      sourceObservationKey: "src/App.tsx@version-2:20-40",
      decisionCheckpoint: {
        expectedTarget: "src/App.tsx",
        sourceObservationKey: "src/App.tsx@version-2:20-40",
        nextRequiredCapability: "targeted_read",
        evidenceVersion: "ledger-7",
      },
    },
  });
  assert.equal(restoredTransaction.mode, "validation_only");
  assert.equal(restoredTransaction.reason, "goal_slice_recovery_restored");
  assert.equal(restoredTransaction.expectedTarget, "src/App.tsx");
  assert.equal(restoredTransaction.attempts, 5);
  assert.equal(restoredTransaction.phaseNoProgressCount, 3);
  assert.equal(restoredTransaction.protocolNoProgressCount, 4);
  assert.equal(restoredTransaction.protocolNoProgressFingerprint, "validation_only::src/app.tsx::read_unchanged");
  assert.equal(restoredTransaction.readLease, null);
  assert.equal(restoredTransaction.sourceObservationKey, "src/App.tsx@version-2:20-40");
  assert.equal(restoredTransaction.decisionCheckpoint?.evidenceVersion, "ledger-7");
  assert.equal(restoredTransaction.decisionCheckpoint?.nextRequiredCapability, "validation");

  const restoredApprovedPlanTransaction = createExecuteRecoveryRuntimeState({
    workflowMode: "plan",
    forcedState: {
      mode: "validation_only",
      reason: "approved_plan_slice_recovery",
      expectedTarget: "src/App.tsx",
    },
  });
  assert.equal(restoredApprovedPlanTransaction.mode, "validation_only");
  assert.equal(restoredApprovedPlanTransaction.reason, "approved_plan_slice_recovery");
  assert.equal(restoredApprovedPlanTransaction.expectedTarget, "src/App.tsx");

  const forcedChat = createExecuteRecoveryRuntimeState({
    workflowMode: "chat",
    forcedMode: "mutation_first",
  });
  assert.equal(forcedChat.mode, "normal");
  assert.equal(forcedChat.reason, "");
  assert.equal(forcedChat.attempts, 0);
});

test("execute recovery state activates, advances, and clears through the unified phase budget", () => {
  let state = createExecuteRecoveryRuntimeState({ workflowMode: "plan" });

  state = activateExecuteRecoveryRuntimeState(state, {
    mode: "mutation_first",
    reason: "read_loop",
  });
  assert.equal(state.mode, "mutation_first");
  assert.equal(state.reason, "read_loop");
  assert.equal(state.attempts, 1);

  state = activateExecuteRecoveryRuntimeState(
    { ...state, expectedTarget: "src/App.tsx" },
    { mode: "mutation_first", reason: "same_transaction_retry" },
  );
  assert.equal(state.expectedTarget, "src/App.tsx", "reactivation preserves the active transaction target");

  for (let i = 1; i <= MAX_EXECUTE_RECOVERY_ITERATIONS + 1; i += 1) {
    const advanced = advanceExecuteRecoveryRuntimeIteration(state);
    state = advanced.state;
    assert.equal(advanced.reachedMaxIterations, i === MAX_EXECUTE_RECOVERY_ITERATIONS + 1);
  }
  assert.equal(state.iterationCount, MAX_EXECUTE_RECOVERY_ITERATIONS + 1);

  state = clearExecuteRecoveryRuntimeState(state);
  assert.equal(state.mode, "normal");
  assert.equal(state.reason, "");
  assert.equal(state.expectedTarget, null);
  assert.equal(state.attempts, 0);
  assert.equal(state.iterationCount, 0);
});

test("execute recovery state preserves an explicit missing-source lease without a legacy read-loop fold", () => {
  const leasedState = activateExecuteRecoveryRuntimeState(
    createExecuteRecoveryRuntimeState({ workflowMode: "edit" }),
    {
      mode: "patch_recovery_read",
      reason: "patch_mismatch",
      expectedTarget: "src/App.tsx",
      readLease: {
        purpose: "patch_recovery",
        target: "src/App.tsx",
        requestedRange: { startLine: 205, endLine: 256 },
        state: "available",
      },
    },
  );
  assert.equal(
    leasedState.mode,
    "patch_recovery_read",
    "an available read lease is the single authority for the targeted-read phase",
  );
  assert.equal(leasedState.readLease?.state, "available");
  assert.equal(leasedState.readLease?.target, "src/App.tsx");
});

test("execute recovery max-iteration prompt is generated from the shared limit", () => {
  assert.match(
    buildExecuteRecoveryMaxIterationsPrompt({ language: "en" }),
    new RegExp(String(MAX_EXECUTE_RECOVERY_ITERATIONS)),
  );
  assert.match(
    buildExecuteRecoveryMaxIterationsPrompt({ language: "zh", maxIterations: 3 }),
    /3/,
  );
});

test("patch mismatch reuses an active source observation instead of forcing another read", () => {
  const decision = resolveDirectMutationPreflightRecovery({
    workflowMode: "edit",
    runtimeIntent: "execute",
    executeRecoveryMode: "mutation_first",
    retainedSourceObservation: {
      key: "src/main.js::26895:1784042986186::361-540",
      path: "src/main.js",
      requestSignature: 'read_file::src/main.js::[["max_lines",180],["start_line",361]]',
      versionToken: "26895:1784042986186",
      source: "fresh",
    },
    results: [{
      name: "apply_patch",
      target: "src/main.js",
      content: "Error: MUTATION_PREFLIGHT_BLOCKED",
      isError: true,
      mutationPreflightReason: "invalid_patch",
    }],
  });

  assert.equal(decision?.mode, "mutation_first");
  assert.equal(decision?.readLease, null);
  assert.equal(decision?.sourceObservationKey, "src/main.js::26895:1784042986186::361-540");
  assert.equal(decision?.decisionCheckpoint.nextRequiredCapability, "mutation");
  assert.equal(decision?.decisionCheckpoint.evidenceVersion, "26895:1784042986186");

  const state = activateExecuteRecoveryRuntimeState(
    createExecuteRecoveryRuntimeState({ workflowMode: "edit" }),
    decision,
  );
  assert.equal(state.mode, "mutation_first");
  assert.equal(state.readLease, null);
  assert.equal(state.sourceObservationKey, "src/main.js::26895:1784042986186::361-540");
});

test("execute recovery transaction advances a missing-window read to mutation and direct validation", () => {
  let state = activateExecuteRecoveryRuntimeState(
    createExecuteRecoveryRuntimeState({ workflowMode: "edit" }),
    {
      mode: "patch_recovery_read",
      reason: "read_only_loop",
      expectedTarget: "src/App.tsx",
      readLease: {
        purpose: "missing_window",
        target: "src/App.tsx",
        requestedRange: { startLine: 1, endLine: 100, maxLines: 100 },
        observedVersion: "v1",
        state: "available",
      },
    },
  );
  const attempts = state.attempts;

  const cached = transitionExecuteRecoveryRuntimeState(state, {});
  assert.equal(cached.transition, "none");
  assert.equal(cached.state.mode, "patch_recovery_read");

  const wrongRead = transitionExecuteRecoveryRuntimeState(state, {
    expectedTarget: "src/App.tsx",
    freshReadTarget: "src/other.ts",
  });
  assert.equal(wrongRead.transition, "none");
  assert.equal(wrongRead.state.mode, "patch_recovery_read");
  assert.equal(wrongRead.state.expectedTarget, "src/App.tsx");
  assert.equal(wrongRead.consumedExpectedRead, false);

  const read = transitionExecuteRecoveryRuntimeState(wrongRead.state, {
    freshReadTarget: "./src/App.tsx",
    sourceRequestedRange: { startLine: 1, endLine: 100, maxLines: 100 },
    sourceObservedVersion: "v1",
  });
  assert.equal(read.transition, "context_to_mutation");
  assert.equal(read.state.mode, "mutation_first");
  assert.equal(read.state.expectedTarget, "src/App.tsx");
  assert.equal(read.state.attempts, attempts);
  assert.equal(read.consumedExpectedRead, true);
  state = read.state;

  const validationAlternative = transitionExecuteRecoveryRuntimeState(state, { validationTarget: "npm test" });
  assert.equal(validationAlternative.transition, "none");
  assert.equal(validationAlternative.state.mode, "mutation_first");

  const wrongMutation = transitionExecuteRecoveryRuntimeState(state, {
    mutationTarget: "src/other.ts",
  });
  assert.equal(wrongMutation.transition, "none");
  assert.equal(wrongMutation.state.mode, "mutation_first");
  assert.equal(wrongMutation.state.expectedTarget, "src/App.tsx");

  const mutation = transitionExecuteRecoveryRuntimeState(wrongMutation.state, {
    mutationTarget: "/tmp/workspace/src/App.tsx",
  });
  assert.equal(mutation.transition, "mutation_to_validation");
  assert.equal(mutation.state.mode, "validation_only");
  assert.equal(mutation.state.expectedTarget, "src/App.tsx");
  assert.equal(mutation.state.attempts, attempts);
  assert.equal(mutation.state.readLease, null);
  assert.equal(mutation.state.decisionCheckpoint?.nextRequiredCapability, "validation");
  state = mutation.state;

  const verified = transitionExecuteRecoveryRuntimeState(state, {
    validationTarget: "npm test",
    validationToolName: "run_command",
  });
  assert.equal(verified.transition, "validation_to_normal");
  assert.equal(verified.target, "src/App.tsx", "validation keeps the transaction target instead of its command label");
  assert.equal(verified.state.mode, "normal");
  assert.equal(verified.state.expectedTarget, null);
  assert.equal(verified.state.attempts, 0);
});

test("failed-process recovery accepts a bounded target repair before returning to validation", () => {
  const state = activateExecuteRecoveryRuntimeState(
    createExecuteRecoveryRuntimeState({ workflowMode: "edit" }),
    {
      mode: "action_plus_targeting",
      reason: "precompletion_evidence_gap:unreconciled_failure",
      expectedTarget: "src/App.tsx",
      decisionCheckpoint: {
        expectedTarget: "src/App.tsx",
        sourceObservationKey: null,
        nextRequiredCapability: "recover_process",
      },
    },
  );

  const repaired = transitionExecuteRecoveryRuntimeState(state, {
    mutationTarget: "./src/App.tsx",
  });
  assert.equal(repaired.transition, "mutation_to_validation");
  assert.equal(repaired.state.mode, "validation_only");
  assert.equal(repaired.state.expectedTarget, "src/App.tsx");
  assert.equal(repaired.state.readLease, null);
  assert.equal(repaired.state.decisionCheckpoint?.nextRequiredCapability, "validation");
});

test("failed finite validation clears stale source ownership and reads the current target window before repair", () => {
  const state = activateExecuteRecoveryRuntimeState(
    createExecuteRecoveryRuntimeState({ workflowMode: "edit" }),
    {
      mode: "mutation_first",
      reason: "approved_plan_finite_validation_requires_repair",
      expectedTarget: "src/main.js",
      readLease: {
        purpose: "context_restore",
        target: "src/main.js",
        requestedRange: { startLine: 205, endLine: 256, maxLines: 52 },
        state: "available",
      },
      sourceObservationKey: null,
      decisionCheckpoint: {
        expectedTarget: "src/main.js",
        sourceObservationKey: null,
        nextRequiredCapability: "targeted_read",
      },
    },
  );

  assert.equal(state.mode, "patch_recovery_read");
  assert.equal(state.expectedTarget, "src/main.js");
  assert.equal(state.sourceObservationKey, null);
  assert.equal(state.readLease?.purpose, "context_restore");
  assert.deepEqual(state.readLease?.requestedRange, {
    startLine: 205,
    endLine: 256,
    maxLines: 52,
  });
  assert.equal(state.decisionCheckpoint?.nextRequiredCapability, "targeted_read");

  const refreshed = transitionExecuteRecoveryRuntimeState(state, {
    freshReadTarget: "src/main.js",
    sourceObservationKey: "src/main.js::current-v2::205-256",
    sourceRequestedRange: { startLine: 205, endLine: 256, maxLines: 52 },
    sourceObservedVersion: "current-v2",
  });
  assert.equal(refreshed.transition, "context_to_mutation");
  assert.equal(refreshed.state.mode, "mutation_first");
  assert.equal(refreshed.state.sourceObservationKey, "src/main.js::current-v2::205-256");
  assert.equal(refreshed.state.decisionCheckpoint?.nextRequiredCapability, "mutation");
});

test("structural targeting evidence resets the phase budget before its exact range read", () => {
  let state = activateExecuteRecoveryRuntimeState(
    createExecuteRecoveryRuntimeState({ workflowMode: "plan", forcedMode: "action_plus_targeting" }),
    {
      mode: "action_plus_targeting",
      reason: "approved_plan_symbol_targeting_required",
      expectedTarget: "src/main.js",
      decisionCheckpoint: {
        expectedTarget: "src/main.js",
        sourceObservationKey: "head-v1",
        nextRequiredCapability: "targeting",
        evidenceVersion: "9000:100",
      },
    },
  );
  state = advanceExecuteRecoveryRuntimeIteration(state).state;
  assert.equal(state.phaseNoProgressCount, 1);

  const ranged = activateExecuteRecoveryRuntimeState(state, {
    mode: "patch_recovery_read",
    reason: "approved_plan_declaration_range_required",
    expectedTarget: "src/main.js",
    readLease: {
      purpose: "patch_recovery",
      target: "src/main.js",
      requestedRange: { startLine: 600, endLine: 650, maxLines: 51 },
      observedVersion: "9000:100",
      state: "available",
    },
    decisionCheckpoint: {
      expectedTarget: "src/main.js",
      sourceObservationKey: null,
      nextRequiredCapability: "targeted_read",
      evidenceVersion: "9000:100",
    },
  });
  assert.equal(ranged.mode, "patch_recovery_read");
  assert.equal(ranged.phaseNoProgressCount, 0);
  assert.equal(ranged.decisionCheckpoint?.nextRequiredCapability, "targeted_read");
});

test("recovery no-progress budget resets only for fresh phase evidence", () => {
  let state = activateExecuteRecoveryRuntimeState(
    createExecuteRecoveryRuntimeState({ workflowMode: "edit" }),
    {
      mode: "patch_recovery_read",
      reason: "patch_mismatch",
      expectedTarget: "src/App.tsx",
      readLease: {
        purpose: "patch_recovery",
        target: "src/App.tsx",
        requestedRange: { startLine: 205, endLine: 256 },
        state: "active",
      },
    },
  );
  for (let index = 0; index < 4; index += 1) {
    state = advanceExecuteRecoveryRuntimeIteration(state).state;
  }
  assert.equal(state.phaseNoProgressCount, 4);

  const noEvidence = transitionExecuteRecoveryRuntimeState(state, {});
  assert.equal(noEvidence.transition, "none");
  assert.equal(noEvidence.state.phaseNoProgressCount, 4, "stub/internal deferral cannot reset the phase budget");

  const fresh = transitionExecuteRecoveryRuntimeState(state, {
    freshReadTarget: "src/App.tsx",
    sourceObservationKey: "src/App.tsx::205-256::v2",
    sourceRequestedRange: { startLine: 205, endLine: 256 },
  });
  assert.equal(fresh.transition, "context_to_mutation");
  assert.equal(fresh.state.phaseNoProgressCount, 0);
  assert.equal(fresh.state.iterationCount, 0);
  assert.equal(fresh.state.sourceObservationKey, "src/App.tsx::205-256::v2");
  assert.equal(fresh.state.readLease.state, "consumed");
  assert.equal(fresh.state.decisionCheckpoint.sourceObservationKey, "src/App.tsx::205-256::v2");
  assert.equal(fresh.state.decisionCheckpoint.nextRequiredCapability, "mutation");

  state = advanceExecuteRecoveryRuntimeIteration(fresh.state).state;
  const mutation = transitionExecuteRecoveryRuntimeState(state, {
    mutationTarget: "src/App.tsx",
  });
  assert.equal(mutation.transition, "mutation_to_validation");
  assert.equal(mutation.state.phaseNoProgressCount, 0);
  assert.equal(mutation.state.readLease, null);
  assert.equal(mutation.state.decisionCheckpoint.nextRequiredCapability, "validation");

  state = advanceExecuteRecoveryRuntimeIteration(mutation.state).state;
  const validation = transitionExecuteRecoveryRuntimeState(state, {
    validationTarget: "npm test",
    validationToolName: "run_command",
  });
  assert.equal(validation.transition, "validation_to_normal");
  assert.equal(validation.state.mode, "normal");
  assert.equal(validation.state.phaseNoProgressCount, 0);
});

test("patch recovery consumes only the leased target, source range, and version", () => {
  const lease = {
    purpose: "patch_recovery",
    target: "src/main.js",
    requestedRange: { startLine: 205, endLine: 256, maxLines: 52 },
    observedVersion: "8192:1700000000000",
    mismatchFingerprint: "patch_mismatch::src/main.js::mutation_preflight_invalid_patch",
    state: "available",
  };
  const state = activateExecuteRecoveryRuntimeState(
    createExecuteRecoveryRuntimeState({ workflowMode: "edit" }),
    {
      mode: "patch_recovery_read",
      reason: "mutation_preflight_invalid_patch",
      expectedTarget: "src/main.js",
      readLease: lease,
    },
  );

  const wrongRange = transitionExecuteRecoveryRuntimeState(state, {
    freshReadTarget: "src/main.js",
    sourceObservationKey: "main:1-52:v1",
    sourceRequestedRange: { startLine: 1, endLine: 52, maxLines: 52 },
    sourceObservedVersion: "8192:1700000000000",
  });
  assert.equal(wrongRange.transition, "none");
  assert.equal(wrongRange.state.readLease.state, "available");

  const wrongVersion = transitionExecuteRecoveryRuntimeState(state, {
    freshReadTarget: "src/main.js",
    sourceObservationKey: "main:205-256:v2",
    sourceRequestedRange: { startLine: 205, endLine: 256, maxLines: 52 },
    sourceObservedVersion: "8193:1700000000001",
  });
  assert.equal(wrongVersion.transition, "context_to_mutation");
  assert.equal(wrongVersion.state.mode, "mutation_first");
  assert.equal(wrongVersion.state.readLease.observedVersion, "8193:1700000000001");
  assert.equal(wrongVersion.state.sourceObservationKey, "main:205-256:v2");

  const exact = transitionExecuteRecoveryRuntimeState(state, {
    freshReadTarget: "/tmp/workspace/src/main.js",
    sourceObservationKey: "main:205-256:v1",
    sourceRequestedRange: { startLine: 205, endLine: 256, maxLines: 52 },
    sourceObservedVersion: "8192:1700000000000",
  });
  assert.equal(exact.transition, "context_to_mutation");
  assert.equal(exact.state.readLease.state, "consumed");
  assert.equal(exact.state.readLease.observationKey, "main:205-256:v1");
  assert.deepEqual(exact.state.readLease.requestedRange, lease.requestedRange);
  assert.equal(exact.state.readLease.observedVersion, lease.observedVersion);
});

test("parser declaration leases accept one bounded source prefix", () => {
  const state = activateExecuteRecoveryRuntimeState(
    createExecuteRecoveryRuntimeState({ workflowMode: "edit" }),
    {
      mode: "patch_recovery_read",
      reason: "approved_plan_declaration_range_required",
      expectedTarget: "src/main.js",
      readLease: {
        purpose: "initial_targeting",
        target: "src/main.js",
        requestedRange: { startLine: 1, endLine: 1000, maxLines: 1000 },
        coverageMode: "bounded_prefix",
        observedVersion: "120000:300",
        state: "available",
      },
    },
  );

  const bounded = transitionExecuteRecoveryRuntimeState(state, {
    freshReadTarget: "src/main.js",
    sourceObservationKey: "main:1-60:v1",
    sourceRequestedRange: { startLine: 1, endLine: 60, maxLines: 60 },
    sourceObservedVersion: "120000:300",
  });
  assert.equal(bounded.transition, "context_to_mutation");
  assert.equal(bounded.state.mode, "mutation_first");
  assert.deepEqual(bounded.state.readLease.requestedRange, {
    startLine: 1,
    endLine: 60,
    maxLines: 60,
  });
  assert.equal(bounded.state.readLease.observationKey, "main:1-60:v1");
});

test("a changed parser declaration version invalidates its lease and retargets", () => {
  const state = activateExecuteRecoveryRuntimeState(
    createExecuteRecoveryRuntimeState({ workflowMode: "edit" }),
    {
      mode: "patch_recovery_read",
      reason: "approved_plan_declaration_range_required",
      expectedTarget: "src/main.js",
      readLease: {
        purpose: "initial_targeting",
        target: "src/main.js",
        requestedRange: { startLine: 600, endLine: 850, maxLines: 251 },
        coverageMode: "bounded_prefix",
        observedVersion: "50000:300",
        state: "available",
      },
    },
  );
  const changed = transitionExecuteRecoveryRuntimeState(state, {
    freshReadTarget: "src/main.js",
    sourceObservationKey: "main:600-660:v2",
    sourceRequestedRange: { startLine: 600, endLine: 660, maxLines: 61 },
    sourceObservedVersion: "50010:301",
  });
  assert.equal(changed.transition, "context_version_changed_to_targeting");
  assert.equal(changed.state.mode, "action_plus_targeting");
  assert.equal(changed.state.readLease, null);
  assert.equal(changed.state.decisionCheckpoint.nextRequiredCapability, "targeting");
  assert.equal(changed.state.decisionCheckpoint.evidenceVersion, "50010:301");
  assert.equal(changed.state.phaseNoProgressCount, 0);
});

test("reviewed Plan line ranges accumulate versioned read segments before mutation", () => {
  const state = activateExecuteRecoveryRuntimeState(
    createExecuteRecoveryRuntimeState({ workflowMode: "edit" }),
    {
      mode: "patch_recovery_read",
      reason: "approved_plan_declaration_range_required",
      expectedTarget: "src/main.js",
      readLease: {
        purpose: "plan_line_context",
        target: "src/main.js",
        requestedRange: { startLine: 205, endLine: 900, maxLines: 696 },
        requiredRange: { startLine: 205, endLine: 900, maxLines: 696 },
        coveredRanges: [],
        coverageMode: "segmented_exact",
        observedVersion: "90000:400",
        state: "available",
      },
    },
  );
  const first = transitionExecuteRecoveryRuntimeState(state, {
    freshReadTarget: "src/main.js",
    sourceObservationKey: "main:205-380:v1",
    sourceRequestedRange: { startLine: 205, endLine: 380, maxLines: 176 },
    sourceObservedVersion: "90000:400",
  });
  assert.equal(first.transition, "context_refreshed");
  assert.equal(first.state.mode, "patch_recovery_read");
  assert.deepEqual(first.state.readLease.requestedRange, {
    startLine: 381,
    endLine: 900,
    maxLines: 520,
  });
  assert.deepEqual(first.state.readLease.coveredRanges, [{ startLine: 205, endLine: 380 }]);
  assert.deepEqual(first.state.readLease.observationKeys, ["main:205-380:v1"]);

  const changedMidRange = transitionExecuteRecoveryRuntimeState(first.state, {
    freshReadTarget: "src/main.js",
    sourceObservationKey: "main:381-500:v2",
    sourceRequestedRange: { startLine: 381, endLine: 500, maxLines: 120 },
    sourceObservedVersion: "90010:401",
  });
  assert.equal(changedMidRange.transition, "context_refreshed");
  assert.deepEqual(changedMidRange.state.readLease.requestedRange, {
    startLine: 205,
    endLine: 900,
    maxLines: 696,
  });
  assert.deepEqual(changedMidRange.state.readLease.coveredRanges, []);
  assert.deepEqual(changedMidRange.state.readLease.observationKeys, []);
  assert.equal(changedMidRange.state.readLease.observedVersion, "90010:401");

  const second = transitionExecuteRecoveryRuntimeState(first.state, {
    freshReadTarget: "src/main.js",
    sourceObservationKey: "main:381-900:v1",
    sourceRequestedRange: { startLine: 381, endLine: 900, maxLines: 520 },
    sourceObservedVersion: "90000:400",
  });
  assert.equal(second.transition, "context_to_mutation");
  assert.equal(second.state.mode, "mutation_first");
  assert.deepEqual(second.state.readLease.coveredRanges, [
    { startLine: 205, endLine: 380 },
    { startLine: 381, endLine: 900 },
  ]);
  assert.equal(second.state.readLease.state, "consumed");
  assert.deepEqual(second.state.readLease.observationKeys, [
    "main:205-380:v1",
    "main:381-900:v1",
  ]);
});

test("policy deferrals, cache stubs, and PTY waits can refund the current phase debit", () => {
  let state = activateExecuteRecoveryRuntimeState(
    createExecuteRecoveryRuntimeState({ workflowMode: "edit" }),
    { mode: "validation_only", reason: "awaiting_runtime_evidence" },
  );
  state = advanceExecuteRecoveryRuntimeIteration(state).state;
  assert.equal(state.phaseNoProgressCount, 1);
  state = refundExecuteRecoveryRuntimeIteration(state);
  assert.equal(state.phaseNoProgressCount, 0);
  assert.equal(state.iterationCount, 0);
  assert.equal(refundExecuteRecoveryRuntimeIteration(state).phaseNoProgressCount, 0);
});

test("six identical unchanged-read stubs stop through the unified protocol budget", () => {
  let state = activateExecuteRecoveryRuntimeState(
    createExecuteRecoveryRuntimeState({ workflowMode: "edit" }),
    {
      mode: "patch_recovery_read",
      reason: "patch_mismatch",
      expectedTarget: "src/main.js",
      readLease: {
        purpose: "patch_recovery",
        target: "src/main.js",
        requestedRange: { startLine: 205, endLine: 256 },
        state: "active",
      },
    },
  );
  const fingerprint = "patch_recovery_read::src/main.js::unchanged_stub";
  for (let index = 1; index <= MAX_EXECUTE_RECOVERY_ITERATIONS; index += 1) {
    state = advanceExecuteRecoveryRuntimeIteration(state).state;
    state = refundExecuteRecoveryRuntimeIteration(state);
    state = registerExecuteRecoveryProtocolNoProgress(state, fingerprint);
    assert.equal(state.phaseNoProgressCount, 0);
    assert.equal(state.protocolNoProgressCount, index);
  }
  const boundary = advanceExecuteRecoveryRuntimeIteration(state);
  assert.equal(boundary.reachedMaxIterations, true);

  const changedRequest = registerExecuteRecoveryProtocolNoProgress(
    state,
    "patch_recovery_read::src/main.js::different-evidence-version",
  );
  assert.equal(changedRequest.protocolNoProgressCount, 1);
  assert.equal(changedRequest.protocolNoProgressFingerprint.includes("different-evidence-version"), true);

  const progressed = transitionExecuteRecoveryRuntimeState(state, {
    freshReadTarget: "src/main.js",
    sourceObservationKey: "src/main.js::v2::205-256",
    sourceRequestedRange: { startLine: 205, endLine: 256 },
  });
  assert.equal(progressed.transition, "context_to_mutation");
  assert.equal(progressed.state.protocolNoProgressCount, 0);
  assert.equal(progressed.state.protocolNoProgressFingerprint, null);
});

test("approved Plan scope conflicts stop after six semantic retries across mutation tool changes", () => {
  const fingerprint = buildApprovedPlanScopeConflictFingerprint({
    planRevision: 4,
    unexpectedTargets: ["src/components/toolbar.js"],
    plannedTargets: ["src/main.js"],
  });
  const normalizedFingerprint = buildApprovedPlanScopeConflictFingerprint({
    planRevision: 4,
    unexpectedTargets: ["./src/components/TOOLBAR.js"],
    plannedTargets: ["./src/main.js"],
  });
  assert.equal(normalizedFingerprint, fingerprint);

  let state = createExecuteRecoveryRuntimeState({ workflowMode: "plan" });
  for (let attempt = 1; attempt <= MAX_EXECUTE_RECOVERY_ITERATIONS; attempt += 1) {
    state = activateExecuteRecoveryRuntimeState(state, {
      mode: "mutation_first",
      reason: "approved_plan_scope_blocked",
      expectedTarget: "src/main.js",
    });
    state = registerExecuteRecoveryProtocolNoProgress(state, fingerprint);
    assert.equal(state.protocolNoProgressCount, attempt);
    if (attempt < MAX_EXECUTE_RECOVERY_ITERATIONS) {
      const nextTurn = advanceExecuteRecoveryRuntimeIteration(state);
      assert.equal(nextTurn.reachedMaxIterations, false);
      state = nextTurn.state;
    }
  }

  const boundary = advanceExecuteRecoveryRuntimeIteration(state);
  assert.equal(boundary.reachedMaxIterations, true);
  assert.equal(boundary.state.protocolNoProgressCount, MAX_EXECUTE_RECOVERY_ITERATIONS);

  const revisedPlan = registerExecuteRecoveryProtocolNoProgress(
    state,
    buildApprovedPlanScopeConflictFingerprint({
      planRevision: 5,
      unexpectedTargets: ["src/components/toolbar.js"],
      plannedTargets: ["src/main.js", "src/components/toolbar.js"],
    }),
  );
  assert.equal(revisedPlan.protocolNoProgressCount, 1);
});

test("PTY readiness closes an ordinary watch process without inventing a browser obligation", () => {
  let state = activateExecuteRecoveryRuntimeState(
    createExecuteRecoveryRuntimeState({ workflowMode: "edit" }),
    {
      mode: "validation_only",
      reason: "goal_slice_recovery",
      expectedTarget: "npm run watch",
      decisionCheckpoint: {
        expectedTarget: "npm run watch",
        sourceObservationKey: null,
        nextRequiredCapability: "observe_pty",
      },
    },
  );
  state = advanceExecuteRecoveryRuntimeIteration(state).state;
  const ready = transitionExecuteRecoveryRuntimeState(state, {
    validationTarget: "npm run watch",
    validationToolName: "get_pty_status",
  });
  assert.equal(ready.transition, "validation_to_normal");
  assert.equal(ready.state.mode, "normal");
});

test("long-running desktop validation requires launch and PTY readiness, not browser evidence", () => {
  let state = activateExecuteRecoveryRuntimeState(
    createExecuteRecoveryRuntimeState({ workflowMode: "edit" }),
    {
      mode: "validation_only",
      reason: "validation_after_mutation_required",
      expectedTarget: "src/App.tsx",
      decisionCheckpoint: {
        expectedTarget: "src/App.tsx",
        sourceObservationKey: "src/App.tsx::v2",
        nextRequiredCapability: "launch_long_process",
      },
    },
  );

  const launched = transitionExecuteRecoveryRuntimeState(state, {
    validationTarget: "cargo tauri dev",
    validationToolName: "execute_command",
  });
  assert.equal(launched.transition, "validation_progress");
  assert.equal(launched.state.mode, "validation_only");
  assert.equal(launched.state.decisionCheckpoint?.nextRequiredCapability, "observe_pty");

  const inputSent = transitionExecuteRecoveryRuntimeState(launched.state, {
    validationTarget: "y",
    validationToolName: "send_pty_input",
  });
  assert.equal(inputSent.transition, "validation_progress");
  assert.equal(inputSent.state.decisionCheckpoint?.nextRequiredCapability, "observe_pty");

  const observed = transitionExecuteRecoveryRuntimeState(inputSent.state, {
    validationTarget: "cargo tauri dev",
    validationToolName: "get_pty_status",
  });
  assert.equal(observed.transition, "validation_to_normal");
  assert.equal(observed.state.mode, "normal");
});

test("failed worker reconciliation ignores unrelated commands and closes on a healthy process probe", () => {
  const state = activateExecuteRecoveryRuntimeState(
    createExecuteRecoveryRuntimeState({ workflowMode: "edit" }),
    {
      mode: "action_plus_targeting",
      reason: "precompletion_evidence_gap:unreconciled_failure",
      expectedTarget: "node worker.js",
      decisionCheckpoint: {
        expectedTarget: "node worker.js",
        sourceObservationKey: null,
        nextRequiredCapability: "recover_process",
      },
    },
  );

  const unrelated = transitionExecuteRecoveryRuntimeState(state, {
    validationTarget: "npm test",
    validationToolName: "run_command",
  });
  assert.equal(unrelated.transition, "none");
  assert.equal(unrelated.state.mode, "action_plus_targeting");

  const healthy = transitionExecuteRecoveryRuntimeState(unrelated.state, {
    validationTarget: "curl -sS http://localhost:1420/",
    validationToolName: "run_command",
  });
  assert.equal(healthy.transition, "validation_to_normal");
  assert.equal(healthy.state.mode, "normal");
});

test("complex execution transaction reduces observe, repair, mutate, and validate through one kernel", () => {
  let state = activateExecuteRecoveryRuntimeState(
    createExecuteRecoveryRuntimeState({ workflowMode: "edit" }),
    {
      mode: "mutation_first",
      reason: "read_only_evidence_budget",
      expectedTarget: "src/main.js",
      sourceObservationKey: "src/main.js::v1::1-500",
      decisionCheckpoint: {
        expectedTarget: "src/main.js",
        sourceObservationKey: "src/main.js::v1::1-500",
        nextRequiredCapability: "mutation",
        evidenceVersion: "v1",
        planTaskId: "task-main-runtime",
        requirementRef: "REQ-MAIN",
      },
    },
  );
  state = advanceExecuteRecoveryRuntimeIteration(state).state;

  const refreshed = transitionExecuteRecoveryRuntimeState(state, {
    freshReadTarget: "src/main.js",
    sourceObservationKey: "src/main.js::v1::501-894",
    sourceRequestedRange: { startLine: 501, endLine: 894 },
    sourceObservedVersion: "v1",
  });
  assert.equal(refreshed.transition, "context_refreshed");
  assert.equal(refreshed.state.mode, "mutation_first");
  assert.equal(refreshed.state.phaseNoProgressCount, 0);
  assert.equal(refreshed.state.decisionCheckpoint?.nextRequiredCapability, "mutation");
  assert.equal(refreshed.state.decisionCheckpoint?.planTaskId, "task-main-runtime");
  assert.equal(refreshed.state.decisionCheckpoint?.requirementRef, "REQ-MAIN");

  const mutated = transitionExecuteRecoveryRuntimeState(refreshed.state, {
    mutationTarget: "src/main.js",
  });
  assert.equal(mutated.transition, "mutation_to_validation");
  assert.equal(mutated.state.mode, "validation_only");
  assert.equal(mutated.state.readLease, null);
  assert.equal(mutated.state.decisionCheckpoint?.planTaskId, "task-main-runtime");

  const repairedDuringValidation = transitionExecuteRecoveryRuntimeState(
    advanceExecuteRecoveryRuntimeIteration(mutated.state).state,
    { mutationTarget: "src/main.js" },
  );
  assert.equal(repairedDuringValidation.transition, "mutation_to_validation");
  assert.equal(repairedDuringValidation.state.mode, "validation_only");
  assert.equal(repairedDuringValidation.state.phaseNoProgressCount, 0);

  const validated = transitionExecuteRecoveryRuntimeState(repairedDuringValidation.state, {
    validationTarget: "npm test",
    validationToolName: "run_command",
  });
  assert.equal(validated.transition, "validation_to_normal");
  assert.equal(validated.state.mode, "normal");
  assert.equal(validated.state.expectedTarget, null);
});
