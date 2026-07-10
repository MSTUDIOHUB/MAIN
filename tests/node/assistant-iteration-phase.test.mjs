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

test("assistant iteration phase owns post-stream assistant phase ordering", () => {
  const phaseSource = sourceFor("src/lib/orchestrator/loop/assistantIterationPhase.ts");

  assert.match(phaseSource, /export async function handleAssistantIterationPhase/);

  const streamPostProcessing = indexOfRequired(phaseSource, /handleAssistantStreamPostProcessingPhase\(\{/);
  const displayAction = indexOfRequired(phaseSource, /handleAssistantDisplayActionPhase\(\{/);
  const unityNoTool = indexOfRequired(phaseSource, /handleUnityMcpNoToolRecovery\(\{/);
  const output = indexOfRequired(phaseSource, /handleAssistantOutputPhase\(\{/);
  const completion = indexOfRequired(phaseSource, /handleAssistantCompletionPhase\(\{/);

  assert.ok(streamPostProcessing < displayAction);
  assert.ok(displayAction < unityNoTool);
  assert.ok(unityNoTool < output);
  assert.ok(output < completion);
});

test("assistant iteration phase returns only tool execution handoff fields", () => {
  const phaseSource = sourceFor("src/lib/orchestrator/loop/assistantIterationPhase.ts");

  assert.match(phaseSource, /effectiveToolCalls: ToolCallToExecute\[\]/);
  assert.match(phaseSource, /historyAssistantText: string/);
  assert.match(phaseSource, /providerReasoningForHistory: ProviderReasoningForHistory/);
  assert.match(phaseSource, /finalReplyOptionCount: number/);
  assert.match(phaseSource, /hasStructuredProposal: boolean/);
});

test("agent loop delegates assistant subphases to assistant iteration phase", () => {
  const orchestratorSource = sourceFor("src/lib/orchestrator/loop/AgentOrchestrator.ts");

  assert.match(orchestratorSource, /handleAssistantIterationPhase\(\{/);
  assert.doesNotMatch(orchestratorSource, /handleAssistantStreamPostProcessingPhase\(\{/);
  assert.doesNotMatch(orchestratorSource, /handleAssistantDisplayActionPhase\(\{/);
  assert.doesNotMatch(orchestratorSource, /handleUnityMcpNoToolRecovery\(\{/);
  assert.doesNotMatch(orchestratorSource, /handleAssistantOutputPhase\(\{/);
  assert.doesNotMatch(orchestratorSource, /handleAssistantCompletionPhase\(\{/);
});
