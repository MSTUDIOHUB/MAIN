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
        ? "已批准计划正在执行，但当前缺少可审计的任务清单。不要输出解释文字，下一步必须先从 plan.md 派生 runtime 任务清单；只有长任务、跨会话恢复或需要审计留档时，才直接调用 `write_file` 创建 `.MAIN/plans/tasks.md`。"
        : "已批准计划正在执行，但上一步没有继续调用工具。不要输出进度说明、计划、伪代码或完成总结；下一条回复必须是一个真实工具调用，用 `apply_patch`、`replace_in_file` 或 `write_file` 修改证据未满足任务对应的源码文件。",
      input.rejectedCompletionClaim
        ? "你刚才的完成声明没有通过可信证据审计；正文不会被当作完成证据。"
        : "",
      input.missingTasksArtifact
        ? "任务清单应保持 8-20 个以内，每项一句话，并带轻量 evidence 标签，例如 `— 证据: file:src/App.tsx`、`— 证据: cmd:npm test` 或 `— 证据: deliverable:REPORT.md`。"
        : "优先处理下面的第一个源码修改任务。不要再读取 `.MAIN/plans/plan.md`，不要用 `run_command`/`cat`/`head`/`grep`/`rg` 获取源码内容。若刚才的 `apply_patch` 因格式失败，请改用正确的 Codex apply_patch 语法或 `replace_in_file`；只有发生 patch/search_text 不匹配时才允许一次定向 `read_file`，随后必须立即写入。一次性命令验证用 `run_command` 并检查 exitCode/stdout/stderr；页面渲染验证必须使用 Browser/Playwright DOM 或截图证据，不能用 curl/grep/cat 代替。完成任务后，必须先产生真实证据；如果 tasks.md 已存在，再把对应 checkbox 更新为 `[x]`。",
      "当前缺失证据：",
      remainingText,
      commandHint,
    ].filter(Boolean).join("\n");
  }

  return [
    input.missingTasksArtifact
      ? "An approved plan is executing, but no auditable task list exists. Do not output explanatory prose; next, derive a runtime task list from plan.md. Call `write_file` to create `.MAIN/plans/tasks.md` only for long work, cross-session recovery, or explicit audit-file needs."
      : "An approved plan is executing, but the previous step did not continue with a tool call. Do not output a progress note, plan, pseudocode, or final summary; the next reply must be one real tool call using `apply_patch`, `replace_in_file`, or `write_file` against the source file for the evidence-unsatisfied task.",
    input.rejectedCompletionClaim
      ? "Your completion claim did not pass the trusted evidence audit; prose is not completion evidence."
      : "",
    input.missingTasksArtifact
      ? "The task list should stay within 8-20 concise items and include lightweight evidence labels such as `- evidence: file:src/App.tsx`, `- evidence: cmd:npm test`, or `- evidence: deliverable:REPORT.md`."
      : "Start with the first source-edit task below. Do not reread `.MAIN/plans/plan.md`, and do not use `run_command`/`cat`/`head`/`grep`/`rg` to obtain source text. If the prior `apply_patch` failed due to formatting, retry with valid Codex apply_patch syntax or use `replace_in_file`; only after a patch/search_text mismatch may you call one targeted `read_file`, then immediately write. Use `run_command` for one-shot validation after the write and inspect exitCode/stdout/stderr. Rendered-page validation requires Browser/Playwright DOM or screenshot evidence; do not substitute curl/grep/cat. After real evidence exists, update the matching tasks.md checkbox to `[x]` if tasks.md exists.",
    "Missing evidence:",
    remainingText,
    commandHint,
  ].filter(Boolean).join("\n");
}
