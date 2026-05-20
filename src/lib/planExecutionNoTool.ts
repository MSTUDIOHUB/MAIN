import type { PlanTaskEvidenceAudit } from "./workflowModels";

export function shouldHandleApprovedPlanExecutionNoTool(input: {
  workflowMode: "chat" | "edit" | "plan";
  isPlanApproved: boolean;
  planStage: string;
  toolCallCount: number;
  audit?: Pick<PlanTaskEvidenceAudit, "totalCount" | "acceptedCompletion" | "allTrustedComplete" | "pendingExternalValidation"> | null;
}): boolean {
  if (input.workflowMode !== "plan" || !input.isPlanApproved) return false;
  if (input.planStage !== "executing") return false;
  if (input.toolCallCount > 0) return false;
  if (!input.audit) return false;
  return input.audit.totalCount === 0 || !input.audit.allTrustedComplete;
}

export function buildPlanExecutionNoToolRecoveryPrompt(input: {
  language: "zh" | "en";
  missingTasksArtifact: boolean;
  remainingText: string;
  commandHint?: string;
  rejectedCompletionClaim?: boolean;
}): string {
  const remainingText = String(input.remainingText || "").trim();
  const commandHint = String(input.commandHint || "").trim();
  if (input.language === "zh") {
    return [
      input.missingTasksArtifact
        ? "已批准计划正在执行，但当前缺少可审计的任务清单。不要输出解释文字，下一步必须先从 design.md 派生 runtime 任务清单；只有长任务、跨会话恢复或需要审计留档时，才直接调用 `write_file` 创建 `.MAIN/plans/tasks.md`。"
        : "已批准计划正在执行，但上一步没有继续调用工具。不要输出进度说明或完成总结，下一步必须直接调用工具继续证据未满足且与当前诊断最相关的任务。",
      input.rejectedCompletionClaim
        ? "你刚才的完成声明没有通过可信证据审计；正文不会被当作完成证据。"
        : "",
      input.missingTasksArtifact
        ? "任务清单应保持 8-20 个以内，每项一句话，并带轻量 evidence 标签，例如 `— 证据: file:src/App.tsx`、`— 证据: cmd:npm test` 或 `— 证据: deliverable:REPORT.md`。"
        : "优先处理下面的任务。需要修改文件就调用 `read_file`/`write_file`/`replace_in_file`；如果目标文件已经读过、再次读取只返回 `FILE_UNCHANGED_STUB`，不要继续重复读取，必须转向 `replace_in_file`/`write_file`、读取不同目标，或明确暂停说明阻塞。一次性命令验证用 `run_command` 并检查 exitCode/stdout/stderr；页面渲染验证必须使用 Browser/Playwright DOM 或截图证据，不能用 curl/grep/cat 代替；Tauri/人工验证不可自动完成时要暂停说明待用户验证。完成任务后，必须先产生真实证据；如果 tasks.md 已存在，再把对应 checkbox 更新为 `[x]`。",
      "当前缺失证据：",
      remainingText,
      commandHint,
    ].filter(Boolean).join("\n");
  }

  return [
    input.missingTasksArtifact
      ? "An approved plan is executing, but no auditable task list exists. Do not output explanatory prose; next, derive a runtime task list from design.md. Call `write_file` to create `.MAIN/plans/tasks.md` only for long work, cross-session recovery, or explicit audit-file needs."
      : "An approved plan is executing, but the previous step did not continue with a tool call. Do not output a progress note or final summary; next, directly call tools for the evidence-unsatisfied task that best matches the current diagnosis.",
    input.rejectedCompletionClaim
      ? "Your completion claim did not pass the trusted evidence audit; prose is not completion evidence."
      : "",
    input.missingTasksArtifact
      ? "The task list should stay within 8-20 concise items and include lightweight evidence labels such as `- evidence: file:src/App.tsx`, `- evidence: cmd:npm test`, or `- evidence: deliverable:REPORT.md`."
      : "Start with the tasks below. Use `read_file`/`write_file`/`replace_in_file` for file work; if the target file has already been read and another read only returns `FILE_UNCHANGED_STUB`, do not keep rereading it: switch to `replace_in_file`/`write_file`, inspect a different target, or pause with the exact blocker. Use `run_command` for one-shot command validation and inspect exitCode/stdout/stderr. Rendered-page validation requires Browser/Playwright DOM or screenshot evidence; do not substitute curl/grep/cat. If Tauri or manual validation cannot be automated, pause and report pending user validation. After real evidence exists, update the matching tasks.md checkbox to `[x]` if tasks.md exists.",
    "Missing evidence:",
    remainingText,
    commandHint,
  ].filter(Boolean).join("\n");
}
