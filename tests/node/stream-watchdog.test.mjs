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
  computeContextForceReason,
  isReasoningDominatedLengthResult,
  isReasoningDominatedNoActionResult,
  isStreamWatchdogTimeoutMessage,
  permitsConfiguredMaxOutputEscalation,
  shouldAttemptPlanClosureGuard,
  shouldDeferNoProgressStopToPlanReadOnlyConvergence,
  shouldUsePlanNoVisibleTokenWatchdog,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/orchestrator.ts"));
const streamInvocationSource = fsSync.readFileSync(
  path.join(workspaceRoot, "src/lib/orchestrator/loop/streamInvocation.ts"),
  "utf8",
);
const {
  shouldSuppressPlanTruncationWarning,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/planRuntime.ts"));
const {
  SUBAGENT_FINAL_STREAM_MAX_OUTPUT_TOKENS,
  SUBAGENT_TOOL_STREAM_MAX_OUTPUT_TOKENS,
  capSubagentStreamMaxEscalations,
  capSubagentStreamMaxTokens,
  resolveRecoveryToolChoice,
} = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/lib/orchestrator/loop/streamInvocation.ts"),
);
const {
  resolveExecuteRecoveryActionContract,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/executeRecoveryTools.ts"));
const {
  resolveExecuteMaxIterationsRecoveryDecision,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/planExecutionRecovery.ts"));
const {
  APPROVED_PLAN_STREAM_WATCHDOG_RETRY_MAX_ELAPSED_MS,
  PREAPPROVAL_PLAN_STREAM_WATCHDOG_RETRY_MAX_ELAPSED_MS,
  buildApprovedPlanStreamWatchdogRecoveryPrompt,
  buildPreapprovalPlanStreamWatchdogRecoveryPrompt,
  observeFileReadContextForMessagesSent,
  replaceMessagesForRetry,
  resolvePreapprovalPlanStreamWatchdogReadFallback,
  resolvePreapprovalPlanStreamWatchdogRecoveryTools,
  shouldAttemptApprovedPlanStreamWatchdogRecovery,
  shouldAttemptPreapprovalPlanStreamWatchdogRecovery,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/streamRecovery.ts"));

test("subagent tool and final streams use separate bounded output budgets", () => {
  assert.equal(SUBAGENT_TOOL_STREAM_MAX_OUTPUT_TOKENS, 4_096);
  assert.equal(SUBAGENT_FINAL_STREAM_MAX_OUTPUT_TOKENS, 2_048);
  assert.equal(capSubagentStreamMaxTokens(1, undefined), 4_096);
  assert.equal(capSubagentStreamMaxTokens(1, 8_192), 4_096);
  assert.equal(capSubagentStreamMaxTokens(2, 1_024), 1_024);
  assert.equal(capSubagentStreamMaxEscalations(1, 2), 1);
  assert.equal(capSubagentStreamMaxTokens(1, 8_192, true), 2_048);
  assert.equal(capSubagentStreamMaxEscalations(1, 2, true), 0);

  assert.equal(capSubagentStreamMaxTokens(0, undefined), undefined);
  assert.equal(capSubagentStreamMaxTokens(0, 8_192), 8_192);
  assert.equal(capSubagentStreamMaxEscalations(0, 2), 2);

  assert.equal(permitsConfiguredMaxOutputEscalation(undefined, undefined), true);
  assert.equal(permitsConfiguredMaxOutputEscalation(4_096, undefined), false);
  assert.equal(permitsConfiguredMaxOutputEscalation(4_096, 0), false);
  assert.equal(permitsConfiguredMaxOutputEscalation(4_096, 1), true);
});

test("exact messages sent to the model advance file-read eviction independently of token reduction", () => {
  const exactRead = `READ_FILE_RESULT\n${"x".repeat(1_200)}\nTAIL_MARKER`;
  const state = {
    signature: "read_file::src/App.tsx::[]",
    path: "src/App.tsx",
    argsKey: "[]",
    contentHash: "same-version",
    contentLength: exactRead.length,
    sizeBytes: 1_200,
    modifiedMs: 1,
    modelContent: exactRead,
    contextEvictionEpoch: 2,
    updatedAt: 1,
  };
  const fileReadStates = new Map([[state.signature, state]]);
  const beforeMessages = [{ role: "tool", content: exactRead }];
  const messagesSentToLLM = [{ role: "user", content: exactRead.slice(0, 800) }];

  assert.equal(observeFileReadContextForMessagesSent({
    fileReadStates,
    beforeMessages,
    messagesSentToLLM,
    iteration: 3,
    reason: "xml_protocol_test",
  }), 1);
  assert.equal(state.contextEvictionEpoch, 3);

  let activeMessages = beforeMessages;
  replaceMessagesForRetry({
    callbacks: {
      getMessages: () => activeMessages,
      replaceMessages: (messages) => {
        activeMessages = messages;
      },
    },
    iteration: 4,
    messages: messagesSentToLLM,
    fileReadStates,
    reason: "emergency_zero_reduction_test",
    changed: false,
  });
  assert.deepEqual(activeMessages, messagesSentToLLM);
  assert.equal(state.contextEvictionEpoch, 4);
});

test("approved Plan provenance keeps execute compaction and stream bounds in edit workflow", () => {
  const force = computeContextForceReason({
    messages: [{ role: "tool", content: "x".repeat(40_000) }],
    iteration: 6,
    workflowMode: "edit",
    isPlanApproved: true,
    inputBudget: 20_000,
    proactiveTriggerBudget: 20_000,
  });
  assert.equal(force.shouldForce, true);
  assert.equal(force.reason, "approved_plan_loop_interval");
  assert.doesNotMatch(
    streamInvocationSource,
    /workflowMode === "plan"\s*&&\s*callbacks\.getIsPlanApproved\(\)/,
  );
});

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

test("classifies a visible-text repetition guard as a stream watchdog stop", () => {
  assert.equal(
    isStreamWatchdogTimeoutMessage("STREAM_VISIBLE_TEXT_REPETITION: model repeated a visible cycle"),
    true,
  );
});

test("preapproval Plan watchdog failures get one provider-neutral bounded recovery", () => {
  assert.equal(PREAPPROVAL_PLAN_STREAM_WATCHDOG_RETRY_MAX_ELAPSED_MS, 120_000);
  assert.equal(shouldAttemptPreapprovalPlanStreamWatchdogRecovery({
    message: "STREAM_VISIBLE_TEXT_REPETITION: model repeated a visible cycle",
    workflowMode: "plan",
    runtimeIntent: "plan",
    isPlanApproved: false,
    qualityRecoveryActive: false,
  }), true);
  assert.equal(shouldAttemptPreapprovalPlanStreamWatchdogRecovery({
    message: "STREAM_VISIBLE_TEXT_REPETITION: model repeated a visible cycle",
    workflowMode: "plan",
    runtimeIntent: "plan",
    isPlanApproved: false,
    qualityRecoveryActive: true,
  }), false);
  assert.equal(shouldAttemptPreapprovalPlanStreamWatchdogRecovery({
    message: "STREAM_VISIBLE_TEXT_REPETITION: model repeated a visible cycle",
    workflowMode: "plan",
    runtimeIntent: "execute",
    isPlanApproved: true,
    qualityRecoveryActive: false,
  }), false);
  assert.match(buildPreapprovalPlanStreamWatchdogRecoveryPrompt("en", true), /exactly one targeted read-only tool/i);
  assert.match(buildPreapprovalPlanStreamWatchdogRecoveryPrompt("zh", false), /完整可审批/);
});

test("preapproval Plan watchdog recovery narrows to core read-only evidence tools", () => {
  const tool = (name) => ({
    type: "function",
    function: {
      name,
      description: name,
      parameters: { type: "object", properties: {}, required: [] },
    },
  });
  const recovered = resolvePreapprovalPlanStreamWatchdogRecoveryTools([
    tool("apply_patch"),
    tool("read_file"),
    tool("run_command"),
    tool("grep_search"),
    tool("browser_evaluate"),
    tool("list_directory"),
    tool("get_file_outline"),
  ]);

  assert.deepEqual(recovered.map((entry) => entry.function.name), [
    "read_file",
    "grep_search",
    "list_directory",
    "get_file_outline",
  ]);
});

test("preapproval Plan watchdog injects one safe read for a unique explicit unread target", () => {
  const readTool = {
    type: "function",
    function: {
      name: "read_file",
      description: "read",
      parameters: { type: "object", properties: {}, required: ["path"] },
    },
  };
  const common = {
    messages: [{
      role: "user",
      content: "Please fix src/hooks/useCsvParser.ts after preparing a Plan.",
    }],
    tools: [readTool],
    recentToolActivity: [],
    buildToolCallId: () => "call_read_target",
  };
  const call = resolvePreapprovalPlanStreamWatchdogReadFallback(common);

  assert.equal(call?.id, "call_read_target");
  assert.equal(call?.name, "read_file");
  assert.deepEqual(JSON.parse(call?.arguments || "{}"), {
    path: "src/hooks/useCsvParser.ts",
  });
  assert.equal(resolvePreapprovalPlanStreamWatchdogReadFallback({
    ...common,
    recentToolActivity: [{
      name: "read_file",
      status: "succeeded",
      target: "./src/hooks/useCsvParser.ts",
    }],
  }), null);
  assert.equal(resolvePreapprovalPlanStreamWatchdogReadFallback({
    ...common,
    messages: [{
      role: "user",
      content: "Compare src/a.ts and src/b.ts before planning.",
    }],
  }), null);
});

test("classifies recovery stream max elapsed timeout as watchdog pause", () => {
  const error = createStreamMaxElapsedTimeoutError(90_000, "approved_plan_recovery");

  assert.equal(error.code, "STREAM_MAX_ELAPSED_TIMEOUT");
  assert.match(error.message, /maximum stream duration 90000ms exceeded/);
  assert.equal(isStreamWatchdogTimeoutMessage(error.message), true);
});

test("normal execution does not require a tool before recovery is activated", () => {
  assert.equal(resolveRecoveryToolChoice({
    isExecuteRecoveryEligible: false,
    executeRecoveryMode: "normal",
    llmToolNames: ["read_file", "apply_patch", "run_command"],
    forceXmlTools: false,
  }), undefined);
});

test("preapproval plan quality recovery requires a native plan artifact call", () => {
  const common = {
    isExecuteRecoveryEligible: false,
    executeRecoveryMode: "normal",
    llmToolNames: ["read_file", "write_plan"],
    forceXmlTools: false,
  };
  assert.equal(resolveRecoveryToolChoice({
    ...common,
    preapprovalPlanQualityRecoveryToolChoice: "required",
  }), "required");
  assert.equal(resolveRecoveryToolChoice({
    ...common,
    forceXmlTools: true,
    preapprovalPlanQualityRecoveryToolChoice: "required",
  }), undefined);
});

test("local recovery binds only genuinely single-capability phases", () => {
  const streamInvocationSource = fsSync.readFileSync(
    path.join(workspaceRoot, "src/lib/orchestrator/loop/streamInvocation.ts"),
    "utf8",
  );
  assert.doesNotMatch(
    streamInvocationSource,
    /nextRequiredCapability\s*===/,
    "the provider transport must not maintain a second capability-to-tool mapping",
  );
  assert.deepEqual(
    resolveExecuteRecoveryActionContract("normal").toolCallRequirement,
    { kind: "optional" },
  );
  assert.equal(resolveRecoveryToolChoice({
    isExecuteRecoveryEligible: true,
    executeRecoveryMode: "mutation_first",
    llmToolNames: ["apply_patch", "replace_in_file", "write_file"],
    forceXmlTools: false,
    preferExplicitFunction: true,
  }), "required");

  const targetedReadContract = resolveExecuteRecoveryActionContract("patch_recovery_read", {
    expectedTarget: "src/App.tsx",
    readLease: {
      purpose: "missing_window",
      target: "src/App.tsx",
      state: "available",
    },
  });
  assert.deepEqual(targetedReadContract.toolCallRequirement, {
    kind: "required_named",
    toolName: "read_file",
  });
  assert.deepEqual(resolveRecoveryToolChoice({
    isExecuteRecoveryEligible: true,
    executeRecoveryMode: "patch_recovery_read",
    llmToolNames: ["read_file"],
    forceXmlTools: false,
    preferExplicitFunction: true,
    recoveryActionContract: targetedReadContract,
  }), { type: "function", function: { name: "read_file" } });

  assert.equal(resolveRecoveryToolChoice({
    isExecuteRecoveryEligible: true,
    executeRecoveryMode: "patch_recovery_read",
    llmToolNames: ["run_command"],
    forceXmlTools: false,
    preferExplicitFunction: true,
    recoveryActionContract: targetedReadContract,
  }), undefined, "a missing named capability must not force an unrelated tool call");
  assert.equal(resolveRecoveryToolChoice({
    isExecuteRecoveryEligible: true,
    executeRecoveryMode: "patch_recovery_read",
    llmToolNames: ["run_command", "wait_subagents"],
    forceXmlTools: false,
    preferExplicitFunction: true,
    recoveryActionContract: targetedReadContract,
  }), undefined, "a child join does not turn a missing exact capability into required-any");

  assert.equal(resolveRecoveryToolChoice({
    isExecuteRecoveryEligible: true,
    executeRecoveryMode: "patch_recovery_read",
    llmToolNames: ["read_file", "wait_subagents"],
    forceXmlTools: false,
    preferExplicitFunction: true,
  }), "required", "a pending child join must not be quarantined by named read_file choice");
});

test("local max-iteration continuation binds the first post-mutation action to run_command", () => {
  const decision = resolveExecuteMaxIterationsRecoveryDecision({
    evidenceLedger: [{
      id: "mutation-before-boundary",
      kind: "file",
      value: "src/App.tsx",
      target: "src/App.tsx",
      sourceTool: "apply_patch",
      createdAt: 1,
    }],
  });

  assert.equal(decision.mode, "finite_validation_only");
  assert.deepEqual(resolveRecoveryToolChoice({
    isExecuteRecoveryEligible: true,
    executeRecoveryMode: decision.mode,
    llmToolNames: ["read_file", "run_command"],
    forceXmlTools: false,
    preferExplicitFunction: true,
  }), { type: "function", function: { name: "run_command" } });
});

test("local recovery tool choice follows the contract next capability, not the legacy mode label", () => {
  const common = {
    isExecuteRecoveryEligible: true,
    executeRecoveryMode: "action_plus_targeting",
    forceXmlTools: false,
    preferExplicitFunction: true,
  };
  const targeting = resolveExecuteRecoveryActionContract("action_plus_targeting", {
    expectedTarget: "src/main.js",
    decisionCheckpoint: {
      expectedTarget: "src/main.js",
      sourceObservationKey: "head-v1",
      nextRequiredCapability: "targeting",
      evidenceVersion: "9000:100",
    },
  });
  assert.equal(resolveRecoveryToolChoice({
    ...common,
    recoveryActionContract: targeting,
    llmToolNames: ["code_ast_query", "find_symbol_references", "get_file_outline"],
  }), "required", "structural targeting is a capability surface, not one hard-coded parser call");
  assert.equal(resolveRecoveryToolChoice({
    ...common,
    recoveryActionContract: targeting,
    llmToolNames: ["run_command"],
  }), undefined, "required-any applies only when an allowed capability tool is truly present");

  const observePty = resolveExecuteRecoveryActionContract("action_plus_targeting", {
    devServerStatus: "running",
    devServerNextCapability: "observe_pty",
  });
  assert.equal(resolveRecoveryToolChoice({
    ...common,
    recoveryActionContract: observePty,
    llmToolNames: ["send_pty_input", "read_pty_tail", "read_pty_since", "get_pty_status"],
  }), "required");

  const recoverProcess = resolveExecuteRecoveryActionContract("action_plus_targeting", {
    devServerStatus: "failed",
    devServerNextCapability: "launch",
  });
  assert.equal(resolveRecoveryToolChoice({
    ...common,
    recoveryActionContract: recoverProcess,
    llmToolNames: ["read_pty_tail", "run_command", "execute_command"],
  }), "required");

  const browser = resolveExecuteRecoveryActionContract("action_plus_targeting", {
    devServerStatus: "ready",
    devServerNextCapability: "browser",
  });
  assert.deepEqual(resolveRecoveryToolChoice({
    ...common,
    recoveryActionContract: browser,
    llmToolNames: ["browser_evaluate"],
  }), { type: "function", function: { name: "browser_evaluate" } });
  assert.deepEqual(resolveRecoveryToolChoice({
    ...common,
    recoveryActionContract: browser,
    llmToolNames: ["browser_evaluate", "git_status", "read_file"],
  }), { type: "function", function: { name: "browser_evaluate" } },
  "an exact browser checkpoint must bind the browser even when the stable execution surface has other tools");

  const migratedPostMutation = resolveExecuteRecoveryActionContract("validation_only", {
    readLease: {
      purpose: "post_mutation_verify",
      target: "src/App.tsx",
      state: "available",
    },
  });
  assert.equal(migratedPostMutation.readLease, null);
  assert.equal(migratedPostMutation.nextRequiredCapability, "validation");
  assert.equal(resolveRecoveryToolChoice({
    ...common,
    executeRecoveryMode: "validation_only",
    recoveryActionContract: migratedPostMutation,
    llmToolNames: ["read_file"],
  }), undefined, "validation recovery stays optional when run_command is absent");
});

test("validation recovery binds the command capability selected by the action contract", () => {
  assert.deepEqual(resolveRecoveryToolChoice({
    isExecuteRecoveryEligible: true,
    executeRecoveryMode: "validation_only",
    llmToolNames: ["run_command", "execute_command", "browser_evaluate"],
    forceXmlTools: false,
    preferExplicitFunction: true,
  }), { type: "function", function: { name: "run_command" } });
});

test("approved plan watchdog timeout gets exactly one bounded native-tool recovery opportunity", () => {
  const message = createStreamMaxElapsedTimeoutError(45_000, "approved_plan_recovery").message;
  const base = {
    message,
    activeProfile: "local",
    workflowMode: "plan",
    runtimeIntent: "execute",
    isPlanApproved: true,
    isExecuteRecoveryEligible: false,
    llmToolCount: 7,
    forceXmlTools: false,
  };
  assert.equal(shouldAttemptApprovedPlanStreamWatchdogRecovery(base), true);
  assert.equal(
    shouldAttemptApprovedPlanStreamWatchdogRecovery(base),
    true,
    "normal approved execution gets one bounded watchdog retry",
  );
  assert.equal(shouldAttemptApprovedPlanStreamWatchdogRecovery({
    ...base,
    forceXmlTools: true,
  }), false);
  assert.equal(APPROVED_PLAN_STREAM_WATCHDOG_RETRY_MAX_ELAPSED_MS, 45_000);
  assert.match(buildApprovedPlanStreamWatchdogRecoveryPrompt("zh"), /直接调用一个可用工具/);
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

  const longXmlToolCall = [
    "<tool_use>",
    "<tool>write_file</tool>",
    '<parameter name="path">src/App.tsx</parameter>',
    `<parameter name="content">${"export const value = 1;\n".repeat(500)}</parameter>`,
    "</tool_use>",
  ].join("\n");
  assert.equal(
    isReasoningDominatedLengthResult({
      content: longXmlToolCall,
      actionableContent: longXmlToolCall,
      semanticContent: "",
      reasoningContent: "",
      finishReason: "length",
      toolCalls: [],
    }),
    false,
  );

  const mirroredReasoning = "未闭合后台分析。".repeat(1200);
  assert.equal(
    isReasoningDominatedLengthResult({
      content: mirroredReasoning,
      actionableContent: "",
      semanticContent: "",
      reasoningContent: mirroredReasoning,
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

  assert.equal(
    shouldAttemptPlanClosureGuard({
      workflowMode: "plan",
      isPlanApproved: false,
      hasReviewablePlanArtifacts: false,
      evidenceCount: 2,
      rejectedVisibleCandidate: true,
      toolCallCount: 0,
      replyOptionCount: 0,
    }),
    true,
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
