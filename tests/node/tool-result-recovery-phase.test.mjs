import test from "node:test";
import assert from "node:assert/strict";
import fsSync from "node:fs";
import path from "node:path";

const workspaceRoot = process.cwd();
const phaseSource = fsSync.readFileSync(
  path.join(workspaceRoot, "src/lib/orchestrator/loop/toolResultRecoveryPhase.ts"),
  "utf8",
);
const orchestratorSource = fsSync.readFileSync(
  path.join(workspaceRoot, "src/lib/orchestrator/loop/AgentOrchestrator.ts"),
  "utf8",
);
const toolIterationPhaseSource = fsSync.readFileSync(
  path.join(workspaceRoot, "src/lib/orchestrator/loop/toolIterationPhase.ts"),
  "utf8",
);

test("tool result recovery phase owns post-tool recovery ordering", () => {
  assert.match(phaseSource, /export async function handleToolResultRecoveryPhase/);
  assert.match(phaseSource, /handlePlanQualityRecoveryAfterToolResults\(\{[\s\S]*?handleNoProgressRecovery\(\{/);
  assert.match(phaseSource, /appendToolResultsToHistory\(\{[\s\S]*?handleReadFileRepeatLimitRecovery\(\{/);
  assert.match(phaseSource, /handleCrossIterationReadFileLoopRecovery\(\{[\s\S]*?handleRepeatedEditValidationRecovery\(\{/);
  assert.match(phaseSource, /handlePlanReadOnlyConvergence\(\{[\s\S]*?pauseForReviewablePlanArtifact/);
  assert.match(phaseSource, /shouldPauseForReviewablePlanArtifactAfterToolResults\(\{[\s\S]*?pauseForReviewablePlanArtifact/);
  assert.match(
    phaseSource,
    /pauseForReviewablePlanArtifact\([\s\S]*?post_tool_plan_artifact_write[\s\S]*?planArtifactQualityRejected:\s*planRuntimeState\.planArtifactQualityRejected/,
  );
  assert.match(phaseSource, /handleStrictRepeatGuardRecovery\(\{[\s\S]*?handleTargetProgressLoopRecovery\(\{/);
  assert.match(phaseSource, /handleExecuteConvergencePrompt\(\{[\s\S]*?logAgentEvent\("post_tool_result_continuation"/);
});

test("Goal evidence is checked immediately after tool results enter history", () => {
  const appendIndex = phaseSource.indexOf("appendToolResultsToHistory({", phaseSource.indexOf("handleNoProgressRecovery({"));
  const checkpointIndex = phaseSource.indexOf("evaluateGoalToolResultCheckpoint?.(");
  const readRecoveryIndex = phaseSource.indexOf("handleReadFileRepeatLimitRecovery({");

  assert.notEqual(appendIndex, -1);
  assert.notEqual(checkpointIndex, -1);
  assert.notEqual(readRecoveryIndex, -1);
  assert.ok(appendIndex < checkpointIndex);
  assert.ok(checkpointIndex < readRecoveryIndex);
  assert.match(phaseSource, /return finish\("goal_completed"\)/);
  assert.match(orchestratorSource, /toolIterationPhase\.status === "goal_completed"[\s\S]*?goal_inner_loop_evidence_boundary[\s\S]*?return;/);
});

test("tool result recovery phase owns runtime state folds", () => {
  assert.match(
    phaseSource,
    /const activateExecuteRecoveryAndSync[\s\S]*?executeRecoveryState = input\.activateExecuteRecovery\(mode, reason, context\)/,
    "a recovery activation must update the phase-local state before the reducer returns",
  );
  assert.match(
    phaseSource,
    /handleNoProgressRecovery\(\{[\s\S]*?activateExecuteRecovery: activateExecuteRecoveryAndSync/,
    "direct mutation mismatch recovery must use the synchronized activation path",
  );
  assert.match(phaseSource, /applyPlanQualityRuntimeState\(/);
  assert.match(phaseSource, /applyNoProgressTrackingRuntimeState\(/);
  assert.match(phaseSource, /applyToolFailureSignatureRuntimeState\(/);
  assert.match(phaseSource, /applyCrossIterationReadFileRecoveryState\(/);
  assert.match(phaseSource, /setRepeatedEditValidationRecoveryAttempts\(/);
  assert.match(phaseSource, /applyPlanReadOnlyConvergenceRuntimeState\(/);
  assert.match(phaseSource, /applyExecuteConvergencePromptState\(/);
  assert.match(phaseSource, /approvedPlanRecoveryState = input\.continueApprovedPlanWithStrategySwitch/);
  assert.match(phaseSource, /approvedPlanRecoveryState,/);
});

test("approved plan scope blocks recover within the reviewed scope before completion can be audited", () => {
  const scopeCheckpointIndex = phaseSource.indexOf("const approvedPlanScopeBlockedTargets");
  const completionAuditIndex = phaseSource.indexOf("buildPlanTaskEvidenceAudit({");
  const recoveryActivationIndex = phaseSource.indexOf(
    '"approved_plan_scope_blocked"',
    scopeCheckpointIndex,
  );
  const recoveryPromptAppendIndex = phaseSource.indexOf(
    "content: recoveryPrompt",
    scopeCheckpointIndex,
  );

  assert.notEqual(scopeCheckpointIndex, -1);
  assert.notEqual(completionAuditIndex, -1);
  assert.notEqual(recoveryActivationIndex, -1);
  assert.notEqual(recoveryPromptAppendIndex, -1);
  assert.ok(scopeCheckpointIndex < completionAuditIndex);
  assert.ok(recoveryActivationIndex < recoveryPromptAppendIndex);
  assert.match(phaseSource, /getApprovedPlanScopeConflict\(input\.results\)/);
  assert.match(
    phaseSource,
    /const conflict = result\.approvedPlanScopeConflict;[\s\S]*?\(!conflict && !APPROVED_PLAN_SCOPE_BLOCKED_RE/,
  );
  assert.match(
    phaseSource,
    /activateExecuteRecoveryAndSync\(\s*"mutation_first",\s*"approved_plan_scope_blocked",[\s\S]*?expectedTarget: plannedTargets\[0\][\s\S]*?protocolNoProgressFingerprint/,
  );
  assert.match(phaseSource, /buildApprovedPlanScopeConflictFingerprint\(\{/);
  assert.match(phaseSource, /buildPlanApprovalIdentity\([\s\S]*?getPlanArtifacts/);
  assert.match(phaseSource, /logAgentEvent\("approved_plan_scope_block_recovering"/);
  assert.match(phaseSource, /emitPlanExecutionProgress\("running",[\s\S]*?approved_plan_scope_block_recovering/);
  assert.match(phaseSource, /appendMessage\(\{[\s\S]*?content: recoveryPrompt/);
  assert.doesNotMatch(phaseSource, /approved_plan_scope_revision_required/);
});

test("approved plan completion is committed only after closure and active-recovery gates", () => {
  const closureIndex = phaseSource.indexOf("const evidenceClosureAudit = buildExecuteEvidenceClosureAudit({");
  const recoveryGateIndex = phaseSource.indexOf('executeRecoveryState.mode === "normal"', closureIndex);
  const doneIndex = phaseSource.indexOf('input.emitTaskOrchestratorPhase("DONE"', closureIndex);
  const completedStageIndex = phaseSource.indexOf('input.callbacks.onPlanStageChanged("completed")', closureIndex);

  assert.notEqual(closureIndex, -1);
  assert.notEqual(recoveryGateIndex, -1);
  assert.notEqual(doneIndex, -1);
  assert.notEqual(completedStageIndex, -1);
  assert.ok(closureIndex < recoveryGateIndex);
  assert.ok(recoveryGateIndex < doneIndex);
  assert.ok(doneIndex < completedStageIndex);
  assert.match(phaseSource, /evidenceClosureAudit\.completionAllowed/);
});

test("premature browser validation activates PTY observation recovery before completion auditing", () => {
  const deferralIndex = phaseSource.indexOf("resolvePtyObservationPolicyDeferral(input.results)");
  const activationIndex = phaseSource.indexOf(
    '"browser_validation_deferred_for_pty_observation"',
    deferralIndex,
  );
  const completionAuditIndex = phaseSource.indexOf("buildPlanTaskEvidenceAudit({");

  assert.notEqual(deferralIndex, -1);
  assert.notEqual(activationIndex, -1);
  assert.notEqual(completionAuditIndex, -1);
  assert.ok(deferralIndex < activationIndex);
  assert.ok(activationIndex < completionAuditIndex);
  assert.match(
    phaseSource,
    /executeRecoveryState\.mode === "normal" && ptyObservationDeferral[\s\S]*?activateExecuteRecoveryAndSync\(\s*"validation_only"/,
  );
  assert.match(phaseSource, /nextCapability: "observe_pty"/);
});

test("a long-process result atomically narrows the next turn to PTY observation or browser validation", () => {
  const runtimeIndex = phaseSource.indexOf("const devServerRuntime = resolveDevServerRuntimeState(");
  const noProgressIndex = phaseSource.indexOf("const noProgressRecovery = handleNoProgressRecovery({");
  const activationIndex = phaseSource.indexOf(
    '"execute_recovery_activated_from_dev_server_evidence"',
    runtimeIndex,
  );

  assert.notEqual(runtimeIndex, -1);
  assert.notEqual(noProgressIndex, -1);
  assert.notEqual(activationIndex, -1);
  assert.ok(runtimeIndex < activationIndex);
  assert.ok(activationIndex < noProgressIndex);
  assert.match(
    phaseSource,
    /devServerRuntime\.nextCapability === "observe_pty"[\s\S]*?devServerEvidenceGap === "pty_observation_required"/,
  );
  assert.match(
    phaseSource,
    /devServerRuntime\.nextCapability === "browser"[\s\S]*?devServerEvidenceGap === "browser_validation_required"/,
  );
  assert.match(
    phaseSource,
    /activateExecuteRecoveryAndSync\(\s*"validation_only",[\s\S]*?nextCapability,[\s\S]*?foregroundGeneration/,
  );
  assert.match(phaseSource, /return finish\("continue"\)/);
});

test("approved Plan finite command failures split invocation recovery from source repair", () => {
  const appendIndex = phaseSource.indexOf(
    "appendToolResultsToHistory({",
    phaseSource.indexOf("handleNoProgressRecovery({"),
  );
  const recoveryIndex = phaseSource.indexOf("approved_plan_finite_validation_recovery");
  const goalCheckpointIndex = phaseSource.indexOf("evaluateGoalToolResultCheckpoint?.(");

  assert.notEqual(appendIndex, -1);
  assert.notEqual(recoveryIndex, -1);
  assert.notEqual(goalCheckpointIndex, -1);
  assert.ok(appendIndex < recoveryIndex);
  assert.ok(recoveryIndex < goalCheckpointIndex);
  assert.match(phaseSource, /classifyFailedFiniteValidationOutcome\(\{/);
  assert.match(phaseSource, /failedFiniteValidationOutcome === "invocation_error"[\s\S]*?"finite_validation_only"/);
  assert.match(phaseSource, /"finite_validation_only",\s*"failed_finite_validation_command"/);
  assert.match(phaseSource, /shouldEnterFailedFiniteValidationRecovery\(command\)/);
  assert.match(phaseSource, /remainingPlanTasksAfterFailedFiniteValidation[\s\S]*?hasPendingPlanCommandEvidence\(remainingPlanTasksAfterFailedFiniteValidation\)/);
  assert.match(phaseSource, /resolveFailedFiniteValidationRecoveryPolicy\(\{/);
  assert.match(phaseSource, /buildFailedFiniteValidationRecoveryPrompt\(\{/);
  assert.match(phaseSource, /failedFiniteValidationOutcome === "validation_failure"[\s\S]*?failedFiniteValidationMatchesPendingPlanEvidence\(\{/);
  assert.match(phaseSource, /approved_plan_finite_validation_requires_repair/);
  assert.match(phaseSource, /clearExecuteRecoveryRuntimeState\(executeRecoveryState\)/);
});

test("tool iteration phase delegates tool-result recovery internals to the phase helper", () => {
  assert.match(orchestratorSource, /handleToolIterationPhase\(\{/);
  assert.match(toolIterationPhaseSource, /handleToolResultRecoveryPhase\(\{/);
  assert.match(toolIterationPhaseSource, /planRuntimeState: toolCallPhase\.planRuntimeState/);
  assert.match(toolIterationPhaseSource, /recoveryPromptState: toolCallPhase\.recoveryPromptState/);
  assert.match(toolIterationPhaseSource, /results: toolCallPhase\.allResults/);
  assert.match(toolIterationPhaseSource, /approvedPlanRecoveryState: toolResultRecoveryPhase\.approvedPlanRecoveryState/);
  assert.doesNotMatch(orchestratorSource, /handleToolResultRecoveryPhase\(\{/);
  assert.doesNotMatch(orchestratorSource, /appendToolResultsToHistory\(/);
  assert.doesNotMatch(orchestratorSource, /handleNoProgressRecovery\(/);
  assert.doesNotMatch(orchestratorSource, /handleReadFileRepeatLimitRecovery\(/);
  assert.doesNotMatch(orchestratorSource, /handleCrossIterationReadFileLoopRecovery\(/);
  assert.doesNotMatch(orchestratorSource, /handleRepeatedEditValidationRecovery\(/);
  assert.doesNotMatch(orchestratorSource, /handleStrictRepeatGuardRecovery\(/);
  assert.doesNotMatch(orchestratorSource, /handleTargetProgressLoopRecovery\(/);
  assert.doesNotMatch(orchestratorSource, /handleExecuteConvergencePrompt\(/);
});
