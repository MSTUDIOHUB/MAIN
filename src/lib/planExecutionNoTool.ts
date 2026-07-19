import type { PlanTaskEvidenceAudit } from "./workflowModels";

export function shouldHandleApprovedPlanExecutionNoTool(input: {
  isPlanApproved: boolean;
  planStage: string;
  toolCallCount: number;
  audit?: Pick<
    PlanTaskEvidenceAudit,
    | "totalCount"
    | "acceptedCompletion"
    | "allTrustedComplete"
    | "pendingExternalValidation"
    | "pendingUserValidationTasks"
    | "remainingTasks"
  > | null;
}): boolean {
  if (!input.isPlanApproved) return false;
  if (input.planStage !== "executing") return false;
  if (input.toolCallCount > 0) return false;
  if (!input.audit) return false;
  return input.audit.totalCount === 0 ||
    !input.audit.acceptedCompletion;
}

export function buildPlanExecutionNoToolRecoveryPrompt(input: {
  language: "zh" | "en";
  /** XML is opt-in; omitted/false keeps the recovery protocol-neutral for native schemas. */
  forceXmlTools?: boolean;
  missingTasksArtifact: boolean;
  remainingText: string;
  commandHint?: string;
  recentActivitySummary?: string;
  rejectedCompletionClaim?: boolean;
}): string {
  const remainingText = String(input.remainingText || "").trim();
  const commandHint = String(input.commandHint || "").trim();
  const recentActivitySummary = String(input.recentActivitySummary || "").trim();
  const toolCallRequirement = input.forceXmlTools
    ? input.language === "zh"
      ? "下一条回复必须只包含一个真实 `<tool_use>`"
      : "The next reply must contain exactly one real `<tool_use>`"
    : input.language === "zh"
      ? "下一条回复必须只发起一个当前 schema 中的正式工具调用"
      : "The next reply must make exactly one formal tool call from the active schemas";
  if (input.language === "zh") {
    return [
      input.missingTasksArtifact
        ? `TOOL_ONLY_RECOVERY: 已批准计划正在执行，但当前缺少可审计的任务清单。${toolCallRequirement}；先从 plan.md 派生 runtime 任务清单，只有长任务、跨会话恢复或需要审计留档时才用 \`write_file\` 创建 \`.MAIN/plans/tasks.md\`。`
        : `TOOL_ONLY_RECOVERY: 已批准计划正在执行，但上一轮没有工具调用。${toolCallRequirement}，不要输出进度说明、计划、伪代码或完成总结。`,
      input.rejectedCompletionClaim
        ? "你刚才的完成声明没有通过可信证据审计；正文不会被当作完成证据。"
        : "",
      input.missingTasksArtifact
        ? "任务清单应保持 8-20 个以内，每项一句话，并带轻量 evidence 标签，例如 `— 证据: file:src/App.tsx`、`— 证据: cmd:npm test` 或 `— 证据: deliverable:REPORT.md`。"
        : "允许的下一步只有：`read_file` 一次性读取缺失的精确源码窗口、`apply_patch`/`replace_in_file`/`write_file` 写入源码、`run_command`/`execute_command` 做真实命令验证、`browser_evaluate` 做网页 UI/DOM/截图验证，或在桌面验收项且工具已开放时使用 `computer_use`。不要再读取 `.MAIN/plans/plan.md`，不要用 `cat`/`head`/`grep`/`rg` 通过 shell 翻源码。若读取了源码，下一轮必须写入或验证；完成任务前必须先产生真实工具证据。",
      "当前缺失证据：",
      remainingText,
      recentActivitySummary ? `最近工具结果：${recentActivitySummary}` : "",
      recentActivitySummary && /(?:failed|failure|error|失败|错误)/i.test(recentActivitySummary)
        ? "上一次工具失败不能作为完成证据。读取其 exitCode/stdout/stderr，改用与真实文件扩展名、项目运行时和当前任务相兼容的验证方式；不要重复失败命令，也不要只输出完成说明。"
        : "",
      commandHint,
    ].filter(Boolean).join("\n");
  }

  return [
    input.missingTasksArtifact
      ? `TOOL_ONLY_RECOVERY: An approved plan is executing, but no auditable task list exists. ${toolCallRequirement}; derive runtime tasks from plan.md, and call \`write_file\` for \`.MAIN/plans/tasks.md\` only for long work, cross-session recovery, or explicit audit-file needs.`
      : `TOOL_ONLY_RECOVERY: An approved plan is executing, but the previous step did not call a tool. ${toolCallRequirement}; do not output a progress note, plan, pseudocode, or final summary.`,
    input.rejectedCompletionClaim
      ? "Your completion claim did not pass the trusted evidence audit; prose is not completion evidence."
      : "",
    input.missingTasksArtifact
      ? "The task list should stay within 8-20 concise items and include lightweight evidence labels such as `- evidence: file:src/App.tsx`, `- evidence: cmd:npm test`, or `- evidence: deliverable:REPORT.md`."
      : "The only allowed next steps are: one targeted `read_file` for the exact missing source window, `apply_patch`/`replace_in_file`/`write_file` for source edits, `run_command`/`execute_command` for real command validation, `browser_evaluate` for web UI/DOM/screenshot validation, or `computer_use` for an exposed desktop acceptance item. Do not reread `.MAIN/plans/plan.md`, and do not use shell `cat`/`head`/`grep`/`rg` to page source. If you read source, the following turn must write or validate; completion requires real tool evidence.",
    "Missing evidence:",
    remainingText,
    recentActivitySummary ? `Recent tool result: ${recentActivitySummary}` : "",
    recentActivitySummary && /(?:failed|failure|error|失败|错误)/i.test(recentActivitySummary)
      ? "A failed tool result is not completion evidence. Inspect its exitCode/stdout/stderr and use a different validation method compatible with the real file extension, project runtime, and current task. Do not repeat the failed command or only state completion."
      : "",
    commandHint,
  ].filter(Boolean).join("\n");
}
