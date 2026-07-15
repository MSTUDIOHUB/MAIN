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
  applyCrossIterationReadFileRecoveryState,
  buildExecuteRecoveryMaxIterationsPrompt,
  clearExecuteRecoveryRuntimeState,
  createExecuteRecoveryRuntimeState,
  refundExecuteRecoveryRuntimeIteration,
  resolvePtyObservationPolicyDeferral,
  setRepeatedEditValidationRecoveryAttempts,
  transitionExecuteRecoveryRuntimeState,
} = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/lib/orchestrator/loop/executeRecoveryRuntime.ts"),
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
  assert.equal(forcedEdit.mode, "patch_recovery_read");
  assert.equal(forcedEdit.reason, "forced_execute_recovery");
  assert.equal(forcedEdit.expectedTarget, null);
  assert.equal(forcedEdit.attempts, 1);

  const restoredTransaction = createExecuteRecoveryRuntimeState({
    workflowMode: "edit",
    forcedState: {
      mode: "validation_only",
      reason: "goal_slice_recovery_restored",
      expectedTarget: "src/App.tsx",
      phaseNoProgressCount: 3,
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
  assert.equal(restoredTransaction.phaseNoProgressCount, 3);
  assert.equal(restoredTransaction.readLease?.purpose, "post_mutation_verify");
  assert.equal(restoredTransaction.sourceObservationKey, "src/App.tsx@version-2:20-40");
  assert.equal(restoredTransaction.decisionCheckpoint?.evidenceVersion, "ledger-7");

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

test("execute recovery state activates, advances, and clears without losing loop counters", () => {
  let state = createExecuteRecoveryRuntimeState({ workflowMode: "plan" });
  state = {
    ...state,
    consecutiveBlockedReadFileCount: 1,
    repeatedEditValidationAttempts: 1,
  };

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

  for (let i = 1; i <= MAX_EXECUTE_RECOVERY_ITERATIONS; i += 1) {
    const advanced = advanceExecuteRecoveryRuntimeIteration(state);
    state = advanced.state;
    assert.equal(advanced.reachedMaxIterations, i === MAX_EXECUTE_RECOVERY_ITERATIONS);
  }
  assert.equal(state.iterationCount, MAX_EXECUTE_RECOVERY_ITERATIONS);

  state = clearExecuteRecoveryRuntimeState(state);
  assert.equal(state.mode, "normal");
  assert.equal(state.reason, "");
  assert.equal(state.expectedTarget, null);
  assert.equal(state.attempts, 0);
  assert.equal(state.iterationCount, 0);
  assert.equal(state.consecutiveBlockedReadFileCount, 1);
  assert.equal(state.repeatedEditValidationAttempts, 1);
});

test("execute recovery state records blocked-read and validation recovery counters", () => {
  let state = activateExecuteRecoveryRuntimeState(
    createExecuteRecoveryRuntimeState({ workflowMode: "edit" }),
    { mode: "mutation_first", reason: "read_loop", expectedTarget: "src/App.tsx" },
  );
  state = applyCrossIterationReadFileRecoveryState(state, {
    mode: "normal",
    reason: "",
    consecutiveBlockedReadFileCount: 0,
  });
  assert.equal(state.mode, "normal");
  assert.equal(state.reason, "");
  assert.equal(state.expectedTarget, null);
  assert.equal(state.attempts, 1);

  state = setRepeatedEditValidationRecoveryAttempts(state, 2);
  assert.equal(state.repeatedEditValidationAttempts, 2);
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

test("execute recovery transaction advances read to mutation to validation without spending attempts", () => {
  let state = activateExecuteRecoveryRuntimeState(
    createExecuteRecoveryRuntimeState({ workflowMode: "edit" }),
    { mode: "patch_recovery_read", reason: "read_only_loop" },
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
  });
  assert.equal(read.transition, "context_to_mutation");
  assert.equal(read.state.mode, "mutation_first");
  assert.equal(read.state.expectedTarget, "src/App.tsx");
  assert.equal(read.state.attempts, attempts);
  assert.equal(read.consumedExpectedRead, true);
  state = read.state;

  const validationTooEarly = transitionExecuteRecoveryRuntimeState(state, { validationTarget: "npm test" });
  assert.equal(validationTooEarly.transition, "none");
  assert.equal(validationTooEarly.state.mode, "mutation_first");

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
  state = mutation.state;

  const validationBeforePostMutationRead = transitionExecuteRecoveryRuntimeState(state, {
    validationTarget: "npm test",
    validationToolName: "run_command",
  });
  assert.equal(validationBeforePostMutationRead.transition, "none");
  const postMutationRead = transitionExecuteRecoveryRuntimeState(state, {
    freshReadTarget: "src/App.tsx",
    sourceObservationKey: "src/App.tsx::post-mutation::v2",
  });
  assert.equal(postMutationRead.transition, "post_mutation_check_to_validation");
  state = postMutationRead.state;

  const verified = transitionExecuteRecoveryRuntimeState(state, { validationTarget: "npm test" });
  assert.equal(verified.transition, "validation_to_normal");
  assert.equal(verified.target, "src/App.tsx", "validation keeps the transaction target instead of its command label");
  assert.equal(verified.state.mode, "normal");
  assert.equal(verified.state.expectedTarget, null);
  assert.equal(verified.state.attempts, 0);
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
  assert.equal(mutation.state.readLease.purpose, "post_mutation_verify");

  state = advanceExecuteRecoveryRuntimeIteration(mutation.state).state;
  const postMutationRead = transitionExecuteRecoveryRuntimeState(state, {
    freshReadTarget: "src/App.tsx",
    sourceObservationKey: "src/App.tsx::205-256::v3",
  });
  assert.equal(postMutationRead.transition, "post_mutation_check_to_validation");
  assert.equal(postMutationRead.state.mode, "validation_only");
  assert.equal(postMutationRead.state.phaseNoProgressCount, 0);
  assert.equal(postMutationRead.state.readLease.state, "consumed");
  assert.equal(postMutationRead.state.decisionCheckpoint.nextRequiredCapability, "validation");
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

test("action-plus recovery observes PTY readiness before browser validation clears the transaction", () => {
  let state = activateExecuteRecoveryRuntimeState(
    createExecuteRecoveryRuntimeState({ workflowMode: "edit" }),
    {
      mode: "action_plus_targeting",
      reason: "goal_slice_recovery",
      expectedTarget: "src/App.tsx",
    },
  );
  state = advanceExecuteRecoveryRuntimeIteration(state).state;
  const pty = transitionExecuteRecoveryRuntimeState(state, {
    validationTarget: "terminal status",
    validationToolName: "get_pty_status",
  });
  assert.equal(pty.transition, "validation_progress");
  assert.equal(pty.state.mode, "action_plus_targeting");
  assert.equal(pty.state.phaseNoProgressCount, 0);
  assert.equal(pty.state.decisionCheckpoint.nextRequiredCapability, "browser_validation");

  const browser = transitionExecuteRecoveryRuntimeState(pty.state, {
    validationTarget: "http://localhost:1420/",
    validationToolName: "browser_evaluate",
  });
  assert.equal(browser.transition, "validation_to_normal");
  assert.equal(browser.state.mode, "normal");
});

test("validation recovery keeps the transaction open when PTY becomes ready", () => {
  let state = activateExecuteRecoveryRuntimeState(
    createExecuteRecoveryRuntimeState({ workflowMode: "edit" }),
    {
      mode: "validation_only",
      reason: "recovery_mutation_observed",
      expectedTarget: "src/App.tsx",
    },
  );
  state = advanceExecuteRecoveryRuntimeIteration(state).state;
  const pty = transitionExecuteRecoveryRuntimeState(state, {
    validationTarget: "terminal status",
    validationToolName: "read_pty_since",
  });
  assert.equal(pty.transition, "validation_progress");
  assert.equal(pty.state.mode, "validation_only");
  assert.equal(pty.state.phaseNoProgressCount, 0);
  assert.equal(pty.state.decisionCheckpoint.nextRequiredCapability, "browser_validation");

  const browser = transitionExecuteRecoveryRuntimeState(pty.state, {
    validationTarget: "http://localhost:1420/",
    validationToolName: "browser_evaluate",
  });
  assert.equal(browser.transition, "validation_to_normal");
  assert.equal(browser.state.mode, "normal");
});
