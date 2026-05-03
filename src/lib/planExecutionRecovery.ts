import {
  isPlanTaskTrustedComplete,
  type PlanArtifact,
  type PlanExecutionEvidenceEntry,
  type PlanExecutionProgressPhase,
  type PlanExecutionProgressSnapshot,
  type PlanExecutionProgressUpdate,
  type PlanTask,
} from "./workflowModels";

export const PLAN_MAX_AUTO_RESUME_LIMIT = 1;

export type PlanToolActivityStatus = "called" | "succeeded" | "failed";

export interface PlanToolActivitySummary {
  name: string;
  target: string;
  status: PlanToolActivityStatus;
  detail?: string;
}

export interface PlanMaxIterationsCheckpoint {
  reason: "max_iterations_checkpoint";
  iterationCount: number;
  maxIterations: number;
  autoResumeCount: number;
  currentTask: string;
  remainingTasks: string[];
  completedEvidence: string[];
  recentToolActivity: PlanToolActivitySummary[];
  lastAssistantText: string;
  unresolvedBlockers: string[];
}

const INTERNAL_PLAN_PATH_RE = /(?:^|[\\/])\.MAIN[\\/]plans[\\/]/i;
const MAX_LINE_CHARS = 180;

export function isInternalPlanPath(value: string | undefined | null): boolean {
  return INTERNAL_PLAN_PATH_RE.test(String(value || "").replace(/\\/g, "/"));
}

function compactLine(value: string | undefined | null, maxChars = MAX_LINE_CHARS): string {
  const normalized = String(value || "").replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  return normalized.length <= maxChars ? normalized : `${normalized.slice(0, maxChars).trim()}...`;
}

function summarizeTask(task: PlanTask): string {
  const status = task.evidenceStatus || task.status || "missing";
  return compactLine(`${task.text} [${status}]`);
}

function summarizeEvidence(entry: PlanExecutionEvidenceEntry): string {
  const target = entry.target || entry.value;
  return compactLine(`${entry.kind}:${target} via ${entry.sourceTool}`);
}

function summarizeToolActivity(activity: PlanToolActivitySummary): string {
  const target = activity.target ? ` ${activity.target}` : "";
  const detail = activity.detail ? ` - ${activity.detail}` : "";
  return compactLine(`${activity.status}:${activity.name}${target}${detail}`);
}

function topLines(values: string[], fallback: string, limit = 5): string[] {
  const lines = values.map((value) => compactLine(value)).filter(Boolean).slice(0, limit);
  return lines.length > 0 ? lines : [fallback];
}

export function summarizePlanExecutionEvidence(
  evidenceLedger: PlanExecutionEvidenceEntry[],
  limit = 8,
): string[] {
  return evidenceLedger
    .filter((entry) => !isInternalPlanPath(entry.target || entry.value))
    .slice(-limit)
    .map(summarizeEvidence)
    .filter(Boolean);
}

function getPlanProgressPhaseLabel(phase: PlanExecutionProgressPhase, language: "zh" | "en"): string {
  if (language === "zh") {
    switch (phase) {
      case "starting": return "准备执行";
      case "tool_start": return "工具执行中";
      case "tool_done": return "工具已完成";
      case "tool_error": return "工具出错";
      case "waiting_review": return "等待审批";
      case "context_compression": return "背景已压缩";
      case "checkpoint": return "检查点";
      case "auto_resume": return "自动续跑";
      case "paused": return "已暂停";
      case "completed": return "已完成";
      default: return "执行中";
    }
  }

  switch (phase) {
    case "starting": return "Starting";
    case "tool_start": return "Tool running";
    case "tool_done": return "Tool done";
    case "tool_error": return "Tool error";
    case "waiting_review": return "Waiting for approval";
    case "context_compression": return "Context compressed";
    case "checkpoint": return "Checkpoint";
    case "auto_resume": return "Auto-resuming";
    case "paused": return "Paused";
    case "completed": return "Completed";
    default: return "Running";
  }
}

function getPlanProgressNextStep(
  phase: PlanExecutionProgressPhase,
  remainingTask: PlanTask | undefined,
  language: "zh" | "en",
): string {
  if (phase === "completed") {
    return language === "zh" ? "整理最终回复并关闭计划运行态" : "prepare the final reply and close the plan runtime";
  }
  if (phase === "paused") {
    return language === "zh" ? "点击 Resume Execution 后基于当前 workspace 状态继续" : "click Resume Execution and continue from current workspace state";
  }
  if (phase === "auto_resume") {
    return language === "zh" ? "开启新的恢复上下文，先核查当前 workspace 状态" : "start a fresh recovery context and inspect current workspace state first";
  }
  if (phase === "checkpoint") {
    return language === "zh" ? "保存检查点并决定是否自动续跑" : "save a checkpoint and decide whether to auto-resume";
  }
  if (phase === "context_compression") {
    return language === "zh" ? "基于压缩后的上下文继续，必要时重新读取当前文件" : "continue with compacted context and reread current files if needed";
  }
  if (phase === "waiting_review") {
    return language === "zh" ? "等待工具调用审批后继续执行" : "wait for tool approval, then continue execution";
  }
  if (phase === "tool_error") {
    return language === "zh" ? "根据工具错误修正下一步，必要时暂停给出恢复信息" : "recover from the tool error or pause with recovery details";
  }
  if (remainingTask) return compactLine(remainingTask.text);
  return language === "zh"
    ? "确认 tasks.md、交付物与验证证据都已满足"
    : "confirm tasks.md, deliverables, and verification evidence are satisfied";
}

export function buildPlanExecutionProgressUpdate(input: {
  language: "zh" | "en";
  phase: PlanExecutionProgressPhase;
  iterationCount: number;
  maxIterations: number;
  autoResumeCount: number;
  tasks: PlanTask[];
  evidenceLedger: PlanExecutionEvidenceEntry[];
  recentToolActivity: PlanToolActivitySummary[];
  currentTool?: string;
  latestEvidence?: string;
  nextStep?: string;
}): PlanExecutionProgressUpdate {
  const remaining = input.tasks.filter((task) => !isPlanTaskTrustedComplete(task));
  const remainingTask = remaining[0];
  const recentTool = input.recentToolActivity.length > 0
    ? summarizeToolActivity(input.recentToolActivity[input.recentToolActivity.length - 1])
    : "";
  const recentEvidence = summarizePlanExecutionEvidence(input.evidenceLedger, 1)[0] || "";
  const currentTask = remainingTask
    ? summarizeTask(remainingTask)
    : input.language === "zh" ? "核查最终证据" : "verify final evidence";

  return {
    phase: input.phase,
    currentTask,
    currentTool: compactLine(input.currentTool || recentTool || (input.language === "zh" ? "暂无工具调用" : "no tool call yet")),
    latestEvidence: compactLine(input.latestEvidence || recentEvidence || (input.language === "zh" ? "暂无项目源码证据" : "no project-source evidence yet")),
    nextStep: compactLine(input.nextStep || getPlanProgressNextStep(input.phase, remainingTask, input.language)),
    iteration: Math.max(0, Number(input.iterationCount) || 0),
    maxIterations: Math.max(0, Number(input.maxIterations) || 0),
    autoResumeCount: Math.max(0, Number(input.autoResumeCount) || 0),
  };
}

export function normalizePlanExecutionProgressSnapshot(input: {
  turnId: string;
  update: PlanExecutionProgressUpdate;
  previous?: PlanExecutionProgressSnapshot | null;
  now?: number;
}): PlanExecutionProgressSnapshot {
  const previous = input.previous;
  return {
    turnId: input.update.turnId || previous?.turnId || input.turnId,
    phase: input.update.phase || previous?.phase || "running",
    currentTask: compactLine(input.update.currentTask || previous?.currentTask || ""),
    currentTool: compactLine(input.update.currentTool || previous?.currentTool || ""),
    latestEvidence: compactLine(input.update.latestEvidence || previous?.latestEvidence || ""),
    nextStep: compactLine(input.update.nextStep || previous?.nextStep || ""),
    iteration: Math.max(0, Number(input.update.iteration ?? previous?.iteration) || 0),
    maxIterations: Math.max(0, Number(input.update.maxIterations ?? previous?.maxIterations) || 0),
    autoResumeCount: Math.max(0, Number(input.update.autoResumeCount ?? previous?.autoResumeCount) || 0),
    updatedAt: Math.max(0, Number(input.update.updatedAt) || Number(input.now) || Date.now()),
  };
}

export function summarizePlanExecutionProgressSnapshot(
  snapshot: PlanExecutionProgressSnapshot,
  language: "zh" | "en",
): string {
  const phaseLabel = getPlanProgressPhaseLabel(snapshot.phase, language);
  if (language === "zh") {
    return `${phaseLabel}：当前 ${snapshot.currentTask || "核查任务"}；最近证据 ${snapshot.latestEvidence || "暂无"}；下一步 ${snapshot.nextStep || "继续执行"}。`;
  }
  return `${phaseLabel}: current ${snapshot.currentTask || "check task"}; latest evidence ${snapshot.latestEvidence || "none"}; next ${snapshot.nextStep || "continue"}.`;
}

export function formatPlanExecutionProgressSnapshot(
  snapshot: PlanExecutionProgressSnapshot,
  language: "zh" | "en",
): string {
  const phaseLabel = getPlanProgressPhaseLabel(snapshot.phase, language);
  const turnInfo = snapshot.maxIterations > 0
    ? `${snapshot.iteration}/${snapshot.maxIterations}`
    : String(snapshot.iteration || 0);
  return language === "zh"
    ? [
        `${phaseLabel} · 轮次 ${turnInfo} · 自动恢复 ${snapshot.autoResumeCount}/${PLAN_MAX_AUTO_RESUME_LIMIT}`,
        `当前任务：${snapshot.currentTask || "核查任务状态"}`,
        `最近证据：${snapshot.latestEvidence || "暂无项目源码证据"}`,
        `当前工具：${snapshot.currentTool || "暂无工具调用"}`,
        `下一步：${snapshot.nextStep || "继续执行剩余任务"}`,
      ].join("\n")
    : [
        `${phaseLabel} · turn ${turnInfo} · auto-resume ${snapshot.autoResumeCount}/${PLAN_MAX_AUTO_RESUME_LIMIT}`,
        `Current task: ${snapshot.currentTask || "check task status"}`,
        `Latest evidence: ${snapshot.latestEvidence || "no project-source evidence yet"}`,
        `Current tool: ${snapshot.currentTool || "no tool call yet"}`,
        `Next: ${snapshot.nextStep || "continue remaining tasks"}`,
      ].join("\n");
}

export function buildPlanMaxIterationsCheckpoint(input: {
  iterationCount: number;
  maxIterations: number;
  autoResumeCount: number;
  tasks: PlanTask[];
  evidenceLedger: PlanExecutionEvidenceEntry[];
  recentToolActivity: PlanToolActivitySummary[];
  lastAssistantText?: string;
  unresolvedBlockers?: string[];
}): PlanMaxIterationsCheckpoint {
  const remaining = input.tasks.filter((task) => !isPlanTaskTrustedComplete(task));
  const completedEvidence = summarizePlanExecutionEvidence(input.evidenceLedger);
  const currentTask = remaining[0]
    ? summarizeTask(remaining[0])
    : "No task with unsatisfied evidence was found; verify tasks.md and current workspace state.";

  return {
    reason: "max_iterations_checkpoint",
    iterationCount: input.iterationCount,
    maxIterations: input.maxIterations,
    autoResumeCount: Math.max(0, input.autoResumeCount),
    currentTask,
    remainingTasks: topLines(
      remaining.map(summarizeTask),
      "No remaining task summary available; reread tasks.md and evidence before continuing.",
      8,
    ),
    completedEvidence: topLines(
      completedEvidence,
      "No trusted project-source evidence yet.",
      8,
    ),
    recentToolActivity: input.recentToolActivity.slice(-8),
    lastAssistantText: compactLine(input.lastAssistantText || "", 240),
    unresolvedBlockers: topLines(
      input.unresolvedBlockers || [],
      `The agent reached the ${input.maxIterations}-iteration safety boundary while still trying to continue.`,
      5,
    ),
  };
}

export function buildPlanExecutionProgressNotice(input: {
  language: "zh" | "en";
  iterationCount: number;
  maxIterations: number;
  tasks: PlanTask[];
  evidenceLedger: PlanExecutionEvidenceEntry[];
  recentToolActivity: PlanToolActivitySummary[];
}): string {
  const update = buildPlanExecutionProgressUpdate({
    ...input,
    phase: "running",
    autoResumeCount: 0,
  });
  const snapshot = normalizePlanExecutionProgressSnapshot({
    turnId: "",
    update,
    now: 0,
  });
  return summarizePlanExecutionProgressSnapshot(snapshot, input.language);
}

export function buildPlanMaxIterationsAutoResumeNotice(
  checkpoint: PlanMaxIterationsCheckpoint,
  language: "zh" | "en",
): string {
  const recentTool = checkpoint.recentToolActivity.length > 0
    ? summarizeToolActivity(checkpoint.recentToolActivity[checkpoint.recentToolActivity.length - 1])
    : language === "zh" ? "暂无工具结果" : "no tool result yet";

  return language === "zh"
    ? [
        `计划执行达到 ${checkpoint.maxIterations} 轮安全边界，MAIN 已保存检查点并自动开启 1 次恢复上下文。`,
        `当前任务：${checkpoint.currentTask}`,
        `最近工具：${recentTool}`,
        "恢复时会重新读取当前 workspace 状态；`.MAIN/plans` 只作为内部计划状态，不会被当作用户源码证据。",
      ].join("\n")
    : [
        `Plan execution reached the ${checkpoint.maxIterations}-iteration safety boundary. MAIN saved a checkpoint and will auto-resume once in a fresh context.`,
        `Current task: ${checkpoint.currentTask}`,
        `Recent tool: ${recentTool}`,
        "The recovery turn will reread current workspace state; `.MAIN/plans` is internal plan state, not project-source evidence.",
      ].join("\n");
}

export function buildPlanMaxIterationsPauseNotice(
  checkpoint: PlanMaxIterationsCheckpoint,
  language: "zh" | "en",
): string {
  const evidenceLines = checkpoint.completedEvidence.slice(0, 4).map((line) => `- ${line}`);
  const remainingLines = checkpoint.remainingTasks.slice(0, 5).map((line) => `- ${line}`);
  const toolLines = checkpoint.recentToolActivity.slice(-4).map((activity) => `- ${summarizeToolActivity(activity)}`);
  const blockerLines = checkpoint.unresolvedBlockers.slice(0, 3).map((line) => `- ${line}`);

  if (language === "zh") {
    return [
      `计划执行已暂停：连续第 ${checkpoint.iterationCount}/${checkpoint.maxIterations} 轮后仍未闭环。`,
      "MAIN 已经自动恢复过一次，为避免无限循环，这次停在可恢复状态。",
      "",
      "RecoveryDetails:",
      `- reason: ${checkpoint.reason}`,
      `- autoResumeCount: ${checkpoint.autoResumeCount}/${PLAN_MAX_AUTO_RESUME_LIMIT}`,
      `- currentTask: ${checkpoint.currentTask}`,
      "- recentToolActivity:",
      ...(toolLines.length ? toolLines : ["- 无"]),
      "- recentProjectEvidence:",
      ...(evidenceLines.length ? evidenceLines : ["- 暂无可信项目源码证据"]),
      "- remainingTasks:",
      ...(remainingLines.length ? remainingLines : ["- 请重新读取 tasks.md 和证据摘要后继续"]),
      "- blockers:",
      ...(blockerLines.length ? blockerLines : ["- 命中计划执行安全轮次上限"]),
      "",
      "下一步：点击 Resume Execution 后，MAIN 会开启新的恢复上下文，先重新读取当前 workspace 状态，再继续证据未满足的任务。",
    ].join("\n");
  }

  return [
    `Plan execution paused after ${checkpoint.iterationCount}/${checkpoint.maxIterations} iterations without closure.`,
    "MAIN has already auto-resumed once, so it is stopping here to avoid an infinite loop.",
    "",
    "RecoveryDetails:",
    `- reason: ${checkpoint.reason}`,
    `- autoResumeCount: ${checkpoint.autoResumeCount}/${PLAN_MAX_AUTO_RESUME_LIMIT}`,
    `- currentTask: ${checkpoint.currentTask}`,
    "- recentToolActivity:",
    ...(toolLines.length ? toolLines : ["- none"]),
    "- recentProjectEvidence:",
    ...(evidenceLines.length ? evidenceLines : ["- No trusted project-source evidence yet"]),
    "- remainingTasks:",
    ...(remainingLines.length ? remainingLines : ["- Reread tasks.md plus the evidence summary, then continue"]),
    "- blockers:",
    ...(blockerLines.length ? blockerLines : ["- Hit the plan execution iteration safety limit"]),
    "",
    "Next: click Resume Execution to start a fresh recovery context, reread current workspace state, and continue from the first task whose evidence is not satisfied.",
  ].join("\n");
}

export function buildPlanMaxIterationsResumePrompt(input: {
  language: "zh" | "en";
  checkpoint: PlanMaxIterationsCheckpoint;
  hasTasksArtifact: boolean;
  tasks: PlanTask[];
  artifacts: PlanArtifact[];
  evidenceLedger: PlanExecutionEvidenceEntry[];
}): string {
  const remaining = input.tasks.filter((task) => !isPlanTaskTrustedComplete(task)).slice(0, 8);
  const remainingText = remaining.length > 0
    ? remaining.map((task, index) => `${index + 1}. ${summarizeTask(task)}`).join("\n")
    : input.language === "zh"
    ? "没有找到证据未满足的任务；请先核查 tasks.md 是否缺失或状态不可信。"
    : "No task with unsatisfied evidence was found; first verify whether tasks.md is missing or stale.";
  const evidenceText = summarizePlanExecutionEvidence(input.evidenceLedger)
    .map((line) => `- ${line}`)
    .join("\n") || (input.language === "zh" ? "- 暂无可信项目源码证据" : "- No trusted project-source evidence yet");
  const artifactText = input.artifacts
    .map((artifact) => `- ${artifact.path} (${artifact.kind}, ${artifact.content.length} chars)`)
    .join("\n") || (input.language === "zh" ? "- 暂无计划文件摘要" : "- No plan artifact summary");
  const toolText = input.checkpoint.recentToolActivity.slice(-6)
    .map((activity) => `- ${summarizeToolActivity(activity)}`)
    .join("\n") || (input.language === "zh" ? "- 暂无工具活动摘要" : "- No recent tool activity summary");

  if (input.language === "zh") {
    return [
      "请在新的恢复上下文中继续执行已批准计划。这是 MAIN 在 50 轮安全边界后的自动恢复，只允许继续真实未完成工作。",
      input.hasTasksArtifact
        ? "先重新读取当前 workspace 状态和 `.MAIN/plans/tasks.md`，从第一个证据未满足的任务继续。"
        : "先基于已批准的 requirements/design 或 bugfix 重新生成 `.MAIN/plans/tasks.md`，再执行真实任务。",
      "不要重做已经满足证据的任务；不要只修改 checkbox；不要重复计划说明；不要把 `.MAIN/plans` 当作用户源码证据。需要判断源码现状时，直接读取真实项目文件。",
      "",
      "Checkpoint:",
      `- iterationBoundary: ${input.checkpoint.iterationCount}/${input.checkpoint.maxIterations}`,
      `- currentTask: ${input.checkpoint.currentTask}`,
      input.checkpoint.lastAssistantText ? `- lastAssistantText: ${input.checkpoint.lastAssistantText}` : "",
      "",
      "计划文件摘要（仅内部计划状态）：",
      artifactText,
      "",
      "最近可信项目证据：",
      evidenceText,
      "",
      "最近工具活动：",
      toolText,
      "",
      "优先恢复任务：",
      remainingText,
    ].filter(Boolean).join("\n");
  }

  return [
    "Continue the approved plan in a fresh recovery context. This is MAIN's automatic recovery after the 50-iteration safety boundary; only continue real unfinished work.",
    input.hasTasksArtifact
      ? "First reread current workspace state and `.MAIN/plans/tasks.md`, then continue from the first task whose evidence is not satisfied."
      : "First regenerate `.MAIN/plans/tasks.md` from the approved requirements/design or bugfix, then execute real tasks.",
    "Do not redo tasks whose evidence is already satisfied. Do not only edit checkboxes. Do not restate the plan. Do not treat `.MAIN/plans` as project-source evidence; read real project files when source state matters.",
    "",
    "Checkpoint:",
    `- iterationBoundary: ${input.checkpoint.iterationCount}/${input.checkpoint.maxIterations}`,
    `- currentTask: ${input.checkpoint.currentTask}`,
    input.checkpoint.lastAssistantText ? `- lastAssistantText: ${input.checkpoint.lastAssistantText}` : "",
    "",
    "Plan artifact summary (internal plan state only):",
    artifactText,
    "",
    "Recent trusted project evidence:",
    evidenceText,
    "",
    "Recent tool activity:",
    toolText,
    "",
    "Priority recovery tasks:",
    remainingText,
  ].filter(Boolean).join("\n");
}
