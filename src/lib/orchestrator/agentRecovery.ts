import type { ResolvedUserIntent } from "../runIntent";
import type { StreamResult } from "../streaming";
import { generateId } from "../utils";
import { detectResponseLanguageMismatch } from "../workflowModels";
import {
  summarizeRepeatedPlanTargetsFromToolActivity,
  type PlanToolActivitySummary,
} from "../planExecutionRecovery";

type WorkflowMode = "chat" | "edit" | "plan";

export interface PseudoToolRecoveryDecision {
  call: { id: string; name: string; arguments: string } | null;
  requestedToolName: string | null;
  recoveredToolName: string | null;
  reason: string;
  mentionedPathCount: number;
  argumentKeys: string[];
}

interface MessageWithMaybeTextContent {
  role: string;
  content: unknown;
}

export function buildExecuteNoActionPauseMessage(input: {
  language: "zh" | "en";
  recentToolActivity: PlanToolActivitySummary[];
  visibleText?: string;
}): string {
  const repeatedTargets = summarizeRepeatedPlanTargetsFromToolActivity(input.recentToolActivity);
  const recent = input.recentToolActivity
    .slice(-6)
    .map((activity) => {
      const target = activity.target ? ` ${activity.target}` : "";
      const detail = activity.detail ? ` - ${activity.detail}` : "";
      return `${activity.status}:${activity.name}${target}${detail}`;
    })
    .map((line) => truncateForLog(line, 180));
  const visible = truncateForLog(input.visibleText || "", 220);

  if (input.language === "zh") {
    return [
      "执行已暂停：模型已经读取/分析了上下文，但没有转向真实写入、命令验证或明确结论。",
      repeatedTargets.length > 0 ? `重复目标：${repeatedTargets.join("、")}` : "",
      recent.length > 0 ? `最近有效进展：\n${recent.map((line) => `- ${line}`).join("\n")}` : "",
      visible ? `模型最后可见输出：${visible}` : "",
      "恢复时不要在文件未变化且结果仍在上下文时重复同一读取范围；文件修改后、结果已淘汰或需要不同范围时可以重读。否则请基于已读内容直接写入/替换、运行验证命令，或说明阻塞在什么具体证据/权限/业务选择上。",
    ].filter(Boolean).join("\n");
  }

  return [
    "Execution paused: the model read/analyzed context but did not pivot to a real write, command validation, or clear conclusion.",
    repeatedTargets.length > 0 ? `Repeated targets: ${repeatedTargets.join(", ")}` : "",
    recent.length > 0 ? `Recent effective progress:\n${recent.map((line) => `- ${line}`).join("\n")}` : "",
    visible ? `Last visible model output: ${visible}` : "",
    "On resume, do not reread the same range while the file is unchanged and that result remains active; reread after mutation, eviction, or for a different required range. Otherwise use cached context to patch/write, validate, or state the concrete evidence/permission/business-choice blocker.",
  ].filter(Boolean).join("\n");
}

export function isReasoningModelName(modelName: string | null | undefined): boolean {
  if (!modelName) return false;
  const lower = modelName.toLowerCase();
  return /deepseek-r1|qwq|reasoning|thinking|o1|o3/i.test(lower);
}

export function isReasoningDominatedLengthResult(
  result: Pick<StreamResult, "content" | "actionableContent" | "semanticContent" | "finishReason" | "reasoningContent" | "toolCalls">,
  isLocal?: boolean,
  isReasoningModel?: boolean,
): boolean {
  if (result.finishReason !== "length") return false;
  return isReasoningDominatedNoActionResult(result, isLocal, isReasoningModel);
}

export function isReasoningDominatedNoActionResult(
  result: Pick<StreamResult, "content" | "actionableContent" | "semanticContent" | "reasoningContent" | "toolCalls">,
  isLocal?: boolean,
  isReasoningModel?: boolean,
): boolean {
  if (Array.isArray(result.toolCalls) && result.toolCalls.length > 0) return false;
  if (isReasoningModel) return false;

  const reasoningChars = String(result.reasoningContent || "").trim().length;
  const semanticContent = typeof result.actionableContent === "string"
    ? result.actionableContent
    : typeof result.semanticContent === "string"
    ? result.semanticContent
    : result.content;
  const visibleChars = stripReasoningBlocksForEscalation(semanticContent).length;

  // Count reasoning blocks embedded within visible content (e.g. <thought>...</thought>)
  const embeddedReasoningChars = Math.max(0, String(result.content || "").length - visibleChars);
  const totalReasoningChars = reasoningChars + embeddedReasoningChars;

  const threshold = isLocal ? 8000 : 1000;
  if (totalReasoningChars < threshold) return false;

  if (visibleChars <= 240) return true;
  return visibleChars <= 600 && totalReasoningChars >= visibleChars * 6;
}

export function buildReasoningDominatedRecoveryPrompt(language: "zh" | "en", workflowMode: WorkflowMode): string {
  if (language === "en") {
    return workflowMode === "plan"
      ? [
          "The previous model turn produced only hidden reasoning metadata and no tool call, user-visible answer, or plan artifact.",
          "Hidden reasoning is not progress. Continue now with one concrete action: call the next necessary tool, create/update the reviewable plan artifact, or state the exact blocker in user-visible Markdown.",
          "Do not output hidden thinking tags or another plan-shaped internal monologue.",
        ].join("\n")
      : [
          "The previous model turn produced only hidden reasoning metadata and no executable action.",
          "Continue now with one concrete action: patch/write, run a finite command, use browser validation, or give a concise user-visible blocker. Broad reads may be temporarily withheld; reuse the cached context instead of rereading the same files. Do not output hidden thinking tags.",
        ].join("\n");
  }

  return workflowMode === "plan"
    ? [
        "上一轮模型只产生了后台 reasoning 元数据，没有工具调用、用户可见结论或可审批计划文件。",
        "后台思考不算进展。现在必须执行一个真实动作：调用下一步必要工具、生成/更新可审批计划文件，或用普通 Markdown 说明精确阻塞点。",
        "不要再输出 hidden thinking 标签，也不要继续写内部独白式方案。",
      ].join("\n")
    : [
        "上一轮模型只产生了后台 reasoning 元数据，没有可执行动作。",
        "现在必须执行一个真实动作：写入/替换、运行有限命令、浏览器验证，或用普通 Markdown 给出精确阻塞点。宽泛读取工具可能会被临时收起；请复用已缓存上下文，不要重复读同一批文件。不要输出 hidden thinking 标签。",
      ].join("\n");
}

export function buildReasoningDominatedPauseMessage(language: "zh" | "en", workflowMode: WorkflowMode): string {
  if (language === "en") {
    return [
      "Paused: the model repeatedly returned hidden reasoning without tools or visible progress.",
      workflowMode === "plan"
        ? "A Plan run must advance through a reviewable artifact, tool evidence, edits, commands, browser validation, or an explicit blocker."
        : "A run must advance through a user-visible answer, tool evidence, edits, commands, validation, or an explicit blocker.",
      "Resume after switching to a concrete action target or a model/profile that does not emit reasoning-only completions.",
    ].join("\n\n");
  }

  return [
    "已暂停：模型连续返回后台 reasoning，但没有工具调用或可见进展。",
    workflowMode === "plan"
      ? "Plan 流程必须通过可审批计划文件、工具证据、编辑、命令、浏览器验证或明确阻塞点推进。"
      : "执行流程必须通过用户可见结论、工具证据、编辑、命令、验证或明确阻塞点推进。",
    "恢复前建议先切到具体动作目标，或换用不会持续输出 reasoning-only 的模型/配置。",
  ].join("\n\n");
}

export function buildLanguageMismatchRecoveryPrompt(language: "zh" | "en"): string {
  return language === "zh"
    ? [
        "上一条可见回复语言与本轮目标语言不一致。",
        "不要解释语言策略，也不要复述过程。",
        "请基于已完成的上下文与证据，重新输出同等结论，并且必须使用简体中文。",
      ].join("\n")
    : [
        "The previous visible reply used the wrong language for this turn.",
        "Do not explain language policy and do not repeat process narration.",
        "Using the existing context and evidence, restate the same conclusion in English.",
      ].join("\n");
}

export function shouldRecoverLanguageMismatchTurn(input: {
  text: string;
  targetLanguage: "zh" | "en";
  suppressedByPlanGuard: boolean;
  toolCallCount: number;
  alreadyRetried: boolean;
}): {
  action: "recover_once" | "hide_text_continue" | "pass";
  shouldRecover: boolean;
  exhausted: boolean;
  hideTextForToolCall: boolean;
  mismatch: boolean;
  detectedLanguage: "zh" | "en" | null;
  hanCount: number;
  latinLetters: number;
  latinWords: number;
} {
  const mismatch = detectResponseLanguageMismatch({
    text: input.text,
    targetLanguage: input.targetLanguage,
  });
  const hasActionableMismatch =
    !input.suppressedByPlanGuard &&
    input.text.trim().length > 0 &&
    mismatch.mismatch;
  const hideTextForToolCall =
    hasActionableMismatch &&
    input.toolCallCount > 0;
  const shouldRecover =
    hasActionableMismatch &&
    input.toolCallCount === 0 &&
    !input.alreadyRetried;
  const exhausted =
    hasActionableMismatch &&
    input.alreadyRetried &&
    input.toolCallCount === 0;
  return {
    action: shouldRecover ? "recover_once" : hideTextForToolCall ? "hide_text_continue" : "pass",
    shouldRecover,
    exhausted,
    hideTextForToolCall,
    mismatch: mismatch.mismatch,
    detectedLanguage: mismatch.detectedLanguage,
    hanCount: mismatch.hanCount,
    latinLetters: mismatch.latinLetters,
    latinWords: mismatch.latinWords,
  };
}

export function extractPseudoToolCallName(text: string): string | null {
  const content = String(text || "");
  if (!content.trim()) return null;
  if (/<tool_use>|<tool_call|<function_call/i.test(content)) return null;
  const match = content.match(PSEUDO_TOOL_CALL_RE);
  const name = String(match?.[1] || match?.[2] || "").trim();
  return name || null;
}

export function looksLikePseudoToolCallPlaceholder(text: string): boolean {
  return extractPseudoToolCallName(text) != null;
}

export function looksLikeNonStandardToolCallFormat(text: string): boolean {
  const content = String(text || "");
  if (!content.trim()) return false;
  if (/<tool_use>|<tool_call|<function_call/i.test(content)) return false;
  return NON_STANDARD_TOOL_WRAPPER_RE.test(content);
}

export function buildPseudoToolCallRecoveryPrompt(language: "zh" | "en", workflowMode: WorkflowMode): string {
  const modeText = workflowMode === "chat" ? "read-only/discussion" : workflowMode === "plan" ? "plan" : "execute";
  return language === "zh"
    ? [
        "你刚才输出了非标准工具格式（如 `[Tool call: ...]` 或 `<tool_code>...</tool_code>`），它不是可执行工具调用，MAIN 不能据此执行工具。",
        "如果你需要工具，必须立即用正式 XML 工具协议重发，并补齐所有必填参数：",
        "<tool_use>",
        "<tool>read_file</tool>",
        "<parameter name=\"path\">相对 workspace 的文件路径</parameter>",
        "</tool_use>",
        `当前运行阶段：${modeText}。不要再输出 \`[Tool call: ...]\`、\`<tool_code>...</tool_code>\`，也不要只描述“我要调用工具”。如果缺少路径或参数，请先用可用的只读工具获取上下文，或直接用可见正文说明缺口。`,
      ].join("\n")
    : [
        "You just emitted a non-standard tool format (for example `[Tool call: ...]` or `<tool_code>...</tool_code>`). That is not an executable tool call, so MAIN cannot run a tool from it.",
        "If you need a tool, immediately resend it using the formal XML tool protocol with all required parameters:",
        "<tool_use>",
        "<tool>read_file</tool>",
        "<parameter name=\"path\">workspace-relative file path</parameter>",
        "</tool_use>",
        `Current workflow mode: ${modeText}. Do not output \`[Tool call: ...]\`, \`<tool_code>...</tool_code>\`, or merely describe that you will call a tool. If a path or argument is missing, use an available read-only tool to gather context or explain the gap in visible text.`,
      ].join("\n");
}

export function shouldRecoverExecuteXmlTextWithoutAction(input: {
  workflowMode: WorkflowMode;
  turnIntent: string;
  runtimeIntent: string;
  forceXmlTools: boolean;
  availableToolCount: number;
  toolCallCount: number;
  replyOptionCount: number;
  sawExecuteOperationEvidence: boolean;
  visibleText: string;
  iteration?: number;
}): boolean {
  const visible = String(input.visibleText || "").replace(/\s+/g, " ").trim();
  if (!visible) return false;
  const isExecuteRuntime =
    input.workflowMode === "edit" ||
    input.turnIntent === "execute" ||
    input.runtimeIntent === "execute" ||
    input.runtimeIntent === "studio_workflow";
  return (
    isExecuteRuntime &&
    input.forceXmlTools &&
    input.availableToolCount > 0 &&
    input.toolCallCount === 0 &&
    input.replyOptionCount === 0 &&
    !input.sawExecuteOperationEvidence
  );
}

export function buildExecuteXmlTextActionRecoveryPrompt(input: {
  language: "zh" | "en";
  retryCount: number;
  availableTools: string[];
}): string {
  const toolList = input.availableTools.slice(0, 16).join(", ");
  if (input.language === "en") {
    return [
      "The previous execute reply was plain text, but this local profile uses XML tool calls. Plain text is not executable progress in an execute turn.",
      toolList ? `Available tools include: ${toolList}.` : "",
      "Continue with exactly one of these outcomes:",
      "1. If the task can proceed, output exactly one valid XML `<tool_use>` block and no surrounding prose.",
      "2. If a real permission, evidence, or product-choice blocker prevents action, output concise Markdown plus `<user_options>` choices and stop.",
      "Valid XML shape:",
      "<tool_use>",
      "<tool>read_file</tool>",
      "<parameter name=\"path\">workspace-relative path</parameter>",
      "</tool_use>",
      input.retryCount > 1 ? "This is a repeated protocol miss. Do not summarize or sign off without tool evidence." : "",
    ].filter(Boolean).join("\n");
  }

  return [
    "上一条 Execute 回复只是普通文本，但当前本地 profile 使用 XML 工具协议。普通文字在执行回合里不会变成真实进展。",
    toolList ? `可用工具包括：${toolList}。` : "",
    "下一条只能完成以下其一：",
    "1. 如果任务还能推进，只输出一个合法 XML `<tool_use>` 块，不要包裹解释或总结。",
    "2. 如果确实被权限、证据或产品选择阻塞，用简短 Markdown 说明阻塞点，并输出 `<user_options>` 选项后停止。",
    "合法 XML 形状：",
    "<tool_use>",
    "<tool>read_file</tool>",
    "<parameter name=\"path\">相对 workspace 的路径</parameter>",
    "</tool_use>",
    input.retryCount > 1 ? "这已经是重复协议偏离。没有工具证据时不要总结或收尾。" : "",
  ].filter(Boolean).join("\n");
}

export function buildToolProtocolDoomLoopStopMessage(language: "zh" | "en", toolName?: string | null): string {
  const tool = toolName ? ` ${toolName}` : "";
  return language === "zh"
    ? `模型连续输出不可执行的伪工具调用${tool}，没有补齐正式 XML 参数。MAIN 已停止本轮以避免继续堆叠恢复提示。你可以继续当前任务，MAIN 会保留已读取的上下文；建议下一条明确指定文件路径或让 MAIN 先读取 @ 文件。`
    : `The model repeatedly emitted a non-executable pseudo tool call${tool} without valid XML parameters. MAIN stopped this turn to avoid piling on more recovery prompts. You can continue the task; MAIN kept the context already read. For the next message, specify the file path or ask MAIN to read the @ file first.`;
}

export function containsToolUseBlock(text: string): boolean {
  return /<tool_use\b/i.test(String(text || ""));
}

export function containsToolNameParameterFallback(text: string): boolean {
  return /<tool_use\b[\s\S]*?<parameter\s+name=["'](?:tool|name|function)["']/i.test(String(text || ""));
}

export function summarizeProtocolFragmentForLog(text: string): string {
  return String(text || "")
    .replace(/```[\s\S]*?```/g, "[code block]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
}

export function extractUserMentionedFilePathsFromMessages(messages: MessageWithMaybeTextContent[]): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const message of messages) {
    if (message.role !== "user" || typeof message.content !== "string") continue;
    const markerIndex = message.content.indexOf("[user_mentioned_files]");
    if (markerIndex < 0) continue;
    const section = message.content
      .slice(markerIndex)
      .split(/\n\[[a-z_]+(?:_[a-z_]+)*\]/i)[0] || "";
    const pathRe = /^path:\s*(.+?)\s*$/gmi;
    let match: RegExpExecArray | null;
    while ((match = pathRe.exec(section)) !== null) {
      const value = String(match[1] || "").trim();
      if (!value || seen.has(value)) continue;
      seen.add(value);
      paths.push(value);
    }
  }
  return paths;
}

export function choosePseudoToolRecovery(input: {
  pseudoToolName: string | null;
  availableToolNames: Set<string>;
  mentionedPaths: string[];
  workflowMode: WorkflowMode;
  turnIntent: ResolvedUserIntent;
}): PseudoToolRecoveryDecision {
  const requestedToolName = String(input.pseudoToolName || "").trim();
  if (!requestedToolName) {
    return {
      call: null,
      requestedToolName: null,
      recoveredToolName: null,
      reason: "no_pseudo_tool_name",
      mentionedPathCount: input.mentionedPaths.length,
      argumentKeys: [],
    };
  }
  if (!input.availableToolNames.has(requestedToolName)) {
    return {
      call: null,
      requestedToolName,
      recoveredToolName: null,
      reason: "tool_not_available",
      mentionedPathCount: input.mentionedPaths.length,
      argumentKeys: [],
    };
  }

  if (requestedToolName === "get_project_skeleton" || requestedToolName === "get_pty_status" || requestedToolName === "clear_pty_buffer") {
    return {
      call: {
        id: `pseudo_recovered_${generateId()}`,
        name: requestedToolName,
        arguments: JSON.stringify({}),
      },
      requestedToolName,
      recoveredToolName: requestedToolName,
      reason: "no_required_arguments",
      mentionedPathCount: input.mentionedPaths.length,
      argumentKeys: [],
    };
  }

  const uniqueMentionedPath = input.mentionedPaths.length === 1 ? input.mentionedPaths[0] : "";
  if (!uniqueMentionedPath) {
    return {
      call: null,
      requestedToolName,
      recoveredToolName: null,
      reason: input.mentionedPaths.length > 1 ? "ambiguous_mentioned_paths" : "missing_required_path",
      mentionedPathCount: input.mentionedPaths.length,
      argumentKeys: [],
    };
  }

  const isTabular = TABULAR_FILE_RE.test(uniqueMentionedPath);
  const shouldPreferTabularAnalysis =
    requestedToolName === "read_file" &&
    isTabular &&
    input.availableToolNames.has("analyze_tabular_document") &&
    (input.workflowMode === "plan" || input.turnIntent === "analyze" || input.turnIntent === "report" || input.turnIntent === "summarize");
  const recoveredToolName = shouldPreferTabularAnalysis ? "analyze_tabular_document" : requestedToolName;
  if (!input.availableToolNames.has(recoveredToolName)) {
    return {
      call: null,
      requestedToolName,
      recoveredToolName: null,
      reason: "recovered_tool_not_available",
      mentionedPathCount: input.mentionedPaths.length,
      argumentKeys: [],
    };
  }

  const pathOnlyTools = new Set([
    "read_file",
    "read_document",
    "analyze_tabular_document",
    "get_file_outline",
    "code_ast_query",
    "list_directory",
    "index_workspace_documents",
  ]);
  if (!pathOnlyTools.has(recoveredToolName)) {
    return {
      call: null,
      requestedToolName,
      recoveredToolName: null,
      reason: "tool_requires_uninferrable_arguments",
      mentionedPathCount: input.mentionedPaths.length,
      argumentKeys: [],
    };
  }

  const args = { path: uniqueMentionedPath };
  return {
    call: {
      id: `pseudo_recovered_${generateId()}`,
      name: recoveredToolName,
      arguments: JSON.stringify(args),
    },
    requestedToolName,
    recoveredToolName,
    reason: shouldPreferTabularAnalysis ? "unique_tabular_mention" : "unique_mentioned_path",
    mentionedPathCount: input.mentionedPaths.length,
    argumentKeys: Object.keys(args),
  };
}

export function recoverPseudoToolCallFromContext(input: {
  text: string;
  availableToolNames: Set<string> | string[];
  mentionedPaths: string[];
  workflowMode: WorkflowMode;
  turnIntent: ResolvedUserIntent;
}): PseudoToolRecoveryDecision {
  return choosePseudoToolRecovery({
    pseudoToolName: extractPseudoToolCallName(input.text),
    availableToolNames: input.availableToolNames instanceof Set
      ? input.availableToolNames
      : new Set(input.availableToolNames),
    mentionedPaths: input.mentionedPaths,
    workflowMode: input.workflowMode,
    turnIntent: input.turnIntent,
  });
}

export function buildMalformedToolUseRecoveryPrompt(language: "zh" | "en"): string {
  if (language === "en") {
    return [
      "Your previous reply contained a `<tool_use>` block, but MAIN could not parse it as an executable tool call.",
      "Continue with exactly one valid XML tool call now. Use this shape:",
      "<tool_use>",
      "<tool>query_tabular_document</tool>",
      "<parameter name=\"path\">path/to/file.csv</parameter>",
      "<parameter name=\"query\">SQL or natural-language query</parameter>",
      "</tool_use>",
      "Do not put the tool name inside `<parameter name=\"tool\">`, and do not output prose around the tool call.",
    ].join("\n");
  }

  return [
    "上一条回复包含 `<tool_use>`，但 MAIN 没能解析成可执行工具调用。",
    "现在请只输出一个合法 XML 工具调用，格式如下：",
    "<tool_use>",
    "<tool>query_tabular_document</tool>",
    "<parameter name=\"path\">path/to/file.csv</parameter>",
    "<parameter name=\"query\">SQL 或自然语言查询</parameter>",
    "</tool_use>",
    "不要把工具名写进 `<parameter name=\"tool\">`，也不要在工具调用前后输出说明文字。",
  ].join("\n");
}

export function looksLikeToolUnavailableClaim(text: string): boolean {
  const normalized = String(text || "").replace(/\s+/g, " ").trim().toLowerCase();
  if (!normalized) return false;
  const toolClaim =
    /没有(?:可用|可以调用|能调用|任何)?(?:的)?工具/.test(normalized) ||
    /无法(?:访问|读取|查看|打开|调用|使用).*(?:文件|目录|工作区|工具|本地)/.test(normalized) ||
    /不能(?:访问|读取|查看|打开|调用|使用).*(?:文件|目录|工作区|工具|本地)/.test(normalized) ||
    /(?:no|without|lack|lacks|do not have|don't have|cannot|can't|unable to).{0,80}(?:tool|function|file|folder|filesystem|workspace|local)/i.test(normalized) ||
    /(?:tool|function|file|folder|filesystem|workspace|local).{0,80}(?:unavailable|not available|not accessible|unsupported|disabled)/i.test(normalized);
  return toolClaim;
}

export function buildToolUnavailableRecoveryPrompt(language: "zh" | "en", workflowMode: WorkflowMode): string {
  const writeAllowed = workflowMode === "chat"
    ? language === "zh"
      ? "当前是聊天回合，除非用户明确要求实现或修改，先只使用只读工具。"
      : "This is a chat turn, so use read-only tools unless the user explicitly asked for implementation or edits."
    : language === "zh"
    ? "如果用户要求实现、修复或计划落盘，可以使用写入/执行工具。"
    : "If the user asked for implementation, fixes, or plan artifacts, write/execute tools are available.";

  return language === "zh"
    ? [
        "上一条回复把云端原生 function tools 不可用误解成 MAIN 没有工具。请纠正：MAIN 内置工具可通过 XML `<tool_use>` 调用。",
        "不要再声称无法访问工作区、文件或工具；如果需要上下文，请立即调用合适的 XML 工具。",
        writeAllowed,
        "可用示例：",
        "<tool_use>",
        "<tool>read_file</tool>",
        "<parameter name=\"path\">README.md</parameter>",
        "</tool_use>",
      ].join("\n")
    : [
        "The previous reply confused native function-tools support with MAIN tool availability. Correct this: MAIN built-in tools are available through XML `<tool_use>` calls.",
        "Do not claim that workspace files or tools are unavailable; if context is needed, immediately call the appropriate XML tool.",
        writeAllowed,
        "Example:",
        "<tool_use>",
        "<tool>read_file</tool>",
        "<parameter name=\"path\">README.md</parameter>",
        "</tool_use>",
      ].join("\n");
}

function stripReasoningBlocksForEscalation(text: string): string {
  return String(text || "")
    .replace(/<(?:analysis|thought|thinking|reasoning)(?:\s[^>]*)?>[\s\S]*?<\/(?:analysis|thought|thinking|reasoning)>/gi, " ")
    .replace(/<\/?(?:analysis|thought|thinking|reasoning)(?:\s[^>]*)?>/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function truncateForLog(value: string, maxLength = 96): string {
  const normalized = String(value || "").replace(/\s+/g, " ").trim();
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength).trim()}...`;
}

const PSEUDO_TOOL_CALL_RE = /(?:^|\n)\s*(?:\[(?:Tool call|tool_call|工具调用)\s*:\s*([a-z_][a-z0-9_]*)\s*\]|(?:Tool call|tool_call|工具调用)\s*:\s*([a-z_][a-z0-9_]*))\s*$/im;
const NON_STANDARD_TOOL_WRAPPER_RE = /<tool_code(?:\s[^>]*)?>[\s\S]*?<\/tool_code>/i;
const TABULAR_FILE_RE = /\.(?:csv|tsv|xlsx|xls|xlsm)$/i;
