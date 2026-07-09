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
  createStreamMaxElapsedTimeoutError,
  createStreamNoVisibleTokenTimeoutError,
  buildPlanExplorationBudget,
  isReasoningDominatedLengthResult,
  isReasoningDominatedNoActionResult,
  isStreamWatchdogTimeoutMessage,
  shouldAttemptPlanClosureGuard,
  shouldDeferNoProgressStopToPlanReadOnlyConvergence,
  shouldUsePlanNoVisibleTokenWatchdog,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/orchestrator.ts"));
const {
  shouldSuppressPlanTruncationWarning,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/planRuntime.ts"));

test("classifies no-visible-token stream timeout as a plan watchdog timeout", () => {
  const error = createStreamNoVisibleTokenTimeoutError(125_000, "plan:preapproval_xml_tools");

  assert.equal(error.code, "STREAM_NO_VISIBLE_TOKEN_TIMEOUT");
  assert.match(error.message, /no visible model output/);
  assert.equal(isStreamWatchdogTimeoutMessage(error.message), true);
});

test("classifies post-first-chunk idle stream timeout as a plan watchdog timeout", () => {
  assert.equal(
    isStreamWatchdogTimeoutMessage("STREAM_IDLE_TIMEOUT: 模型已返回首个流式 chunk，但 180 秒内没有继续输出，本轮已暂停。"),
    true,
  );
});

test("classifies chunk trickle without visible progress as a plan watchdog timeout", () => {
  assert.equal(
    isStreamWatchdogTimeoutMessage("STREAM_NO_VISIBLE_PROGRESS_TIMEOUT: model stream produced chunks for 180000ms without visible output or tool calls."),
    true,
  );
});

test("classifies recovery stream max elapsed timeout as watchdog pause", () => {
  const error = createStreamMaxElapsedTimeoutError(90_000, "approved_plan_recovery");

  assert.equal(error.code, "STREAM_MAX_ELAPSED_TIMEOUT");
  assert.match(error.message, /maximum stream duration 90000ms exceeded/);
  assert.equal(isStreamWatchdogTimeoutMessage(error.message), true);
});

test("detects reasoning-dominated length results before max output escalation", () => {
  assert.equal(
    isReasoningDominatedLengthResult({
      content: `<thinking>${"需要继续分析。".repeat(500)}</thinking>`,
      reasoningContent: "需要继续分析。".repeat(500),
      finishReason: "length",
      toolCalls: [],
    }),
    true,
  );

  assert.equal(
    isReasoningDominatedLengthResult({
      content: `<thinking>${"需要继续分析。".repeat(500)}</thinking>\n## Plan\n${"用户可见方案。".repeat(120)}`,
      reasoningContent: "需要继续分析。".repeat(500),
      finishReason: "length",
      toolCalls: [],
    }),
    false,
  );

  // New test case for embedded thinking blocks (e.g. Qwen on OMLX)
  assert.equal(
    isReasoningDominatedLengthResult({
      content: `<thinking>${"需要继续分析。".repeat(500)}</thinking>`,
      reasoningContent: "",
      finishReason: "length",
      toolCalls: [],
    }),
    true,
  );
});

test("suppresses generic truncation warning for hidden-only unapproved plan length", () => {
  assert.equal(shouldSuppressPlanTruncationWarning({
    workflowMode: "plan",
    isPlanApproved: false,
    finishReason: "length",
    reasoningOnly: true,
  }), true);

  assert.equal(shouldSuppressPlanTruncationWarning({
    workflowMode: "plan",
    isPlanApproved: false,
    finishReason: "length",
    reasoningOnly: false,
  }), false);
});

test("detects reasoning-only no-action results even without length finish", () => {
  assert.equal(
    isReasoningDominatedNoActionResult({
      content: "",
      reasoningContent: "内部分析。".repeat(400),
      toolCalls: [],
    }),
    true,
  );

  assert.equal(
    isReasoningDominatedNoActionResult({
      content: "我已经修好了。",
      reasoningContent: "内部分析。".repeat(400),
      toolCalls: [{ name: "write_file", arguments: "{}", id: "call_1" }],
    }),
    false,
  );
});

test("keeps local pre-approval plan text protocol as notice-only", () => {
  assert.equal(
    shouldUsePlanNoVisibleTokenWatchdog({
      workflowMode: "plan",
      isPlanApproved: false,
      nativeToolCount: 0,
      activeProfile: "local",
      provider: "Ollama",
      toolProtocol: "xml",
    }),
    false,
  );

  assert.equal(
    shouldUsePlanNoVisibleTokenWatchdog({
      workflowMode: "plan",
      isPlanApproved: false,
      nativeToolCount: 0,
      activeProfile: "local",
      provider: "OMLX",
      toolProtocol: "auto",
    }),
    false,
  );
});

test("keeps local native no-token stalls under the hard watchdog when no native tools are attached", () => {
  assert.equal(
    shouldUsePlanNoVisibleTokenWatchdog({
      workflowMode: "plan",
      isPlanApproved: false,
      nativeToolCount: 0,
      activeProfile: "local",
      provider: "OMLX",
      toolProtocol: "native",
    }),
    true,
  );
});

test("enables no-visible-token watchdog for cloud pre-approval plan text protocol", () => {
  assert.equal(
    shouldUsePlanNoVisibleTokenWatchdog({
      workflowMode: "plan",
      isPlanApproved: false,
      nativeToolCount: 0,
      activeProfile: "cloud",
      provider: "OpenAI",
      toolProtocol: "xml",
    }),
    true,
  );
  assert.equal(
    shouldUsePlanNoVisibleTokenWatchdog({
      workflowMode: "plan",
      isPlanApproved: true,
      nativeToolCount: 0,
      activeProfile: "cloud",
      provider: "OpenAI",
      toolProtocol: "xml",
    }),
    false,
  );
  assert.equal(
    shouldUsePlanNoVisibleTokenWatchdog({
      workflowMode: "plan",
      isPlanApproved: false,
      nativeToolCount: 2,
      activeProfile: "cloud",
      provider: "OpenAI",
      toolProtocol: "native",
    }),
    false,
  );
  assert.equal(
    shouldUsePlanNoVisibleTokenWatchdog({
      workflowMode: "edit",
      isPlanApproved: false,
      nativeToolCount: 0,
      activeProfile: "cloud",
      provider: "OpenAI",
      toolProtocol: "xml",
    }),
    false,
  );
});

test("plan closure guard runs before empty checkpoint when read-only evidence exists", () => {
  assert.equal(
    shouldAttemptPlanClosureGuard({
      workflowMode: "plan",
      isPlanApproved: false,
      hasReviewablePlanArtifacts: false,
      evidenceCount: 3,
      consecutiveEmptyResponseCount: 2,
      toolCallCount: 0,
      replyOptionCount: 0,
    }),
    true,
  );

  assert.equal(
    shouldAttemptPlanClosureGuard({
      workflowMode: "plan",
      isPlanApproved: false,
      hasReviewablePlanArtifacts: false,
      evidenceCount: 0,
      consecutiveEmptyResponseCount: 2,
      toolCallCount: 0,
      replyOptionCount: 0,
    }),
    false,
  );

  assert.equal(
    shouldAttemptPlanClosureGuard({
      workflowMode: "plan",
      isPlanApproved: false,
      hasReviewablePlanArtifacts: true,
      evidenceCount: 3,
      consecutiveEmptyResponseCount: 2,
      toolCallCount: 0,
      replyOptionCount: 0,
    }),
    false,
  );
});

test("plan read-only batches defer no-progress pause to convergence guard", () => {
  assert.equal(
    shouldDeferNoProgressStopToPlanReadOnlyConvergence({
      workflowMode: "plan",
      isPlanApproved: false,
      hasPlanDecisionOutput: false,
      resultCount: 1,
      successfulReadOnlyResultCount: 1,
      nonReadOnlySuccessfulResultCount: 0,
    }),
    true,
  );

  assert.equal(
    shouldDeferNoProgressStopToPlanReadOnlyConvergence({
      workflowMode: "plan",
      isPlanApproved: false,
      hasPlanDecisionOutput: true,
      resultCount: 1,
      successfulReadOnlyResultCount: 1,
      nonReadOnlySuccessfulResultCount: 0,
    }),
    false,
  );

  assert.equal(
    shouldDeferNoProgressStopToPlanReadOnlyConvergence({
      workflowMode: "edit",
      isPlanApproved: false,
      hasPlanDecisionOutput: false,
      resultCount: 1,
      successfulReadOnlyResultCount: 1,
      nonReadOnlySuccessfulResultCount: 0,
    }),
    false,
  );

  assert.equal(
    shouldDeferNoProgressStopToPlanReadOnlyConvergence({
      workflowMode: "plan",
      isPlanApproved: false,
      hasPlanDecisionOutput: false,
      resultCount: 2,
      successfulReadOnlyResultCount: 1,
      nonReadOnlySuccessfulResultCount: 1,
    }),
    false,
  );
});

test("plan exploration budget redirects repeated broad reads to design closure", () => {
  assert.deepEqual(
    buildPlanExplorationBudget({
      workflowMode: "plan",
      isPlanApproved: false,
      toolName: "list_directory",
      target: ".",
      duplicateCount: 1,
      hasTabularEvidence: false,
    }),
    {
      shouldRedirectToPlanClosure: true,
      reason: "repeated_broad_structure_read",
    },
  );

  assert.equal(
    buildPlanExplorationBudget({
      workflowMode: "plan",
      isPlanApproved: true,
      toolName: "list_directory",
      target: ".",
      duplicateCount: 2,
      hasTabularEvidence: true,
    }).shouldRedirectToPlanClosure,
    false,
  );
});

test("plan exploration budget redirects broad reads after enough read evidence", () => {
  assert.deepEqual(
    buildPlanExplorationBudget({
      workflowMode: "plan",
      isPlanApproved: false,
      toolName: "get_project_skeleton",
      duplicateCount: 0,
      hasTabularEvidence: false,
      successfulReadEvidenceCount: 2,
    }),
    {
      shouldRedirectToPlanClosure: true,
      reason: "sufficient_read_context_already_available",
    },
  );
});
