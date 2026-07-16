import { workspacePathsReferToSameFile } from "./workspacePaths";
import { WORKSPACE_MUTATION_TOOL_NAMES } from "./workspaceMutationTools";
import {
  isFinitePlanValidationCommand,
  isFlexiblePlanValidationCommandEvidence,
  planCommandEvidenceMatchesExecution,
} from "./workflowModels";
export {
  classifyFailedFiniteValidationOutcome,
  compactStructuredCommandResult,
  type FailedFiniteValidationOutcome,
} from "./commandValidationOutcome";

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

export type ExecuteRecoveryContractPhase =
  | "normal"
  | "context"
  | "mutation"
  | "post_mutation_check"
  | "validation"
  | "reconcile";

export type ExecuteRecoveryNextCapability =
  | "any"
  | "targeting"
  | "targeted_read"
  | "mutation"
  | "validation"
  | "launch_long_process"
  | "recover_process"
  | "reconcile_server"
  | "observe_pty"
  | "browser_validation";

export type RecoveryReadLeasePurpose =
  | "initial_targeting"
  | "plan_line_context"
  | "patch_recovery"
  | "missing_window"
  | "context_restore"
  | "post_mutation_verify";

export interface RecoveryReadLease {
  purpose: RecoveryReadLeasePurpose;
  target: string;
  requestedRange?: { startLine?: number; endLine?: number; maxLines?: number } | null;
  /** Full reviewed range retained while segmented exact reads advance. */
  requiredRange?: { startLine?: number; endLine?: number; maxLines?: number } | null;
  coveredRanges?: Array<{ startLine: number; endLine: number }>;
  /**
   * Parser-backed declaration ranges may be larger than read_file's bounded
   * line/character envelope. In that case one exact declaration prefix is enough
   * to bind mutation preflight to current source; patch recovery still
   * requires exact coverage of its mismatch range.
   */
  coverageMode?: "exact" | "bounded_prefix" | "segmented_exact";
  observationKey?: string | null;
  observedVersion?: string | null;
  /** Stable identity of the patch failure that granted this one-shot read. */
  mismatchFingerprint?: string | null;
  state: "available" | "active" | "consumed";
}

export interface PatchRecoveryMismatchEvidence {
  mismatchFingerprint: string;
  target: string;
  requestedRange?: RecoveryReadLease["requestedRange"];
  observedVersion?: string | null;
}

export interface ExecutionDecisionCheckpoint {
  expectedTarget: string | null;
  sourceObservationKey: string | null;
  nextRequiredCapability: ExecuteRecoveryNextCapability;
  evidenceVersion?: string | null;
}

export interface ReadProgressFingerprint {
  phase: ExecuteRecoveryContractPhase;
  target: string;
  observedVersion: string | null;
  purpose: RecoveryReadLeasePurpose | "unleased";
  coverage: {
    kind: "same_window" | "overlap_extension" | "new_window";
    startLine?: number;
    endLine?: number;
    maxLines?: number;
  } | null;
  decisionCheckpoint: ExecutionDecisionCheckpoint | null;
  /**
   * Stable semantic identity used by the monotonic protocol retry counter.
   * Tiny overlap extensions deliberately share an identity; a new version,
   * phase, purpose, or decision checkpoint does not.
   */
  semanticKey: string;
}

/** Portable recovery transaction state used when a loop is resumed. */
export interface ForcedExecuteRecoveryRuntimeState {
  mode: ExecuteRecoveryMode;
  reason?: string | null;
  expectedTarget?: string | null;
  /** Recovery activations already spent before a callback or Goal slice boundary. */
  attempts?: number;
  phaseNoProgressCount?: number;
  protocolNoProgressCount?: number;
  protocolNoProgressFingerprint?: string | null;
  readLease?: RecoveryReadLease | null;
  sourceObservationKey?: string | null;
  decisionCheckpoint?: ExecutionDecisionCheckpoint | null;
}

/**
 * One provider-neutral contract owns the recovery phase, preferred next
 * capability, and exposed tool surface. ExecuteRecoveryMode remains a compact
 * persistence/logging label; callers must not maintain a second mode-specific
 * tool allowlist.
 *
 * read_file is exposed only by an explicit context/read lease (including
 * patch recovery and post-mutation verification). Mutation and validation
 * phases are strict: a provider cannot turn a named mutation request back into
 * open-ended exploration by returning another read call.
 */
export interface RecoveryActionContract {
  modeLabel: ExecuteRecoveryMode;
  phase: ExecuteRecoveryContractPhase;
  nextRequiredCapability: ExecuteRecoveryNextCapability;
  expectedTarget: string | null;
  readLease: RecoveryReadLease | null;
  sourceObservationKey: string | null;
  decisionCheckpoint: ExecutionDecisionCheckpoint | null;
  phaseNoProgressCount: number;
  protocolNoProgressCount: number;
  protocolNoProgressFingerprint: string | null;
  devServerStatus: "none" | "pending" | "running" | "ready" | "unknown" | "failed" | "stopped";
  devServerUrl: string | null;
  ptyGeneration: number | null;
  ptyOutputSequence: number | null;
  allowTargetedFileRead: boolean;
  allowsAllTools: boolean;
  allowedToolNames: ReadonlySet<string>;
  surfaceDescription: string;
}

export const EXECUTE_RECOVERY_TARGETING_TOOLS = new Set([
  "code_ast_query",
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

export const EXECUTE_RECOVERY_MUTATION_TOOLS = new Set(WORKSPACE_MUTATION_TOOL_NAMES);

export const EXECUTE_RECOVERY_MUTATION_FIRST_TOOLS = new Set([
  ...EXECUTE_RECOVERY_MUTATION_TOOLS,
  ...EXECUTE_RECOVERY_VALIDATION_TOOLS,
]);

const EXECUTE_RECOVERY_MUTATION_CONTRACT_TOOLS = new Set([
  ...EXECUTE_RECOVERY_MUTATION_TOOLS,
]);

const EXECUTE_RECOVERY_TARGETED_ACTION_CONTRACT_TOOLS = new Set([
  ...EXECUTE_RECOVERY_MUTATION_TOOLS,
  ...EXECUTE_RECOVERY_TARGETING_TOOLS,
]);

const EXECUTE_RECOVERY_VALIDATION_CONTRACT_TOOLS = new Set([
  ...EXECUTE_RECOVERY_VALIDATION_TOOLS,
]);

const EXECUTE_RECOVERY_FINITE_VALIDATION_CONTRACT_TOOLS = new Set([
  ...EXECUTE_RECOVERY_FINITE_VALIDATION_TOOLS,
]);

const EXECUTE_RECOVERY_PTY_DIAGNOSTIC_CONTRACT_TOOLS = new Set([
  "read_pty_buffer",
  "read_pty_tail",
  "read_pty_since",
  "get_pty_status",
]);

const EXECUTE_RECOVERY_PTY_OBSERVATION_CONTRACT_TOOLS = new Set([
  "send_pty_input",
  ...EXECUTE_RECOVERY_PTY_DIAGNOSTIC_CONTRACT_TOOLS,
]);

const EXECUTE_RECOVERY_BROWSER_VALIDATION_CONTRACT_TOOLS = new Set([
  "browser_evaluate",
]);

const EXECUTE_RECOVERY_LONG_PROCESS_LAUNCH_CONTRACT_TOOLS = new Set([
  "execute_command",
]);

const EXECUTE_RECOVERY_SERVER_RECONCILE_CONTRACT_TOOLS = new Set([
  "run_command",
  ...EXECUTE_RECOVERY_PTY_DIAGNOSTIC_CONTRACT_TOOLS,
]);

const EXECUTE_RECOVERY_PROCESS_FAILURE_CONTRACT_TOOLS = new Set([
  ...EXECUTE_RECOVERY_PTY_DIAGNOSTIC_CONTRACT_TOOLS,
  "run_command",
  "execute_command",
  ...EXECUTE_RECOVERY_MUTATION_TOOLS,
  ...EXECUTE_RECOVERY_PATCH_READ_TOOLS,
]);

// Runtime-owned no-progress feedback always starts with a marker. Never scan
// the whole payload: freshly read source may legitimately contain these
// strings (MAIN's own cache implementation does).
const READ_ONLY_NO_PROGRESS_DETAIL_RE = /^\s*(?:FILE_UNCHANGED_STUB|CACHED_FILE_REPLAY|READ_FILE_WINDOW_NARROWED|Repeated read-only tool call skipped|READ_FILE_REPEAT_LIMIT|READ_ONLY_REPEAT_LIMIT)\b/i;

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

export function resolveExecuteRecoveryActionContract(
  value: ExecuteRecoveryMode,
  context: {
    expectedTarget?: string | null;
    readLease?: RecoveryReadLease | null;
    sourceObservationKey?: string | null;
    decisionCheckpoint?: ExecutionDecisionCheckpoint | null;
    phaseNoProgressCount?: number;
    protocolNoProgressCount?: number;
    protocolNoProgressFingerprint?: string | null;
    devServerStatus?: "none" | "pending" | "running" | "ready" | "unknown" | "failed" | "stopped";
    devServerNextCapability?: "launch" | "observe_pty" | "browser" | "reconcile";
    devServerUrl?: string | null;
    ptyGeneration?: number | null;
    ptyOutputSequence?: number | null;
  } = {},
): RecoveryActionContract {
  const mode = normalizeExecuteRecoveryMode(value);
  const shared = {
    expectedTarget: context.expectedTarget?.trim() || null,
    readLease: context.readLease || null,
    sourceObservationKey: context.sourceObservationKey?.trim() || (
      context.readLease?.state === "consumed"
        ? context.readLease.observationKey?.trim() || null
        : null
    ),
    decisionCheckpoint: context.decisionCheckpoint || null,
    phaseNoProgressCount: Math.max(0, context.phaseNoProgressCount || 0),
    protocolNoProgressCount: Math.max(0, context.protocolNoProgressCount || 0),
    protocolNoProgressFingerprint: context.protocolNoProgressFingerprint?.trim() || null,
    devServerStatus: context.devServerStatus || "none" as const,
    devServerUrl: context.devServerUrl?.trim() || null,
    ptyGeneration: Number.isFinite(context.ptyGeneration) ? context.ptyGeneration as number : null,
    ptyOutputSequence: Number.isFinite(context.ptyOutputSequence) ? context.ptyOutputSequence as number : null,
  };
  if (mode === "normal") {
    return {
      ...shared,
      modeLabel: mode,
      phase: "normal",
      nextRequiredCapability: "any",
      allowTargetedFileRead: false,
      allowsAllTools: true,
      allowedToolNames: new Set<string>(),
      surfaceDescription: "normal",
    };
  }
  if (
    context.readLease?.purpose !== "post_mutation_verify" &&
    (context.readLease?.state === "available" || context.readLease?.state === "active")
  ) {
    return {
      ...shared,
      modeLabel: "patch_recovery_read",
      phase: "context",
      nextRequiredCapability: "targeted_read",
      allowTargetedFileRead: true,
      allowsAllTools: false,
      allowedToolNames: EXECUTE_RECOVERY_PATCH_READ_TOOLS,
      surfaceDescription: "targeted_context_read",
    };
  }
  if (
    mode === "validation_only" &&
    context.readLease?.purpose === "post_mutation_verify" &&
    (context.readLease.state === "available" || context.readLease.state === "active")
  ) {
    return {
      ...shared,
      modeLabel: mode,
      phase: "post_mutation_check",
      nextRequiredCapability: "targeted_read",
      allowTargetedFileRead: true,
      allowsAllTools: false,
      allowedToolNames: EXECUTE_RECOVERY_PATCH_READ_TOOLS,
      surfaceDescription: "post_mutation_target_read",
    };
  }
  if (
    mode === "action_plus_targeting" &&
    context.decisionCheckpoint?.nextRequiredCapability === "targeting"
  ) {
    return {
      ...shared,
      modeLabel: mode,
      phase: "context",
      nextRequiredCapability: "targeting",
      allowTargetedFileRead: false,
      allowsAllTools: false,
      allowedToolNames: EXECUTE_RECOVERY_TARGETING_TOOLS,
      surfaceDescription: "structural_targeting_only",
    };
  }
  const longRunningValidationActive = mode === "action_plus_targeting" || mode === "validation_only";
  if (
    longRunningValidationActive &&
    context.devServerNextCapability === "reconcile"
  ) {
    return {
      ...shared,
      modeLabel: mode,
      phase: "reconcile",
      nextRequiredCapability: "reconcile_server",
      allowTargetedFileRead: false,
      allowsAllTools: false,
      allowedToolNames: EXECUTE_RECOVERY_SERVER_RECONCILE_CONTRACT_TOOLS,
      surfaceDescription: "dev_server_reconcile_only",
    };
  }
  if (
    longRunningValidationActive &&
    (
      shared.devServerStatus === "failed" ||
      shared.devServerStatus === "stopped" ||
      (
        shared.devServerStatus === "none" &&
        context.decisionCheckpoint?.nextRequiredCapability === "recover_process"
      )
    )
  ) {
    return {
      ...shared,
      modeLabel: mode,
      phase: "reconcile",
      nextRequiredCapability: "recover_process",
      allowTargetedFileRead: true,
      allowsAllTools: false,
      allowedToolNames: EXECUTE_RECOVERY_PROCESS_FAILURE_CONTRACT_TOOLS,
      surfaceDescription: "dev_server_failure_recovery",
    };
  }
  if (
    longRunningValidationActive &&
    context.decisionCheckpoint?.nextRequiredCapability === "launch_long_process" &&
    shared.devServerStatus === "none"
  ) {
    return {
      ...shared,
      modeLabel: mode,
      phase: "validation",
      nextRequiredCapability: "launch_long_process",
      allowTargetedFileRead: false,
      allowsAllTools: false,
      allowedToolNames: EXECUTE_RECOVERY_LONG_PROCESS_LAUNCH_CONTRACT_TOOLS,
      surfaceDescription: "dev_server_launch_only",
    };
  }
  if (
    longRunningValidationActive &&
    (context.devServerNextCapability === "observe_pty" ||
      shared.devServerStatus === "pending" ||
      shared.devServerStatus === "running" ||
      shared.devServerStatus === "unknown")
  ) {
    return {
      ...shared,
      modeLabel: mode,
      phase: "validation",
      nextRequiredCapability: "observe_pty",
      allowTargetedFileRead: false,
      allowsAllTools: false,
      allowedToolNames: EXECUTE_RECOVERY_PTY_OBSERVATION_CONTRACT_TOOLS,
      surfaceDescription: "pty_observation_only",
    };
  }
  if (
    longRunningValidationActive &&
    (context.devServerNextCapability === "browser" || shared.devServerStatus === "ready")
  ) {
    return {
      ...shared,
      modeLabel: mode,
      phase: "validation",
      nextRequiredCapability: "browser_validation",
      allowTargetedFileRead: false,
      allowsAllTools: false,
      allowedToolNames: EXECUTE_RECOVERY_BROWSER_VALIDATION_CONTRACT_TOOLS,
      surfaceDescription: "browser_validation_only",
    };
  }
  if (mode === "patch_recovery_read") {
    return {
      ...shared,
      modeLabel: mode,
      phase: "context",
      nextRequiredCapability: "targeted_read",
      allowTargetedFileRead: true,
      allowsAllTools: false,
      allowedToolNames: EXECUTE_RECOVERY_PATCH_READ_TOOLS,
      surfaceDescription: "targeted_context_read",
    };
  }
  if (mode === "validation_only") {
    return {
      ...shared,
      modeLabel: mode,
      phase: "validation",
      nextRequiredCapability: "validation",
      allowTargetedFileRead: false,
      allowsAllTools: false,
      allowedToolNames: EXECUTE_RECOVERY_VALIDATION_CONTRACT_TOOLS,
      surfaceDescription: "validation_only",
    };
  }
  if (mode === "finite_validation_only") {
    return {
      ...shared,
      modeLabel: mode,
      phase: "validation",
      nextRequiredCapability: "validation",
      allowTargetedFileRead: false,
      allowsAllTools: false,
      allowedToolNames: EXECUTE_RECOVERY_FINITE_VALIDATION_CONTRACT_TOOLS,
      surfaceDescription: "finite_validation_only",
    };
  }
  if (mode === "action_plus_targeting") {
    return {
      ...shared,
      modeLabel: mode,
      phase: "mutation",
      nextRequiredCapability: "mutation",
      allowTargetedFileRead: false,
      allowsAllTools: false,
      allowedToolNames: EXECUTE_RECOVERY_TARGETED_ACTION_CONTRACT_TOOLS,
      surfaceDescription: "mutation_with_targeting",
    };
  }
  return {
    ...shared,
    modeLabel: mode,
    phase: "mutation",
    nextRequiredCapability: "mutation",
    allowTargetedFileRead: false,
    allowsAllTools: false,
    allowedToolNames: EXECUTE_RECOVERY_MUTATION_CONTRACT_TOOLS,
    surfaceDescription: "mutation_only",
  };
}

export function isExecutePatchMismatchRecoveryActivity(activity: ExecuteRecoveryActivityLike): boolean {
  if ((activity.name !== "replace_in_file" && activity.name !== "apply_patch") || activity.status !== "failed") return false;
  return /(?:search_text|not\s+found|no\s+match|mismatch|不一致|未匹配|未找到|patch)/i.test(activity.detail || "");
}

export function shouldAllowExecuteRecoveryFileRead(
  _recentActivity: ExecuteRecoveryActivityLike[],
  mode: ExecuteRecoveryMode = "normal",
): boolean {
  // Tool definitions are chosen before path/range/version arguments are known.
  // Keep the conditional capability visible; argument-aware cache/scope logic
  // decides whether the concrete read is fresh, replayed, stubbed, or deferred.
  return resolveExecuteRecoveryActionContract(mode).allowTargetedFileRead;
}

function normalizeExecuteRecoveryTarget(value: unknown): string {
  return String(value || "")
    .trim()
    .replace(/^['"]|['"]$/g, "")
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/");
}

export function normalizeRecoveryReadRange(
  value: unknown,
): RecoveryReadLease["requestedRange"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const range = {
    ...(Number.isFinite(candidate.startLine ?? candidate.start_line)
      ? { startLine: Math.max(1, Math.floor(Number(candidate.startLine ?? candidate.start_line))) }
      : {}),
    ...(Number.isFinite(candidate.endLine ?? candidate.end_line)
      ? { endLine: Math.max(1, Math.floor(Number(candidate.endLine ?? candidate.end_line))) }
      : {}),
    ...(Number.isFinite(candidate.maxLines ?? candidate.max_lines)
      ? { maxLines: Math.max(1, Math.floor(Number(candidate.maxLines ?? candidate.max_lines))) }
      : {}),
  };
  return Object.keys(range).length > 0 ? range : null;
}

export function recoveryReadRangesMatch(
  expected: RecoveryReadLease["requestedRange"],
  observed: RecoveryReadLease["requestedRange"],
): boolean {
  const normalizedExpected = normalizeRecoveryReadRange(expected);
  if (!normalizedExpected) return true;
  const normalizedObserved = normalizeRecoveryReadRange(observed);
  if (!normalizedObserved) return false;
  const expectedStart = normalizedExpected.startLine || 1;
  const observedStart = normalizedObserved.startLine || 1;
  if (expectedStart !== observedStart) return false;
  const expectedEnd = normalizedExpected.endLine ?? (
    normalizedExpected.maxLines
      ? expectedStart + normalizedExpected.maxLines - 1
      : null
  );
  const observedEnd = normalizedObserved.endLine ?? (
    normalizedObserved.maxLines
      ? observedStart + normalizedObserved.maxLines - 1
      : null
  );
  return expectedEnd === observedEnd;
}

export function requestedRangeFromReadObservationSignature(
  requestSignature: string,
): RecoveryReadLease["requestedRange"] {
  const argsSeparator = requestSignature.lastIndexOf("::");
  if (argsSeparator < 0) return null;
  try {
    const entries = JSON.parse(requestSignature.slice(argsSeparator + 2));
    return Array.isArray(entries)
      ? normalizeRecoveryReadRange(Object.fromEntries(entries))
      : null;
  } catch {
    return null;
  }
}

export function buildExecutePatchMismatchFingerprint(input: {
  reason: string;
  target: string;
  failureIdentity?: string | null;
}): string {
  const reason = String(input.reason || "patch_mismatch")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_:-]+/g, "_");
  const failureIdentity = String(input.failureIdentity || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_:-]+/g, "_");
  return [
    "patch_mismatch",
    normalizeExecuteRecoveryTarget(input.target).toLowerCase(),
    reason || "patch_mismatch",
    ...(failureIdentity ? [failureIdentity] : []),
  ].join("::");
}

export function buildPatchRecoveryReadNoProgressFingerprint(target: string): string {
  const normalizedTarget = normalizeExecuteRecoveryTarget(target).toLowerCase();
  return [
    "patch_recovery_read",
    normalizedTarget,
    `read_file:${normalizedTarget}:read_unchanged`,
  ].join("::");
}

export function patchRecoveryLeaseIdentityMatches(
  current: RecoveryReadLease | null | undefined,
  candidate: RecoveryReadLease | null | undefined,
): boolean {
  if (
    current?.purpose !== "patch_recovery" ||
    candidate?.purpose !== "patch_recovery" ||
    !workspacePathsReferToSameFile(current.target, candidate.target)
  ) {
    return false;
  }
  const currentFingerprint = String(current.mismatchFingerprint || "").trim();
  const candidateFingerprint = String(candidate.mismatchFingerprint || "").trim();
  const failureClass = (fingerprint: string): string => {
    const parts = fingerprint.toLowerCase().split("::");
    return parts[0] === "patch_mismatch" && parts.length >= 3
      ? parts[2]
      : fingerprint.toLowerCase();
  };
  if (
    !currentFingerprint ||
    !candidateFingerprint ||
    failureClass(currentFingerprint) !== failureClass(candidateFingerprint)
  ) {
    return false;
  }
  if (
    String(current.observedVersion || "").trim() !==
    String(candidate.observedVersion || "").trim()
  ) {
    return false;
  }
  const currentRange = normalizeRecoveryReadRange(current.requestedRange);
  const candidateRange = normalizeRecoveryReadRange(candidate.requestedRange);
  // The retry identity is semantic, not a byte-for-byte lease identity. A
  // model cannot obtain a fresh read merely by nudging or extending the same
  // hunk. A genuinely disjoint window remains eligible because it can add new
  // source evidence for the same file version.
  if (!currentRange || !candidateRange) return true;
  const toBounds = (range: NonNullable<RecoveryReadLease["requestedRange"]>) => {
    const start = Math.max(1, range.startLine || 1);
    const end = Math.max(
      start,
      range.endLine ?? (range.maxLines ? start + range.maxLines - 1 : start),
    );
    return { start, end };
  };
  const currentBounds = toBounds(currentRange);
  const candidateBounds = toBounds(candidateRange);
  return currentBounds.start <= candidateBounds.end &&
    candidateBounds.start <= currentBounds.end;
}

export function readEvidenceSatisfiesRecoveryLease(input: {
  lease: RecoveryReadLease | null | undefined;
  target: string;
  requestedRange?: RecoveryReadLease["requestedRange"];
  observedVersion?: string | null;
}): boolean {
  const lease = input.lease;
  if (!lease || !workspacePathsReferToSameFile(input.target, lease.target)) return false;
  if (lease.purpose === "patch_recovery" && !normalizeRecoveryReadRange(lease.requestedRange)) {
    return false;
  }
  const expectedRange = normalizeRecoveryReadRange(lease.requestedRange);
  const observedRange = normalizeRecoveryReadRange(input.requestedRange);
  if (lease.coverageMode === "bounded_prefix" && expectedRange) {
    if (!observedRange) return false;
    const expectedStart = expectedRange.startLine || 1;
    const expectedEnd = expectedRange.endLine ?? (
      expectedRange.maxLines
        ? expectedStart + expectedRange.maxLines - 1
        : Number.MAX_SAFE_INTEGER
    );
    const observedStart = observedRange.startLine || 1;
    const observedEnd = observedRange.endLine ?? (
      observedRange.maxLines
        ? observedStart + observedRange.maxLines - 1
        : observedStart
    );
    if (
      observedStart !== expectedStart ||
      observedEnd < observedStart ||
      observedEnd > expectedEnd
    ) {
      return false;
    }
  } else if (!recoveryReadRangesMatch(lease.requestedRange, input.requestedRange)) {
    return false;
  }
  const expectedVersion = String(lease.observedVersion || "").trim();
  const observedVersion = String(input.observedVersion || "").trim();
  return !expectedVersion || !observedVersion || expectedVersion === observedVersion;
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

export function shouldUseExecutePatchRecoveryReadLease(input: {
  toolName: string;
  allowFileRead: boolean;
  target: string;
  requestedRange?: RecoveryReadLease["requestedRange"];
  observedVersion?: string | null;
  activeReadLease?: RecoveryReadLease | null;
  leaseClaimed: boolean;
}): boolean {
  const lease = input.activeReadLease;
  return Boolean(
    !input.leaseClaimed &&
    input.toolName === "read_file" &&
    input.allowFileRead &&
    lease?.purpose === "patch_recovery" &&
    lease.state === "available" &&
    readEvidenceSatisfiesRecoveryLease({
      lease,
      target: input.target,
      requestedRange: input.requestedRange,
      observedVersion: input.observedVersion,
    })
  );
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
  contract?: RecoveryActionContract;
}): ExecuteRecoveryBatchDecision {
  const mode = normalizeExecuteRecoveryMode(input.mode);
  const contract = input.contract || resolveExecuteRecoveryActionContract(mode);
  const calls = Array.isArray(input.calls) ? input.calls : [];
  if (contract.phase === "normal") {
    return {
      active: false,
      phase: "normal",
      selectedCallId: null,
      selectedToolName: null,
      deferredCallIds: [],
    };
  }

  const phase = contract.nextRequiredCapability === "targeted_read" ||
    contract.nextRequiredCapability === "targeting"
    ? "need_context" as const
    : contract.nextRequiredCapability === "mutation" && mode !== "action_plus_targeting"
      ? "need_mutation" as const
      : (contract.phase === "validation" || contract.phase === "reconcile")
        ? "need_validation" as const
        : "legacy_action" as const;
  const eligible = calls.filter((call) => isExecuteRecoveryToolName(
    call.name,
    new Set(EXECUTE_RECOVERY_PATCH_READ_TOOLS),
    { mode, allowFileRead: contract.allowTargetedFileRead, contract },
  ));
  const transactionTarget = String(input.expectedTarget || "").trim() || (
    mode === "patch_recovery_read"
      ? resolveExecutePatchRecoveryTarget(input.recentActivity || [])
      : null
  );
  const isTargetScopedCall = (call: ExecuteRecoveryBatchCallLike): boolean =>
    call.name === "read_file" ||
    call.name === "code_ast_query" ||
    call.name === "get_file_outline" ||
    EXECUTE_RECOVERY_MUTATION_TOOLS.has(call.name);
  const scopedEligible = transactionTarget
    ? eligible.filter((call) =>
        !isTargetScopedCall(call) ||
        workspacePathsReferToSameFile(call.target || "", transactionTarget)
      )
    : eligible;
  // A malformed or partially streamed apply_patch may not expose a target yet.
  // If it is the only eligible mutation, let normal patch parsing and mutation
  // preflight return the precise error instead of silently deferring the call.
  const soleUnresolvedPatch =
    Boolean(transactionTarget) &&
    eligible.length === 1 &&
    eligible[0]?.name === "apply_patch" &&
    /^(?:workspace patch)?$/i.test(String(eligible[0]?.target || "").trim());
  const matchingMutation = scopedEligible.find((call) =>
    EXECUTE_RECOVERY_MUTATION_TOOLS.has(call.name)
  ) || (soleUnresolvedPatch ? eligible[0] : undefined);
  const matchingRead = scopedEligible.find((call) => call.name === "read_file");
  const matchingTargeting = scopedEligible.find((call) =>
    EXECUTE_RECOVERY_TARGETING_TOOLS.has(call.name)
  );
  const matchingJoin = scopedEligible.find((call) => call.name === "wait_subagents");
  const matchingValidation = mode === "finite_validation_only"
    ? scopedEligible.find((call) =>
          call.name === "run_command" &&
          shouldEnterFailedFiniteValidationRecovery(String(call.target || ""))
        ) || scopedEligible.find((call) => call.name === "run_command")
    : scopedEligible.find((call) => EXECUTE_RECOVERY_VALIDATION_TOOLS.has(call.name));
  const matchingNextCapability = contract.nextRequiredCapability === "observe_pty"
    ? scopedEligible.find((call) => EXECUTE_RECOVERY_PTY_OBSERVATION_CONTRACT_TOOLS.has(call.name))
    : contract.nextRequiredCapability === "browser_validation"
      ? scopedEligible.find((call) => EXECUTE_RECOVERY_BROWSER_VALIDATION_CONTRACT_TOOLS.has(call.name))
      : contract.nextRequiredCapability === "launch_long_process"
        ? scopedEligible.find((call) => EXECUTE_RECOVERY_LONG_PROCESS_LAUNCH_CONTRACT_TOOLS.has(call.name))
        : contract.nextRequiredCapability === "recover_process"
          ? scopedEligible.find((call) => EXECUTE_RECOVERY_PTY_DIAGNOSTIC_CONTRACT_TOOLS.has(call.name)) ||
            scopedEligible.find((call) => call.name === "read_file") ||
            scopedEligible.find((call) => EXECUTE_RECOVERY_MUTATION_TOOLS.has(call.name)) ||
            scopedEligible.find((call) => call.name === "run_command") ||
            scopedEligible.find((call) => call.name === "execute_command")
        : contract.nextRequiredCapability === "reconcile_server"
          ? scopedEligible.find((call) => EXECUTE_RECOVERY_SERVER_RECONCILE_CONTRACT_TOOLS.has(call.name))
      : undefined;
  const selected = matchingJoin || (contract.nextRequiredCapability === "targeted_read"
    ? matchingRead
    : contract.nextRequiredCapability === "targeting"
      ? matchingTargeting
    : contract.nextRequiredCapability === "mutation"
      ? matchingMutation
      : matchingNextCapability || matchingValidation || matchingRead);
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
  _readOnlyTools: Set<string>,
  options: {
    mode?: ExecuteRecoveryMode;
    allowFileRead?: boolean;
    contract?: RecoveryActionContract;
  } = {},
): boolean {
  const contract = options.contract || resolveExecuteRecoveryActionContract(
    normalizeExecuteRecoveryMode(options.mode),
  );
  if (contract.allowsAllTools) return true;
  // Recovery may narrow new work, but it must not strand already-running
  // children. Joining releases their scope lease and is not new exploration.
  if (name === "wait_subagents") return true;
  // allowFileRead is retained for call-site compatibility. The action contract
  // is authoritative: legal changed-version/missing-window reads first switch
  // into a lease-backed context phase, so mutation cannot silently expose it.
  return contract.allowedToolNames.has(name);
}

export function describeExecuteRecoveryToolSurface(
  mode: ExecuteRecoveryMode,
  _allowFileRead = false,
): string {
  return resolveExecuteRecoveryActionContract(mode).surfaceDescription;
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

/**
 * Failed shell diagnostics must stay on the normal execution surface. Only a
 * command that can actually satisfy finite Plan command evidence should enter
 * the run_command-only recovery transaction; otherwise probes such as `lsof`
 * or `curl` can hide the PTY/browser tools needed to finish the real check.
 */
export function shouldEnterFailedFiniteValidationRecovery(command: string): boolean {
  return isFinitePlanValidationCommand(command);
}

export function hasPendingPlanCommandEvidence(
  tasks: ReadonlyArray<{ evidence?: ReadonlyArray<{ kind?: string; value?: string }> }>,
): boolean {
  // Inferred validation tasks intentionally use the semantic placeholder
  // "focused validation command". The actual failed command is classified
  // separately, so this gate only asks whether command evidence remains.
  return tasks.some((task) =>
    (task.evidence || []).some((evidence) => evidence.kind === "cmd")
  );
}

export function failedFiniteValidationMatchesPendingPlanEvidence(input: {
  failedCommand: string;
  tasks: ReadonlyArray<{ evidence?: ReadonlyArray<{ kind?: string; value?: string }> }>;
}): boolean {
  return input.tasks.some((task) =>
    (task.evidence || []).some((evidence) =>
      evidence.kind === "cmd" && (
        isFlexiblePlanValidationCommandEvidence(String(evidence.value || "")) ||
        planCommandEvidenceMatchesExecution(
          String(evidence.value || ""),
          input.failedCommand,
        )
      )
    )
  );
}

export function resolveFailedFiniteValidationRecoveryPolicy(input: {
  failedCommand: string;
  tasks: ReadonlyArray<{ evidence?: ReadonlyArray<{ kind?: string; value?: string }> }>;
}): { allowAlternativeCommand: boolean; requiredCommand: string } {
  const pendingCommands = input.tasks.flatMap((task) =>
    (task.evidence || [])
      .filter((evidence) => evidence.kind === "cmd")
      .map((evidence) => String(evidence.value || "").trim())
      .filter(Boolean)
  );
  const matchingExplicitCommand = pendingCommands.find((command) =>
    !isFlexiblePlanValidationCommandEvidence(command) &&
    planCommandEvidenceMatchesExecution(command, input.failedCommand)
  );
  if (matchingExplicitCommand) {
    return {
      allowAlternativeCommand: false,
      requiredCommand: matchingExplicitCommand,
    };
  }

  // The semantic placeholder deliberately accepts any finite validation
  // command. It takes ownership of an otherwise-unmatched failed command;
  // explicit commands later in the task list retain their own exact boundary.
  if (pendingCommands.some(isFlexiblePlanValidationCommandEvidence)) {
    return { allowAlternativeCommand: true, requiredCommand: "" };
  }

  const firstExplicitCommand = pendingCommands.find((command) =>
    !isFlexiblePlanValidationCommandEvidence(command)
  );
  return firstExplicitCommand
    ? { allowAlternativeCommand: false, requiredCommand: firstExplicitCommand }
    : { allowAlternativeCommand: true, requiredCommand: "" };
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
    if (!isReadOnlyNoProgressDetail(activity.detail)) continue;
    counts.set(targetKey, (counts.get(targetKey) || 0) + 1);
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

  const visibleSuccessfulResults = input.results.filter(
    (result) => !result.internalFeedback && !result.isError,
  );
  const currentBatchHasFreshReadOnlyEvidence = visibleSuccessfulResults.some((result) =>
    !isReadOnlyNoProgressDetail(String(result.displayContent || result.content || ""))
  );
  if (currentBatchHasFreshReadOnlyEvidence) {
    // Raw call count and output size are context-management signals, not proof
    // of a loop. A distinct window/version is progress and must remain legal.
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

  const allSuccessfulReadsAreCached = visibleSuccessfulResults.length > 0 && visibleSuccessfulResults.every((result) =>
    isReadOnlyNoProgressDetail(String(result.displayContent || result.content || ""))
  );
  const currentBatchHasCachedReadOnly = visibleSuccessfulResults.some((result) =>
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
  contract: RecoveryActionContract;
  repeatedTargets?: string[];
  recentActivity?: ExecuteRecoveryActivityLike[];
}): string {
  const contract = input.contract;
  const surface = contract.surfaceDescription;
  const fileReadAvailable = contract.allowTargetedFileRead;
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
        : fileReadAvailable
        ? "A targeted `read_file` is available to repair exact-content or patch mismatch problems; after that, patch, run a finite command, use browser validation, or state the exact blocker."
        : "No `read_file` is available in this recovery step. Reuse cached context and take the next concrete action: `apply_patch`/`replace_in_file`/`write_file`, run a finite command, use browser validation, or state the exact blocker. If grep_search already returned a line containing the failing code, treat that line as enough context for a minimal exact replacement.",
      fileReadAvailable
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
      : fileReadAvailable
      ? "现在可使用定向 `read_file` 来修复精确内容或 patch mismatch；随后必须改为写入、运行有限命令、浏览器验证，或说明精确阻塞。"
      : "这个恢复步骤不再开放 `read_file`。请复用已缓存上下文，执行下一个具体动作：`apply_patch` / `replace_in_file` / `write_file`、运行有限命令、浏览器验证，或说明精确阻塞。如果 grep_search 已经返回包含失败代码的行，把该行视为最小精确替换的足够上下文。",
    fileReadAvailable
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
      "Do not edit files, reread source, or summarize completion until validation returns. If the runtime detects a changed target version or missing post-mutation window, it will first switch to a separate targeted-read lease; a read never satisfies validation. If automated validation is impossible, state the exact blocker without claiming completion.",
    ].filter(Boolean).join("\n");
  }

  return [
    "EXECUTE_RECOVERY: 已批准 Plan 连续修改同一目标，但期间没有新的验证证据。",
    `恢复原因：${input.reason}。`,
    `重复目标：${input.target || "未知目标"}（距上次验证后已修改 ${input.editCount} 次）。`,
    tools ? `本轮可用验证工具：${tools}。` : "",
    recent ? `最近工具活动：${recent}。` : "",
    "下一条回复必须只调用一个验证工具；有限的构建/测试/lint 优先用 `run_command`，页面 DOM/截图验证用 `browser_evaluate`。",
    "不要继续编辑文件，也不要在验证返回前总结完成。只有目标版本变化、源码窗口被淘汰或缺少修改后区间时，才允许一次定向 read_file；该读取不能替代验证。如果无法自动验证，请说明精确阻塞，不能声称任务完成。",
  ].filter(Boolean).join("\n");
}

export function buildFailedFiniteValidationRecoveryPrompt(input: {
  command: string;
  result: string;
  allowAlternativeCommand?: boolean;
  requiredCommand?: string;
}): string {
  const command = String(input.command || "").trim() || "the failed finite command";
  const requiredCommand = String(input.requiredCommand || "").trim();
  const allowAlternativeCommand = input.allowAlternativeCommand !== false || !requiredCommand;
  const result = String(input.result || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1_200);
  return [
    "FINITE_VALIDATION_RECOVERY: The last `run_command` failed and cannot satisfy the approved Plan's command evidence.",
    `Failed command: ${command}`,
    result ? `Observed result: ${result}` : "Observed result: no usable command output was returned.",
    allowAlternativeCommand
      ? "The pending Plan evidence is a generic finite-validation placeholder. `run_command` is the required next capability; call one different finite validation command that matches the actual project runtime and source format (for example an existing test, build, typecheck, lint, or compile command). Source reads are not part of this validation phase."
      : `The approved Plan requires this exact command evidence: ${requiredCommand}. \`run_command\` is the required next capability; retry that same command after correcting its prerequisites or invocation. Source reads are not part of this validation phase. Do not substitute a different build, test, lint, or typecheck command.`,
    "Do not switch this finite check to `execute_command` or PTY tools. Do not repeat an unchanged source window, and do not infer that a successful file edit was reverted merely because the validation command itself was invalid.",
    allowAlternativeCommand
      ? "Use stdout, stderr, and exitCode to distinguish a real source/test failure from a wrong command. If the diagnostic names a real source defect, repair it in a later normal execution transaction; otherwise choose a compatible finite command now. Do not repeat the failed command unchanged and do not claim completion before exitCode 0."
      : `Use stdout, stderr, and exitCode to diagnose and correct the failure, but keep \`${requiredCommand}\` as the acceptance boundary. Retry that exact command and do not claim completion until that command returns exitCode 0.`,
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
