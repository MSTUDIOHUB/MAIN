import test from "node:test";
import assert from "node:assert/strict";
import fsSync from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

import ts from "typescript";

const require = createRequire(import.meta.url);
const workspaceRoot = process.cwd();
const transpiledModuleCache = new Map();

function loadTranspiledModuleSync(sourcePath) {
  const normalizedPath = path.resolve(sourcePath);
  if (transpiledModuleCache.has(normalizedPath)) {
    return transpiledModuleCache.get(normalizedPath);
  }

  const source = fsSync.readFileSync(normalizedPath, "utf8");
  const localRequire = createRequire(normalizedPath);
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
    fileName: normalizedPath,
  }).outputText;

  const module = { exports: {} };
  transpiledModuleCache.set(normalizedPath, module.exports);

  const runtimeRequire = (specifier) => {
    if (specifier.startsWith(".")) {
      const basePath = path.resolve(path.dirname(normalizedPath), specifier);
      const candidates = [
        basePath,
        `${basePath}.ts`,
        `${basePath}.tsx`,
        path.join(basePath, "index.ts"),
      ];

      for (const candidate of candidates) {
        if (!fsSync.existsSync(candidate)) continue;
        if (candidate.endsWith(".ts") || candidate.endsWith(".tsx")) {
          return loadTranspiledModuleSync(candidate);
        }
      }
    }

    return localRequire(specifier);
  };

  const factory = new Function("exports", "module", "require", transpiled);
  factory(module.exports, module, runtimeRequire);
  transpiledModuleCache.set(normalizedPath, module.exports);
  return module.exports;
}

const {
  resolveAssistantTurnDisplayDecision,
} = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/lib/orchestrator/loop/assistantTurnDisplay.ts"),
);
const { extractReplyOptions } = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/lib/replyOptions.ts"),
);

function resolveDecision(overrides = {}) {
  return resolveAssistantTurnDisplayDecision({
    workflowMode: "edit",
    turnIntent: "execute",
    runtimeIntent: "execute",
    streamText: "I will continue.",
    normalizedVisibleText: "I will continue.",
    normalizedBaseVisibleText: "",
    normalizedFinishReason: "stop",
    normalizedReplyOptions: [],
    effectiveToolCallCount: 0,
    isPlanApproved: false,
    planStage: "idle",
    sawPlanModeToolActivity: false,
    sawExecuteOperationEvidence: false,
    readOnlyAutoApproveForSession: false,
    language: "en",
    ...overrides,
  });
}

test("assistant turn display compacts oversized prose code dumps and drops reply options", () => {
  const longCodeDump = [
    "File: src/App.tsx",
    "```tsx",
    "export function App() { return null; }",
    "```",
    "File: src/main.tsx",
    "```tsx",
    "export const boot = true;",
    "```",
    " filler".repeat(2_100),
  ].join("\n");

  const decision = resolveDecision({
    normalizedVisibleText: longCodeDump,
    normalizedReplyOptions: [{ label: "Continue", value: "continue" }],
  });

  assert.equal(decision.compactedProseCodeDump, true);
  assert.equal(decision.rawFinalReplyOptions.length, 0);
  assert.equal(decision.finalReplyOptions.length, 0);
  assert.match(decision.finalVisibleText, /compacted/i);
});

test("assistant turn display auto-continues read-only permission options when already approved", () => {
  const decision = resolveDecision({
    workflowMode: "edit",
    normalizedVisibleText: "May I read src/App.tsx before editing?",
    normalizedReplyOptions: [{
      label: "Allow reading",
      value: "allow",
      action: "allow_readonly_session",
      source: "readonly_permission",
    }],
    readOnlyAutoApproveForSession: true,
  });

  assert.equal(decision.autoContinueReadOnlyPermission, true);
  assert.equal(decision.suppressReadOnlyPermissionOptions, true);
  assert.equal(decision.finalReplyOptions.length, 0);
});

test("assistant turn display suppresses executable options during approved plan execution", () => {
  const decision = resolveDecision({
    workflowMode: "plan",
    turnIntent: "plan",
    isPlanApproved: true,
    planStage: "executing",
    normalizedVisibleText: "I can continue implementing the approved plan.",
    normalizedReplyOptions: [{
      label: "Approve execution",
      value: "approve",
      action: "approve_operation_once",
      source: "operation_approval",
    }],
  });

  assert.equal(decision.isApprovedPlanExecutionTurn, true);
  assert.equal(decision.suppressApprovedPlanExecutionReplyOptions, true);
  assert.equal(decision.finalReplyOptions.length, 0);
});

test("assistant turn display routes premature unapproved plan options into the artifact", () => {
  const decision = resolveDecision({
    workflowMode: "plan",
    turnIntent: "plan",
    isPlanApproved: false,
    planStage: "idle",
    normalizedVisibleText: [
      "Implementation Plan",
      "Phase 1: inspect the current workflow.",
      "Phase 2: implement the scoped fix.",
    ].join("\n"),
    normalizedReplyOptions: [{
      label: "Start implementation",
      value: "execute the plan",
      source: "proposal_follow_up",
    }],
  });

  assert.equal(decision.rawFinalReplyOptions.length, 1);
  assert.equal(decision.planReplyOptionsRoutedToArtifact, true);
  assert.equal(decision.finalReplyOptions.length, 0);
  assert.match(decision.finalVisibleText, /Implementation Plan/);
});

test("assistant turn display hides model-authored approval options once a structured plan is reviewable", () => {
  const decision = resolveDecision({
    workflowMode: "plan",
    turnIntent: "plan",
    isPlanApproved: false,
    planStage: "idle",
    streamText: "<proposed_plan># Plan\n\n## Summary\nA reviewable plan backed by the inspected event flow.\n\n## Key Changes\n- Align the event names.\n- Add regression coverage.</proposed_plan>",
    normalizedVisibleText: "# Plan\n\n## Summary\nA reviewable plan backed by the inspected event flow.\n\n## Key Changes\n- Align the event names.\n- Add regression coverage.",
    normalizedReplyOptions: [
      {
        label: "Approve execution",
        value: "approve",
        action: "approve_operation_once",
        source: "proposal_follow_up",
      },
      {
        label: "Adjust plan",
        value: "adjust",
        action: "adjust_plan",
        source: "proposal_follow_up",
      },
    ],
  });

  assert.equal(decision.hasStructuredProposal, true);
  assert.equal(decision.planReplyOptionsRoutedToArtifact, true);
  assert.equal(decision.finalReplyOptions.length, 0);
});

test("assistant turn display completes evidenced execution instead of reopening inferred approval", () => {
  const completionSummary = [
    "## 修复方案已完成",
    "",
    "- 已修改运行时的回复选项路由。",
    "- 已运行构建并通过验证。",
    "- 后续可以继续完善相关测试。",
  ].join("\n");
  const inferred = extractReplyOptions(completionSummary);
  assert.equal(inferred.replyOptions[0]?.source, "proposal_follow_up");
  const decision = resolveDecision({
    streamText: completionSummary,
    normalizedVisibleText: completionSummary,
    normalizedReplyOptions: inferred.replyOptions,
    sawExecuteOperationEvidence: true,
  });

  assert.equal(decision.hasStructuredProposal, false);
  assert.equal(decision.suppressInferredOperationApprovalAfterExecution, true);
  assert.equal(decision.finalReplyOptions.length, 0);
});

test("assistant turn display preserves explicit blocking choices after execution evidence", () => {
  const decision = resolveDecision({
    normalizedVisibleText: "发现两条会改变用户可见行为的实现路径，请选择。",
    normalizedReplyOptions: [{
      label: "保留旧行为",
      value: "保留旧行为",
      source: "explicit_user_options",
    }],
    sawExecuteOperationEvidence: true,
  });

  assert.equal(decision.suppressInferredOperationApprovalAfterExecution, false);
  assert.equal(decision.finalReplyOptions.length, 1);
});

test("assistant turn display keeps inferred approval for a real post-evidence decision before completion", () => {
  const decision = resolveDecision({
    normalizedVisibleText: "A newly discovered compatibility choice must be decided before continuing.",
    normalizedReplyOptions: [{
      label: "Approve the compatibility change",
      value: "Approve the compatibility change",
      action: "approve_operation_once",
      source: "proposal_follow_up",
    }],
    sawExecuteOperationEvidence: true,
  });

  assert.equal(decision.suppressInferredOperationApprovalAfterExecution, false);
  assert.equal(decision.finalReplyOptions.length, 1);
});

test("plain structured markdown remains a tier-3 proposal only inside Plan workflow", () => {
  const plaintextPlan = [
    "# Implementation Plan",
    "",
    "## Changes",
    "- Update the runtime boundary.",
    "- Add regression tests.",
    "- Preserve explicit blocking choices while preventing completed execution from reopening approval.",
  ].join("\n");

  const editDecision = resolveDecision({
    streamText: plaintextPlan,
    normalizedVisibleText: plaintextPlan,
  });
  const planDecision = resolveDecision({
    workflowMode: "plan",
    turnIntent: "plan",
    runtimeIntent: "plan",
    streamText: plaintextPlan,
    normalizedVisibleText: plaintextPlan,
  });

  assert.equal(editDecision.hasStructuredProposal, false);
  assert.equal(planDecision.hasStructuredProposal, true);
});
