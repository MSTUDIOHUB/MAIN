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

test("pending review materializes a visible tool card for TopIsland", () => {
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
