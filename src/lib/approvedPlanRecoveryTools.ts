export interface ApprovedPlanRecoveryActivityLike {
  name?: string;
  status?: string;
  detail?: string;
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

export function isPatchMismatchRecoveryActivity(activity: ApprovedPlanRecoveryActivityLike): boolean {
  if (activity.name !== "replace_in_file" || activity.status !== "failed") return false;
  return /(?:search_text|not\s+found|no\s+match|mismatch|不一致|未匹配|未找到|patch)/i.test(activity.detail || "");
}

export function shouldAllowApprovedPlanRecoveryFileRead(
  recentActivity: ApprovedPlanRecoveryActivityLike[],
): boolean {
  const recent = recentActivity.slice(-6);
  let latestPatchMismatchIndex = -1;
  let latestFileReadIndex = -1;
  for (let index = 0; index < recent.length; index += 1) {
    const activity = recent[index];
    if (isPatchMismatchRecoveryActivity(activity)) latestPatchMismatchIndex = index;
    if (activity.name === "read_file") latestFileReadIndex = index;
  }
  return latestPatchMismatchIndex >= 0 && latestPatchMismatchIndex > latestFileReadIndex;
}

export function isApprovedPlanRecoveryToolName(
  name: string,
  readOnlyTools: Set<string>,
  options: { allowFileRead?: boolean } = {},
): boolean {
  if (!readOnlyTools.has(name)) return true;
  if (APPROVED_PLAN_RECOVERY_TARGETING_TOOLS.has(name)) return true;
  return Boolean(options.allowFileRead && APPROVED_PLAN_PATCH_RECOVERY_READ_TOOLS.has(name));
}

export function describeApprovedPlanRecoveryToolSurface(allowFileRead: boolean): string {
  return allowFileRead ? "action_plus_patch_file_read" : "action_plus_targeting_reads";
}
