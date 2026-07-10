import test from "node:test";
import assert from "node:assert/strict";
import fsSync from "node:fs";
import path from "node:path";

const workspaceRoot = process.cwd();

const stateSource = fsSync.readFileSync(
  path.join(workspaceRoot, "src/lib/orchestrator/loop/loopMutableState.ts"),
  "utf8",
);
const orchestratorSource = fsSync.readFileSync(
  path.join(workspaceRoot, "src/lib/orchestrator/loop/AgentOrchestrator.ts"),
  "utf8",
);

test("loop mutable state owns per-loop runtime state initialization", () => {
  assert.match(stateSource, /export interface AgentLoopMutableState/);
  assert.match(stateSource, /export function createAgentLoopMutableState/);
  assert.match(stateSource, /iteration: 0/);
  assert.match(stateSource, /createAgentLoopGuardRuntimeState\(\)/);
  assert.match(stateSource, /createAgentLoopNoToolRuntimeState\(\)/);
  assert.match(stateSource, /createAgentLoopStreamRuntimeState\(\)/);
  assert.match(stateSource, /createAgentLoopRecoveryPromptRuntimeState\(\)/);
  assert.match(stateSource, /createPlanLoopRuntimeState\(\{/);
  assert.match(stateSource, /createAgentLoopEvidenceRuntimeState\(\)/);
  assert.match(stateSource, /createApprovedPlanRecoveryRuntimeState\(\)/);
  assert.match(stateSource, /createExecuteRecoveryRuntimeState\(\{/);
  assert.match(stateSource, /createAgentLoopToolExecutionRuntimeState\(/);
  assert.match(stateSource, /unityMcpRuntimeState: input\.unityMcpRuntimeState/);
});

test("loop mutable state owns common phase result folds", () => {
  assert.match(stateSource, /markExecuteOperationEvidenceRuntimeState\(/);
  assert.match(stateSource, /markChatFinalSynthesisPromptUsed\(/);
  assert.match(stateSource, /applyIterationStreamPreparationMutableState/);
  assert.match(stateSource, /state\.streamRuntimeState = result\.streamRuntimeState/);
  assert.match(stateSource, /state\.executeRecoveryState = result\.executeRecoveryState/);
  assert.match(stateSource, /applyAssistantIterationMutableState/);
  assert.match(stateSource, /state\.approvedPlanRecoveryState = result\.approvedPlanRecoveryState/);
  assert.match(stateSource, /state\.unityMcpRuntimeState = result\.unityMcpRuntimeState/);
  assert.match(stateSource, /applyToolIterationMutableState/);
  assert.match(stateSource, /state\.loopGuardRuntimeState = result\.loopGuardRuntimeState/);
});

test("agent orchestrator delegates mutable runtime state creation and folds", () => {
  assert.match(orchestratorSource, /createAgentLoopMutableState\(\{/);
  assert.match(orchestratorSource, /applyIterationStreamPreparationMutableState\(/);
  assert.match(orchestratorSource, /applyAssistantIterationMutableState\(/);
  assert.match(orchestratorSource, /applyToolIterationMutableState\(/);
  assert.match(orchestratorSource, /markExecuteOperationEvidenceMutableState\(loopState\)/);
  assert.match(orchestratorSource, /markChatFinalSynthesisPromptUsedMutableState\(loopState\)/);
  assert.doesNotMatch(orchestratorSource, /createAgentLoopGuardRuntimeState\(\)/);
  assert.doesNotMatch(orchestratorSource, /createAgentLoopStreamRuntimeState\(\)/);
  assert.doesNotMatch(orchestratorSource, /markExecuteOperationEvidenceRuntimeState\(/);
  assert.doesNotMatch(orchestratorSource, /markChatFinalSynthesisPromptUsed\(streamRuntimeState\)/);
});
