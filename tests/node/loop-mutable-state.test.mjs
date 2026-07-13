import test from "node:test";
import assert from "node:assert/strict";
import fsSync from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";

const workspaceRoot = process.cwd();

const stateSource = fsSync.readFileSync(
  path.join(workspaceRoot, "src/lib/orchestrator/loop/loopMutableState.ts"),
  "utf8",
);
const orchestratorSource = fsSync.readFileSync(
  path.join(workspaceRoot, "src/lib/orchestrator/loop/AgentOrchestrator.ts"),
  "utf8",
);

const moduleCache = new Map();
function loadTranspiledModuleSync(sourcePath) {
  const normalizedPath = path.resolve(sourcePath);
  if (moduleCache.has(normalizedPath)) return moduleCache.get(normalizedPath);
  const source = fsSync.readFileSync(normalizedPath, "utf8");
  const transpiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    fileName: normalizedPath,
  }).outputText;
  const module = { exports: {} };
  moduleCache.set(normalizedPath, module.exports);
  const localRequire = createRequire(normalizedPath);
  const runtimeRequire = (specifier) => {
    if (specifier.startsWith(".")) {
      const basePath = path.resolve(path.dirname(normalizedPath), specifier);
      for (const candidate of [basePath, `${basePath}.ts`, `${basePath}.tsx`, path.join(basePath, "index.ts")]) {
        if (!fsSync.existsSync(candidate)) continue;
        if (candidate.endsWith(".ts") || candidate.endsWith(".tsx")) {
          return loadTranspiledModuleSync(candidate);
        }
      }
    }
    return localRequire(specifier);
  };
  new Function("exports", "module", "require", transpiled)(module.exports, module, runtimeRequire);
  moduleCache.set(normalizedPath, module.exports);
  return module.exports;
}

const {
  createAgentLoopMutableState,
  resetAgentLoopMutableStateForApprovedPlanExecution,
} = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/lib/orchestrator/loop/loopMutableState.ts"),
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

test("approved Plan phase reset removes planning counters while preserving the turn iteration and tool cache", () => {
  const unityMcpRuntimeState = { firstPhaseActive: false };
  const state = createAgentLoopMutableState({
    callbacks: {
      getIsPlanApproved: () => false,
      getForcedExecuteRecoveryMode: () => null,
      getSessionKey: () => "session-1",
    },
    workflowMode: "plan",
    unityMcpRuntimeState,
  });
  const toolExecutionRuntimeState = state.toolExecutionRuntimeState;
  state.iteration = 19;
  state.recentPlanToolActivity.push({ name: "write_file", status: "succeeded", target: ".MAIN/plans/plan.md" });
  state.recentToolActivity.push({ name: "read_file", status: "succeeded", target: "src/main.rs" });
  state.attemptedPlanWriteTargets.push(".MAIN/plans/plan.md");
  state.noToolRuntimeState.consecutiveNoToolCount = 4;
  state.loopGuardRuntimeState.crossIterationFileReads.set("src/main.rs", 3);
  state.loopGuardRuntimeState.failedToolCallCounts.set("replace:src/main.rs", 2);
  state.approvedPlanRecoveryState.approvedPlanActionOnlyRecoveryActive = true;
  state.executeRecoveryState.mode = "mutation_first";

  resetAgentLoopMutableStateForApprovedPlanExecution(state);

  assert.equal(state.iteration, 19);
  assert.equal(state.toolExecutionRuntimeState, toolExecutionRuntimeState);
  assert.equal(state.unityMcpRuntimeState, unityMcpRuntimeState);
  assert.equal(state.recentPlanToolActivity.length, 0);
  assert.equal(state.recentToolActivity.length, 0);
  assert.equal(state.attemptedPlanWriteTargets.length, 0);
  assert.equal(state.noToolRuntimeState.consecutiveNoToolCount, 0);
  assert.equal(state.loopGuardRuntimeState.crossIterationFileReads.size, 0);
  assert.equal(state.loopGuardRuntimeState.failedToolCallCounts.size, 0);
  assert.equal(state.approvedPlanRecoveryState.approvedPlanActionOnlyRecoveryActive, false);
  assert.equal(state.executeRecoveryState.mode, "normal");
  assert.equal(state.planRuntimeState.planRuntimePhase, "grounding");
  assert.equal(state.evidenceRuntimeState.sawExecuteOperationEvidence, false);
});

test("loop mutable state restores a target-scoped forced recovery transaction", () => {
  const state = createAgentLoopMutableState({
    callbacks: {
      getIsPlanApproved: () => false,
      getForcedExecuteRecoveryMode: () => "mutation_first",
      getForcedExecuteRecoveryState: () => ({
        mode: "validation_only",
        reason: "goal_continuation_mutation_observed",
        expectedTarget: "src/App.tsx",
      }),
      getSessionKey: () => "session-1",
    },
    workflowMode: "edit",
    unityMcpRuntimeState: { firstPhaseActive: false },
  });

  assert.equal(state.executeRecoveryState.mode, "validation_only");
  assert.equal(state.executeRecoveryState.reason, "goal_continuation_mutation_observed");
  assert.equal(state.executeRecoveryState.expectedTarget, "src/App.tsx");
});

test("agent orchestrator delegates mutable runtime state creation and folds", () => {
  assert.match(orchestratorSource, /createAgentLoopMutableState\(\{/);
  assert.match(orchestratorSource, /applyIterationStreamPreparationMutableState\(/);
  assert.match(orchestratorSource, /applyAssistantIterationMutableState\(/);
  assert.match(orchestratorSource, /applyToolIterationMutableState\(/);
  assert.match(orchestratorSource, /markExecuteOperationEvidenceMutableState\(loopState\)/);
  assert.match(orchestratorSource, /markChatFinalSynthesisPromptUsedMutableState\(loopState\)/);
  assert.match(orchestratorSource, /resetAgentLoopMutableStateForApprovedPlanExecution\(loopState\)/);
  assert.match(orchestratorSource, /publishExecuteRecoveryState/);
  assert.match(orchestratorSource, /onExecuteRecoveryStateChange/);
  assert.doesNotMatch(orchestratorSource, /createAgentLoopGuardRuntimeState\(\)/);
  assert.doesNotMatch(orchestratorSource, /createAgentLoopStreamRuntimeState\(\)/);
  assert.doesNotMatch(orchestratorSource, /markExecuteOperationEvidenceRuntimeState\(/);
  assert.doesNotMatch(orchestratorSource, /markChatFinalSynthesisPromptUsed\(streamRuntimeState\)/);
});
