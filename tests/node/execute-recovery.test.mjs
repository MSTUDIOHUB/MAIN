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

test("execute recovery tool surface removes broad reads but keeps action and targeting tools", () => {
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
    mode: "action_plus_targeting",
  }));

  assert.deepEqual(scoped, [
    "grep_search",
    "get_file_outline",
    "apply_patch",
    "replace_in_file",
    "write_file",
    "execute_command",
    "run_command",
    "browser_evaluate",
    "send_pty_input",
    "get_pty_status",
  ]);
  assert.equal(describeExecuteRecoveryToolSurface("action_plus_targeting"), "action_plus_targeting");
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
    mode: "action_plus_targeting",
    repeatedTargets: summarizeRepeatedExecuteTargets(recent),
    recentActivity: recent,
  });
  assert.match(prompt, /不再开放 `read_file`/);
  assert.match(prompt, /apply_patch|write_file|replace_in_file/);
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
  const source = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator.ts"), "utf8");

  assert.match(source, /execute_recovery_tool_scope_applied/);
  assert.match(source, /const effectiveExecuteRecoveryFileRead =[\s\S]*executeRecoveryMode === "patch_recovery_read" \|\| allowExecuteRecoveryFileRead/);
  assert.match(source, /adaptiveFileReadAllowed: allowExecuteRecoveryFileRead/);
  assert.match(source, /execute_recovery_context_compacted/);
  assert.match(source, /isExecuteRecoveryEligible && contextForceForManagement\?\.shouldForce/);
  assert.match(source, /execute_recovery_context_skipped/);
  assert.match(source, /activateExecuteRecovery\("action_plus_targeting", "execute_convergence_prompt"/);
  assert.match(source, /executeRecoveryAttempts \+= 1/);
  assert.doesNotMatch(source, /executeRecoveryReason !== reason/);
  assert.match(source, /resolveAgentLoopMaxIterations/);
  assert.match(source, /buildMaxStepsFinalTextPrompt/);
  assert.match(source, /recoveryReason: "max_iterations_boundary"/);
  assert.match(source, /normalizeNoProgressResultContent/);
  assert.match(source, /resolveReadOnlyNoProgressTrigger/);
  assert.match(source, /buildChatFinalSynthesisPrompt/);
  assert.match(source, /chat_final_synthesis_activated/);
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
  const source = fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator.ts"), "utf8");

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

