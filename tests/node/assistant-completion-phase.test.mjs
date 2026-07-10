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
  const approvedPlanNoToolRecovery = indexOfRequired(phaseSource, /handleApprovedPlanNoToolRecovery\(\{/);
  const executeNoToolRecovery = indexOfRequired(phaseSource, /handleExecuteNoToolRecovery\(\{/);
  const planNoToolRecovery = indexOfRequired(phaseSource, /handlePlanNoToolRecovery\(\{/);
  const missingToolNoToolRecovery = indexOfRequired(phaseSource, /handleMissingToolNoToolRecovery\(\{/);
  const approvedPlanFinalization = indexOfRequired(phaseSource, /handleApprovedPlanFinalization\(\{/);
  const finalNoToolAssistantTurn = indexOfRequired(phaseSource, /handleFinalNoToolAssistantTurn\(\{/);

  assert.ok(replyOptionsPause < approvedPlanNoToolRecovery);
  assert.ok(approvedPlanNoToolRecovery < executeNoToolRecovery);
  assert.ok(executeNoToolRecovery < planNoToolRecovery);
  assert.ok(planNoToolRecovery < missingToolNoToolRecovery);
  assert.ok(missingToolNoToolRecovery < approvedPlanFinalization);
  assert.ok(approvedPlanFinalization < finalNoToolAssistantTurn);
});

test("assistant completion phase owns no-tool runtime state folds", () => {
  const phaseSource = sourceFor("src/lib/orchestrator/loop/assistantCompletionPhase.ts");

  assert.match(phaseSource, /applyConsecutiveNoToolRuntimeState\(/);
  assert.match(phaseSource, /applyApprovedPlanNoToolRecoveryState\(/);
  assert.match(phaseSource, /applyPlanNoToolRuntimeState\(/);
  assert.match(phaseSource, /applyRecoveringFromEmptyAssistantReplyRuntimeState\(/);
});

test("assistant iteration phase delegates assistant completion details to the phase module", () => {
  const orchestratorSource = sourceFor("src/lib/orchestrator/loop/AgentOrchestrator.ts");
  const iterationPhaseSource = sourceFor("src/lib/orchestrator/loop/assistantIterationPhase.ts");

  assert.match(orchestratorSource, /handleAssistantIterationPhase\(\{/);
  assert.match(iterationPhaseSource, /handleAssistantCompletionPhase\(\{/);
  assert.doesNotMatch(orchestratorSource, /handleAssistantCompletionPhase\(\{/);
  assert.doesNotMatch(orchestratorSource, /handleReplyOptionsPause\(\{/);
  assert.doesNotMatch(orchestratorSource, /handleApprovedPlanNoToolRecovery\(\{/);
  assert.doesNotMatch(orchestratorSource, /handleExecuteNoToolRecovery\(\{/);
  assert.doesNotMatch(orchestratorSource, /handlePlanNoToolRecovery\(\{/);
  assert.doesNotMatch(orchestratorSource, /handleMissingToolNoToolRecovery\(\{/);
  assert.doesNotMatch(orchestratorSource, /handleApprovedPlanFinalization\(\{/);
  assert.doesNotMatch(orchestratorSource, /handleFinalNoToolAssistantTurn\(\{/);
});
