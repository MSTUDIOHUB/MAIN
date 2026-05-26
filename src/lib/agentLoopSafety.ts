export interface AgentLoopIterationLimits {
  chatRespond?: number;
  editExecute?: number;
  planDraft?: number;
  planExecution?: number;
  default?: number;
}

export const DEFAULT_AGENT_LOOP_ITERATION_LIMITS = {
  chatRespond: 25,
  editExecute: 25,
  planDraft: 25,
  planExecution: 50,
  default: 25,
} as const;

function positiveInt(value: unknown, fallback: number): number {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) return fallback;
  const rounded = Math.floor(numberValue);
  return rounded > 0 ? rounded : fallback;
}

export function resolveAgentLoopMaxIterations(input: {
  workflowMode: "chat" | "edit" | "plan";
  runtimeIntent: "respond" | "execute" | string;
  isPlanApproved: boolean;
  limits?: AgentLoopIterationLimits | null;
}): number {
  const limits = input.limits || {};
  if (input.workflowMode === "plan" && input.isPlanApproved) {
    return positiveInt(limits.planExecution, DEFAULT_AGENT_LOOP_ITERATION_LIMITS.planExecution);
  }
  if (input.workflowMode === "plan") {
    return positiveInt(limits.planDraft, DEFAULT_AGENT_LOOP_ITERATION_LIMITS.planDraft);
  }
  if (input.workflowMode === "edit" && input.runtimeIntent === "execute") {
    return positiveInt(limits.editExecute, DEFAULT_AGENT_LOOP_ITERATION_LIMITS.editExecute);
  }
  if (input.workflowMode === "chat" && input.runtimeIntent === "respond") {
    return positiveInt(limits.chatRespond, DEFAULT_AGENT_LOOP_ITERATION_LIMITS.chatRespond);
  }
  return positiveInt(limits.default, DEFAULT_AGENT_LOOP_ITERATION_LIMITS.default);
}

export function shouldUseMaxStepsFinalTextOnly(input: {
  workflowMode: "chat" | "edit" | "plan";
  runtimeIntent: "respond" | "execute" | string;
  isPlanApproved: boolean;
  iteration: number;
  maxIterations: number;
  alreadyPrompted: boolean;
}): boolean {
  if (input.alreadyPrompted) return false;
  if (input.iteration < input.maxIterations) return false;
  if (input.workflowMode === "plan" && input.isPlanApproved) return false;
  return input.workflowMode === "chat" && input.runtimeIntent === "respond";
}

export function buildMaxStepsFinalTextPrompt(input: {
  language: "zh" | "en";
  iteration: number;
  maxIterations: number;
  repeatedTargets?: string[];
}): string {
  const repeatedTargets = input.repeatedTargets?.filter(Boolean) || [];
  if (input.language === "zh") {
    return [
      "MAX_STEPS_FINAL_TEXT: 本轮已达到 agent 安全轮次边界。",
      `当前轮次：${input.iteration}/${input.maxIterations}。工具已在本轮最后一步关闭，直到用户下一条输入前都不要再调用工具。`,
      "严格要求：",
      "1. 不要发起任何工具调用，包括读取、搜索、编辑、命令或浏览器工具。",
      "2. 只输出面向用户的 Markdown 正文。",
      "3. 必须总结目前已经完成/确认的内容、仍未完成的任务，以及建议下一步。",
      repeatedTargets.length ? `最近重复目标：${repeatedTargets.join("、")}。` : "",
      "如果信息不足，明确说明缺口；不要用新的工具调用补上下文。",
    ].filter(Boolean).join("\n");
  }

  return [
    "MAX_STEPS_FINAL_TEXT: This turn has reached the agent safety step boundary.",
    `Current step: ${input.iteration}/${input.maxIterations}. Tools are disabled for this final step until the next user input.`,
    "Strict requirements:",
    "1. Do not make any tool calls, including reads, searches, edits, commands, or browser tools.",
    "2. Respond with user-visible Markdown text only.",
    "3. Summarize what has been completed or learned, what remains unfinished, and the recommended next step.",
    repeatedTargets.length ? `Recent repeated targets: ${repeatedTargets.join(", ")}.` : "",
    "If information is missing, state the gap explicitly; do not use tools to fill it.",
  ].filter(Boolean).join("\n");
}

export function buildMaxStepsToolCallIgnoredNotice(input: {
  language: "zh" | "en";
  iteration: number;
  maxIterations: number;
  repeatedTargets?: string[];
}): string {
  const targets = input.repeatedTargets?.filter(Boolean) || [];
  if (input.language === "zh") {
    return [
      `本轮达到 ${input.iteration}/${input.maxIterations} 轮安全边界，模型仍尝试继续调用工具。`,
      "MAIN 已忽略最后一步工具调用并停在可恢复状态，避免继续扩大重复循环。",
      targets.length ? `重复目标：${targets.join("、")}` : "重复目标：未定位到单一目标",
      "下一步：继续时请复用已读上下文，直接总结、换目标，或说明具体阻塞。",
    ].join("\n");
  }
  return [
    `This turn reached the ${input.iteration}/${input.maxIterations}-iteration safety boundary, but the model still attempted tool calls.`,
    "MAIN ignored those final-step tool calls and stopped in a recoverable state to avoid extending the loop.",
    targets.length ? `Repeated targets: ${targets.join(", ")}` : "Repeated targets: none isolated",
    "Next: resume by reusing the cached context, summarizing, switching targets, or stating the concrete blocker.",
  ].join("\n");
}

export function buildEmptyModelResponsePauseNotice(input: {
  language: "zh" | "en";
  emptyResponses: number;
  repeatedTargets?: string[];
  localProfile?: boolean;
}): string {
  const targets = input.repeatedTargets?.filter(Boolean) || [];
  if (input.language === "zh") {
    return [
      `模型本轮已返回 ${input.emptyResponses} 次空响应，没有产生可见正文或工具调用。`,
      input.localProfile
        ? "这通常是本地模型在长上下文或 XML 工具协议下的空补全/预填充兼容问题。"
        : "这通常是网关或上游模型返回空补全。MAIN 已保留当前上下文。",
      targets.length ? `最近重复目标：${targets.join("、")}` : "最近重复目标：未定位到单一目标",
      "下一步：继续时请先复用已读上下文，要求模型直接总结、换一个明确目标，或说明具体阻塞。",
    ].join("\n");
  }

  return [
    `The model returned ${input.emptyResponses} empty responses in this turn without visible text or tool calls.`,
    input.localProfile
      ? "This usually indicates a local-model empty-completion/prefill compatibility issue under long context or XML tools."
      : "This usually indicates an empty completion from the gateway or upstream model. MAIN preserved the current context.",
    targets.length ? `Recent repeated targets: ${targets.join(", ")}` : "Recent repeated targets: none isolated",
    "Next: resume by reusing cached context and asking for a direct summary, a different concrete target, or the exact blocker.",
  ].join("\n");
}
