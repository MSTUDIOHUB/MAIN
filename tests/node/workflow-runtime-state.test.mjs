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
