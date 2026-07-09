import test from "node:test";
import assert from "node:assert/strict";
import fsSync from "node:fs";
import path from "node:path";

const workspaceRoot = process.cwd();

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
  assert.match(source, /isSubstantiveModelFeedback\(content\)/);
  assert.match(source, /!hasSubstantiveIntermediateAgentText/);
  assert.match(source, /阶段性\|结论\|总结\|问题\|原因\|根因\|修复\|方案\|验证/);
});

test("onStreamDone preserves abortController when agentStatus is pending_review", () => {
  const source = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/workflowEngine.ts"), "utf8");

  assert.match(
    source,
    /\.\.\.\(s\.agentStatus === "pending_review" \? \{\} : \{ abortController: null \}\)/
  );
});

test("onToolDone populates planExecutionEvidenceLedger and reconciles planTasks", () => {
  const source = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/workflowEngine.ts"), "utf8");

  assert.match(source, /createPlanExecutionEvidenceEntry/);
  assert.match(source, /appendPlanEvidenceEntry/);
  assert.match(source, /reconcilePlanTaskCompletion/);
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
  const source = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/AgentOrchestrator.ts"), "utf8");

  assert.match(source, /Promise<AgentLoopOutcome>/);
  assert.match(source, /onNonActionableStop: \(message, reason, progress\) =>/);
  assert.match(source, /reason === "incomplete_plan" \? "paused"/);
  assert.match(source, /approved_plan_completion_guard/);
  assert.match(source, /buildPlanTaskEvidenceAudit/);
});

test("approved plan no-tool guard uses execution checkpoint helper and no-action outcome", () => {
  const source = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/AgentOrchestrator.ts"), "utf8");
  const workflowEngine = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/workflowEngine.ts"), "utf8");

  assert.match(source, /shouldHandleApprovedPlanExecutionNoTool/);
  assert.match(source, /approved_plan_no_tool_route/);
  assert.match(source, /plan_execution_no_tool_reprompt/);
  assert.match(source, /approved_plan_completion_guard_no_evidence/);
  assert.match(source, /return \{ status: "stopped_no_action", reason: "approved_plan_completion_guard" \}/);
  assert.match(workflowEngine, /progress\?\.recoveryReason === "approved_plan_completion_guard_no_evidence"[\s\S]*?"stopped_no_action"/);
  assert.match(workflowEngine, /const stopBlock = \{/);
  assert.match(workflowEngine, /type: "system"/);
  assert.match(workflowEngine, /content: message/);
  assert.match(workflowEngine, /variant: "execution_checkpoint"/);
});

test("approved plan max-iteration boundary pauses instead of surfacing agent error", () => {
  const source = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/AgentOrchestrator.ts"), "utf8");
  const checkpointIndex = source.indexOf("logAgentEvent(\"max_iterations_checkpoint\"");
  const branch = source.slice(checkpointIndex, checkpointIndex + 2200);

  assert.notEqual(checkpointIndex, -1);
  assert.match(branch, /emitPlanExecutionProgress\("paused"/);
  assert.match(branch, /callbacks\.onNonActionableStop\(/);
  assert.match(branch, /recoveryReason:\s*"plan_max_iterations_checkpoint"/);
  assert.match(branch, /"incomplete_plan"/);
  assert.doesNotMatch(branch, /callbacks\.onError\(buildPlanMaxIterationsPauseNotice/);
});

test("explicit reply options mark assistant text as awaiting input even when tool calls coexist", () => {
  const workflowEngine = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/workflowEngine.ts"), "utf8");
  const orchestratorSource = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/AgentOrchestrator.ts"), "utf8");

  assert.match(orchestratorSource, /awaitingInput:\s*shouldPauseForUserChoice/);
  assert.match(orchestratorSource, /onAssistantFinalText: \(text, replyOptions = \[\], meta\) =>/);
  assert.match(orchestratorSource, /status: "paused", reason: "awaiting_user_choice"/);
  assert.match(orchestratorSource, /agent_loop_awaiting_user_choice/);
  assert.match(workflowEngine, /const awaitingInput = meta\?\.awaitingInput === true && replyOptions\.length > 0/);
  assert.match(workflowEngine, /status:\s*"awaiting_input"/);
  assert.match(workflowEngine, /agentStatus:\s*"idle"[\s\S]*?isGenerating:\s*false/);
});

test("agent loop blocks execute completion without execution evidence", () => {
  const source = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/AgentOrchestrator.ts"), "utf8");
  const orchestrator = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator.ts"), "utf8");
  const workflowEngine = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/workflowEngine.ts"), "utf8");

  assert.match(source, /completionEvidenceRequired === "execution_evidence"/);
  assert.match(source, /!orchestrator\.hasExecuteOperationEvidence\(\)/);
  assert.match(source, /execute_completion_outcome_without_evidence/);
  assert.match(source, /reason: "execution_evidence_required"/);
  assert.match(source, /parseToolFeedbackEnvelope/);
  assert.match(source, /feedbackStatus === "no_op"/);
  assert.match(source, /feedbackStatus === "no_effect_mutation"/);
  assert.match(source, /already matched requested content/);
  assert.match(source, /commandResultLooksSuccessful/);
  assert.match(source, /browserResultLooksSuccessful/);
  assert.match(orchestrator, /export function isProjectSourceWriteResult/);
  assert.match(orchestrator, /"noOp"\\s\*:\\s\*true\|NO_EFFECT_MUTATION/);
  assert.match(workflowEngine, /getExecutionConsentGranted/);
  assert.match(workflowEngine, /currentTurnExecutionConsent/);
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
  assert.match(submitPlanExecutionResumeSource, /createVisibleTurnForHiddenMessage:\s*true/);
  assert.match(submitPendingReviewTransitionSource, /export function applySubmitPendingReviewTransition/);
  assert.match(submitPendingReviewTransitionSource, /resolvePendingReviewSubmissionDecision/);
  assert.match(submitPendingReviewTransitionSource, /send_pending_review_abort_and_new_turn/);
  assert.match(submitPendingReviewTransitionSource, /stopped_no_action/);
  assert.match(submitPlanStateResetSource, /export function applySubmitPlanStateReset/);
  assert.match(submitPlanStateResetSource, /planExecutionEvidenceLedger: \[\]/);
  assert.match(submitPlanStateResetSource, /currentTurnExecutionConsent: \{ turnId: null, granted: false \}/);
  assert.match(submitSendGateEffectsSource, /export function applySubmitSendGateEffects/);
  assert.match(submitSendGateEffectsSource, /resolveSubmitSendGateDecision/);
  assert.match(submitSendGateEffectsSource, /send_busy_hidden_execution_allowed/);
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
    /const selectedAwaitingReplyOption = findReplyOptionMatchingSelectedText/,
  );
  assert.match(
    turnSubmissionSource,
    /const shouldAutoResumeChoiceTurn =[\s\S]*?currentTurnHasReplyOptions &&[\s\S]*?!!selectedAwaitingReplyOption;/,
  );
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
  assert.doesNotMatch(
    storeSource,
    /if \(runtimeDecision\.shouldResetPlanState\)[\s\S]{0,500}planExecutionEvidenceLedger/,
  );
  assert.match(storeSource, /const sendGateEffect = applySubmitSendGateEffects/);
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

test("approved plan execution handoff has one runtime owner and dedupe guard", () => {
  const storeSource = fsSync.readFileSync(path.join(workspaceRoot, "src/store/useAppStore.ts"), "utf8");
  const sessionTypesSource = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/sessionTypes.ts"), "utf8");
  const workflowEngineSource = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/workflowEngine.ts"), "utf8");
  const approvePlanMethod = storeSource.slice(
    storeSource.indexOf("approvePlan: (approvalChoice) =>"),
    storeSource.indexOf("rejectPlan: () =>", storeSource.indexOf("approvePlan: (approvalChoice) =>")),
  );

  assert.match(sessionTypesSource, /export interface PlanApprovalHandoff/);
  assert.match(storeSource, /PlanApprovalHandoff/);
  assert.match(storeSource, /planApprovalExecutionStartedForTurnId/);
  assert.match(storeSource, /startApprovedPlanExecutionTurnFromHandoff/);
  assert.match(storeSource, /plan_approval_direct_execution_suppressed/);
  assert.match(storeSource, /plan_approval_execution_turn_created/);
  assert.match(storeSource, /source:\s*"store_fallback"/);
  assert.doesNotMatch(
    approvePlanMethod,
    /get\(\)\.sendMessage\(/,
    "approvePlan must register a handoff, not directly append a hidden execution turn",
  );

  assert.match(workflowEngineSource, /startApprovedPlanExecutionTurnFromHandoff/);
  assert.match(workflowEngineSource, /source:\s*"active_loop"/);
  assert.match(workflowEngineSource, /plan_approval_handoff_deduped/);
  assert.doesNotMatch(
    workflowEngineSource,
    /plan_approval_handoff_starting_execution_turn/,
    "legacy direct-start log should be replaced by the single execution-turn-created event",
  );
});
