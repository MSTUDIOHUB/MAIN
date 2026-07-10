import test from "node:test";
import assert from "node:assert/strict";
import fsSync from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

import ts from "typescript";

const workspaceRoot = process.cwd();
const transpiledModuleCache = new Map();

function loadTranspiledModuleSync(sourcePath) {
  const normalizedPath = path.resolve(sourcePath);
  if (transpiledModuleCache.has(normalizedPath)) {
    return transpiledModuleCache.get(normalizedPath);
  }

  const source = fsSync.readFileSync(normalizedPath, "utf8");
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
    fileName: normalizedPath,
  }).outputText;

  const module = { exports: {} };
  transpiledModuleCache.set(normalizedPath, module.exports);
  const localRequire = createRequire(normalizedPath);
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
  buildExecuteNoProgressLoopPauseNotice,
  buildExecuteRecoveryPrompt,
  buildExecuteValidationRecoveryPrompt,
  describeExecuteRecoveryToolSurface,
  isExecutePatchMismatchRecoveryActivity,
  isExecuteRecoveryToolName,
  resolveExecuteReadOnlyRecoveryTrigger,
  resolveReadOnlyNoProgressTrigger,
  shouldAllowExecuteRecoveryFileRead,
  summarizeRepeatedExecuteTargets,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/executeRecoveryTools.ts"));

const {
  buildChatFinalSynthesisPrompt,
  buildEmptyModelResponsePauseNotice,
  buildMaxStepsFinalTextPrompt,
  resolveAgentLoopMaxIterations,
  shouldTriggerChatFinalSynthesis,
  shouldUseMaxStepsFinalTextOnly,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/agentLoopSafety.ts"));

const {
  compactContextForExecuteRecovery,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/contextTrim.ts"));

const {
  handleExecuteNoToolRecovery,
  isExecuteRuntimeRequiringEvidence,
  resolveExecuteNoToolCheckpointLimit,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/executeNoToolRecovery.ts"));

const {
  handleMaxIterationBoundary,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/maxIterationBoundary.ts"));

const readOnlyTools = new Set([
  "get_project_skeleton",
  "list_directory",
  "glob_search",
  "grep_search",
  "read_file",
  "read_document",
  "analyze_tabular_document",
  "query_tabular_document",
  "index_workspace_documents",
  "get_file_outline",
  "read_pty_buffer",
  "read_pty_tail",
  "read_pty_since",
  "get_pty_status",
]);

function createExecuteNoToolHarness(language = "en") {
  const appended = [];
  const statuses = [];
  const streamTokens = [];
  const stops = [];
  return {
    appended,
    statuses,
    streamTokens,
    stops,
    callbacks: {
      getPreferredLanguage: () => language,
      appendMessage: (message) => appended.push(message),
      onStatusChange: (status) => statuses.push(status),
      onStreamToken: (token, id) => streamTokens.push({ token, id }),
      onNonActionableStop: (message, reason, progress) => stops.push({ message, reason, progress }),
    },
  };
}

function createExecuteNoToolInput(harness, overrides = {}) {
  return {
    callbacks: harness.callbacks,
    activeProfile: "cloud",
    iteration: 2,
    workflowMode: "edit",
    turnIntent: "execute",
    runtimeIntent: "execute",
    forceXmlTools: false,
    availableToolNames: new Set(["read_file", "apply_patch", "run_command"]),
    effectiveToolCallCount: 0,
    finalReplyOptionsCount: 0,
    shouldPauseForUserChoice: false,
    sawExecuteOperationEvidence: false,
    visibleText: "I have completed the requested changes and verified them.",
    assistantMsgId: "assistant-1",
    consecutiveNoToolCount: 0,
    ...overrides,
  };
}

test("execute no-tool recovery reprompts completion claims without evidence", () => {
  const harness = createExecuteNoToolHarness("en");
  const result = handleExecuteNoToolRecovery(createExecuteNoToolInput(harness));

  assert.equal(result.status, "continue");
  assert.equal(result.consecutiveNoToolCount, 1);
  assert.deepEqual(harness.statuses, ["running"]);
  assert.deepEqual(harness.streamTokens, [{ token: "__ESCALATION_RESET__:", id: "assistant-1" }]);
  assert.equal(harness.appended.length, 1);
  assert.match(harness.appended[0].content, /no real tool evidence/i);
  assert.match(harness.appended[0].content, /Start real tool actions/i);
  assert.equal(harness.stops.length, 0);
});

test("generic max-iteration boundary emits stop, idle, and completion in order", async () => {
  const order = [];
  await handleMaxIterationBoundary({
    callbacks: {
      getPreferredLanguage: () => "en",
      getIsPlanApproved: () => false,
      onNonActionableStop: (_message, reason, progress) => {
        order.push(`stop:${reason}:${progress?.recoveryReason}`);
      },
      onStatusChange: (status) => order.push(`status:${status}`),
    },
    workflowMode: "chat",
    runtimeIntent: "respond",
    effectiveMaxIterations: 8,
    recentPlanToolActivity: [],
    recentToolActivity: [],
    lastAssistantTextForCheckpoint: "",
    sawExecuteOperationEvidence: false,
    executeRecoveryMode: "off",
    emitPlanExecutionProgress: () => {},
    emitTurnCompletedEvent: () => order.push("turn:completed"),
  });

  assert.deepEqual(order, [
    "stop:no_action:max_iterations_boundary",
    "status:idle",
    "turn:completed",
  ]);
});

test("execute no-tool recovery stops local completion loops at checkpoint", () => {
  const harness = createExecuteNoToolHarness("zh");
  const result = handleExecuteNoToolRecovery(createExecuteNoToolInput(harness, {
    activeProfile: "local",
    consecutiveNoToolCount: 4,
    visibleText: "已经修复完成并验证通过。",
  }));

  assert.equal(resolveExecuteNoToolCheckpointLimit("local"), 5);
  assert.equal(resolveExecuteNoToolCheckpointLimit("cloud") < resolveExecuteNoToolCheckpointLimit("local"), true);
  assert.equal(result.status, "stopped");
  assert.equal(result.consecutiveNoToolCount, 5);
  assert.deepEqual(harness.statuses, ["running", "idle"]);
  assert.equal(harness.appended.length, 0);
  assert.equal(harness.stops.length, 1);
  assert.equal(harness.stops[0].reason, "no_action");
  assert.match(harness.stops[0].message, /没有产生真实工具调用或文件变更/);
});

test("execute no-tool recovery reprompts XML profiles to emit executable tool calls", () => {
  const harness = createExecuteNoToolHarness("zh");
  const result = handleExecuteNoToolRecovery(createExecuteNoToolInput(harness, {
    activeProfile: "local",
    forceXmlTools: true,
    turnIntent: "respond",
    runtimeIntent: "studio_workflow",
    visibleText: "我会先修改文件，然后运行验证。",
  }));

  assert.equal(isExecuteRuntimeRequiringEvidence({
    workflowMode: "plan",
    turnIntent: "respond",
    runtimeIntent: "studio_workflow",
  }), true);
  assert.equal(result.status, "continue");
  assert.equal(result.consecutiveNoToolCount, 1);
  assert.deepEqual(harness.statuses, ["running"]);
  assert.equal(harness.appended.length, 1);
  assert.match(harness.appended[0].content, /XML 工具协议/);
  assert.match(harness.appended[0].content, /<tool_use>/);
  assert.match(harness.appended[0].content, /read_file, apply_patch, run_command/);
});

test("execute recovery mutation-first surface removes broad reads and search tools", () => {
  const names = [
    "list_directory",
    "glob_search",
    "grep_search",
    "read_file",
    "read_document",
    "index_workspace_documents",
    "get_file_outline",
    "apply_patch",
    "replace_in_file",
    "write_file",
    "execute_command",
    "run_command",
    "browser_evaluate",
    "send_pty_input",
    "get_pty_status",
  ];
  const scoped = names.filter((name) => isExecuteRecoveryToolName(name, readOnlyTools, {
    mode: "mutation_first",
  }));

  assert.deepEqual(scoped, [
    "apply_patch",
    "replace_in_file",
    "write_file",
    "execute_command",
    "run_command",
    "browser_evaluate",
    "send_pty_input",
    "get_pty_status",
  ]);
  assert.equal(describeExecuteRecoveryToolSurface("mutation_first"), "mutation_first");
  assert.equal(describeExecuteRecoveryToolSurface("mutation_first", true), "mutation_first_plus_patch_file_read");
  assert.equal(isExecuteRecoveryToolName("read_file", readOnlyTools, {
    mode: "mutation_first",
    allowFileRead: true,
  }), true);
  assert.equal(isExecuteRecoveryToolName("grep_search", readOnlyTools, {
    mode: "mutation_first",
    allowFileRead: true,
  }), false);
});

test("repeat-edit validation recovery exposes only validation tools and forbids more edits", () => {
  assert.equal(isExecuteRecoveryToolName("run_command", readOnlyTools, {
    mode: "validation_only",
  }), true);
  assert.equal(isExecuteRecoveryToolName("browser_evaluate", readOnlyTools, {
    mode: "validation_only",
  }), true);
  assert.equal(isExecuteRecoveryToolName("replace_in_file", readOnlyTools, {
    mode: "validation_only",
  }), false);
  assert.equal(isExecuteRecoveryToolName("read_file", readOnlyTools, {
    mode: "validation_only",
  }), false);
  assert.equal(describeExecuteRecoveryToolSurface("validation_only"), "validation_only");

  const prompt = buildExecuteValidationRecoveryPrompt({
    language: "zh",
    reason: "repeat_edit_target_without_validation",
    target: "src/components/Dashboard/CourseBarChart.tsx",
    editCount: 3,
    availableValidationTools: ["run_command", "browser_evaluate"],
  });
  assert.match(prompt, /连续修改同一目标/);
  assert.match(prompt, /必须只调用一个验证工具/);
  assert.match(prompt, /不要继续编辑文件/);
});

test("patch mismatch recovery opens one targeted read_file path", () => {
  const recent = [
    { name: "replace_in_file", status: "failed", target: "src/App.tsx", detail: "search_text not found" },
  ];

  assert.equal(isExecutePatchMismatchRecoveryActivity(recent[0]), true);
  assert.equal(
    isExecutePatchMismatchRecoveryActivity({
      name: "apply_patch",
      status: "failed",
      target: "src/App.tsx",
      detail: "Patch context was not found in src/App.tsx",
    }),
    true,
  );
  assert.equal(shouldAllowExecuteRecoveryFileRead(recent), true);
  assert.equal(
    shouldAllowExecuteRecoveryFileRead([
      { name: "apply_patch", status: "failed", target: "src/App.tsx", detail: "Patch context was not found" },
    ]),
    true,
  );
  assert.equal(isExecuteRecoveryToolName("read_file", readOnlyTools, {
    mode: "patch_recovery_read",
    allowFileRead: true,
  }), true);
  assert.equal(isExecuteRecoveryToolName("list_directory", readOnlyTools, {
    mode: "patch_recovery_read",
    allowFileRead: true,
  }), false);

  assert.equal(
    shouldAllowExecuteRecoveryFileRead([
      ...recent,
      { name: "read_file", status: "succeeded", target: "src/App.tsx", detail: "READ_FILE_RESULT" },
    ]),
    false,
  );

  const prompt = buildExecuteRecoveryPrompt({
    language: "zh",
    reason: "target_progress_patch_mismatch",
    mode: "patch_recovery_read",
    repeatedTargets: ["src/App.tsx"],
    recentActivity: recent,
  });
  assert.match(prompt, /上下文与当前文件不匹配/);
  assert.match(prompt, /不要继续重试基于旧上下文的 `apply_patch`/);
});

test("read-only budget triggers execute recovery before max iterations", () => {
  const recent = Array.from({ length: 8 }, (_value, index) => ({
    name: "read_file",
    status: "succeeded",
    target: index < 4 ? "src/App.tsx" : "src/hooks/useCsvParser.ts",
    detail: index >= 4 ? "FILE_UNCHANGED_STUB: src/hooks/useCsvParser.ts" : "READ_FILE_RESULT",
  }));
  const decision = resolveExecuteReadOnlyRecoveryTrigger({
    results: [{ name: "read_file", target: "src/hooks/useCsvParser.ts", content: "FILE_UNCHANGED_STUB", isError: false }],
    recentActivity: recent,
    readOnlyTools,
    sawExecuteOperationEvidence: false,
    noProgressBatchRepeatCount: 1,
  });

  assert.equal(decision.shouldRecover, true);
  assert.match(decision.reason, /read_only|cached/);
  assert.deepEqual(summarizeRepeatedExecuteTargets(recent), ["src/hooks/useCsvParser.ts", "src/App.tsx"]);

  const prompt = buildExecuteRecoveryPrompt({
    language: "zh",
    reason: decision.reason,
    mode: "mutation_first",
    repeatedTargets: summarizeRepeatedExecuteTargets(recent),
    recentActivity: recent,
  });
  assert.match(prompt, /不再开放 `read_file`/);
  assert.match(prompt, /apply_patch|write_file|replace_in_file/);
  assert.match(prompt, /小型 Codex-style patch 事务/);
  assert.match(prompt, /不要把源码或完整文件粘贴到聊天 Markdown/);
});

test("local cached-read loop recovers before no-progress pause boundary", () => {
  const recent = Array.from({ length: 8 }, (_value, index) => ({
    name: "read_file",
    status: "succeeded",
    target: "src-tauri/src/main.rs",
    detail: index === 0 ? "READ_FILE_RESULT" : "FILE_UNCHANGED_STUB: src-tauri/src/main.rs",
  }));
  const decision = resolveExecuteReadOnlyRecoveryTrigger({
    results: [{ name: "read_file", target: "src-tauri/src/main.rs", content: "FILE_UNCHANGED_STUB", isError: false }],
    recentActivity: recent,
    readOnlyTools,
    sawExecuteOperationEvidence: false,
    noProgressBatchRepeatCount: 4,
    minReadOnlyActivities: 10,
    minCachedReadOnlyActivities: 8,
    maxNoProgressReadOnlyRepeats: 4,
  });

  assert.equal(decision.shouldRecover, true);
  assert.equal(decision.reason, "read_only_no_progress");
  assert.deepEqual(summarizeRepeatedExecuteTargets(recent), ["src-tauri/src/main.rs"]);
});

test("chat read-only no-progress is eligible for final synthesis before max iterations", () => {
  const recent = [
    { name: "read_file", status: "succeeded", target: "src/App.tsx", detail: "READ_FILE_RESULT" },
    { name: "read_file", status: "succeeded", target: "src/App.tsx", detail: "FILE_UNCHANGED_STUB: src/App.tsx" },
    { name: "grep_search", status: "succeeded", target: "onFileLoaded", detail: "5 matches" },
  ];
  const decision = resolveReadOnlyNoProgressTrigger({
    results: [{ name: "read_file", target: "src/App.tsx", content: "FILE_UNCHANGED_STUB", isError: false }],
    recentActivity: recent,
    readOnlyTools,
    sawExecuteOperationEvidence: false,
    noProgressBatchRepeatCount: 1,
    minReadOnlyActivities: 6,
    minCachedReadOnlyActivities: 3,
  });

  assert.equal(decision.shouldRecover, true);
  assert.equal(decision.reason, "repeated_cached_read");
  assert.equal(shouldTriggerChatFinalSynthesis({
    workflowMode: "chat",
    runtimeIntent: "respond",
    toolCallCount: 0,
    recentReadOnlyActivityCount: 6,
    consecutiveNoToolCount: 1,
  }), true);

  const notice = buildExecuteNoProgressLoopPauseNotice({
    language: "zh",
    scope: "chat",
    repeats: 1,
    remainingTask: "只有只读探索，没有最终回答。",
    recentActivity: recent,
  });
  assert.match(notice, /对话已暂停/);
  assert.match(notice, /直接回答/);
});

test("chat read-only no-progress ignores batches after execution evidence", () => {
  const recent = [
    { name: "read_file", status: "succeeded", target: "src/components/toolbar.js", detail: "READ_FILE_RESULT" },
    { name: "replace_in_file", status: "succeeded", target: "src/components/toolbar.js", detail: "updated successfully" },
    { name: "read_file", status: "succeeded", target: "src/components/toolbar.js", detail: "FILE_UNCHANGED_STUB: src/components/toolbar.js" },
  ];
  const decision = resolveReadOnlyNoProgressTrigger({
    results: [{ name: "read_file", target: "src/components/toolbar.js", content: "FILE_UNCHANGED_STUB", isError: false }],
    recentActivity: recent,
    readOnlyTools,
    sawExecuteOperationEvidence: true,
    noProgressBatchRepeatCount: 1,
    minCachedReadOnlyActivities: 1,
  });

  assert.equal(decision.shouldRecover, false);
});

test("chat final synthesis prompt disables tools only for recovery synthesis", () => {
  const prompt = buildChatFinalSynthesisPrompt({
    language: "zh",
    reason: "length_no_tool_chat",
    iteration: 7,
    repeatedTargets: ["src/lib/orchestrator.ts"],
    recentActivity: [
      { name: "read_file", status: "succeeded", target: "src/lib/orchestrator.ts", detail: "READ_FILE_RESULT" },
    ],
  });

  assert.match(prompt, /CHAT_FINAL_SYNTHESIS/);
  assert.match(prompt, /工具已关闭/);
  assert.match(prompt, /不要输出 `<tool_use>`/);
  assert.match(prompt, /src\/lib\/orchestrator\.ts/);
});

test("chat final synthesis trigger is scoped to respond recovery loops", () => {
  assert.equal(shouldTriggerChatFinalSynthesis({
    workflowMode: "chat",
    runtimeIntent: "respond",
    finishReason: "length",
    toolCallCount: 0,
  }), true);
  assert.equal(shouldTriggerChatFinalSynthesis({
    workflowMode: "chat",
    runtimeIntent: "respond",
    wasLanguageMismatchRecovery: true,
    languageMismatchAlreadyRetried: true,
    toolCallCount: 0,
  }), true);
  assert.equal(shouldTriggerChatFinalSynthesis({
    workflowMode: "chat",
    runtimeIntent: "respond",
    finishReason: "length",
    toolCallCount: 1,
  }), false);
  assert.equal(shouldTriggerChatFinalSynthesis({
    workflowMode: "edit",
    runtimeIntent: "execute",
    finishReason: "length",
    toolCallCount: 0,
  }), false);
});

test("agent loop iteration limits are mode-specific and configurable", () => {
  assert.equal(resolveAgentLoopMaxIterations({
    workflowMode: "chat",
    runtimeIntent: "respond",
    isPlanApproved: false,
  }), 25);
  assert.equal(resolveAgentLoopMaxIterations({
    workflowMode: "plan",
    runtimeIntent: "execute",
    isPlanApproved: true,
  }), 50);
  assert.equal(resolveAgentLoopMaxIterations({
    workflowMode: "chat",
    runtimeIntent: "respond",
    isPlanApproved: false,
    limits: { chatRespond: 12 },
  }), 12);
});

test("max-steps final text prompt disables tools for chat final boundary", () => {
  assert.equal(shouldUseMaxStepsFinalTextOnly({
    workflowMode: "chat",
    runtimeIntent: "respond",
    isPlanApproved: false,
    iteration: 25,
    maxIterations: 25,
    alreadyPrompted: false,
  }), true);
  assert.equal(shouldUseMaxStepsFinalTextOnly({
    workflowMode: "plan",
    runtimeIntent: "execute",
    isPlanApproved: true,
    iteration: 50,
    maxIterations: 50,
    alreadyPrompted: false,
  }), false);

  const prompt = buildMaxStepsFinalTextPrompt({
    language: "en",
    iteration: 25,
    maxIterations: 25,
    repeatedTargets: ["src/App.tsx"],
  });
  assert.match(prompt, /MAX_STEPS_FINAL_TEXT/);
  assert.match(prompt, /Do not make any tool calls/);
  assert.match(prompt, /what remains unfinished/);
});

test("empty model response pause explains local-model empty completion instead of waiting for max iterations", () => {
  const notice = buildEmptyModelResponsePauseNotice({
    language: "zh",
    emptyResponses: 2,
    repeatedTargets: ["src/App.tsx"],
    localProfile: true,
  });
  assert.match(notice, /2 次空响应/);
  assert.match(notice, /本地模型/);
  assert.match(notice, /src\/App\.tsx/);
});

test("execute no-progress pause reports edit-mode recent tools instead of empty plan activity", () => {
  const recent = [
    { name: "grep_search", status: "succeeded", target: "rawOrders", detail: "8 matches" },
    { name: "read_file", status: "succeeded", target: "src/hooks/useCsvParser.ts", detail: "READ_FILE_RESULT" },
    { name: "read_file", status: "succeeded", target: "src/hooks/useCsvParser.ts", detail: "FILE_UNCHANGED_STUB: src/hooks/useCsvParser.ts" },
  ];
  const notice = buildExecuteNoProgressLoopPauseNotice({
    language: "zh",
    repeats: 3,
    remainingTask: "停止重复读取，转向写入或验证。",
    recentActivity: recent,
  });

  assert.match(notice, /src\/hooks\/useCsvParser\.ts/);
  assert.match(notice, /最近工具/);
  assert.doesNotMatch(notice, /最近工具：暂无/);
});

test("execute recovery context compaction keeps recent complete tool pairs without orphan tool messages", () => {
  const messages = [
    { role: "system", content: "system prompt" },
    { role: "user", content: "修复数据不显示和深色模式" },
  ];
  for (let index = 0; index < 70; index += 1) {
    const id = `call_${index}`;
    messages.push({
      role: "assistant",
      content: `读取第 ${index} 个文件`,
      tool_calls: [{ id, type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: `src/file${index}.tsx` }) } }],
    });
    messages.push({
      role: "tool",
      tool_call_id: id,
      content: `[MAIN_TOOL_FEEDBACK_V1]{"status":"completed","tool":"read_file","target":"src/file${index}.tsx"}\nREAD_FILE_RESULT path: src/file${index}.tsx\n---CONTENT START---\n${"export const value = 1;\n".repeat(300)}---CONTENT END---`,
    });
  }
  messages.push({ role: "user", content: "EXECUTE_RECOVERY: 请复用上下文转向写入/验证。" });

  const compacted = compactContextForExecuteRecovery(messages, {
    maxMessages: 36,
    maxToolResultMessages: 12,
    maxToolChars: 12_000,
    maxToolCallGroups: 6,
    maxToolResultTokens: 320,
    now: 123,
  });

  const toolMessages = compacted.messages.filter((message) => message.role === "tool");
  const toolChars = toolMessages.reduce((sum, message) => sum + String(message.content || "").length, 0);
  assert.equal(compacted.messages.length <= 36, true);
  assert.equal(toolMessages.length <= 12, true);
  assert.equal(toolChars <= 12_000, true);
  assert.match(String(compacted.messages[1]?.content || ""), /ContextMemoryState/);
  assert.match(JSON.stringify(compacted.messages), /EXECUTE_RECOVERY/);

  for (const message of compacted.messages) {
    if (message.role !== "assistant" || !Array.isArray(message.tool_calls)) continue;
    const ids = message.tool_calls.map((toolCall) => toolCall.id).filter(Boolean);
    for (const id of ids) {
      assert.equal(toolMessages.some((toolMessage) => toolMessage.tool_call_id === id), true);
    }
  }
});

test("orchestrator wires execute convergence and max-iteration recovery before idle completion", () => {
  const source = (
    fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator.ts"), "utf8") +
    "\n" +
    fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/AgentOrchestrator.ts"), "utf8") +
    "\n" +
    fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/iterationStreamPreparation.ts"), "utf8") +
    "\n" +
    fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/finalTextOnlyToolCallHandling.ts"), "utf8") +
    "\n" +
    fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/loopRecovery.ts"), "utf8") +
    "\n" +
    fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/maxIterationBoundary.ts"), "utf8")
  );
  const streamInvocationSource = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/streamInvocation.ts"), "utf8");
  const toolCallPlanningSource = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/toolCallPlanning.ts"), "utf8");
  const contextManagementSource = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/contextManagement.ts"), "utf8");
  const executeRecoveryRuntimeSource = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/executeRecoveryRuntime.ts"), "utf8");
  const loopControlRuntimeSource = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/loopControlRuntime.ts"), "utf8");
  const loopRuntimeActionsSource = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/loopRuntimeActions.ts"), "utf8");

  assert.match(source, /resolveIterationToolSurface\(\{/);
  assert.match(toolCallPlanningSource, /execute_recovery_tool_scope_applied/);
  assert.match(toolCallPlanningSource, /const effectiveExecuteRecoveryFileRead =[\s\S]*executeRecoveryMode === "patch_recovery_read" \|\| allowExecuteRecoveryFileRead/);
  assert.match(toolCallPlanningSource, /adaptiveFileReadAllowed: allowExecuteRecoveryFileRead/);
  assert.match(source, /prepareManagedMessagesForIteration\(\{/);
  assert.match(contextManagementSource, /execute_recovery_context_compacted/);
  assert.match(contextManagementSource, /isExecuteRecoveryEligible && contextForceForManagement\?\.shouldForce/);
  assert.match(contextManagementSource, /execute_recovery_context_skipped/);
  assert.match(source, /activateExecuteRecovery\("mutation_first", "execute_convergence_prompt"/);
  assert.match(streamInvocationSource, /const recoveryToolChoice =[\s\S]*toolChoice: recoveryToolChoice/);
  assert.match(executeRecoveryRuntimeSource, /attempts: state\.attempts \+ 1/);
  assert.match(executeRecoveryRuntimeSource, /MAX_EXECUTE_RECOVERY_ITERATIONS = 6/);
  assert.doesNotMatch(source, /executeRecoveryReason !== reason/);
  assert.match(loopControlRuntimeSource, /resolveAgentLoopMaxIterations/);
  assert.match(streamInvocationSource, /buildMaxStepsFinalTextPrompt/);
  assert.match(source, /recoveryReason: "max_iterations_boundary"/);
  assert.match(source, /normalizeNoProgressResultContent/);
  assert.match(source, /resolveReadOnlyNoProgressTrigger/);
  assert.match(streamInvocationSource, /buildChatFinalSynthesisPrompt/);
  assert.match(loopRuntimeActionsSource, /chat_final_synthesis_activated/);
  assert.match(source, /chat_readonly_no_progress_final_synthesis/);
  assert.match(source, /chat_final_synthesis_tool_calls_ignored/);
  assert.match(source, /looksLikeRepairExecutionRequest/);
  assert.match(source, /chat_repair_readonly_no_progress_paused/);
  assert.match(source, /unresolvedRepairRequest/);

  const callbackIndex = source.indexOf("const handled = await callbacks.onExecuteMaxIterationsCheckpoint?.(checkpoint);");
  const idleIndex = source.indexOf("callbacks.onStatusChange(\"idle\");", callbackIndex);
  assert.equal(callbackIndex > 0, true);
  assert.equal(idleIndex > callbackIndex, true);
});

test("orchestrator evidence reconcile logs failed tool summaries", () => {
  const source = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/toolResultPostProcessing.ts"), "utf8");

  assert.match(source, /failedEvidenceResults/);
  assert.match(source, /firstFailureReason/);
  assert.match(source, /firstFailureLifecycleState/);
  assert.match(source, /firstFailureTool/);
  assert.match(source, /firstFailureTarget/);
});

test("execute recovery does not trigger on a single cached read when minCachedReadOnlyActivities is set", () => {
  const recent = [
    { name: "read_file", status: "succeeded", target: "src/App.tsx", detail: "FILE_UNCHANGED_STUB: src/App.tsx" }
  ];
  const decision = resolveExecuteReadOnlyRecoveryTrigger({
    results: [{ name: "read_file", target: "src/App.tsx", content: "FILE_UNCHANGED_STUB", isError: false }],
    recentActivity: recent,
    readOnlyTools,
    sawExecuteOperationEvidence: false,
    noProgressBatchRepeatCount: 1,
    minCachedReadOnlyActivities: 3,
  });

  assert.equal(decision.shouldRecover, false);
});

test("execute recovery detects cached reads across changing batch signatures", () => {
  const recent = [
    { name: "read_file", status: "succeeded", target: "src/App.tsx", detail: "FILE_UNCHANGED_STUB: src/App.tsx" },
    { name: "read_file", status: "succeeded", target: "src/lib/router.ts", detail: "READ_ONLY_REPEAT_LIMIT: duplicate read" },
    { name: "read_file", status: "succeeded", target: "src/store/useAppStore.ts", detail: "CACHED_FILE_REPLAY: unchanged file replay" },
  ];
  const decision = resolveExecuteReadOnlyRecoveryTrigger({
    results: [{ name: "read_file", target: "src/store/useAppStore.ts", content: "CACHED_FILE_REPLAY: unchanged file replay", isError: false }],
    recentActivity: recent,
    readOnlyTools,
    sawExecuteOperationEvidence: false,
    noProgressBatchRepeatCount: 1,
    minReadOnlyActivities: 99,
    minCachedReadOnlyActivities: 3,
    minRepeatedReadOnlyTargetScore: 99,
  });

  assert.equal(decision.shouldRecover, true);
  assert.equal(decision.reason, "repeated_cached_read");
  assert.equal(decision.cachedReadOnlyActivityCount, 3);
});

test("execute recovery treats covered-window reads on the same target as no progress", () => {
  const recent = [
    { name: "read_file", status: "succeeded", target: "src/lib/orchestrator/loop/AgentOrchestrator.ts", detail: "READ_FILE_RESULT lines 1-120" },
    { name: "read_file", status: "succeeded", target: "src/lib/orchestrator/loop/AgentOrchestrator.ts", detail: "READ_FILE_WINDOW_NARROWED: overlapping unchanged lines already in context" },
    { name: "read_file", status: "succeeded", target: "src/lib/orchestrator/loop/AgentOrchestrator.ts", detail: "FILE_UNCHANGED_STUB: requested window is already covered by unchanged earlier read_file results" },
    { name: "read_file", status: "succeeded", target: "src/lib/orchestrator/loop/AgentOrchestrator.ts", detail: "READ_FILE_RESULT lines 300-340" },
  ];
  const decision = resolveExecuteReadOnlyRecoveryTrigger({
    results: [{ name: "read_file", target: "src/lib/orchestrator/loop/AgentOrchestrator.ts", content: "READ_FILE_RESULT lines 300-340", isError: false }],
    recentActivity: recent,
    readOnlyTools,
    sawExecuteOperationEvidence: false,
    noProgressBatchRepeatCount: 1,
    minReadOnlyActivities: 99,
    minCachedReadOnlyActivities: 99,
    minRepeatedReadOnlyTargetScore: 6,
  });

  assert.equal(decision.shouldRecover, true);
  assert.equal(decision.reason, "target_repeated_read_only");
  assert.equal(decision.repeatedReadOnlyTargetScore >= 6, true);
});

test("targeting search recovery opens read_file path to see context", () => {
  const recent = [
    { name: "grep_search", status: "succeeded", target: "Order", detail: "Order" },
  ];
  assert.equal(shouldAllowExecuteRecoveryFileRead(recent), true);
});
