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

test("approved plan scope blocks become a revision checkpoint before completion can be audited", () => {
  const scopeCheckpointIndex = phaseSource.indexOf("const approvedPlanScopeBlockedTargets");
  const completionAuditIndex = phaseSource.indexOf("buildPlanTaskEvidenceAudit({");

  assert.notEqual(scopeCheckpointIndex, -1);
  assert.notEqual(completionAuditIndex, -1);
  assert.ok(scopeCheckpointIndex < completionAuditIndex);
  assert.match(phaseSource, /getApprovedPlanScopeBlockedTargets\(input\.results\)/);
  assert.match(phaseSource, /logAgentEvent\("approved_plan_scope_revision_required"/);
  assert.match(phaseSource, /emitPlanExecutionProgress\("paused",[\s\S]*?approved_plan_scope_revision_required/);
  assert.match(phaseSource, /onNonActionableStop\(message, "incomplete_plan",[\s\S]*?approved_plan_scope_revision_required/);
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
