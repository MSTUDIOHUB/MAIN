import test from "node:test";
import assert from "node:assert/strict";
import fsSync from "node:fs";
import path from "node:path";

const workspaceRoot = process.cwd();

const phaseSource = fsSync.readFileSync(
  path.join(workspaceRoot, "src/lib/orchestrator/loop/toolIterationPhase.ts"),
  "utf8",
);
const orchestratorSource = fsSync.readFileSync(
  path.join(workspaceRoot, "src/lib/orchestrator/loop/AgentOrchestrator.ts"),
  "utf8",
);
const assistantCompletionSource = fsSync.readFileSync(
  path.join(workspaceRoot, "src/lib/orchestrator/loop/assistantCompletionPhase.ts"),
  "utf8",
);
const runtimeOrchestratorSource = fsSync.readFileSync(
  path.join(workspaceRoot, "src/lib/orchestrator.ts"),
  "utf8",
);
const orchestratorTypesSource = fsSync.readFileSync(
  path.join(workspaceRoot, "src/lib/orchestrator/types.ts"),
  "utf8",
);

test("tool iteration phase owns the execution-to-recovery handoff", () => {
  const executeIndex = phaseSource.indexOf("executeToolCallPhase(input)");
  const recoveryIndex = phaseSource.indexOf("handleToolResultRecoveryPhase({");

  assert.notEqual(executeIndex, -1);
  assert.notEqual(recoveryIndex, -1);
  assert.ok(executeIndex < recoveryIndex);
  assert.match(phaseSource, /results: toolCallPhase\.allResults/);
  assert.match(phaseSource, /toolArgsByCallId: toolCallPhase\.toolArgsByCallId/);
  assert.match(phaseSource, /toolFailureSignatures: toolCallPhase\.toolFailureSignatures/);
  assert.match(phaseSource, /hasPlanDecisionOutput: toolCallPhase\.hasPlanDecisionOutput/);
  assert.match(phaseSource, /unityMcpFallbackPrompt: toolCallPhase\.unityMcpFallbackPrompt/);
  assert.match(phaseSource, /isUnapprovedPlanReadOnlyBatch:\s*toolCallPhase\.isUnapprovedPlanReadOnlyBatch/);
  assert.match(phaseSource, /executeRecoveryState: toolCallPhase\.executeRecoveryState/);
  assert.match(phaseSource, /loopGuardRuntimeState: toolCallPhase\.loopGuardRuntimeState/);
});

test("tool iteration phase returns one folded runtime-state result to the orchestrator", () => {
  assert.match(phaseSource, /status: "aborted" \| "stopped" \| "continue" \| "completed" \| "plan_completed" \| "goal_completed"/);
  assert.match(phaseSource, /noToolRuntimeState: toolCallPhase\.noToolRuntimeState/);
  assert.match(phaseSource, /planRuntimeState: toolResultRecoveryPhase\.planRuntimeState/);
  assert.match(phaseSource, /loopGuardRuntimeState: toolResultRecoveryPhase\.loopGuardRuntimeState/);
  assert.match(phaseSource, /executeRecoveryState: toolResultRecoveryPhase\.executeRecoveryState/);
  assert.match(phaseSource, /recoveryPromptState: toolResultRecoveryPhase\.recoveryPromptState/);
});

test("semantic collaboration uses runtime-owned task registration and join outcomes", () => {
  assert.match(orchestratorTypesSource, /subagentSpawnOutcome\?: SpawnSubagentResult/);
  assert.match(runtimeOrchestratorSource, /subagentSpawnOutcome = result/);
  assert.match(runtimeOrchestratorSource, /await options\.onSubagentSpawnCreated\?\.\(result\)/);
  assert.match(runtimeOrchestratorSource, /\{ subagentSpawnOutcome \}/);
  assert.match(phaseSource, /const runtimeOutcome = result\.subagentSpawnOutcome/);
  assert.match(phaseSource, /runtimeOutcome\.subagentId !== null/);
  assert.match(phaseSource, /extractCollaborationTaskJoinOutcomes/);
  assert.match(
    phaseSource,
    /input\.onCollaborationTaskOutcomes\?\.\(collaborationTaskOutcomes\)/,
  );
  assert.match(orchestratorSource, /agent\.semantic_collaboration_task_spawned/);
  assert.match(orchestratorSource, /agent\.semantic_collaboration_evidence_consumed/);
  assert.match(orchestratorSource, /emitCollaborationTaskOutcomes/);
  assert.match(orchestratorSource, /consumedScopeKeys:\s*outcomes/);
  assert.match(orchestratorSource, /\.filter\(\(outcome\) => outcome\.evidenceAdopted\)/);
  assert.match(orchestratorSource, /semantic_collaboration_joined_without_evidence/);
  assert.match(
    orchestratorSource,
    /assessPlanEvidenceReadiness\(\{[\s\S]*joinedEvidenceReadiness\.status === "ready_for_plan"[\s\S]*setPlanRuntimePhase\(\s*"needs_evidence"/,
  );
  assert.match(
    assistantCompletionSource,
    /joinResult\.adoptedEvidenceCount === 0[\s\S]*input\.setPlanRuntimePhase\("needs_evidence"/,
  );
  assert.ok(
    runtimeOrchestratorSource.indexOf("await options.onSubagentSpawnCreated?.(result)") <
      runtimeOrchestratorSource.indexOf("return JSON.stringify(result)"),
  );
  assert.doesNotMatch(
    phaseSource,
    /input\.onSubagentSpawnCreated\?\.\(outcome\)/,
  );
  assert.ok(
    phaseSource.indexOf("const runtimeOutcome = result.subagentSpawnOutcome") <
      phaseSource.indexOf("JSON.parse(String(result.content || \"\"))"),
  );
});

test("agent orchestrator delegates tool execution and result recovery to one iteration phase", () => {
  assert.match(orchestratorSource, /handleToolIterationPhase\(\{/);
  assert.match(orchestratorSource, /toolIterationPhase\.status === "aborted"/);
  assert.match(orchestratorSource, /toolIterationPhase\.status === "goal_completed"/);
  assert.match(orchestratorSource, /toolIterationPhase\.status === "stopped"/);
  assert.match(orchestratorSource, /toolIterationPhase\.status === "continue"/);
  assert.doesNotMatch(orchestratorSource, /executeToolCallPhase\(\{/);
  assert.doesNotMatch(orchestratorSource, /handleToolResultRecoveryPhase\(\{/);
  assert.doesNotMatch(orchestratorSource, /const allResults =/);
  assert.doesNotMatch(orchestratorSource, /const toolArgsByCallId =/);
  assert.doesNotMatch(orchestratorSource, /const toolFailureSignatures =/);
});
