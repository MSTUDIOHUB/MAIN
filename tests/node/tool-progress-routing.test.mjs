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

test("tool progress presentation hides approved execution model narration", () => {
  const decision = resolveToolProgressPresentation({
    progressEligibleToolCallCount: 1,
    finalReplyOptionCount: 0,
    hasSubstantivePlanAssistantText: false,
    workflowMode: "plan",
    isPlanApproved: true,
    runtimeNarrationInjected: false,
    visibleAssistantText: "I will patch the source now.",
    shouldSuppressApprovedPlanNoToolText: false,
  });

  assert.equal(decision.shouldRenderToolProgress, true);
  assert.equal(decision.shouldPreserveApprovedExecutionText, false);
  assert.equal(decision.visibility, "hidden_process");
  assert.equal(decision.capsuleCandidate, false);
  assert.equal(decision.modelAuthored, true);
});
