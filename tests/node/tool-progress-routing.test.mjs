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
  isAllowedUnapprovedPlanDraftMutationCallForRuntime,
  resolveToolProgressPresentation,
  resolveToolProgressRouting,
  shouldInjectRuntimeToolNarration,
} = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/lib/orchestrator/loop/toolProgressRouting.ts"),
);

const planDraftWrite = {
  id: "call_plan",
  name: "write_file",
  arguments: JSON.stringify({ path: ".MAIN/plans/plan.md", content: "# Plan" }),
};

test("tool progress routing allows unapproved plan draft artifact writes", () => {
  assert.equal(
    isAllowedUnapprovedPlanDraftMutationCallForRuntime({
      call: planDraftWrite,
      workflowMode: "plan",
      isPlanApproved: false,
      workspace: workspaceRoot,
    }),
    true,
  );

  const decision = resolveToolProgressRouting({
    effectiveToolCalls: [planDraftWrite],
    availableToolNames: new Set(),
    workflowMode: "plan",
    isPlanApproved: false,
    workspace: workspaceRoot,
    visibleAssistantText: "",
  });

  assert.equal(decision.progressEligibleToolCalls.length, 1);
  assert.equal(decision.unsupportedToolCalls.length, 0);
  assert.equal(decision.hasSuppressedUnsupportedPlanToolCalls, false);
});

test("tool progress routing suppresses unsupported unapproved plan tool calls", () => {
  const unsupported = { id: "call_bad", name: "run_command", arguments: "{}" };
  const decision = resolveToolProgressRouting({
    effectiveToolCalls: [unsupported],
    availableToolNames: new Set(["read_file"]),
    workflowMode: "plan",
    isPlanApproved: false,
    workspace: workspaceRoot,
    visibleAssistantText: "",
  });

  assert.deepEqual(decision.unsupportedToolCalls, [unsupported]);
  assert.equal(decision.progressEligibleToolCalls.length, 0);
  assert.equal(decision.hasSuppressedUnsupportedPlanToolCalls, true);
});

test("tool progress routing detects substantive unapproved plan assistant text", () => {
  const decision = resolveToolProgressRouting({
    effectiveToolCalls: [],
    availableToolNames: new Set(),
    workflowMode: "plan",
    isPlanApproved: false,
    workspace: workspaceRoot,
    visibleAssistantText: [
      "## Goal",
      "Fix the issue.",
      "## Steps",
      "1. Inspect code.",
      "2. Patch and validate.",
    ].join("\n"),
  });

  assert.equal(decision.hasSubstantivePlanAssistantText, true);
});

test("tool progress presentation marks runtime narration as user progress", () => {
  assert.equal(
    shouldInjectRuntimeToolNarration({
      progressEligibleToolCallCount: 1,
      visibleAssistantText: "",
      hasToolActionNarration: true,
    }),
    true,
  );

  const decision = resolveToolProgressPresentation({
    progressEligibleToolCallCount: 1,
    unsupportedToolCallCount: 0,
    finalReplyOptionCount: 0,
    hasSubstantivePlanAssistantText: false,
    workflowMode: "edit",
    isPlanApproved: false,
    runtimeNarrationInjected: true,
    visibleAssistantText: "Reading src/App.tsx",
    shouldSuppressApprovedPlanNoToolText: false,
  });

  assert.equal(decision.shouldRenderToolProgress, true);
  assert.equal(decision.visibility, "user_progress");
  assert.equal(decision.capsuleCandidate, false);
  assert.equal(decision.modelAuthored, false);
});

test("tool progress presentation gives model-authored reporting an assistant update identity", () => {
  const decision = resolveToolProgressPresentation({
    progressEligibleToolCallCount: 1,
    unsupportedToolCallCount: 0,
    finalReplyOptionCount: 0,
    hasSubstantivePlanAssistantText: false,
    workflowMode: "plan",
    isPlanApproved: true,
    runtimeNarrationInjected: false,
    visibleAssistantText: "The file-open callback reaches openFiles, so I am checking the backend command registration before choosing the repair boundary.",
    shouldSuppressApprovedPlanNoToolText: false,
  });

  assert.equal(decision.shouldRenderToolProgress, true);
  assert.equal(decision.shouldPreserveApprovedExecutionText, true);
  assert.equal(decision.visibility, "assistant_update");
  assert.equal(decision.capsuleCandidate, false);
  assert.equal(decision.modelAuthored, true);
});

test("assistant update identity preserves a substantive finding plus next step", () => {
  const decision = resolveToolProgressPresentation({
    progressEligibleToolCallCount: 1,
    unsupportedToolCallCount: 0,
    finalReplyOptionCount: 0,
    hasSubstantivePlanAssistantText: false,
    workflowMode: "edit",
    isPlanApproved: false,
    runtimeNarrationInjected: false,
    visibleAssistantText: "前端回调会把选择结果交给 openFiles；我正在对照后端命令注册，判断文件内容能否回传。",
    shouldSuppressApprovedPlanNoToolText: false,
  });

  assert.equal(decision.visibility, "assistant_update");
  assert.equal(decision.shouldPreserveApprovedExecutionText, true);
});

test("first tool-call preamble stays process-only until the Run has tool evidence", () => {
  const decision = resolveToolProgressPresentation({
    progressEligibleToolCallCount: 3,
    unsupportedToolCallCount: 0,
    finalReplyOptionCount: 0,
    hasSubstantivePlanAssistantText: false,
    workflowMode: "plan",
    isPlanApproved: false,
    runtimeNarrationInjected: false,
    visibleAssistantText: "我需要先理解文件打开和新建文档的问题。让我先查看相关代码，了解真实实现。",
    shouldSuppressApprovedPlanNoToolText: false,
    hasPriorToolEvidence: false,
  });

  assert.equal(decision.visibility, "user_progress");
  assert.equal(decision.shouldPreserveApprovedExecutionText, false);
  assert.equal(decision.modelAuthored, true);
});

test("mixed tool narration keeps the substantive stage finding as an assistant update", () => {
  const decision = resolveToolProgressPresentation({
    progressEligibleToolCallCount: 1,
    unsupportedToolCallCount: 0,
    finalReplyOptionCount: 0,
    hasSubstantivePlanAssistantText: false,
    workflowMode: "plan",
    isPlanApproved: true,
    runtimeNarrationInjected: false,
    visibleAssistantText: "让我继续读取相关实现；已确认根因是暂停状态没有统一投影，下一步会收敛终态写入。",
    shouldSuppressApprovedPlanNoToolText: false,
  });

  assert.equal(decision.visibility, "assistant_update");
  assert.equal(decision.shouldPreserveApprovedExecutionText, true);
  assert.equal(decision.modelAuthored, true);
  assert.equal(decision.capsuleCandidate, false);
});

test("thin tool preambles stay internal instead of becoming assistant updates", () => {
  const decision = resolveToolProgressPresentation({
    progressEligibleToolCallCount: 1,
    unsupportedToolCallCount: 0,
    finalReplyOptionCount: 0,
    hasSubstantivePlanAssistantText: false,
    workflowMode: "edit",
    isPlanApproved: true,
    runtimeNarrationInjected: false,
    visibleAssistantText: "让我继续读取关键文件来确认问题根因。",
    shouldSuppressApprovedPlanNoToolText: false,
  });

  assert.equal(decision.visibility, "user_progress");
  assert.equal(decision.shouldPreserveApprovedExecutionText, false);
  assert.equal(decision.capsuleCandidate, false);
});

test("unsupported-tool narration remains hidden even when it describes a next attempt", () => {
  const decision = resolveToolProgressPresentation({
    progressEligibleToolCallCount: 0,
    unsupportedToolCallCount: 1,
    finalReplyOptionCount: 0,
    hasSubstantivePlanAssistantText: false,
    workflowMode: "edit",
    isPlanApproved: false,
    runtimeNarrationInjected: false,
    visibleAssistantText: "工具不可用，下一步将尝试另一个工具。",
    shouldSuppressApprovedPlanNoToolText: false,
  });

  assert.equal(decision.visibility, "hidden_process");
  assert.equal(decision.shouldPreserveApprovedExecutionText, false);
});
