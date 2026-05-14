import type { PlanTaskEvidenceAudit } from "./workflowModels";

export function shouldHandleApprovedPlanExecutionNoTool(input: {
  workflowMode: "chat" | "edit" | "plan";
  isPlanApproved: boolean;
  planStage: string;
  toolCallCount: number;
  audit?: Pick<PlanTaskEvidenceAudit, "totalCount" | "acceptedCompletion"> | null;
}): boolean {
  if (input.workflowMode !== "plan" || !input.isPlanApproved) return false;
  if (input.planStage !== "executing") return false;
  if (input.toolCallCount > 0) return false;
  if (!input.audit) return false;
  return input.audit.totalCount === 0 || !input.audit.acceptedCompletion;
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
        ? "已批准计划正在执行，但当前缺少可审计的 `.MAIN/plans/tasks.md`。不要输出解释文字，下一步必须直接调用 `write_file` 创建 `.MAIN/plans/tasks.md`。"
        : "已批准计划正在执行，但上一步没有继续调用工具。不要输出进度说明或完成总结，下一步必须直接调用工具继续第一个证据未满足的任务。",
      input.rejectedCompletionClaim
        ? "你刚才的完成声明没有通过可信证据审计；正文不会被当作完成证据。"
        : "",
      input.missingTasksArtifact
        ? "tasks.md 必须包含 8-20 个未完成 checkbox，每项一句话，并带轻量 evidence 标签，例如 `— 证据: file:src/App.tsx`、`— 证据: cmd:npm test` 或 `— 证据: deliverable:REPORT.md`。批准后才允许执行源码写入和命令。"
        : "优先处理下面的任务。需要修改文件就调用 `read_file`/`write_file`/`replace_in_file`；需要验证就调用 `run_command` 并检查 exitCode/stdout/stderr。完成任务后，必须先产生真实证据，再把 tasks.md 对应 checkbox 更新为 `[x]`。",
      "当前缺失证据：",
      remainingText,
      commandHint,
    ].filter(Boolean).join("\n");
  }

  return [
    input.missingTasksArtifact
      ? "An approved plan is executing, but `.MAIN/plans/tasks.md` is missing or has no auditable tasks. Do not output explanatory prose; next, directly call `write_file` to create `.MAIN/plans/tasks.md`."
      : "An approved plan is executing, but the previous step did not continue with a tool call. Do not output a progress note or final summary; next, directly call tools for the first task whose evidence is not satisfied.",
    input.rejectedCompletionClaim
      ? "Your completion claim did not pass the trusted evidence audit; prose is not completion evidence."
      : "",
    input.missingTasksArtifact
      ? "tasks.md must contain 8-20 unchecked checkboxes, one sentence each, with lightweight evidence labels such as `- evidence: file:src/App.tsx`, `- evidence: cmd:npm test`, or `- evidence: deliverable:REPORT.md`. Source writes and commands are allowed only after this task list exists."
      : "Start with the tasks below. Use `read_file`/`write_file`/`replace_in_file` for file work; use `run_command` for verification and inspect exitCode/stdout/stderr. After real evidence exists, update the matching tasks.md checkbox to `[x]`.",
    "Missing evidence:",
    remainingText,
    commandHint,
  ].filter(Boolean).join("\n");
}
