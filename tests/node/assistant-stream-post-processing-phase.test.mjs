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

test("assistant stream post-processing phase owns recovery and normalization ordering", () => {
  const phaseSource = sourceFor("src/lib/orchestrator/loop/assistantStreamPostProcessingPhase.ts");

  assert.match(phaseSource, /export async function handleAssistantStreamPostProcessingPhase/);

  const consumePlanSubmission = indexOfRequired(
    phaseSource,
    /consumeNativePlanCandidateSubmission\(\{/,
  );
  const processResponse = indexOfRequired(phaseSource, /processAssistantStreamResponse\(\{/);
  const reasoningRecovery = indexOfRequired(phaseSource, /handleReasoningDominatedNoToolRecovery\(\{/);
  const emptyRecovery = indexOfRequired(phaseSource, /handleEmptyResponseRecovery\(\{/);
  const normalizeToolCall = indexOfRequired(phaseSource, /normalizeToolCallToExecute\(\{/);
  const finalTextOnly = indexOfRequired(phaseSource, /handleFinalTextOnlyToolCalls\(\{/);

  assert.ok(consumePlanSubmission < processResponse);
  assert.ok(processResponse < reasoningRecovery);
  assert.ok(reasoningRecovery < emptyRecovery);
  assert.ok(emptyRecovery < normalizeToolCall);
  assert.ok(normalizeToolCall < finalTextOnly);
});

test("assistant stream post-processing phase owns runtime state folds", () => {
  const phaseSource = sourceFor("src/lib/orchestrator/loop/assistantStreamPostProcessingPhase.ts");

  assert.match(phaseSource, /applyReasoningDominatedNoToolRuntimeState\(/);
  assert.match(phaseSource, /applyReasoningNoToolPlanRuntimeState\(/);
  assert.doesNotMatch(phaseSource, /applyApprovedPlanActionOnlyRecoveryState\(/);
  assert.match(phaseSource, /applyEmptyResponseNoToolRuntimeState\(/);
  assert.match(phaseSource, /applyMalformedToolUseRecoveryPromptState\(/);
  assert.match(phaseSource, /resetEmptyAndReasoningNoToolRuntimeState\(/);
});

test("assistant iteration phase delegates stream post-processing details to the phase module", () => {
  const orchestratorSource = sourceFor("src/lib/orchestrator/loop/AgentOrchestrator.ts");
  const iterationPhaseSource = sourceFor("src/lib/orchestrator/loop/assistantIterationPhase.ts");

  assert.match(orchestratorSource, /handleAssistantIterationPhase\(\{/);
  assert.match(iterationPhaseSource, /handleAssistantStreamPostProcessingPhase\(\{/);
  assert.doesNotMatch(orchestratorSource, /handleAssistantStreamPostProcessingPhase\(\{/);
  assert.doesNotMatch(orchestratorSource, /processAssistantStreamResponse\(\{/);
  assert.doesNotMatch(orchestratorSource, /handleReasoningDominatedNoToolRecovery\(\{/);
  assert.doesNotMatch(orchestratorSource, /handleEmptyResponseRecovery\(\{/);
  assert.doesNotMatch(orchestratorSource, /normalizeToolCallToExecute\(\{/);
  assert.doesNotMatch(orchestratorSource, /handleFinalTextOnlyToolCalls\(\{/);
});
