import test from "node:test";
import assert from "node:assert/strict";
import fsSync from "node:fs";
import path from "node:path";
import ts from "typescript";

const workspaceRoot = process.cwd();
const phaseSource = fsSync.readFileSync(
  path.join(workspaceRoot, "src/lib/orchestrator/loop/toolCallExecutionPhase.ts"),
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

function loadExecutionPhaseWithStubbedDependencies() {
  const transpiled = ts.transpileModule(phaseSource, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
    fileName: "toolCallExecutionPhase.ts",
  }).outputText;
  const module = { exports: {} };
  const dependencyStub = new Proxy({}, {
    get: (_target, property) => property === "__esModule" ? true : () => undefined,
  });
  const factory = new Function("exports", "module", "require", transpiled);
  factory(module.exports, module, () => dependencyStub);
  return module.exports;
}

test("tool call execution phase owns the tool handoff and execution ordering", () => {
  assert.match(phaseSource, /export async function executeToolCallPhase/);
  assert.match(phaseSource, /resetConsecutiveNoToolRuntimeState\(/);
  assert.match(phaseSource, /resetPlanRecoveryPromptRuntimeState\(/);
  assert.match(phaseSource, /resetTransientRecoveryPromptRuntimeState\(/);
  assert.match(phaseSource, /markUnityMcpToolCallsDetected\(/);
  assert.match(phaseSource, /logAgentEvent\("tool_calls_detected"/);
  assert.match(phaseSource, /input\.emitTaskOrchestratorPhase\("EXECUTE_STEP"/);
  assert.match(phaseSource, /buildAssistantHistoryMessage\([\s\S]*?\{ tool_calls: toolCallsForMsg \}/);
  assert.match(phaseSource, /partitionToolCallsForExecution\(\{[\s\S]*?executeToolExecutionRound\(\{/);
});

test("provider tool ids are replaced with iteration-scoped runtime ids before history and execution", () => {
  const { assignRuntimeToolCallIds } = loadExecutionPhaseWithStubbedDependencies();
  const firstIteration = assignRuntimeToolCallIds([
    { id: "native_call_1", name: "read_file", arguments: "{}" },
    { id: "native_call_1", name: "grep_search", arguments: "{}" },
  ], "turn-a-run-source-1");
  const nextIteration = assignRuntimeToolCallIds([
    { id: "native_call_1", name: "replace_in_file", arguments: "{}" },
  ], "turn-a-run-source-2");
  const recoveredRun = assignRuntimeToolCallIds([
    { id: "native_call_1", name: "read_file", arguments: "{}" },
  ], "turn-a-run-recovery-1");

  assert.deepEqual(firstIteration.map((call) => call.id), [
    "turn-a-run-source-1-tool-1",
    "turn-a-run-source-1-tool-2",
  ]);
  assert.deepEqual(nextIteration.map((call) => call.id), ["turn-a-run-source-2-tool-1"]);
  assert.deepEqual(recoveredRun.map((call) => call.id), ["turn-a-run-recovery-1-tool-1"]);
  assert.equal(
    new Set([...firstIteration, ...nextIteration, ...recoveredRun].map((call) => call.id)).size,
    4,
  );

  const assignmentIndex = phaseSource.indexOf("assignRuntimeToolCallIds(", phaseSource.indexOf("export async function executeToolCallPhase"));
  const historyIndex = phaseSource.indexOf("buildAssistantHistoryMessage(", assignmentIndex);
  const executionIndex = phaseSource.indexOf("partitionToolCallsForExecution({", assignmentIndex);
  assert.ok(assignmentIndex >= 0 && assignmentIndex < historyIndex);
  assert.ok(assignmentIndex < executionIndex);
  assert.match(phaseSource, /\| "iterationTurnId"/);
});

test("tool call execution phase owns post-processing runtime state updates", () => {
  assert.match(phaseSource, /handleToolResultPostProcessing\(\{/);
  assert.match(phaseSource, /applyRecentSuccessfulProjectWriteRuntimeState\(/);
  assert.match(phaseSource, /applyRecoveringFromEmptyAssistantReplyRuntimeState\(/);
  assert.match(phaseSource, /applyUnityMcpToolResultState\(/);
  assert.match(phaseSource, /applyToolResultPlanRuntimeState\(/);
  assert.doesNotMatch(phaseSource, /applyApprovedPlanToolResultRecoveryState\(/);
  assert.match(phaseSource, /unityMcpFallbackPrompt: toolResultPostProcessing\.unityMcpFallbackPrompt/);
  assert.match(phaseSource, /isUnapprovedPlanReadOnlyBatch:\s*toolResultPostProcessing\.isUnapprovedPlanReadOnlyBatch/);
});

test("tool call execution phase preserves callback-owned state through the phase fold", () => {
  assert.match(
    phaseSource,
    /const markExecuteOperationEvidenceAndSync[\s\S]*?evidenceRuntimeState = markExecuteOperationEvidenceRuntimeState/,
  );
  assert.match(
    phaseSource,
    /const clearExecuteRecoveryAndSync[\s\S]*?executeRecoveryState = input\.clearExecuteRecovery\([\s\S]*?return executeRecoveryState/,
  );
  assert.doesNotMatch(phaseSource, /clearCrossIterationReadTrackingForTarget/);
  assert.match(
    phaseSource,
    /markExecuteOperationEvidence: markExecuteOperationEvidenceAndSync/,
  );
  assert.match(
    phaseSource,
    /transitionExecuteRecoveryRuntimeState\([\s\S]*?recoveryTransition\.transition === "validation_to_normal"[\s\S]*?clearExecuteRecoveryAndSync\(/,
  );
  assert.match(phaseSource, /sourceObservationKey: freshReadResult\?\.readFileObservation\?\.key/);
  assert.match(phaseSource, /validationToolName: validationResult\?\.name/);
  assert.match(phaseSource, /readFileObservation\?\.source[\s\S]*?source !== "stub"/);
  assert.doesNotMatch(phaseSource, /clearExecuteRecovery: clearExecuteRecoveryAndSync/);
  assert.match(phaseSource, /executeRecoveryState,[\s\S]*?loopGuardRuntimeState,/);
});

test("approved Plan scope recovery keeps one semantic fingerprint across policy-deferred tool changes", () => {
  assert.match(
    phaseSource,
    /executeRecoveryState\.reason === "approved_plan_scope_blocked"[\s\S]*?executeRecoveryState\.protocolNoProgressFingerprint[\s\S]*?semanticNoProgressFingerprint/,
  );
  assert.match(
    phaseSource,
    /registerExecuteRecoveryProtocolNoProgress\(\s*executeRecoveryState,\s*semanticNoProgressFingerprint/,
  );
});

test("approved Plan recovery advances the runtime contract after task evidence closes", () => {
  assert.match(
    phaseSource,
    /resolveApprovedPlanRecoveryReconciliation\(\{[\s\S]*?tasks:\s*input\.callbacks\.getPlanTasks\(\),[\s\S]*?evidenceLedger:\s*input\.callbacks\.getPlanExecutionEvidenceLedger\(\)/,
  );
  assert.match(
    phaseSource,
    /approved_plan_recovery_rebased_before_partition/,
  );
  assert.match(
    phaseSource,
    /createExecuteRecoveryRuntimeState\(\{[\s\S]*?forcedState:\s*reconciliation\.next/,
  );
  assert.match(phaseSource, /approved_plan_recovery_obligation_advanced/);
});

test("unchanged PTY observations consume semantic progress while new output changes the fingerprint", () => {
  assert.match(
    phaseSource,
    /pty:\$\{observation\.status\}[\s\S]*?generation:\$\{observation\.foregroundGeneration[\s\S]*?sequence:\$\{observation\.outputSequence/,
  );
  assert.match(
    phaseSource,
    /recoveryIterationBudgetNeutral[\s\S]*?buildRecoveryProtocolNoProgressFingerprint\([\s\S]*?registerExecuteRecoveryProtocolNoProgress\(/,
  );
  assert.doesNotMatch(phaseSource, /if \(!ptyWaitOnly\)/);
});

test("partial abort reconciles observed tool results before returning and closes protocol calls", () => {
  const postProcessIndex = phaseSource.indexOf("handleToolResultPostProcessing({");
  const abortedReturnIndex = phaseSource.indexOf('status: "aborted"', postProcessIndex);

  assert.notEqual(postProcessIndex, -1);
  assert.notEqual(abortedReturnIndex, -1);
  assert.ok(postProcessIndex < abortedReturnIndex);
  assert.match(phaseSource, /const wasAborted = toolExecutionRound\.status === "aborted"/);
  assert.match(phaseSource, /if \(wasAborted\) \{[\s\S]*?appendToolResultsToHistory\(\{/);
  assert.match(phaseSource, /observedToolCallIds/);
  assert.match(phaseSource, /TOOL_CALL_ABORTED/);
  assert.match(phaseSource, /lifecycleState: "blocked"/);
  assert.match(phaseSource, /internalFeedback: true/);
});

test("tool iteration phase delegates to the tool call execution phase", () => {
  assert.match(toolIterationPhaseSource, /executeToolCallPhase\(input\)/);
  assert.match(orchestratorSource, /handleToolIterationPhase\(\{/);
  assert.doesNotMatch(orchestratorSource, /executeToolCallPhase\(\{/);
  assert.doesNotMatch(orchestratorSource, /partitionToolCallsForExecution\(/);
  assert.doesNotMatch(orchestratorSource, /executeToolExecutionRound\(/);
  assert.doesNotMatch(orchestratorSource, /handleToolResultPostProcessing\(/);
  assert.doesNotMatch(orchestratorSource, /tool_calls_detected/);
});
