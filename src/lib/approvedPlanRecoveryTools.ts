export interface ApprovedPlanRecoveryActivityLike {
  name?: string;
  target?: string;
  status?: string;
  detail?: string;
}

export interface ApprovedPlanToolResultLike {
  name?: string;
  isError?: boolean;
  detail?: string;
  content?: string;
  displayContent?: string;
}

export const APPROVED_PLAN_RECOVERY_TARGETING_TOOLS = new Set([
  "grep_search",
  "get_file_outline",
  "read_pty_buffer",
  "read_pty_tail",
  "read_pty_since",
  "get_pty_status",
]);

export const APPROVED_PLAN_PATCH_RECOVERY_READ_TOOLS = new Set([
  "read_file",
]);

export const APPROVED_PLAN_SOURCE_EDIT_TOOLS = new Set([
  "apply_patch",
  "replace_in_file",
  "write_file",
]);

export const APPROVED_PLAN_PTY_LIFECYCLE_TOOLS = new Set([
  "send_pty_input",
  "read_pty_buffer",
  "read_pty_tail",
  "read_pty_since",
  "get_pty_status",
  "clear_pty_buffer",
]);

export const APPROVED_PLAN_ACTION_RECOVERY_TOOLS = new Set([
  ...APPROVED_PLAN_SOURCE_EDIT_TOOLS,
  "run_command",
  "execute_command",
  // Long-lived commands are not complete at dispatch time. Keep their
  // observation/input surface available even after action-only recovery is
  // activated, otherwise the runtime creates an impossible completion gate.
  "send_pty_input",
  "read_pty_buffer",
  "read_pty_tail",
  "read_pty_since",
  "get_pty_status",
  "clear_pty_buffer",
  "browser_evaluate",
]);

export function isPatchMismatchRecoveryActivity(activity: ApprovedPlanRecoveryActivityLike): boolean {
  if (activity.status !== "failed") return false;
  if (activity.name !== "replace_in_file" && activity.name !== "apply_patch") return false;
  return /(?:search_text|not\s+found|no\s+match|mismatch|不一致|未匹配|未找到|patch|unsupported apply_patch|invalid patch|上下文)/i.test(activity.detail || "");
}

function isCachedReadOnlyResult(result: ApprovedPlanToolResultLike): boolean {
  return /FILE_UNCHANGED_STUB|Repeated read-only tool call skipped|READ_FILE_REPEAT_LIMIT/i.test([
    result.detail,
    result.displayContent,
    result.content,
  ].map((value) => String(value || "")).join("\n"));
}

export function isApprovedPlanCachedReadOnlyNoProgressBatch(input: {
  results: ApprovedPlanToolResultLike[];
  readOnlyTools: Set<string>;
  sawExecutionEvidence?: boolean;
}): boolean {
  if (input.sawExecutionEvidence) return false;
  const results = Array.isArray(input.results) ? input.results : [];
  if (results.length === 0) return false;
  const successful = results.filter((result) => !result.isError);
  if (successful.length === 0) return false;
  if (!successful.every((result) => input.readOnlyTools.has(String(result.name || "")))) return false;
  const readOnlyResults = successful.filter((result) => input.readOnlyTools.has(String(result.name || "")));
  if (readOnlyResults.length === 0) return false;
  return readOnlyResults.every(isCachedReadOnlyResult);
}

export function shouldAllowApprovedPlanRecoveryFileRead(
  recentActivity: ApprovedPlanRecoveryActivityLike[],
): boolean {
  return resolveApprovedPlanPatchRecoveryTarget(recentActivity) !== null;
}

function normalizeRecoveryTarget(value: unknown): string {
  return String(value || "")
    .trim()
    .replace(/^['"]|['"]$/g, "")
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/");
}

function isSuccessfulRecoveryResolution(
  activity: ApprovedPlanRecoveryActivityLike,
  mismatchTarget: string,
): boolean {
  if (activity.status === "failed") return false;
  if (normalizeRecoveryTarget(activity.target) !== mismatchTarget) return false;
  return activity.name === "read_file" ||
    (typeof activity.name === "string" && APPROVED_PLAN_SOURCE_EDIT_TOOLS.has(activity.name));
}

/**
 * Return the newest patch-mismatch target that has not yet been satisfied by
 * a fresh read or a successful write to that same file.
 */
export function resolveApprovedPlanPatchRecoveryTarget(
  recentActivity: ApprovedPlanRecoveryActivityLike[],
): string | null {
  const recent = recentActivity.slice(-8);
  for (let index = recent.length - 1; index >= 0; index -= 1) {
    const activity = recent[index];
    if (!isPatchMismatchRecoveryActivity(activity)) continue;
    const mismatchTarget = normalizeRecoveryTarget(activity.target);
    if (!mismatchTarget) continue;
    const alreadyResolved = recent
      .slice(index + 1)
      .some((next) => isSuccessfulRecoveryResolution(next, mismatchTarget));
    if (!alreadyResolved) return mismatchTarget;
  }
  return null;
}

export function shouldBypassApprovedPlanReadCacheForPatchRecovery(input: {
  toolName: string;
  allowFileRead: boolean;
  target: string;
  recentActivity: ApprovedPlanRecoveryActivityLike[];
}): boolean {
  if (input.toolName !== "read_file" || !input.allowFileRead) return false;
  const recoveryTarget = resolveApprovedPlanPatchRecoveryTarget(input.recentActivity);
  return recoveryTarget !== null && normalizeRecoveryTarget(input.target) === recoveryTarget;
}

export function isApprovedPlanRecoveryToolName(
  name: string,
  readOnlyTools: Set<string>,
  options: { allowFileRead?: boolean } = {},
): boolean {
  void readOnlyTools;
  if (APPROVED_PLAN_ACTION_RECOVERY_TOOLS.has(name)) return true;
  return Boolean(options.allowFileRead && APPROVED_PLAN_PATCH_RECOVERY_READ_TOOLS.has(name));
}

export function isApprovedPlanSourceEditFirstToolName(
  name: string,
  options: { allowFileRead?: boolean; preservePtyLifecycle?: boolean } = {},
): boolean {
  if (APPROVED_PLAN_SOURCE_EDIT_TOOLS.has(name)) return true;
  if (options.preservePtyLifecycle && APPROVED_PLAN_PTY_LIFECYCLE_TOOLS.has(name)) return true;
  return Boolean(options.allowFileRead && APPROVED_PLAN_PATCH_RECOVERY_READ_TOOLS.has(name));
}

export function describeApprovedPlanRecoveryToolSurface(allowFileRead: boolean): string {
  return allowFileRead ? "action_plus_patch_file_read" : "action_only";
}

export function describeApprovedPlanSourceEditFirstToolSurface(
  allowFileRead: boolean,
  preservePtyLifecycle = false,
): string {
  const base = allowFileRead ? "source_edit_plus_patch_file_read" : "source_edit_only";
  return preservePtyLifecycle ? `${base}_plus_pty_lifecycle` : base;
}
