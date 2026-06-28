import {
  buildPlanTaskEvidenceAudit,
  isPlanTaskAwaitingBrowserValidation,
  isPlanTaskAwaitingExternalValidation,
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
  const status = isPlanTaskAwaitingExternalValidation(task)
    ? "待用户验证"
    : isPlanTaskAwaitingBrowserValidation(task)
    ? "需要浏览器验证"
    : task.evidenceStatus || task.status || "missing";
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

export function isCachedReadOnlyPlanActivity(activity: PlanToolActivitySummary): boolean {
  return /FILE_UNCHANGED_STUB|Repeated read-only tool call skipped|READ_FILE_REPEAT_LIMIT/i.test(activity.detail || "");
}

export function summarizeRepeatedPlanTargetsFromToolActivity(activity: PlanToolActivitySummary[], limit = 4): string[] {
  const counts = new Map<string, number>();
  for (const item of activity) {
    const key = normalizeMatchText(item.target || "");
    if (!key) continue;
    counts.set(key, (counts.get(key) || 0) + (isCachedReadOnlyPlanActivity(item) ? 2 : 1));
  }
  return [...counts.entries()]
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .map(([target]) => target)
    .slice(0, limit);
}

export function buildPlanProgressSignatureFromToolActivity(
  activity: PlanToolActivitySummary[],
): string {
  return activity
    .slice(-6)
    .map((item) => {
      const cached = isCachedReadOnlyPlanActivity(item) ? "cached" : "fresh";
      return `${item.name}:${normalizeMatchText(item.target || "")}:${item.status}:${cached}`;
    })
    .join("|");
}

export function buildPlanNoProgressLoopPauseNotice(input: {
  language: "zh" | "en";
  repeats: number;
  remainingTask?: string;
  evidenceLedger: PlanExecutionEvidenceEntry[];
  recentToolActivity: PlanToolActivitySummary[];
  repeatedTargets?: string[];
}): string {
  const repeatedTargets = (input.repeatedTargets && input.repeatedTargets.length > 0)
    ? input.repeatedTargets
    : summarizeRepeatedPlanTargetsFromToolActivity(input.recentToolActivity);
  const evidence = summarizePlanExecutionEvidence(input.evidenceLedger, 4);
  const recent = input.recentToolActivity.slice(-4).map(summarizeToolActivity);
  const remainingTask = compactLine(input.remainingTask || (input.language === "zh" ? "继续未满足证据的任务" : "continue the task whose evidence is still missing"));

  if (input.language === "zh") {
    return [
      "执行已暂停：连续重复探索，没有产生新的可用证据。",
      `重复轮数：${input.repeats}`,
      `重复目标：${repeatedTargets.length > 0 ? repeatedTargets.join("、") : "未定位到单一目标"}`,
      `已确认的证据：${evidence.length > 0 ? evidence.join("；") : "暂无可用项目证据"}`,
      `最近工具：${recent.length > 0 ? recent.join("；") : "暂无"}`,
      `缺失证据：${remainingTask}`,
      "建议恢复动作：不要继续读取同一文件；改为写入/替换、读取不同目标、运行命令验证、执行 Browser/Playwright 验证，或明确说明真实阻塞原因。",
    ].join("\n");
  }

  return [
    "Execution paused: repeated exploration did not produce new usable evidence.",
    `Repeated batches: ${input.repeats}`,
    `Repeated targets: ${repeatedTargets.length > 0 ? repeatedTargets.join(", ") : "no single target identified"}`,
    `Confirmed evidence: ${evidence.length > 0 ? evidence.join("; ") : "no project evidence yet"}`,
    `Recent tools: ${recent.length > 0 ? recent.join("; ") : "none"}`,
    `Missing evidence: ${remainingTask}`,
    "Suggested recovery: do not keep reading the same file; switch to patching, inspect a different target, run command validation, use Browser/Playwright validation, or state the concrete blocker.",
  ].join("\n");
}

function normalizeMatchText(value: string): string {
  return String(value || "")
    .replace(/\\/g, "/")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function baseName(value: string): string {
  const normalized = normalizeMatchText(value);
  return normalized.split("/").filter(Boolean).pop() || normalized;
}

function collectPlanTaskMatchValues(task: PlanTask): string[] {
  const values = [
    task.text,
    ...(task.commands || []),
    ...(task.evidence || []).map((item) => item.value),
  ].map(normalizeMatchText).filter(Boolean);
  return [...new Set(values)];
}

function extractPathLikeSegments(value: string): string[] {
  const source = String(value || "").replace(/\\/g, "/");
  const matches = source.match(/[A-Za-z0-9_.@-]+(?:\/[A-Za-z0-9_.@-]+)+/g) || [];
  return matches.map(normalizeMatchText).filter(Boolean);
}

function collectActivityTargets(input: {
  recentToolActivity: PlanToolActivitySummary[];
  currentTool?: string;
  latestEvidence?: string;
}): string[] {
  const values: string[] = [];
  for (const activity of input.recentToolActivity.slice(-4).reverse()) {
    if (activity.target) values.push(activity.target);
    values.push(`${activity.name} ${activity.target || ""}`);
  }
  if (input.currentTool) values.push(input.currentTool);
  if (input.latestEvidence) values.push(input.latestEvidence);
  const expanded = values.flatMap((value) => [value, ...extractPathLikeSegments(value)]);
  return [...new Set(expanded.map(normalizeMatchText).filter(Boolean))];
}

function scoreTaskForActivity(task: PlanTask, targets: string[]): number {
  const taskValues = collectPlanTaskMatchValues(task);
  if (taskValues.length === 0 || targets.length === 0) return 0;
  let score = 0;
  for (const target of targets) {
    const targetBase = baseName(target);
    if (!targetBase) continue;
    for (const value of taskValues) {
      const valueBase = baseName(value);
      if (value === target || (value.length > 8 && target.includes(value)) || (target.length > 8 && value.includes(target))) {
        score = Math.max(score, 8);
      } else if (valueBase && valueBase.length > 3 && valueBase === targetBase) {
        score = Math.max(score, 5);
      } else if (targetBase.length > 4 && value.includes(targetBase)) {
        score = Math.max(score, 3);
      }
    }
  }
  if (score > 0 && task.status !== "completed") score += 1;
  return score;
}

function resolveActivePlanTask(input: {
  tasks: PlanTask[];
  recentToolActivity: PlanToolActivitySummary[];
  currentTool?: string;
  latestEvidence?: string;
}): PlanTask | undefined {
  const targets = collectActivityTargets(input);
  let bestTask: PlanTask | undefined;
  let bestScore = 0;
  let bestIndex = -1;
  input.tasks.forEach((task, index) => {
    const score = scoreTaskForActivity(task, targets);
    if (score < 3) return;
    if (!bestTask || score > bestScore || (score === bestScore && index > bestIndex)) {
      bestTask = task;
      bestScore = score;
      bestIndex = index;
    }
  });
  return bestTask;
}

function isBroadPlanTask(task: PlanTask | undefined): boolean {
  const text = normalizeMatchText(task?.text || "");
  if (!text) return false;
  return /^(?:目标|goal)[：:]/i.test(text) ||
    /(?:\b\d+\s*(?:个|core)?\s*(?:核心)?(?:问题|issues)|整体|全局|设计规范|design\s+spec|all\s+core\s+issues)/i.test(text);
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

function getPlanProgressStatusText(phase: PlanExecutionProgressPhase, language: "zh" | "en"): string {
  if (language === "zh") {
    if (phase === "auto_resume") return "计划自动恢复中";
    if (phase === "paused") return "计划已暂停，等待继续执行";
    if (phase === "completed") return "计划执行已完成";
    if (phase === "tool_error") return "计划执行遇到工具错误";
    if (phase === "tool_start") return "正在执行工具";
    if (phase === "tool_done") return "工具结果已记录";
    return "执行状态已更新";
  }

  if (phase === "auto_resume") return "Plan auto-resume in progress";
  if (phase === "paused") return "Plan paused, waiting to continue";
  if (phase === "completed") return "Plan execution completed";
  if (phase === "tool_error") return "Plan execution hit a tool error";
  if (phase === "tool_start") return "Tool is running";
  if (phase === "tool_done") return "Tool result recorded";
  return "Execution status updated";
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
    return language === "zh" ? "基于压缩后的上下文继续；只在需要精确缺失行时定向读取" : "continue with compacted context; reread only the exact missing lines if needed";
  }
  if (phase === "waiting_review") {
    return language === "zh" ? "等待工具调用审批后继续执行" : "wait for tool approval, then continue execution";
  }
  if (phase === "tool_error") {
    return language === "zh" ? "根据工具错误修正下一步，必要时暂停给出恢复信息" : "recover from the tool error or pause with recovery details";
  }
  if (remainingTask) {
    return compactLine(
      language === "zh"
        ? `继续满足剩余证据，可按当前诊断选择最合理顺序：${remainingTask.text}`
        : `continue satisfying remaining evidence in the most reasonable order: ${remainingTask.text}`,
    );
  }
  return language === "zh"
    ? "确认 runtime 任务清单、交付物与验证证据都已满足；tasks.md 仅在已知存在时同步"
    : "confirm the runtime task list, deliverables, and verification evidence are satisfied; sync tasks.md only if it is known to exist";
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
  progressSignature?: string;
  repeatedTargets?: string[];
  lastEffectiveEvidenceAt?: number;
  recoveryReason?: string;
}): PlanExecutionProgressUpdate {
  const audit = buildPlanTaskEvidenceAudit({
    tasks: input.tasks,
    evidenceLedger: input.evidenceLedger,
    highlightNext: true,
  });
  const remaining = audit.remainingTasks;
  const remainingTask = remaining[0];
  const recentTool = input.recentToolActivity.length > 0
    ? summarizeToolActivity(input.recentToolActivity[input.recentToolActivity.length - 1])
    : "";
  const recentEvidence = summarizePlanExecutionEvidence(input.evidenceLedger, 1)[0] || "";
  const activeTask = resolveActivePlanTask({
    tasks: audit.tasks,
    recentToolActivity: input.recentToolActivity,
    currentTool: input.currentTool,
    latestEvidence: input.latestEvidence || recentEvidence,
  });
  const currentTask = activeTask
    ? summarizeTask(activeTask)
    : remainingTask && !(recentTool && isBroadPlanTask(remainingTask))
    ? summarizeTask(remainingTask)
    : recentTool
    ? compactLine(input.language === "zh" ? `当前动作：${recentTool}` : `Current action: ${recentTool}`)
    : input.language === "zh" ? "核查最终证据" : "verify final evidence";

  return {
    phase: input.phase,
    currentTask,
    currentTool: compactLine(input.currentTool || recentTool || (input.language === "zh" ? "暂无工具调用" : "no tool call yet")),
    latestEvidence: compactLine(input.latestEvidence || recentEvidence || (input.language === "zh" ? "暂无项目源码证据" : "no project-source evidence yet")),
    nextStep: compactLine(input.nextStep || getPlanProgressNextStep(input.phase, remainingTask, input.language)),
    ...(input.progressSignature ? { progressSignature: compactLine(input.progressSignature, 220) } : {}),
    ...(input.repeatedTargets && input.repeatedTargets.length > 0
      ? { repeatedTargets: input.repeatedTargets.map((target) => compactLine(target, 100)).filter(Boolean).slice(0, 8) }
      : {}),
    ...(input.lastEffectiveEvidenceAt ? { lastEffectiveEvidenceAt: Math.max(0, Number(input.lastEffectiveEvidenceAt) || 0) } : {}),
    ...(input.recoveryReason ? { recoveryReason: compactLine(input.recoveryReason, 160) } : {}),
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
    progressSignature: compactLine(input.update.progressSignature || previous?.progressSignature || "", 220) || undefined,
    repeatedTargets: (input.update.repeatedTargets || previous?.repeatedTargets || [])
      .map((target) => compactLine(target, 100))
      .filter(Boolean)
      .slice(0, 8),
    lastEffectiveEvidenceAt: Math.max(0, Number(input.update.lastEffectiveEvidenceAt ?? previous?.lastEffectiveEvidenceAt) || 0) || undefined,
    recoveryReason: compactLine(input.update.recoveryReason || previous?.recoveryReason || "", 160) || undefined,
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
  const statusText = getPlanProgressStatusText(snapshot.phase, language);
  return language === "zh" ? `${phaseLabel}：${statusText}。` : `${phaseLabel}: ${statusText}.`;
}

export function formatPlanExecutionProgressSnapshot(
  snapshot: PlanExecutionProgressSnapshot,
  language: "zh" | "en",
): string {
  const phaseLabel = getPlanProgressPhaseLabel(snapshot.phase, language);
  const turnInfo = snapshot.maxIterations > 0
    ? `${snapshot.iteration}/${snapshot.maxIterations}`
    : String(snapshot.iteration || 0);
  const statusText = getPlanProgressStatusText(snapshot.phase, language);
  return language === "zh"
    ? [
        `${phaseLabel} · 轮次 ${turnInfo} · 自动恢复 ${snapshot.autoResumeCount}/${PLAN_MAX_AUTO_RESUME_LIMIT}`,
        statusText,
      ].join("\n")
    : [
        `${phaseLabel} · turn ${turnInfo} · auto-resume ${snapshot.autoResumeCount}/${PLAN_MAX_AUTO_RESUME_LIMIT}`,
        statusText,
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
  const audit = buildPlanTaskEvidenceAudit({
    tasks: input.tasks,
    evidenceLedger: input.evidenceLedger,
    highlightNext: true,
  });
  const remaining = audit.remainingTasks;
  const completedEvidence = summarizePlanExecutionEvidence(input.evidenceLedger);
  const currentTask = remaining[0]
    ? summarizeTask(remaining[0])
    : "No task with unsatisfied evidence was found; verify the runtime task list and current workspace state. tasks.md is optional; do not read it just to check existence.";

  return {
    reason: "max_iterations_checkpoint",
    iterationCount: input.iterationCount,
    maxIterations: input.maxIterations,
    autoResumeCount: Math.max(0, input.autoResumeCount),
    currentTask,
    remainingTasks: topLines(
      remaining.map(summarizeTask),
      "No remaining task summary available; reconcile the runtime task list, current workspace state, and evidence before continuing. Read tasks.md only if it is already known to exist.",
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
  return language === "zh"
    ? [
        `计划执行达到 ${checkpoint.maxIterations} 轮安全边界，MAIN 已保存检查点并自动开启 1 次恢复上下文。`,
        "计划将继续执行；恢复上下文会重新读取当前 workspace 状态。",
      ].join("\n")
    : [
        `Plan execution reached the ${checkpoint.maxIterations}-iteration safety boundary. MAIN saved a checkpoint and will auto-resume once in a fresh context.`,
        "Plan execution will continue; the recovery context will reread the current workspace state.",
      ].join("\n");
}

export function buildPlanMaxIterationsPauseNotice(
  checkpoint: PlanMaxIterationsCheckpoint,
  language: "zh" | "en",
): string {
  const evidenceLines = checkpoint.completedEvidence.slice(0, 4).map((line) => `- ${line}`);
  const rawRemainingLines = checkpoint.remainingTasks.slice(0, 5);
  const hasOnlyFallbackRemaining =
    rawRemainingLines.length === 1 &&
    /No remaining task summary available/i.test(rawRemainingLines[0] || "");
  const remainingLines = hasOnlyFallbackRemaining ? [] : rawRemainingLines.map((line) => `- ${line}`);
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
      ...(remainingLines.length ? remainingLines : ["- 请核查 runtime 任务清单、当前 workspace 状态和证据摘要后继续；只有已知存在时才读取 tasks.md"]),
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
    ...(remainingLines.length ? remainingLines : ["- Reconcile the runtime task list, current workspace state, and evidence summary, then continue; read tasks.md only if it is already known to exist"]),
    "- blockers:",
    ...(blockerLines.length ? blockerLines : ["- Hit the plan execution iteration safety limit"]),
    "",
    "Next: click Resume Execution to start a fresh recovery context, reread current workspace state, and continue with the evidence-unsatisfied task that best matches the current diagnosis.",
  ].join("\n");
}

export function buildExecuteMaxIterationsAutoResumeNotice(
  checkpoint: PlanMaxIterationsCheckpoint,
  language: "zh" | "en",
): string {
  return language === "zh"
    ? [
        `执行达到 ${checkpoint.maxIterations} 轮安全边界，MAIN 已保存恢复点并自动开启 1 次恢复上下文。`,
        "接下来会复用检查点与压缩记忆，并临时收窄工具面，避免重复同一批读取操作。",
      ].join("\n")
    : [
        `Execution reached the ${checkpoint.maxIterations}-iteration safety boundary. MAIN saved a recovery checkpoint and will auto-resume once in a fresh context.`,
        "The recovery context will reuse the checkpoint plus compact memory and temporarily narrow tools to avoid repeating the same reads.",
      ].join("\n");
}

export function buildExecuteMaxIterationsPauseNotice(
  checkpoint: PlanMaxIterationsCheckpoint,
  language: "zh" | "en",
): string {
  const toolLines = checkpoint.recentToolActivity.slice(-6).map((activity) => `- ${summarizeToolActivity(activity)}`);
  const blockerLines = checkpoint.unresolvedBlockers.slice(0, 3).map((line) => `- ${line}`);

  if (language === "zh") {
    return [
      `执行已暂停：本轮达到 ${checkpoint.iterationCount}/${checkpoint.maxIterations} 轮安全边界。`,
      "这不是工具权限或模式切换失败；MAIN 已保留当前 workspace、工具结果和恢复点，避免继续进入无限工具循环。",
      "",
      "RecoveryDetails:",
      `- reason: ${checkpoint.reason}`,
      `- autoResumeCount: ${checkpoint.autoResumeCount}/${PLAN_MAX_AUTO_RESUME_LIMIT}`,
      checkpoint.lastAssistantText ? `- lastAssistantText: ${checkpoint.lastAssistantText}` : "",
      "- recentToolActivity:",
      ...(toolLines.length ? toolLines : ["- 无"]),
      "- blockers:",
      ...(blockerLines.length ? blockerLines : ["- 命中执行安全轮次上限"]),
      "",
      "下一步：点击或发送 Resume Execution / 继续执行。请复用已读上下文，不要重复只读检查；MAIN 会开启新的恢复上下文，复用检查点并收窄只读工具，只执行最小必要的写入、命令验证、浏览器验证或明确阻塞说明。",
    ].filter(Boolean).join("\n");
  }

  return [
    `Execution paused after reaching the ${checkpoint.iterationCount}/${checkpoint.maxIterations}-iteration safety boundary.`,
    "This is not a tool permission or mode-switch failure. MAIN preserved the workspace state, tool results, and a recovery checkpoint to avoid an infinite tool loop.",
    "",
    "RecoveryDetails:",
    `- reason: ${checkpoint.reason}`,
    `- autoResumeCount: ${checkpoint.autoResumeCount}/${PLAN_MAX_AUTO_RESUME_LIMIT}`,
    checkpoint.lastAssistantText ? `- lastAssistantText: ${checkpoint.lastAssistantText}` : "",
    "- recentToolActivity:",
    ...(toolLines.length ? toolLines : ["- none"]),
    "- blockers:",
    ...(blockerLines.length ? blockerLines : ["- Hit the execution iteration safety limit"]),
    "",
    "Next: click or send Resume Execution. Reuse read context instead of repeating read-only checks; MAIN will start a fresh recovery context, reuse the checkpoint, narrow read-only tools, and run only the minimum necessary write, command validation, browser validation, or concrete blocker report.",
  ].filter(Boolean).join("\n");
}

export function buildExecuteMaxIterationsResumePrompt(input: {
  language: "zh" | "en";
  checkpoint: PlanMaxIterationsCheckpoint;
}): string {
  const toolText = input.checkpoint.recentToolActivity.slice(-8)
    .map((activity) => `- ${summarizeToolActivity(activity)}`)
    .join("\n") || (input.language === "zh" ? "- 暂无工具活动摘要" : "- No recent tool activity summary");

  if (input.language === "zh") {
    return [
      "请在新的恢复上下文中继续上一轮执行任务。这是 MAIN 在普通 Execute 25 轮安全边界后的自动恢复，只允许继续真实未完成工作。",
      "复用下面的检查点、最近工具结果和压缩记忆；如果任务已经完成，直接输出最终总结并停止，不要再调用工具。",
      "如果仍需工具，只选择一个最小必要的下一步动作：写入/替换、运行有限命令、浏览器验证，或说明精确阻塞。不要重复读取最近已有结果的同一批文件。",
      "MAIN 会临时收窄宽泛读取工具；只有 patch mismatch 需要精确当前内容时才做一次定向读取。",
      "",
      "Checkpoint:",
      `- iterationBoundary: ${input.checkpoint.iterationCount}/${input.checkpoint.maxIterations}`,
      input.checkpoint.lastAssistantText ? `- lastAssistantText: ${input.checkpoint.lastAssistantText}` : "",
      "",
      "最近工具活动：",
      toolText,
    ].filter(Boolean).join("\n");
  }

  return [
    "Continue the previous execute task in a fresh recovery context. This is MAIN's automatic recovery after the normal Execute 25-iteration safety boundary; only continue real unfinished work.",
    "Reuse the checkpoint, recent tool results, and compact memory below. If the task is complete, output the final summary and stop without more tools.",
    "If another tool is still needed, choose exactly one smallest necessary action: patch/write, run a finite command, use browser validation, or state the exact blocker. Do not repeat the same reads that already have results.",
    "MAIN will temporarily narrow broad read tools; do a targeted file read only when a patch mismatch requires exact current content.",
    "",
    "Checkpoint:",
    `- iterationBoundary: ${input.checkpoint.iterationCount}/${input.checkpoint.maxIterations}`,
    input.checkpoint.lastAssistantText ? `- lastAssistantText: ${input.checkpoint.lastAssistantText}` : "",
    "",
    "Recent tool activity:",
    toolText,
  ].filter(Boolean).join("\n");
}

export function buildPlanMaxIterationsResumePrompt(input: {
  language: "zh" | "en";
  checkpoint: PlanMaxIterationsCheckpoint;
  hasTasksArtifact: boolean;
  tasks: PlanTask[];
  artifacts: PlanArtifact[];
  evidenceLedger: PlanExecutionEvidenceEntry[];
}): string {
  const audit = buildPlanTaskEvidenceAudit({
    tasks: input.tasks,
    evidenceLedger: input.evidenceLedger,
    highlightNext: true,
  });
  const remaining = audit.remainingTasks.slice(0, 8);
  const remainingText = remaining.length > 0
    ? remaining.map((task, index) => `${index + 1}. ${summarizeTask(task)}`).join("\n")
    : input.language === "zh"
    ? "没有找到证据未满足的任务；请先核查 runtime 任务清单是否为空、已完成或状态不可信。tasks.md 是可选审计文件，不要为了确认是否存在而读取它。"
    : "No task with unsatisfied evidence was found; first verify whether the runtime task list is empty, complete, or stale. tasks.md is optional; do not read it just to check existence.";
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
        ? "先重新读取当前 workspace 状态和 `.MAIN/plans/tasks.md`，选择证据未满足且与当前改动最相关的任务继续；顺序是参考，不是强制线性流程。"
        : input.tasks.length > 0
        ? "当前已有 runtime 任务清单；先重新读取当前 workspace 状态，再选择证据未满足且与当前诊断最相关的任务继续。只有长任务、跨会话恢复或需要审计留档时才持久化 `.MAIN/plans/tasks.md`；不要为了确认它是否存在而读取它。"
        : "先基于已批准的 plan.md 或 bugfix.md 派生 runtime 任务清单；旧 requirements.md 和 design.md 只作为历史辅助上下文。只有长任务、跨会话恢复或需要审计留档时才生成 `.MAIN/plans/tasks.md`；不要默认读取缺失的 tasks.md。",
      "不要重做已经满足证据的任务；如果存在 tasks.md，不要只修改 checkbox；不要重复计划说明；不要把 `.MAIN/plans` 当作用户源码证据。需要判断源码现状时，直接读取真实项目文件。",
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
      ? "First reread current workspace state and `.MAIN/plans/tasks.md`, then choose the evidence-unsatisfied task that best matches the current change; task order is guidance, not a forced linear path."
      : input.tasks.length > 0
      ? "A runtime task list is already available; first reread current workspace state, then choose the evidence-unsatisfied task that best matches the current diagnosis. Persist `.MAIN/plans/tasks.md` only for long work, cross-session recovery, or audit-file needs; do not read it just to check existence."
      : "First derive a runtime task list from the approved plan.md or bugfix.md; use any legacy requirements.md/design.md only as supporting context. Generate `.MAIN/plans/tasks.md` only for long work, cross-session recovery, or audit-file needs; do not read missing tasks.md by default.",
    "Do not redo tasks whose evidence is already satisfied. If tasks.md exists, do not only edit checkboxes. Do not restate the plan. Do not treat `.MAIN/plans` as project-source evidence; read real project files when source state matters.",
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
