import { workspacePathsReferToSameFile } from "./workspacePaths";

export type ExecuteRecoveryMode =
  | "normal"
  | "mutation_first"
  | "action_plus_targeting"
  | "patch_recovery_read"
  | "validation_only"
  | "finite_validation_only"
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

export interface ExecuteRecoveryBatchCallLike {
  id: string;
  name: string;
  target?: string;
}

export interface ExecuteRecoveryBatchDecision {
  active: boolean;
  phase: "normal" | "need_context" | "need_mutation" | "need_validation" | "legacy_action";
  selectedCallId: string | null;
  selectedToolName: string | null;
  deferredCallIds: string[];
}

export const EXECUTE_RECOVERY_TARGETING_TOOLS = new Set([
  "grep_search",
  "get_file_outline",
  "code_ast_query",
  "find_symbol_references",
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
  "git_status",
  "git_diff",
  "send_pty_input",
  "read_pty_buffer",
  "read_pty_tail",
  "read_pty_since",
  "get_pty_status",
  "clear_pty_buffer",
]);

export const EXECUTE_RECOVERY_FINITE_VALIDATION_TOOLS = new Set([
  "run_command",
]);

export const EXECUTE_RECOVERY_MUTATION_TOOLS = new Set([
  "apply_patch",
  "replace_in_file",
  "write_file",
]);

export const EXECUTE_RECOVERY_MUTATION_FIRST_TOOLS = new Set([
  ...EXECUTE_RECOVERY_MUTATION_TOOLS,
  ...EXECUTE_RECOVERY_VALIDATION_TOOLS,
]);

const READ_ONLY_NO_PROGRESS_DETAIL_RE = /FILE_UNCHANGED_STUB|CACHED_FILE_REPLAY|Repeated read-only tool call skipped|READ_FILE_REPEAT_LIMIT|READ_ONLY_REPEAT_LIMIT|already called with identical arguments|already been read with the same range|already covered by unchanged earlier read_file results|Covered read windows already in context|READ_FILE_WINDOW_NARROWED|overlapping unchanged lines already in context/i;

export function normalizeExecuteRecoveryMode(value: unknown): ExecuteRecoveryMode {
  return value === "mutation_first" ||
    value === "action_plus_targeting" ||
    value === "patch_recovery_read" ||
    value === "validation_only" ||
    value === "finite_validation_only" ||
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
  _recentActivity: ExecuteRecoveryActivityLike[],
  mode: ExecuteRecoveryMode = "normal",
): boolean {
  // Tool definitions are chosen before the next call arguments are known.
  // Availability must therefore come from the recovery transaction phase,
  // never from a history-wide read count that can hide a required new target.
  return normalizeExecuteRecoveryMode(mode) === "patch_recovery_read";
}

function normalizeExecuteRecoveryTarget(value: unknown): string {
  return String(value || "")
    .trim()
    .replace(/^['"]|['"]$/g, "")
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/");
}

function isSuccessfulExecutePatchRecoveryResolution(
  activity: ExecuteRecoveryActivityLike,
  mismatchTarget: string,
): boolean {
  if (activity.status !== "succeeded") return false;
  if (!workspacePathsReferToSameFile(String(activity.target || ""), mismatchTarget)) return false;
  return activity.name === "read_file" || EXECUTE_RECOVERY_MUTATION_TOOLS.has(String(activity.name || ""));
}

/**
 * Return the newest patch-mismatch target that has not yet received a fresh
 * read or a successful mutation. This is a target-scoped, one-shot cache lease.
 */
export function resolveExecutePatchRecoveryTarget(
  recentActivity: ExecuteRecoveryActivityLike[],
): string | null {
  // recentToolActivity is already bounded by the runtime. Inspect the whole
  // retained window so unrelated tool calls cannot prematurely expire an
  // unresolved patch mismatch.
  const recent = recentActivity.slice(-12);
  for (let index = recent.length - 1; index >= 0; index -= 1) {
    const activity = recent[index];
    if (!isExecutePatchMismatchRecoveryActivity(activity)) continue;
    const mismatchTarget = normalizeExecuteRecoveryTarget(activity.target);
    if (!mismatchTarget) continue;
    const alreadyResolved = recent
      .slice(index + 1)
      .some((next) => isSuccessfulExecutePatchRecoveryResolution(next, mismatchTarget));
    if (!alreadyResolved) return mismatchTarget;
  }
  return null;
}

export function shouldBypassExecuteReadCacheForPatchRecovery(input: {
  toolName: string;
  allowFileRead: boolean;
  target: string;
  recentActivity: ExecuteRecoveryActivityLike[];
}): boolean {
  if (input.toolName !== "read_file" || !input.allowFileRead) return false;
  const recoveryTarget = resolveExecutePatchRecoveryTarget(input.recentActivity);
  return recoveryTarget !== null && workspacePathsReferToSameFile(input.target, recoveryTarget);
}

export function shouldUseExecutePatchRecoveryReadLease(input: {
  toolName: string;
  allowFileRead: boolean;
  target: string;
  recentActivity: ExecuteRecoveryActivityLike[];
  leaseClaimed: boolean;
}): boolean {
  return !input.leaseClaimed && shouldBypassExecuteReadCacheForPatchRecovery(input);
}

/**
 * Normalize native, XML, and compatibility-model multi-call responses into a
 * single recovery transaction step. A read and an edit generated in the same
 * response cannot be causally related because the edit has not seen the read
 * result yet, so every non-selected call is closed as deferred feedback.
 */
export function resolveExecuteRecoveryBatchDecision(input: {
  mode: ExecuteRecoveryMode;
  calls: ExecuteRecoveryBatchCallLike[];
  recentActivity?: ExecuteRecoveryActivityLike[];
  expectedTarget?: string | null;
}): ExecuteRecoveryBatchDecision {
  const mode = normalizeExecuteRecoveryMode(input.mode);
  const calls = Array.isArray(input.calls) ? input.calls : [];
  if (mode === "normal") {
    return {
      active: false,
      phase: "normal",
      selectedCallId: null,
      selectedToolName: null,
      deferredCallIds: [],
    };
  }

  const phase = mode === "patch_recovery_read"
    ? "need_context" as const
    : mode === "mutation_first"
      ? "need_mutation" as const
      : mode === "validation_only" || mode === "finite_validation_only"
        ? "need_validation" as const
        : "legacy_action" as const;
  const eligible = calls.filter((call) => isExecuteRecoveryToolName(
    call.name,
    new Set(EXECUTE_RECOVERY_PATCH_READ_TOOLS),
    { mode, allowFileRead: mode === "patch_recovery_read" },
  ));
  const transactionTarget = String(input.expectedTarget || "").trim() || (
    mode === "patch_recovery_read"
      ? resolveExecutePatchRecoveryTarget(input.recentActivity || [])
      : null
  );
  const requiresTargetMatch = Boolean(transactionTarget) && (
    mode === "patch_recovery_read" ||
    mode === "mutation_first" ||
    mode === "action_only"
  );
  const matchingTargetCall = requiresTargetMatch
    ? eligible.find((call) =>
        workspacePathsReferToSameFile(call.target || "", transactionTarget || "")
      )
    : undefined;
  // A malformed or partially streamed apply_patch may not expose a target yet.
  // If it is the only eligible mutation, let normal patch parsing and mutation
  // preflight return the precise error instead of silently deferring the call.
  const soleUnresolvedPatch =
    requiresTargetMatch &&
    eligible.length === 1 &&
    eligible[0]?.name === "apply_patch" &&
    /^(?:workspace patch)?$/i.test(String(eligible[0]?.target || "").trim());
  const selected = requiresTargetMatch
    ? matchingTargetCall || (soleUnresolvedPatch ? eligible[0] : undefined)
    : eligible[0];
  return {
    active: true,
    phase,
    selectedCallId: selected?.id || null,
    selectedToolName: selected?.name || null,
    deferredCallIds: calls
      .filter((call) => call.id !== selected?.id)
      .map((call) => call.id),
  };
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
  if (mode === "finite_validation_only") {
    return EXECUTE_RECOVERY_FINITE_VALIDATION_TOOLS.has(name);
  }
  if (mode === "mutation_first") {
    return EXECUTE_RECOVERY_MUTATION_TOOLS.has(name);
  }
  if (mode === "patch_recovery_read") {
    return Boolean(options.allowFileRead && EXECUTE_RECOVERY_PATCH_READ_TOOLS.has(name));
  }
  if (mode === "action_only") return EXECUTE_RECOVERY_MUTATION_TOOLS.has(name);
  if (mode === "action_plus_targeting") {
    return EXECUTE_RECOVERY_MUTATION_TOOLS.has(name) || EXECUTE_RECOVERY_TARGETING_TOOLS.has(name);
  }
  return !readOnlyTools.has(name);
}

export function describeExecuteRecoveryToolSurface(
  mode: ExecuteRecoveryMode,
  allowFileRead = false,
): string {
  const normalized = normalizeExecuteRecoveryMode(mode);
  if (normalized === "normal") return "normal";
  if (normalized === "validation_only") return "validation_only";
  if (normalized === "finite_validation_only") return "finite_validation_only";
  if (normalized === "action_only") return "action_only";
  if (normalized === "mutation_first") {
    return "mutation_only";
  }
  if (normalized === "patch_recovery_read") return "context_read_only";
  if (allowFileRead) return "action_plus_targeted_file_read";
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

export function isReadOnlyNoProgressDetail(value: string | undefined): boolean {
  return READ_ONLY_NO_PROGRESS_DETAIL_RE.test(String(value || ""));
}

export function countRecentCachedReadOnlyActivities(
  recentActivity: ExecuteRecoveryActivityLike[],
  readOnlyTools: Set<string>,
): number {
  return recentActivity
    .filter((activity) =>
      activity.status === "succeeded" &&
      readOnlyTools.has(String(activity.name || "")) &&
      isReadOnlyNoProgressDetail(activity.detail)
    )
    .length;
}

function resolveEquivalentRecoveryTargetKey(
  counts: Map<string, number>,
  target: string,
): string {
  return [...counts.keys()].find((candidate) =>
    workspacePathsReferToSameFile(candidate, target)
  ) || target;
}

export function getMaxRepeatedReadOnlyTargetScore(
  recentActivity: ExecuteRecoveryActivityLike[],
  readOnlyTools: Set<string>,
): number {
  const counts = new Map<string, number>();
  for (const activity of recentActivity) {
    if (activity.status !== "succeeded") continue;
    if (!readOnlyTools.has(String(activity.name || ""))) continue;
    const target = String(activity.target || "").trim();
    if (!target) continue;
    const targetKey = resolveEquivalentRecoveryTargetKey(counts, target);
    const cachedWeight = isReadOnlyNoProgressDetail(activity.detail) ? 2 : 1;
    counts.set(targetKey, (counts.get(targetKey) || 0) + cachedWeight);
  }
  return Math.max(0, ...counts.values());
}

export function summarizeRepeatedExecuteTargets(
  recentActivity: ExecuteRecoveryActivityLike[],
  maxTargets = 4,
): string[] {
  const counts = new Map<string, number>();
  for (const activity of recentActivity) {
    const target = String(activity.target || "").trim();
    if (!target) continue;
    const targetKey = resolveEquivalentRecoveryTargetKey(counts, target);
    const cachedWeight = isReadOnlyNoProgressDetail(activity.detail) ? 2 : 1;
    counts.set(targetKey, (counts.get(targetKey) || 0) + cachedWeight);
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
  minRepeatedReadOnlyTargetScore?: number;
  maxNoProgressReadOnlyRepeats?: number;
  maxReadOnlyToolChars?: number;
}): { shouldRecover: boolean; reason: string; readOnlyActivityCount: number; batchToolChars: number; cachedReadOnlyActivityCount: number; repeatedReadOnlyTargetScore: number } {
  const readOnlyActivityCount = countRecentReadOnlyActivities(input.recentActivity, input.readOnlyTools);
  const cachedReadOnlyActivityCount = countRecentCachedReadOnlyActivities(input.recentActivity, input.readOnlyTools);
  const repeatedReadOnlyTargetScore = getMaxRepeatedReadOnlyTargetScore(input.recentActivity, input.readOnlyTools);
  const batchToolChars = input.currentBatchToolChars ?? countExecuteBatchToolContentChars(input.results);
  if (input.sawExecuteOperationEvidence) {
    return { shouldRecover: false, reason: "", readOnlyActivityCount, batchToolChars, cachedReadOnlyActivityCount, repeatedReadOnlyTargetScore };
  }
  if (!isExecuteReadOnlyOnlyBatch(input.results, input.readOnlyTools)) {
    return { shouldRecover: false, reason: "", readOnlyActivityCount, batchToolChars, cachedReadOnlyActivityCount, repeatedReadOnlyTargetScore };
  }

  const repeatLimit = input.maxNoProgressReadOnlyRepeats ?? 2;
  if ((input.noProgressBatchRepeatCount ?? 0) >= repeatLimit) {
    return { shouldRecover: true, reason: "read_only_no_progress", readOnlyActivityCount, batchToolChars, cachedReadOnlyActivityCount, repeatedReadOnlyTargetScore };
  }

  const repeatedTargetLimit = input.minRepeatedReadOnlyTargetScore ?? 6;
  if (repeatedReadOnlyTargetScore >= repeatedTargetLimit) {
    return { shouldRecover: true, reason: "target_repeated_read_only", readOnlyActivityCount, batchToolChars, cachedReadOnlyActivityCount, repeatedReadOnlyTargetScore };
  }

  const readLimit = input.minReadOnlyActivities ?? 32;
  if (readOnlyActivityCount >= readLimit) {
    return { shouldRecover: true, reason: "read_only_budget_exhausted", readOnlyActivityCount, batchToolChars, cachedReadOnlyActivityCount, repeatedReadOnlyTargetScore };
  }

  const charLimit = input.maxReadOnlyToolChars ?? 30_000;
  if (batchToolChars >= charLimit) {
    return { shouldRecover: true, reason: "read_only_tool_chars_exhausted", readOnlyActivityCount, batchToolChars, cachedReadOnlyActivityCount, repeatedReadOnlyTargetScore };
  }

  const visibleResults = input.results.filter((result) => !result.internalFeedback && !result.isError);
  const allSuccessfulReadsAreCached = visibleResults.length > 0 && visibleResults.every((result) =>
    isReadOnlyNoProgressDetail(String(result.displayContent || result.content || ""))
  );
  const currentBatchHasCachedReadOnly = visibleResults.some((result) =>
    isReadOnlyNoProgressDetail(String(result.displayContent || result.content || ""))
  );
  const cachedReadLimit = input.minCachedReadOnlyActivities ?? 0;
  if (
    allSuccessfulReadsAreCached &&
    cachedReadOnlyActivityCount >= cachedReadLimit
  ) {
    return { shouldRecover: true, reason: "repeated_cached_read", readOnlyActivityCount, batchToolChars, cachedReadOnlyActivityCount, repeatedReadOnlyTargetScore };
  }
  if (currentBatchHasCachedReadOnly && cachedReadOnlyActivityCount >= cachedReadLimit) {
    return { shouldRecover: true, reason: "repeated_cached_read", readOnlyActivityCount, batchToolChars, cachedReadOnlyActivityCount, repeatedReadOnlyTargetScore };
  }

  return { shouldRecover: false, reason: "", readOnlyActivityCount, batchToolChars, cachedReadOnlyActivityCount, repeatedReadOnlyTargetScore };
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
      input.allowFileRead
        ? "Uniform action protocol (use the first applicable branch and call one tool): 1) if the intended edit target's exact current text is missing, call one targeted `read_file` for that target; 2) otherwise call one mutation tool; 3) after a successful mutation, call one finite validation tool. Never batch multiple speculative reads."
        : "Uniform action protocol (use the first applicable branch and call one tool): 1) mutate from the retained exact context; 2) after a successful mutation, call one finite validation tool; 3) if neither is possible, report the exact blocker without claiming completion.",
      "For edits, call exactly one small Codex-style patch transaction: prefer `apply_patch`, touch only the minimal file(s), and keep the patch to 1-3 focused hunks. Do not paste source code or full files into chat Markdown.",
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
    input.allowFileRead
      ? "统一行动协议（按顺序选择第一个适用分支，并且只调用一个工具）：1）缺少待编辑目标的当前精确文本时，只对该目标调用一次定向 `read_file`；2）已有精确文本时，调用一个修改工具；3）修改成功后，调用一个有限验证工具。不要在同一批次发起多个猜测性读取。"
      : "统一行动协议（按顺序选择第一个适用分支，并且只调用一个工具）：1）基于保留的精确上下文执行修改；2）修改成功后调用一个有限验证工具；3）两者都无法执行时，只报告精确阻塞，不能声称完成。",
    "编辑时必须调用一次小型 Codex-style patch 事务：优先 `apply_patch`，只触碰最小必要文件，patch 控制在 1-3 个聚焦 hunk 内。不要把源码或完整文件粘贴到聊天 Markdown。",
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

export function buildFailedFiniteValidationRecoveryPrompt(input: {
  command: string;
  result: string;
}): string {
  const command = String(input.command || "").trim() || "the failed finite command";
  const result = String(input.result || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1_200);
  return [
    "FINITE_VALIDATION_RECOVERY: The last `run_command` failed and cannot satisfy the approved Plan's command evidence.",
    `Failed command: ${command}`,
    result ? `Observed result: ${result}` : "Observed result: no usable command output was returned.",
    "The next tool surface is intentionally limited to `run_command`. Call one different finite validation command that matches the actual project runtime and source format (for example an existing test, build, typecheck, lint, or compile command).",
    "Do not switch this finite check to `execute_command` or PTY tools, do not reread an already-modified source file, and do not infer that a successful file edit was reverted merely because the validation command itself was invalid.",
    "Use stdout, stderr, and exitCode to distinguish a real source/test failure from a wrong command. If the diagnostic names a real source defect, repair it in a later normal execution transaction; otherwise choose a compatible finite command now. Do not repeat the failed command unchanged and do not claim completion before exitCode 0.",
  ].join("\n");
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
