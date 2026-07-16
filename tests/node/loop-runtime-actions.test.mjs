import test from "node:test";
import assert from "node:assert/strict";
import fsSync from "node:fs";
import path from "node:path";

const workspaceRoot = process.cwd();

function sourceFor(relativePath) {
  return fsSync.readFileSync(path.join(workspaceRoot, relativePath), "utf8");
}

function indexOfRequired(source, pattern) {
  const index = source.search(pattern);
  assert.notEqual(index, -1, `Expected source to contain ${pattern}`);
  return index;
}

test("loop runtime actions own mutable recovery and phase reducers", () => {
  const actionsSource = sourceFor("src/lib/orchestrator/loop/loopRuntimeActions.ts");

  assert.match(actionsSource, /export function createAgentLoopRuntimeActions/);
  assert.match(actionsSource, /activateExecuteRecoveryRuntimeState\(/);
  assert.match(actionsSource, /expectedTarget/);
  assert.match(actionsSource, /repeatedTargets\.length === 1/);
  assert.match(actionsSource, /patchRecoveryLeaseIdentityMatches\(/);
  assert.match(actionsSource, /registerExecuteRecoveryProtocolNoProgress\(/);
  assert.match(
    actionsSource,
    /context\.protocolNoProgressFingerprint[\s\S]*?registerExecuteRecoveryProtocolNoProgress\(/,
  );
  assert.match(actionsSource, /activateChatFinalSynthesisState\(/);
  assert.match(actionsSource, /clearExecuteRecoveryRuntimeState\(stateOverride\)/);
  assert.match(actionsSource, /clearCrossIterationReadTrackingForTarget\(/);
  assert.match(actionsSource, /applyPlanRuntimePhase\(/);
  assert.match(actionsSource, /buildPlanRuntimeCapsuleNarration\(/);
  assert.match(actionsSource, /onPlanRuntimeNarration\?\./);
  assert.doesNotMatch(actionsSource, /onTurnRuntimePhaseChanged\?\./);
});

test("loop runtime actions keep recovery telemetry next to the state mutation", () => {
  const actionsSource = sourceFor("src/lib/orchestrator/loop/loopRuntimeActions.ts");

  const activateRecovery = indexOfRequired(actionsSource, /activateExecuteRecoveryRuntimeState\(/);
  const comparePatchLease = indexOfRequired(actionsSource, /patchRecoveryLeaseIdentityMatches\(/);
  const countPatchLeaseRetry = indexOfRequired(actionsSource, /registerExecuteRecoveryProtocolNoProgress\(/);
  const activateRecoveryLog = indexOfRequired(actionsSource, /execute_recovery_activated/);
  const chatSynthesis = indexOfRequired(actionsSource, /activateChatFinalSynthesisState\(/);
  const chatSynthesisLog = indexOfRequired(actionsSource, /chat_final_synthesis_activated/);
  const clearRecovery = indexOfRequired(actionsSource, /clearExecuteRecoveryRuntimeState\(stateOverride\)/);
  const clearRecoveryLog = indexOfRequired(actionsSource, /execute_recovery_cleared/);

  assert.ok(activateRecovery < activateRecoveryLog);
  assert.ok(comparePatchLease < activateRecovery);
  assert.ok(comparePatchLease < countPatchLeaseRetry);
  assert.ok(countPatchLeaseRetry < activateRecoveryLog);
  assert.ok(chatSynthesis < chatSynthesisLog);
  assert.ok(clearRecovery < clearRecoveryLog);
});

test("agent loop delegates runtime action details to the action module", () => {
  const orchestratorSource = sourceFor("src/lib/orchestrator/loop/AgentOrchestrator.ts");

  assert.match(orchestratorSource, /createAgentLoopRuntimeActions\(\{/);
  assert.doesNotMatch(orchestratorSource, /activateExecuteRecoveryRuntimeState\(/);
  assert.doesNotMatch(orchestratorSource, /activateChatFinalSynthesisState\(/);
  assert.doesNotMatch(orchestratorSource, /clearExecuteRecoveryRuntimeState\(/);
  assert.doesNotMatch(orchestratorSource, /applyPlanRuntimePhase\(/);
  assert.doesNotMatch(orchestratorSource, /execute_recovery_activated/);
  assert.doesNotMatch(orchestratorSource, /plan_runtime_phase_changed/);
});
