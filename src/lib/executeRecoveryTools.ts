import { workspacePathsReferToSameFile } from "./workspacePaths";
import { isLocalDevServerHealthProbeCommand } from "./devServerRuntime";
import { WORKSPACE_MUTATION_TOOL_NAMES } from "./workspaceMutationTools";
import {
  migrateLegacyDirectEditTransaction,
  resolveDirectEditTransaction,
  type DirectEditTransaction,
} from "./directEditTransaction";
import {
  isFinitePlanValidationCommand,
  planCommandEvidenceMatchesExecution,
} from "./workflowModels";
export {
  classifyFailedFiniteValidationOutcome,
  compactStructuredCommandResult,
  summarizeSuccessfulValidationObservation,
  type FailedFiniteValidationOutcome,
} from "./commandValidationOutcome";

export type ExecuteRecoveryMode =
  | "normal"
  | "objective_audit"
  | "mutation_first"
  | "action_plus_targeting"
  | "patch_recovery_read"
  | "validation_only"
  | "finite_validation_only";

// Semantic fingerprints reject an identical validation-to-mutation retry.
// This higher independent-action ceiling is only a final safety fuse for
// objectives that legitimately require several distinct edits.
export const MAX_VALIDATION_MUTATION_REOPENS = 8;

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
  /**
   * Exact replacement and single-file update contracts may correct a weak
   * targeting guess. Full-file writes and explicit read leases stay bound.
   */
  canRebindTarget?: boolean;
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
  | "validation"
  | "reconcile";

export type ExecuteRecoveryNextCapability =
  | "any"
  | "targeting"
  | "targeted_read"
  | "mutation"
  | "validation"
  | "browser_diagnostic"
  | "desktop_validation"
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
  | "context_restore";

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
  /** Exact source windows that jointly satisfy a segmented read lease. */
  observationKeys?: string[];
  observedVersion?: string | null;
  /** Stable identity of the patch failure that granted this one-shot read. */
  mismatchFingerprint?: string | null;
  /**
   * available: granted; active: the exact read is in flight; consumed: the
   * one-shot lease is closed only by an exact source observation or source replay.
   * Only a new mismatch or source-version epoch may grant another lease.
   */
  state: "available" | "active" | "consumed";
}

export interface PatchRecoveryMismatchEvidence {
  mismatchFingerprint: string;
  target: string;
  requestedRange?: RecoveryReadLease["requestedRange"];
  observedVersion?: string | null;
}

export interface PendingFiniteValidationCheckpoint {
  command: string;
  cwd: string;
  timeoutMs?: number;
}

export interface ExecutionDecisionCheckpoint {
  expectedTarget: string | null;
  sourceObservationKey: string | null;
  nextRequiredCapability: ExecuteRecoveryNextCapability;
  evidenceVersion?: string | null;
  /** Approved Plan task that owns the current recovery transaction. */
  planTaskId?: string | null;
  /**
   * Provider-neutral no-progress strategies already attempted for this exact
   * unfinished objective. A terminal pause is only valid after the bounded
   * strategy set has been exhausted.
   */
  noProgressStrategyPivots?: ExecuteNoProgressStrategyPivot[];
  /** Stable requirement reference used for diagnostics and legacy task remapping. */
  requirementRef?: string | null;
  /** Exact finite validation that must succeed after the current repair. */
  pendingFiniteValidation?: PendingFiniteValidationCheckpoint | null;
  /**
   * Latest bounded stdout/stderr diagnostic for the still-pending finite
   * validation. It supersedes older repair prompts on every validation rerun.
   */
  finiteValidationFailureDetail?: string | null;
  /** Workspace owners named by the latest finite-validation diagnostic. */
  finiteValidationDiagnosticTargets?: string[];
  /**
   * Bounded validation-to-mutation transitions. Finite validation counts
   * consecutive retries of the same diagnostic; assistant-proposed edits are
   * additionally gated by their semantic fingerprints.
   */
  validationMutationReopenCount?: number;
  /** Semantic obligations already granted a validation -> mutation reopen. */
  validationMutationReopenFingerprints?: string[];
  /** Canonical parent-owned read -> edit -> validate -> audit transaction. */
  directEditTransaction?: DirectEditTransaction | null;
  /** Stable identity of a browser validation spec/runtime failure under diagnosis. */
  browserFailureFingerprint?: string | null;
  /** Exact cache-contract signature of a deterministic failed browser invocation. */
  browserFailureCallSignature?: string | null;
  /** Bounded structured diagnostic retained across Goal continuation slices. */
  browserFailureDetail?: string | null;
  /** Locator that failed in the attempted browser action, if one was explicit. */
  browserFailedLocator?: string | null;
  /** DOM-derived locator/text candidates returned by the validator. */
  browserLocatorCandidates?: string[];
  /** Exact browser target whose validation remains open. */
  browserRequestedUrl?: string | null;
}

export type ExecuteNoProgressStrategyPivot =
  | "current_task_action_lock"
  | "alternate_capability_reframe";

export const EXECUTE_NO_PROGRESS_STRATEGY_PIVOTS: readonly ExecuteNoProgressStrategyPivot[] = [
  "current_task_action_lock",
  "alternate_capability_reframe",
];

/**
 * Internal Execute boundaries that may yield to a fresh bounded Run without
 * user input. This list is deliberately model/provider/language neutral and
 * excludes permission, external-dependency, user-choice, and exhausted
 * validation-repair boundaries.
 */
const AUTO_RESUMABLE_EXECUTION_BOUNDARY_REASONS = new Set([
  "stream_no_visible_progress_timeout",
  "stream_max_elapsed_timeout",
  "execute_recovery_no_progress_limit",
  "execute_no_progress_batch_loop",
  "required_tool_call_protocol_violation",
  "required_tool_call_protocol_violation_after_change",
  "execute_no_action_after_change",
  "execute_xml_text_without_action",
  "execute_read_only_no_action_checkpoint",
  "execute_missing_tool_reprompt_limit",
  "execute_chat_repair_no_progress",
  "empty_model_response",
  "reasoning_dominated_no_action",
  "target_progress_loop",
  "repeated_failure_policy_no_progress",
  "approved_plan_repeated_browser_validation",
  "approved_plan_repeated_read_file",
  "strict_repeat_strategy_exhausted",
  "tool_protocol_doom_loop",
  "read_only_permission_no_action",
  "objective_closure_audit_evidence_missing",
  "approved_plan_completion_guard_incomplete_after_change",
  "approved_plan_completion_guard_no_evidence",
  "approved_plan_remaining_tasks_no_action",
  "execution_evidence_required",
]);

export function isAutoResumableExecutionBoundaryReason(
  value: string | null | undefined,
): boolean {
  const reason = String(value || "").trim();
  return AUTO_RESUMABLE_EXECUTION_BOUNDARY_REASONS.has(reason) ||
    reason.startsWith("execution_evidence_gap:");
}

export type ExecuteNoProgressStrategyDecision =
  | {
      action: "continue_with_pivot";
      strategy: ExecuteNoProgressStrategyPivot;
      attemptedStrategies: ExecuteNoProgressStrategyPivot[];
      prompt: string;
    }
  | {
      action: "pause";
      attemptedStrategies: ExecuteNoProgressStrategyPivot[];
    };

/**
 * Choose the next bounded recovery strategy without consulting model or
 * provider identity. The prompt carries only execution facts: the unfinished
 * task, its locked target, the available capability surface, and the call
 * pattern that must not be repeated.
 */
export function resolveExecuteNoProgressStrategyDecision(input: {
  attemptedStrategies?: readonly ExecuteNoProgressStrategyPivot[] | null;
  currentTaskId?: string | null;
  expectedTarget?: string | null;
  unfinishedObjective?: string | null;
  availableToolNames?: Iterable<string> | null;
  cause: string;
  language: "zh" | "en";
  /** False for read-only conversational work that must not inherit execution evidence requirements. */
  requireExecutionEvidence?: boolean;
}): ExecuteNoProgressStrategyDecision {
  const attemptedStrategies = EXECUTE_NO_PROGRESS_STRATEGY_PIVOTS.filter((strategy) =>
    input.attemptedStrategies?.includes(strategy)
  );
  const strategy = EXECUTE_NO_PROGRESS_STRATEGY_PIVOTS.find((candidate) =>
    !attemptedStrategies.includes(candidate)
  );
  if (!strategy) {
    return { action: "pause", attemptedStrategies };
  }

  const nextAttempted = [...attemptedStrategies, strategy];
  const task = input.currentTaskId?.trim() || "unidentified-current-task";
  const target = input.expectedTarget?.trim() || "current-task-target";
  const objective = input.unfinishedObjective?.trim() || "complete the current unfinished objective";
  const capabilities = [...new Set(
    [...(input.availableToolNames || [])]
      .map((name) => String(name || "").trim())
      .filter(Boolean),
  )].sort();
  const capabilityText = capabilities.join(", ") || "current recovery contract tools";
  const requireExecutionEvidence = input.requireExecutionEvidence !== false;
  const prompt = input.language === "zh"
    ? [
        "EXECUTE_NO_PROGRESS_STRATEGY_PIVOT:",
        `- strategy: ${strategy}`,
        `- cause: ${input.cause}`,
        `- currentTaskId: ${task}`,
        `- lockedTarget: ${target}`,
        `- unfinishedObjective: ${objective}`,
        `- availableCapabilities: ${capabilityText}`,
        "- constraint: 复用已有观察；关闭重复读取，不得原样重放相同工具、目标和参数。",
        strategy === "current_task_action_lock"
          ? requireExecutionEvidence
            ? "- nextAction: 聚焦当前任务，立即选择一个能产生写入或验证证据的动作。"
            : "- nextAction: 聚焦当前问题，复用已有观察直接形成答案；确有信息缺口时只做一个新的有界观察。"
          : requireExecutionEvidence
          ? "- nextAction: 改用尚未尝试的能力或实质不同的参数/目标继续；若存在真实权限、外部或安全阻塞，结构化说明该阻塞。"
          : "- nextAction: 改用尚未尝试的有界观察或实质不同的参数/目标，然后立即回答；若存在真实外部、权限或上下文阻塞，结构化说明该阻塞。",
      ].join("\n")
    : [
        "EXECUTE_NO_PROGRESS_STRATEGY_PIVOT:",
        `- strategy: ${strategy}`,
        `- cause: ${input.cause}`,
        `- currentTaskId: ${task}`,
        `- lockedTarget: ${target}`,
        `- unfinishedObjective: ${objective}`,
        `- availableCapabilities: ${capabilityText}`,
        "- constraint: Reuse retained observations; repeated reads are closed, and the same tool/target/arguments must not be replayed unchanged.",
        strategy === "current_task_action_lock"
          ? requireExecutionEvidence
            ? "- nextAction: Stay on the current task and take an action that produces mutation or validation evidence now."
            : "- nextAction: Stay on the current question and use retained observations to answer directly; make only one new bounded observation if information is genuinely missing."
          : requireExecutionEvidence
          ? "- nextAction: Continue with an untried capability or materially different arguments/target; if a real permission, external, or safety blocker exists, report it structurally."
          : "- nextAction: Use one untried bounded observation or materially different arguments/target, then answer immediately; if a real external, permission, or context blocker exists, report it structurally.",
      ].join("\n");
  return {
    action: "continue_with_pivot",
    strategy,
    attemptedStrategies: nextAttempted,
    prompt,
  };
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
 * The next capability owns the request's exact tool surface as well as its
 * evidence-accounting state. File version/range eligibility remains a later
 * decision for capabilities that legitimately expose read_file.
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
  toolCallRequirement: RecoveryToolCallRequirement;
}

export interface RuntimeOwnedRecoveryAction {
  toolName: "read_file" | "run_command";
  arguments: Record<string, string | number>;
  checkpointKind: "targeted_read" | "finite_validation";
}

/**
 * Skip a redundant model decision only when the recovery contract exposes one
 * named tool and already owns every required argument. Search, mutation,
 * browser, and process actions remain model-owned.
 */
export function resolveRuntimeOwnedRecoveryAction(input: {
  contract: RecoveryActionContract;
  activeToolNames: Iterable<string>;
}): RuntimeOwnedRecoveryAction | null {
  const activeToolNames = new Set(
    [...input.activeToolNames]
      .map((name) => String(name || "").trim())
      .filter(Boolean),
  );
  const requirement = input.contract.toolCallRequirement;
  if (
    requirement.kind !== "required_named" ||
    activeToolNames.size !== 1 ||
    !activeToolNames.has(requirement.toolName)
  ) {
    return null;
  }

  if (requirement.toolName === "run_command") {
    const checkpoint =
      input.contract.decisionCheckpoint?.pendingFiniteValidation;
    const command = String(checkpoint?.command || "").trim();
    const cwd = String(checkpoint?.cwd || ".").trim() || ".";
    if (
      input.contract.nextRequiredCapability !== "validation" ||
      !command ||
      !isFinitePlanValidationCommand(command)
    ) {
      return null;
    }
    const timeoutMs = Number(checkpoint?.timeoutMs);
    return {
      toolName: "run_command",
      checkpointKind: "finite_validation",
      arguments: {
        command,
        cwd,
        description:
          `Run the runtime-pinned finite validation: ${command}`.slice(0, 240),
        ...(Number.isFinite(timeoutMs) && timeoutMs > 0
          ? { timeout_ms: Math.floor(timeoutMs) }
          : {}),
      },
    };
  }

  if (requirement.toolName === "read_file") {
    const target = String(input.contract.expectedTarget || "").trim();
    const lease = input.contract.readLease;
    if (
      input.contract.nextRequiredCapability !== "targeted_read" ||
      !target ||
      !lease ||
      lease.state !== "available" ||
      !workspacePathsReferToSameFile(target, lease.target)
    ) {
      return null;
    }
    const range = lease.requestedRange;
    return {
      toolName: "read_file",
      checkpointKind: "targeted_read",
      arguments: {
        path: target,
        ...(range?.startLine ? { start_line: range.startLine } : {}),
        ...(range?.endLine ? { end_line: range.endLine } : {}),
        ...(range?.maxLines ? { max_lines: range.maxLines } : {}),
      },
    };
  }

  return null;
}

/**
 * Provider-neutral tool-call requirement for the current recovery phase.
 * Transport adapters may translate this into their native tool-choice shape,
 * but capability-to-tool-name selection belongs to the recovery contract.
 */
export type RecoveryToolCallRequirement =
  | { kind: "optional" }
  | { kind: "required_any" }
  | { kind: "required_named"; toolName: string };

export const EXECUTE_RECOVERY_PATCH_READ_TOOLS = new Set([
  "read_file",
]);

export const EXECUTE_RECOVERY_VALIDATION_TOOLS = new Set([
  "run_command",
  "execute_command",
  "browser_evaluate",
  "computer_use",
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

/**
 * A closed revision is audited without write or validation tools. Stopping
 * accepts the current mutation + validation receipts; reading a source file
 * explicitly reopens one bounded mutation transaction.
 */
export const EXECUTE_RECOVERY_OBJECTIVE_AUDIT_TOOLS = new Set([
  "glob_search",
  "grep_search",
  "code_ast_query",
  "find_symbol_references",
  "get_file_outline",
  "read_file",
  "git_status",
  "git_diff",
]);

const EXECUTE_RECOVERY_OBJECTIVE_AUDIT_CORRECTION_TOOLS = new Set([
  "replace_in_file",
]);

export const EXECUTE_RECOVERY_TARGETING_TOOLS = new Set([
  "glob_search",
  "grep_search",
  "code_ast_query",
  "find_symbol_references",
  "get_file_outline",
  "read_file",
]);

const EXECUTE_RECOVERY_TARGETED_READ_TOOLS = new Set([
  "read_file",
]);

const EXECUTE_RECOVERY_PTY_DIAGNOSTIC_CONTRACT_TOOLS = new Set([
  "read_pty_buffer",
  "read_pty_tail",
  "read_pty_since",
  "get_pty_status",
]);

const EXECUTE_RECOVERY_PTY_OBSERVATION_CONTRACT_TOOLS = new Set([
  ...EXECUTE_RECOVERY_PTY_DIAGNOSTIC_CONTRACT_TOOLS,
]);

const EXECUTE_RECOVERY_BROWSER_VALIDATION_CONTRACT_TOOLS = new Set([
  "browser_evaluate",
]);

const EXECUTE_RECOVERY_BROWSER_DIAGNOSTIC_CONTRACT_TOOLS = new Set([
  "browser_evaluate",
  "grep_search",
  "read_file",
]);

const EXECUTE_RECOVERY_DESKTOP_VALIDATION_CONTRACT_TOOLS = new Set([
  "computer_use",
]);

const EXECUTE_RECOVERY_LONG_PROCESS_LAUNCH_CONTRACT_TOOLS = new Set([
  "execute_command",
]);

const EXECUTE_RECOVERY_RECONCILE_SERVER_CONTRACT_TOOLS = new Set([
  ...EXECUTE_RECOVERY_PTY_DIAGNOSTIC_CONTRACT_TOOLS,
  ...EXECUTE_RECOVERY_FINITE_VALIDATION_TOOLS,
]);

/** A failed/stopped process may be inspected or relaunched, never source-edited. */
export const EXECUTE_RECOVERY_CORE_TOOLS = new Set([
  ...EXECUTE_RECOVERY_PTY_DIAGNOSTIC_CONTRACT_TOOLS,
  ...EXECUTE_RECOVERY_LONG_PROCESS_LAUNCH_CONTRACT_TOOLS,
]);

/**
 * Every recovery capability owns its executable surface. This turns the
 * runtime state machine into an actual control boundary instead of a prompt
 * preference: context may discover/read, mutation may write, and validation
 * may run a finite check. A fresh read is reopened only through an explicit
 * one-shot read lease.
 */
function resolveRecoveryAllowedToolNames(
  nextCapability: ExecuteRecoveryNextCapability,
): ReadonlySet<string> {
  switch (nextCapability) {
    case "targeted_read":
      return EXECUTE_RECOVERY_TARGETED_READ_TOOLS;
    case "targeting":
      return EXECUTE_RECOVERY_TARGETING_TOOLS;
    case "mutation":
      return EXECUTE_RECOVERY_MUTATION_TOOLS;
    case "validation":
      return EXECUTE_RECOVERY_FINITE_VALIDATION_TOOLS;
    case "browser_diagnostic":
      return EXECUTE_RECOVERY_BROWSER_DIAGNOSTIC_CONTRACT_TOOLS;
    case "desktop_validation":
      return EXECUTE_RECOVERY_DESKTOP_VALIDATION_CONTRACT_TOOLS;
    case "launch_long_process":
      return EXECUTE_RECOVERY_LONG_PROCESS_LAUNCH_CONTRACT_TOOLS;
    case "observe_pty":
      return EXECUTE_RECOVERY_PTY_OBSERVATION_CONTRACT_TOOLS;
    case "browser_validation":
      return EXECUTE_RECOVERY_BROWSER_VALIDATION_CONTRACT_TOOLS;
    case "reconcile_server":
      return EXECUTE_RECOVERY_RECONCILE_SERVER_CONTRACT_TOOLS;
    case "recover_process":
      return EXECUTE_RECOVERY_CORE_TOOLS;
    default:
      return new Set<string>();
  }
}

function resolveRecoveryToolCallRequirement(
  nextCapability: ExecuteRecoveryNextCapability,
): RecoveryToolCallRequirement {
  const toolName = nextCapability === "browser_validation"
    ? "browser_evaluate"
    : nextCapability === "desktop_validation"
    ? "computer_use"
    : nextCapability === "launch_long_process"
    ? "execute_command"
    : nextCapability === "targeted_read"
    ? "read_file"
    : nextCapability === "validation"
    ? "run_command"
    : null;
  return toolName
    ? { kind: "required_named", toolName }
    : { kind: nextCapability === "any" ? "optional" : "required_any" };
}

// Runtime-owned no-progress feedback always starts with a marker. Never scan
// the whole payload: freshly read source may legitimately contain these
// strings (MAIN's own cache implementation does).
const READ_ONLY_NO_PROGRESS_DETAIL_RE = /^\s*(?:FILE_UNCHANGED_STUB|CACHED_FILE_REPLAY|READ_FILE_WINDOW_NARROWED|Repeated read-only tool call skipped|READ_FILE_REPEAT_LIMIT|READ_ONLY_REPEAT_LIMIT)\b/i;

export function normalizeExecuteRecoveryMode(value: unknown): ExecuteRecoveryMode {
  // Compatibility for snapshots written before approved-Plan action recovery
  // was separated from the execute transaction.
  if (value === "action_only") return "mutation_first";
  return value === "mutation_first" ||
    value === "objective_audit" ||
    value === "action_plus_targeting" ||
    value === "patch_recovery_read" ||
    value === "validation_only" ||
    value === "finite_validation_only" ||
    value === "normal"
    ? value
    : "normal";
}

/** Drop the mandatory post-mutation reread lease used by older snapshots. */
export function isLegacyPostMutationReadLease(value: unknown): boolean {
  return Boolean(
    value &&
    typeof value === "object" &&
    (value as { purpose?: unknown }).purpose === "post_mutation_verify",
  );
}

export function migrateRecoveryReadLease(
  value: RecoveryReadLease | null | undefined,
): RecoveryReadLease | null {
  if (!value) return null;
  return isLegacyPostMutationReadLease(value)
    ? null
    : normalizeRecoveryReadLeaseSnapshot(value);
}

type DevServerLifecycleCapability =
  | "launch_long_process"
  | "recover_process"
  | "reconcile_server"
  | "observe_pty"
  | "browser_validation";

function isDevServerLifecycleCapability(
  value: ExecuteRecoveryNextCapability | undefined,
): value is DevServerLifecycleCapability {
  return value === "launch_long_process" ||
    value === "recover_process" ||
    value === "reconcile_server" ||
    value === "observe_pty" ||
    value === "browser_validation";
}

/**
 * A browser checkpoint is the final obligation, not permission to skip the
 * process lifecycle. Runtime evidence owns launch -> PTY observation ->
 * browser. An explicit finite-validation checkpoint stays independent from
 * any unrelated development server already recorded in the ledger.
 */
function resolveDevServerLifecycleStep(input: {
  mode: ExecuteRecoveryMode;
  checkpointCapability?: ExecuteRecoveryNextCapability;
  status: RecoveryActionContract["devServerStatus"];
  nextCapability?: "launch" | "observe_pty" | "browser" | "reconcile";
}): {
  phase: ExecuteRecoveryContractPhase;
  nextRequiredCapability: DevServerLifecycleCapability;
} | null {
  const explicitLifecycle = isDevServerLifecycleCapability(input.checkpointCapability);
  const legacyObservedLifecycle = !input.checkpointCapability &&
    (input.mode === "action_plus_targeting" || input.mode === "validation_only") &&
    input.status !== "none";
  if (!explicitLifecycle && !legacyObservedLifecycle) return null;

  if (
    input.checkpointCapability === "reconcile_server" ||
    input.nextCapability === "reconcile"
  ) {
    return { phase: "reconcile", nextRequiredCapability: "reconcile_server" };
  }
  if (
    input.status === "failed" ||
    input.status === "stopped"
  ) {
    return { phase: "reconcile", nextRequiredCapability: "recover_process" };
  }
  // The checkpoint is the durable process obligation. Runtime transitions do
  // not always carry the ledger's server status, so an explicit PTY gate must
  // remain observable instead of falling back to a second launch.
  if (input.checkpointCapability === "observe_pty") {
    return { phase: "validation", nextRequiredCapability: "observe_pty" };
  }
  if (input.checkpointCapability === "recover_process" && input.status === "none") {
    return { phase: "reconcile", nextRequiredCapability: "recover_process" };
  }
  if (input.status === "none") {
    return { phase: "validation", nextRequiredCapability: "launch_long_process" };
  }
  if (
    input.status === "pending" ||
    input.status === "running" ||
    input.status === "unknown" ||
    input.nextCapability === "observe_pty"
  ) {
    return { phase: "validation", nextRequiredCapability: "observe_pty" };
  }
  if (input.status === "ready" || input.nextCapability === "browser") {
    return { phase: "validation", nextRequiredCapability: "browser_validation" };
  }
  return null;
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
  // Old snapshots may contain the removed mandatory post-mutation read lease.
  // Treat it as already migrated to validation instead of reviving that phase.
  const normalizedReadLease = migrateRecoveryReadLease(context.readLease);
  const shared = {
    expectedTarget: context.expectedTarget?.trim() || null,
    readLease: normalizedReadLease,
    sourceObservationKey: context.sourceObservationKey?.trim() || (
      normalizedReadLease?.state === "consumed"
        ? normalizedReadLease.observationKey?.trim() || null
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
      toolCallRequirement: resolveRecoveryToolCallRequirement("any"),
    };
  }
  if (mode === "objective_audit") {
    const correctionWindowOpen =
      context.decisionCheckpoint?.nextRequiredCapability === "mutation";
    if (correctionWindowOpen) {
      return {
        ...shared,
        modeLabel: mode,
        phase: "mutation",
        nextRequiredCapability: "mutation",
        allowTargetedFileRead: false,
        // The audit already observed a fresh exact source window. The model may
        // either correct that window once or make no tool call to accept the
        // frozen mutation + validation receipts.
        allowsAllTools: false,
        allowedToolNames: EXECUTE_RECOVERY_OBJECTIVE_AUDIT_CORRECTION_TOOLS,
        surfaceDescription: "objective-audit:edit-or-close",
        toolCallRequirement: { kind: "optional" },
      };
    }
    return {
      ...shared,
      modeLabel: mode,
      phase: "normal",
      nextRequiredCapability: "any",
      allowTargetedFileRead: true,
      // A successful validation is immutable during the closure decision.
      // A fresh read is the single explicit transition that may reopen one
      // bounded mutation; stale writes and repeated validation cannot bypass
      // that boundary.
      allowsAllTools: false,
      allowedToolNames: EXECUTE_RECOVERY_OBJECTIVE_AUDIT_TOOLS,
      surfaceDescription: "objective-audit:read-or-close",
      toolCallRequirement: { kind: "optional" },
    };
  }
  let phase: ExecuteRecoveryContractPhase = "mutation";
  let nextRequiredCapability: ExecuteRecoveryNextCapability = "mutation";
  const checkpointCapability = context.decisionCheckpoint?.nextRequiredCapability;
  const activeReadLease = normalizedReadLease &&
    (normalizedReadLease.state === "available" || normalizedReadLease.state === "active")
      ? normalizedReadLease
      : null;
  const devServerLifecycleStep = resolveDevServerLifecycleStep({
    mode,
    checkpointCapability,
    status: shared.devServerStatus,
    nextCapability: context.devServerNextCapability,
  });

  if (activeReadLease) {
    phase = "context";
    nextRequiredCapability = "targeted_read";
  } else if (checkpointCapability === "targeting") {
    phase = "context";
    nextRequiredCapability = "targeting";
  } else if (checkpointCapability === "browser_diagnostic") {
    // A malformed locator/assertion is not evidence that application source is
    // broken. Keep a narrow inspection surface until DOM/search evidence
    // attributes a concrete source target or a corrected browser check passes.
    phase = "context";
    nextRequiredCapability = "browser_diagnostic";
  } else if (checkpointCapability === "desktop_validation") {
    phase = "validation";
    nextRequiredCapability = "desktop_validation";
  } else if (devServerLifecycleStep) {
    phase = devServerLifecycleStep.phase;
    nextRequiredCapability = devServerLifecycleStep.nextRequiredCapability;
  } else if (mode === "validation_only" || mode === "finite_validation_only") {
    phase = "validation";
    nextRequiredCapability = "validation";
  }

  const allowedToolNames =
    resolveRecoveryAllowedToolNames(nextRequiredCapability);
  return {
    ...shared,
    modeLabel: mode,
    phase,
    nextRequiredCapability,
    // Version/range/context eligibility decides whether a visible read_file
    // performs IPC, replays context, or returns a cache stub.
    allowTargetedFileRead: allowedToolNames.has("read_file"),
    allowsAllTools: false,
    allowedToolNames,
    surfaceDescription: `capability:${nextRequiredCapability}`,
    toolCallRequirement:
      resolveRecoveryToolCallRequirement(nextRequiredCapability),
  };
}

export function isExecutePatchMismatchRecoveryActivity(activity: ExecuteRecoveryActivityLike): boolean {
  if ((activity.name !== "replace_in_file" && activity.name !== "apply_patch") || activity.status !== "failed") return false;
  // Only stable internal reason codes participate in recovery. Localized
  // executor prose must not become a hidden state-machine input.
  return /\b(?:MUTATION_PREFLIGHT_BLOCKED|invalid_patch|search_text_mismatch)\b/i.test(activity.detail || "");
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

/** Canonical persisted/read-lease normalizer shared by live and Goal loops. */
export function normalizeRecoveryReadLeaseSnapshot(value: unknown): RecoveryReadLease | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (isLegacyPostMutationReadLease(value)) return null;
  const candidate = value as Partial<RecoveryReadLease>;
  const purposes = new Set<RecoveryReadLeasePurpose>([
    "initial_targeting",
    "plan_line_context",
    "patch_recovery",
    "missing_window",
    "context_restore",
  ]);
  const states = new Set<RecoveryReadLease["state"]>(["available", "active", "consumed"]);
  const purpose = candidate.purpose;
  const state = candidate.state;
  const target = String(candidate.target || "").trim();
  if (!target || !purpose || !purposes.has(purpose) || !state || !states.has(state)) return null;
  const requestedRange = normalizeRecoveryReadRange(candidate.requestedRange);
  const requiredRange = normalizeRecoveryReadRange(candidate.requiredRange);
  const coveredRanges = Array.isArray(candidate.coveredRanges)
    ? candidate.coveredRanges.flatMap((range) => {
        const normalized = normalizeRecoveryReadRange(range);
        const startLine = normalized?.startLine;
        const endLine = normalized?.endLine ?? (
          startLine && normalized?.maxLines
            ? startLine + normalized.maxLines - 1
            : undefined
        );
        return startLine && endLine && endLine >= startLine
          ? [{ startLine, endLine }]
          : [];
      })
    : [];
  const coverageMode = candidate.coverageMode === "exact" ||
    candidate.coverageMode === "bounded_prefix" ||
    candidate.coverageMode === "segmented_exact"
    ? candidate.coverageMode
    : undefined;
  return {
    purpose,
    target,
    ...(requestedRange ? { requestedRange } : {}),
    ...(requiredRange ? { requiredRange } : {}),
    ...(coveredRanges.length > 0 ? { coveredRanges } : {}),
    ...(coverageMode ? { coverageMode } : {}),
    observationKey: String(candidate.observationKey || "").trim() || null,
    ...(Array.isArray(candidate.observationKeys) && candidate.observationKeys.length > 0
      ? {
          observationKeys: Array.from(new Set(candidate.observationKeys
            .map((key) => String(key || "").trim())
            .filter(Boolean))),
        }
      : {}),
    observedVersion: String(candidate.observedVersion || "").trim() || null,
    mismatchFingerprint: String(candidate.mismatchFingerprint || "").trim() || null,
    state,
  };
}

/** Canonical persisted checkpoint normalizer shared by live and Goal loops. */
export function normalizeExecutionDecisionCheckpointSnapshot(
  value: unknown,
): ExecutionDecisionCheckpoint | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Partial<ExecutionDecisionCheckpoint>;
  const rawCandidate = value as Record<string, unknown>;
  const capabilities = new Set<ExecuteRecoveryNextCapability>([
    "any",
    "targeting",
    "targeted_read",
    "mutation",
    "validation",
    "browser_diagnostic",
    "desktop_validation",
    "launch_long_process",
    "recover_process",
    "reconcile_server",
    "observe_pty",
    "browser_validation",
  ]);
  const nextRequiredCapability = candidate.nextRequiredCapability;
  if (!nextRequiredCapability || !capabilities.has(nextRequiredCapability)) return null;
  const pendingFiniteValidationCandidate = candidate.pendingFiniteValidation;
  const pendingFiniteValidation = pendingFiniteValidationCandidate &&
    typeof pendingFiniteValidationCandidate === "object" &&
    !Array.isArray(pendingFiniteValidationCandidate)
    ? (() => {
        const command = String(pendingFiniteValidationCandidate.command || "").trim();
        if (!command) return null;
        const cwd = String(pendingFiniteValidationCandidate.cwd || ".")
          .replace(/\\/g, "/")
          .replace(/\/+$/, "")
          .trim() || ".";
        const timeoutMs = Number(pendingFiniteValidationCandidate.timeoutMs);
        return {
          command,
          cwd,
          ...(Number.isFinite(timeoutMs) && timeoutMs > 0
            ? { timeoutMs: Math.floor(timeoutMs) }
            : {}),
        };
      })()
    : null;
  const validationMutationReopenFingerprints = Array.isArray(
    candidate.validationMutationReopenFingerprints,
  )
    ? [...new Set(candidate.validationMutationReopenFingerprints
        .map((entry) => String(entry || "").trim().toLowerCase())
        .filter(Boolean))]
        .slice(-32)
    : [];
  const finiteValidationFailureDetail = String(
    candidate.finiteValidationFailureDetail || "",
  )
    .replace(/\u0000/g, "")
    .trim()
    .slice(0, 2_400) || null;
  const finiteValidationDiagnosticTargets = Array.isArray(
    candidate.finiteValidationDiagnosticTargets,
  )
    ? [...new Set(candidate.finiteValidationDiagnosticTargets
        .map((entry) => String(entry || "").replace(/\\/g, "/").trim())
        .filter(Boolean))]
        .slice(0, 12)
    : [];
  const directEditTransaction = migrateLegacyDirectEditTransaction(rawCandidate);
  const browserLocatorCandidates = Array.isArray(candidate.browserLocatorCandidates)
    ? [...new Set(candidate.browserLocatorCandidates
        .map((entry) => String(entry || "").replace(/\s+/g, " ").trim())
        .filter(Boolean))]
        .slice(0, 24)
    : [];
  return {
    expectedTarget: String(candidate.expectedTarget || "").trim() || null,
    sourceObservationKey: String(candidate.sourceObservationKey || "").trim() || null,
    nextRequiredCapability,
    ...(candidate.evidenceVersion === undefined
      ? {}
      : { evidenceVersion: String(candidate.evidenceVersion || "").trim() || null }),
    ...(candidate.planTaskId === undefined
      ? {}
      : { planTaskId: String(candidate.planTaskId || "").trim() || null }),
    ...(candidate.requirementRef === undefined
      ? {}
      : { requirementRef: String(candidate.requirementRef || "").trim() || null }),
    ...(candidate.pendingFiniteValidation === undefined
      ? {}
      : { pendingFiniteValidation }),
    ...(candidate.finiteValidationFailureDetail === undefined
      ? {}
      : { finiteValidationFailureDetail }),
    ...(candidate.finiteValidationDiagnosticTargets === undefined
      ? {}
      : { finiteValidationDiagnosticTargets }),
    ...(candidate.validationMutationReopenCount === undefined
      ? {}
      : {
          validationMutationReopenCount: Math.max(
            0,
            Math.floor(Number(candidate.validationMutationReopenCount) || 0),
          ),
        }),
    ...(candidate.validationMutationReopenFingerprints === undefined
      ? {}
      : { validationMutationReopenFingerprints }),
    ...(directEditTransaction ? { directEditTransaction } : {}),
    ...(candidate.browserFailureFingerprint === undefined
      ? {}
      : {
          browserFailureFingerprint:
            String(candidate.browserFailureFingerprint || "").trim() || null,
        }),
    ...(candidate.browserFailureCallSignature === undefined
      ? {}
      : {
          browserFailureCallSignature:
            String(candidate.browserFailureCallSignature || "").trim() || null,
        }),
    ...(candidate.browserFailureDetail === undefined
      ? {}
      : {
          browserFailureDetail:
            String(candidate.browserFailureDetail || "").replace(/\s+/g, " ").trim().slice(0, 1_200) || null,
        }),
    ...(candidate.browserFailedLocator === undefined
      ? {}
      : {
          browserFailedLocator:
            String(candidate.browserFailedLocator || "").replace(/\s+/g, " ").trim().slice(0, 240) || null,
        }),
    ...(candidate.browserLocatorCandidates === undefined
      ? {}
      : { browserLocatorCandidates }),
    ...(candidate.browserRequestedUrl === undefined
      ? {}
      : {
          browserRequestedUrl:
            String(candidate.browserRequestedUrl || "").trim().slice(0, 2_000) || null,
        }),
  };
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

function targetFromReadObservationSignature(
  requestSignature: string,
): string | null {
  const prefix = "read_file::";
  if (!requestSignature.startsWith(prefix)) return null;
  const argsSeparator = requestSignature.lastIndexOf("::");
  if (argsSeparator <= prefix.length) return null;
  return requestSignature.slice(prefix.length, argsSeparator).trim() || null;
}

/**
 * Resolve a compiler/bundler diagnostic such as `src/main.js (377:12)` or
 * `file: /workspace/src/main.js:377:12` to one bounded source window. Matching
 * starts from the runtime-attributed target, so an unrelated diagnostic cannot
 * silently transfer the repair lease to another file.
 */
export function resolveFailedValidationDiagnosticRange(input: {
  target: string;
  diagnosticText?: string | null;
  contextLines?: number;
}): RecoveryReadLease["requestedRange"] | null {
  const target = String(input.target || "").trim().replace(/\\/g, "/");
  const diagnosticText = String(input.diagnosticText || "").replace(/\\/g, "/");
  if (!target || !diagnosticText) return null;

  const basename = target.split("/").filter(Boolean).pop() || target;
  const needles = [...new Set([target, basename])]
    .filter(Boolean)
    .sort((left, right) => right.length - left.length);
  for (const line of diagnosticText.split(/\r?\n/)) {
    const normalizedLine = line.replace(/\\/g, "/");
    const lowerLine = normalizedLine.toLowerCase();
    for (const needle of needles) {
      const lowerNeedle = needle.toLowerCase();
      let searchFrom = 0;
      while (searchFrom < lowerLine.length) {
        const index = lowerLine.indexOf(lowerNeedle, searchFrom);
        if (index < 0) break;
        searchFrom = index + lowerNeedle.length;
        const before = index > 0 ? normalizedLine[index - 1] : "";
        if (before && !/[\s"'`(:/]/.test(before)) continue;
        const suffix = normalizedLine.slice(index + needle.length);
        const location = suffix.match(
          /^\s*(?:\((\d+)\s*[,:]\s*\d+\)|:(\d+):\d+)/,
        );
        const lineNumber = Number(location?.[1] || location?.[2]);
        if (!Number.isFinite(lineNumber) || lineNumber < 1) continue;
        const contextLines = Math.max(
          8,
          Math.min(120, Math.floor(Number(input.contextLines) || 48)),
        );
        const startLine = Math.max(1, lineNumber - contextLines);
        const endLine = lineNumber + contextLines;
        return {
          startLine,
          endLine,
          maxLines: endLine - startLine + 1,
        };
      }
    }
  }
  return null;
}

/**
 * A real validation failure occurs after the mutation epoch that invalidated
 * the source window used to author that mutation. Grant exactly one read of
 * the same target/range before asking for a repair, but do not bind the lease
 * to the stale pre-mutation version. A diagnostic can transfer ownership to a
 * different file; in that case the previous file's range is unrelated.
 */
export function buildFailedValidationRepairReadLease(input: {
  target: string;
  sourceObservationKey?: string | null;
  diagnosticText?: string | null;
  preferredRange?: RecoveryReadLease["requestedRange"] | null;
}): RecoveryReadLease {
  const target = String(input.target || "").trim();
  const sourceObservationKey = String(input.sourceObservationKey || "").trim();
  const versionMarker = sourceObservationKey.indexOf("::version=");
  const requestSignature = versionMarker > 0
    ? sourceObservationKey.slice(0, versionMarker)
    : sourceObservationKey;
  const observationTarget = targetFromReadObservationSignature(requestSignature);
  const requestedRange =
    resolveFailedValidationDiagnosticRange({
      target,
      diagnosticText: input.diagnosticText,
    }) ||
    normalizeRecoveryReadRange(input.preferredRange) ||
    (
      requestSignature &&
      observationTarget &&
      workspacePathsReferToSameFile(target, observationTarget)
        ? requestedRangeFromReadObservationSignature(requestSignature)
        : null
    );
  return {
    purpose: "context_restore",
    target,
    ...(requestedRange ? { requestedRange } : {}),
    state: "available",
  };
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
    : contract.nextRequiredCapability === "mutation"
      ? "need_mutation" as const
      : (contract.phase === "validation" || contract.phase === "reconcile")
        ? "need_validation" as const
        : "legacy_action" as const;
  const eligible = calls.filter((call) =>
    call.name === "wait_subagents" ||
    isExecuteRecoveryToolName(
      call.name,
      new Set(EXECUTE_RECOVERY_PATCH_READ_TOOLS),
      { mode, allowFileRead: contract.allowTargetedFileRead, contract },
    )
  );
  // The runtime checkpoint owns target identity. Inferring it again from
  // localized failure prose revived stale targets after unrelated tool calls.
  const transactionTarget = String(input.expectedTarget || "").trim() || null;
  const isTargetScopedCall = (call: ExecuteRecoveryBatchCallLike): boolean =>
    call.name === "read_file" ||
    call.name === "code_ast_query" ||
    call.name === "get_file_outline" ||
    EXECUTE_RECOVERY_MUTATION_TOOLS.has(call.name);
  const scopedCalls = transactionTarget
    ? calls.filter((call) =>
        !isTargetScopedCall(call) ||
        workspacePathsReferToSameFile(call.target || "", transactionTarget)
      )
    : calls;
  const scopedEligible = eligible.filter((call) => scopedCalls.includes(call));
  // A malformed or partially streamed apply_patch may not expose a target yet.
  // If it is the only eligible mutation, let normal patch parsing and mutation
  // preflight return the precise error instead of silently deferring the call.
  const soleUnresolvedPatch =
    Boolean(transactionTarget) &&
    calls.length === 1 &&
    calls[0]?.name === "apply_patch" &&
    /^(?:workspace patch)?$/i.test(String(calls[0]?.target || "").trim());
  // Select only the capability owned by the current runtime checkpoint.
  // Adjacent workspace operations are deliberately not a fallback here:
  // allowing an unleased read during mutation made the phase boundary
  // advisory and let repeated-read loops run past the recovery budget.
  const mutationMayPreempt = contract.nextRequiredCapability === "mutation";
  const correctiveMutations = !contract.readLease
    ? calls.filter((call) =>
        EXECUTE_RECOVERY_MUTATION_TOOLS.has(call.name) &&
        call.canRebindTarget === true
      )
    : [];
  const soleCorrectiveMutation =
    correctiveMutations.length === 1 ? correctiveMutations[0] : undefined;
  const matchingMutation = mutationMayPreempt
    ? scopedCalls.find((call) => EXECUTE_RECOVERY_MUTATION_TOOLS.has(call.name)) ||
      soleCorrectiveMutation ||
      (soleUnresolvedPatch ? calls[0] : undefined)
    : undefined;
  const matchingRead = scopedEligible.find((call) => call.name === "read_file");
  const matchingTargeting = scopedEligible.find((call) =>
    call.name !== "read_file" &&
    EXECUTE_RECOVERY_TARGETING_TOOLS.has(call.name)
  ) || matchingRead;
  const matchingJoin = scopedEligible.find((call) => call.name === "wait_subagents");
  const matchingValidation = scopedEligible.find((call) =>
    call.name === "run_command" &&
    shouldEnterFailedFiniteValidationRecovery(String(call.target || ""))
  ) || scopedEligible.find((call) => call.name === "run_command");
  const matchingNextCapability = (() => {
    switch (contract.nextRequiredCapability) {
      case "targeted_read":
        return matchingRead;
      case "targeting":
        return matchingTargeting;
      case "mutation":
        return matchingMutation;
      case "validation":
        return matchingValidation;
      case "launch_long_process":
        return scopedEligible.find((call) => EXECUTE_RECOVERY_LONG_PROCESS_LAUNCH_CONTRACT_TOOLS.has(call.name));
      case "observe_pty":
        return scopedEligible.find((call) => EXECUTE_RECOVERY_PTY_OBSERVATION_CONTRACT_TOOLS.has(call.name));
      case "browser_validation":
        return scopedEligible.find((call) => EXECUTE_RECOVERY_BROWSER_VALIDATION_CONTRACT_TOOLS.has(call.name));
      case "browser_diagnostic":
        return scopedEligible.find((call) => EXECUTE_RECOVERY_BROWSER_DIAGNOSTIC_CONTRACT_TOOLS.has(call.name));
      case "desktop_validation":
        return scopedEligible.find((call) => EXECUTE_RECOVERY_DESKTOP_VALIDATION_CONTRACT_TOOLS.has(call.name));
      case "recover_process":
        return scopedEligible.find((call) => EXECUTE_RECOVERY_PTY_DIAGNOSTIC_CONTRACT_TOOLS.has(call.name)) ||
          scopedEligible.find((call) => call.name === "execute_command");
      case "reconcile_server":
        return scopedEligible.find((call) =>
          EXECUTE_RECOVERY_PTY_DIAGNOSTIC_CONTRACT_TOOLS.has(call.name) ||
          (
            call.name === "run_command" &&
            isLocalDevServerHealthProbeCommand(String(call.target || ""))
          )
        );
      default:
        return undefined;
    }
  })();
  const selected =
    matchingNextCapability ||
    matchingJoin;
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
  // allowFileRead is retained for call-site compatibility. The capability
  // contract controls visibility; path/version/range eligibility is evaluated
  // later when concrete read arguments are available.
  return contract.allowedToolNames.has(name);
}

/**
 * Keep only complete diagnostic clauses that concern the active repair owner.
 * Multi-owner validation reruns can otherwise leave several stale, conflicting
 * repair prompts in a local model's context.
 */
export function scopeFiniteValidationDiagnosticToTarget(input: {
  diagnostic: string;
  target?: string | null;
  maxChars?: number;
}): string {
  const diagnostic = String(input.diagnostic || "").trim();
  if (!diagnostic) return "";
  const normalizedTarget = String(input.target || "")
    .replace(/\\/g, "/")
    .toLowerCase();
  const targetBasename = normalizedTarget.split("/").filter(Boolean).pop() || "";
  const fragments = diagnostic
    .split(/(?:\s*;\s*|\n+)/)
    .map((entry) => entry.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const clauses = fragments.reduce<string[]>((entries, fragment) => {
    const namesSourceOwner =
      /(?:^|[\s("'`])(?:\.{0,2}\/)?(?:[A-Za-z0-9_@+.-]+\/)+[A-Za-z0-9_@+.-]+\.[A-Za-z0-9]+(?=$|[\s:;,.)"'`])/.test(
        fragment,
      );
    if (!namesSourceOwner && entries.length > 0) {
      entries[entries.length - 1] = `${entries[entries.length - 1]}; ${fragment}`;
      return entries;
    }
    entries.push(fragment);
    return entries;
  }, []);
  const matching = normalizedTarget
    ? clauses.filter((entry) => {
        const normalized = entry.replace(/\\/g, "/").toLowerCase();
        return normalized.includes(normalizedTarget) ||
          (!!targetBasename && normalized.includes(targetBasename));
      })
    : [];
  // One validation-to-mutation transaction repairs one complete diagnostic
  // clause. A fresh validation then removes that clause or returns it again.
  // Feeding every same-file failure at once encouraged local models to make a
  // nearby cosmetic edit or oscillate between several loci in a large file.
  const selected = matching.length > 0 ? matching.slice(0, 1) : clauses.slice(-1);
  const limit = Math.max(240, Math.floor(Number(input.maxChars) || 1_800));
  const complete: string[] = [];
  let usedChars = 0;
  for (const clause of selected) {
    if (usedChars + clause.length + 2 > limit) continue;
    complete.push(clause);
    usedChars += clause.length + 2;
  }
  return complete.join("; ");
}

/**
 * Ephemeral per-request contract card. It is appended after historical
 * recovery prompts, so a phase transition atomically replaces stale advice
 * without adding another durable transcript message.
 */
export function buildExecutionActionContractCard(input: {
  contract: RecoveryActionContract;
  language: "zh" | "en";
  /** Final request surface after Plan, provider-capability, and policy filtering. */
  availableToolNames?: Iterable<string>;
  /** Canonical user objective retained across recovery phase changes. */
  turnObjective?: string;
}): string {
  const { contract } = input;
  const target = contract.expectedTarget || "(current task target)";
  const observation = contract.sourceObservationKey ||
    contract.readLease?.observationKey ||
    "(none)";
  const readRange = contract.readLease?.requestedRange;
  const range = readRange
    ? `${readRange.startLine || 1}-${readRange.endLine || "?"}`
    : "(none)";
  const availableToolNames = new Set(
    input.availableToolNames || contract.allowedToolNames,
  );
  const tools = [...availableToolNames].sort().join(", ");
  const readFileVisible = availableToolNames.has("read_file");
  const hasSourceObservation = observation !== "(none)";
  const planTaskId = contract.decisionCheckpoint?.planTaskId || "(none)";
  const requirementRef = contract.decisionCheckpoint?.requirementRef || "(none)";
  const turnObjective = String(input.turnObjective || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 900);
  const pendingFiniteValidation = contract.decisionCheckpoint?.pendingFiniteValidation || null;
  const finiteValidationFailureDetail = String(
    contract.decisionCheckpoint?.finiteValidationFailureDetail || "",
  ).trim();
  const finiteValidationDiagnosticTargets = (
    contract.decisionCheckpoint?.finiteValidationDiagnosticTargets || []
  )
    .map((entry) => String(entry || "").trim())
    .filter(Boolean)
    .slice(0, 12);
  const validationRepairAttempt = Math.max(
    0,
    Math.floor(
      Number(contract.decisionCheckpoint?.validationMutationReopenCount) || 0,
    ),
  );
  const scopedFiniteValidationFailure = scopeFiniteValidationDiagnosticToTarget({
    diagnostic: finiteValidationFailureDetail,
    target: contract.expectedTarget,
  });
  const directEditTransaction =
    resolveDirectEditTransaction(contract.decisionCheckpoint);
  const objectiveClosure = directEditTransaction
    ? directEditTransaction.phase
    : "not-tracked";
  const mutationEvidence = (directEditTransaction?.mutations || [])
    .slice(-8)
    .map((entry) => `${entry.target}${entry.requirementRef ? `@${entry.requirementRef}` : ""}`)
    .join(", ") || "(none)";
  if (contract.modeLabel === "objective_audit") {
    const revision = directEditTransaction?.revision || 1;
    const validationEvidence = directEditTransaction?.validation;
    const evidenceLine = validationEvidence
      ? `${validationEvidence.tool}:${validationEvidence.target}@revision-${validationEvidence.revision}`
      : "(none)";
    const validationObservation = String(validationEvidence?.summary || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 1_200);
    const correctionWindowOpen =
      contract.nextRequiredCapability === "mutation";
    return input.language === "zh"
      ? [
          "[EXECUTION_ACTION_CONTRACT]",
          `phase=objective_audit; next=${correctionWindowOpen ? "correct_or_close" : "inspect_or_close"}; target=${target}`,
          `objectiveRevision=${revision}; mutationEvidence=${mutationEvidence}`,
          `validationEvidence=${evidenceLine}`,
          ...(validationObservation
            ? [`validationObservation=${validationObservation}`]
            : []),
          ...(turnObjective ? [`turnObjective=${turnObjective}`] : []),
          `availableTools=${tools}`,
          correctionWindowOpen
            ? "这是 objective closure audit 的源码复核步骤。你刚读取了新的精确源码窗口；若它暴露出仍未覆盖的 outcome，可调用一次 replace_in_file 修正该窗口，否则不要调用工具并接受当前 revision。"
            : "这是 objective closure audit。当前 revision 的修改和验证证据已冻结；本步骤只能检查源码或直接结束，不能重复验证。",
          correctionWindowOpen
            ? "不要为了结束审查而进行无意义改动；只有刚才的源码证据明确要求修正时才写入。"
            : "若有一个具体 outcome 尚未覆盖，只调用 read_file 读取其精确源码目标；读取后运行时会开放一次“修正或结束”的有界步骤。否则不要调用工具，直接总结。",
          validationObservation
            ? "最终总结必须忠实复述 validationObservation 已验证的 outcome，并把推断与事实区分开；不要用新的、未经验证的根因解释替换它。"
            : "",
          "只有全部 objective outcome 均已覆盖时才不调用工具，并直接输出面向用户的最终结论总结。不要为了结束审查而虚构工具调用。",
        ].join("\n")
      : [
          "[EXECUTION_ACTION_CONTRACT]",
          `phase=objective_audit; next=${correctionWindowOpen ? "correct_or_close" : "inspect_or_close"}; target=${target}`,
          `objectiveRevision=${revision}; mutationEvidence=${mutationEvidence}`,
          `validationEvidence=${evidenceLine}`,
          ...(validationObservation
            ? [`validationObservation=${validationObservation}`]
            : []),
          ...(turnObjective ? [`turnObjective=${turnObjective}`] : []),
          `availableTools=${tools}`,
          correctionWindowOpen
            ? "This is the source-review step of the objective-closure audit. You just read a fresh exact source window; if it exposes an uncovered outcome, call replace_in_file once to correct that window. Otherwise make no tool call and accept the current revision."
            : "This is the objective-closure audit. Mutation and validation evidence for the current revision is frozen; this step may inspect source or close, but it cannot repeat validation.",
          correctionWindowOpen
            ? "Do not manufacture a no-op edit to end the audit; write only when the source evidence you just read requires a correction."
            : "If one concrete outcome is still uncovered, call only read_file for its exact source target; the runtime will then open one bounded correct-or-close step. Otherwise make no tool call and summarize.",
          validationObservation
            ? "The final summary must faithfully report the outcomes verified by validationObservation and distinguish inference from fact; do not replace them with a new unverified root-cause story."
            : "",
          "Only when every objective outcome is covered, make no tool call and output the final user-facing conclusion summary. Do not invent a tool call merely to end the audit.",
        ].join("\n");
  }
  const sourcePhase = contract.phase === "context" || contract.phase === "mutation";
  const browserDiagnostic = contract.nextRequiredCapability === "browser_diagnostic";
  if (input.language === "zh") {
    return [
      "[EXECUTION_ACTION_CONTRACT]",
      `phase=${contract.phase}; next=${contract.nextRequiredCapability}; target=${target}`,
      `planTask=${planTaskId}; requirement=${requirementRef}`,
      `objectiveClosure=${objectiveClosure}; mutationEvidence=${mutationEvidence}`,
      ...(turnObjective ? [`turnObjective=${turnObjective}`] : []),
      ...(pendingFiniteValidation
        ? [
            `validationCommand=${pendingFiniteValidation.command}`,
            `validationCwd=${pendingFiniteValidation.cwd}`,
          ]
        : []),
      ...(scopedFiniteValidationFailure
        ? [
            `activeValidationDiagnostic=${scopedFiniteValidationFailure}`,
            `diagnosticOwners=${finiteValidationDiagnosticTargets.join(", ") || target}`,
            ...(validationRepairAttempt > 1
              ? [`validationRepairAttempt=${validationRepairAttempt}`]
              : []),
          ]
        : []),
      `availableTools=${tools}`,
      ...(sourcePhase
        ? browserDiagnostic
          ? [
              `browserFailure=${contract.decisionCheckpoint?.browserFailureDetail || "browser validation failed without a source stack"}`,
              `failedLocator=${contract.decisionCheckpoint?.browserFailedLocator || "(none)"}`,
              `locatorCandidates=${(contract.decisionCheckpoint?.browserLocatorCandidates || []).join(", ") || "(none)"}`,
              "先利用浏览器返回的 DOM/交互元素清单修正 locator 或因果断言；需要源码定位时，只搜索失败 locator、候选 locator 或可见标签，并且只读取搜索结果明确指向的文件。",
              "这个阶段不授权源码修改，也不能把最后读取的任意文件当作故障源。不要在参数和页面状态未变化时重复同一个失败验证。",
            ]
          : [
            `sourceObservation=${observation}; readLeaseRange=${range}`,
            hasSourceObservation
              ? "复用已绑定的源码 observation；不要为满足规则而复读未变化的相同窗口。"
              : "仅在缺少修改所需精确文本时定向读取。",
            readFileVisible
              ? "相同文件版本和已覆盖窗口只返回缓存 stub；版本、范围或上下文变化后可重新读取。"
              : "read_file 当前不可用；从 availableTools 选择 next 能力。",
          ]
        : []),
      pendingFiniteValidation && contract.nextRequiredCapability === "validation"
        ? "用 run_command 在 validationCwd 重新运行 validationCommand；该命令是当前唯一验收边界。若失败，运行时会依据结构化失败结果另行开启修复阶段。"
        : contract.nextRequiredCapability === "validation"
        ? "从已保留的清单与任务上下文选择一条真实、有限的 run_command。当前阶段不开放读取或修改；失败后由运行时结构化切回修复。"
        : contract.nextRequiredCapability === "mutation" && scopedFiniteValidationFailure
        ? `${validationRepairAttempt > 1 ? "同一诊断在上一次修改后仍然存在；不要继续重构函数，逐项对照诊断并只修改承载这些条件的现有表达式或分支。" : ""}本次修改必须直接消除 activeValidationDiagnostic 在当前 target 中指出的既有因果条件。replace_text 只覆盖 search_text 的精确范围，不要把相邻源码重复复制进去。优先删除或修正被点名的现有路径；不要新增与诊断无关的 helper、事件、API、自动保存或回退分支，也不要为了满足工具要求制造无意义改动。`
        : "只选择 availableTools 中能完成 next 的工具；相邻能力不会在当前阶段隐式开放。不要重启宽泛诊断。",
    ].join("\n");
  }
  return [
    "[EXECUTION_ACTION_CONTRACT]",
    `phase=${contract.phase}; next=${contract.nextRequiredCapability}; target=${target}`,
    `planTask=${planTaskId}; requirement=${requirementRef}`,
    `objectiveClosure=${objectiveClosure}; mutationEvidence=${mutationEvidence}`,
    ...(turnObjective ? [`turnObjective=${turnObjective}`] : []),
    ...(pendingFiniteValidation
      ? [
          `validationCommand=${pendingFiniteValidation.command}`,
          `validationCwd=${pendingFiniteValidation.cwd}`,
        ]
      : []),
    ...(scopedFiniteValidationFailure
      ? [
          `activeValidationDiagnostic=${scopedFiniteValidationFailure}`,
          `diagnosticOwners=${finiteValidationDiagnosticTargets.join(", ") || target}`,
          ...(validationRepairAttempt > 1
            ? [`validationRepairAttempt=${validationRepairAttempt}`]
            : []),
        ]
      : []),
    `availableTools=${tools}`,
      ...(sourcePhase
      ? browserDiagnostic
        ? [
            `browserFailure=${contract.decisionCheckpoint?.browserFailureDetail || "browser validation failed without a source stack"}`,
            `failedLocator=${contract.decisionCheckpoint?.browserFailedLocator || "(none)"}`,
            `locatorCandidates=${(contract.decisionCheckpoint?.browserLocatorCandidates || []).join(", ") || "(none)"}`,
            "First correct the locator or causal assertion from the returned DOM/interactive-element inventory. If source lookup is needed, search only the failed locator, a returned locator candidate, or its visible label, and read only a file named by that search.",
            "This phase does not authorize source mutation and must not promote an arbitrary last-read file into a failure target. Do not repeat an identical failed validation while its arguments and page state are unchanged.",
          ]
        : [
          `sourceObservation=${observation}; readLeaseRange=${range}`,
          hasSourceObservation
            ? "Reuse the bound source observation; do not reread an unchanged covered window merely to satisfy a rule."
            : "Request a targeted read only when exact mutation text is missing.",
          readFileVisible
            ? "The same file version and covered window returns a cache stub; a version, range, or context change permits a fresh read."
            : "read_file is unavailable now; choose the next capability from availableTools.",
        ]
      : []),
    pendingFiniteValidation && contract.nextRequiredCapability === "validation"
      ? "Use run_command in validationCwd to rerun validationCommand; it is the only acceptance boundary for this phase. A structured failure lets runtime reopen repair separately."
      : contract.nextRequiredCapability === "validation"
      ? "Choose one real finite run_command from the retained manifest and task context. Reads and edits are closed in this phase; a structured failure lets runtime reopen repair."
      : contract.nextRequiredCapability === "mutation" && scopedFiniteValidationFailure
      ? `${validationRepairAttempt > 1 ? "The same diagnostic survived the previous mutation; do not keep restructuring the function. Compare every stated condition and change only the existing expression or branch that owns them. " : ""}This mutation must directly eliminate the existing causal condition named by activeValidationDiagnostic in the current target. Keep replacement text bounded to the exact searched region; do not copy adjacent source into it. Prefer removing or correcting the cited path; do not add unrelated helpers, events, APIs, autosave behavior, or fallback branches, and do not manufacture a no-op edit merely to satisfy the tool requirement.`
      : "Choose only an availableTools action that satisfies next. Adjacent capabilities are not implicitly open in this phase. Do not restart broad diagnosis.",
  ].join("\n");
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
      evidence.kind === "cmd" && planCommandEvidenceMatchesExecution(
        String(evidence.value || ""),
        input.failedCommand,
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
    planCommandEvidenceMatchesExecution(command, input.failedCommand)
  );
  if (matchingExplicitCommand) {
    return {
      allowAlternativeCommand: false,
      requiredCommand: matchingExplicitCommand,
    };
  }

  const firstExplicitCommand = pendingCommands[0];
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
    const detail = String(activity.detail || "").trim();
    if (detail && !isReadOnlyNoProgressDetail(detail)) continue;
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
  const currentBatchHasFreshReadOnlyEvidence = visibleSuccessfulResults.some((result) => {
    const detail = String(result.displayContent || result.content || "").trim();
    return Boolean(detail) && !isReadOnlyNoProgressDetail(detail);
  });
  const readOnlyActivityLimit = input.minReadOnlyActivities ?? Infinity;
  if (readOnlyActivityCount >= readOnlyActivityLimit) {
    return { shouldRecover: true, reason: "read_only_evidence_budget", readOnlyActivityCount, batchToolChars, cachedReadOnlyActivityCount, repeatedReadOnlyTargetScore };
  }
  const readOnlyCharLimit = input.maxReadOnlyToolChars ?? Infinity;
  if (batchToolChars >= readOnlyCharLimit) {
    return { shouldRecover: true, reason: "read_only_context_budget", readOnlyActivityCount, batchToolChars, cachedReadOnlyActivityCount, repeatedReadOnlyTargetScore };
  }
  if (currentBatchHasFreshReadOnlyEvidence) {
    // A distinct window/version is useful source evidence, but it is not an
    // unlimited phase reset. The bounded budgets above force an execution
    // checkpoint after enough context has been collected.
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
  const partialMutationRequiresReread =
    input.reason === "mutation_partial_effect_requires_reread";
  const mutationProducedNoEffect =
    input.reason === "mutation_preflight_no_effect";
  const noEffectRetainsValidationOwner = Boolean(
    mutationProducedNoEffect && contract.expectedTarget,
  );
  const repeatedTargets = input.repeatedTargets?.length
    ? input.repeatedTargets.join(input.language === "zh" ? "、" : ", ")
    : input.language === "zh" ? "最近已读目标" : "recently read targets";
  const recent = (input.recentActivity || [])
    .slice(-5)
    .map((activity) => [activity.status, activity.name, activity.target, activity.detail].filter(Boolean).join(" "))
    .join(input.language === "zh" ? "；" : "; ");
  const needsSourceTargeting =
    contract.nextRequiredCapability === "targeting" &&
    !contract.sourceObservationKey;

  if (input.language === "en") {
    return [
      "EXECUTE_RECOVERY: the current transaction still lacks required execution evidence.",
      `Recovery reason: ${input.reason || "read_only_no_action"}.`,
      `Checkpoint: phase=${contract.phase}; next=${contract.nextRequiredCapability}; target=${contract.expectedTarget || repeatedTargets}.`,
      recent ? `Recent tool activity: ${recent}.` : "",
      needsSourceTargeting
        ? "No versioned source observation is bound yet. Do not mutate or repeat the same zero-result query; use one exposed targeting capability to identify a concrete source file and read its relevant window."
        : "Reuse the retained versioned observation. If exact source is genuinely missing and read_file is actually available, request one targeted window; otherwise perform the checkpoint's next capability.",
      partialMutationRequiresReread
        ? "The runtime observed that the failed tool already changed this workspace path. The pre-call source is stale: reread the current target now, and do not retry the same mutation or arguments until that fresh read returns."
        : noEffectRetainsValidationOwner
        ? "The attempted mutation produced no state delta, but the pending finite validation still attributes its concrete gap to this source owner. Keep this target and make one differentiated mutation from the retained current source; do not replay identical arguments."
        : mutationProducedNoEffect
        ? "The attempted mutation produced no state delta, so its unconfirmed target binding was released. Do not replay identical arguments; use one bounded targeting action to identify the actual mutation owner."
        : "A failed patch may be malformed, a no-op, or a context mismatch. Follow the structured tool error instead of assuming that another read is required.",
      "Call one useful tool for this checkpoint. Do not start another broad scan, repeat an unchanged window, bypass file reads through shell commands, or claim completion without validation evidence.",
    ].filter(Boolean).join("\n");
  }

  return [
    "EXECUTE_RECOVERY：当前事务仍缺少所需执行证据。",
    `恢复原因：${input.reason || "read_only_no_action"}。`,
    `检查点：phase=${contract.phase}；next=${contract.nextRequiredCapability}；target=${contract.expectedTarget || repeatedTargets}。`,
    recent ? `最近工具活动：${recent}。` : "",
    needsSourceTargeting
      ? "当前尚未绑定版本化源码观察。不要修改，也不要重复同一个零结果查询；请从已开放的定位能力中选择一个，确定具体源码文件并读取相关窗口。"
      : "复用已保留的版本化源码观察。只有确实缺少精确源码且本轮实际提供 read_file 时，才定向补读一个窗口；否则执行检查点指定的 next 能力。",
    partialMutationRequiresReread
      ? "运行时已观察到失败工具实际改变了该工作区路径。调用前的源码上下文已经过期：现在必须重读当前目标；在新读取返回前，不得用相同修改或参数重试。"
      : noEffectRetainsValidationOwner
      ? "本次修改没有产生任何状态变化，但待完成的有限验证仍把具体缺口归因到这个源码所有者。保留当前目标和当前源码观察，执行一次不同的精确修改；不要重复相同参数。"
      : mutationProducedNoEffect
      ? "本次修改没有产生任何状态变化，因此未经确认的目标绑定已解除。不要原样重放相同参数；请用一次有限定位动作确定真实修改所有者。"
      : "补丁失败可能是格式错误、无变化或上下文不匹配；应依据结构化工具错误处理，不能默认再读一次文件。",
    "本检查点只调用一个有用工具。不要重新泛读、重复未变化窗口、用 shell 绕过文件读取，也不要在缺少验证证据时声称完成。",
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
      "The next evidence priority is one successful validation result: use a finite command for build/test/lint evidence or browser validation for DOM/screenshot evidence.",
      "Validation is the only open capability in this phase. Reads and edits reopen only through a structured validation failure or a distinct runtime-owned objective transition. If automated validation is impossible, state the exact blocker without claiming completion.",
    ].filter(Boolean).join("\n");
  }

  return [
    "EXECUTE_RECOVERY: 已批准 Plan 连续修改同一目标，但期间没有新的验证证据。",
    `恢复原因：${input.reason}。`,
    `重复目标：${input.target || "未知目标"}（距上次验证后已修改 ${input.editCount} 次）。`,
    tools ? `本轮可用验证工具：${tools}。` : "",
    recent ? `最近工具活动：${recent}。` : "",
    "下一证据优先级是一条成功验证结果：构建/测试/lint 使用有限命令，页面 DOM/截图使用浏览器验证。",
    "验证是当前阶段唯一开放能力。读取和修改只能由结构化验证失败或新的运行时 objective 转换重新开启。如果无法自动验证，请说明精确阻塞，不能声称任务完成。",
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
    "FINITE_VALIDATION_RECOVERY: The last `run_command` failed and cannot satisfy the current turn's command evidence.",
    `Failed command: ${command}`,
    result ? `Observed result: ${result}` : "Observed result: no usable command output was returned.",
    allowAlternativeCommand
      ? "No exact command was reviewed for this runtime-owned post-mutation check. The next required evidence is one compatible finite command for the actual project runtime and source format."
      : `The approved Plan requires this exact command evidence: ${requiredCommand}. Correct its prerequisites or invocation, then retry that command; a different command cannot replace the reviewed acceptance boundary.`,
    "This phase exposes only the finite command boundary. A structured source/test failure reopens a separate targeting or repair transaction; reads and edits are not adjacent validation actions. Long-running commands and PTY observations remain outside this boundary. Do not infer that a successful edit was reverted merely because the command invocation was invalid.",
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
