import type { PendingOperationProposal } from "../lib/workflowModels";
import { buildPlanSubmissionGuidance } from "../lib/planSubmissionGuidance";
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
  const submissionGuidance = buildPlanSubmissionGuidance(input.preferredLanguage);
  return input.preferredLanguage === "en"
    ? [
        `${planModeLead} Gather only the read-only evidence needed to make the plan decision-complete. Before approval, do not call \`write_file\`, \`replace_in_file\`, or any other write tool for \`.MAIN/plans/plan.md\`, requirements/design/tasks files, or project source files.`,
        "Treat the frozen runtime evidence IDs and goal IDs as authority. The complete typed graph must connect diagnoses, explicit change operations/targets, decisions, interfaces, acceptance-capable validation primitives, assumptions, and blocking choices through G/E/R/C/D/V references. Prose and Markdown are display text only and must not carry graph authority.",
        submissionGuidance,
        "The runtime—not the model—validates that typed candidate, seals it, and renders the review artifact at `.MAIN/plans/plan.md`. Never create, update, patch, or incrementally edit that file yourself, even if an older plan already exists.",
        "If a genuinely blocking user decision remains, return concise `<user_options>` only and do not also submit a typed graph. Otherwise submit the complete replacement graph through the contract-declared transport, without options or tutorial prose.",
        "",
        userContent,
      ].join("\n")
    : [
        `${planModeLead}只收集让计划达到 decision-complete 所需的只读证据。批准前不得为 \`.MAIN/plans/plan.md\`、requirements/design/tasks 文件或项目源码调用 \`write_file\`、\`replace_in_file\` 或任何其他写入工具。`,
        "以 runtime 冻结的证据 ID 和目标 ID 为唯一依据。完整 typed graph 中的诊断、明确改动操作/目标、决策、接口、可验收验证原语、假设和阻塞选择必须通过 G/E/R/C/D/V 引用显式连接。自然语言和 Markdown 仅用于展示，不承载图关系权威。",
        submissionGuidance,
        "由 runtime 校验并封存 typed candidate，再单向渲染为 `.MAIN/plans/plan.md` 审批产物。模型绝不能自行创建、更新、打补丁或增量编辑该文件，即使已有旧计划也一样。",
        "如仍有真正阻塞的用户决策，只返回精简的 `<user_options>`，不要同时提交 typed graph；否则通过契约声明的入口提交完整替换图，不要附带选项或教程式长文。",
        "",
        userContent,
      ].join("\n");
}

function applyPlanContinuationPrompt(input: BuildSubmitPromptContextInput, userContent: string): string {
  if (!input.shouldContinuePlanIntent) return userContent;
  const originalPlanPrompt = input.currentTurnUserPrompt?.trim();
  const submissionGuidance = buildPlanSubmissionGuidance(input.preferredLanguage);
  return input.preferredLanguage === "en"
    ? [
        "Continue the previous PLAN turn. The user is asking to keep going, not to start a new discussion.",
        originalPlanPrompt ? `Original plan request: ${originalPlanPrompt}` : "Original plan request: use the current conversation context.",
        "Continue from the existing frozen evidence and gather only missing read-only evidence. Do not call write_file, replace_in_file, or any write tool for plan.md, requirements/design/tasks files, or project source files.",
        "If a genuinely blocking choice remains, return concise <user_options> only. If all decisions are made, submit exactly one complete replacement typed graph with explicit G/E/R/C/D/V references and acceptance-capable validation primitives; do not return options in the same response.",
        submissionGuidance,
        "The runtime alone validates, seals, and renders `.MAIN/plans/plan.md`. Never create or incrementally edit the review artifact yourself; keep candidate display text concise and omit tutorials, full code listings, and repeated background.",
        input.text.trim() ? `Latest user message: ${input.text.trim()}` : "Latest user message: continue",
      ].join("\n")
    : [
        "请继续上一轮 PLAN 回合。用户是在要求继续推进，不是开启新的普通讨论。",
        originalPlanPrompt ? `上一轮计划请求：${originalPlanPrompt}` : "上一轮计划请求：请依据当前对话上下文继续。",
        "请沿用已冻结证据，只补充缺失的只读证据；不得为 plan.md、requirements/design/tasks 文件或项目源码调用 write_file、replace_in_file 或任何写入工具。",
        "如仍有真正阻塞的选择，只返回精简的 <user_options>。如决策已完整，只提交一个完整替换式 typed graph，以 G/E/R/C/D/V 引用显式连接，并包含可验收的验证原语；同一回复不要再带选项。",
        submissionGuidance,
        "每个 <option> 必须是用户点击后会发送的完整选择，不要写成“是否……”问题句。",
        "只有 runtime 可以校验、封存并渲染 `.MAIN/plans/plan.md`；模型绝不能自行创建或增量编辑审批产物。candidate 的展示文本保持精简，不要写教程式长文、完整代码清单或重复背景。",
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
