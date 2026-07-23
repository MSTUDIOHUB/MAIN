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
  isHiddenThoughtOnlyNoToolStop,
  resolveAssistantReplyOptionRouting,
  resolveClosedPlanReadOnlyContinuation,
  resolveNonBlockingPlanChoiceLoop,
  resolveToolProtocolStreamClearDecision,
  shouldAutoContinueNonBlockingPlanChoices,
  shouldTrackAssistantCheckpoint,
} = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/lib/orchestrator/loop/assistantOutputRouting.ts"),
);
const {
  annotateRequiredToolCallProtocolResult,
} = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/lib/requiredToolProtocol.ts"),
);
const {
  normalizeAssistantTurn,
} = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/lib/normalizedTurn.ts"),
);

test("assistant output routing clears raw tool protocol unless unapproved plan text should remain", () => {
  const clear = resolveToolProtocolStreamClearDecision({
    toolCallCount: 1,
    streamText: "<tool_use><tool>read_file</tool></tool_use>",
    workflowMode: "edit",
    isPlanApproved: false,
    visibleAssistantText: "",
  });
  assert.deepEqual(clear, { shouldClear: true, preserveScopedPlanVisibleText: false });

  const preservePlanText = resolveToolProtocolStreamClearDecision({
    toolCallCount: 1,
    streamText: "<tool_use><tool>write_file</tool></tool_use>",
    workflowMode: "plan",
    isPlanApproved: false,
    visibleAssistantText: "## Plan\n- inspect evidence",
  });
  assert.deepEqual(preservePlanText, { shouldClear: true, preserveScopedPlanVisibleText: true });
});

test("assistant output routing leaves normal text streams alone", () => {
  const decision = resolveToolProtocolStreamClearDecision({
    toolCallCount: 1,
    streamText: "I will inspect the file.",
    workflowMode: "edit",
    isPlanApproved: false,
    visibleAssistantText: "I will inspect the file.",
  });

  assert.deepEqual(decision, { shouldClear: false, preserveScopedPlanVisibleText: false });
});

test("assistant output routing tracks checkpoint text only for model-authored text", () => {
  assert.equal(
    shouldTrackAssistantCheckpoint({
      historyAssistantText: "I found the issue.",
      runtimeNarrationInjected: false,
    }),
    true,
  );
  assert.equal(
    shouldTrackAssistantCheckpoint({
      historyAssistantText: "Reading src/App.tsx",
      runtimeNarrationInjected: true,
    }),
    false,
  );
});

test("assistant output routing auto-continues only non-blocking unapproved plan choices without tools", () => {
  assert.equal(
    shouldAutoContinueNonBlockingPlanChoices({
      suppressPlanContinuationReplyOptions: true,
      toolCallCount: 0,
      workflowMode: "plan",
      isPlanApproved: false,
    }),
    true,
  );
  assert.equal(
    shouldAutoContinueNonBlockingPlanChoices({
      suppressPlanContinuationReplyOptions: true,
      toolCallCount: 1,
      workflowMode: "plan",
      isPlanApproved: false,
    }),
    false,
  );
  assert.equal(
    shouldAutoContinueNonBlockingPlanChoices({
      suppressPlanContinuationReplyOptions: true,
      toolCallCount: 0,
      workflowMode: "plan",
      isPlanApproved: false,
      hasSubstantivePlanAssistantText: true,
    }),
    false,
    "strip the non-blocking options but preserve a substantive plan candidate for materialization",
  );
});

test("non-blocking plan choice auto-continuation forces finalization at its retry boundary", () => {
  assert.deepEqual(resolveNonBlockingPlanChoiceLoop({
    consecutiveNoToolCount: 0,
    maxAutoContinues: 2,
  }), {
    action: "continue",
    nextConsecutiveNoToolCount: 1,
  });
  assert.deepEqual(resolveNonBlockingPlanChoiceLoop({
    consecutiveNoToolCount: 1,
    maxAutoContinues: 2,
  }), {
    action: "force_finalize",
    nextConsecutiveNoToolCount: 2,
  });
});

test("closed drafting surface reopens targeted evidence without a raw read-count cap", () => {
  const first = resolveClosedPlanReadOnlyContinuation({
    autoContinueNonBlockingPlanChoices: true,
    replyOptions: [{ label: "继续读取配置", value: "继续读取配置", action: "continue_readonly_once" }],
    toolCallCount: 0,
    workflowMode: "plan",
    isPlanApproved: false,
    availableToolCount: 0,
    planRuntimePhase: "drafting",
    targetedRecoveryPasses: 0,
  });
  assert.deepEqual(first, {
    action: "targeted_evidence",
    reason: "suppressed_tool_ready_evidence_missing_visible_plan",
  });

  const laterDistinctRead = resolveClosedPlanReadOnlyContinuation({
    autoContinueNonBlockingPlanChoices: true,
    replyOptions: [{ label: "继续读取配置", value: "继续读取配置", action: "continue_readonly_once" }],
    toolCallCount: 0,
    workflowMode: "plan",
    isPlanApproved: false,
    availableToolCount: 0,
    planRuntimePhase: "drafting",
    targetedRecoveryPasses: 1,
  });
  assert.deepEqual(laterDistinctRead, {
    action: "targeted_evidence",
    reason: "suppressed_tool_ready_evidence_missing_visible_plan",
  });

  const modelOwnedGroundingChoice = resolveClosedPlanReadOnlyContinuation({
    autoContinueNonBlockingPlanChoices: true,
    replyOptions: [
      {
        label: "直接基于当前发现生成计划",
        value: "直接基于当前发现生成计划（假设采用当前映射）",
        source: "explicit_user_options",
      },
      {
        label: "我来确认具体的字段使用情况",
        value: "我来确认具体的字段使用情况",
        source: "explicit_user_options",
      },
    ],
    toolCallCount: 0,
    workflowMode: "plan",
    isPlanApproved: false,
    availableToolCount: 0,
    planRuntimePhase: "drafting",
    targetedRecoveryPasses: 0,
  });
  assert.deepEqual(modelOwnedGroundingChoice, {
    action: "targeted_evidence",
    reason: "suppressed_tool_ready_evidence_missing_visible_plan",
  });
});

test("closed plan continuation does not reopen tools for arbitrary options or an open evidence surface", () => {
  assert.deepEqual(resolveClosedPlanReadOnlyContinuation({
    autoContinueNonBlockingPlanChoices: false,
    replyOptions: [{
      label: "确认 normalizeCsvOrder 的返回值类型兼容",
      value: "请确认 normalizeCsvOrder 的返回值类型兼容",
      source: "inferred_enumerated",
    }],
    toolCallCount: 0,
    workflowMode: "plan",
    isPlanApproved: false,
    availableToolCount: 0,
    planRuntimePhase: "drafting",
    targetedRecoveryPasses: 0,
  }), { action: "none" });
  assert.deepEqual(resolveClosedPlanReadOnlyContinuation({
    autoContinueNonBlockingPlanChoices: true,
    replyOptions: [{ label: "改变范围", value: "改变范围" }],
    toolCallCount: 0,
    workflowMode: "plan",
    isPlanApproved: false,
    availableToolCount: 0,
    planRuntimePhase: "drafting",
    targetedRecoveryPasses: 0,
  }), { action: "none" });
  assert.deepEqual(resolveClosedPlanReadOnlyContinuation({
    autoContinueNonBlockingPlanChoices: true,
    replyOptions: [{ label: "继续读取配置", value: "继续读取配置", action: "continue_readonly_once" }],
    toolCallCount: 0,
    workflowMode: "plan",
    isPlanApproved: false,
    availableToolCount: 1,
    planRuntimePhase: "needs_evidence",
    targetedRecoveryPasses: 0,
  }), { action: "none" });
});

test("assistant output routing resolves executable plan reply options and pause decision", () => {
  const replyOptions = [
    { label: "批准执行本轮操作", value: "approve", action: "approve_operation_once", source: "proposal_follow_up" },
    { label: "继续调整方案", value: "adjust", action: "adjust_plan", source: "proposal_follow_up" },
  ];

  const decision = resolveAssistantReplyOptionRouting({
    rawFinalReplyOptions: replyOptions,
    finalReplyOptions: [
      { label: "继续", value: "continue", source: "explicit_user_options" },
    ],
    toolCallCount: 0,
    workflowMode: "plan",
    hasStructuredProposal: false,
    hasReadyPlanArtifacts: false,
    isPlanApproved: false,
    forcePause: false,
    finishReason: "stop",
  });

  assert.equal(decision.hasExecutablePlanProposalOptions, true);
  assert.equal(decision.shouldPauseForUserChoice, true);
});

test("required typed Plan surface still pauses for explicit blocking user options", () => {
  const requiredResult = annotateRequiredToolCallProtocolResult({
    content: [
      "A user-owned product decision blocks the Plan.",
      "<user_options>",
      "<option>Keep local-only storage</option>",
      "<option>Enable cloud synchronization</option>",
      "</user_options>",
    ].join("\n"),
    toolCalls: [],
    finishReason: "stop",
  }, "required", ["submit_plan_candidate"]);
  assert.equal(requiredResult.protocolViolation, "required_tool_call_missing");

  const normalized = normalizeAssistantTurn(requiredResult);
  assert.deepEqual(normalized.replyOptions.map((option) => option.source), [
    "explicit_user_options",
    "explicit_user_options",
  ]);
  const decision = resolveAssistantReplyOptionRouting({
    rawFinalReplyOptions: normalized.replyOptions,
    finalReplyOptions: normalized.replyOptions,
    toolCallCount: 0,
    workflowMode: "plan",
    hasStructuredProposal: false,
    hasReadyPlanArtifacts: false,
    isPlanApproved: false,
    forcePause: false,
    finishReason: "stop",
  });
  assert.equal(decision.shouldPauseForUserChoice, true);

  const completionSource = fsSync.readFileSync(path.join(
    workspaceRoot,
    "src/lib/orchestrator/loop/assistantCompletionPhase.ts",
  ), "utf8");
  assert.ok(
    completionSource.indexOf("handleReplyOptionsPause({") <
      completionSource.indexOf("handlePlanNoToolRecovery({"),
    "blocking reply options must pause before required-tool recovery",
  );
});

test("assistant output routing keeps inferred diagnostic options from pausing tool execution", () => {
  const inferredDiagnostics = [
    {
      label: "引用了 save_file_content 命令但未在 Rust 端实现",
      value: "引用了 save_file_content 命令但未在 Rust 端实现",
      action: "execute_once",
      source: "inferred_enumerated",
    },
    {
      label: "我来确认是否在 tauri.conf.json 中配置",
      value: "我来确认是否在 tauri.conf.json 中配置",
      source: "inferred_enumerated",
    },
  ];

  const decision = resolveAssistantReplyOptionRouting({
    rawFinalReplyOptions: inferredDiagnostics,
    finalReplyOptions: inferredDiagnostics,
    toolCallCount: 2,
    workflowMode: "plan",
    hasStructuredProposal: false,
    hasReadyPlanArtifacts: false,
    isPlanApproved: true,
    forcePause: true,
    finishReason: "tool_calls",
  });

  // Completion only drops calls from the reply-options pause path; this false
  // decision therefore leaves the two calls on the normal execution path.
  assert.equal(decision.shouldPauseForUserChoice, false);
});

test("assistant output routing detects hidden-thought-only no-tool stops", () => {
  assert.equal(
    isHiddenThoughtOnlyNoToolStop({
      toolCallCount: 0,
      replyOptionCount: 0,
      hasMeaningfulVisibleText: false,
      hiddenThought: "internal reasoning",
    }),
    true,
  );
  assert.equal(
    isHiddenThoughtOnlyNoToolStop({
      toolCallCount: 0,
      replyOptionCount: 1,
      hasMeaningfulVisibleText: false,
      hiddenThought: "internal reasoning",
    }),
    false,
  );
});
