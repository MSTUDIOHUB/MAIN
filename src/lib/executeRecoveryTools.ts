export type ExecuteRecoveryMode =
  | "normal"
  | "action_plus_targeting"
  | "patch_recovery_read"
  | "validation_only"
  | "action_only";

export interface ExecuteRecoveryActivityLike {
  name?: string;
  status?: string;
  target?: string;
  detail?: string;
}

export interface ExecuteRecoveryResultLike {
  name?: string;
  target?: string;
  content?: string;
  displayContent?: string;
  isError?: boolean;
  internalFeedback?: boolean;
}

export const EXECUTE_RECOVERY_TARGETING_TOOLS = new Set([
  "grep_search",
  "get_file_outline",
  "read_pty_buffer",
  "read_pty_tail",
  "read_pty_since",
  "get_pty_status",
]);

export const EXECUTE_RECOVERY_PATCH_READ_TOOLS = new Set([
  "read_file",
]);

export const EXECUTE_RECOVERY_VALIDATION_TOOLS = new Set([
  "run_command",
  "execute_command",
  "browser_evaluate",
  "send_pty_input",
  "read_pty_buffer",
  "read_pty_tail",
  "read_pty_since",
  "get_pty_status",
  "clear_pty_buffer",
]);

export function normalizeExecuteRecoveryMode(value: unknown): ExecuteRecoveryMode {
  return value === "action_plus_targeting" ||
    value === "patch_recovery_read" ||
    value === "validation_only" ||
    value === "action_only" ||
    value === "normal"
    ? value
    : "normal";
}

export function isExecutePatchMismatchRecoveryActivity(activity: ExecuteRecoveryActivityLike): boolean {
  if ((activity.name !== "replace_in_file" && activity.name !== "apply_patch") || activity.status !== "failed") return false;
  return /(?:search_text|not\s+found|no\s+match|mismatch|不一致|未匹配|未找到|patch)/i.test(activity.detail || "");
}

export function shouldAllowExecuteRecoveryFileRead(
  recentActivity: ExecuteRecoveryActivityLike[],
): boolean {
  const recent = recentActivity.slice(-6);
  let latestPatchMismatchIndex = -1;
  let latestFileReadIndex = -1;
  for (let index = 0; index < recent.length; index += 1) {
    const activity = recent[index];
    if (isExecutePatchMismatchRecoveryActivity(activity)) latestPatchMismatchIndex = index;
    if (activity.name === "read_file") latestFileReadIndex = index;
  }
  return latestPatchMismatchIndex >= 0 && latestPatchMismatchIndex > latestFileReadIndex;
}

export function isExecuteRecoveryToolName(
  name: string,
  readOnlyTools: Set<string>,
  options: {
    mode?: ExecuteRecoveryMode;
    allowFileRead?: boolean;
  } = {},
): boolean {
  const mode = normalizeExecuteRecoveryMode(options.mode);
  if (mode === "normal") return true;
  if (mode === "validation_only") return EXECUTE_RECOVERY_VALIDATION_TOOLS.has(name);
  if (!readOnlyTools.has(name)) return true;
  if (mode === "action_only") return false;
  if (mode === "action_plus_targeting" && EXECUTE_RECOVERY_TARGETING_TOOLS.has(name)) return true;
  return Boolean(
    (mode === "patch_recovery_read" || options.allowFileRead) &&
    EXECUTE_RECOVERY_PATCH_READ_TOOLS.has(name)
  );
}

export function describeExecuteRecoveryToolSurface(
  mode: ExecuteRecoveryMode,
  allowFileRead = false,
): string {
  const normalized = normalizeExecuteRecoveryMode(mode);
  if (normalized === "normal") return "normal";
  if (normalized === "validation_only") return "validation_only";
  if (normalized === "action_only") return "action_only";
  if (normalized === "patch_recovery_read" || allowFileRead) return "action_plus_patch_file_read";
  return "action_plus_targeting";
}

export function countRecentReadOnlyActivities(
  recentActivity: ExecuteRecoveryActivityLike[],
  readOnlyTools: Set<string>,
): number {
  return recentActivity
    .filter((activity) => activity.status === "succeeded" && readOnlyTools.has(String(activity.name || "")))
    .length;
}

export function summarizeRepeatedExecuteTargets(
  recentActivity: ExecuteRecoveryActivityLike[],
  maxTargets = 4,
): string[] {
  const counts = new Map<string, number>();
  for (const activity of recentActivity) {
    const target = String(activity.target || "").trim();
    if (!target) continue;
    const cachedWeight = /FILE_UNCHANGED_STUB|Repeated read-only tool call skipped|READ_FILE_REPEAT_LIMIT/i.test(activity.detail || "") ? 2 : 1;
    counts.set(target, (counts.get(target) || 0) + cachedWeight);
  }
  return [...counts.entries()]
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .map(([target]) => target)
    .slice(0, maxTargets);
}

export function isExecuteReadOnlyOnlyBatch(
  results: ExecuteRecoveryResultLike[],
  readOnlyTools: Set<string>,
): boolean {
  const visibleResults = results.filter((result) => !result.internalFeedback);
  return visibleResults.length > 0 && visibleResults.every((result) => readOnlyTools.has(String(result.name || "")));
}

export function countExecuteBatchToolContentChars(results: ExecuteRecoveryResultLike[]): number {
  return results.reduce((sum, result) => {
    if (result.internalFeedback) return sum;
    return sum + String(result.displayContent || result.content || "").length;
  }, 0);
}

export function resolveReadOnlyNoProgressTrigger(input: {
  results: ExecuteRecoveryResultLike[];
  recentActivity: ExecuteRecoveryActivityLike[];
  readOnlyTools: Set<string>;
  sawExecuteOperationEvidence: boolean;
  noProgressBatchRepeatCount?: number;
  currentBatchToolChars?: number;
  minReadOnlyActivities?: number;
  minCachedReadOnlyActivities?: number;
  maxNoProgressReadOnlyRepeats?: number;
  maxReadOnlyToolChars?: number;
}): { shouldRecover: boolean; reason: string; readOnlyActivityCount: number; batchToolChars: number } {
  const readOnlyActivityCount = countRecentReadOnlyActivities(input.recentActivity, input.readOnlyTools);
  const batchToolChars = input.currentBatchToolChars ?? countExecuteBatchToolContentChars(input.results);
  if (input.sawExecuteOperationEvidence) {
    return { shouldRecover: false, reason: "", readOnlyActivityCount, batchToolChars };
  }
  if (!isExecuteReadOnlyOnlyBatch(input.results, input.readOnlyTools)) {
    return { shouldRecover: false, reason: "", readOnlyActivityCount, batchToolChars };
  }

  const repeatLimit = input.maxNoProgressReadOnlyRepeats ?? 2;
  if ((input.noProgressBatchRepeatCount ?? 0) >= repeatLimit) {
    return { shouldRecover: true, reason: "read_only_no_progress", readOnlyActivityCount, batchToolChars };
  }

  const readLimit = input.minReadOnlyActivities ?? 8;
  if (readOnlyActivityCount >= readLimit) {
    return { shouldRecover: true, reason: "read_only_budget_exhausted", readOnlyActivityCount, batchToolChars };
  }

  const charLimit = input.maxReadOnlyToolChars ?? 30_000;
  if (batchToolChars >= charLimit) {
    return { shouldRecover: true, reason: "read_only_tool_chars_exhausted", readOnlyActivityCount, batchToolChars };
  }

  const visibleResults = input.results.filter((result) => !result.internalFeedback && !result.isError);
  const allSuccessfulReadsAreCached = visibleResults.length > 0 && visibleResults.every((result) =>
    /FILE_UNCHANGED_STUB|Repeated read-only tool call skipped|READ_FILE_REPEAT_LIMIT/i.test(String(result.displayContent || result.content || ""))
  );
  const cachedReadLimit = input.minCachedReadOnlyActivities ?? 0;
  if (allSuccessfulReadsAreCached && readOnlyActivityCount >= cachedReadLimit) {
    return { shouldRecover: true, reason: "repeated_cached_read", readOnlyActivityCount, batchToolChars };
  }

  return { shouldRecover: false, reason: "", readOnlyActivityCount, batchToolChars };
}

export function resolveExecuteReadOnlyRecoveryTrigger(input: Parameters<typeof resolveReadOnlyNoProgressTrigger>[0]) {
  return resolveReadOnlyNoProgressTrigger(input);
}

export function buildExecuteRecoveryPrompt(input: {
  language: "zh" | "en";
  reason: string;
  mode: ExecuteRecoveryMode;
  repeatedTargets?: string[];
  recentActivity?: ExecuteRecoveryActivityLike[];
  allowFileRead?: boolean;
}): string {
  const surface = describeExecuteRecoveryToolSurface(input.mode, input.allowFileRead);
  const isPatchMismatchRecovery =
    input.mode === "patch_recovery_read" ||
    /patch|mismatch|target_progress_patch_mismatch|search_text|not\s+found/i.test(input.reason || "");
  const repeatedTargets = input.repeatedTargets?.length
    ? input.repeatedTargets.join(input.language === "zh" ? "、" : ", ")
    : input.language === "zh" ? "最近已读目标" : "recently read targets";
  const recent = (input.recentActivity || [])
    .slice(-5)
    .map((activity) => [activity.status, activity.name, activity.target, activity.detail].filter(Boolean).join(" "))
    .join(input.language === "zh" ? "；" : "; ");

  if (input.language === "en") {
    return [
      isPatchMismatchRecovery
        ? "EXECUTE_RECOVERY: The last edit failed because the patch or replacement context did not match the current file."
        : "EXECUTE_RECOVERY: The current Execute turn has spent its read-only budget without producing write, command, or browser validation evidence.",
      `Recovery reason: ${input.reason || "read_only_no_action"}.`,
      `Recovery tool surface: ${surface}.`,
      `Repeated/known targets: ${repeatedTargets}.`,
      recent ? `Recent tool activity: ${recent}.` : "",
      isPatchMismatchRecovery
        ? "Use one targeted `read_file` only if needed, then base the next edit on text copied from that latest result. Prefer `replace_in_file` for a small exact replacement, or run validation / browser checks if the target already satisfies the task. Do not retry an `apply_patch` built from stale context."
        : input.allowFileRead
        ? "A targeted `read_file` is available to repair exact-content or patch mismatch problems; after that, patch, run a finite command, use browser validation, or state the exact blocker."
        : "No `read_file` is available in this recovery step. Reuse cached context and take the next concrete action: `apply_patch`/`replace_in_file`/`write_file`, run a finite command, use browser validation, or state the exact blocker. If grep_search already returned a line containing the failing code, treat that line as enough context for a minimal exact replacement.",
      "Do not start a new broad scan, do not reread the same files, do not use cat/sed/head/tail shell file reads as a workaround, and do not output another plan instead of action.",
    ].filter(Boolean).join("\n");
  }

  return [
    isPatchMismatchRecovery
      ? "EXECUTE_RECOVERY: 上一次编辑失败，因为 patch 或替换上下文与当前文件不匹配。"
      : "EXECUTE_RECOVERY: 当前 Execute 回合已经耗尽只读预算，但还没有产生写入、命令或浏览器验证证据。",
    `恢复原因：${input.reason || "read_only_no_action"}。`,
    `恢复工具面：${surface}。`,
    `重复/已知目标：${repeatedTargets}。`,
    recent ? `最近工具活动：${recent}。` : "",
    isPatchMismatchRecovery
      ? "只在必要时使用一次定向 `read_file`，下一次编辑必须基于最新结果中复制出来的真实文本。小范围修改优先用 `replace_in_file` 精确替换；如果目标已经满足任务，转向命令/浏览器验证。不要继续重试基于旧上下文的 `apply_patch`。"
      : input.allowFileRead
      ? "现在可使用定向 `read_file` 来修复精确内容或 patch mismatch；随后必须改为写入、运行有限命令、浏览器验证，或说明精确阻塞。"
      : "这个恢复步骤不再开放 `read_file`。请复用已缓存上下文，执行下一个具体动作：`apply_patch` / `replace_in_file` / `write_file`、运行有限命令、浏览器验证，或说明精确阻塞。如果 grep_search 已经返回包含失败代码的行，把该行视为最小精确替换的足够上下文。",
    "不要开启新一轮泛读，不要重复读取同一批文件，不要用 cat/sed/head/tail shell 读文件绕行，也不要用新的方案文档替代执行动作。",
  ].filter(Boolean).join("\n");
}

export function buildExecuteValidationRecoveryPrompt(input: {
  language: "zh" | "en";
  reason: string;
  target: string;
  editCount: number;
  recentActivity?: ExecuteRecoveryActivityLike[];
  availableValidationTools?: string[];
}): string {
  const tools = (input.availableValidationTools || [])
    .filter(Boolean)
    .map((name) => `\`${name}\``)
    .join(input.language === "zh" ? "、" : ", ");
  const recent = (input.recentActivity || [])
    .slice(-5)
    .map((activity) => [activity.status, activity.name, activity.target, activity.detail].filter(Boolean).join(" "))
    .join(input.language === "zh" ? "；" : "; ");

  if (input.language === "en") {
    return [
      "EXECUTE_RECOVERY: The approved Plan edited the same target repeatedly without fresh validation evidence.",
      `Recovery reason: ${input.reason}.`,
      `Repeated target: ${input.target || "unknown target"} (${input.editCount} edits since the last validation).`,
      tools ? `Available validation tools: ${tools}.` : "",
      recent ? `Recent tool activity: ${recent}.` : "",
      "Next response must call exactly one validation tool, preferably `run_command` for a finite build/test/lint command or `browser_evaluate` for DOM/screenshot validation.",
      "Do not edit files, do not reread files, and do not summarize completion until the validation tool returns. If automated validation is impossible, state the exact blocker without claiming the task is complete.",
    ].filter(Boolean).join("\n");
  }

  return [
    "EXECUTE_RECOVERY: 已批准 Plan 连续修改同一目标，但期间没有新的验证证据。",
    `恢复原因：${input.reason}。`,
    `重复目标：${input.target || "未知目标"}（距上次验证后已修改 ${input.editCount} 次）。`,
    tools ? `本轮可用验证工具：${tools}。` : "",
    recent ? `最近工具活动：${recent}。` : "",
    "下一条回复必须只调用一个验证工具；有限的构建/测试/lint 优先用 `run_command`，页面 DOM/截图验证用 `browser_evaluate`。",
    "不要继续编辑文件，不要重新读取文件，也不要在验证工具返回前总结完成。如果无法自动验证，请说明精确阻塞，不能声称任务完成。",
  ].filter(Boolean).join("\n");
}

export function buildExecuteNoProgressLoopPauseNotice(input: {
  language: "zh" | "en";
  repeats: number;
  remainingTask: string;
  recentActivity: ExecuteRecoveryActivityLike[];
  repeatedTargets?: string[];
  scope?: "execute" | "chat";
}): string {
  const repeatedTargets = input.repeatedTargets?.length
    ? input.repeatedTargets
    : summarizeRepeatedExecuteTargets(input.recentActivity);
  const recent = input.recentActivity
    .slice(-8)
    .map((activity) => {
      const target = activity.target ? ` ${activity.target}` : "";
      const detail = activity.detail ? ` - ${activity.detail}` : "";
      return `- ${activity.status || "unknown"}:${activity.name || "tool"}${target}${detail}`;
    });

  if (input.language === "en") {
    return [
      input.scope === "chat"
        ? "Chat turn paused: repeated read-only exploration did not produce a final answer or concrete blocker."
        : "Execution paused: repeated read-only exploration did not produce a write, command, browser validation, or concrete blocker.",
      `Repeat count: ${input.repeats}`,
      repeatedTargets.length ? `Repeated targets: ${repeatedTargets.join(", ")}` : "Repeated targets: none isolated",
      "Recent tools:",
      ...(recent.length ? recent : ["- none"]),
      `Missing progress: ${input.remainingTask}`,
      input.scope === "chat"
        ? "Resume by using cached context to answer directly, switch to a different target, or state the exact blocker."
        : "Resume by using cached context to patch/write, run a finite validation command, use browser validation, or state the exact blocker.",
    ].join("\n");
  }

  return [
    input.scope === "chat"
      ? "对话已暂停：连续重复只读探索，但没有产出最终回答或具体阻塞。"
      : "执行已暂停：连续重复只读探索，但没有产生写入、命令、浏览器验证或具体阻塞。",
    `重复轮数：${input.repeats}`,
    repeatedTargets.length ? `重复目标：${repeatedTargets.join("、")}` : "重复目标：未定位到单一目标",
    "最近工具：",
    ...(recent.length ? recent : ["- 暂无"]),
    `缺失进展：${input.remainingTask}`,
    input.scope === "chat"
      ? "恢复时请复用已读上下文，直接回答、换一个明确目标，或说明精确阻塞。"
      : "恢复时请复用已读上下文，直接写入/替换、运行有限验证命令、执行浏览器验证，或说明精确阻塞。",
  ].join("\n");
}
