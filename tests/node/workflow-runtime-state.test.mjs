import test from "node:test";
import assert from "node:assert/strict";
import fsSync from "node:fs";
import path from "node:path";

const workspaceRoot = process.cwd();

function collectFilesRecursively(root) {
  return fsSync.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const absolutePath = path.join(root, entry.name);
    return entry.isDirectory() ? collectFilesRecursively(absolutePath) : [absolutePath];
  });
}

test("retired model policies and validator modules have no runtime consumers", () => {
  const retiredPaths = [
    "src/lib/orchestrator/policies/CloudModelPolicy.ts",
    "src/lib/orchestrator/policies/ExecutionPolicy.ts",
    "src/lib/orchestrator/policies/LocalModelPolicy.ts",
    "src/lib/orchestrator/policies/PolicyFactory.ts",
    "src/lib/orchestrator/prompts/validationPrompts.ts",
    "src/lib/orchestrator/tools/shellValidators.ts",
    "src/lib/orchestrator/tools/toolValidators.ts",
  ];
  for (const retiredPath of retiredPaths) {
    assert.equal(fsSync.existsSync(path.join(workspaceRoot, retiredPath)), false, retiredPath);
  }

  const runtimeSource = collectFilesRecursively(path.join(workspaceRoot, "src"))
    .filter((file) => /\.(?:ts|tsx)$/.test(file))
    .map((file) => fsSync.readFileSync(file, "utf8"))
    .join("\n");
  assert.doesNotMatch(
    runtimeSource,
    /CloudModelPolicy|ExecutionPolicy|LocalModelPolicy|PolicyFactory|validationPrompts|shellValidators|toolValidators/,
  );
});

test("assistant progress before tool calls keeps the run active", () => {
  const source = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/workflowEngine.ts"), "utf8");

  assert.match(source, /const hasToolCalls = meta\?\.hasToolCalls === true;/);
  assert.match(
    source,
    /if \(hasToolCalls\) \{\s*return \{\s*taskFlow,\s*conversationTurns,\s*agentStatus: s\.agentStatus === "pending_review" \? "pending_review" : "running",\s*isGenerating: true,\s*\};\s*\}/s,
  );
  assert.doesNotMatch(
    source,
    /if \(hasToolCalls\)[\s\S]{0,240}abortController: null/,
    "tool-call progress must not clear the abort controller",
  );
  assert.match(
    source,
    /if \(hasToolCalls\) \{\s*nextStreamingBlockId = null;\s*\}/,
    "tool-call progress should close the current assistant block so the final answer starts cleanly",
  );
});

test("preapproval Plan quality candidates stay non-terminal without publishing internal phase UI", () => {
  const source = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/workflowEngine.ts"), "utf8");
  const runtimeActionsSource = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/loopRuntimeActions.ts"), "utf8");
  const assistantCallback = source.slice(
    source.indexOf("onAssistantFinalText: (text"),
    source.indexOf("onToolExecuting:", source.indexOf("onAssistantFinalText: (text")),
  );

  assert.match(assistantCallback, /const provisionalPlanCandidate\s*=/);
  assert.match(assistantCallback, /provisionalPlanCandidate[\s\S]{0,240}status:\s*turn\.status === "awaiting_approval" \? turn\.status : "planning"/);
  assert.match(assistantCallback, /if \(provisionalPlanCandidate\) \{\s*return \{\s*taskFlow,\s*conversationTurns,\s*agentStatus: "running",\s*isGenerating: true/s);
  assert.doesNotMatch(source, /onTurnRuntimePhaseChanged:/);
  assert.doesNotMatch(source, /projectTurnRuntimePhase/);
  assert.doesNotMatch(source, /emitPlanRuntimeStreamHeartbeat/);
  assert.doesNotMatch(source, /plan-runtime:\$\{owner\.runId\}/);
  assert.match(runtimeActionsSource, /logAgentEvent\("plan_runtime_phase_changed"/);
});

test("tool execution reasserts running state for stop button and timer", () => {
  const source = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/workflowEngine.ts"), "utf8");

  assert.match(
    source,
    /onToolExecuting:[\s\S]*?sessionSet\(\(s: any\) => \{[\s\S]*?agentStatus: s\.agentStatus === "pending_review" \? "pending_review" : "running",\s*isGenerating: true,/,
  );
});

test("tool lifecycle keeps edit diff previews through completion", () => {
  const source = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/workflowEngine.ts"), "utf8");

  assert.match(source, /onToolExecuting: \(toolName: string, target: string, diffPreview\?: any/);
  assert.match(source, /supportsToolDiffPreview\(toolName\)/);
  assert.match(source, /isEphemeralPlanArtifactPath\(diffPath\)/);
  assert.match(source, /\.\.\.\(diff \? \{ diff \} : \{\}\)/);
  assert.match(source, /findToolLifecycleBlockIndex/);
  assert.match(source, /summarizeToolObservation/);
  assert.match(source, /withTurnRuntimePhaseStatus/);
});

test("pending review materializes a visible tool card for ExecutionCapsule", () => {
  const source = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/workflowEngine.ts"), "utf8");

  assert.match(source, /status: "pending_review",\s*toolStatus: "pending"/);
  assert.match(source, /taskFlow: \[\.\.\.s\.taskFlow, pendingBlock\]/);
  assert.match(source, /pendingReviewTaskId: taskId/);
});

test("chat rendering keeps substantive intermediate conclusions out of process archive", () => {
  const source = fsSync.readFileSync(path.join(workspaceRoot, "src/components/ChatArea.tsx"), "utf8");

  assert.match(source, /hasSubstantiveIntermediateAgentText/);
  assert.match(source, /shouldRetainStageSummary\(content\)/);
  assert.match(source, /!hasSubstantiveIntermediateAgentText/);
  assert.doesNotMatch(source, /if \(isTransparentToolNarrationBlock\(block\)\) return false;/);
});

test("completed useful thought summaries remain visible after streaming ends", () => {
  const source = fsSync.readFileSync(path.join(workspaceRoot, "src/components/ChatArea.tsx"), "utf8");

  assert.match(source, /latestThoughtBlock\.isStreaming \|\| shouldRetainStageSummary\(summary\)/);
  assert.match(source, /processTextsOverlap\(finalAgentSummaryText, summary\)/);
});

test("onAssistantFinalText leaves terminal status and abort cleanup to the publication gate", () => {
  const source = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/workflowEngine.ts"), "utf8");
  const finalTextStart = source.indexOf("onAssistantFinalText:");
  const toolExecutingStart = source.indexOf("onToolExecuting:", finalTextStart);
  const finalTextCallback = source.slice(finalTextStart, toolExecutingStart);

  assert.notEqual(finalTextStart, -1);
  assert.ok(toolExecutingStart > finalTextStart);
  assert.doesNotMatch(finalTextCallback, /abortController:\s*null/);
  assert.doesNotMatch(finalTextCallback, /agentStatus:\s*"idle"/);
});

test("onToolDone populates planExecutionEvidenceLedger and reconciles planTasks", () => {
  const source = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/workflowEngine.ts"), "utf8");
  const orchestratorSource = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator.ts"), "utf8");
  const onToolDoneStart = source.indexOf("onToolDone: (");
  const internalFeedbackGuard = source.indexOf("if (meta?.internalFeedback === true)", onToolDoneStart);
  const evidenceCreation = source.indexOf("createPlanExecutionEvidenceEntry", onToolDoneStart);

  assert.match(source, /createPlanExecutionEvidenceEntry/);
  assert.match(source, /appendPlanEvidenceEntry/);
  assert.match(source, /reconcilePlanTaskCompletion/);
  assert.match(source, /const unownedEntry = createPlanExecutionEvidenceEntry/);
  assert.match(source, /resolvePlanExecutionEvidenceIdentity\(\{[\s\S]*?record,[\s\S]*?preferredPlanTaskId/);
  const lifecycleMissReturn = source.indexOf("if (existingIndex < 0) return evidencePatch", evidenceCreation);
  const evidenceAppend = source.indexOf("appendPlanEvidenceEntry", evidenceCreation);
  assert.ok(evidenceAppend > evidenceCreation && evidenceAppend < lifecycleMissReturn);
  assert.ok(internalFeedbackGuard > onToolDoneStart);
  assert.ok(
    evidenceCreation > internalFeedbackGuard,
    "internal quality feedback must return before user progress/evidence is created",
  );
  assert.match(
    source.slice(internalFeedbackGuard, evidenceCreation),
    /tool_result_internal_feedback[\s\S]*taskFlow:\s*s\.taskFlow\.filter[\s\S]*return;/,
  );
  assert.match(
    orchestratorSource,
    /callbacks\.onToolDone\(tc\.name, completedTarget, finalDisplayContent,[\s\S]{0,420}tc\.name === "browser_evaluate"[\s\S]{0,100}evidenceResult: resultStr/,
    "browser evidence must cross the UI boundary as exact structured JSON",
  );
  assert.match(
    source.slice(onToolDoneStart, evidenceCreation + 500),
    /const evidenceResultText = typeof meta\?\.evidenceResult === "string"[\s\S]*?result: evidenceResultText/,
    "the evidence ledger must parse the exact payload instead of the truncated UI result",
  );
  assert.match(
    source.slice(onToolDoneStart, evidenceCreation + 1_000),
    /summarizeToolObservation\(\{[\s\S]*?result: resultText/,
    "UI narration should continue using the bounded display result",
  );
});

test("onToolError records only explicit executor failures in the evidence ledger", () => {
  const workflowSource = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/workflowEngine.ts"), "utf8");
  const orchestratorSource = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator.ts"), "utf8");
  const onToolErrorStart = workflowSource.indexOf("onToolError: (");
  const onToolErrorEnd = workflowSource.indexOf("requestReview:", onToolErrorStart);
  const onToolError = workflowSource.slice(onToolErrorStart, onToolErrorEnd);

  assert.match(onToolError, /const failureKind = meta\?\.failureKind \|\| "policy"/);
  assert.match(
    onToolError,
    /shouldRecordPlanExecutionFailure\(meta\)\s*\? createPlanExecutionFailureEntry/,
  );
  assert.match(onToolError, /const evidencePatch = failureEntry\s*\?/);
  assert.match(onToolError, /if \(meta\?\.internalFeedback === true\)[\s\S]*return;/);
  assert.match(
    orchestratorSource,
    /catch \(err\)[\s\S]*callbacks\.onToolError\(tc\.name, target, errorMsg, \{\s*toolCallId: tc\.id,\s*failureKind: "actual",/,
  );
});

test("workflow engine closes harness from structured agent loop outcome", () => {
  const source = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/workflowEngine.ts"), "utf8");

  assert.match(source, /type AgentLoopOutcome/);
  assert.match(source, /const closeHarnessForAgentLoopOutcome = \(outcome: AgentLoopOutcome\) =>/);
  assert.match(source, /case "completed":[\s\S]*agent_loop_completed/);
  assert.match(source, /case "paused":[\s\S]*closeCurrentHarnessRunMarker\("paused"/);
  assert.match(source, /case "stopped_no_action":[\s\S]*agent_loop_no_action/);
  assert.match(source, /agent_loop_stop_summary/);
  assert.match(source, /streamElapsedMs:\s*marker\.streamElapsedMs/);
  assert.match(source, /lastStreamError:\s*marker\.lastStreamError/);
  assert.doesNotMatch(source, /closeCurrentHarnessRunMarker\("completed", "agent_loop_resolved"\)/);
});

test("agent loop returns structured non-completed outcomes for stops and approved-plan guard", () => {
  const runnerSource = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/AgentLoopRunner.ts"), "utf8");
  const guardsSource = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/completionGuards.ts"), "utf8");

  assert.match(runnerSource, /Promise<AgentLoopOutcome>/);
  assert.match(runnerSource, /onNonActionableStop: \(message, reason, progress\) =>/);
  assert.match(runnerSource, /resolveNonActionableStopOutcome\(reason, progress\)/);
  assert.match(guardsSource, /reason === "incomplete_plan" \? "paused"/);
  assert.match(guardsSource, /approved_plan_completion_guard/);
  assert.match(guardsSource, /buildPlanTaskEvidenceAudit/);
});

test("agent loop runtime state preparation is separated from the main execute loop", () => {
  const source = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/AgentOrchestrator.ts"), "utf8");
  const turnPreparationSource = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/turnPreparation.ts"), "utf8");
  const streamInvocationSource = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/streamInvocation.ts"), "utf8");
  const streamRecoverySource = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/streamRecovery.ts"), "utf8");
  const iterationStreamPreparationSource = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/iterationStreamPreparation.ts"), "utf8");
  const toolCallPlanningSource = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/toolCallPlanning.ts"), "utf8");
  const contextManagementSource = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/contextManagement.ts"), "utf8");
  const toolRegistrySetupSource = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/toolRegistrySetup.ts"), "utf8");
  const toolSurfaceRuntimeSource = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/toolSurfaceRuntime.ts"), "utf8");
  const toolCallPartitioningSource = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/toolCallPartitioning.ts"), "utf8");
  const toolExecutionRoundSource = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/toolExecutionRound.ts"), "utf8");
  const toolIterationPhaseSource = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/toolIterationPhase.ts"), "utf8");
  const toolCallExecutionPhaseSource = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/toolCallExecutionPhase.ts"), "utf8");
  const toolResultRecoveryPhaseSource = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/toolResultRecoveryPhase.ts"), "utf8");
  const toolProgressRoutingSource = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/toolProgressRouting.ts"), "utf8");
  const toolResultHistorySource = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/toolResultHistory.ts"), "utf8");
  const toolResultPostProcessingSource = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/toolResultPostProcessing.ts"), "utf8");
  const finalTurnCompletionSource = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/finalTurnCompletion.ts"), "utf8");
  const finalTextOnlyToolCallHandlingSource = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/finalTextOnlyToolCallHandling.ts"), "utf8");
  const loopRecoverySource = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/loopRecovery.ts"), "utf8");
  const maxIterationBoundarySource = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/maxIterationBoundary.ts"), "utf8");
  const approvedPlanNoToolRoutingSource = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/approvedPlanNoToolRouting.ts"), "utf8");
  const approvedPlanRecoveryActionsSource = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/approvedPlanRecoveryActions.ts"), "utf8");
  const approvedPlanFinalizationSource = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/approvedPlanFinalization.ts"), "utf8");
  const preCompletionEvidenceRecoverySource = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/preCompletionEvidenceRecovery.ts"), "utf8");
  const executeNoToolRecoverySource = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/executeNoToolRecovery.ts"), "utf8");
  const executeRecoveryRuntimeSource = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/executeRecoveryRuntime.ts"), "utf8");
  const missingToolNoToolRecoverySource = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/missingToolNoToolRecovery.ts"), "utf8");
  const planNoToolRecoverySource = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/planNoToolRecovery.ts"), "utf8");
  const unityMcpRuntimeSource = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/unityMcpRuntime.ts"), "utf8");
  const planConvergenceSource = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/planConvergence.ts"), "utf8");
  const planQualityRecoverySource = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/planQualityRecovery.ts"), "utf8");
  const reasoningNoToolRecoverySource = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/reasoningNoToolRecovery.ts"), "utf8");
  const emptyResponseRecoverySource = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/emptyResponseRecovery.ts"), "utf8");
  const assistantResponseProcessingSource = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/assistantResponseProcessing.ts"), "utf8");
  const assistantTurnDisplaySource = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/assistantTurnDisplay.ts"), "utf8");
  const assistantActionRoutingSource = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/assistantActionRouting.ts"), "utf8");
  const assistantNoToolRecoveryRoutingSource = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/assistantNoToolRecoveryRouting.ts"), "utf8");
  const assistantLanguageRecoveryRoutingSource = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/assistantLanguageRecoveryRouting.ts"), "utf8");
  const assistantRecoveryHandlingSource = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/assistantRecoveryHandling.ts"), "utf8");
  const assistantOutputRoutingSource = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/assistantOutputRouting.ts"), "utf8");
  const assistantIterationPhaseSource = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/assistantIterationPhase.ts"), "utf8");
  const assistantCompletionPhaseSource = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/assistantCompletionPhase.ts"), "utf8");
  const assistantStreamPostProcessingPhaseSource = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/assistantStreamPostProcessingPhase.ts"), "utf8");
  const assistantDisplayActionPhaseSource = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/assistantDisplayActionPhase.ts"), "utf8");
  const assistantOutputPhaseSource = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/assistantOutputPhase.ts"), "utf8");
  const turnIterationContextSource = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/turnIterationContext.ts"), "utf8");
  const planRuntimeStateSource = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/planRuntimeState.ts"), "utf8");
  const streamRuntimeStateSource = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/streamRuntimeState.ts"), "utf8");
  const recoveryPromptRuntimeStateSource = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/recoveryPromptRuntimeState.ts"), "utf8");
  const noToolRuntimeStateSource = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/noToolRuntimeState.ts"), "utf8");
  const loopGuardRuntimeStateSource = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/loopGuardRuntimeState.ts"), "utf8");
  const loopMutableStateSource = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/loopMutableState.ts"), "utf8");
  const toolExecutionRuntimeStateSource = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/toolExecutionRuntimeState.ts"), "utf8");
  const evidenceRuntimeStateSource = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/evidenceRuntimeState.ts"), "utf8");
  const planReviewRuntimeSource = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/planReviewRuntime.ts"), "utf8");
  const loopControlRuntimeSource = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/loopControlRuntime.ts"), "utf8");
  const loopRuntimeActionsSource = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/loopRuntimeActions.ts"), "utf8");

  assert.match(source, /const runtimeState = await prepareAgentLoopRuntimeState\(callbacks\)/);
  assert.match(source, /const turnInputContext = resolveAgentLoopTurnInputContext\(runtimeState, callbacks\)/);
  assert.match(source, /const \{ applySystemPromptForRuntime \} = createSystemPromptApplier/);
  assert.match(source, /prepareIterationStreamRequest\(\{/);
  assert.match(source, /invokeStreamWithRecoveryForIteration\(\{/);
  assert.match(iterationStreamPreparationSource, /resolveIterationToolSurface\(\{/);
  assert.match(iterationStreamPreparationSource, /prepareManagedMessagesForIteration\(\{/);
  assert.match(source, /prepareAgentLoopToolRegistry\(\{/);
  assert.match(source, /handleToolIterationPhase\(\{/);
  assert.match(toolIterationPhaseSource, /executeToolCallPhase\(input\)/);
  assert.match(toolIterationPhaseSource, /handleToolResultRecoveryPhase\(\{/);
  assert.match(toolCallExecutionPhaseSource, /partitionToolCallsForExecution\(\{/);
  assert.match(assistantOutputPhaseSource, /resolveToolProgressRouting\(\{/);
  assert.match(assistantOutputPhaseSource, /resolveToolProgressPresentation\(\{/);
  assert.match(toolCallExecutionPhaseSource, /executeToolExecutionRound\(\{/);
  assert.match(toolResultRecoveryPhaseSource, /appendToolResultsToHistory\(\{/);
  assert.match(toolCallExecutionPhaseSource, /handleToolResultPostProcessing\(\{/);
  assert.doesNotMatch(toolResultRecoveryPhaseSource, /handleReadFileRepeatLimitRecovery\(\{/);
  assert.doesNotMatch(toolResultRecoveryPhaseSource, /handleRepeatedEditValidationRecovery\(\{/);
  assert.match(toolResultRecoveryPhaseSource, /handleStrictRepeatGuardRecovery\(\{/);
  assert.match(source, /handleMaxIterationBoundary\(\{/);
  assert.match(assistantOutputPhaseSource, /resolveApprovedPlanNoToolRoute\(\{/);
  assert.match(source, /createAgentLoopControlRuntime\(\{/);
  assert.match(source, /loopControl\.startLoop\(\{/);
  assert.match(loopControlRuntimeSource, /pauseApprovedPlanStreamWatchdogAction\(\{/);
  assert.match(source, /handleAssistantIterationPhase\(\{/);
  assert.match(assistantIterationPhaseSource, /handleAssistantCompletionPhase\(\{/);
  assert.match(assistantCompletionPhaseSource, /handleExecuteNoToolRecovery\(\{/);
  assert.match(assistantCompletionPhaseSource, /handleMissingToolNoToolRecovery\(\{/);
  assert.match(assistantCompletionPhaseSource, /handlePlanNoToolRecovery\(\{/);
  assert.match(source, /createUnityMcpRuntimeState\(\{/);
  assert.match(source, /createAgentLoopToolSurfaceRuntime\(\{/);
  assert.match(toolSurfaceRuntimeSource, /resolveUnityMcpFirstPhaseTools\(\{/);
  assert.match(toolSurfaceRuntimeSource, /filterToolDefinitionsForIntent\(/);
  assert.match(toolSurfaceRuntimeSource, /filterGlobalChatToolDefinitions\(\{/);
  assert.match(toolSurfaceRuntimeSource, /global_chat_tool_scope_applied/);
  assert.match(toolSurfaceRuntimeSource, /unity_mcp_fallback/);
  assert.match(assistantIterationPhaseSource, /handleUnityMcpNoToolRecovery\(\{/);
  assert.match(toolCallExecutionPhaseSource, /markUnityMcpToolCallsDetected\(/);
  assert.match(toolCallExecutionPhaseSource, /applyUnityMcpToolResultState\(/);
  assert.match(toolResultPostProcessingSource, /resolveUnityMcpForcedConsoleResult\(\{/);
  assert.match(unityMcpRuntimeSource, /resolveUnityMcpNoToolRecovery\(\{/);
  assert.match(toolResultRecoveryPhaseSource, /handlePlanReadOnlyConvergence\(\{/);
  assert.match(assistantOutputPhaseSource, /handlePlanPostConvergenceToolRedirect\(\{/);
  assert.match(toolResultRecoveryPhaseSource, /handlePlanQualityRecoveryAfterToolResults\(\{/);
  assert.match(assistantCompletionPhaseSource, /handleReplyOptionsPause\(\{/);
  assert.match(assistantCompletionPhaseSource, /handleFinalNoToolAssistantTurn\(\{/);
  assert.match(assistantIterationPhaseSource, /handleAssistantStreamPostProcessingPhase\(\{/);
  assert.match(assistantStreamPostProcessingPhaseSource, /handleFinalTextOnlyToolCalls\(\{/);
  assert.match(assistantStreamPostProcessingPhaseSource, /handleReasoningDominatedNoToolRecovery\(\{/);
  assert.match(assistantStreamPostProcessingPhaseSource, /handleEmptyResponseRecovery\(\{/);
  assert.match(assistantStreamPostProcessingPhaseSource, /processAssistantStreamResponse\(\{/);
  assert.match(assistantIterationPhaseSource, /handleAssistantDisplayActionPhase\(\{/);
  assert.match(assistantDisplayActionPhaseSource, /resolveAssistantTurnDisplayDecision\(\{/);
  assert.match(assistantDisplayActionPhaseSource, /resolveAssistantActionRouting\(\{/);
  assert.match(assistantDisplayActionPhaseSource, /handleAssistantNoToolRecovery\(\{/);
  assert.match(assistantIterationPhaseSource, /handleAssistantOutputPhase\(\{/);
  assert.match(assistantOutputPhaseSource, /handleAssistantLanguageRecovery\(\{/);
  assert.match(assistantRecoveryHandlingSource, /countRecentReadOnlyActivityForChat\(\{/);
  assert.match(assistantRecoveryHandlingSource, /resolveAssistantNoToolRecoveryRoute\(\{/);
  assert.match(assistantRecoveryHandlingSource, /resolveAssistantLanguageRecoveryRoute\(\{/);
  assert.match(assistantOutputPhaseSource, /resolveToolProtocolStreamClearDecision\(\{/);
  assert.match(assistantOutputPhaseSource, /resolveAssistantReplyOptionRouting\(\{/);
  assert.match(assistantOutputPhaseSource, /isHiddenThoughtOnlyNoToolStop\(\{/);
  assert.match(source, /startTurnIteration\(\{/);
  assert.match(source, /createAgentLoopMutableState\(\{/);
  assert.match(loopMutableStateSource, /createExecuteRecoveryRuntimeState\(\{/);
  assert.match(source, /createAgentLoopRuntimeActions\(\{/);
  assert.match(loopRuntimeActionsSource, /activateExecuteRecoveryRuntimeState\(/);
  assert.match(iterationStreamPreparationSource, /advanceExecuteRecoveryRuntimeIteration\(input\.executeRecoveryState\)/);
  assert.match(loopRuntimeActionsSource, /clearExecuteRecoveryRuntimeState\(stateOverride\)/);
  assert.match(loopMutableStateSource, /createPlanLoopRuntimeState\(\{/);
  assert.match(loopRuntimeActionsSource, /applyPlanRuntimePhase\(/);
  assert.match(assistantStreamPostProcessingPhaseSource, /applyReasoningNoToolPlanRuntimeState\(/);
  assert.match(assistantCompletionPhaseSource, /applyPlanNoToolRuntimeState\(/);
  assert.match(assistantCompletionPhaseSource, /setPlanRuntimePhaseAndSync/);
  assert.match(assistantCompletionPhaseSource, /input\.setPlanRuntimePhase\(phase, reason, status, qualitySnapshot\)/);
  assert.match(assistantCompletionPhaseSource, /planRuntimeState = applyPlanRuntimePhase\(\{/);
  assert.match(assistantCompletionPhaseSource, /planQualityRejectCount: qualitySnapshot\.qualityRejectCount/);
  assert.match(assistantOutputPhaseSource, /applyPlanPostConvergenceRuntimeState\(/);
  assert.match(assistantOutputPhaseSource, /setPlanRuntimePhaseAndSync/);
  assert.match(assistantOutputPhaseSource, /planRuntimeState = applyPlanRuntimePhase\(planRuntimeState/);
  assert.match(toolCallExecutionPhaseSource, /applyToolResultPlanRuntimeState\(/);
  assert.match(toolResultRecoveryPhaseSource, /applyPlanQualityRuntimeState\(/);
  assert.match(toolResultRecoveryPhaseSource, /applyPlanReadOnlyConvergenceRuntimeState\(/);
  assert.match(toolResultRecoveryPhaseSource, /setPlanRuntimePhaseAndSync/);
  assert.match(toolResultRecoveryPhaseSource, /input\.setPlanRuntimePhase\(phase, reason, status, qualitySnapshot\)/);
  assert.match(toolResultRecoveryPhaseSource, /planRuntimeState = applyPlanRuntimePhase\(\{/);
  assert.match(assistantOutputPhaseSource, /markPlanModeToolActivity\(planRuntimeState\)/);
  assert.match(planReviewRuntimeSource, /markPlanClosurePromptIssued\(planRuntimeState\)/);
  assert.match(toolCallExecutionPhaseSource, /resetPlanRecoveryPromptRuntimeState\(/);
  assert.match(loopMutableStateSource, /createAgentLoopStreamRuntimeState\(\)/);
  assert.match(loopControlRuntimeSource, /resolveMaxOutputEscalations\(\{/);
  assert.match(iterationStreamPreparationSource, /resolveFinalTextOnlyStepState\(input\.streamRuntimeState/);
  assert.match(iterationStreamPreparationSource, /appendActiveRuntimeGuidance\(\{/);
  assert.match(iterationStreamPreparationSource, /runtime_guidance_injected/);
  assert.match(iterationStreamPreparationSource, /callbacks\.onDebugEvent\?\.\("agent\.iteration_start"/);
  assert.match(iterationStreamPreparationSource, /buildExecuteRecoveryMaxIterationsPrompt/);
  assert.match(loopRuntimeActionsSource, /activateChatFinalSynthesisState\(/);
  assert.match(source, /markChatFinalSynthesisPromptUsedMutableState\(loopState\)/);
  assert.match(loopMutableStateSource, /markChatFinalSynthesisPromptUsed\(/);
  assert.match(loopControlRuntimeSource, /resolvePlanStreamWatchdogState\(streamRuntimeState/);
  assert.match(loopMutableStateSource, /createAgentLoopRecoveryPromptRuntimeState\(\)/);
  assert.match(assistantRecoveryHandlingSource, /markToolUnavailableRecoveryPromptUsed\(/);
  assert.match(assistantRecoveryHandlingSource, /markPseudoToolCallRecoveryPromptUsed\(/);
  assert.match(assistantRecoveryHandlingSource, /markLanguageMismatchRecoveryPromptUsed\(/);
  assert.match(assistantOutputPhaseSource, /markReadOnlyPermissionHardRecoveryPromptUsed\(recoveryPromptState\)/);
  assert.match(toolCallExecutionPhaseSource, /resetTransientRecoveryPromptRuntimeState\(/);
  assert.match(assistantStreamPostProcessingPhaseSource, /applyMalformedToolUseRecoveryPromptState\(/);
  assert.match(toolResultRecoveryPhaseSource, /applyExecuteConvergencePromptState\(/);
  assert.match(loopMutableStateSource, /createAgentLoopNoToolRuntimeState\(\)/);
  assert.match(assistantCompletionPhaseSource, /applyConsecutiveNoToolRuntimeState\(/);
  assert.match(assistantOutputPhaseSource, /incrementConsecutiveNoToolRuntimeState\(noToolRuntimeState\)/);
  assert.match(assistantOutputPhaseSource, /resetConsecutiveNoToolRuntimeState\(noToolRuntimeState\)/);
  assert.match(assistantStreamPostProcessingPhaseSource, /applyReasoningDominatedNoToolRuntimeState\(/);
  assert.match(assistantStreamPostProcessingPhaseSource, /applyEmptyResponseNoToolRuntimeState\(/);
  assert.match(assistantStreamPostProcessingPhaseSource, /resetEmptyAndReasoningNoToolRuntimeState\(noToolRuntimeState\)/);
  assert.match(assistantCompletionPhaseSource, /applyRecoveringFromEmptyAssistantReplyRuntimeState\(/);
  assert.match(loopMutableStateSource, /createAgentLoopGuardRuntimeState\(\)/);
  assert.match(toolResultRecoveryPhaseSource, /getNoProgressTrackingRuntimeState\(loopGuardRuntimeState\)/);
  assert.match(toolResultRecoveryPhaseSource, /applyNoProgressTrackingRuntimeState\(/);
  assert.match(toolResultRecoveryPhaseSource, /applyToolFailureSignatureRuntimeState\(/);
  assert.doesNotMatch(loopRuntimeActionsSource, /clearCrossIterationReadTrackingForTarget\(/);
  assert.match(loopMutableStateSource, /createAgentLoopToolExecutionRuntimeState\(/);
  assert.match(iterationStreamPreparationSource, /fileReadStates: toolExecutionRuntimeState\.fileReadStates/);
  assert.match(toolCallExecutionPhaseSource, /\.\.\.input\.toolExecutionRuntimeState/);
  assert.match(loopMutableStateSource, /createAgentLoopEvidenceRuntimeState\(\)/);
  assert.match(loopMutableStateSource, /markExecuteOperationEvidenceRuntimeState\(/);
  assert.match(source, /markExecuteOperationEvidenceMutableState\(loopState\)/);
  assert.match(assistantOutputPhaseSource, /setLastAssistantTextForCheckpointRuntimeState\(/);
  assert.match(toolCallExecutionPhaseSource, /applyRecentSuccessfulProjectWriteRuntimeState\(/);
  assert.match(source, /createPlanReviewRuntimeHandlers\(\{/);
  assert.match(source, /waitForPlanApprovalIfNeeded,/);
  assert.match(source, /pauseForReviewablePlanArtifact,/);
  assert.match(source, /tryClosePlanWithEvidence,/);
  assert.match(approvedPlanNoToolRoutingSource, /buildPlanTaskEvidenceAudit/);
  assert.match(approvedPlanNoToolRoutingSource, /shouldHandleApprovedPlanExecutionNoTool/);
  assert.match(approvedPlanNoToolRoutingSource, /looksLikePlanCompletionClaim/);
  assert.match(approvedPlanNoToolRoutingSource, /shouldSuppressApprovedPlanNoToolText/);
  assert.match(toolProgressRoutingSource, /isPreApprovalPlanDraftWrite/);
  assert.match(toolProgressRoutingSource, /looksLikeSubstantivePlanAssistantText/);
  assert.match(toolProgressRoutingSource, /shouldInjectRuntimeToolNarration/);
  assert.match(toolProgressRoutingSource, /resolveToolProgressPresentation/);
  assert.match(assistantNoToolRecoveryRoutingSource, /shouldTriggerChatFinalSynthesis/);
  assert.match(assistantNoToolRecoveryRoutingSource, /looksLikeToolUnavailableClaim/);
  assert.match(assistantNoToolRecoveryRoutingSource, /action: "activate_chat_final_synthesis"/);
  assert.match(assistantNoToolRecoveryRoutingSource, /action: "reprompt_tool_unavailable"/);
  assert.match(assistantNoToolRecoveryRoutingSource, /action: "reprompt_pseudo_tool"/);
  assert.match(assistantNoToolRecoveryRoutingSource, /action: "stop_pseudo_tool_doom_loop"/);
  assert.match(assistantLanguageRecoveryRoutingSource, /shouldRecoverLanguageMismatchTurn/);
  assert.match(assistantLanguageRecoveryRoutingSource, /shouldTriggerChatFinalSynthesis/);
  assert.match(assistantLanguageRecoveryRoutingSource, /action: "activate_chat_final_synthesis"/);
  assert.match(assistantLanguageRecoveryRoutingSource, /action: "recover_once"/);
  assert.match(assistantLanguageRecoveryRoutingSource, /action: "hide_text_continue"/);
  assert.match(assistantOutputRoutingSource, /containsToolUseBlock/);
  assert.match(assistantOutputRoutingSource, /hasExecutableProposalReplyOptions/);
  assert.match(assistantOutputRoutingSource, /shouldPauseForReplyOptions/);
  assert.match(assistantOutputRoutingSource, /shouldAutoContinueNonBlockingPlanChoices/);
  assert.match(assistantOutputRoutingSource, /resolveClosedPlanReadOnlyContinuation/);
  assert.match(assistantOutputPhaseSource, /plan_closed_tool_surface_read_recovery/);
  assert.match(finalTextOnlyToolCallHandlingSource, /buildMaxStepsToolCallIgnoredNotice/);
  assert.match(finalTextOnlyToolCallHandlingSource, /buildExecuteNoProgressLoopPauseNotice/);
  assert.match(finalTextOnlyToolCallHandlingSource, /completeAssistantTurn\(\{/);
  assert.doesNotMatch(source, /looksLikeToolUnavailableClaim/);
  assert.doesNotMatch(source, /shouldRecoverLanguageMismatchTurn/);
  assert.doesNotMatch(source, /shouldTriggerChatFinalSynthesis/);
  assert.doesNotMatch(source, /containsToolUseBlock/);
  assert.doesNotMatch(source, /hasExecutableProposalReplyOptions/);
  assert.doesNotMatch(source, /shouldPauseForReplyOptions/);
  assert.doesNotMatch(source, /resolveAssistantNoToolRecoveryRoute\(/);
  assert.doesNotMatch(source, /resolveAssistantLanguageRecoveryRoute\(/);
  assert.doesNotMatch(source, /tool_unavailable_claim_reprompt/);
  assert.doesNotMatch(source, /pseudo_tool_repair_requested/);
  assert.doesNotMatch(source, /tool_protocol_doom_loop/);
  assert.doesNotMatch(source, /language_mismatch_reprompt/);
  assert.doesNotMatch(source, /language_mismatch_text_hidden_for_tool_calls/);
  assert.doesNotMatch(source, /buildMaxStepsToolCallIgnoredNotice/);
  assert.doesNotMatch(source, /buildExecuteNoProgressLoopPauseNotice/);
  assert.doesNotMatch(source, /runtime_guidance_injected/);
  assert.doesNotMatch(source, /logAgentEvent\("iteration_start"/);
  assert.doesNotMatch(source, /prepareManagedMessagesForIteration\(/);
  assert.doesNotMatch(source, /resolveIterationToolSurface\(/);
  assert.doesNotMatch(source, /partitionToolCallsForExecution\(/);
  assert.doesNotMatch(source, /executeToolExecutionRound\(/);
  assert.doesNotMatch(source, /handleToolResultPostProcessing\(/);
  assert.doesNotMatch(source, /tool_calls_detected/);
  assert.doesNotMatch(source, /appendToolResultsToHistory\(/);
  assert.doesNotMatch(source, /handleNoProgressRecovery\(/);
  assert.doesNotMatch(source, /handleReadFileRepeatLimitRecovery\(/);
  assert.doesNotMatch(source, /handleCrossIterationReadFileLoopRecovery\(/);
  assert.doesNotMatch(source, /handleRepeatedEditValidationRecovery\(/);
  assert.doesNotMatch(source, /handleStrictRepeatGuardRecovery\(/);
  assert.doesNotMatch(source, /handleTargetProgressLoopRecovery\(/);
  assert.doesNotMatch(source, /handleExecuteConvergencePrompt\(/);
  assert.doesNotMatch(source, /handlePlanQualityRecoveryAfterToolResults\(/);
  assert.doesNotMatch(source, /handlePlanReadOnlyConvergence\(/);
  assert.doesNotMatch(source, /handleExecuteNoToolRecovery\(/);
  assert.doesNotMatch(source, /handleMissingToolNoToolRecovery\(/);
  assert.doesNotMatch(source, /handlePlanNoToolRecovery\(/);
  assert.doesNotMatch(source, /handleReplyOptionsPause\(/);
  assert.doesNotMatch(source, /handleFinalNoToolAssistantTurn\(/);
  assert.doesNotMatch(source, /processAssistantStreamResponse\(/);
  assert.doesNotMatch(source, /handleReasoningDominatedNoToolRecovery\(/);
  assert.doesNotMatch(source, /handleEmptyResponseRecovery\(/);
  assert.doesNotMatch(source, /handleFinalTextOnlyToolCalls\(/);
  assert.doesNotMatch(source, /normalizeToolCallToExecute\(/);
  assert.doesNotMatch(source, /resolveAssistantTurnDisplayDecision\(/);
  assert.doesNotMatch(source, /resolveAssistantActionRouting\(/);
  assert.doesNotMatch(source, /handleAssistantNoToolRecovery\(/);
  assert.doesNotMatch(source, /resolveApprovedPlanNoToolRoute\(/);
  assert.doesNotMatch(source, /handleAssistantLanguageRecovery\(/);
  assert.doesNotMatch(source, /resolveToolProgressRouting\(/);
  assert.doesNotMatch(source, /resolveToolProgressPresentation\(/);
  assert.doesNotMatch(source, /resolveToolProtocolStreamClearDecision\(/);
  assert.doesNotMatch(source, /resolveAssistantReplyOptionRouting\(/);
  assert.doesNotMatch(source, /isHiddenThoughtOnlyNoToolStop\(/);
  assert.doesNotMatch(source, /handlePlanPostConvergenceToolRedirect\(/);
  assert.doesNotMatch(source, /resolveUnityMcpFirstPhaseTools\(/);
  assert.doesNotMatch(source, /resolveUnityMcpNoToolRecovery\(/);
  assert.doesNotMatch(source, /applyUnityMcpNoToolRecoveryState\(/);
  assert.doesNotMatch(source, /unity_mcp_strict_retry/);
  assert.doesNotMatch(source, /filterToolDefinitionsForIntent\(/);
  assert.doesNotMatch(source, /filterGlobalChatToolDefinitions\(/);
  assert.doesNotMatch(source, /global_chat_tool_scope_applied/);
  assert.doesNotMatch(source, /activateExecuteRecoveryRuntimeState\(/);
  assert.doesNotMatch(source, /clearExecuteRecoveryRuntimeState\(/);
  assert.doesNotMatch(source, /activateChatFinalSynthesisState\(/);
  assert.doesNotMatch(source, /applyPlanRuntimePhase\(/);
  assert.doesNotMatch(source, /clearCrossIterationReadTrackingForTarget\(/);
  assert.doesNotMatch(source, /execute_recovery_activated/);
  assert.doesNotMatch(source, /chat_final_synthesis_activated/);
  assert.doesNotMatch(source, /execute_recovery_cleared/);
  assert.doesNotMatch(source, /plan_runtime_phase_changed/);
  assert.doesNotMatch(source, /buildPlanTaskEvidenceAudit/);
  assert.doesNotMatch(source, /shouldHandleApprovedPlanExecutionNoTool/);
  assert.doesNotMatch(source, /looksLikePlanCompletionClaim/);
  assert.doesNotMatch(source, /isPreApprovalPlanDraftWrite/);
  assert.doesNotMatch(source, /looksLikeSubstantivePlanAssistantText/);
  assert.doesNotMatch(source, /let planRuntimePhase/);
  assert.doesNotMatch(source, /let planQualityRejectCount/);
  assert.doesNotMatch(source, /let planEvidenceRecoveryPasses/);
  assert.doesNotMatch(source, /let planDraftingRecoveryReadCount/);
  assert.doesNotMatch(source, /let planReadOnlyConvergenceBatches/);
  assert.doesNotMatch(source, /let sawPlanModeToolActivity/);
  assert.doesNotMatch(source, /let usedPlanRecoveryPrompt/);
  assert.doesNotMatch(source, /let usedPlanClosureGuard/);
  assert.doesNotMatch(source, /let usedPlanClosurePrompt/);
  assert.doesNotMatch(source, /let usedPlanReadOnlyConvergencePrompt/);
  assert.doesNotMatch(source, /let planPostConvergenceToolRedirectCount/);
  assert.doesNotMatch(source, /let usedMaxStepsFinalTextPrompt/);
  assert.doesNotMatch(source, /let chatFinalSynthesisActive/);
  assert.doesNotMatch(source, /let chatFinalSynthesisReason/);
  assert.doesNotMatch(source, /let usedChatFinalSynthesisPrompt/);
  assert.doesNotMatch(source, /let currentMaxTokens/);
  assert.doesNotMatch(source, /let loggedLocalPlanNoVisibleTokenNoticeOnly/);
  assert.doesNotMatch(source, /let usedToolUnavailableRecoveryPrompt/);
  assert.doesNotMatch(source, /let usedPseudoToolCallRecoveryPrompt/);
  assert.doesNotMatch(source, /let usedMalformedToolUseRecoveryPrompt/);
  assert.doesNotMatch(source, /let usedLanguageMismatchRecoveryPrompt/);
  assert.doesNotMatch(source, /let usedExecuteConvergencePrompt/);
  assert.doesNotMatch(source, /let usedReadOnlyPermissionHardRecoveryPrompt/);
  assert.doesNotMatch(source, /let consecutiveNoToolCount/);
  assert.doesNotMatch(source, /let consecutiveEmptyResponseCount/);
  assert.doesNotMatch(source, /let emptyResponseCountThisTurn/);
  assert.doesNotMatch(source, /let consecutiveReasoningDominatedCount/);
  assert.doesNotMatch(source, /let recoveringFromEmptyAssistantReplyAfterWrite/);
  assert.doesNotMatch(source, /const crossIterationFileReads = new Map/);
  assert.doesNotMatch(source, /const successfulEditTargetsSinceVerification = new Map/);
  assert.doesNotMatch(source, /let lastNoProgressBatchSignature/);
  assert.doesNotMatch(source, /let noProgressBatchRepeatCount/);
  assert.doesNotMatch(source, /let consecutiveReadFileOnlyCacheHits/);
  assert.doesNotMatch(source, /const repeatGuardRecoveredSignatures = new Set/);
  assert.doesNotMatch(source, /const targetProgressGuardRecoveredSignatures = new Set/);
  assert.doesNotMatch(source, /const failedToolCallCounts = new Map/);
  assert.doesNotMatch(source, /const readOnlyResultCache = new Map/);
  assert.doesNotMatch(source, /const browserValidationCache = new Map/);
  assert.doesNotMatch(source, /const readOnlyDuplicateSkipCounts = new Map/);
  assert.doesNotMatch(source, /const fileReadStates = getSessionFileReadStates/);
  assert.doesNotMatch(source, /let recentSuccessfulProjectWrite/);
  assert.doesNotMatch(source, /let sawExecuteOperationEvidence/);
  assert.doesNotMatch(source, /let lastAssistantTextForCheckpoint/);
  assert.doesNotMatch(source, /let unityMcpFirstPhaseActive/);
  assert.doesNotMatch(source, /let unityMcpFirstIterationPending/);
  assert.doesNotMatch(source, /let unityMcpForceConsoleFirstPending/);
  assert.doesNotMatch(source, /let unityConsoleFinalVerificationRequired/);
  assert.doesNotMatch(source, /let executeRecoveryMode/);
  assert.doesNotMatch(source, /let executeRecoveryReason/);
  assert.doesNotMatch(source, /let executeRecoveryAttempts/);
  assert.doesNotMatch(source, /const MAX_RECOVERY_ITERATIONS\s*=\s*6/);
  assert.doesNotMatch(source, /plan_reasoning_only_recovery_decision/);
  assert.doesNotMatch(source, /reasoning_dominated_recovery/);
  assert.doesNotMatch(source, /plan_review_ready_after_empty_response/);
  assert.doesNotMatch(source, /plan_empty_response_checkpoint/);
  assert.doesNotMatch(source, /reasoning_suppressed/);
  assert.doesNotMatch(source, /llm_empty_response_diagnostic/);
  assert.doesNotMatch(source, /function waitForPlanApprovalIfNeeded/);
  assert.doesNotMatch(source, /function pauseForReviewablePlanArtifact/);
  assert.doesNotMatch(source, /function tryClosePlanWithEvidence/);
  assert.doesNotMatch(source, /plan_closure_guard_start/);
  assert.doesNotMatch(source, /plan_review_ready_after_tool/);
  assert.doesNotMatch(source, /\(this as any\)\._thread/);
  assert.doesNotMatch(source, /createTurn\(eventTurnId/);
  assert.match(turnPreparationSource, /export interface AgentLoopRuntimeState/);
  assert.match(turnPreparationSource, /export interface AgentLoopTurnInputContext/);
  assert.match(turnPreparationSource, /export async function prepareAgentLoopRuntimeState/);
  assert.match(turnPreparationSource, /export function resolveAgentLoopTurnInputContext/);
  assert.match(turnPreparationSource, /export function createSystemPromptApplier/);
  assert.match(turnPreparationSource, /export async function loadAgentLoopResolvedInstructions/);
  assert.match(turnPreparationSource, /export async function loadAgentLoopHooksConfig/);
  assert.match(turnPreparationSource, /export async function runAgentLoopStartHooks/);
  assert.match(turnPreparationSource, /export function createTaskTargetingRuntime/);
  assert.match(turnPreparationSource, /export function startModelProbeForTurn/);
  assert.match(turnPreparationSource, /export function createTurnEventEmitter/);
  assert.match(turnPreparationSource, /export function emitInitialTurnPreparationEvents/);
  assert.match(turnPreparationSource, /computeDynamicLocalContextLimit/);
  assert.match(turnPreparationSource, /resolveReasoningPolicy/);
  assert.match(turnPreparationSource, /buildEffectiveTurnContract/);
  assert.match(turnPreparationSource, /buildSystemPrompt/);
  assert.match(turnPreparationSource, /tool_protocol_card_applied/);
  assert.match(turnPreparationSource, /task_orchestrator_phase/);
  assert.match(turnPreparationSource, /runModelProbe/);
  assert.match(turnPreparationSource, /runLifecycleHooks/);
  assert.match(streamInvocationSource, /export async function invokeInitialStreamForIteration/);
  assert.match(streamInvocationSource, /llm_request_shape/);
  assert.match(streamInvocationSource, /fetchLLMStream/);
  assert.match(streamInvocationSource, /messagesSentToLLM: messagesForLLM/);
  assert.match(streamInvocationSource, /buildMaxStepsFinalTextPrompt/);
  assert.match(streamInvocationSource, /buildChatFinalSynthesisPrompt/);
  assert.doesNotMatch(streamInvocationSource, /PolicyFactory|responseFormat|response_format/);
  assert.doesNotMatch(streamInvocationSource, /reasoningRatio|getReasoningDominatedStopMessage/);
  assert.match(streamRecoverySource, /export async function invokeStreamWithRecoveryForIteration/);
  assert.match(streamRecoverySource, /invokeInitialStreamForIteration/);
  assert.match(streamRecoverySource, /handlePlanDraftStreamTimeout/);
  assert.match(streamRecoverySource, /logAgentEvent\("context_retry_start"/);
  assert.match(streamRecoverySource, /logAgentEvent\("provider_compatibility_retry"/);
  assert.match(streamRecoverySource, /buildCompatibilityRetryMessages/);
  assert.match(streamRecoverySource, /buildTranscriptCompatibilityRetryMessages/);
  assert.match(streamRecoverySource, /ensureProviderCompatibilityMode/);
  assert.match(streamRecoverySource, /computeManagedContextLimit/);
  assert.match(streamRecoverySource, /prepareMessagesForToolProtocol/);
  assert.match(streamRecoverySource, /messagesSentToLLM: emergencyManagedForLLM/);
  assert.match(source, /managedAgentMessages: messagesSentToLLM/);
  assert.match(toolCallPlanningSource, /export interface IterationToolSurfaceDecision/);
  assert.match(toolCallPlanningSource, /export function resolveIterationToolSurface/);
  assert.match(toolCallPlanningSource, /execute_recovery_tool_scope_applied/);
  assert.doesNotMatch(toolCallPlanningSource, /approved_plan_source_edit_first_tool_scope_applied/);
  assert.match(toolCallPlanningSource, /logAgentEvent\("tool_surface_decision"/);
  assert.match(toolCallPlanningSource, /plan_runtime_tool_scope_applied/);
  assert.match(contextManagementSource, /export interface IterationContextManagementResult/);
  assert.match(contextManagementSource, /export function prepareManagedMessagesForIteration/);
  assert.match(contextManagementSource, /iterationContext: Pick<TurnIterationContext, "eventTurnId" \| "turnContext">;/);
  assert.match(contextManagementSource, /const \{ eventTurnId, turnContext \} = iterationContext;/);
  assert.match(contextManagementSource, /compactContextForExecuteRecovery/);
  assert.match(contextManagementSource, /computeContextForceReason/);
  assert.match(contextManagementSource, /logAgentEvent\("context_pack_built"/);
  assert.match(contextManagementSource, /logAgentEvent\("execute_recovery_context_compacted"/);
  assert.match(contextManagementSource, /logAgentEvent\("execute_recovery_context_skipped"/);
  assert.match(toolRegistrySetupSource, /export async function prepareAgentLoopToolRegistry/);
  assert.match(toolRegistrySetupSource, /discoverAllMcpTools/);
  assert.match(toolRegistrySetupSource, /logAgentEvent\("mcp_discovery_start"/);
  assert.match(toolRegistrySetupSource, /logAgentEvent\("mcp_discovery_done"/);
  assert.match(toolRegistrySetupSource, /logAgentEvent\("mcp_server_status"/);
  assert.match(toolRegistrySetupSource, /routeMcpToolsForPrompt/);
  assert.match(toolRegistrySetupSource, /buildToolCapabilityRegistry/);
  assert.match(toolRegistrySetupSource, /WEB_RESEARCH_TOOL_NAMES/);
  assert.match(toolRegistrySetupSource, /KNOWLEDGE_TOOL_NAMES/);
  assert.match(toolCallPartitioningSource, /export async function partitionToolCallsForExecution/);
  assert.match(toolCallPartitioningSource, /iterationContext: Pick<TurnIterationContext, "eventThreadId" \| "eventTurnId">;/);
  assert.match(toolCallPartitioningSource, /const \{ eventThreadId, eventTurnId \} = iterationContext;/);
  assert.match(toolCallPartitioningSource, /planRuntimeToolCall/);
  assert.match(toolCallPartitioningSource, /shouldBlockToolCallForTargeting/);
  assert.match(toolCallPartitioningSource, /buildReadOnlyCacheSignature/);
  assert.match(toolCallPartitioningSource, /logAgentEvent\("file_read_cache_hit"/);
  assert.match(toolCallPartitioningSource, /logAgentEvent\("browser_validation_reused_without_state_change"/);
  assert.match(toolCallPartitioningSource, /emitToolPreflightBlocked/);
  assert.match(toolExecutionRoundSource, /export async function executeToolExecutionRound/);
  assert.match(toolExecutionRoundSource, /executeReadOnlyToolsConcurrently/);
  assert.match(toolExecutionRoundSource, /executeLocalFileReadToolWithReview/);
  assert.match(toolExecutionRoundSource, /executeWriteToolWithReview/);
  assert.match(toolExecutionRoundSource, /logAgentEvent\("file_read_cache_stored"/);
  assert.match(toolExecutionRoundSource, /browserValidationCache\.set/);
  assert.match(toolResultHistorySource, /export function appendToolResultsToHistory/);
  assert.match(toolResultHistorySource, /iterationContext: Pick<TurnIterationContext, "eventThreadId" \| "eventTurnId" \| "turnContext">;/);
  assert.match(toolResultHistorySource, /const \{ eventThreadId, eventTurnId, turnContext \} = iterationContext;/);
  assert.match(toolResultHistorySource, /buildToolResultHistoryContentByFormat/);
  assert.match(toolResultHistorySource, /turnContext\.registerToolExecution/);
  assert.match(toolResultHistorySource, /type: "tool_result"/);
  assert.match(toolResultHistorySource, /createHookContextMessages\("PostToolUse"/);
  assert.match(toolResultPostProcessingSource, /export function handleToolResultPostProcessing/);
  assert.match(toolResultPostProcessingSource, /toolResultCountsAsExecutionEvidence/);
  assert.match(toolResultPostProcessingSource, /resolveUnityMcpForcedConsoleResult/);
  assert.match(toolResultPostProcessingSource, /buildExecutionDigest/);
  assert.match(toolResultPostProcessingSource, /EVIDENCE_RECONCILE/);
  assert.match(toolResultPostProcessingSource, /stage: "after_evidence_reconcile"/);
  assert.match(toolResultPostProcessingSource, /shouldDeferNoProgressStopToPlanReadOnlyConvergence/);
  assert.match(finalTurnCompletionSource, /export function completeAssistantTurn/);
  assert.match(finalTurnCompletionSource, /iterationContext: Pick<TurnIterationContext, "eventThreadId" \| "eventTurnId">;/);
  assert.match(finalTurnCompletionSource, /const \{ eventThreadId, eventTurnId \} = iterationContext;/);
  assert.match(finalTurnCompletionSource, /export function handleReplyOptionsPause/);
  assert.match(finalTurnCompletionSource, /export function handleFinalNoToolAssistantTurn/);
  assert.match(finalTurnCompletionSource, /reply_options_pause/);
  assert.match(finalTurnCompletionSource, /plan_waiting_for_user_or_summary/);
  assert.match(finalTurnCompletionSource, /assistant_text_done/);
  assert.match(toolResultRecoveryPhaseSource, /handleNoProgressRecovery\(\{/);
  assert.match(loopRecoverySource, /export function handleNoProgressRecovery/);
  assert.match(loopRecoverySource, /resolveExecuteReadOnlyRecoveryTrigger/);
  assert.match(loopRecoverySource, /resolveReadOnlyNoProgressTrigger/);
  assert.match(loopRecoverySource, /isApprovedPlanCachedReadOnlyNoProgressBatch/);
  assert.match(loopRecoverySource, /chat_readonly_no_progress_final_synthesis/);
  assert.match(loopRecoverySource, /chat_repair_readonly_no_progress_paused/);
  assert.match(loopRecoverySource, /no_progress_deferred_to_plan_readonly_convergence/);
  assert.match(loopRecoverySource, /no_progress_batch_loop/);
  assert.match(loopRecoverySource, /currentExecuteRecoveryAttempts/);
  assert.doesNotMatch(toolResultRecoveryPhaseSource, /handleCrossIterationReadFileLoopRecovery\(\{/);
  assert.doesNotMatch(loopRecoverySource, /export function handleCrossIterationReadFileLoopRecovery/);
  assert.doesNotMatch(loopRecoverySource, /resolveCrossIterationReadThreshold/);
  assert.match(toolResultRecoveryPhaseSource, /handleTargetProgressLoopRecovery\(\{/);
  assert.match(loopRecoverySource, /export function handleTargetProgressLoopRecovery/);
  assert.match(loopRecoverySource, /registerTargetProgressEventForLoopGuard/);
  assert.match(loopRecoverySource, /formatTargetProgressLoopRecoveryMessage/);
  assert.match(loopRecoverySource, /target_progress_mutation_failure/);
  assert.match(loopRecoverySource, /target_progress_no_diff_chain/);
  assert.match(toolResultRecoveryPhaseSource, /handleExecuteConvergencePrompt\(\{/);
  assert.match(loopRecoverySource, /export function handleExecuteConvergencePrompt/);
  assert.match(loopRecoverySource, /PLAN_EXECUTE_CONVERGENCE_PROMPT_RATIO/);
  assert.match(loopRecoverySource, /EXECUTE_CONVERGENCE_PROMPT_RATIO/);
  assert.match(loopRecoverySource, /buildExecuteConvergencePrompt/);
  assert.match(loopRecoverySource, /execute_convergence_prompt/);
  assert.doesNotMatch(loopRecoverySource, /export function handleReadFileRepeatLimitRecovery/);
  assert.doesNotMatch(loopRecoverySource, /export function handleRepeatedEditValidationRecovery/);
  assert.match(loopRecoverySource, /export function handleStrictRepeatGuardRecovery/);
  assert.match(loopRecoverySource, /registerToolCallForRepeatGuard/);
  assert.match(loopRecoverySource, /formatRepeatLoopRecoveryMessage/);
  assert.match(loopRecoverySource, /formatRepeatLoopFatalMessage/);
  assert.match(loopRecoverySource, /approved_plan_repeated_browser_validation/);
  assert.doesNotMatch(loopRecoverySource, /approved_plan_read_file_repeat_limit/);
  assert.doesNotMatch(loopRecoverySource, /repeat_edit_target_validation_recovery/);
  assert.doesNotMatch(source, /formatRepeatLoopFatalMessage/);
  assert.doesNotMatch(source, /formatRepeatLoopRecoveryMessage/);
  assert.doesNotMatch(source, /approved_plan_repeated_read_file/);
  assert.doesNotMatch(source, /approved_plan_repeated_browser_validation/);
  assert.match(maxIterationBoundarySource, /export async function handleMaxIterationBoundary/);
  assert.match(maxIterationBoundarySource, /buildPlanMaxIterationsCheckpoint/);
  assert.match(maxIterationBoundarySource, /buildPlanMaxIterationsPauseNotice/);
  assert.match(maxIterationBoundarySource, /buildExecuteMaxIterationsPauseNotice/);
  assert.match(maxIterationBoundarySource, /logAgentEvent\(isPlanBoundary[\s\S]*?"max_iterations_checkpoint"[\s\S]*?"execute_max_iterations_checkpoint"/);
  assert.match(maxIterationBoundarySource, /reason: "max_iterations_boundary"/);
  assert.match(approvedPlanRecoveryActionsSource, /export function pauseApprovedPlanStreamWatchdog/);
  assert.match(approvedPlanRecoveryActionsSource, /approved_plan_stream_watchdog_paused/);
  assert.match(preCompletionEvidenceRecoverySource, /export function resolvePreCompletionEvidenceRecoveryDecision/);
  const preCompletionAuditIndex = assistantCompletionPhaseSource.indexOf("resolvePreCompletionEvidenceRecoveryDecision({");
  const activeContractIndex = assistantCompletionPhaseSource.indexOf('currentExecuteRecoveryState.mode !== "normal"');
  const executeNoToolIndex = assistantCompletionPhaseSource.indexOf("handleExecuteNoToolRecovery({");
  assert.ok(preCompletionAuditIndex >= 0);
  assert.ok(preCompletionAuditIndex < activeContractIndex);
  assert.ok(activeContractIndex < executeNoToolIndex);
  assert.match(assistantCompletionPhaseSource, /handleApprovedPlanFinalization\(\{/);
  assert.match(approvedPlanFinalizationSource, /export function handleApprovedPlanFinalization/);
  assert.match(approvedPlanFinalizationSource, /remaining_plan_tasks_limit/);
  assert.match(approvedPlanFinalizationSource, /plan_completion_guard_reprompt/);
  assert.match(approvedPlanFinalizationSource, /plan_evidence_complete/);
  assert.doesNotMatch(source, /remaining_plan_tasks_limit/);
  assert.doesNotMatch(source, /plan_completion_guard_reprompt/);
  assert.doesNotMatch(source, /plan_execution_validation_boundary/);
  assert.doesNotMatch(source, /handleApprovedPlanFinalization\(/);
  assert.doesNotMatch(source, /buildApprovedPlanValidationPendingMessage/);
  assert.doesNotMatch(source, /buildBrowserValidationContinuationPrompt/);
  assert.match(executeNoToolRecoverySource, /export function handleExecuteNoToolRecovery/);
  assert.match(executeNoToolRecoverySource, /export function resolveExecuteNoToolCheckpointLimit/);
  assert.match(executeNoToolRecoverySource, /export function isExecuteRuntimeRequiringEvidence/);
  assert.doesNotMatch(executeNoToolRecoverySource, /execute_completion_claim_without_evidence/);
  assert.doesNotMatch(executeNoToolRecoverySource, /execute_replanning_text_without_evidence/);
  assert.match(executeNoToolRecoverySource, /execute_xml_text_without_action/);
  assert.match(executeRecoveryRuntimeSource, /export interface ExecuteRecoveryRuntimeState/);
  assert.match(executeRecoveryRuntimeSource, /export const MAX_EXECUTE_RECOVERY_ITERATIONS = 6/);
  assert.match(executeRecoveryRuntimeSource, /export function createExecuteRecoveryRuntimeState/);
  assert.match(executeRecoveryRuntimeSource, /export function activateExecuteRecoveryRuntimeState/);
  assert.match(executeRecoveryRuntimeSource, /export function advanceExecuteRecoveryRuntimeIteration/);
  assert.match(executeRecoveryRuntimeSource, /export function clearExecuteRecoveryRuntimeState/);
  assert.match(missingToolNoToolRecoverySource, /export function handleMissingToolNoToolRecovery/);
  assert.match(missingToolNoToolRecoverySource, /export function resolveMissingToolNoToolKind/);
  assert.match(missingToolNoToolRecoverySource, /missing_tool_reprompt/);
  assert.match(missingToolNoToolRecoverySource, /execute_read_only_no_action_checkpoint/);
  assert.match(missingToolNoToolRecoverySource, /missing_tool_reprompt_limit/);
  assert.match(planNoToolRecoverySource, /export async function handlePlanNoToolRecovery/);
  assert.match(planNoToolRecoverySource, /export function resolvePlanNoToolRecoveryDecision/);
  assert.match(planNoToolRecoverySource, /export \{ buildPlanClosureEvidenceRecoveryPrompt \}/);
  assert.match(planNoToolRecoverySource, /plan_structured_proposal_materialized/);
  assert.match(planNoToolRecoverySource, /plan_text_materialized/);
  assert.match(planNoToolRecoverySource, /plan_recovery_prompt_start/);
  assert.match(planNoToolRecoverySource, /plan_refine_long_output/);
  assert.match(planNoToolRecoverySource, /force_plan_continuation_limit/);
  assert.match(unityMcpRuntimeSource, /export function resolveUnityMcpFirstPhaseTools/);
  assert.match(unityMcpRuntimeSource, /export function resolveUnityMcpForcedConsoleResult/);
  assert.match(unityMcpRuntimeSource, /export function resolveUnityMcpNoToolRecovery/);
  assert.match(unityMcpRuntimeSource, /export type UnityMcpRuntimeState/);
  assert.match(unityMcpRuntimeSource, /export function createUnityMcpRuntimeState/);
  assert.match(unityMcpRuntimeSource, /export function activateUnityMcpFallbackState/);
  assert.match(unityMcpRuntimeSource, /export function applyUnityMcpNoToolRecoveryState/);
  assert.match(unityMcpRuntimeSource, /export function handleUnityMcpNoToolRecovery/);
  assert.match(unityMcpRuntimeSource, /export function markUnityMcpToolCallsDetected/);
  assert.match(unityMcpRuntimeSource, /export function applyUnityMcpToolResultState/);
  assert.match(unityMcpRuntimeSource, /UNITY_MCP_STRICT_RETRY_FORCED_TOOLS/);
  assert.match(unityMcpRuntimeSource, /unity_mcp_strict_retry/);
  assert.match(unityMcpRuntimeSource, /missing_required_console_tool/);
  assert.match(unityMcpRuntimeSource, /mcp_tools_not_exposed_for_runtime/);
  assert.match(unityMcpRuntimeSource, /forced_console_call_failed/);
  assert.match(unityMcpRuntimeSource, /strict_retry_no_tool_call/);
  assert.match(planConvergenceSource, /export function handlePlanReadOnlyConvergence/);
  assert.match(planConvergenceSource, /export function handlePlanPostConvergenceToolRedirect/);
  assert.match(planConvergenceSource, /shouldTriggerPlanReadOnlyConvergence/);
  assert.match(planConvergenceSource, /buildPlanReadOnlyConvergencePrompt/);
  assert.match(planConvergenceSource, /plan_readonly_convergence_threshold/);
  assert.match(planConvergenceSource, /shouldRedirectPlanRuntimeToolsAfterReadOnlyConvergence/);
  assert.match(planConvergenceSource, /plan_post_convergence_tool_redirect/);
  assert.match(planConvergenceSource, /planEvidenceRecoveryPasses/);
  assert.match(planConvergenceSource, /plan_suppressed_tool_recovery_decision/);
  assert.match(planConvergenceSource, /plan_suppressed_tool_forced_write_injected/);
  assert.match(planQualityRecoverySource, /export function handlePlanQualityRecoveryAfterToolResults/);
  assert.match(planQualityRecoverySource, /plan_quality_recovery_action/);
  assert.match(planQualityRecoverySource, /plan_quality_gate_recovery_decision/);
  assert.match(reasoningNoToolRecoverySource, /export function handleReasoningDominatedNoToolRecovery/);
  assert.match(reasoningNoToolRecoverySource, /plan_reasoning_only_recovery_decision/);
  assert.match(reasoningNoToolRecoverySource, /activateExecuteRecovery\("mutation_first", "reasoning_dominated_recovery"/);
  assert.match(reasoningNoToolRecoverySource, /plan_reasoning_only_evidence_blocked/);
  assert.match(emptyResponseRecoverySource, /export async function handleEmptyResponseRecovery/);
  assert.match(emptyResponseRecoverySource, /plan_review_ready_after_empty_response/);
  assert.match(emptyResponseRecoverySource, /tool_protocol_parse_failed/);
  assert.match(emptyResponseRecoverySource, /empty_model_response/);
  assert.match(emptyResponseRecoverySource, /plan_empty_response_checkpoint/);
  assert.match(emptyResponseRecoverySource, /post_write_verify/);
  assert.match(assistantResponseProcessingSource, /export function processAssistantStreamResponse/);
  assert.match(assistantResponseProcessingSource, /stream_done/);
  assert.match(assistantResponseProcessingSource, /reasoning_suppressed/);
  assert.match(assistantResponseProcessingSource, /llm_empty_response_diagnostic/);
  assert.match(assistantResponseProcessingSource, /normalizeAssistantTurn/);
  assert.match(assistantResponseProcessingSource, /ensureVisibleConclusionWithPolicy/);
  assert.match(assistantTurnDisplaySource, /export interface AssistantTurnDisplayDecision/);
  assert.match(assistantTurnDisplaySource, /export function resolveAssistantTurnDisplayDecision/);
  assert.match(assistantTurnDisplaySource, /shouldCompactProseCodeDump/);
  assert.match(assistantTurnDisplaySource, /shouldRouteUnapprovedPlanReplyOptionsToArtifact/);
  assert.match(assistantTurnDisplaySource, /shouldSuppressApprovedPlanExecutionReplyOptions/);
  assert.match(assistantTurnDisplaySource, /buildPlanFallbackNotice/);
  assert.match(assistantActionRoutingSource, /export interface AssistantActionRoutingDecision/);
  assert.match(assistantActionRoutingSource, /export function resolveAssistantActionRouting/);
  assert.match(assistantActionRoutingSource, /choosePseudoToolRecovery/);
  assert.match(assistantActionRoutingSource, /shouldRequireWebResearchForPrompt/);
  assert.match(assistantActionRoutingSource, /WEB_RESEARCH_TOOL_NAMES/);
  assert.match(assistantActionRoutingSource, /isSyntheticVisibleConclusion/);
  assert.doesNotMatch(source, /shouldRouteUnapprovedPlanReplyOptionsToArtifact/);
  assert.doesNotMatch(source, /shouldAutoContinueReadOnlyPermission/);
  assert.doesNotMatch(source, /hasOnlyReadOnlyPermissionReplyOptions/);
  assert.doesNotMatch(source, /buildProseCodeDumpNotice/);
  assert.doesNotMatch(source, /shouldRequireWebResearchForPrompt/);
  assert.doesNotMatch(source, /choosePseudoToolRecovery/);
  assert.match(turnIterationContextSource, /export interface TurnIterationContext/);
  assert.match(turnIterationContextSource, /export function startTurnIteration/);
  assert.match(turnIterationContextSource, /createThread/);
  assert.match(turnIterationContextSource, /createTurn/);
  assert.match(turnIterationContextSource, /new TurnContext/);
  assert.match(source, /iterationContext: turnIterationContext/);
  assert.match(planRuntimeStateSource, /export interface PlanLoopRuntimeState/);
  assert.match(planRuntimeStateSource, /export function createPlanLoopRuntimeState/);
  assert.match(planRuntimeStateSource, /export function applyPlanRuntimePhase/);
  assert.match(planRuntimeStateSource, /export function applyPlanPostConvergenceRuntimeState/);
  assert.match(planRuntimeStateSource, /export function applyPlanQualityRuntimeState/);
  assert.match(planRuntimeStateSource, /export function applyPlanReadOnlyConvergenceRuntimeState/);
  assert.match(planRuntimeStateSource, /export function markPlanModeToolActivity/);
  assert.match(planRuntimeStateSource, /export function markPlanClosurePromptIssued/);
  assert.match(planRuntimeStateSource, /export function resetPlanRecoveryPromptRuntimeState/);
  assert.match(streamRuntimeStateSource, /export interface AgentLoopStreamRuntimeState/);
  assert.match(streamRuntimeStateSource, /export function createAgentLoopStreamRuntimeState/);
  assert.match(streamRuntimeStateSource, /export function resolveMaxOutputEscalations/);
  assert.match(streamRuntimeStateSource, /export function resolveFinalTextOnlyStepState/);
  assert.match(streamRuntimeStateSource, /export function activateChatFinalSynthesisState/);
  assert.match(streamRuntimeStateSource, /export function resolvePlanStreamWatchdogState/);
  assert.match(loopControlRuntimeSource, /export interface AgentLoopControlRuntime/);
  assert.match(loopControlRuntimeSource, /export function createAgentLoopControlRuntime/);
  assert.match(loopControlRuntimeSource, /resolveAgentLoopIterationBudget/);
  assert.match(loopControlRuntimeSource, /plan_execution_iteration_budget_started/);
  assert.match(loopControlRuntimeSource, /buildPlanExecutionProgressUpdate/);
  assert.match(loopControlRuntimeSource, /callbacks\.onDebugEvent\?\.\("agent\.loop_start"/);
  assert.match(recoveryPromptRuntimeStateSource, /export interface AgentLoopRecoveryPromptRuntimeState/);
  assert.match(recoveryPromptRuntimeStateSource, /export function createAgentLoopRecoveryPromptRuntimeState/);
  assert.match(recoveryPromptRuntimeStateSource, /export function resetTransientRecoveryPromptRuntimeState/);
  assert.match(recoveryPromptRuntimeStateSource, /export function applyExecuteConvergencePromptState/);
  assert.match(noToolRuntimeStateSource, /export interface AgentLoopNoToolRuntimeState/);
  assert.match(noToolRuntimeStateSource, /export function createAgentLoopNoToolRuntimeState/);
  assert.match(noToolRuntimeStateSource, /export function applyConsecutiveNoToolRuntimeState/);
  assert.match(noToolRuntimeStateSource, /export function incrementConsecutiveNoToolRuntimeState/);
  assert.match(noToolRuntimeStateSource, /export function resetConsecutiveNoToolRuntimeState/);
  assert.match(noToolRuntimeStateSource, /export function applyEmptyResponseNoToolRuntimeState/);
  assert.match(noToolRuntimeStateSource, /export function applyReasoningDominatedNoToolRuntimeState/);
  assert.match(noToolRuntimeStateSource, /export function resetEmptyAndReasoningNoToolRuntimeState/);
  assert.match(noToolRuntimeStateSource, /export function applyRecoveringFromEmptyAssistantReplyRuntimeState/);
  assert.match(loopGuardRuntimeStateSource, /export interface AgentLoopGuardRuntimeState/);
  assert.match(loopGuardRuntimeStateSource, /export function createAgentLoopGuardRuntimeState/);
  assert.match(loopGuardRuntimeStateSource, /export function getNoProgressTrackingRuntimeState/);
  assert.match(loopGuardRuntimeStateSource, /export function applyNoProgressTrackingRuntimeState/);
  assert.doesNotMatch(loopGuardRuntimeStateSource, /export function clearCrossIterationReadTrackingForTarget/);
  assert.match(loopGuardRuntimeStateSource, /export function applyToolFailureSignatureRuntimeState/);
  assert.match(toolExecutionRuntimeStateSource, /export interface AgentLoopToolExecutionRuntimeState/);
  assert.match(toolExecutionRuntimeStateSource, /export function createAgentLoopToolExecutionRuntimeState/);
  assert.match(toolExecutionRuntimeStateSource, /getSessionFileReadStates\(sessionKey\)/);
  assert.match(evidenceRuntimeStateSource, /export interface AgentLoopEvidenceRuntimeState/);
  assert.match(evidenceRuntimeStateSource, /export function createAgentLoopEvidenceRuntimeState/);
  assert.match(evidenceRuntimeStateSource, /export function markExecuteOperationEvidenceRuntimeState/);
  assert.match(evidenceRuntimeStateSource, /export function applyRecentSuccessfulProjectWriteRuntimeState/);
  assert.match(evidenceRuntimeStateSource, /export function setLastAssistantTextForCheckpointRuntimeState/);
  assert.match(planReviewRuntimeSource, /export interface PlanReviewRuntimeHandlers/);
  assert.match(planReviewRuntimeSource, /export function createPlanReviewRuntimeHandlers/);
  assert.match(planReviewRuntimeSource, /waitForPlanApprovalIfNeeded/);
  assert.match(planReviewRuntimeSource, /pauseForReviewablePlanArtifact/);
  assert.match(planReviewRuntimeSource, /tryClosePlanWithEvidence/);
  assert.match(planReviewRuntimeSource, /plan_review_ready_after_tool/);
  assert.match(planReviewRuntimeSource, /plan_closure_guard_start/);
  assert.match(planQualityRecoverySource, /PLAN_EXPLORATION_READ_ONLY_TOOLS/);
  assert.match(planQualityRecoverySource, /buildPlanEvidenceRecoveryClosurePrompt/);
  assert.match(planQualityRecoverySource, /buildPlanEvidenceRecoveryBlockedPrompt/);
  assert.doesNotMatch(source, /plan_quality_recovery_action/);
  assert.doesNotMatch(source, /plan_quality_gate_recovery_decision/);
  assert.doesNotMatch(source, /computeDynamicLocalContextLimit/);
  assert.doesNotMatch(source, /loadResolvedInstructions/);
  assert.doesNotMatch(source, /loadHooksConfig/);
  assert.doesNotMatch(source, /runLifecycleHooks/);
  assert.doesNotMatch(source, /runModelProbe/);
  assert.doesNotMatch(source, /createProbeRunner/);
  assert.doesNotMatch(source, /buildTaskTargetingProfile/);
  assert.doesNotMatch(source, /getSessionTaskTargetingEvidence/);
  assert.doesNotMatch(source, /getOriginalUserPromptForPlanFallback/);
  assert.doesNotMatch(source, /buildSystemPrompt/);
  assert.doesNotMatch(source, /skillNameToToolName/);
  assert.doesNotMatch(source, /formatWebResearchLocalDate/);
  assert.doesNotMatch(source, /buildMaxStepsFinalTextPrompt/);
  assert.doesNotMatch(source, /buildChatFinalSynthesisPrompt/);
  assert.doesNotMatch(source, /PolicyFactory/);
  assert.doesNotMatch(source, /filterPlanRuntimeToolDefinitionsForPhase/);
  assert.doesNotMatch(source, /isExecuteRecoveryToolName/);
  assert.doesNotMatch(source, /isApprovedPlanSourceEditFirstTool/);
  assert.doesNotMatch(source, /compactContextForExecuteRecovery/);
  assert.doesNotMatch(source, /computeContextForceReason/);
  assert.doesNotMatch(source, /invokeInitialStreamForIteration/);
  assert.doesNotMatch(source, /buildCompatibilityRetryMessages/);
  assert.doesNotMatch(source, /buildTranscriptCompatibilityRetryMessages/);
  assert.doesNotMatch(source, /ensureProviderCompatibilityMode/);
  assert.doesNotMatch(source, /computeManagedContextLimit/);
  assert.doesNotMatch(source, /prepareMessagesForToolProtocol/);
  assert.doesNotMatch(source, /fetchLLMStream/);
  assert.doesNotMatch(source, /discoverAllMcpTools/);
  assert.doesNotMatch(source, /routeMcpToolsForPrompt/);
  assert.doesNotMatch(source, /buildToolCapabilityRegistry/);
  assert.doesNotMatch(source, /getMcpToolServerMap/);
  assert.doesNotMatch(source, /planRuntimeToolCall/);
  assert.doesNotMatch(source, /shouldBlockToolCallForTargeting/);
  assert.doesNotMatch(source, /buildReadOnlyCacheSignature/);
  assert.doesNotMatch(source, /file_read_cache_hit/);
  assert.doesNotMatch(source, /approved_plan_browser_validation_reused/);
  assert.doesNotMatch(source, /executeReadOnlyToolsConcurrently/);
  assert.doesNotMatch(source, /executeLocalFileReadToolWithReview/);
  assert.doesNotMatch(source, /executeWriteToolWithReview/);
  assert.doesNotMatch(source, /file_read_cache_stored/);
  assert.doesNotMatch(source, /buildToolResultHistoryContentByFormat/);
  assert.doesNotMatch(source, /registerToolExecution/);
  assert.doesNotMatch(source, /createHookContextMessages\("PostToolUse"/);
  assert.doesNotMatch(source, /resolveUnityMcpForcedConsoleResult/);
  assert.doesNotMatch(source, /buildExecutionDigest/);
  assert.doesNotMatch(source, /stage: "after_evidence_reconcile"/);
  assert.doesNotMatch(source, /EVIDENCE_RECONCILE/);
  assert.doesNotMatch(source, /reason: "plan_waiting_for_user_or_summary"/);
  assert.doesNotMatch(source, /reason: "assistant_text_done"/);
  assert.doesNotMatch(source, /logAgentEvent\("reply_options_pause"/);
  assert.doesNotMatch(source, /approvedPlanReadFileRepeatLimit/);
  assert.doesNotMatch(source, /summarizeReadFileRepeatLimitBatch/);
  assert.doesNotMatch(source, /buildReadFileRepeatLimitBatchPauseNotice/);
  assert.doesNotMatch(source, /buildExecuteValidationRecoveryPrompt/);
  assert.doesNotMatch(source, /resolveExecuteReadOnlyRecoveryTrigger/);
  assert.doesNotMatch(source, /resolveReadOnlyNoProgressTrigger/);
  assert.doesNotMatch(source, /isApprovedPlanCachedReadOnlyNoProgressBatch/);
  assert.doesNotMatch(source, /chat_readonly_no_progress_final_synthesis/);
  assert.doesNotMatch(source, /chat_repair_readonly_no_progress_paused/);
  assert.doesNotMatch(source, /no_progress_deferred_to_plan_readonly_convergence/);
  assert.doesNotMatch(source, /cross_iteration_file_read_loop/);
  assert.doesNotMatch(source, /blocked_read_file_recovery_prompt_injected/);
  assert.doesNotMatch(source, /execute_recovery_reset_after_blocked_reads/);
  assert.doesNotMatch(source, /target_progress_mutation_failure/);
  assert.doesNotMatch(source, /target_progress_no_diff_chain/);
  assert.doesNotMatch(source, /formatTargetProgressLoopRecoveryMessage/);
  assert.doesNotMatch(source, /registerTargetProgressEventForLoopGuard/);
  assert.doesNotMatch(source, /PLAN_EXECUTE_CONVERGENCE_PROMPT_RATIO/);
  assert.doesNotMatch(source, /EXECUTE_CONVERGENCE_PROMPT_RATIO/);
  assert.doesNotMatch(source, /buildExecuteConvergencePrompt/);
  assert.doesNotMatch(source, /activateExecuteRecovery\("mutation_first", "execute_convergence_prompt"/);
  assert.doesNotMatch(source, /buildPlanMaxIterationsCheckpoint/);
  assert.doesNotMatch(source, /buildPlanMaxIterationsPauseNotice/);
  assert.doesNotMatch(source, /buildExecuteMaxIterationsPauseNotice/);
  assert.doesNotMatch(source, /logAgentEvent\("max_iterations_checkpoint"/);
  assert.doesNotMatch(source, /logAgentEvent\("execute_max_iterations_checkpoint"/);
  assert.doesNotMatch(source, /buildPlanNoProgressLoopPauseNotice/);
  assert.doesNotMatch(source, /buildApprovedPlanNoProgressStrategySwitchPrompt/);
  assert.doesNotMatch(source, /isStreamWatchdogTimeoutMessage/);
  assert.doesNotMatch(source, /approved_plan_stream_watchdog_paused/);
  assert.doesNotMatch(source, /plan_execution_strategy_switch_reprompt/);
  assert.doesNotMatch(source, /approved_plan_no_tool_recovery_tool_surface/);
  assert.doesNotMatch(source, /approved_plan_reasoning_length_no_action/);
  assert.doesNotMatch(source, /execute_completion_claim_without_evidence/);
  assert.doesNotMatch(source, /execute_replanning_text_without_evidence/);
  assert.doesNotMatch(source, /execute_xml_text_without_action/);
  assert.doesNotMatch(source, /buildExecuteCompletionEvidencePrompt/);
  assert.doesNotMatch(source, /buildExecuteReplanningEvidencePrompt/);
  assert.doesNotMatch(source, /buildExecuteXmlTextActionRecoveryPrompt/);
  assert.doesNotMatch(source, /shouldRecoverExecuteXmlTextWithoutAction/);
  assert.doesNotMatch(source, /missing_tool_reprompt/);
  assert.doesNotMatch(source, /execute_read_only_no_action_checkpoint/);
  assert.doesNotMatch(source, /missing_tool_reprompt_limit/);
  assert.doesNotMatch(source, /resolveMissingToolCallRepromptKind/);
  assert.doesNotMatch(source, /buildExecuteNoActionPauseMessage/);
  assert.doesNotMatch(source, /buildHiddenThoughtOnlyContinuationPrompt/);
  assert.doesNotMatch(source, /plan_structured_proposal_materialized/);
  assert.doesNotMatch(source, /plan_text_materialized/);
  assert.doesNotMatch(source, /plan_text_materialization_rejected/);
  assert.doesNotMatch(source, /plan_recovery_prompt_start/);
  assert.doesNotMatch(source, /plan_refine_long_output/);
  assert.doesNotMatch(source, /force_plan_continuation_limit/);
  assert.doesNotMatch(source, /UNITY_FALLBACK_RECOVERY_READ_ONLY_TOOL_NAMES/);
  assert.doesNotMatch(source, /extractMcpCallFailureCategory/);
  assert.doesNotMatch(source, /shouldRepromptBeforeUnityConsoleFallback/);
  assert.doesNotMatch(source, /shouldTriggerUnityMcpFirstIterationFallback/);
  assert.doesNotMatch(source, /shouldTriggerUnityMcpStrictRetry/);
  assert.doesNotMatch(source, /shouldTriggerPlanReadOnlyConvergence/);
  assert.doesNotMatch(source, /buildPlanReadOnlyConvergencePrompt/);
  assert.doesNotMatch(source, /buildPlanReadOnlyConvergencePause/);
  assert.doesNotMatch(source, /shouldRedirectPlanToolsAfterReadOnlyConvergence/);
  assert.doesNotMatch(source, /shouldRedirectPlanRuntimeToolsAfterReadOnlyConvergence/);
  assert.doesNotMatch(source, /resolvePlanSuppressedToolRecovery/);
  assert.doesNotMatch(source, /buildPlanPostConvergenceToolRedirectPrompt/);
  assert.doesNotMatch(source, /plan_post_convergence_tool_redirect/);
  assert.doesNotMatch(source, /plan_drafting_recovery_read_injected/);
  assert.doesNotMatch(source, /plan_suppressed_tool_recovery_decision/);
  assert.doesNotMatch(source, /plan_suppressed_tool_forced_write_injected/);
});

test("approved plan no-tool turns use evidence recovery, the active contract, then generic no-tool recovery", () => {
  const source = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/AgentOrchestrator.ts"), "utf8");
  const assistantIterationPhaseSource = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/assistantIterationPhase.ts"), "utf8");
  const assistantOutputPhaseSource = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/assistantOutputPhase.ts"), "utf8");
  const assistantCompletionPhaseSource = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/assistantCompletionPhase.ts"), "utf8");
  const approvedPlanNoToolRoutingSource = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/approvedPlanNoToolRouting.ts"), "utf8");
  const executeNoToolRecoverySource = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/executeNoToolRecovery.ts"), "utf8");
  const guardsSource = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/completionGuards.ts"), "utf8");
  const workflowEngine = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/workflowEngine.ts"), "utf8");

  assert.match(assistantOutputPhaseSource, /resolveApprovedPlanNoToolRoute\(\{/);
  assert.match(source, /handleAssistantIterationPhase\(\{/);
  assert.match(assistantIterationPhaseSource, /handleAssistantCompletionPhase\(\{/);
  assert.match(approvedPlanNoToolRoutingSource, /shouldHandleApprovedPlanExecutionNoTool/);
  assert.match(assistantOutputPhaseSource, /approved_plan_no_tool_route/);
  const evidenceAuditIndex = assistantCompletionPhaseSource.indexOf("resolvePreCompletionEvidenceRecoveryDecision({");
  const activeContractIndex = assistantCompletionPhaseSource.indexOf('currentExecuteRecoveryState.mode !== "normal"');
  const genericRecoveryIndex = assistantCompletionPhaseSource.indexOf("handleExecuteNoToolRecovery({");
  assert.ok(evidenceAuditIndex >= 0);
  assert.ok(evidenceAuditIndex < activeContractIndex);
  assert.ok(activeContractIndex < genericRecoveryIndex);
  assert.match(assistantCompletionPhaseSource, /precompletion_evidence_recovery_activated/);
  assert.match(executeNoToolRecoverySource, /required_tool_call_protocol_violation/);
  assert.match(executeNoToolRecoverySource, /availableTools: Array\.from\(availableToolNames\)/);
  assert.match(guardsSource, /approved_plan_completion_guard_no_evidence/);
  assert.match(guardsSource, /return \{ status: "stopped_no_action", reason: "approved_plan_completion_guard" \}/);
  assert.match(workflowEngine, /progress\?\.recoveryReason === "approved_plan_completion_guard_no_evidence"[\s\S]*?"stopped_no_action"/);
  assert.match(workflowEngine, /const stopBlock = \{/);
  assert.match(workflowEngine, /type: "system"/);
  assert.match(workflowEngine, /content: message/);
  assert.match(workflowEngine, /variant: "execution_checkpoint"/);
  assert.match(workflowEngine, /planExecutionProgress: progress/);
  assert.match(workflowEngine, /summary: message/);
});

test("approved plan max-iteration boundary pauses instead of surfacing agent error", () => {
  const source = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/AgentOrchestrator.ts"), "utf8");
  const maxIterationBoundarySource = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/maxIterationBoundary.ts"), "utf8");
  const checkpointIndex = maxIterationBoundarySource.indexOf("if (isPlanBoundary && !handling.handled)");
  const branch = maxIterationBoundarySource.slice(checkpointIndex, checkpointIndex + 2200);

  assert.match(source, /handleMaxIterationBoundary\(\{/);
  assert.notEqual(checkpointIndex, -1);
  assert.match(branch, /emitPlanExecutionProgress\("paused"/);
  assert.match(branch, /callbacks\.onNonActionableStop\(/);
  assert.match(branch, /recoveryReason:\s*"plan_max_iterations_checkpoint"/);
  assert.match(branch, /"incomplete_plan"/);
  assert.doesNotMatch(branch, /callbacks\.onError\(buildPlanMaxIterationsPauseNotice/);
});

test("explicit reply options mark assistant text as awaiting input even when tool calls coexist", () => {
  const workflowEngine = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/workflowEngine.ts"), "utf8");
  const assistantOutputPhaseSource = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/assistantOutputPhase.ts"), "utf8");
  const runnerSource = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/AgentLoopRunner.ts"), "utf8");

  assert.match(assistantOutputPhaseSource, /awaitingInput:\s*shouldPauseForUserChoice/);
  assert.match(runnerSource, /onAssistantFinalText: \(text, replyOptions = \[\], meta\) =>/);
  assert.match(runnerSource, /status: "paused", reason: "awaiting_user_choice"/);
  assert.match(runnerSource, /agent_loop_awaiting_user_choice/);
  assert.match(workflowEngine, /const awaitingInput = meta\?\.awaitingInput === true && replyOptions\.length > 0/);
  assert.match(workflowEngine, /status:\s*"awaiting_input"/);
  assert.match(workflowEngine, /agentStatus:\s*"idle"[\s\S]*?isGenerating:\s*false/);
});

test("agent loop blocks execute completion without execution evidence", () => {
  const source = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/AgentOrchestrator.ts"), "utf8");
  const runnerSource = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/AgentLoopRunner.ts"), "utf8");
  const guardsSource = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/completionGuards.ts"), "utf8");
  const toolActivityTrackingSource = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/toolActivityTracking.ts"), "utf8");
  const toolIterationPhaseSource = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/toolIterationPhase.ts"), "utf8");
  const toolCallExecutionPhaseSource = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/toolCallExecutionPhase.ts"), "utf8");
  const toolResultPostProcessingSource = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/toolResultPostProcessing.ts"), "utf8");
  const orchestrator = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator.ts"), "utf8");
  const workflowEngine = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/workflowEngine.ts"), "utf8");

  assert.match(guardsSource, /completionEvidenceRequired !== "execution_evidence"/);
  assert.match(guardsSource, /sawExecutionEvidence/);
  assert.match(runnerSource, /sawExecutionEvidence: orchestrator\.hasExecuteOperationEvidence\(\)/);
  assert.match(guardsSource, /execute_completion_outcome_without_evidence/);
  assert.match(guardsSource, /"execution_evidence_required"/);
  assert.match(source, /handleToolIterationPhase\(\{/);
  assert.match(source, /markExecuteOperationEvidence/);
  assert.match(toolIterationPhaseSource, /executeToolCallPhase\(input\)/);
  assert.match(toolCallExecutionPhaseSource, /handleToolResultPostProcessing\(\{/);
  assert.match(toolCallExecutionPhaseSource, /markExecuteOperationEvidence: markExecuteOperationEvidenceAndSync/);
  assert.match(
    toolCallExecutionPhaseSource,
    /evidenceRuntimeState = markExecuteOperationEvidenceRuntimeState\(/,
  );
  assert.match(toolResultPostProcessingSource, /toolResultCountsAsExecutionEvidence/);
  assert.match(toolResultPostProcessingSource, /markExecuteOperationEvidence/);
  assert.match(toolActivityTrackingSource, /parseToolFeedbackEnvelope/);
  assert.match(toolActivityTrackingSource, /feedbackStatus === "no_op"/);
  assert.match(toolActivityTrackingSource, /feedbackStatus === "no_effect_mutation"/);
  assert.match(toolActivityTrackingSource, /already matched requested content/);
  assert.match(toolActivityTrackingSource, /commandResultLooksSuccessful/);
  assert.match(toolActivityTrackingSource, /browserResultLooksSuccessful/);
  assert.match(toolActivityTrackingSource, /export function rememberToolActivity/);
  assert.match(toolActivityTrackingSource, /export function isEditProgressResult/);
  assert.match(toolActivityTrackingSource, /export function isVerificationEvidenceResult/);
  assert.match(orchestrator, /export function isProjectSourceWriteResult/);
  assert.match(orchestrator, /"noOp"\\s\*:\\s\*true\|NO_EFFECT_MUTATION/);
  assert.match(workflowEngine, /getExecutionConsentGranted/);
  assert.match(workflowEngine, /currentTurnExecutionConsent/);
});

test("workflow engine owns one hidden auto-resume at max-iteration checkpoints", () => {
  const source = fsSync.readFileSync(
    path.join(workspaceRoot, "src/lib/orchestrator/workflowEngine.ts"),
    "utf8",
  );
  const planStart = source.indexOf("onPlanMaxIterationsCheckpoint:");
  const executeStart = source.indexOf("onExecuteMaxIterationsCheckpoint:", planStart);
  const handlersEnd = source.indexOf("onStatusChange:", executeStart);
  const planHandler = source.slice(planStart, executeStart);
  const executeHandler = source.slice(executeStart, handlersEnd);
  const terminalStart = source.indexOf("const queuedAfterRun =", handlersEnd);
  const terminalEnd = source.indexOf("return true;", terminalStart);
  const terminalContinuation = source.slice(terminalStart, terminalEnd);

  assert.notEqual(planStart, -1);
  assert.notEqual(executeStart, -1);
  assert.notEqual(handlersEnd, -1);
  for (const handler of [planHandler, executeHandler]) {
    assert.match(handler, /currentCount < PLAN_MAX_AUTO_RESUME_LIMIT/);
    assert.match(handler, /planAutoResumeCount: effectiveCheckpoint\.autoResumeCount/);
    assert.match(handler, /turn\.id === turnId \|\| turn\.id === context\.uiDisplayTurnId/);
    assert.match(handler, /pendingMaxIterationsAutoResume = \{/);
    assert.match(handler, /status: "auto_resume_scheduled" as const/);
    assert.match(handler, /hidden: true/);
    assert.match(handler, /reuseCurrentTurn: true/);
    assert.match(handler, /turnIdOverride: context\.uiDisplayTurnId \|\| turnId/);
    assert.match(handler, /parentRunIdOverride: activeRuntimeRunIdentity\.runId/);
    assert.match(handler, /preservePlanState: true/);
    assert.match(handler, /cancelAutoResume\("resume_submission_rejected", \{ visible: true \}\)/);
    assert.match(handler, /type: "system",\s*content: pauseNotice,/);
  }
  assert.match(planHandler, /buildPlanMaxIterationsResumePrompt/);
  assert.match(planHandler, /resolvedIntent: "execute"/);
  assert.doesNotMatch(planHandler, /runtimeIntentOverride/);
  assert.match(planHandler, /executionConsentGranted: true/);
  assert.match(executeHandler, /buildExecuteMaxIterationsResumePrompt/);
  assert.doesNotMatch(executeHandler, /runtimeIntentOverride/);
  assert.match(executeHandler, /resolveExecuteMaxIterationsRecoveryDecision/);
  assert.match(
    executeHandler,
    /scopeExecutionEvidenceLedger\(\s*executeEvidenceLedger,\s*turnId,?\s*\)/,
  );
  assert.match(executeHandler, /transactionId: turnId/);
  assert.match(executeHandler, /\[\.\.\.scopedExecuteEvidenceLedger\]\.reverse\(\)/);
  assert.match(executeHandler, /forceExecuteRecoveryMode: executeRecoveryDecision\.mode/);
  assert.match(executeHandler, /forceExecuteRecoveryState: forcedExecuteRecoveryState/);
  assert.match(executeHandler, /latestExecuteRecoveryState\?\.expectedTarget/);
  assert.match(executeHandler, /readLease: latestExecuteRecoveryState\?\.readLease \|\| null/);
  assert.match(executeHandler, /sourceObservationKey: latestExecuteRecoveryState\?\.sourceObservationKey \|\| null/);
  assert.match(executeHandler, /phaseNoProgressCount: recoveryPhaseChanged/);
  assert.doesNotMatch(executeHandler, /forceExecuteRecoveryMode: "action_plus_targeting"/);
  assert.match(executeHandler, /executionConsentGranted: true/);
  assert.notEqual(terminalStart, -1);
  assert.notEqual(terminalEnd, -1);
  assert.match(
    terminalContinuation,
    /pendingMaxIterationsAutoResume && \(pendingSameTurnExecution \|\| queuedAfterRun\)/,
  );
  assert.match(terminalContinuation, /queued_user_message_deferred/);
  assert.doesNotMatch(terminalContinuation, /queued_user_message_force_idle/);
  assert.match(terminalContinuation, /queued_user_message_submission_rejected/);
  assert.ok(
    terminalContinuation.indexOf("started = latest.sendMessage(") <
      terminalContinuation.indexOf("queuedUserMessage: null"),
  );
  assert.match(
    terminalContinuation,
    /else if \(pendingMaxIterationsAutoResume\)[\s\S]*?runAfterNextPaint\(\(\) => pending\.start\(\)\)/,
  );
});

test("ordinary composer sends only reuse awaiting-choice turns on exact option match", () => {
  const storeSource = fsSync.readFileSync(path.join(workspaceRoot, "src/store/useAppStore.ts"), "utf8");
  const turnSubmissionSource = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/submit/turnSubmission.ts"), "utf8");
  const submitRuntimeFacadeSource = fsSync.readFileSync(path.join(workspaceRoot, "src/store/submitRuntimeFacade.ts"), "utf8");
  const submitSessionRuntimeControllerSource = fsSync.readFileSync(path.join(workspaceRoot, "src/store/submitSessionRuntimeController.ts"), "utf8");
  const submitPreflightExecutorSource = fsSync.readFileSync(path.join(workspaceRoot, "src/store/submitPreflightExecutor.ts"), "utf8");
  const submitPlanHydrationSource = fsSync.readFileSync(path.join(workspaceRoot, "src/store/submitPlanHydration.ts"), "utf8");
  const submitPlanExecutionResumeSource = fsSync.readFileSync(path.join(workspaceRoot, "src/store/submitPlanExecutionResume.ts"), "utf8");
  const submitPendingReviewTransitionSource = fsSync.readFileSync(path.join(workspaceRoot, "src/store/submitPendingReviewTransition.ts"), "utf8");
  const submitPlanStateResetSource = fsSync.readFileSync(path.join(workspaceRoot, "src/store/submitPlanStateReset.ts"), "utf8");
  const submitSendGateEffectsSource = fsSync.readFileSync(path.join(workspaceRoot, "src/store/submitSendGateEffects.ts"), "utf8");
  const submitIntentRoutingSource = fsSync.readFileSync(path.join(workspaceRoot, "src/store/submitIntentRouting.ts"), "utf8");
  const submitAsyncWorkflowRunSource = fsSync.readFileSync(path.join(workspaceRoot, "src/store/submitAsyncWorkflowRun.ts"), "utf8");
  const submitAttachmentContextSource = fsSync.readFileSync(path.join(workspaceRoot, "src/store/submitAttachmentContext.ts"), "utf8");
  const submitPromptContextSource = fsSync.readFileSync(path.join(workspaceRoot, "src/store/submitPromptContext.ts"), "utf8");
  const submitApprovedPlanExecutionSource = fsSync.readFileSync(path.join(workspaceRoot, "src/store/submitApprovedPlanExecution.ts"), "utf8");
  const submitSessionBootstrapSource = fsSync.readFileSync(path.join(workspaceRoot, "src/store/submitSessionBootstrap.ts"), "utf8");
  const submitTurnDraftSource = fsSync.readFileSync(path.join(workspaceRoot, "src/store/submitTurnDraft.ts"), "utf8");
  const submitVisibleTurnSource = fsSync.readFileSync(path.join(workspaceRoot, "src/store/submitVisibleTurn.ts"), "utf8");
  const submitRunLeaseSource = fsSync.readFileSync(path.join(workspaceRoot, "src/store/submitRunLease.ts"), "utf8");
  const submitTitleEffectsSource = fsSync.readFileSync(path.join(workspaceRoot, "src/store/submitTitleEffects.ts"), "utf8");
  const submitWorkflowContextSource = fsSync.readFileSync(path.join(workspaceRoot, "src/store/submitWorkflowContext.ts"), "utf8");
  const submitStreamingUiSource = fsSync.readFileSync(path.join(workspaceRoot, "src/store/submitStreamingUi.ts"), "utf8");
  const submitWorkflowEngineRunnerSource = fsSync.readFileSync(path.join(workspaceRoot, "src/store/submitWorkflowEngineRunner.ts"), "utf8");
  const gameStudioLocalSlashBridgeSource = fsSync.readFileSync(path.join(workspaceRoot, "src/store/gameStudioLocalSlashBridge.ts"), "utf8");
  const gameStudioTurnPreparationSource = fsSync.readFileSync(path.join(workspaceRoot, "src/store/gameStudioTurnPreparation.ts"), "utf8");
  const submitGameStudioPreparationSource = fsSync.readFileSync(path.join(workspaceRoot, "src/store/submitGameStudioPreparation.ts"), "utf8");
  const gameStudioLocalSlashSubmissionSource = fsSync.readFileSync(path.join(workspaceRoot, "src/store/gameStudioLocalSlashSubmission.ts"), "utf8");
  const workflowEngineSource = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/workflowEngine.ts"), "utf8");

  assert.match(turnSubmissionSource, /export function findReplyOptionMatchingSelectedText/);
  assert.match(turnSubmissionSource, /export function buildSubmitInputEnvelope/);
  assert.match(turnSubmissionSource, /export function buildSubmitPipelineDecision/);
  assert.match(turnSubmissionSource, /export function buildSubmitIntentConfirmationPendingDecision/);
  assert.match(turnSubmissionSource, /export function resolveSubmitTurnReuseDecision/);
  assert.match(turnSubmissionSource, /export function resolveSubmitEffectiveIntentDecision/);
  assert.match(turnSubmissionSource, /export function resolveSubmitRuntimeDecision/);
  assert.match(turnSubmissionSource, /export function resolveSubmitSendGateDecision/);
  assert.match(turnSubmissionSource, /export function buildSubmitSessionBootstrapDecision/);
  assert.match(turnSubmissionSource, /export function buildSubmitSessionBootstrapPatch/);
  assert.match(turnSubmissionSource, /export function resolveSubmitTurnTitleDecision/);
  assert.match(turnSubmissionSource, /export function buildSubmitLocalStudioTurnPatch/);
  assert.match(turnSubmissionSource, /export function buildSubmitRunStatePatch/);
  assert.match(turnSubmissionSource, /export function buildSubmitBlockingPreflightEffect/);
  assert.match(turnSubmissionSource, /export function resolveSubmitPreflightStalenessDecision/);
  assert.match(turnSubmissionSource, /export function resolveSubmitPreflightEffectAction/);
  assert.match(turnSubmissionSource, /export function buildSubmitPreflightResumeOptions/);
  assert.match(turnSubmissionSource, /export function buildSubmitVisibleTurnPatch/);
  assert.match(turnSubmissionSource, /export function resolveSubmitSemanticMetadataDecision/);
  assert.match(turnSubmissionSource, /export function buildSubmitHarnessRunMarkerDraft/);
  assert.match(submitRuntimeFacadeSource, /export function createSubmitPreRunSessionPatcher/);
  assert.match(submitRuntimeFacadeSource, /export function createSubmitSessionRuntimeFacade/);
  assert.match(submitRuntimeFacadeSource, /export function startSubmitElapsedTimer/);
  assert.match(submitSessionRuntimeControllerSource, /export function createSubmitSessionRuntimeController/);
  assert.match(submitSessionRuntimeControllerSource, /plan_artifact_rejected_by_quality_gate/);
  assert.match(submitSessionRuntimeControllerSource, /setConversationTurnStatus: sessionSetConversationTurnStatus/);
  assert.match(submitPreflightExecutorSource, /export async function executeSubmitBlockingPreflight/);
  assert.match(submitPreflightExecutorSource, /export function startSubmitBlockingPreflightEffect/);
  assert.match(submitPreflightExecutorSource, /applyPreRunSessionPatch\(\{ pendingRunDecision \}\)/);
  assert.match(submitPlanHydrationSource, /export async function runSubmitPlanHydrationEffect/);
  assert.match(submitPlanHydrationSource, /export function startSubmitPlanHydrationEffect/);
  assert.match(submitPlanHydrationSource, /shouldPromoteHydratedPlanToExecuting/);
  assert.match(submitPlanHydrationSource, /send_async_resume_skipped_inactive_session/);
  assert.match(submitPlanExecutionResumeSource, /export async function runSubmitPlanExecutionResumeEffect/);
  assert.match(submitPlanExecutionResumeSource, /export function buildTrustedPlanResumePrompt/);
  assert.match(submitPlanExecutionResumeSource, /existing_plan_hydrated_for_execution/);
  assert.match(submitPlanExecutionResumeSource, /createVisibleTurnForHiddenMessage:\s*!continuationTurnId/);
  assert.match(submitPlanExecutionResumeSource, /reuseCurrentTurn:\s*!!continuationTurnId/);
  assert.match(submitPendingReviewTransitionSource, /export function applySubmitPendingReviewTransition/);
  assert.match(submitPendingReviewTransitionSource, /resolvePendingReviewSubmissionDecision/);
  assert.match(submitPendingReviewTransitionSource, /send_pending_review_abort_and_new_turn/);
  assert.match(submitPendingReviewTransitionSource, /stopped_no_action/);
  assert.match(submitPlanStateResetSource, /export function applySubmitPlanStateReset/);
  assert.match(submitPlanStateResetSource, /planExecutionEvidenceLedger: \[\]/);
  assert.match(submitPlanStateResetSource, /currentTurnExecutionConsent: \{ turnId: null, granted: false \}/);
  assert.match(submitSendGateEffectsSource, /export function applySubmitSendGateEffects/);
  assert.match(submitSendGateEffectsSource, /resolveSubmitSendGateDecision/);
  assert.match(submitSendGateEffectsSource, /send_busy_hidden_execution_rejected/);
  assert.match(submitSendGateEffectsSource, /send_stuck_state_reset/);
  assert.match(submitIntentRoutingSource, /export function resolveAndApplySubmitIntentRouting/);
  assert.match(submitIntentRoutingSource, /resolveSubmitEffectiveIntentDecision/);
  assert.match(submitIntentRoutingSource, /resolveSubmitExecutionApprovalDecision/);
  assert.match(submitIntentRoutingSource, /buildSubmitBlockingPreflightEffect/);
  assert.match(submitIntentRoutingSource, /intent_decision_suppressed_for_same_input/);
  assert.match(submitAsyncWorkflowRunSource, /export async function runSubmitAsyncWorkflowRun/);
  assert.match(submitAsyncWorkflowRunSource, /await \(phaseRunners\.buildAttachmentContext \|\| buildSubmitAttachmentContext\)/);
  assert.match(submitAsyncWorkflowRunSource, /\(phaseRunners\.buildPromptContext \|\| buildSubmitPromptContext\)/);
  assert.match(submitAsyncWorkflowRunSource, /await \(phaseRunners\.runGameStudioPreparation \|\| runSubmitGameStudioPreparation\)/);
  assert.match(submitAsyncWorkflowRunSource, /\(phaseRunners\.startRunLease \|\| startSubmitRunLease\)/);
  assert.match(submitAsyncWorkflowRunSource, /void \(phaseRunners\.runWorkflowEngine \|\| runSubmitWorkflowEngine\)/);
  assert.match(submitAttachmentContextSource, /export async function buildSubmitAttachmentContext/);
  assert.match(submitAttachmentContextSource, /export async function prepareAttachedFileForRead/);
  assert.match(submitAttachmentContextSource, /\[attached_tabular_file\]/);
  assert.match(submitAttachmentContextSource, /\[user_mentioned_files\]/);
  assert.match(submitPromptContextSource, /export function buildSubmitPromptContext/);
  assert.match(submitPromptContextSource, /export function buildOperationApprovalContinuationPrompt/);
  assert.match(submitPromptContextSource, /Continue the previous PLAN turn/);
  assert.match(submitPromptContextSource, /The user approved real operations/);
  assert.match(submitApprovedPlanExecutionSource, /export function buildApprovedPlanExecutionPrompt/);
  assert.match(submitApprovedPlanExecutionSource, /export function ensureApprovedPlanRuntimeTasksForState/);
  assert.match(submitApprovedPlanExecutionSource, /export function normalizeApprovedPlanTaskStatuses/);
  assert.match(submitApprovedPlanExecutionSource, /The plan is approved/);
  assert.match(submitSessionBootstrapSource, /export function applySubmitSessionBootstrap/);
  assert.match(submitSessionBootstrapSource, /buildSubmitSessionBootstrapDecision/);
  assert.match(submitSessionBootstrapSource, /buildSubmitSessionBootstrapPatch/);
  assert.match(submitTurnDraftSource, /export function prepareSubmitTurnDraft/);
  assert.match(submitTurnDraftSource, /buildUserContextItems/);
  assert.match(submitTurnDraftSource, /resolveSubmitTurnTitleDecision/);
  assert.match(submitVisibleTurnSource, /export function applySubmitVisibleTurn/);
  assert.match(submitVisibleTurnSource, /buildSubmitVisibleTurnPatch/);
  assert.match(submitVisibleTurnSource, /buildSubmitRunStatePatch/);
  assert.match(submitVisibleTurnSource, /export function markSubmitUserContextItemFailed/);
  assert.match(submitRunLeaseSource, /export function startSubmitRunLease/);
  assert.match(submitRunLeaseSource, /buildSubmitHarnessRunMarkerDraft/);
  assert.match(submitTitleEffectsSource, /export function applySubmitSeedSessionTitle/);
  assert.match(submitTitleEffectsSource, /export function startSubmitSemanticMetadataEffect/);
  assert.match(submitWorkflowContextSource, /export function createSubmitWorkflowContext/);
  assert.match(submitWorkflowContextSource, /agentBlockIdsCreatedThisRun: new Set<number>/);
  assert.match(submitStreamingUiSource, /export function startSubmitStreamingUi/);
  assert.match(submitStreamingUiSource, /new StreamingCadenceBuffer/);
  assert.match(submitStreamingUiSource, /resolveStreamingAssistantDisplay/);
  assert.match(submitWorkflowEngineRunnerSource, /export function createSubmitWorkflowEngineHelpers/);
  assert.match(submitWorkflowEngineRunnerSource, /export function runSubmitWorkflowEngine/);
  assert.match(submitWorkflowEngineRunnerSource, /new WorkflowEngine/);
  assert.match(gameStudioLocalSlashBridgeSource, /export function createGameStudioLocalSlashBridge/);
  assert.match(gameStudioLocalSlashBridgeSource, /buildSubmitLocalStudioTurnPatch/);
  assert.match(gameStudioLocalSlashBridgeSource, /buildLocalSlashRuntimeSnapshot/);
  assert.match(gameStudioTurnPreparationSource, /export async function prepareGameStudioTurn/);
  assert.match(submitGameStudioPreparationSource, /export async function runSubmitGameStudioPreparation/);
  assert.match(submitGameStudioPreparationSource, /export function applySubmitGameStudioPreparationResult/);
  assert.match(submitGameStudioPreparationSource, /pendingSlashCommand: null/);
  assert.match(submitGameStudioPreparationSource, /shouldInvalidateWorkspaceTree/);
  assert.match(gameStudioLocalSlashSubmissionSource, /export function startGameStudioLocalSlashSubmission/);
  assert.match(
    turnSubmissionSource,
    /const selectedAwaitingReplyOption = choiceIdentityMatches/,
  );
  assert.match(
    turnSubmissionSource,
    /const shouldAutoResumeChoiceTurn =[\s\S]*?currentTurnHasReplyOptions &&[\s\S]*?choiceIdentityMatches &&[\s\S]*?!!selectedAwaitingReplyOption;/,
  );
  assert.match(turnSubmissionSource, /isMatchingUserChoiceResolution\(\{/);
  assert.match(turnSubmissionSource, /replyOptionRequestIdentity\?: UserChoiceResolutionIdentity/);
  assert.doesNotMatch(
    turnSubmissionSource,
    /const shouldAutoResumeChoiceTurn =[\s\S]{0,260}\(currentTurn\.status === "awaiting_input" \|\| currentTurnHasReplyOptions\)/,
  );
  assert.match(storeSource, /const submitPipelineDecision = buildSubmitPipelineDecision/);
  assert.match(storeSource, /const intentRouting = resolveAndApplySubmitIntentRouting/);
  assert.doesNotMatch(storeSource, /buildSubmitIntentConfirmationPendingDecision\(\{/);
  assert.doesNotMatch(storeSource, /createPendingDecisionCopy/);
  assert.match(storeSource, /const pendingReviewTransition = applySubmitPendingReviewTransition/);
  assert.doesNotMatch(storeSource, /send_pending_review_abort_and_new_turn/);
  assert.match(storeSource, /const applyPreRunSessionPatch = createSubmitPreRunSessionPatcher<AppState, SessionRuntimeState>/);
  assert.doesNotMatch(
    storeSource,
    /const applyPreRunSessionPatch = \(patch:[\s\S]{0,600}runtimeBySessionKey/,
  );
  assert.match(storeSource, /applySubmitPlanStateReset\(\{/);
  assert.ok(
    storeSource.lastIndexOf("const sendGateEffect = applyCurrentSendGate(state)") <
      storeSource.lastIndexOf("applySubmitPlanStateReset({"),
    "Plan state must only reset after the send gate grants the run lease so queued Goal source context stays durable",
  );
  assert.match(
    workflowEngineSource,
    /goalSourceContextSnapshot:\s*queuedAfterRun\.goalSourceContextSnapshot/,
    "Dequeued Goal submissions must reuse the immutable source snapshot captured while they were queued",
  );
  assert.doesNotMatch(
    storeSource,
    /if \(runtimeDecision\.shouldResetPlanState\)[\s\S]{0,500}planExecutionEvidenceLedger/,
  );
  assert.match(storeSource, /const applyCurrentSendGate = \([\s\S]*?\) => applySubmitSendGateEffects/);
  assert.ok(
    storeSource.indexOf("const planResumeSendGateEffect = applyCurrentSendGate(state)") <
      storeSource.indexOf("const intentRouting = resolveAndApplySubmitIntentRouting"),
    "Plan resume must pass the owner gate before async intent routing mutates state",
  );
  assert.doesNotMatch(storeSource, /const sendGateDecision = resolveSubmitSendGateDecision/);
  assert.doesNotMatch(storeSource, /send_stuck_state_reset/);
  assert.match(storeSource, /startSubmitPlanHydrationEffect\(\{/);
  assert.match(storeSource, /runSubmitPlanExecutionResumeEffect\(\{/);
  assert.doesNotMatch(storeSource, /const shouldPromoteToExecuting = shouldPromoteHydratedPlanToExecuting/);
  assert.doesNotMatch(storeSource, /function buildTrustedPlanResumePrompt/);
  assert.doesNotMatch(storeSource, /existing_plan_hydrated_for_execution/);
  assert.match(storeSource, /void startSubmitAsyncWorkflowRun\(\{/);
  assert.doesNotMatch(storeSource, /const attachmentContext = await buildSubmitAttachmentContext/);
  assert.doesNotMatch(storeSource, /\[attached_tabular_file\]/);
  assert.doesNotMatch(storeSource, /prepareAttachedFileForRead/);
  assert.doesNotMatch(storeSource, /userContent = buildSubmitPromptContext\(\{/);
  assert.doesNotMatch(storeSource, /Continue the previous PLAN turn/);
  assert.doesNotMatch(storeSource, /The user approved real operations/);
  assert.match(storeSource, /buildApprovedPlanExecutionPrompt\(\{/);
  assert.match(storeSource, /ensureApprovedPlanRuntimeTasksForState\(state, language\)/);
  assert.doesNotMatch(storeSource, /The plan is approved\. Continue directly/);
  assert.doesNotMatch(storeSource, /function buildPlanCommandExecutionHint/);
  assert.match(storeSource, /const inputEnvelope = buildSubmitInputEnvelope\(\{/);
  assert.doesNotMatch(storeSource, /const preParsedStudioCommand =/);
  assert.doesNotMatch(storeSource, /const initialIntentDecision = resolveSubmitEffectiveIntentDecision/);
  assert.match(storeSource, /const runtimeDecision = resolveSubmitRuntimeDecision/);
  assert.match(storeSource, /const sessionBootstrapDecision = applySubmitSessionBootstrap/);
  assert.match(storeSource, /const turnDraft = prepareSubmitTurnDraft\(\{/);
  assert.doesNotMatch(storeSource, /const titleDecision = resolveSubmitTurnTitleDecision/);
  assert.doesNotMatch(storeSource, /buildUserContextItems\(\{/);
  assert.match(storeSource, /const localSlashBridge = createGameStudioLocalSlashBridge/);
  assert.doesNotMatch(storeSource, /buildSubmitLocalStudioTurnPatch/);
  assert.match(storeSource, /const visibleTurnSubmission = applySubmitVisibleTurn/);
  assert.doesNotMatch(storeSource, /buildSubmitRunStatePatch/);
  assert.doesNotMatch(storeSource, /buildSubmitVisibleTurnPatch/);
  assert.match(storeSource, /void startSubmitBlockingPreflightEffect\(\{/);
  assert.doesNotMatch(storeSource, /const blockingPreflightEffect = buildSubmitBlockingPreflightEffect/);
  assert.doesNotMatch(storeSource, /await executeSubmitBlockingPreflight/);
  assert.match(storeSource, /const semanticMetadataDecision = resolveSubmitSemanticMetadataDecision/);
  assert.match(storeSource, /startSubmitSemanticMetadataEffect/);
  assert.doesNotMatch(storeSource, /const runLease = startSubmitRunLease/);
  assert.doesNotMatch(storeSource, /const context = createSubmitWorkflowContext/);
  assert.doesNotMatch(storeSource, /startSubmitStreamingUi\(\{/);
  assert.doesNotMatch(storeSource, /void runSubmitWorkflowEngine\(\{/);
  assert.match(submitAsyncWorkflowRunSource, /const runLease = \(phaseRunners\.startRunLease \|\| startSubmitRunLease\)/);
  assert.match(submitAsyncWorkflowRunSource, /const context = \(phaseRunners\.createWorkflowContext \|\| createSubmitWorkflowContext\)/);
  assert.match(submitAsyncWorkflowRunSource, /\(phaseRunners\.startStreamingUi \|\| startSubmitStreamingUi\)\(\{/);
  assert.match(submitAsyncWorkflowRunSource, /void \(phaseRunners\.runWorkflowEngine \|\| runSubmitWorkflowEngine\)/);
  assert.doesNotMatch(storeSource, /new WorkflowEngine/);
  assert.match(storeSource, /createSubmitSessionRuntimeController<AppState, SessionRuntimeState>/);
  assert.doesNotMatch(storeSource, /const sessionSetConversationTurnStatus/);
  assert.match(storeSource, /const elapsedTimer = startSubmitElapsedTimer/);
  assert.doesNotMatch(storeSource, /const gameStudioPreparation = await runSubmitGameStudioPreparation/);
  assert.match(submitAsyncWorkflowRunSource, /const gameStudioPreparation = await \(phaseRunners\.runGameStudioPreparation \|\| runSubmitGameStudioPreparation\)/);
  assert.doesNotMatch(storeSource, /content: gameStudioPreparation\.errorMessage/);
  assert.doesNotMatch(storeSource, /gameStudioPreparation\.shouldInvalidateWorkspaceTree/);
  assert.match(storeSource, /const localSlashSubmission = startGameStudioLocalSlashSubmission/);
  assert.match(turnSubmissionSource, /params\.shouldExplicitlyReuseCurrentTurn \|\| params\.shouldAutoResumeChoiceTurn/);
  assert.match(turnSubmissionSource, /params\.currentTurnHasReplyOptions/);
  assert.match(
    turnSubmissionSource,
    /shouldReuseExistingTurnIntent \? currentTurnIntent : fallbackRunIntent/,
  );
  assert.match(
    storeSource,
    /fallbackRunIntent: resolveRunIntentFromLegacyWorkflowMode\(state\.config\.workflowMode\)/,
  );
  assert.doesNotMatch(
    storeSource,
    /\(\(preservePlanState \|\| shouldReuseExistingTurnIntent\)[\s\S]{0,120}\? currentTurnIntent/,
  );
});

test("debug log compacts repeated prompt and tool payloads instead of storing raw blobs", () => {
  const source = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/debugLog.ts"), "utf8");

  assert.match(source, /function compactDebugString/);
  assert.match(source, /stableDebugHash/);
  assert.match(source, /function summarizeMessageArray/);
  assert.match(source, /hiddenReasoningChars/);
  assert.match(source, /largestMessages/);
  assert.match(source, /function summarizeToolResultLike/);
  assert.match(source, /feedbackStatus/);
  assert.match(source, /contentHash/);
  assert.match(source, /READ_FILE_RESULT\[\\s\\S\]\{300,\}/);
  assert.match(source, /messages\|agentMessages\|preparedMessages/);
  assert.match(source, /names: nested/);
  assert.match(source, /<chars:\$\{normalized\.length\};hash:/);
  assert.match(source, /const compacted = compactDebugValue\(input\)/);
  assert.match(source, /redacted\.length > 8_000/);
  assert.match(source, /function isSecretDebugKey/);
  assert.match(source, /SECRET_DEBUG_KEYS/);
  assert.doesNotMatch(source, /if \(\/authorization\|api\[-_\]\?key\|x-api-key\|token\|password\|secret\/i\.test\(key\)\)/);
  assert.match(source, /source === "agent\.plan_runtime_tool_scope_applied"/);
  assert.match(source, /source === "delegation_scope_decision"/);
});

test("global plan toolbar button is driven by live plan workspace, not historical plan turns", () => {
  const chatAreaSource = fsSync.readFileSync(path.join(workspaceRoot, "src/components/ChatArea.tsx"), "utf8");
  const storeSource = fsSync.readFileSync(path.join(workspaceRoot, "src/store/useAppStore.ts"), "utf8");

  assert.match(chatAreaSource, /hasLivePlanWorkspace/);
  assert.match(chatAreaSource, /const activePlanFallbackPreview = useMemo/);
  assert.match(chatAreaSource, /extractStructuredPlanProposal/);
  assert.match(chatAreaSource, /extractPlanDraftPreview/);
  assert.match(chatAreaSource, /const hasLivePlanWorkspaceContent = useMemo\(\(\) => hasLivePlanWorkspace/);
  assert.match(chatAreaSource, /fallbackPlanPreview:\s*activePlanFallbackPreview/);
  assert.match(chatAreaSource, /\{hasLivePlanWorkspaceContent && \(/);
  assert.doesNotMatch(chatAreaSource, /const hasPlanPanelContent = useMemo/);
  assert.doesNotMatch(chatAreaSource, /groupedTurns\.some\(\(entry\)[\s\S]{0,220}hasGeneratedPlanContent\(entry\.blocks\)[\s\S]{0,220}\{hasPlanPanelContent && \(/);

  assert.match(storeSource, /clearPlanArtifacts:\s*\(\) =>\s*set\(\(s\) =>/);
  assert.match(storeSource, /rightPanelTab:\s*nextRightPanelTab/);
  assert.match(storeSource, /s\.rightPanelTab === "plan" \? "terminal"/);
  assert.match(storeSource, /logStoreEvent\("planWorkspaceStateChanged"/);
  assert.match(storeSource, /logStoreEvent\("planFilesCleared"/);
});

test("approved plan execution stays in one logical turn and has one runtime owner", () => {
  const storeSource = fsSync.readFileSync(path.join(workspaceRoot, "src/store/useAppStore.ts"), "utf8");
  const sessionTypesSource = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/sessionTypes.ts"), "utf8");
  const workflowEngineSource = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/workflowEngine.ts"), "utf8");
  const approvePlanMethod = storeSource.slice(
    storeSource.indexOf("approvePlan: (approvalChoice, expectedIdentity) =>"),
    storeSource.indexOf("rejectPlan: (expectedIdentity) =>", storeSource.indexOf("approvePlan: (approvalChoice, expectedIdentity) =>")),
  );

  assert.match(sessionTypesSource, /export interface PlanApprovalHandoff/);
  assert.match(storeSource, /PlanApprovalHandoff/);
  assert.match(storeSource, /planApprovalExecutionStartedForTurnId/);
  assert.match(storeSource, /startApprovedPlanExecutionInCurrentTurn/);
  assert.match(storeSource, /plan_approval_same_turn_execution_queued/);
  assert.match(storeSource, /plan_approval_same_turn_execution_restarted/);
  assert.match(storeSource, /source:\s*"store_fallback"/);
  assert.match(storeSource, /reuseCurrentTurn:\s*true/);
  assert.match(storeSource, /createVisibleTurnForHiddenMessage:\s*false/);
  const approvedExecutionStarter = storeSource.slice(
    storeSource.indexOf("export function startApprovedPlanExecutionInCurrentTurn"),
    storeSource.indexOf("async function hydrateExistingPlanArtifactsForWorkspace"),
  );
  assert.match(approvedExecutionStarter, /resolvedIntent:\s*"execute"/);
  assert.doesNotMatch(approvedExecutionStarter, /runtimeIntentOverride/);
  assert.doesNotMatch(approvePlanMethod, /parentPlanTurnId/);
  assert.doesNotMatch(
    approvePlanMethod,
    /get\(\)\.sendMessage\(/,
    "approvePlan must queue a same-turn transition rather than launch in the approval reducer",
  );

  assert.match(workflowEngineSource, /startApprovedPlanExecutionInCurrentTurn/);
  assert.match(workflowEngineSource, /source:\s*"workflow_fallback"/);
  assert.match(workflowEngineSource, /onApprovedPlanExecutionStarted/);
  assert.match(workflowEngineSource, /plan_approval_same_turn_execution_started/);
  assert.match(workflowEngineSource, /plan_approval_handoff_deduped/);
  assert.doesNotMatch(workflowEngineSource, /approvedPlanHandoff/);
  assert.match(workflowEngineSource, /getCurrentRunIntent:\s*\(\) => effectiveRunIntent/);
  assert.match(
    workflowEngineSource,
    /getWorkflowMode:\s*\(\) => getIntentPolicy\(effectiveRunIntent\)\.workflowMode/,
  );
});

test("tool-result recovery returns the activated execute-recovery state", () => {
  const phaseSource = fsSync.readFileSync(
    path.join(workspaceRoot, "src/lib/orchestrator/loop/toolResultRecoveryPhase.ts"),
    "utf8",
  );
  const actionsSource = fsSync.readFileSync(
    path.join(workspaceRoot, "src/lib/orchestrator/loop/loopRuntimeActions.ts"),
    "utf8",
  );

  assert.match(
    phaseSource,
    /executeRecoveryState = input\.activateExecuteRecovery\(mode, reason, context\)/,
  );
  assert.match(phaseSource, /activateExecuteRecovery: activateExecuteRecoveryAndSync/);
  assert.doesNotMatch(phaseSource, /activateExecuteRecovery: input\.activateExecuteRecovery/);
  assert.match(actionsSource, /return nextState;/);
});

test("six no-progress recovery attempts pause before another model stream", () => {
  const preparationSource = fsSync.readFileSync(
    path.join(workspaceRoot, "src/lib/orchestrator/loop/iterationStreamPreparation.ts"),
    "utf8",
  );
  const orchestratorSource = fsSync.readFileSync(
    path.join(workspaceRoot, "src/lib/orchestrator/loop/AgentOrchestrator.ts"),
    "utf8",
  );
  const pauseCheck = orchestratorSource.indexOf("if (iterationStreamPreparation.recoveryPause)");
  const streamCall = orchestratorSource.indexOf("invokeStreamWithRecoveryForIteration", pauseCheck);

  assert.match(preparationSource, /recoveryPause:\s*\{/);
  assert.match(preparationSource, /execute_recovery_max_iterations_reached/);
  assert.match(orchestratorSource, /execute_recovery_no_progress_limit/);
  assert.ok(pauseCheck >= 0 && streamCall > pauseCheck, "the terminal pause must be persisted before another LLM stream starts");
});

test("terminal runs persist the turn projection before publishing idle", () => {
  const workflowEngineSource = fsSync.readFileSync(
    path.join(workspaceRoot, "src/lib/orchestrator/workflowEngine.ts"),
    "utf8",
  );
  const finalTextStart = workflowEngineSource.indexOf("onAssistantFinalText:");
  const toolExecutingStart = workflowEngineSource.indexOf("onToolExecuting:", finalTextStart);
  const finalTextCallback = workflowEngineSource.slice(finalTextStart, toolExecutingStart);
  const commitIndex = workflowEngineSource.indexOf("commitTerminalProjectionBeforeStatusPublication(loopOutcome)");
  const closeIndex = workflowEngineSource.indexOf("closeHarnessForAgentLoopOutcome(loopOutcome)", commitIndex);
  const persistIndex = workflowEngineSource.indexOf("persistCurrentSessionRuntime(latestState)", closeIndex);
  const gateCommitIndex = workflowEngineSource.indexOf("terminalStatusPublicationGate.commitTerminal({");
  const persistProjectionIndex = workflowEngineSource.indexOf("persistTerminalProjection:", gateCommitIndex);
  const publishStatusIndex = workflowEngineSource.indexOf("publishTerminalStatus:", gateCommitIndex);

  assert.notEqual(commitIndex, -1);
  assert.notEqual(finalTextStart, -1);
  assert.ok(toolExecutingStart > finalTextStart);
  assert.doesNotMatch(
    finalTextCallback,
    /agentStatus:\s*s\.agentStatus === "pending_review" \? "pending_review" : "idle"/,
    "final text must not publish idle before the outer terminal projection is persisted",
  );
  assert.doesNotMatch(
    finalTextCallback,
    /agentStatus:\s*"idle"/,
    "awaiting-input final text must leave idle publication to the terminal gate",
  );
  assert.notEqual(closeIndex, -1);
  assert.notEqual(persistIndex, -1);
  assert.ok(commitIndex < closeIndex);
  assert.ok(closeIndex < persistIndex);
  assert.ok(gateCommitIndex >= 0 && persistProjectionIndex > gateCommitIndex);
  assert.ok(publishStatusIndex > persistProjectionIndex);
  assert.match(workflowEngineSource, /terminal_idle_notification_deferred/);
  assert.match(
    workflowEngineSource,
    /terminalTurnIds\.has\(candidate\.id\)[\s\S]*?status: terminalTurnStatus/,
  );
  assert.match(workflowEngineSource, /terminal_run_projection_committed/);
  assert.match(
    workflowEngineSource,
    /isIntentionalActionPause[\s\S]*?pendingAction\?\.status === "pending"/,
  );
});
