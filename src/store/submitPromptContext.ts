import type { PendingOperationProposal } from "../lib/workflowModels";
import { buildTurnIntakeContextBlock, type TurnInputContextSignals } from "../lib/turnIntake";

export type SubmitPromptRunIntent = string;
export type SubmitPromptWorkflowMode = "chat" | "edit" | "plan";
export type SubmitPromptLanguage = "zh" | "en";

export interface SubmitPromptContinuationTarget {
  userPrompt?: string;
  status: string;
}

export interface BuildSubmitPromptContextInput {
  userContent: string;
  text: string;
  preferredLanguage: SubmitPromptLanguage;
  effectiveRunIntent: SubmitPromptRunIntent;
  effectiveWorkflowMode: SubmitPromptWorkflowMode;
  preservePlanState: boolean;
  isPlanApproved: boolean;
  shouldContinuePlanIntent: boolean;
  shouldContinuePreviousTurnIntent: boolean;
  shouldExecuteOnceFromReplyOption: boolean;
  currentTurnUserPrompt?: string;
  previousTurnContinuationTarget?: SubmitPromptContinuationTarget | null;
  previousTurnLastToolSummary?: string;
  previousTurnLastAssistantSummary?: string;
  approvedProposal?: PendingOperationProposal;
  latestAssistantSummary?: string;
  selectedChoiceText?: string;
  turnInputContextSignals: TurnInputContextSignals;
}

export interface BuildSubmitPromptContextResult {
  userContent: string;
}

export function buildOperationApprovalContinuationPrompt(params: {
  language: SubmitPromptLanguage;
  proposal?: PendingOperationProposal;
  latestAssistantSummary?: string;
  userChoice: string;
}): string {
  const summary = params.proposal?.proposalSummary || params.latestAssistantSummary || "";
  if (params.language === "en") {
    return [
      "The user approved real operations for this turn.",
      summary ? `Reuse the previous proposal summary exactly as execution context: ${summary}` : "Reuse the immediately preceding proposal in this turn as execution context.",
      "Do not re-plan from scratch. Start the smallest necessary real tool actions now, then verify with actual tool results.",
      "Do not claim the work is fixed or complete unless there is tool evidence, a file diff/write result, a command result, or an explicit blocker.",
      `User approval message: ${params.userChoice}`,
    ].join("\n");
  }
  return [
    "用户已批准本轮真实操作。",
    summary ? `请严格复用上一轮方案摘要作为执行上下文：${summary}` : "请复用本回合紧邻上一条方案作为执行上下文。",
    "不要重新从零规划。现在开始调用最小必要的真实工具操作，然后用实际工具结果验证。",
    "没有工具证据、文件 diff/写入结果、命令结果或明确阻塞时，不得声称已修复或已完成。",
    `用户批准消息：${params.userChoice}`,
  ].join("\n");
}

function applyPlanModePrompt(input: BuildSubmitPromptContextInput, userContent: string): string {
  if (input.effectiveRunIntent !== "plan" || input.isPlanApproved || input.shouldContinuePlanIntent) {
    return userContent;
  }
  const planModeLead = input.preservePlanState
    ? input.preferredLanguage === "en"
      ? "This is still an unapproved PLAN turn. Treat the latest user message as a planning choice or clarification, not approval to edit source files."
      : "当前仍是未批准的 PLAN 回合。请把用户最新消息视为计划选项/澄清，不要当作已批准修改源码。"
    : input.preferredLanguage === "en"
    ? "This turn is in PLAN mode."
    : "本轮处于 PLAN 模式。";
  return input.preferredLanguage === "en"
    ? [
        `${planModeLead} If the request is a complex implementation, gather read-only evidence first, then create or update the reviewable plan at \`.MAIN/plans/plan.md\` with \`write_file\` or \`replace_in_file\`. This is the only allowed write before approval. For debug-log, screenshot, repeated-failure, or cross-module repairs, you may also keep a short staged ledger: \`requirements.md\` for user goals/acceptance and \`design.md\` for evidence-backed diagnosis. Do not write project source files or tasks.md before approval.`,
        "Follow the opencode-style plan file workflow: if a plan file already exists, edit it incrementally; otherwise create it. Keep exploring read-only evidence until the plan is decision-complete.",
        "The plan file must follow the Codex app handoff shape: title, Summary, Key Changes / Implementation Changes, Public APIs / Interfaces / Types, Test Plan, and Assumptions / Defaults.",
        "If it is only a discussion-style plan, keep the answer concise and use user options for real decisions.",
        "",
        userContent,
      ].join("\n")
    : [
        `${planModeLead}如果这是复杂实现请求，请先收集只读证据，再用 \`write_file\` 或 \`replace_in_file\` 创建/更新可审批计划文件 \`.MAIN/plans/plan.md\`；这是批准前唯一允许的写入。遇到调试日志、截图、反复失败或跨模块修复时，可以同时保留简短 staged ledger：\`requirements.md\` 写用户目标/验收，\`design.md\` 写证据归因/取舍。等待用户批准后再改源码；批准前不要生成 tasks.md。`,
        "严格按 opencode 风格的计划文件流程：如果 plan.md 已存在就增量编辑，否则创建完整计划；只读证据足够且计划 decision-complete 后再停在审批。",
        "plan.md 必须对齐 Codex app 的交接计划结构：标题、摘要、关键实现改动、公共 API/接口/类型、测试方案、假设与默认值。",
        "如果只是讨论式方案，请保持简洁，并在真实分叉点用可点击选项让用户选择。",
        "",
        userContent,
      ].join("\n");
}

function applyPlanContinuationPrompt(input: BuildSubmitPromptContextInput, userContent: string): string {
  if (!input.shouldContinuePlanIntent) return userContent;
  const originalPlanPrompt = input.currentTurnUserPrompt?.trim();
  return input.preferredLanguage === "en"
    ? [
        "Continue the previous PLAN turn. The user is asking to keep going, not to start a new discussion.",
        originalPlanPrompt ? `Original plan request: ${originalPlanPrompt}` : "Original plan request: use the current conversation context.",
        "Produce real planning progress now. If key choices remain, summarize them in 2-3 bullets then use <user_options>; if all decisions are made, write plan.md directly without options. Use requirements/design only as a short staged ledger for complex evidence tracking.",
        "Keep plan.md concise: review-summary style, no tutorial prose, no full code listings, no repeated background.",
        input.text.trim() ? `Latest user message: ${input.text.trim()}` : "Latest user message: continue",
      ].join("\n")
    : [
        "请继续上一轮 PLAN 回合。用户是在要求继续推进，不是开启新的普通讨论。",
        originalPlanPrompt ? `上一轮计划请求：${originalPlanPrompt}` : "上一轮计划请求：请依据当前对话上下文继续。",
        "现在必须产生实际规划进展。如有关键决策需确认，先用 2-3 条摘要归纳再给出 <user_options>；如所有决策已完成，则直接写入 plan.md 无需选项。requirements/design 只作为复杂证据追踪的简短 staged ledger。",
        "每个 <option> 必须是用户点击后会发送的完整选择，不要写成“是否……”问题句。",
        "plan.md 要精简成 Codex app 交接计划风格：标题、摘要、关键实现改动、公共 API/接口/类型、测试方案、假设与默认值；不要写教程式长文、完整代码清单或重复背景。",
        input.text.trim() ? `用户最新消息：${input.text.trim()}` : "用户最新消息：继续",
      ].join("\n");
}

function applyPreviousTurnContinuationPrompt(input: BuildSubmitPromptContextInput, userContent: string): string {
  const target = input.previousTurnContinuationTarget;
  if (!input.shouldContinuePreviousTurnIntent || !target) return userContent;
  const originalPrompt = target.userPrompt?.trim();
  const executionHint =
    input.effectiveRunIntent === "execute" || input.effectiveRunIntent === "studio_workflow"
      ? input.preferredLanguage === "en"
        ? "If the unfinished next step is running, testing, verifying, or executing a command, issue the real tool call now: prefer `run_command` for finite checks/tests, and use `execute_command` only for long-running or interactive validation."
        : "如果未完成的下一步是运行、测试、验证或执行命令，现在必须发起真实工具调用：一次性检查/测试优先用 `run_command`，长驻或交互式验证才用 `execute_command`。"
      : input.preferredLanguage === "en"
      ? "If the remaining work requires workspace context, use the appropriate read-only tool immediately instead of announcing a future step."
      : "如果剩余工作需要工作区上下文，请立即调用合适的只读工具，不要只宣布下一步。";
  return input.preferredLanguage === "en"
    ? [
        "Continue the previous unfinished turn. The user's message is a semantic continuation request, not a new discussion.",
        originalPrompt ? `Original request: ${originalPrompt}` : "Original request: use the current conversation context.",
        `Previous turn status: ${target.status}.`,
        input.previousTurnLastToolSummary ? `Last tool activity: ${input.previousTurnLastToolSummary}.` : "",
        input.previousTurnLastAssistantSummary ? `Last visible assistant message: ${input.previousTurnLastAssistantSummary}` : "",
        "Resume from the unfinished point and complete the remaining work.",
        executionHint,
        "Do not stop after saying what you will do next.",
        input.text.trim() ? `Latest user message: ${input.text.trim()}` : "Latest user message: continue",
        "",
        userContent,
      ].filter(Boolean).join("\n")
    : [
        "请继续上一轮未完成回合。用户这句是语义续跑，不是开启新的普通讨论。",
        originalPrompt ? `上一轮原始请求：${originalPrompt}` : "上一轮原始请求：请依据当前对话上下文继续。",
        `上一轮状态：${target.status}。`,
        input.previousTurnLastToolSummary ? `上一轮最后工具活动：${input.previousTurnLastToolSummary}。` : "",
        input.previousTurnLastAssistantSummary ? `上一轮最后可见回复：${input.previousTurnLastAssistantSummary}` : "",
        "请从未完成的位置恢复，并完成剩余内容。",
        executionHint,
        "不要只说接下来要做什么后停止。",
        input.text.trim() ? `用户最新消息：${input.text.trim()}` : "用户最新消息：继续",
        "",
        userContent,
      ].filter(Boolean).join("\n");
}

function applyOperationApprovalPrompt(input: BuildSubmitPromptContextInput, userContent: string): string {
  if (
    !input.shouldExecuteOnceFromReplyOption ||
    (input.effectiveRunIntent !== "execute" && input.effectiveRunIntent !== "studio_workflow")
  ) {
    return userContent;
  }
  const approvalContinuationPrompt = buildOperationApprovalContinuationPrompt({
    language: input.preferredLanguage,
    proposal: input.approvedProposal,
    latestAssistantSummary: input.latestAssistantSummary,
    userChoice: input.text.trim() || input.selectedChoiceText || "approved",
  });
  return [
    approvalContinuationPrompt,
    "",
    userContent,
  ].join("\n");
}

function applyTurnIntakePrompt(input: BuildSubmitPromptContextInput, userContent: string): string {
  const turnIntakeBlock = buildTurnIntakeContextBlock({
    rawUserInput: input.text,
    signals: input.turnInputContextSignals,
    language: input.preferredLanguage,
    workflowMode: input.effectiveWorkflowMode,
  });
  return turnIntakeBlock ? `${turnIntakeBlock}\n\n${userContent}` : userContent;
}

export function buildSubmitPromptContext(
  input: BuildSubmitPromptContextInput,
): BuildSubmitPromptContextResult {
  let userContent = input.userContent;
  userContent = applyPlanModePrompt(input, userContent);
  userContent = applyPlanContinuationPrompt(input, userContent);
  userContent = applyPreviousTurnContinuationPrompt(input, userContent);
  userContent = applyOperationApprovalPrompt(input, userContent);
  userContent = applyTurnIntakePrompt(input, userContent);
  return { userContent };
}
