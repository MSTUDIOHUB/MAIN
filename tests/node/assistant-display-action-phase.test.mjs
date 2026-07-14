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

test("assistant display action phase owns display action and no-tool ordering", () => {
  const phaseSource = sourceFor("src/lib/orchestrator/loop/assistantDisplayActionPhase.ts");

  assert.match(phaseSource, /export function handleAssistantDisplayActionPhase/);

  const displayDecision = indexOfRequired(phaseSource, /resolveAssistantTurnDisplayDecision\(\{/);
  const actionRouting = indexOfRequired(phaseSource, /resolveAssistantActionRouting\(\{/);
  const noToolRecovery = indexOfRequired(phaseSource, /handleAssistantNoToolRecovery\(\{/);

  assert.ok(displayDecision < actionRouting);
  assert.ok(actionRouting < noToolRecovery);
});

test("assistant display action phase owns display and action telemetry", () => {
  const phaseSource = sourceFor("src/lib/orchestrator/loop/assistantDisplayActionPhase.ts");

  assert.match(phaseSource, /pseudo_tool_recovered/);
  assert.match(phaseSource, /pseudo_tool_recovery_unavailable/);
  assert.match(phaseSource, /web_research_required_tool_injected/);
  assert.match(phaseSource, /approved_plan_finite_command_injected/);
  assert.match(phaseSource, /readonly_permission_options_ignored_for_tool_call/);
  assert.match(phaseSource, /plan_reply_options_routed_to_artifact/);
  assert.match(phaseSource, /reply_options_detected/);
});

test("assistant iteration phase delegates assistant display action details to the phase module", () => {
  const orchestratorSource = sourceFor("src/lib/orchestrator/loop/AgentOrchestrator.ts");
  const iterationPhaseSource = sourceFor("src/lib/orchestrator/loop/assistantIterationPhase.ts");

  assert.match(orchestratorSource, /handleAssistantIterationPhase\(\{/);
  assert.match(iterationPhaseSource, /handleAssistantDisplayActionPhase\(\{/);
  assert.doesNotMatch(orchestratorSource, /handleAssistantDisplayActionPhase\(\{/);
  assert.doesNotMatch(orchestratorSource, /resolveAssistantTurnDisplayDecision\(\{/);
  assert.doesNotMatch(orchestratorSource, /resolveAssistantActionRouting\(\{/);
  assert.doesNotMatch(orchestratorSource, /handleAssistantNoToolRecovery\(\{/);
  assert.doesNotMatch(orchestratorSource, /pseudo_tool_recovered/);
  assert.doesNotMatch(orchestratorSource, /web_research_required_tool_injected/);
});
