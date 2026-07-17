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
  assert.match(phaseSource, /handleNoProgressRecovery\(\{[\s\S]*?appendToolResultsToHistory\(\{/);
  assert.doesNotMatch(
    phaseSource,
    /handleReadFileRepeatLimitRecovery|handleCrossIterationReadFileLoopRecovery|handleRepeatedEditValidationRecovery/,
  );
  assert.match(phaseSource, /handlePlanReadOnlyConvergence\(\{[\s\S]*?pauseForReviewablePlanArtifact/);
  assert.match(phaseSource, /shouldPauseForReviewablePlanArtifactAfterToolResults\(\{[\s\S]*?pauseForReviewablePlanArtifact/);
  assert.match(
    phaseSource,
    /pauseForReviewablePlanArtifact\([\s\S]*?post_tool_plan_artifact_write[\s\S]*?planArtifactQualityRejected:\s*planRuntimeState\.planArtifactQualityRejected/,
  );
  assert.match(phaseSource, /handleStrictRepeatGuardRecovery\(\{[\s\S]*?handleTargetProgressLoopRecovery\(\{/);
  assert.match(
    phaseSource,
    /handleStrictRepeatGuardRecovery\(\{[\s\S]*?results:\s*input\.results/,
    "strict repetition must classify post-partition outcomes before counting a call",
  );
  assert.match(phaseSource, /handleExecuteConvergencePrompt\(\{[\s\S]*?logAgentEvent\("post_tool_result_continuation"/);
});

test("parent overlap with an active child joins before generic no-progress accounting", () => {
  const deferralIndex = phaseSource.indexOf(
    "shouldJoinPendingSubagentsAfterScopeDeferral(input.results)",
  );
  const joinIndex = phaseSource.indexOf(
    'reason: "scope_conflict"',
    deferralIndex,
  );
  const noProgressIndex = phaseSource.indexOf(
    "const noProgressRecovery = handleNoProgressRecovery({",
  );

  assert.notEqual(deferralIndex, -1);
  assert.notEqual(joinIndex, -1);
  assert.notEqual(noProgressIndex, -1);
  assert.ok(deferralIndex < joinIndex);
  assert.ok(joinIndex < noProgressIndex);
  assert.match(
    phaseSource.slice(deferralIndex, noProgressIndex),
    /appendToolResultsToHistory\(\{[\s\S]*?await joinPendingSubagentsForParent\(\{[\s\S]*?return finish\("continue"\)/,
  );
});

test("Goal evidence is checked immediately after tool results enter history", () => {
  const appendIndex = phaseSource.indexOf("appendToolResultsToHistory({", phaseSource.indexOf("handleNoProgressRecovery({"));
  const checkpointIndex = phaseSource.indexOf("evaluateGoalToolResultCheckpoint?.(");

  assert.notEqual(appendIndex, -1);
  assert.notEqual(checkpointIndex, -1);
  assert.ok(appendIndex < checkpointIndex);
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
  assert.doesNotMatch(phaseSource, /applyCrossIterationReadFileRecoveryState\(/);
  assert.doesNotMatch(phaseSource, /setRepeatedEditValidationRecoveryAttempts\(/);
  assert.match(phaseSource, /applyPlanReadOnlyConvergenceRuntimeState\(/);
  assert.match(phaseSource, /applyExecuteConvergencePromptState\(/);
  assert.match(phaseSource, /activateExecuteRecoveryAndSync\(/);
  assert.match(phaseSource, /executeRecoveryState,/);
});

test("approved plan scope blocks recover within the reviewed scope before completion can be audited", () => {
  const scopeCheckpointIndex = phaseSource.indexOf("const approvedPlanScopeBlockedTargets");
  const completionAuditIndex = phaseSource.indexOf("buildPlanTaskEvidenceAudit({", scopeCheckpointIndex);
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
  assert.match(phaseSource, /if \(input\.callbacks\.getIsPlanApproved\(\)\)/);
  assert.doesNotMatch(
    phaseSource,
    /workflowMode === "plan"\s*&&\s*input\.callbacks\.getIsPlanApproved\(\)/,
  );
  const closureCall = phaseSource.slice(closureIndex, recoveryGateIndex);
  assert.match(closureCall, /mutationExpected:\s*planTasks\.some\(isPlanTaskSourceMutationObligation\)/);
  assert.match(
    closureCall,
    /requiredCommandEvidence:\s*resolveCommandEvidenceRequirements\(\{[\s\S]*?tasks:\s*planTasks,[\s\S]*?getCommandDirective/,
  );
});

test("the first decision-complete approved target read atomically enters mutation", () => {
  const checkpointIndex = phaseSource.indexOf("const approvedPlanInitialMutationRead");
  const activationIndex = phaseSource.indexOf(
    '"approved_plan_target_context_observed"',
    checkpointIndex,
  );
  const noProgressIndex = phaseSource.indexOf("const noProgressRecovery = handleNoProgressRecovery({");

  assert.notEqual(checkpointIndex, -1);
  assert.notEqual(activationIndex, -1);
  assert.notEqual(noProgressIndex, -1);
  assert.ok(checkpointIndex < activationIndex);
  assert.ok(activationIndex < noProgressIndex);
  assert.match(phaseSource, /const pendingTask = audit\.remainingTasks\.find/);
  assert.match(phaseSource, /approvedPlanReadCoversDecisionAnchor\(pendingTask, result\)/);
  assert.match(phaseSource, /extractReadFileWindowMetadata/);
  assert.match(phaseSource, /lineAnchors\.every/);
  assert.match(
    phaseSource,
    /activateExecuteRecoveryAndSync\(\s*"mutation_first",\s*"approved_plan_target_context_observed",[\s\S]*?expectedTarget: approvedPlanInitialMutationRead\.target,[\s\S]*?sourceObservationKey:/,
  );
  assert.match(phaseSource, /approved_plan_target_context_observed[\s\S]*?nextRequiredCapability:\s*"mutation"/);
  assert.doesNotMatch(phaseSource, /SOURCE_CONTEXT_LOCKED|Do not read or investigate again|Call exactly one exposed mutation tool/);
});

test("premature browser validation activates PTY observation recovery before completion auditing", () => {
  const deferralIndex = phaseSource.indexOf("resolvePtyObservationPolicyDeferral(input.results)");
  const activationIndex = phaseSource.indexOf(
    '"browser_validation_deferred_for_pty_observation"',
    deferralIndex,
  );
  const completionAuditIndex = phaseSource.indexOf("buildPlanTaskEvidenceAudit({", activationIndex);

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
  assert.match(
    phaseSource,
    /executeRecoveryState\.mode === "normal" \|\|\s*currentRecoveryCapability !== devServerRecoveryCapability/,
    "fresh PTY/browser evidence must be able to replace a stale active command-validation contract",
  );
  assert.match(
    phaseSource,
    /decisionCheckpoint:[\s\S]*?nextRequiredCapability: nextCapability/,
    "the lifecycle transition must persist the exact next capability instead of relying on a log-only hint",
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
  assert.match(phaseSource, /buildFailedValidationRepairReadLease\(\{/);
  assert.match(phaseSource, /"mutation_first",[\s\S]*?repairReadLease \? \{ readLease: repairReadLease \}/);
  assert.match(phaseSource, /repairReadLease \? \{ sourceObservationKey: null \}/);
  assert.match(phaseSource, /nextRequiredCapability: repairReadLease \? "targeted_read" : "mutation"/);
  assert.match(phaseSource, /approved_plan_finite_validation_requires_repair/);
  assert.doesNotMatch(
    phaseSource,
    /clearExecuteRecoveryRuntimeState\(executeRecoveryState\)/,
    "a failed validation stays inside the active repair transaction",
  );
});

test("browser runtime failures atomically leave browser-only validation for source repair", () => {
  const failureIndex = phaseSource.indexOf("const failedBrowserValidation");
  const finiteFailureIndex = phaseSource.indexOf("const failedFiniteValidation");
  const branch = phaseSource.slice(failureIndex, finiteFailureIndex);

  assert.notEqual(failureIndex, -1);
  assert.notEqual(finiteFailureIndex, -1);
  assert.ok(failureIndex < finiteFailureIndex);
  assert.match(branch, /resolveLatestUnreconciledFailureSignal/);
  assert.match(branch, /failure\?\.domain === "browser"/);
  assert.match(branch, /buildFailedValidationRepairReadLease/);
  assert.match(branch, /"browser_validation_requires_source_repair"/);
  assert.match(branch, /nextRequiredCapability: "targeted_read"/);
  assert.match(branch, /return finish\("continue"\)/);
  assert.doesNotMatch(branch, /reconcile_server/);
});

test("tool iteration phase delegates tool-result recovery internals to the phase helper", () => {
  assert.match(orchestratorSource, /handleToolIterationPhase\(\{/);
  assert.match(toolIterationPhaseSource, /handleToolResultRecoveryPhase\(\{/);
  assert.match(toolIterationPhaseSource, /planRuntimeState: toolCallPhase\.planRuntimeState/);
  assert.match(toolIterationPhaseSource, /recoveryPromptState: toolCallPhase\.recoveryPromptState/);
  assert.match(toolIterationPhaseSource, /results: toolCallPhase\.allResults/);
  assert.match(toolIterationPhaseSource, /executeRecoveryState: toolResultRecoveryPhase\.executeRecoveryState/);
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
