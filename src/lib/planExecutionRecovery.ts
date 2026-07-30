import {
  buildPlanTaskEvidenceAudit,
  findUnsatisfiedPlanTaskEvidence,
  inferPlanTaskEvidence,
  isPlanTaskAwaitingBrowserValidation,
  isPlanTaskAwaitingExternalValidation,
  planTaskHasUnsatisfiedSourceMutationEvidence,
  requiresPtyObservationForPlanCommand,
  type PlanExecutionEvidenceEntry,
  type PlanExecutionProgressPhase,
  type PlanExecutionProgressSnapshot,
  type PlanExecutionProgressUpdate,
  type PlanTask,
} from "./workflowModels";
import type {
  FileReadObservationIdentity,
  FileReadWindowIdentity,
} from "./fileReadObservation";
import type { MainThreadProgressUpdate } from "./turnEvents";
import {
  type ExecuteRecoveryMode,
  type ForcedExecuteRecoveryRuntimeState,
} from "./executeRecoveryTools";
import { workspacePathsReferToSameFile } from "./workspacePaths";
import type { PlanStructuredEvidenceFact } from "./planStructuredEvidence";
import type { PlanSourceObservation } from "./planSourceObservation";
import type {
  PlanEvidenceDiscoveryObservation,
  PlanEvidenceObligation,
} from "./planEvidenceObligations";

export interface ApprovedPlanRecoveryResolutionOptions {
  /** Runtime tools actually available for this iteration, before recovery filtering. */
  availableToolNames?: Iterable<string>;
}

export function hasPendingApprovedPlanSourceMutation(
  tasks: PlanTask[],
  evidenceLedger: PlanExecutionEvidenceEntry[] = [],
): boolean {
  const audit = buildPlanTaskEvidenceAudit({
    tasks: Array.isArray(tasks) ? tasks : [],
    evidenceLedger,
    preserveMissing: true,
    highlightNext: true,
  });
  return audit.remainingTasks.some((task) =>
    planTaskHasUnsatisfiedSourceMutationEvidence(task, evidenceLedger)
  );
}

/**
 * Start approved execution from the first reviewed obligation instead of
 * reopening an unconstrained diagnostic turn. A source mutation begins with
 * one target-scoped read lease; the first fresh observation or unchanged
 * cache stub consumes it and switches the transaction to mutation-only.
 */
export function resolveApprovedPlanInitialExecutionRecovery(
  tasks: PlanTask[],
  evidenceLedger: PlanExecutionEvidenceEntry[] = [],
  options: ApprovedPlanRecoveryResolutionOptions = {},
): ForcedExecuteRecoveryRuntimeState | null {
  const availableToolNames = new Set(options.availableToolNames || []);
  const pending = (Array.isArray(tasks) ? tasks : []).filter((task) =>
    task.status !== "completed" && task.evidenceStatus !== "satisfied"
  );
  for (const task of pending) {
    const planTaskId = String(task.id || "").trim();
    const requirementRef = String(task.requirementRef || planTaskId).trim();
    const taskCheckpointIdentity = {
      ...(planTaskId ? { planTaskId } : {}),
      ...(requirementRef ? { requirementRef } : {}),
    };
    const evidence = task.evidence && task.evidence.length > 0
      ? task.evidence
      : inferPlanTaskEvidence(task.text, task.commands || []);
    if (planTaskHasUnsatisfiedSourceMutationEvidence(task, evidenceLedger)) {
      const target = evidence
        .find((item) => item.kind === "file" && !isInternalPlanPath(item.value))
        ?.value?.trim();
      if (target) {
        return {
          mode: "patch_recovery_read",
          reason: "approved_plan_execution_handoff",
          expectedTarget: target,
          attempts: 0,
          phaseNoProgressCount: 0,
          protocolNoProgressCount: 0,
          protocolNoProgressFingerprint: null,
          readLease: {
            purpose: "plan_line_context",
            target,
            state: "available",
          },
          sourceObservationKey: null,
          decisionCheckpoint: {
            expectedTarget: target,
            sourceObservationKey: null,
            nextRequiredCapability: "targeted_read",
            ...taskCheckpointIdentity,
          },
        };
      }
    }

    const unsatisfiedEvidence = findUnsatisfiedPlanTaskEvidence(task, evidenceLedger);
    const command = unsatisfiedEvidence.find((item) => item.kind === "cmd")?.value?.trim();
    if (command && requiresPtyObservationForPlanCommand(command)) {
      return {
        mode: "validation_only",
        reason: "approved_plan_long_process_handoff",
        expectedTarget: null,
        attempts: 0,
        phaseNoProgressCount: 0,
        protocolNoProgressCount: 0,
        protocolNoProgressFingerprint: null,
        readLease: null,
        sourceObservationKey: null,
        decisionCheckpoint: {
          expectedTarget: null,
          sourceObservationKey: null,
          nextRequiredCapability: "launch_long_process",
          ...taskCheckpointIdentity,
        },
      };
    }
    if (command) {
      return {
        mode: "finite_validation_only",
        reason: "approved_plan_command_handoff",
        expectedTarget: null,
        attempts: 0,
        phaseNoProgressCount: 0,
        protocolNoProgressCount: 0,
        protocolNoProgressFingerprint: null,
        readLease: null,
        sourceObservationKey: null,
        decisionCheckpoint: {
          expectedTarget: null,
          sourceObservationKey: null,
          nextRequiredCapability: "validation",
          ...taskCheckpointIdentity,
        },
      };
    }

    if (unsatisfiedEvidence.some((item) => item.kind === "dev_server_url")) {
      return {
        mode: "validation_only",
        reason: "approved_plan_dev_server_handoff",
        expectedTarget: null,
        attempts: 0,
        phaseNoProgressCount: 0,
        protocolNoProgressCount: 0,
        protocolNoProgressFingerprint: null,
        readLease: null,
        sourceObservationKey: null,
        decisionCheckpoint: {
          expectedTarget: null,
          sourceObservationKey: null,
          nextRequiredCapability: "launch_long_process",
          ...taskCheckpointIdentity,
        },
      };
    }

    if (unsatisfiedEvidence.some((item) =>
      item.kind === "browser_dom" || item.kind === "browser_screenshot"
    )) {
      return {
        mode: "validation_only",
        reason: "approved_plan_browser_handoff",
        expectedTarget: null,
        attempts: 0,
        phaseNoProgressCount: 0,
        protocolNoProgressCount: 0,
        protocolNoProgressFingerprint: null,
        readLease: null,
        sourceObservationKey: null,
        decisionCheckpoint: {
          expectedTarget: null,
          sourceObservationKey: null,
          nextRequiredCapability: "browser_validation",
          ...taskCheckpointIdentity,
        },
      };
    }

    if (
      unsatisfiedEvidence.some((item) => item.kind === "tauri_required") &&
      availableToolNames.has("computer_use")
    ) {
      return {
        mode: "validation_only",
        reason: "approved_plan_desktop_handoff",
        expectedTarget: null,
        attempts: 0,
        phaseNoProgressCount: 0,
        protocolNoProgressCount: 0,
        protocolNoProgressFingerprint: null,
        readLease: null,
        sourceObservationKey: null,
        decisionCheckpoint: {
          expectedTarget: null,
          sourceObservationKey: null,
          nextRequiredCapability: "desktop_validation",
          ...taskCheckpointIdentity,
        },
      };
    }
  }
  return null;
}

export interface ApprovedPlanRecoveryStateLike {
  mode: ExecuteRecoveryMode;
  reason?: string | null;
  expectedTarget?: string | null;
  decisionCheckpoint?: {
    planTaskId?: string | null;
    requirementRef?: string | null;
    nextRequiredCapability?: string | null;
  } | null;
}

export type ApprovedPlanRecoveryReconciliation =
  | { action: "unchanged"; next: ForcedExecuteRecoveryRuntimeState | null }
  | { action: "advance"; next: ForcedExecuteRecoveryRuntimeState }
  | { action: "complete"; next: null };

/**
 * Rebase an approved-Plan recovery transaction onto the first obligation that
 * is still unsatisfied by durable evidence. Task identity and target identity
 * are deliberately compared separately: two reviewed changes may touch the
 * same file, while read/patch/PTY subphases of one obligation must retain their
 * exact lease and progress counters.
 */
export function resolveApprovedPlanRecoveryReconciliation(input: {
  tasks: PlanTask[];
  evidenceLedger?: PlanExecutionEvidenceEntry[];
  current: ApprovedPlanRecoveryStateLike;
  options?: ApprovedPlanRecoveryResolutionOptions;
}): ApprovedPlanRecoveryReconciliation {
  const next = resolveApprovedPlanInitialExecutionRecovery(
    input.tasks,
    input.evidenceLedger || [],
    input.options,
  );
  const currentTaskId = String(
    input.current.decisionCheckpoint?.planTaskId || "",
  ).trim();
  const currentRequirementRef = String(
    input.current.decisionCheckpoint?.requirementRef || "",
  ).trim();
  const currentIsPlanOwned = Boolean(currentTaskId || currentRequirementRef) ||
    String(input.current.reason || "").startsWith("approved_plan_");

  if (!next) {
    return currentIsPlanOwned
      ? { action: "complete", next: null }
      : { action: "unchanged", next: null };
  }
  if (input.current.mode === "normal") {
    return { action: "advance", next };
  }

  const nextTaskId = String(next.decisionCheckpoint?.planTaskId || "").trim();
  const nextRequirementRef = String(
    next.decisionCheckpoint?.requirementRef || "",
  ).trim();
  const taskChanged = currentTaskId && nextTaskId
    ? currentTaskId !== nextTaskId
    : currentRequirementRef && nextRequirementRef
      ? currentRequirementRef !== nextRequirementRef
      : !currentTaskId && !currentRequirementRef;
  if (taskChanged) return { action: "advance", next };

  const currentTarget = String(input.current.expectedTarget || "").trim();
  const nextTarget = String(next.expectedTarget || "").trim();
  const targetChanged = Boolean(currentTarget) !== Boolean(nextTarget) ||
    Boolean(
      currentTarget && nextTarget &&
      !workspacePathsReferToSameFile(currentTarget, nextTarget)
    );
  // Within one task, a source-attributed command/browser failure may
  // intentionally reopen mutation on a different target. Only the canonical
  // successful-mutation transition is allowed to hand the same task from its
  // file obligation to its command/browser/desktop validation obligation.
  const mutationEvidenceJustCommitted =
    input.current.reason === "recovery_mutation_observed";
  return targetChanged && mutationEvidenceJustCommitted
    ? { action: "advance", next }
    : { action: "unchanged", next };
}

export type ApprovedPlanSameTurnFallbackDecision =
  | "start"
  | "retry_busy"
  | "busy_retry_exhausted"
  | "session_changed"
  | "transition_stale";

export function isPlanReviewExecutionLeaseActive(input: {
  agentStatus: string;
  isGenerating: boolean;
  hasAbortController: boolean;
}): boolean {
  // pending_review/awaiting_approval is a paused review run, not a live
  // execution lease. Treating its retained AbortController as active leaves
  // the approved child run queued forever because the review promise has
  // already settled and can no longer perform the workflow fallback.
  return input.agentStatus === "running" && input.isGenerating && input.hasAbortController;
}

interface ApprovedPlanFallbackHandoffLike {
  planTurnId: string;
  requestedAt: number;
  approvalLeaseId: string;
  executionLeaseId: string;
  sessionEpoch: string;
  reviewRequestId: string;
  executionTurnId: string;
  executionRunId: string;
  executionAttempt: number;
  executionInstructionHash: string;
  parentRunId: string | null;
  planRevision: number;
  artifactHash: string;
}

export function resolveApprovedPlanSameTurnFallbackDecision(input: {
  expectedSessionKey: string;
  currentSessionKey: string | null;
  expectedHandoff: ApprovedPlanFallbackHandoffLike;
  currentHandoff: ApprovedPlanFallbackHandoffLike | null | undefined;
  hasExactPlanApprovalHandoff: boolean;
  isAgentBusy: boolean;
  busyRetryAttempt: number;
  maxBusyRetries?: number;
}): ApprovedPlanSameTurnFallbackDecision {
  if (input.currentSessionKey !== input.expectedSessionKey) return "session_changed";

  const expectedExecutionTurnId = input.expectedHandoff.executionTurnId;
  const currentExecutionTurnId = input.currentHandoff?.executionTurnId;
  const exactArtifactIdentity =
    !input.expectedHandoff.artifactHash ||
    (
      input.currentHandoff?.artifactHash === input.expectedHandoff.artifactHash &&
      (
        input.expectedHandoff.planRevision == null ||
        input.currentHandoff?.planRevision === input.expectedHandoff.planRevision
      )
    );
  const exactApprovalLease =
    !!input.expectedHandoff.approvalLeaseId &&
    input.currentHandoff?.approvalLeaseId === input.expectedHandoff.approvalLeaseId &&
    !!input.expectedHandoff.sessionEpoch &&
    input.currentHandoff?.sessionEpoch === input.expectedHandoff.sessionEpoch &&
    !!input.expectedHandoff.reviewRequestId &&
    input.currentHandoff?.reviewRequestId === input.expectedHandoff.reviewRequestId;
  const exactExecutionLease =
    !!input.expectedHandoff.executionLeaseId &&
    input.currentHandoff?.executionLeaseId === input.expectedHandoff.executionLeaseId &&
    !!input.expectedHandoff.executionRunId &&
    input.currentHandoff?.executionRunId === input.expectedHandoff.executionRunId &&
    input.currentHandoff?.parentRunId === input.expectedHandoff.parentRunId &&
    input.currentHandoff?.executionAttempt === input.expectedHandoff.executionAttempt &&
    input.currentHandoff?.executionInstructionHash === input.expectedHandoff.executionInstructionHash;
  const isExactPendingTransition =
    input.hasExactPlanApprovalHandoff &&
    input.currentHandoff?.planTurnId === input.expectedHandoff.planTurnId &&
    input.currentHandoff?.requestedAt === input.expectedHandoff.requestedAt &&
    currentExecutionTurnId === expectedExecutionTurnId &&
    exactArtifactIdentity &&
    exactApprovalLease &&
    exactExecutionLease;
  if (!isExactPendingTransition) return "transition_stale";

  if (!input.isAgentBusy) return "start";
  return input.busyRetryAttempt < Math.max(0, input.maxBusyRetries ?? 1)
    ? "retry_busy"
    : "busy_retry_exhausted";
}

export type PlanToolActivityStatus = "called" | "succeeded" | "failed";

export interface PlanAstSymbolObservation {
  name: string;
  kind: string;
  syntaxKind: string;
  startLine: number;
  endLine: number;
}

export interface PlanAstObservation {
  path: string;
  language: string;
  versionToken: string;
  query?: string;
  exactMatchCount?: number;
  hasErrors: boolean;
  truncated: boolean;
  symbols: PlanAstSymbolObservation[];
}

export interface PlanToolActivitySummary {
  name: string;
  target: string;
  status: PlanToolActivityStatus;
  detail?: string;
  /** Runtime-observed mutation truth; tool names and success prose are insufficient. */
  mutationObserved?: boolean;
  /** Largest concrete changed hunk from the runtime-observed full-file diff. */
  mutationRange?: {
    path: string;
    startLine: number;
    endLine: number;
    maxLines: number;
  };
  /** Runtime-owned typed evidence. Legacy `facts` are display/import only. */
  structuredFacts?: PlanStructuredEvidenceFact[];
  /** Immutable exact source excerpts retained before display compaction. */
  sourceObservations?: PlanSourceObservation[];
  /** Runtime-parsed project/symbol topology; never reconstructed from model prose. */
  discoveryObservation?: PlanEvidenceDiscoveryObservation;
  /** Exact remaining read/search contract owned by the runtime. */
  evidenceObligation?: PlanEvidenceObligation;
  /** Exact needs_evidence transaction this result was admitted to close. */
  obligationClosure?: {
    role: "obligation_closure";
    obligation: PlanEvidenceObligation;
  };
  facts?: string[];
  /** Exact versioned read window retained across checkpoints and compaction. */
  readFileObservation?: FileReadObservationIdentity;
  /** Parser-backed declaration ranges retained without source prose. */
  astObservation?: PlanAstObservation;
  /** Provenance for a child-owned observation and its exact source epoch. */
  delegatedObservation?: {
    owner: {
      agentKind: "subagent";
      collaborationTaskId?: string;
      subagentId: string;
      parentTurnId?: string;
      runId?: string;
    };
    sourceToolCallId?: string;
    sourceObservationKey?: string;
    sourceVersion?: string;
    sourceContentHash?: string;
    sourceContentChars?: number;
    sourceRange?: FileReadWindowIdentity;
    /**
     * Planning may reuse a provenance-backed child observation without
     * pretending that the child's whole delegated task completed. Execution
     * mutations still obey parentContextState/requiresParentReread below.
     */
    planningEvidenceState?: "reusable" | "unresolved";
    /** Set only when a wait_subagents result crossed the parent join/consume boundary. */
    joinState?: "consumed";
    /** Only a complete, owner-matched typed closure may satisfy a parent read obligation. */
    closureState?: "satisfied" | "partial" | "unverified";
    parentContextState: "reference_only" | "version_verified";
    requiresParentReread: boolean;
  };
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
  // The task tracker owns detailed evidence state. Repeating internal values
  // such as `[missing]` in the Capsule headline is both noisy and misleading:
  // it describes the audit record, not the user's next action.
  const suffix = isPlanTaskAwaitingExternalValidation(task)
    ? "（待用户验证）"
    : isPlanTaskAwaitingBrowserValidation(task)
    ? "（需要浏览器验证）"
    : "";
  return compactLine(`${task.text}${suffix}`);
}

function summarizeEvidence(entry: PlanExecutionEvidenceEntry): string {
  const target = entry.target || entry.value;
  return compactLine(`${entry.kind}:${target} via ${entry.sourceTool}`);
}

function summarizeToolActivity(activity: PlanToolActivitySummary): string {
  const target = activity.target ? ` ${activity.target}` : "";
  const detail = activity.detail ? ` - ${activity.detail}` : "";
  const observation = activity.readFileObservation
    ? ` [read=${activity.readFileObservation.source}; version=${activity.readFileObservation.versionToken}; request=${activity.readFileObservation.requestSignature}]`
    : "";
  return compactLine(`${activity.status}:${activity.name}${target}${observation}${detail}`);
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
  currentTaskId?: string;
  currentTool?: string;
  latestEvidence?: string;
  includeCompleted?: boolean;
}): PlanTask | undefined {
  const eligibleTasks = input.tasks.filter((task) =>
    input.includeCompleted ||
    (task.status !== "completed" && task.evidenceStatus !== "satisfied")
  );
  const currentTaskId = String(input.currentTaskId || "").trim();
  if (currentTaskId) {
    return eligibleTasks.find((task) => task.id === currentTaskId);
  }
  const targets = collectActivityTargets(input);
  let bestScore = 0;
  const bestTasks: PlanTask[] = [];
  eligibleTasks.forEach((task) => {
    const score = scoreTaskForActivity(task, targets);
    if (score < 3) return;
    if (score > bestScore) {
      bestTasks.length = 0;
      bestTasks.push(task);
      bestScore = score;
    } else if (score === bestScore) {
      bestTasks.push(task);
    }
  });
  if (bestTasks.length === 1) return bestTasks[0];
  const uniqueInProgressMatch = bestTasks.filter((task) => task.status === "in_progress");
  return uniqueInProgressMatch.length === 1 ? uniqueInProgressMatch[0] : undefined;
}

function isBroadPlanTask(task: PlanTask | undefined): boolean {
  const text = normalizeMatchText(task?.text || "");
  if (!text) return false;
  return /^(?:目标|goal)[：:]/i.test(text) ||
    /(?:\b\d+\s*(?:个|core)?\s*(?:核心)?(?:问题|issues)|整体|全局|设计规范|design\s+spec|all\s+core\s+issues)/i.test(text);
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
  currentTaskId?: string;
  currentTask?: string;
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
    currentTaskId: input.currentTaskId,
    currentTool: input.currentTool,
    latestEvidence: input.latestEvidence || recentEvidence,
    includeCompleted: input.phase === "tool_done",
  });
  const derivedCurrentTask = activeTask
    ? summarizeTask(activeTask)
    : remainingTask && !(recentTool && isBroadPlanTask(remainingTask))
    ? summarizeTask(remainingTask)
    : recentTool
    ? compactLine(input.language === "zh" ? `当前动作：${recentTool}` : `Current action: ${recentTool}`)
    : input.language === "zh" ? "核查最终证据" : "verify final evidence";
  const currentTask = compactLine(input.currentTask || derivedCurrentTask);

  return {
    phase: input.phase,
    ...((activeTask?.id || remainingTask?.id)
      ? { currentTaskId: activeTask?.id || remainingTask?.id }
      : {}),
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
    runId: input.update.runId || previous?.runId || undefined,
    parentRunId: input.update.parentRunId !== undefined
      ? input.update.parentRunId
      : previous?.parentRunId,
    phase: input.update.phase || previous?.phase || "running",
    currentTaskId: compactLine(input.update.currentTaskId || previous?.currentTaskId || "", 160) || undefined,
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

export interface RestoredPlanExecutionTaskIdentityResolution {
  currentTaskId?: string;
  ambiguous: boolean;
}

/**
 * Migrate legacy checkpoints that predate `currentTaskId`. Text and status are
 * accepted only when they identify exactly one live task. Ambiguous same-file
 * task graphs must be paused for revision instead of guessing from path order.
 */
export function resolveRestoredPlanExecutionTaskIdentity(input: {
  snapshot?: Partial<PlanExecutionProgressSnapshot> | null;
  tasks: PlanTask[];
}): RestoredPlanExecutionTaskIdentityResolution {
  const snapshot = input.snapshot;
  if (!snapshot) return { ambiguous: false };
  const tasks = Array.isArray(input.tasks) ? input.tasks : [];
  const persistedId = String(snapshot.currentTaskId || "").trim();
  if (persistedId) {
    return tasks.some((task) => task.id === persistedId)
      ? { currentTaskId: persistedId, ambiguous: false }
      : { ambiguous: true };
  }

  const eligible = tasks.filter((task) =>
    task.status !== "completed" && task.evidenceStatus !== "satisfied"
  );
  if (eligible.length === 0) return { ambiguous: false };
  const checkpointText = compactLine(snapshot.currentTask || "");
  if (checkpointText) {
    const textMatches = eligible.filter((task) => compactLine(task.text) === checkpointText);
    if (textMatches.length === 1) {
      return { currentTaskId: textMatches[0].id, ambiguous: false };
    }
    if (textMatches.length > 1) return { ambiguous: true };
  }
  const inProgress = eligible.filter((task) => task.status === "in_progress");
  if (inProgress.length === 1) {
    return { currentTaskId: inProgress[0].id, ambiguous: false };
  }
  if (inProgress.length > 1) return { ambiguous: true };
  return eligible.length === 1
    ? { currentTaskId: eligible[0].id, ambiguous: false }
    : { ambiguous: true };
}

/**
 * Convert the plan-specific checkpoint into the canonical runtime event shape.
 * The checkpoint intentionally retains richer plan fields for the task UI;
 * consumers of runtimeEvents must not receive that incompatible object.
 */
function parsePlanExecutionToolIdentity(value: unknown): {
  tool: string;
  canonicalTarget: string;
} {
  const parts = String(value || "")
    .split(/\s*[·|]\s*/)
    .map((part) => part.trim())
    .filter(Boolean);
  const tool = parts[0] && /^[a-z][a-z0-9_-]*$/i.test(parts[0]) ? parts[0] : "";
  return {
    tool,
    canonicalTarget: tool ? parts.slice(1).join(" · ") : "",
  };
}

export function toPlanExecutionRuntimeProgressUpdate(input: {
  snapshot: PlanExecutionProgressSnapshot;
  language: "zh" | "en";
  dedupeKey?: string;
}): MainThreadProgressUpdate {
  const { snapshot, language } = input;
  const failed = snapshot.phase === "tool_error";
  const paused = snapshot.phase === "paused" || snapshot.phase === "waiting_review";
  const completed = snapshot.phase === "completed";
  const status = failed
    ? "failed"
    : paused
    ? "paused"
    : completed
    ? "completed"
    : snapshot.phase === "tool_done"
    ? "done"
    : "running";
  const title = language === "zh"
    ? failed
      ? "计划执行工具失败"
      : paused
      ? "计划执行已暂停"
      : completed
      ? "计划执行已完成"
      : "正在执行已批准计划"
    : failed
    ? "Plan execution tool failed"
    : paused
    ? "Plan execution paused"
    : completed
    ? "Plan execution completed"
    : "Executing approved plan";
  const summary = [
    snapshot.currentTask,
    snapshot.currentTool,
    snapshot.latestEvidence,
    snapshot.nextStep,
  ]
    .map((value) => compactLine(value, 180))
    .filter(Boolean)
    .join(" · ");
  const toolIdentity = parsePlanExecutionToolIdentity(snapshot.currentTool);

  return {
    phase: `plan_execution:${snapshot.phase}`,
    title,
    status,
    summary,
    ...(toolIdentity.tool ? { tool: toolIdentity.tool } : {}),
    ...(toolIdentity.canonicalTarget
      ? { canonicalTarget: toolIdentity.canonicalTarget }
      : {}),
    ...(input.dedupeKey ? { dedupeKey: input.dedupeKey } : {}),
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
        `${phaseLabel} · 轮次 ${turnInfo}`,
        statusText,
      ].join("\n")
    : [
        `${phaseLabel} · turn ${turnInfo}`,
        statusText,
      ].join("\n");
}
