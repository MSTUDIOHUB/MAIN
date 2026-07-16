import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const orchestrator = fs.readFileSync(path.join(root, "src/lib/orchestrator.ts"), "utf8");
const executePrompts = fs.readFileSync(path.join(root, "src/lib/orchestrator/prompts/executePrompts.ts"), "utf8");
const planPrompts = fs.readFileSync(path.join(root, "src/lib/orchestrator/prompts/planPrompts.ts"), "utf8");

test("prompt helpers have one implementation source while orchestrator preserves exports", () => {
  const executeNames = [
    "buildExecuteConvergencePrompt",
    "buildHiddenThoughtOnlyContinuationPrompt",
    "buildReadOnlyPermissionHardRecoveryPrompt",
    "looksLikeOperationCompletionClaim",
    "looksLikePlanCompletionClaim",
  ];
  const planNames = [
    "buildApprovedPlanNoToolPauseMessage",
    "buildApprovedPlanValidationPendingMessage",
    "buildBrowserValidationContinuationPrompt",
    "formatPlanAuditRemainingTasks",
    "resolveApprovedPlanValidationBoundary",
  ];
  const planInternalNames = [
    "detectRequestedRootMarkdownDeliverables",
    "formatApprovedPlanNoToolAvailableTools",
    "formatPendingValidationTasks",
    "isPlanControlUserPrompt",
    "isPlanRuntimeInstructionMemory",
  ];

  assert.match(orchestrator, /from "\.\/orchestrator\/prompts\/executePrompts"/);
  assert.match(orchestrator, /from "\.\/orchestrator\/prompts\/planPrompts"/);
  for (const name of executeNames) {
    assert.doesNotMatch(orchestrator, new RegExp(`function\\s+${name}\\s*\\(`));
    assert.match(executePrompts, new RegExp(`export function\\s+${name}\\s*\\(`));
    assert.match(orchestrator, new RegExp(`\\b${name}\\b`));
  }
  for (const name of planNames) {
    assert.doesNotMatch(orchestrator, new RegExp(`function\\s+${name}\\s*\\(`));
    assert.match(planPrompts, new RegExp(`export function\\s+${name}\\s*\\(`));
    assert.match(orchestrator, new RegExp(`\\b${name}\\b`));
  }
  for (const name of planInternalNames) {
    assert.doesNotMatch(orchestrator, new RegExp(`function\\s+${name}\\s*\\(`));
    assert.match(planPrompts, new RegExp(`export function\\s+${name}\\s*\\(`));
  }
});

test("execute prompts do not restore prose-classified completion or replanning recovery", () => {
  for (const removedName of [
    "buildExecuteCompletionEvidencePrompt",
    "buildExecuteReplanningEvidencePrompt",
    "looksLikeExecutionReplanningText",
  ]) {
    assert.doesNotMatch(executePrompts, new RegExp(`\\b${removedName}\\b`));
    assert.doesNotMatch(orchestrator, new RegExp(`\\b${removedName}\\b`));
  }
});

test("browser validation continuation stays project-neutral and preserves the execution boundary", () => {
  assert.doesNotMatch(
    planPrompts,
    /Markdown Viewer|test-sample\.md|inject it into the editor textarea|Mermaid containers|脚注|注入编辑器 textarea/,
  );
  assert.match(planPrompts, /already confirmed ready|readiness is confirmed|已经确认 ready/);
  assert.match(planPrompts, /structured validation obligation, action, and assertion|结构化验证义务、动作和断言/);
  assert.match(planPrompts, /perform that action and check the resulting state|执行对应动作并核对动作后的状态/);
  assert.match(planPrompts, /do not invent project-specific steps|不臆造项目专用步骤/);
  assert.match(planPrompts, /cannot close the automatic acceptance gap|不能用人工复核关闭自动验收缺口/);
});
