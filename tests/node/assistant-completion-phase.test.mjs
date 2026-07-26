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

test("assistant completion phase owns the no-tool assistant completion ordering", () => {
  const phaseSource = sourceFor("src/lib/orchestrator/loop/assistantCompletionPhase.ts");

  assert.match(phaseSource, /export async function handleAssistantCompletionPhase/);

  const replyOptionsPause = indexOfRequired(phaseSource, /handleReplyOptionsPause\(\{/);
  const preCompletionEvidenceAudit = indexOfRequired(phaseSource, /resolvePreCompletionEvidenceRecoveryDecision\(\{/);
  const activeRecoveryContract = indexOfRequired(phaseSource, /currentExecuteRecoveryState\.mode !== "normal"/);
  const executeNoToolRecovery = indexOfRequired(phaseSource, /handleExecuteNoToolRecovery\(\{/);
  const planNoToolRecovery = indexOfRequired(phaseSource, /handlePlanNoToolRecovery\(\{/);
  const missingToolNoToolRecovery = indexOfRequired(phaseSource, /handleMissingToolNoToolRecovery\(\{/);
  const approvedPlanFinalization = indexOfRequired(phaseSource, /handleApprovedPlanFinalization\(\{/);
  const finalNoToolAssistantTurn = indexOfRequired(phaseSource, /handleFinalNoToolAssistantTurn\(\{/);

  assert.ok(replyOptionsPause < preCompletionEvidenceAudit);
  assert.ok(preCompletionEvidenceAudit < executeNoToolRecovery);
  assert.ok(executeNoToolRecovery < activeRecoveryContract);
  assert.ok(executeNoToolRecovery < planNoToolRecovery);
  assert.ok(planNoToolRecovery < missingToolNoToolRecovery);
  assert.ok(missingToolNoToolRecovery < approvedPlanFinalization);
  assert.ok(approvedPlanFinalization < finalNoToolAssistantTurn);
  assert.match(phaseSource, /onStreamToken\("__ESCALATION_RESET__:evidence_recovery", input\.assistantMsgId\)/);
  assert.match(phaseSource, /onStreamToken\("__EVIDENCE_DRAFT_COMMIT__:evidence_closed", input\.assistantMsgId\)/);
  assert.match(phaseSource, /precompletion_evidence_recovery_activated/);
  assert.match(
    phaseSource,
    /resolveJoinedSubagentMutationValidationRecovery\(\{[\s\S]*?joined_subagent_mutation_requires_parent_validation[\s\S]*?parent_join_mutation_validation_activated/,
  );
  assert.match(
    phaseSource,
    /validationExpectedForThisRun[\s\S]*?getSubagentDepth\?\.\(\)[\s\S]*?validationExpected === true/,
  );
  assert.doesNotMatch(
    phaseSource,
    /validationExpected:[\s\S]{0,160}!externalReviewIsAdvisory/,
  );
  assert.match(phaseSource, /currentExecuteRecoveryState\.mode !== "normal"/);
  assert.match(phaseSource, /precompletion_evidence_recovery_still_active/);
  assert.match(phaseSource, /protocolViolationOnly: currentExecuteRecoveryState\.mode !== "normal"/);
  assert.ok(
    indexOfRequired(phaseSource, /currentExecuteRecoveryState\.mode !== "normal"/) <
      indexOfRequired(phaseSource, /__EVIDENCE_DRAFT_COMMIT__:evidence_closed/),
  );
});

test("execute conclusions are held until evidence audit commits or discards the draft", () => {
  const orchestratorSource = sourceFor("src/lib/orchestrator/loop/AgentOrchestrator.ts");
  const workflowSource = sourceFor("src/lib/orchestrator/workflowEngine.ts");
  const iterationSource = sourceFor("src/lib/orchestrator/loop/assistantIterationPhase.ts");

  assert.match(orchestratorSource, /__EVIDENCE_DRAFT_HOLD__:execution_evidence/);
  assert.match(
    orchestratorSource,
    /const holdExecuteConclusionDraft =\s*runtimeIntent === "execute" &&\s*requiresExecutionEvidence/,
  );
  assert.doesNotMatch(orchestratorSource, /preStreamEvidenceAudit/);
  assert.match(workflowSource, /executionEvidenceDraftHeld/);
  assert.match(workflowSource, /executionEvidenceDraftBuffer \+= token/);
  assert.match(workflowSource, /pendingEvidenceDraftFinalPresentation = \{/);
  assert.match(workflowSource, /execution_evidence_final_presentation_held/);
  assert.match(workflowSource, /if \(finalPresentation\) \{[\s\S]*callbacks\.onAssistantFinalText\(/);
  assert.match(workflowSource, /else if \(draft && commitReason === "tool_call"\)/);
  assert.doesNotMatch(
    workflowSource,
    /else if \(draft && commitReason === "tool_call"\)[\s\S]{0,500}streamBuffer\.append\(draft\)/,
  );
  assert.match(workflowSource, /structured tool\/progress events own[\s\S]*visible activity projection/);
  assert.doesNotMatch(
    workflowSource,
    /: hasToolCalls[\s\S]{0,400}summary: normalizedFinal \|\| turn\.summary/,
  );
  assert.match(workflowSource, /isUnapprovedPlanRuntime\(\) \|\| context\.executionEvidenceDraftHeld/);
  assert.match(iterationSource, /__EVIDENCE_DRAFT_COMMIT__:tool_call/);
});

test("assistant completion phase owns no-tool runtime state folds", () => {
  const phaseSource = sourceFor("src/lib/orchestrator/loop/assistantCompletionPhase.ts");

  assert.match(phaseSource, /applyConsecutiveNoToolRuntimeState\(/);
  assert.match(phaseSource, /applyPlanNoToolRuntimeState\(/);
  assert.match(phaseSource, /setPlanRuntimePhaseAndSync/);
  assert.match(phaseSource, /input\.setPlanRuntimePhase\(phase, reason, status, qualitySnapshot\)/);
  assert.match(phaseSource, /planRuntimeState = applyPlanRuntimePhase\(\{/);
  assert.match(phaseSource, /planLastMissingSections: \[\.\.\.qualitySnapshot\.missingSections\]/);
  assert.match(phaseSource, /applyRecoveringFromEmptyAssistantReplyRuntimeState\(/);
});

test("assistant iteration phase delegates assistant completion details to the phase module", () => {
  const orchestratorSource = sourceFor("src/lib/orchestrator/loop/AgentOrchestrator.ts");
  const iterationPhaseSource = sourceFor("src/lib/orchestrator/loop/assistantIterationPhase.ts");

  assert.match(orchestratorSource, /handleAssistantIterationPhase\(\{/);
  assert.match(iterationPhaseSource, /handleAssistantCompletionPhase\(\{/);
  assert.doesNotMatch(orchestratorSource, /handleAssistantCompletionPhase\(\{/);
  assert.doesNotMatch(orchestratorSource, /handleReplyOptionsPause\(\{/);
  assert.doesNotMatch(orchestratorSource, /handleExecuteNoToolRecovery\(\{/);
  assert.doesNotMatch(orchestratorSource, /handlePlanNoToolRecovery\(\{/);
  assert.doesNotMatch(orchestratorSource, /handleMissingToolNoToolRecovery\(\{/);
  assert.doesNotMatch(orchestratorSource, /handleApprovedPlanFinalization\(\{/);
  assert.doesNotMatch(orchestratorSource, /handleFinalNoToolAssistantTurn\(\{/);
});
