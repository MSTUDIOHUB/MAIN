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

test("assistant output phase owns recovery progress and presentation ordering", () => {
  const phaseSource = sourceFor("src/lib/orchestrator/loop/assistantOutputPhase.ts");

  assert.match(phaseSource, /export function handleAssistantOutputPhase/);

  const approvedPlanRoute = indexOfRequired(phaseSource, /resolveApprovedPlanNoToolRoute\(\{/);
  const languageRecovery = indexOfRequired(phaseSource, /handleAssistantLanguageRecovery\(\{/);
  const toolProgress = indexOfRequired(phaseSource, /resolveToolProgressRouting\(\{/);
  const protocolClear = indexOfRequired(phaseSource, /resolveToolProtocolStreamClearDecision\(\{/);
  const replyOptions = indexOfRequired(phaseSource, /resolveAssistantReplyOptionRouting\(\{/);
  const finalText = indexOfRequired(phaseSource, /onAssistantFinalText\(visibleAssistantText/);
  const postConvergence = indexOfRequired(phaseSource, /handlePlanPostConvergenceToolRedirect\(\{/);

  assert.ok(approvedPlanRoute < languageRecovery);
  assert.ok(languageRecovery < toolProgress);
  assert.ok(toolProgress < protocolClear);
  assert.ok(protocolClear < replyOptions);
  assert.ok(replyOptions < finalText);
  assert.ok(finalText < postConvergence);
});

test("assistant output phase owns progress and no-tool presentation telemetry", () => {
  const phaseSource = sourceFor("src/lib/orchestrator/loop/assistantOutputPhase.ts");

  assert.match(phaseSource, /plan_completion_claim_rejected/);
  assert.match(phaseSource, /plan_no_tool_text_suppressed/);
  assert.match(phaseSource, /tool_action_narration_injected/);
  assert.match(phaseSource, /tool_protocol_stream_cleared/);
  assert.match(phaseSource, /readonly_permission_auto_continue_limit/);
  assert.match(phaseSource, /plan_non_blocking_choice_auto_continue_limit/);
  assert.match(phaseSource, /force_plan_finalization/);
  assert.match(phaseSource, /MAIN runtime owns the plan artifact/);
  assert.doesNotMatch(phaseSource, /This turn paused because the model repeatedly emitted planning options/);
  assert.match(phaseSource, /normalized_turn/);
  assert.match(phaseSource, /reply_options_rejected/);
});

test("assistant iteration phase delegates assistant output details to the phase module", () => {
  const orchestratorSource = sourceFor("src/lib/orchestrator/loop/AgentOrchestrator.ts");
  const iterationPhaseSource = sourceFor("src/lib/orchestrator/loop/assistantIterationPhase.ts");

  assert.match(orchestratorSource, /handleAssistantIterationPhase\(\{/);
  assert.match(iterationPhaseSource, /handleAssistantOutputPhase\(\{/);
  assert.doesNotMatch(orchestratorSource, /handleAssistantOutputPhase\(\{/);
  assert.doesNotMatch(orchestratorSource, /resolveApprovedPlanNoToolRoute\(\{/);
  assert.doesNotMatch(orchestratorSource, /handleAssistantLanguageRecovery\(\{/);
  assert.doesNotMatch(orchestratorSource, /resolveToolProgressRouting\(\{/);
  assert.doesNotMatch(orchestratorSource, /resolveAssistantReplyOptionRouting\(\{/);
  assert.doesNotMatch(orchestratorSource, /handlePlanPostConvergenceToolRedirect\(\{/);
  assert.doesNotMatch(orchestratorSource, /readonly_permission_auto_continue_limit/);
  assert.doesNotMatch(orchestratorSource, /tool_action_narration_injected/);
});
