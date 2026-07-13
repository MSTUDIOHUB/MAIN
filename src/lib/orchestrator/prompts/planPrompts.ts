
import type { PlanToolActivitySummary } from "../../planExecutionRecovery";
import {
  type PlanTaskEvidenceAudit,
  describePlanValidationDecision,
  isPlanTaskAwaitingBrowserValidation,
  isPlanTaskAwaitingExternalValidation,
  hasBrowserValidationCapability
} from "../../workflowModels";

export function buildApprovedPlanNoProgressStrategySwitchPrompt(input: {
  language: "zh" | "en";
  remainingText: string;
  repeatedTargets: string[];
  recentToolActivity: PlanToolActivitySummary[];
  allowFileRead?: boolean;
}): string {
  const repeatedTargets = input.repeatedTargets.length > 0
    ? input.repeatedTargets.join(input.language === "zh" ? "、" : ", ")
    : input.language === "zh" ? "最近已读目标" : "recently read targets";
  const recent = input.recentToolActivity
    .slice(-4)
    .map((item) => [item.status, item.name, item.target, item.detail].filter(Boolean).join(" "))
    .join(input.language === "zh" ? "；" : "; ");

  if (input.language === "en") {
    return [
      "The approved Plan is still executing, but the last read-only batch reused already-known file content and did not create action evidence.",
      "Continue now. Do not stop and do not re-plan.",
      `Repeated/known targets: ${repeatedTargets}`,
      recent ? `Recent tool evidence: ${recent}` : "",
      `Unsatisfied task: ${input.remainingText}`,
      input.allowFileRead
        ? "For the next response, MAIN keeps action tools plus targeted file reads available for exact-content or patch recovery. Use one only when needed, then patch or validate."
        : "For the next response, MAIN keeps action tools plus patch-recovery `read_file` only when a patch mismatch just happened. Use `apply_patch`/`replace_in_file`/`write_file`, run a command, use Browser/Playwright validation, or state the exact blocker if no real action is possible.",
      "Do not call read/list/search again for the same cached target. If exact current content is needed, perform one targeted read and immediately continue with patching or validation.",
    ].filter(Boolean).join("\n");
  }

  return [
    "已批准的 Plan 仍在执行，但上一批只读工具只是复用了已知文件内容，没有产生行动证据。",
    "现在继续执行，不要停止，也不要重新规划。",
    `重复/已知目标：${repeatedTargets}`,
    recent ? `最近工具证据：${recent}` : "",
    `证据未满足任务：${input.remainingText}`,
    input.allowFileRead
      ? "下一轮 MAIN 会保留行动工具和定向文件读取，用于精确内容或 patch 恢复。只在需要时读一次，随后必须写入或验证。"
      : "下一轮 MAIN 会保留行动工具；只有刚发生 patch 不匹配时才开放一次定向 `read_file`。请优先使用 `apply_patch` / `replace_in_file` / `write_file` 修改，运行命令，执行 Browser/Playwright 验证，或说明无法真实行动的具体阻塞。",
    "不要再次对同一缓存目标调用 read/list/search；如果确实需要精确当前内容，只做一次定向读取，然后立即继续 patch 或验证。",
  ].filter(Boolean).join("\n");
}

export function buildApprovedPlanSourceEditFirstPrompt(language: "zh" | "en"): string {
  if (language === "en") {
    return [
      "Approved execution must start with real project action, not another exploration loop.",
      "If the approved plan includes a source-file edit, the next tool call should be `apply_patch`, `replace_in_file`, or `write_file` against the named source file.",
      "Do not read `.MAIN/plans/plan.md` again, and do not use `run_command`/`cat`/`head`/`grep`/`rg` to page source files before the first project write. Validation commands are for after the write.",
    ].join("\n");
  }
  return [
    "批准后的执行必须从真实项目动作开始，不能再次进入探索循环。",
    "如果已批准计划包含源码修改，下一次工具调用应直接对命名源码文件使用 `apply_patch`、`replace_in_file` 或 `write_file`。",
    "不要再次读取 `.MAIN/plans/plan.md`，也不要在第一次项目写入前用 `run_command`/`cat`/`head`/`grep`/`rg` 分页读取源码；验证命令应在写入之后再运行。",
  ].join("\n");
}

export function formatPlanAuditRemainingTasks(
  audit: PlanTaskEvidenceAudit,
  language: "zh" | "en",
  fallback: string,
  limit = 8,
): string {
  const lines = audit.remainingTasks.slice(0, limit).map((task, index) => {
    const evidence = task.evidence?.map((item) => `${item.kind}:${item.value}`).join(", ") ||
      (language === "zh" ? "缺少证据标签" : "missing evidence label");
    const status = task.evidenceStatus || task.status || "missing";
    const reason = task.blockedReason || (language === "zh" ? "证据未满足" : "evidence is not satisfied");
    return `- ${index + 1}. ${task.text} [${status}; ${evidence}] - ${reason}`;
  });
  return lines.length > 0 ? lines.join("\n") : fallback;
}

export function formatApprovedPlanNoToolAvailableTools(
  language: "zh" | "en",
  toolNames?: Iterable<string> | null,
): string {
  if (!toolNames) return "";
  const available = new Set(Array.from(toolNames).map((name) => String(name || "")));
  const preferred = [
    "read_file",
    "apply_patch",
    "replace_in_file",
    "write_file",
    "run_command",
    "execute_command",
    "browser_evaluate",
  ].filter((name) => available.has(name));
  if (preferred.length === 0) return "";
  return language === "zh"
    ? `本轮已开放关键工具：${preferred.map((name) => `\`${name}\``).join("、")}。暂停原因不是工具缺失，而是模型没有按执行协议调用工具。`
    : `Key tools were available this turn: ${preferred.map((name) => `\`${name}\``).join(", ")}. This pause is not caused by missing tools; the model did not follow the execution protocol and call one.`;
}

export function buildApprovedPlanNoToolPauseMessage(
  language: "zh" | "en",
  remainingText: string,
  consecutiveNoToolCount: number,
  audit?: PlanTaskEvidenceAudit,
  completionClaimRejected = false,
  availableToolNames?: Iterable<string> | null,
): string {
  const auditLine = audit && audit.totalCount > 0
    ? language === "zh"
      ? `可信审计进度：${audit.completedCount}/${audit.totalCount}`
      : `Trusted audit progress: ${audit.completedCount}/${audit.totalCount}`
    : "";
  const availableToolsLine = formatApprovedPlanNoToolAvailableTools(language, availableToolNames);

  return language === "zh"
    ? [
        completionClaimRejected ? "完成声明未验证" : "计划执行已暂停",
        "",
        completionClaimRejected
          ? `原因：模型声称计划已完成，但可信任务审计没有通过；模型正文不会被当作完成证据。`
          : `原因：模型连续 ${consecutiveNoToolCount} 次提前停止，返回了正文但没有继续调用工具；当前任务清单仍有证据未满足的任务。`,
        "已保留当前 workspace、工具结果和任务证据，不会把这次正文当作完成证据。",
        ...(auditLine ? [auditLine] : []),
        ...(availableToolsLine ? [availableToolsLine] : []),
        "",
        "未完成任务：",
        remainingText,
        "",
        "下一步：点击 Resume Execution 后，MAIN 应先重新读取当前 workspace 状态，再选择证据未满足且与当前诊断最相关的任务继续。",
        "",
        "RecoveryDetails:",
        "- type: remaining_plan_tasks_limit",
        `- noToolStops: ${consecutiveNoToolCount}`,
        `- completionClaimRejected: ${completionClaimRejected ? "true" : "false"}`,
        "- action: Resume Execution",
      ].join("\n")
    : [
        completionClaimRejected ? "Completion claim not accepted" : "Plan execution paused",
        "",
        completionClaimRejected
          ? "Reason: the model claimed the plan was complete, but the trusted task audit did not pass. Assistant prose is not completion evidence."
          : `Reason: the model stopped early ${consecutiveNoToolCount} time(s), returned prose, and did not continue with tool calls while the current task list still has unsatisfied evidence.`,
        "MAIN preserved the current workspace, tool results, and evidence ledger. This prose is not treated as completion evidence.",
        ...(auditLine ? [auditLine] : []),
        ...(availableToolsLine ? [availableToolsLine] : []),
        "",
        "Remaining tasks:",
        remainingText,
        "",
        "Next: click Resume Execution so MAIN rereads current workspace state and continues with the evidence-unsatisfied task that best matches the current diagnosis.",
        "",
        "RecoveryDetails:",
        "- type: remaining_plan_tasks_limit",
        `- noToolStops: ${consecutiveNoToolCount}`,
        `- completionClaimRejected: ${completionClaimRejected ? "true" : "false"}`,
        "- action: Resume Execution",
      ].join("\n");
}

export function formatPendingValidationTasks(
  audit: PlanTaskEvidenceAudit,
  language: "zh" | "en",
  browserValidationAvailable: boolean,
): string {
  const tasks = audit.pendingUserValidationTasks.length > 0
    ? audit.pendingUserValidationTasks
    : audit.remainingTasks.filter((task) =>
        isPlanTaskAwaitingBrowserValidation(task) || isPlanTaskAwaitingExternalValidation(task)
      );
  const lines = tasks.slice(0, 8).map((task, index) => {
    const decision = describePlanValidationDecision({
      task,
      language,
      browserValidationAvailable,
    });
    const evidence = task.evidence?.map((item) => `${item.kind}:${item.value}`).join(", ") ||
      (language === "zh" ? "缺少证据标签" : "missing evidence label");
    return `- ${index + 1}. ${task.text} [${task.evidenceStatus || "missing"}; ${evidence}]${decision ? ` - ${decision}` : ""}`;
  });
  return lines.length > 0
    ? lines.join("\n")
    : language === "zh"
    ? "- 当前没有需要外部验证的任务。"
    : "- No external validation tasks are pending.";
}

export function buildApprovedPlanValidationPendingMessage(input: {
  language: "zh" | "en";
  audit: PlanTaskEvidenceAudit;
  browserValidationAvailable: boolean;
}): string {
  const pendingText = formatPendingValidationTasks(input.audit, input.language, input.browserValidationAvailable);
  return input.language === "zh"
    ? [
        "自动执行已到验证边界",
        "",
        `可信审计进度：${input.audit.completedCount}/${input.audit.totalCount}；剩余项需要浏览器/Tauri/用户确认，不能用 curl、grep 或 cat 替代。`,
        "",
        "待验证项：",
        pendingText,
        "",
        "状态：已保留当前 workspace、端口/命令证据和任务清单；不会继续尝试 kill 端口或重复启动本地服务。",
      ].join("\n")
    : [
        "Automated execution reached a validation boundary",
        "",
        `Trusted audit progress: ${input.audit.completedCount}/${input.audit.totalCount}. The remaining item(s) require browser, Tauri, or user confirmation and cannot be replaced by curl, grep, or cat.`,
        "",
        "Pending validation:",
        pendingText,
        "",
        "State: MAIN preserved the workspace, port/command evidence, and task list; it will not keep killing ports or restarting local servers.",
      ].join("\n");
}

export function buildBrowserValidationContinuationPrompt(input: {
  language: "zh" | "en";
  remainingText: string;
}): string {
  if (input.language === "zh") {
    return [
      "当前剩余任务需要浏览器级验证。下一步必须调用可用的 Browser/Playwright 工具，而不是继续用 curl、grep、cat 或重复启动 dev server。",
      "验证策略：使用当前实际 dev server URL；打开页面；执行 DOM 断言；必要时截图；如果是 Markdown Viewer/test-sample.md 场景，读取样例内容后注入编辑器 textarea，触发 input，再检查 preview 中标题、代码块、表格、脚注、Mermaid 容器和关键样式。",
      "若 Browser/Playwright 工具调用失败或不可用，暂停并说明待用户验证，不要继续兜圈。",
      "待验证任务：",
      input.remainingText,
    ].join("\n");
  }
  return [
    "The remaining task requires browser-level validation. Next, call an available Browser/Playwright tool; do not keep using curl, grep, cat, or repeated dev-server starts.",
    "Validation strategy: use the actual dev-server URL, open the page, run DOM assertions, and take a screenshot if needed. For Markdown Viewer/test-sample.md, read the sample content, inject it into the editor textarea, dispatch input, then assert the preview contains headings, code blocks, tables, footnotes, Mermaid containers, and key styles.",
    "If Browser/Playwright is unavailable or fails, pause and report pending user validation instead of looping.",
    "Pending validation:",
    input.remainingText,
  ].join("\n");
}

export function resolveApprovedPlanValidationBoundary(input: {
  audit: PlanTaskEvidenceAudit | null;
  availableToolNames: Set<string>;
}): "none" | "browser_prompt" | "pause_external_validation" {
  const audit = input.audit;
  if (!audit) return "none";
  const browserAvailable = hasBrowserValidationCapability(input.availableToolNames);
  if (audit.pendingExternalValidation && audit.automationComplete) {
    return "pause_external_validation";
  }
  if (audit.allTrustedComplete) return "none";
  const remaining = audit.remainingTasks;
  if (remaining.length === 0) return "none";
  const allBrowser = remaining.every(isPlanTaskAwaitingBrowserValidation);
  const allExternal = remaining.every((task) =>
    isPlanTaskAwaitingExternalValidation(task) ||
    (isPlanTaskAwaitingBrowserValidation(task) && !browserAvailable)
  );
  if (allBrowser && browserAvailable) return "browser_prompt";
  if (allExternal) return "pause_external_validation";
  return "none";
}

export function stripControlPromptForPlanFallback(text: string): string {
  return String(text || "")
    .replace(/^本轮处于 PLAN 模式。[\s\S]*?\n\n/i, "")
    .replace(/^This turn is in PLAN mode\.[\s\S]*?\n\n/i, "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/<tool_use>[\s\S]*?<\/tool_use>/gi, " ")
    .replace(/<(?:analysis|thought|thinking|reasoning)(?:\s[^>]*)?>[\s\S]*?<\/(?:analysis|thought|thinking|reasoning)>/gi, " ")
    .replace(/<\/?(?:analysis|thought|thinking|reasoning)(?:\s[^>]*)?>/gi, " ")
    // Keep paragraph and list boundaries because Plan quality gates use them
    // to preserve independent user-goal facets. Only collapse horizontal
    // whitespace and excessive blank lines.
    .replace(/[^\S\r\n]+/g, " ")
    .replace(/[ \t]*\r?\n[ \t]*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function isPlanRuntimeInstructionMemory(text: string): boolean {
  return /(?:本轮处于\s*PLAN\s*模式|This turn is in PLAN mode|上一条\s*Plan\s*回复|previous Plan reply|PLAN_REPEAT_READ_LIMIT|PLAN_QUALITY_GATE|如果确实缺少关键业务选择|critical business choice|真正阻塞执行的选择|plan direction is unclear|用\s*`?\s*<?user_options>?\s*`?\s*提问|ask with\s*`?\s*<?user_options>?|可见计划必须|visible\s+`?<proposed_plan>`|创建\s*plan\.md\s*是\s*runtime|MAIN\s+runtime\s+会物化|物化为\s*`?\.MAIN\/plans\/plan\.md|Codex app\s*计划结构|Codex app plan shape|tsx\s*约束|imageParts\s*[0-9]|turn_intake|不要重复扫描目录|Do not repeat directory scans|不要为了完成规划而调用|Do not call\s+`?(?:write_file|replace_in_file)`?\s+just to finish planning)/i.test(
    String(text || "").replace(/\\/g, "/"),
  );
}

export function isPlanControlUserPrompt(text: string): boolean {
  return /^(?:上一条规划内容过长|当前规划还没有进入可执行阶段|计划已批准|请继续上一轮 PLAN|The previous planning reply was too long|The current plan has not reached|The plan is approved|Continue the previous PLAN turn)/i.test(
    String(text || "").trim(),
  );
}

export function detectRequestedRootMarkdownDeliverables(text: string): string[] {
  const source = String(text || "");
  const hasRootHint = /(?:根目录|项目根目录|当前项目|workspace root|project root|root directory)/i.test(source);
  const matches = Array.from(source.matchAll(/(?:^|[^\w./-])([A-Za-z][\w.-]*\.md|README\.md|Readme\.md|readme\.md)(?=$|[^\w./-])/g))
    .map((match) => match[1])
    .filter(Boolean);
  const normalized = matches
    .map((name) => name.replace(/^readme\.md$/i, "Readme.md"))
    .filter((name) => !/^(?:requirements|design|tasks|bugfix)\.md$/i.test(name));

  if (normalized.length === 0 && hasRootHint && /(?:md\s*文档|markdown|说明文档|总结.*文档|Readme|README)/i.test(source)) {
    normalized.push("Readme.md");
  }

  return [...new Set(normalized)];
}
