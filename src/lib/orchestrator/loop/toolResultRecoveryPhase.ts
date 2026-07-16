import {
  buildFailedFiniteValidationRecoveryPrompt,
  classifyFailedFiniteValidationOutcome,
  failedFiniteValidationMatchesPendingPlanEvidence,
  hasPendingPlanCommandEvidence,
  resolveFailedFiniteValidationRecoveryPolicy,
  requestedRangeFromReadObservationSignature,
  shouldEnterFailedFiniteValidationRecovery,
} from "../../executeRecoveryTools";
import { buildApprovedPlanScopeConflictFingerprint } from "../../approvedPlanExecutionScope";
import { resolveDevServerRuntimeState } from "../../devServerRuntime";
import {
  isReviewablePlanStage,
  isSuccessfulPlanArtifactWriteResult,
  logAgentEvent,
  resolveApprovedPlanValidationBoundary,
} from "../../orchestrator";
import { buildPlanApprovalIdentity } from "../../planApprovalIdentity";
import { commandResultLooksSuccessful } from "../../planEvidence";
import type {
  PlanAstObservation,
  PlanAstSymbolObservation,
  PlanToolActivitySummary,
} from "../../planExecutionRecovery";
import { MODEL_CONTROL_LANGUAGE } from "../../modelControlLanguage";
import { extractReadFileWindowMetadata } from "../../readFileWindow";
import { isMutationRuntimeIntent, type ResolvedUserIntent } from "../../runIntent";
import type { TaskOrchestratorPhase } from "../../taskTargeting";
import type { ToolCapabilityRegistry, ToolPermissionPolicy } from "../../toolCapabilities";
import type { MainThreadEventInput, ToolFeedbackFormat } from "../../turnEvents";
import type { TurnInputContextSignals } from "../../turnIntake";
import type {
  PlanExecutionProgressPhase,
  PlanExecutionProgressUpdate,
  PlanRuntimePhase,
  PlanTask,
} from "../../workflowModels";
import {
  buildPlanTaskEvidenceAudit,
  inferPlanTaskEvidence,
  planTaskHasUnsatisfiedSourceMutationEvidence,
} from "../../workflowModels";
import { buildExecuteEvidenceClosureAudit } from "../../verificationEvidence";
import { workspacePathsReferToSameFile } from "../../workspacePaths";
import type { OrchestratorCallbacks, ToolCallToExecute, ToolExecutionResult } from "../types";
import type { ApprovedPlanNoProgressDecision } from "./loopRecovery";
import {
  handleCrossIterationReadFileLoopRecovery,
  handleExecuteConvergencePrompt,
  handleNoProgressRecovery,
  handleReadFileRepeatLimitRecovery,
  handleRepeatedEditValidationRecovery,
  handleStrictRepeatGuardRecovery,
  handleTargetProgressLoopRecovery,
} from "./loopRecovery";
import type { ExecuteRecoveryRuntimeState } from "./executeRecoveryRuntime";
import {
  applyCrossIterationReadFileRecoveryState,
  clearExecuteRecoveryRuntimeState,
  resolvePtyObservationPolicyDeferral,
  setRepeatedEditValidationRecoveryAttempts,
} from "./executeRecoveryRuntime";
import type {
  PlanLoopRuntimeState,
  PlanRuntimePhaseQualitySnapshot,
} from "./planRuntimeState";
import {
  applyPlanQualityRuntimeState,
  applyPlanReadOnlyConvergenceRuntimeState,
  applyPlanRuntimePhase,
} from "./planRuntimeState";
import type { AgentLoopGuardRuntimeState } from "./loopGuardRuntimeState";
import {
  applyNoProgressTrackingRuntimeState,
  applyToolFailureSignatureRuntimeState,
  getNoProgressTrackingRuntimeState,
} from "./loopGuardRuntimeState";
import type { AgentLoopRecoveryPromptRuntimeState } from "./recoveryPromptRuntimeState";
import { applyExecuteConvergencePromptState } from "./recoveryPromptRuntimeState";
import type { AgentLoopEvidenceRuntimeState } from "./evidenceRuntimeState";
import type { ApprovedPlanRecoveryRuntimeState } from "./approvedPlanRecoveryRuntime";
import {
  handlePlanQualityRecoveryAfterToolResults,
  shouldPauseForReviewablePlanArtifactAfterToolResults,
} from "./planQualityRecovery";
import { handlePlanReadOnlyConvergence } from "./planConvergence";
import { appendToolResultsToHistory } from "./toolResultHistory";
import type { TurnIterationContext } from "./turnIterationContext";

type WorkflowMode = "chat" | "edit" | "plan";

type ApprovedPlanCompletionAudit = {
  completedCount: number;
  totalCount: number;
  pendingUserValidationTasks?: PlanTask[];
};

type SetPlanRuntimePhase = (
  phase: PlanRuntimePhase,
  reason?: string,
  status?: "pending" | "running" | "done" | "failed",
  qualitySnapshot?: PlanRuntimePhaseQualitySnapshot,
) => void;

type EmitTaskOrchestratorPhase = (
  phase: TaskOrchestratorPhase,
  extra?: Record<string, unknown>,
) => void;

type EmitPlanExecutionProgress = (
  phase: PlanExecutionProgressPhase,
  overrides?: Partial<PlanExecutionProgressUpdate>,
) => void;

type ActivateExecuteRecovery = (
  mode: Exclude<ExecuteRecoveryRuntimeState["mode"], "normal">,
  reason: string,
  context?: Record<string, unknown>,
) => ExecuteRecoveryRuntimeState;

type ActivateChatFinalSynthesis = (
  reason: string,
  context?: Record<string, unknown>,
) => void;

type ApprovedPlanNoProgressAction = (input: ApprovedPlanNoProgressDecision) => void;
type ApprovedPlanNoProgressRecoveryAction = (
  input: ApprovedPlanNoProgressDecision,
) => ApprovedPlanRecoveryRuntimeState;

const APPROVED_PLAN_SCOPE_BLOCKED_RE = /\bAPPROVED_PLAN_SCOPE_BLOCKED\b/;

function getApprovedPlanScopeConflict(results: ToolExecutionResult[]): {
  requestedTargets: string[];
  unexpectedTargets: string[];
  plannedTargets: string[];
} {
  const requestedTargets = new Set<string>();
  const unexpectedTargets = new Set<string>();
  const plannedTargets = new Set<string>();
  for (const result of results) {
    const conflict = result.approvedPlanScopeConflict;
    if (
      !result.isError ||
      (!conflict && !APPROVED_PLAN_SCOPE_BLOCKED_RE.test(String(result.content || "")))
    ) {
      continue;
    }
    if (conflict) {
      conflict.requestedTargets.forEach((target) => requestedTargets.add(String(target || "").trim()));
      conflict.unexpectedTargets.forEach((target) => unexpectedTargets.add(String(target || "").trim()));
      conflict.plannedTargets.forEach((target) => plannedTargets.add(String(target || "").trim()));
      continue;
    }
    // Backward-compatible fallback for an in-flight result created before the
    // structured conflict envelope was added. New results never derive the
    // semantic identity from localized feedback or the mutation tool name.
    const target = String(result.target || "").trim();
    if (target) {
      requestedTargets.add(target);
      unexpectedTargets.add(target);
    }
  }
  return {
    requestedTargets: Array.from(requestedTargets).filter(Boolean),
    unexpectedTargets: Array.from(unexpectedTargets).filter(Boolean),
    plannedTargets: Array.from(plannedTargets).filter(Boolean),
  };
}

function buildApprovedPlanScopeRecoveryPrompt(input: {
  language: "zh" | "en";
  targets: string[];
  plannedTargets: string[];
}): string {
  const targets = input.targets.join(", ") || (input.language === "zh" ? "新的相关文件" : "a newly relevant file");
  const planned = input.plannedTargets.join(", ") || (input.language === "zh" ? "当前计划任务" : "the current Plan tasks");
  if (input.language === "en") {
    return [
      "The attempted write to " + targets + " was blocked because it is outside the approved Plan scope (" + planned + ").",
      "A bounded scope-recovery transaction is active. Reuse the retained source observation and make the exact mutation inside an approved target; read only if an exact current range is genuinely missing.",
      "Do not use shell commands or another tool to bypass the scope. If the source change genuinely requires the blocked target, write a focused Plan revision for review instead.",
    ].join("\n");
  }
  return [
    "对 " + targets + " 的写入已被拦截，因为它不在已批准 Plan 的修改范围内（当前范围：" + planned + "）。",
    "当前已进入有界范围恢复事务。请复用已有源码观察，在已批准目标内完成精确修改；只有确实缺失当前精确区间时才定向读取。",
    "不要用 shell 或换工具绕过范围限制；如果源码修复确实必须修改被拦截目标，请改为写出聚焦的 Plan revision 供审核。",
  ].join("\n");
}

function extractApprovedPlanSourceLineAnchors(text: string): number[] {
  const anchors: number[] = [];
  for (const match of String(text || "").matchAll(/(?:^|\W)(?:L|line\s+)(\d{1,7})(?:\s*[-–]\s*(\d{1,7}))?/gi)) {
    const start = Number(match[1]);
    const end = Number(match[2] || match[1]);
    if (Number.isFinite(start) && start > 0) anchors.push(start);
    if (Number.isFinite(end) && end > 0) anchors.push(end);
  }
  return [...new Set(anchors)];
}

function extractApprovedPlanSourceIdentifierAnchors(text: string): string[] {
  const anchors = new Set<string>();
  const add = (value: string) => {
    const clean = String(value || "").trim().replace(/\(\)$/, "");
    if (!/^[A-Za-z_$][\w$-]{2,}$/.test(clean)) return;
    if (/^(?:apply_patch|replace_in_file|write_file|read_file|run_command|execute_command|function|return|switch|while|catch|await)$/i.test(clean)) return;
    anchors.add(clean);
  };
  for (const match of String(text || "").matchAll(/`([A-Za-z_$][\w$-]*(?:\(\))?)`/g)) add(match[1]);
  for (const match of String(text || "").matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)) add(match[1]);
  return [...anchors].slice(0, 12);
}

function approvedPlanReadWindow(input: ToolExecutionResult): {
  wholeFile: boolean;
  startLine: number;
  endLine: number;
} {
  const metadata = extractReadFileWindowMetadata(input.content || "");
  if (metadata) {
    return {
      wholeFile:
        !metadata.truncated &&
        metadata.returnedStartLine === 1 &&
        metadata.returnedEndLine >= metadata.totalLines,
      startLine: metadata.returnedStartLine,
      endLine: metadata.returnedEndLine,
    };
  }
  const requestedRange = requestedRangeFromReadObservationSignature(
    input.readFileObservation?.requestSignature || "",
  );
  if (requestedRange) {
    const startLine = requestedRange.startLine || 1;
    return {
      wholeFile: false,
      startLine,
      endLine: requestedRange.endLine || (
        requestedRange.maxLines ? startLine + requestedRange.maxLines - 1 : startLine
      ),
    };
  }
  // read_file emits raw content only when the complete file fits in its
  // bounded result. Stubs are excluded before this helper is called.
  return { wholeFile: true, startLine: 1, endLine: Number.MAX_SAFE_INTEGER };
}

function approvedPlanReadCoversRange(
  result: ToolExecutionResult,
  range: { startLine: number; endLine: number },
): boolean {
  const window = approvedPlanReadWindow(result);
  return window.wholeFile || (
    window.startLine <= range.startLine && window.endLine >= range.endLine
  );
}

function resolveApprovedPlanAstOwner(
  identifiers: string[],
  observation: PlanAstObservation,
): { status: "resolved"; symbol: PlanAstSymbolObservation } | {
  status: "unresolved" | "ambiguous" | "needs_precise_query";
} {
  if (observation.hasErrors || !observation.versionToken) {
    return { status: "unresolved" };
  }
  if (observation.truncated) {
    const normalizedQuery = String(observation.query || "").trim().toLowerCase();
    const queriedIdentifier = identifiers.find((identifier) =>
      identifier.toLowerCase() === normalizedQuery
    );
    if (!queriedIdentifier) return { status: "needs_precise_query" };
    const exactMatches = observation.symbols.filter((symbol) =>
      symbol.name === queriedIdentifier
    );
    const exactMatchCount = Math.max(0, Number(observation.exactMatchCount) || 0);
    if (exactMatchCount === 1 && exactMatches.length === 1) {
      return { status: "resolved", symbol: exactMatches[0] };
    }
    return exactMatchCount > 1
      ? { status: "ambiguous" }
      : { status: "unresolved" };
  }
  for (const identifier of identifiers) {
    const matches = observation.symbols.filter((symbol) => symbol.name === identifier);
    if (matches.length === 0) continue;
    if (matches.length === 1) return { status: "resolved", symbol: matches[0] };
    const nested = [...matches].sort((left, right) =>
      (left.endLine - left.startLine) - (right.endLine - right.startLine) ||
      right.startLine - left.startLine
    )[0];
    const nestedInsideEveryCandidate = matches.every((candidate) =>
      candidate.startLine <= nested.startLine && candidate.endLine >= nested.endLine
    );
    return nestedInsideEveryCandidate
      ? { status: "resolved", symbol: nested }
      : { status: "ambiguous" };
  }
  return { status: "unresolved" };
}

export type ApprovedPlanMutationContextDecision =
  | { status: "none" }
  | {
      status: "needs_targeting";
      target: string;
      identifiers: string[];
      observedVersion: string | null;
      sourceObservationKey: string | null;
      targetingReason?: "missing_ast" | "stale_ast" | "precise_query_required";
    }
  | {
      status: "needs_range_read";
      target: string;
      requestedRange: { startLine: number; endLine: number; maxLines: number };
      observedVersion: string | null;
      symbolName: string | null;
      rangeSource: "plan_line" | "ast_declaration";
    }
  | {
      status: "covered";
      result: ToolExecutionResult;
      requestedRange: { startLine: number; endLine: number; maxLines: number } | null;
      symbolName: string | null;
    };

export function resolveApprovedPlanMutationContextDecision(input: {
  tasks: PlanTask[];
  evidenceLedger: ReturnType<OrchestratorCallbacks["getPlanExecutionEvidenceLedger"]>;
  results: ToolExecutionResult[];
  recentToolActivity?: PlanToolActivitySummary[];
  expectedVersion?: string | null;
}): ApprovedPlanMutationContextDecision {
  const audit = buildPlanTaskEvidenceAudit({
    tasks: input.tasks,
    evidenceLedger: input.evidenceLedger,
    preserveMissing: true,
    highlightNext: true,
  });
  const pendingTask = audit.remainingTasks.find((task) =>
    planTaskHasUnsatisfiedSourceMutationEvidence(task, input.evidenceLedger)
  );
  if (!pendingTask) return { status: "none" };
  const evidence = pendingTask.evidence && pendingTask.evidence.length > 0
    ? pendingTask.evidence
    : inferPlanTaskEvidence(pendingTask.text, pendingTask.commands || []);
  const pendingTargets = evidence
    .filter((item) => item.kind === "file")
    .map((item) => String(item.value || "").trim())
    .filter(Boolean);
  if (pendingTargets.length === 0) return { status: "none" };
  const readResults = input.results.filter((result) =>
    result.name === "read_file" &&
    !result.isError &&
    !result.internalFeedback &&
    result.readFileObservation?.source !== "stub" &&
    pendingTargets.some((target) => workspacePathsReferToSameFile(result.target, target))
  );
  const explicitlyCoveredRead = readResults.find((result) =>
    approvedPlanReadCoversDecisionAnchor(pendingTask, result)
  );
  if (explicitlyCoveredRead) {
    return {
      status: "covered",
      result: explicitlyCoveredRead,
      requestedRange: null,
      symbolName: null,
    };
  }

  const target = pendingTargets.find((candidate) =>
    readResults.some((result) => workspacePathsReferToSameFile(result.target, candidate)) ||
    [...(input.recentToolActivity || [])].reverse().some((activity) =>
      activity.astObservation && workspacePathsReferToSameFile(activity.astObservation.path, candidate)
    )
  ) || pendingTargets[0];
  const lineAnchors = extractApprovedPlanSourceLineAnchors(pendingTask.text);
  if (lineAnchors.length > 0) {
    const requestedRange = {
      startLine: Math.min(...lineAnchors),
      endLine: Math.max(...lineAnchors),
      maxLines: Math.max(1, Math.max(...lineAnchors) - Math.min(...lineAnchors) + 1),
    };
    const coveringRead = readResults.find((result) =>
      workspacePathsReferToSameFile(result.target, target) &&
      approvedPlanReadCoversRange(result, requestedRange)
    );
    return coveringRead
      ? { status: "covered", result: coveringRead, requestedRange, symbolName: null }
      : {
          status: "needs_range_read",
          target,
          requestedRange,
          observedVersion: readResults.find((result) =>
            workspacePathsReferToSameFile(result.target, target)
          )?.readFileObservation?.versionToken || null,
          symbolName: null,
          rangeSource: "plan_line",
        };
  }

  const identifiers = extractApprovedPlanSourceIdentifierAnchors(pendingTask.text);
  if (identifiers.length === 0) return { status: "none" };
  const currentBatchRead = [...readResults].reverse().find((result) =>
    workspacePathsReferToSameFile(result.target, target)
  );
  const retainedReadObservation = [...(input.recentToolActivity || [])].reverse().find((activity) =>
    activity.status === "succeeded" &&
    activity.readFileObservation &&
    workspacePathsReferToSameFile(activity.readFileObservation.path, target)
  )?.readFileObservation;
  const currentReadVersion = currentBatchRead?.readFileObservation?.versionToken ||
    retainedReadObservation?.versionToken || null;
  const sourceObservationKey = currentBatchRead?.readFileObservation?.key ||
    retainedReadObservation?.key || null;
  const newestAstObservation = [...(input.recentToolActivity || [])].reverse().find((activity) =>
    activity.status === "succeeded" &&
    activity.name === "code_ast_query" &&
    activity.astObservation &&
    workspacePathsReferToSameFile(activity.astObservation.path, target)
  )?.astObservation;
  const currentBatchHasAstQuery = input.results.some((result) =>
    result.name === "code_ast_query" &&
    !result.isError &&
    workspacePathsReferToSameFile(result.target, target)
  );
  const astObservation = newestAstObservation && (
    currentBatchHasAstQuery ||
    (currentReadVersion
      ? newestAstObservation.versionToken === currentReadVersion
      : !input.expectedVersion || newestAstObservation.versionToken === input.expectedVersion)
  )
    ? newestAstObservation
    : undefined;
  if (!astObservation) {
    return currentReadVersion
      ? {
          status: "needs_targeting",
          target,
          identifiers,
          observedVersion: currentReadVersion,
          sourceObservationKey,
          targetingReason: newestAstObservation ? "stale_ast" : "missing_ast",
        }
      : { status: "none" };
  }
  const owner = resolveApprovedPlanAstOwner(identifiers, astObservation);
  if (owner.status === "needs_precise_query") {
    return {
      status: "needs_targeting",
      target,
      identifiers,
      observedVersion: astObservation.versionToken,
      sourceObservationKey,
      targetingReason: "precise_query_required",
    };
  }
  if (owner.status !== "resolved") return { status: "none" };
  const requestedRange = {
    startLine: owner.symbol.startLine,
    endLine: owner.symbol.endLine,
    maxLines: Math.max(1, owner.symbol.endLine - owner.symbol.startLine + 1),
  };
  const coveringRead = readResults.find((result) =>
    workspacePathsReferToSameFile(result.target, target) &&
    result.readFileObservation?.versionToken === astObservation.versionToken &&
    approvedPlanReadCoversRange(result, requestedRange)
  );
  const declarationPrefixEnd = Math.min(
    requestedRange.endLine,
    requestedRange.startLine + 1,
  );
  const declarationPrefixRead = readResults.find((result) => {
    if (
      !workspacePathsReferToSameFile(result.target, target) ||
      result.readFileObservation?.versionToken !== astObservation.versionToken
    ) {
      return false;
    }
    const window = approvedPlanReadWindow(result);
    return window.wholeFile || (
      window.startLine <= requestedRange.startLine &&
      window.endLine >= declarationPrefixEnd
    );
  });
  const mutationContextRead = coveringRead || declarationPrefixRead;
  return mutationContextRead
    ? {
        status: "covered",
        result: mutationContextRead,
        requestedRange,
        symbolName: owner.symbol.name,
      }
    : {
        status: "needs_range_read",
        target,
        requestedRange,
        observedVersion: astObservation.versionToken,
        symbolName: owner.symbol.name,
        rangeSource: "ast_declaration",
      };
}

function approvedPlanReadCoversDecisionAnchor(task: PlanTask, result: ToolExecutionResult): boolean {
  const metadata = extractReadFileWindowMetadata(result.content || "");
  const fullFileRead = Boolean(
    approvedPlanReadWindow(result).wholeFile,
  );
  if (fullFileRead) return true;

  const lineAnchors = extractApprovedPlanSourceLineAnchors(task.text);
  if (lineAnchors.length > 0) {
    const requestedRange = requestedRangeFromReadObservationSignature(
      result.readFileObservation?.requestSignature || "",
    );
    const startLine = metadata?.returnedStartLine || requestedRange?.startLine || 1;
    const endLine = metadata?.returnedEndLine || requestedRange?.endLine || (
      requestedRange?.maxLines ? startLine + requestedRange.maxLines - 1 : startLine
    );
    return lineAnchors.every((line) => line >= startLine && line <= endLine);
  }

  return false;
}

export function resolveApprovedPlanInitialMutationRead(input: {
  tasks: PlanTask[];
  evidenceLedger: ReturnType<OrchestratorCallbacks["getPlanExecutionEvidenceLedger"]>;
  results: ToolExecutionResult[];
  recentToolActivity?: PlanToolActivitySummary[];
}): ToolExecutionResult | null {
  const decision = resolveApprovedPlanMutationContextDecision(input);
  return decision.status === "covered" ? decision.result : null;
}

function resolveParentSourceRereadRequirement(input: {
  results: ToolExecutionResult[];
  recentToolActivity: PlanToolActivitySummary[];
}): {
  target: string;
  requestedRange: { startLine?: number; endLine?: number; maxLines?: number };
  observedVersion: string | null;
  sourceObservationKey: string | null;
} | null {
  const deferred = input.results.find((result) =>
    result.qualityGateReason === "subagent_parent_reread_required"
  );
  if (!deferred?.target) return null;
  const delegated = [...input.recentToolActivity].reverse().find((activity) =>
    activity.delegatedObservation?.requiresParentReread === true &&
    workspacePathsReferToSameFile(activity.target, deferred.target)
  )?.delegatedObservation;
  const sourceRange = delegated?.sourceRange;
  return {
    target: deferred.target,
    requestedRange: sourceRange
      ? {
          startLine: sourceRange.startLine,
          endLine: sourceRange.endLine,
          maxLines: Math.max(1, sourceRange.endLine - sourceRange.startLine + 1),
        }
      : { startLine: 1, maxLines: 180 },
    // The child version is diagnostic only; the parent must accept and bind
    // the current version it actually rereads in the exact delegated range.
    observedVersion: null,
    sourceObservationKey: delegated?.sourceObservationKey || null,
  };
}

export type ToolResultRecoveryPhaseResult =
  | {
      status: "continue" | "stopped" | "plan_completed" | "goal_completed";
      planRuntimeState: PlanLoopRuntimeState;
      loopGuardRuntimeState: AgentLoopGuardRuntimeState;
      executeRecoveryState: ExecuteRecoveryRuntimeState;
      recoveryPromptState: AgentLoopRecoveryPromptRuntimeState;
      approvedPlanRecoveryState: ApprovedPlanRecoveryRuntimeState;
      completionAudit?: ApprovedPlanCompletionAudit;
    }
  | {
      status: "completed";
      planRuntimeState: PlanLoopRuntimeState;
      loopGuardRuntimeState: AgentLoopGuardRuntimeState;
      executeRecoveryState: ExecuteRecoveryRuntimeState;
      recoveryPromptState: AgentLoopRecoveryPromptRuntimeState;
      approvedPlanRecoveryState: ApprovedPlanRecoveryRuntimeState;
      completionAudit?: ApprovedPlanCompletionAudit;
    };

export async function handleToolResultRecoveryPhase(input: {
  callbacks: OrchestratorCallbacks;
  workspace: string;
  activeProfile: string;
  toolFeedbackFormat: ToolFeedbackFormat;
  toolPermissionPolicy: ToolPermissionPolicy;
  workflowMode: WorkflowMode;
  runtimeIntent: ResolvedUserIntent;
  iteration: number;
  effectiveMaxIterations: number;
  effectiveToolCalls: ToolCallToExecute[];
  results: ToolExecutionResult[];
  toolArgsByCallId: Map<string, Record<string, unknown>>;
  toolFailureSignatures: Map<string, string>;
  hasPlanDecisionOutput: boolean;
  unityMcpFallbackPrompt: string | null;
  remainingTaskText: string | null;
  successfulReadOnlyExplorationResultCount: number;
  isUnapprovedPlanReadOnlyBatch: boolean;
  recentToolActivity: PlanToolActivitySummary[];
  recentPlanToolActivity: PlanToolActivitySummary[];
  attemptedPlanWriteTargets: string[];
  latestUserPromptText: string;
  availableToolNames: Set<string>;
  toolCapabilityRegistry: ToolCapabilityRegistry;
  snapshotContextLimit?: number;
  repairExecutionRequestInChat: boolean;
  turnInputContextSignals: TurnInputContextSignals;
  planRuntimeState: PlanLoopRuntimeState;
  loopGuardRuntimeState: AgentLoopGuardRuntimeState;
  executeRecoveryState: ExecuteRecoveryRuntimeState;
  approvedPlanRecoveryState: ApprovedPlanRecoveryRuntimeState;
  recoveryPromptState: AgentLoopRecoveryPromptRuntimeState;
  evidenceRuntimeState: AgentLoopEvidenceRuntimeState;
  iterationContext: Pick<TurnIterationContext, "eventThreadId" | "eventTurnId" | "turnContext">;
  emitTurnEvent: (event: MainThreadEventInput) => void;
  emitTurnFailedEvent: (message: string) => void;
  emitTaskOrchestratorPhase: EmitTaskOrchestratorPhase;
  emitPlanExecutionProgress: EmitPlanExecutionProgress;
  activateExecuteRecovery: ActivateExecuteRecovery;
  activateChatFinalSynthesis: ActivateChatFinalSynthesis;
  continueApprovedPlanWithStrategySwitch: ApprovedPlanNoProgressRecoveryAction;
  pauseApprovedPlanNoProgressLoop: ApprovedPlanNoProgressAction;
  setPlanRuntimePhase: SetPlanRuntimePhase;
  pauseForReviewablePlanArtifact: (
    trigger: string,
    runtimeStateOverride?: Pick<PlanLoopRuntimeState, "planArtifactQualityRejected">,
  ) => Promise<"not_reviewable" | "stopped" | "approved_continue">;
}): Promise<ToolResultRecoveryPhaseResult> {
  let planRuntimeState = input.planRuntimeState;
  let loopGuardRuntimeState = input.loopGuardRuntimeState;
  let executeRecoveryState = input.executeRecoveryState;
  let recoveryPromptState = input.recoveryPromptState;
  let approvedPlanRecoveryState = input.approvedPlanRecoveryState;
  let completionAudit: ApprovedPlanCompletionAudit | undefined;
  const activateExecuteRecoveryAndSync: ActivateExecuteRecovery = (mode, reason, context) => {
    // The callback updates the outer loop immediately. Mirror the returned
    // state locally so this phase cannot fold an older `normal` state back over
    // the activation when it returns.
    executeRecoveryState = input.activateExecuteRecovery(mode, reason, context);
    return executeRecoveryState;
  };
  const setPlanRuntimePhaseAndSync: SetPlanRuntimePhase = (
    phase,
    reason,
    status,
    qualitySnapshot,
  ) => {
    input.setPlanRuntimePhase(phase, reason, status, qualitySnapshot);
    planRuntimeState = applyPlanRuntimePhase({
      ...planRuntimeState,
      ...(qualitySnapshot?.qualityRejectCount != null
        ? { planQualityRejectCount: qualitySnapshot.qualityRejectCount }
        : {}),
      ...(qualitySnapshot?.missingSections
        ? { planLastMissingSections: [...qualitySnapshot.missingSections] }
        : {}),
    }, { phase, reason }).state;
  };

  const ptyObservationDeferral = resolvePtyObservationPolicyDeferral(input.results);
  if (executeRecoveryState.mode === "normal" && ptyObservationDeferral) {
    // browser_evaluate was deferred before execution because the foreground
    // server has no ready evidence for its current PTY generation. Turn that
    // structured policy outcome into an active recovery transaction before
    // completion/no-progress gates run. The next iteration can then derive an
    // observe_pty-only surface from the retained dev-server ledger; once that
    // same generation is ready, the same contract derives browser-only.
    executeRecoveryState = activateExecuteRecoveryAndSync(
      "validation_only",
      "browser_validation_deferred_for_pty_observation",
      {
        requestedUrl: ptyObservationDeferral.requestedUrl,
        nextCapability: "observe_pty",
      },
    );
    logAgentEvent("execute_recovery_activated_from_pty_observation_deferral", {
      iteration: input.iteration,
      requestedUrl: ptyObservationDeferral.requestedUrl,
      nextCapability: "observe_pty",
      executeRecoveryMode: executeRecoveryState.mode,
      executeRecoveryAttempts: executeRecoveryState.attempts,
    });
  }

  const planQualityRecovery = handlePlanQualityRecoveryAfterToolResults({
    callbacks: input.callbacks,
    workflowMode: input.workflowMode,
    iteration: input.iteration,
    results: input.results,
    ...planRuntimeState,
    recentPlanToolActivity: input.recentPlanToolActivity,
    attemptedPlanWriteTargets: input.attemptedPlanWriteTargets,
    latestUserPromptText: input.latestUserPromptText,
    setPlanRuntimePhase: setPlanRuntimePhaseAndSync,
  });
  planRuntimeState = applyPlanQualityRuntimeState(
    planRuntimeState,
    planQualityRecovery,
  );
  const pendingPlanRuntimeRecoveryPrompt = planQualityRecovery.pendingPlanRuntimeRecoveryPrompt;
  const approvedPlanScopeConflict = getApprovedPlanScopeConflict(input.results);
  const approvedPlanScopeBlockedTargets = approvedPlanScopeConflict.unexpectedTargets;

  // Keep the reviewed mutation boundary intact without turning every omitted
  // implementation detail into a user checkpoint. A blocked helper/test-file
  // write can usually recover through existing tests, an inline command, or a
  // temporary path; only a genuinely necessary source expansion needs a new
  // reviewed revision.
  if (
    input.workflowMode === "plan" &&
    input.callbacks.getIsPlanApproved() &&
    approvedPlanScopeBlockedTargets.length > 0
  ) {
    appendToolResultsToHistory({
      callbacks: input.callbacks,
      toolFeedbackFormat: input.toolFeedbackFormat,
      results: input.results,
      toolArgsByCallId: input.toolArgsByCallId,
      iterationContext: input.iterationContext,
      emitTurnEvent: input.emitTurnEvent,
    });
    const plannedTargets = approvedPlanScopeConflict.plannedTargets.length > 0
      ? approvedPlanScopeConflict.plannedTargets
      : Array.from(new Set(
          input.callbacks.getPlanTasks().flatMap((task) =>
            (task.evidence || [])
              .filter((evidence) => evidence.kind === "file" || evidence.kind === "deliverable")
              .map((evidence) => String(evidence.value || "").trim())
              .filter(Boolean),
          ),
        ));
    const language = input.callbacks.getPreferredLanguage();
    const planRevision = buildPlanApprovalIdentity(
      input.callbacks.getPlanArtifacts?.() || [],
    )?.revision ?? null;
    const protocolNoProgressFingerprint = buildApprovedPlanScopeConflictFingerprint({
      planRevision,
      unexpectedTargets: approvedPlanScopeBlockedTargets,
      plannedTargets,
    });
    executeRecoveryState = activateExecuteRecoveryAndSync(
      "mutation_first",
      "approved_plan_scope_blocked",
      {
        expectedTarget: plannedTargets[0] || null,
        repeatedTargets: approvedPlanScopeBlockedTargets,
        planRevision,
        plannedTargets,
        protocolNoProgressFingerprint,
      },
    );
    const recoveryPrompt = buildApprovedPlanScopeRecoveryPrompt({
      language: MODEL_CONTROL_LANGUAGE,
      targets: approvedPlanScopeBlockedTargets,
      plannedTargets,
    });
    logAgentEvent("approved_plan_scope_block_recovering", {
      iteration: input.iteration,
      targets: approvedPlanScopeBlockedTargets,
      plannedTargets,
      resultCount: input.results.length,
      planRevision,
      protocolNoProgressFingerprint,
      protocolNoProgressCount: executeRecoveryState.protocolNoProgressCount,
      recoveryMode: executeRecoveryState.mode,
      expectedTarget: executeRecoveryState.expectedTarget,
    });
    input.emitPlanExecutionProgress("running", {
      currentTask: language === "zh" ? "在已批准范围内继续" : "continuing within approved Plan scope",
      currentTool: "",
      latestEvidence: approvedPlanScopeBlockedTargets.join(", "),
      recoveryReason: "approved_plan_scope_block_recovering",
      repeatedTargets: approvedPlanScopeBlockedTargets,
      nextStep: language === "zh"
        ? "修改已批准目标，或提交聚焦的 Plan revision"
        : "mutate an approved target or submit a focused Plan revision",
    });
    input.callbacks.onStatusChange("running");
    input.callbacks.appendMessage({
      role: "user",
      content: recoveryPrompt,
    });
    return finish("continue");
  }

  const parentSourceRereadRequirement = resolveParentSourceRereadRequirement({
    results: input.results,
    recentToolActivity: input.recentToolActivity,
  });
  if (parentSourceRereadRequirement) {
    appendToolResultsToHistory({
      callbacks: input.callbacks,
      toolFeedbackFormat: input.toolFeedbackFormat,
      results: input.results,
      toolArgsByCallId: input.toolArgsByCallId,
      iterationContext: input.iterationContext,
      emitTurnEvent: input.emitTurnEvent,
    });
    executeRecoveryState = activateExecuteRecoveryAndSync(
      "patch_recovery_read",
      "subagent_parent_source_reread_required",
      {
        target: parentSourceRereadRequirement.target,
        requestedRange: parentSourceRereadRequirement.requestedRange,
        observedVersion: parentSourceRereadRequirement.observedVersion,
        sourceObservationKey: parentSourceRereadRequirement.sourceObservationKey,
      },
    );
    input.callbacks.appendMessage({
      role: "user",
      content: `PARENT_SOURCE_READ_LEASE: Read only ${parentSourceRereadRequirement.target} in the leased range, then continue with the pending parent mutation. Do not reopen broad investigation.`,
    });
    logAgentEvent("subagent_parent_reread_recovery_activated", {
      iteration: input.iteration,
      target: parentSourceRereadRequirement.target,
      requestedRange: parentSourceRereadRequirement.requestedRange,
      observedVersion: parentSourceRereadRequirement.observedVersion,
      sourceObservationKey: parentSourceRereadRequirement.sourceObservationKey,
    });
    return finish("continue");
  }

  // An approved source-edit task may need one exact parent-owned source
  // observation before it can write. As soon as that observation exists, bind
  // it to the transaction and switch atomically to mutation-only. Waiting for
  // a generic loop detector here allowed valid plans to drift back into a
  // multi-window investigation even though the next capability was known.
  const approvedPlanMutationContextDecision =
    (
      executeRecoveryState.mode === "normal" ||
      (
        executeRecoveryState.mode === "action_plus_targeting" &&
        executeRecoveryState.decisionCheckpoint?.nextRequiredCapability === "targeting"
      )
    ) &&
    input.workflowMode === "plan" &&
    input.callbacks.getIsPlanApproved() &&
    isMutationRuntimeIntent(input.runtimeIntent)
      ? resolveApprovedPlanMutationContextDecision({
          tasks: input.callbacks.getPlanTasks(),
          evidenceLedger: input.callbacks.getPlanExecutionEvidenceLedger(),
          results: input.results,
          recentToolActivity: input.recentPlanToolActivity,
          expectedVersion: executeRecoveryState.decisionCheckpoint?.evidenceVersion || null,
        })
      : { status: "none" as const };
  if (
    approvedPlanMutationContextDecision.status === "needs_targeting"
  ) {
    appendToolResultsToHistory({
      callbacks: input.callbacks,
      toolFeedbackFormat: input.toolFeedbackFormat,
      results: input.results,
      toolArgsByCallId: input.toolArgsByCallId,
      iterationContext: input.iterationContext,
      emitTurnEvent: input.emitTurnEvent,
    });
    executeRecoveryState = activateExecuteRecoveryAndSync(
      "action_plus_targeting",
      "approved_plan_symbol_targeting_required",
      {
        expectedTarget: approvedPlanMutationContextDecision.target,
        sourceObservationKey: approvedPlanMutationContextDecision.sourceObservationKey,
        decisionCheckpoint: {
          expectedTarget: approvedPlanMutationContextDecision.target,
          sourceObservationKey: approvedPlanMutationContextDecision.sourceObservationKey,
          nextRequiredCapability: "targeting",
          evidenceVersion: approvedPlanMutationContextDecision.observedVersion,
        },
      },
    );
    input.callbacks.appendMessage({
      role: "user",
      content: [
        "SOURCE_TARGETING_REQUIRED: The current read is only a reference/call window, not parser-backed mutation context.",
        `Call code_ast_query for ${approvedPlanMutationContextDecision.target} with query set to one exact reviewed identifier (${approvedPlanMutationContextDecision.identifiers.join(", ")}) and max_results 200. This is the only targeting capability exposed.`,
        approvedPlanMutationContextDecision.targetingReason === "precise_query_required"
          ? "The previous AST result was truncated and cannot prove declaration uniqueness until the exact identifier query is used."
          : approvedPlanMutationContextDecision.targetingReason === "stale_ast"
          ? "The retained AST belongs to a different file version; query the current version before reading source again."
          : "No current parser-backed declaration observation exists yet.",
        "Do not reread the file or mutate until the runtime grants the exact declaration range.",
      ].join("\n"),
    });
    logAgentEvent("approved_plan_symbol_targeting_activated", {
      iteration: input.iteration,
      target: approvedPlanMutationContextDecision.target,
      identifiers: approvedPlanMutationContextDecision.identifiers,
      observedVersion: approvedPlanMutationContextDecision.observedVersion,
      sourceObservationKey: approvedPlanMutationContextDecision.sourceObservationKey,
      targetingReason: approvedPlanMutationContextDecision.targetingReason || "missing_ast",
      nextRequiredCapability: "targeting",
    });
    return finish("continue");
  }
  if (approvedPlanMutationContextDecision.status === "needs_range_read") {
    appendToolResultsToHistory({
      callbacks: input.callbacks,
      toolFeedbackFormat: input.toolFeedbackFormat,
      results: input.results,
      toolArgsByCallId: input.toolArgsByCallId,
      iterationContext: input.iterationContext,
      emitTurnEvent: input.emitTurnEvent,
    });
    executeRecoveryState = activateExecuteRecoveryAndSync(
      "patch_recovery_read",
      "approved_plan_declaration_range_required",
      {
        expectedTarget: approvedPlanMutationContextDecision.target,
        readLease: {
          purpose: approvedPlanMutationContextDecision.rangeSource === "ast_declaration"
            ? "initial_targeting"
            : "plan_line_context",
          target: approvedPlanMutationContextDecision.target,
          requestedRange: approvedPlanMutationContextDecision.requestedRange,
          ...(approvedPlanMutationContextDecision.rangeSource === "plan_line"
            ? { requiredRange: approvedPlanMutationContextDecision.requestedRange, coveredRanges: [] }
            : {}),
          observedVersion: approvedPlanMutationContextDecision.observedVersion,
          coverageMode: approvedPlanMutationContextDecision.rangeSource === "ast_declaration"
            ? "bounded_prefix"
            : "segmented_exact",
          state: "available",
        },
        decisionCheckpoint: {
          expectedTarget: approvedPlanMutationContextDecision.target,
          sourceObservationKey: null,
          nextRequiredCapability: "targeted_read",
          evidenceVersion: approvedPlanMutationContextDecision.observedVersion,
        },
      },
    );
    input.callbacks.appendMessage({
      role: "user",
      content: [
        approvedPlanMutationContextDecision.rangeSource === "ast_declaration"
          ? "SOURCE_RANGE_READ_LEASE: Read the parser-backed declaration range now granted by the runtime. A bounded prefix returned by read_file is valid mutation context when the declaration exceeds the tool envelope."
          : "SOURCE_RANGE_READ_LEASE: Read exactly the reviewed Plan line range now granted by the runtime.",
        `Target: ${approvedPlanMutationContextDecision.target}; lines ${approvedPlanMutationContextDecision.requestedRange.startLine}-${approvedPlanMutationContextDecision.requestedRange.endLine}.`,
        approvedPlanMutationContextDecision.symbolName
          ? `Declaration: ${approvedPlanMutationContextDecision.symbolName}.`
          : "The range comes from the reviewed Plan line anchor.",
        "After the returned source window is bound to the same file version, the transaction switches to mutation-only; do not reopen diagnosis.",
      ].join("\n"),
    });
    logAgentEvent("approved_plan_declaration_range_read_activated", {
      iteration: input.iteration,
      target: approvedPlanMutationContextDecision.target,
      requestedRange: approvedPlanMutationContextDecision.requestedRange,
      observedVersion: approvedPlanMutationContextDecision.observedVersion,
      symbolName: approvedPlanMutationContextDecision.symbolName,
      rangeSource: approvedPlanMutationContextDecision.rangeSource,
    });
    return finish("continue");
  }
  const approvedPlanInitialMutationRead = approvedPlanMutationContextDecision.status === "covered"
    ? approvedPlanMutationContextDecision.result
    : null;
  if (approvedPlanInitialMutationRead?.readFileObservation) {
    appendToolResultsToHistory({
      callbacks: input.callbacks,
      toolFeedbackFormat: input.toolFeedbackFormat,
      results: input.results,
      toolArgsByCallId: input.toolArgsByCallId,
      iterationContext: input.iterationContext,
      emitTurnEvent: input.emitTurnEvent,
    });
    executeRecoveryState = activateExecuteRecoveryAndSync(
      "mutation_first",
      "approved_plan_target_context_observed",
      {
        expectedTarget: approvedPlanInitialMutationRead.target,
        readFileObservation: approvedPlanInitialMutationRead.readFileObservation,
        sourceObservationKey: approvedPlanInitialMutationRead.readFileObservation.key,
        decisionCheckpoint: {
          expectedTarget: approvedPlanInitialMutationRead.target,
          sourceObservationKey: approvedPlanInitialMutationRead.readFileObservation.key,
          nextRequiredCapability: "mutation",
          evidenceVersion: approvedPlanInitialMutationRead.readFileObservation.versionToken,
        },
      },
    );
    logAgentEvent("approved_plan_context_to_mutation", {
      iteration: input.iteration,
      target: approvedPlanInitialMutationRead.target,
      observationKey: approvedPlanInitialMutationRead.readFileObservation.key,
      versionToken: approvedPlanInitialMutationRead.readFileObservation.versionToken,
      requestSignature: approvedPlanInitialMutationRead.readFileObservation.requestSignature,
      executeRecoveryMode: executeRecoveryState.mode,
      nextRequiredCapability: "mutation",
    });
    const language = input.callbacks.getPreferredLanguage();
    input.emitPlanExecutionProgress("running", {
      currentTask: language === "zh" ? "按已批准计划修改目标源码" : "mutating the approved source target",
      currentTool: "apply_patch",
      latestEvidence: approvedPlanInitialMutationRead.target,
      recoveryReason: "approved_plan_target_context_observed",
      nextStep: language === "zh"
        ? "复用已绑定的精确源码窗口执行修改，不再重新诊断"
        : "reuse the bound source observation and perform the mutation without reopening diagnosis",
    });
    input.callbacks.onStatusChange("running");
    input.callbacks.appendMessage({
      role: "user",
      content: "SOURCE_CONTEXT_LOCKED: The approved task now has one exact versioned source observation. Do not read or investigate again. Call exactly one exposed mutation tool for this target and implement the reviewed change.",
    });
    return finish("continue");
  }

  // Codex-style Plan execution is runtime-owned: once every task in the
  // approved revision has fresh trusted evidence, do not spend another model
  // turn asking it to narrate or declare completion.  Persist the current tool
  // results first, then close the execution lease deterministically.
  if (input.workflowMode === "plan" && input.callbacks.getIsPlanApproved()) {
    const baseAudit = buildPlanTaskEvidenceAudit({
      tasks: input.callbacks.getPlanTasks(),
      evidenceLedger: input.callbacks.getPlanExecutionEvidenceLedger(),
      highlightNext: true,
    });
    const validationBoundary = resolveApprovedPlanValidationBoundary({
      audit: baseAudit,
      availableToolNames: input.availableToolNames,
    });
    const audit = validationBoundary === "pause_external_validation"
      ? { ...baseAudit, acceptedCompletion: true }
      : baseAudit;
    const evidenceClosureAudit = buildExecuteEvidenceClosureAudit({
      ledger: input.callbacks.getPlanExecutionEvidenceLedger(),
      // External/user review can remain pending after automation completes, but
      // it cannot substitute for a fresh automatic check after a mutation.
      validationExpected: true,
    });
    if (
      audit.totalCount > 0 &&
      audit.acceptedCompletion &&
      evidenceClosureAudit.completionAllowed &&
      executeRecoveryState.mode === "normal"
    ) {
      appendToolResultsToHistory({
        callbacks: input.callbacks,
        toolFeedbackFormat: input.toolFeedbackFormat,
        results: input.results,
        toolArgsByCallId: input.toolArgsByCallId,
        iterationContext: input.iterationContext,
        emitTurnEvent: input.emitTurnEvent,
      });
      input.emitTaskOrchestratorPhase("DONE", {
        reason: "plan_evidence_complete_after_tool",
        iteration: input.iteration,
        completed: audit.completedCount,
        total: audit.totalCount,
      });
      input.emitPlanExecutionProgress("completed", {
        currentTask: "",
        currentTool: "",
        nextStep: "",
      });
      input.callbacks.onPlanStageChanged("completed");
      logAgentEvent("plan_execution_completed_from_runtime_evidence", {
        iteration: input.iteration,
        completed: audit.completedCount,
        total: audit.totalCount,
        evidenceCount: input.callbacks.getPlanExecutionEvidenceLedger().length,
        modelCompletionClaimRequired: false,
        pendingUserValidation: audit.pendingUserValidationTasks.length,
        evidenceClosureGap: evidenceClosureAudit.gap,
        activeRecoveryMode: executeRecoveryState.mode,
      });
      completionAudit = {
        completedCount: audit.completedCount,
        totalCount: audit.totalCount,
        pendingUserValidationTasks: audit.pendingUserValidationTasks,
      };
      return finish("plan_completed");
    }
  }

  const devServerRuntime = resolveDevServerRuntimeState(
    input.callbacks.getPlanExecutionEvidenceLedger(),
  );
  const devServerEvidenceGap = buildExecuteEvidenceClosureAudit({
    ledger: input.callbacks.getPlanExecutionEvidenceLedger(),
    validationExpected: true,
  }).gap;
  const shouldObservePty =
    devServerRuntime.nextCapability === "observe_pty" &&
    devServerEvidenceGap === "pty_observation_required";
  const shouldBrowserValidate =
    devServerRuntime.nextCapability === "browser" &&
    devServerEvidenceGap === "browser_validation_required";
  const canEnterDevServerEvidenceRecovery =
    executeRecoveryState.mode === "normal" &&
    isMutationRuntimeIntent(input.runtimeIntent) &&
    (input.workflowMode !== "plan" || input.callbacks.getIsPlanApproved());
  if (canEnterDevServerEvidenceRecovery && (shouldObservePty || shouldBrowserValidate)) {
    appendToolResultsToHistory({
      callbacks: input.callbacks,
      toolFeedbackFormat: input.toolFeedbackFormat,
      results: input.results,
      toolArgsByCallId: input.toolArgsByCallId,
      iterationContext: input.iterationContext,
      emitTurnEvent: input.emitTurnEvent,
    });
    const nextCapability = shouldObservePty ? "observe_pty" : "browser_validation";
    executeRecoveryState = activateExecuteRecoveryAndSync(
      "validation_only",
      shouldObservePty
        ? "long_process_pty_observation_required"
        : "ready_server_browser_validation_required",
      {
        nextCapability,
        requestedUrl: devServerRuntime.url,
        foregroundGeneration: devServerRuntime.foregroundGeneration,
        outputSequence: devServerRuntime.outputSequence,
      },
    );
    logAgentEvent("execute_recovery_activated_from_dev_server_evidence", {
      iteration: input.iteration,
      devServerStatus: devServerRuntime.status,
      nextCapability,
      evidenceGap: devServerEvidenceGap,
      requestedUrl: devServerRuntime.url,
      foregroundGeneration: devServerRuntime.foregroundGeneration,
      outputSequence: devServerRuntime.outputSequence,
      executeRecoveryMode: executeRecoveryState.mode,
    });
    const language = input.callbacks.getPreferredLanguage();
    input.emitPlanExecutionProgress("running", {
      currentTask: shouldObservePty
        ? language === "zh" ? "观察开发服务器状态" : "observing dev-server status"
        : language === "zh" ? "执行浏览器交互验收" : "running browser interaction validation",
      currentTool: "",
      latestEvidence: devServerRuntime.url || "",
      recoveryReason: `execution_evidence_gap:${devServerEvidenceGap}`,
      nextStep: shouldObservePty
        ? language === "zh" ? "读取当前 PTY generation 的增量输出或状态" : "read incremental output or status for the current PTY generation"
        : language === "zh" ? "访问 ready URL 并执行动作后断言" : "open the ready URL and run post-action assertions",
    });
    input.callbacks.onStatusChange("running");
    return finish("continue");
  }

  const noProgressRecovery = handleNoProgressRecovery({
    callbacks: input.callbacks,
    activeProfile: input.activeProfile,
    workflowMode: input.workflowMode,
    runtimeIntent: input.runtimeIntent,
    iteration: input.iteration,
    results: input.results,
    recentToolActivity: input.recentToolActivity,
    recentPlanToolActivity: input.recentPlanToolActivity,
    sawExecuteOperationEvidence:
      input.evidenceRuntimeState.sawExecuteOperationEvidence,
    executeRecoveryMode: executeRecoveryState.mode,
    executeRecoveryReason: executeRecoveryState.reason,
    executeRecoveryAttempts: executeRecoveryState.attempts,
    executeRecoverySourceObservationKey: executeRecoveryState.sourceObservationKey,
    repairExecutionRequestInChat: input.repairExecutionRequestInChat,
    latestUserPromptText: input.latestUserPromptText,
    isUnapprovedPlanReadOnlyBatch: input.isUnapprovedPlanReadOnlyBatch,
    planReadOnlyConvergenceBatches: planRuntimeState.planReadOnlyConvergenceBatches,
    planReadOnlyConvergenceTools: planRuntimeState.planReadOnlyConvergenceTools,
    remainingTaskText: input.remainingTaskText,
    approvedPlanNoProgressRecoveryAttempts:
      input.approvedPlanRecoveryState.approvedPlanNoProgressRecoveryAttempts,
    tracking: getNoProgressTrackingRuntimeState(loopGuardRuntimeState),
    activateExecuteRecovery: activateExecuteRecoveryAndSync,
    activateChatFinalSynthesis: input.activateChatFinalSynthesis,
    emitTaskOrchestratorPhase: input.emitTaskOrchestratorPhase,
  });
  loopGuardRuntimeState = applyNoProgressTrackingRuntimeState(
    loopGuardRuntimeState,
    noProgressRecovery.tracking,
  );
  if (noProgressRecovery.status === "stopped") {
    return finish("stopped");
  }
  if (noProgressRecovery.status === "continue") {
    return finish("continue");
  }
  let pendingExecuteRecoveryPrompt = noProgressRecovery.pendingExecuteRecoveryPrompt;
  let pendingExecuteNoProgressPause = noProgressRecovery.pendingExecuteNoProgressPause;
  const approvedPlanNoProgressDecision = noProgressRecovery.approvedPlanNoProgressDecision;

  loopGuardRuntimeState = applyToolFailureSignatureRuntimeState(
    loopGuardRuntimeState,
    {
      results: input.results,
      toolFailureSignatures: input.toolFailureSignatures,
    },
  );

  appendToolResultsToHistory({
    callbacks: input.callbacks,
    toolFeedbackFormat: input.toolFeedbackFormat,
    results: input.results,
    toolArgsByCallId: input.toolArgsByCallId,
    iterationContext: input.iterationContext,
    emitTurnEvent: input.emitTurnEvent,
  });

  const failedFiniteValidation = input.results.find((result) => {
    if (
      result.name !== "run_command" ||
      result.internalFeedback ||
      !(result.isError || !commandResultLooksSuccessful(result.name, result.content || ""))
    ) {
      return false;
    }
    const args = input.toolArgsByCallId.get(result.toolCallId) || {};
    const command = String(args.command || args.cmd || result.target || "").trim();
    return shouldEnterFailedFiniteValidationRecovery(command);
  });
  const failedFiniteValidationCommand = failedFiniteValidation
    ? (() => {
        const args = input.toolArgsByCallId.get(failedFiniteValidation.toolCallId) || {};
        return String(
          args.command || args.cmd || failedFiniteValidation.target || "",
        ).trim();
      })()
    : "";
  const failedFiniteValidationOutcome = failedFiniteValidation
    ? classifyFailedFiniteValidationOutcome({
        result: failedFiniteValidation.content || failedFiniteValidation.displayContent || "",
        isToolError: failedFiniteValidation.isError,
        lifecycleState: failedFiniteValidation.lifecycleState,
      })
    : null;
  const remainingPlanTasksAfterFailedFiniteValidation = failedFiniteValidation &&
    input.workflowMode === "plan" &&
    input.callbacks.getIsPlanApproved()
    ? buildPlanTaskEvidenceAudit({
        tasks: input.callbacks.getPlanTasks(),
        evidenceLedger: input.callbacks.getPlanExecutionEvidenceLedger(),
        preserveMissing: true,
        highlightNext: true,
      }).remainingTasks
    : [];
  if (
    failedFiniteValidation &&
    failedFiniteValidationOutcome === "invocation_error" &&
    input.workflowMode === "plan" &&
    input.callbacks.getIsPlanApproved() &&
    hasPendingPlanCommandEvidence(remainingPlanTasksAfterFailedFiniteValidation)
  ) {
    const command = failedFiniteValidationCommand;
    const recoveryPolicy = resolveFailedFiniteValidationRecoveryPolicy({
      failedCommand: command,
      tasks: remainingPlanTasksAfterFailedFiniteValidation,
    });
    executeRecoveryState = activateExecuteRecoveryAndSync(
      "finite_validation_only",
      "failed_finite_validation_command",
      { command, target: failedFiniteValidation.target || "run_command" },
    );
    const recoveryPrompt = buildFailedFiniteValidationRecoveryPrompt({
      command,
      result: failedFiniteValidation.content || failedFiniteValidation.displayContent || "",
      ...recoveryPolicy,
    });
    logAgentEvent("approved_plan_finite_validation_recovery", {
      iteration: input.iteration,
      command,
      target: failedFiniteValidation.target || "",
      executeRecoveryAttempts: executeRecoveryState.attempts,
    });
    input.emitPlanExecutionProgress("running", {
      currentTool: "run_command",
      recoveryReason: "failed_finite_validation_command",
      nextStep: recoveryPolicy.allowAlternativeCommand
        ? input.callbacks.getPreferredLanguage() === "zh"
          ? "改用与项目运行时匹配的一次性验证命令"
          : "run a different finite validation command compatible with the project runtime"
        : input.callbacks.getPreferredLanguage() === "zh"
          ? `修正调用前提后重新运行计划要求的命令：${recoveryPolicy.requiredCommand}`
          : `correct the invocation prerequisite and rerun the required command: ${recoveryPolicy.requiredCommand}`,
    });
    input.callbacks.onStatusChange("running");
    input.callbacks.appendMessage({ role: "user", content: recoveryPrompt });
    return finish("continue");
  }

  const failedValidationMatchesPendingTask =
    failedFiniteValidation &&
    failedFiniteValidationOutcome === "validation_failure" &&
    failedFiniteValidationMatchesPendingPlanEvidence({
      failedCommand: failedFiniteValidationCommand,
      tasks: remainingPlanTasksAfterFailedFiniteValidation,
    });
  if (
    failedFiniteValidation &&
    failedValidationMatchesPendingTask &&
    input.workflowMode === "plan" &&
    input.callbacks.getIsPlanApproved()
  ) {
    // A validation that actually ran has produced a source/test/config
    // diagnostic. Command-only recovery cannot fix it. Return the next turn to
    // the normal repair surface; the failed command remains negative evidence
    // until that same concrete command succeeds.
    executeRecoveryState = clearExecuteRecoveryRuntimeState(executeRecoveryState);
    const recoveryPrompt = [
      "FINITE_VALIDATION_REPAIR_REQUIRED: The finite validation command executed, but its validation failed.",
      `Failed command: ${failedFiniteValidationCommand}`,
      "MAIN restored the normal read/mutation/validation tool surface. Inspect the structured stdout/stderr/exitCode already returned, repair the implicated source, test, or configuration, then rerun this same command.",
      "Do not substitute an unrelated successful command: this failed validation remains pending Plan evidence until the same concrete command succeeds.",
    ].join("\n");
    logAgentEvent("approved_plan_finite_validation_requires_repair", {
      iteration: input.iteration,
      command: failedFiniteValidationCommand,
      target: failedFiniteValidation.target || "",
      previousRecoveryMode: input.executeRecoveryState.mode,
      nextRecoveryMode: executeRecoveryState.mode,
    });
    input.emitPlanExecutionProgress("running", {
      currentTool: "apply_patch",
      recoveryReason: "failed_finite_validation_requires_repair",
      nextStep: input.callbacks.getPreferredLanguage() === "zh"
        ? "根据命令诊断修复源码、测试或配置，然后重新运行同一验证命令"
        : "repair the diagnosed source, test, or configuration issue, then rerun the same validation command",
    });
    input.callbacks.onStatusChange("running");
    input.callbacks.appendMessage({ role: "user", content: recoveryPrompt });
    return finish("continue");
  }

  const goalCheckpoint = input.callbacks.evaluateGoalToolResultCheckpoint?.(
    input.results,
  );
  if (goalCheckpoint?.complete) {
    logAgentEvent("goal_tool_result_checkpoint_completed", {
      iteration: input.iteration,
      resultCount: input.results.length,
      evidenceCount: goalCheckpoint.evidenceCount,
      supportingEvidenceIds: goalCheckpoint.supportingEvidenceIds,
    });
    return finish("goal_completed");
  }

  const readFileRepeatLimitRecovery = handleReadFileRepeatLimitRecovery({
    callbacks: input.callbacks,
    workflowMode: input.workflowMode,
    runtimeIntent: input.runtimeIntent,
    iteration: input.iteration,
    results: input.results,
    recentPlanToolActivity: input.recentPlanToolActivity,
    recentToolActivity: input.recentToolActivity,
    executeRecoveryAttempts: executeRecoveryState.attempts,
    activateExecuteRecovery: activateExecuteRecoveryAndSync,
    emitTaskOrchestratorPhase: input.emitTaskOrchestratorPhase,
  });
  if (readFileRepeatLimitRecovery.status === "stopped") {
    return finish("stopped");
  }
  if (readFileRepeatLimitRecovery.status === "pending_prompt") {
    pendingExecuteRecoveryPrompt = readFileRepeatLimitRecovery.prompt;
  }

  const crossIterationReadFileRecovery = handleCrossIterationReadFileLoopRecovery({
    callbacks: input.callbacks,
    workflowMode: input.workflowMode,
    runtimeIntent: input.runtimeIntent,
    iteration: input.iteration,
    results: input.results,
    snapshotContextLimit: input.snapshotContextLimit,
    crossIterationFileReads: loopGuardRuntimeState.crossIterationFileReads,
    executeRecoveryMode: executeRecoveryState.mode,
    executeRecoveryReason: executeRecoveryState.reason,
    consecutiveBlockedReadFileInRecoveryCount:
      executeRecoveryState.consecutiveBlockedReadFileCount,
    activateExecuteRecovery: activateExecuteRecoveryAndSync,
  });
  executeRecoveryState = applyCrossIterationReadFileRecoveryState(executeRecoveryState, {
    mode: crossIterationReadFileRecovery.executeRecoveryMode,
    reason: crossIterationReadFileRecovery.executeRecoveryReason,
    consecutiveBlockedReadFileCount:
      crossIterationReadFileRecovery.consecutiveBlockedReadFileInRecoveryCount,
  });

  if (input.unityMcpFallbackPrompt) {
    input.callbacks.appendMessage({
      role: "user",
      content: input.unityMcpFallbackPrompt,
    });
  }

  const repeatedEditValidationRecovery = handleRepeatedEditValidationRecovery({
    callbacks: input.callbacks,
    workflowMode: input.workflowMode,
    runtimeIntent: input.runtimeIntent,
    iteration: input.iteration,
    results: input.results,
    availableToolNames: input.availableToolNames,
    recentToolActivity: input.recentToolActivity,
    successfulEditTargetsSinceVerification:
      loopGuardRuntimeState.successfulEditTargetsSinceVerification,
    repeatedEditValidationRecoveryAttempts:
      executeRecoveryState.repeatedEditValidationAttempts,
    activateExecuteRecovery: activateExecuteRecoveryAndSync,
    emitPlanExecutionProgress: input.emitPlanExecutionProgress,
  });
  executeRecoveryState = setRepeatedEditValidationRecoveryAttempts(
    executeRecoveryState,
    repeatedEditValidationRecovery.repeatedEditValidationRecoveryAttempts,
  );
  if (repeatedEditValidationRecovery.status === "stopped") {
    return finish("stopped");
  }
  if (repeatedEditValidationRecovery.status === "pending_prompt") {
    input.callbacks.appendMessage({
      role: "user",
      content: repeatedEditValidationRecovery.prompt,
    });
    return finish("continue");
  }
  if (pendingExecuteRecoveryPrompt) {
    input.callbacks.onStatusChange("running");
    input.callbacks.appendMessage({
      role: "user",
      content: pendingExecuteRecoveryPrompt,
    });
    return finish("continue");
  }
  if (pendingExecuteNoProgressPause) {
    input.callbacks.onNonActionableStop(
      pendingExecuteNoProgressPause.notice,
      "no_action",
      {
        progressSignature: pendingExecuteNoProgressPause.progressSignature,
        repeatedTargets: pendingExecuteNoProgressPause.repeatedTargets,
        recoveryReason: pendingExecuteNoProgressPause.reason,
        nextStep: input.callbacks.getPreferredLanguage() === "zh"
          ? "复用已读上下文，转向写入/命令/浏览器验证，或说明真实阻塞"
          : "reuse cached context and pivot to patch/run/browser validation, or state the real blocker",
      },
    );
    input.callbacks.onStatusChange("idle");
    return finish("stopped");
  }
  if (pendingPlanRuntimeRecoveryPrompt) {
    input.callbacks.onStatusChange("running");
    input.callbacks.appendMessage({
      role: "user",
      content: pendingPlanRuntimeRecoveryPrompt,
    });
    return finish("continue");
  }

  if (approvedPlanNoProgressDecision) {
    if (approvedPlanNoProgressDecision.action === "recover") {
      approvedPlanRecoveryState = input.continueApprovedPlanWithStrategySwitch(
        approvedPlanNoProgressDecision,
      );
      return finish("continue");
    }
    input.pauseApprovedPlanNoProgressLoop(approvedPlanNoProgressDecision);
    return finish("stopped");
  }

  const planReadOnlyConvergence = handlePlanReadOnlyConvergence({
    callbacks: input.callbacks,
    iteration: input.iteration,
    isUnapprovedPlanReadOnlyBatch: input.isUnapprovedPlanReadOnlyBatch,
    hasPlanDecisionOutput: input.hasPlanDecisionOutput,
    successfulReadOnlyExplorationResultCount:
      input.successfulReadOnlyExplorationResultCount,
    planReadOnlyConvergenceBatches: planRuntimeState.planReadOnlyConvergenceBatches,
    planReadOnlyConvergenceTools: planRuntimeState.planReadOnlyConvergenceTools,
    usedPlanReadOnlyConvergencePrompt:
      planRuntimeState.usedPlanReadOnlyConvergencePrompt,
    planEvidenceRecoveryObjective:
      planRuntimeState.planEvidenceRecoveryObjective,
    planRuntimePhase: planRuntimeState.planRuntimePhase,
    turnInputContextSignals: input.turnInputContextSignals,
    recentPlanToolActivity: input.recentPlanToolActivity,
    lastAssistantTextForCheckpoint:
      input.evidenceRuntimeState.lastAssistantTextForCheckpoint,
    setPlanRuntimePhase: setPlanRuntimePhaseAndSync,
  });
  planRuntimeState = applyPlanReadOnlyConvergenceRuntimeState(
    planRuntimeState,
    planReadOnlyConvergence,
  );
  if (planReadOnlyConvergence.status === "continue") {
    return finish("continue");
  }

  if (shouldPauseForReviewablePlanArtifactAfterToolResults({
    workflowMode: input.workflowMode,
    isPlanApproved: input.callbacks.getIsPlanApproved(),
    planArtifactQualityRejected: planRuntimeState.planArtifactQualityRejected,
    results: input.results,
  })) {
    const currentStage = input.callbacks.getPlanStage();
    if (isReviewablePlanStage(currentStage)) {
      const reviewResult = await input.pauseForReviewablePlanArtifact(
        "post_tool_plan_artifact_write",
        {
          // The outer loop folds this phase only after it returns. Use the
          // current batch's already-folded quality state so an accepted
          // rewrite can enter review immediately instead of seeing stale true.
          planArtifactQualityRejected: planRuntimeState.planArtifactQualityRejected,
        },
      );
      if (reviewResult === "approved_continue") return finish("continue");
      if (reviewResult === "stopped") return finish("stopped");
    } else {
      logAgentEvent("plan_artifact_write_not_reviewable_after_tool", {
        iteration: input.iteration,
        planStage: currentStage,
        targets: input.results
          .filter(isSuccessfulPlanArtifactWriteResult)
          .map((result) => result.target)
          .slice(0, 6),
      });
    }
  }

  if (
    input.workflowMode === "plan" &&
    input.callbacks.getIsPlanApproved() &&
    input.results.some((result) => !result.isError)
  ) {
    input.callbacks.onPlanStageChanged("executing");
  }

  if (input.workflowMode === "plan" && input.callbacks.getIsPlanApproved()) {
    if (input.results.some((result) => result.isError)) {
      input.emitPlanExecutionProgress("tool_error");
    } else if (input.results.some((result) => !result.isError)) {
      input.emitPlanExecutionProgress("tool_done");
    }
  }

  const strictRepeatGuardRecovery = handleStrictRepeatGuardRecovery({
    callbacks: input.callbacks,
    workspace: input.workspace,
    workflowMode: input.workflowMode,
    runtimeIntent: input.runtimeIntent,
    iteration: input.iteration,
    effectiveToolCalls: input.effectiveToolCalls,
    recentToolCalls: loopGuardRuntimeState.recentToolCalls,
    repeatGuardRecoveredSignatures:
      loopGuardRuntimeState.repeatGuardRecoveredSignatures,
    failedToolCallCounts: loopGuardRuntimeState.failedToolCallCounts,
    recentPlanToolActivity: input.recentPlanToolActivity,
    availableToolNames: input.availableToolNames,
    toolCapabilityRegistry: input.toolCapabilityRegistry,
    toolPermissionPolicy: input.toolPermissionPolicy,
    emitTurnFailedEvent: input.emitTurnFailedEvent,
  });
  if (strictRepeatGuardRecovery.status === "stopped") {
    return finish("stopped");
  }
  if (strictRepeatGuardRecovery.status === "continue") {
    return finish("continue");
  }

  const targetProgressLoopRecovery = handleTargetProgressLoopRecovery({
    callbacks: input.callbacks,
    workspace: input.workspace,
    workflowMode: input.workflowMode,
    runtimeIntent: input.runtimeIntent,
    results: input.results,
    effectiveToolCalls: input.effectiveToolCalls,
    recentTargetToolCalls: loopGuardRuntimeState.recentTargetToolCalls,
    targetProgressGuardRecoveredSignatures:
      loopGuardRuntimeState.targetProgressGuardRecoveredSignatures,
    recentToolActivity: input.recentToolActivity,
    executeRecoveryAttempts: executeRecoveryState.attempts,
    activateExecuteRecovery: activateExecuteRecoveryAndSync,
  });
  if (targetProgressLoopRecovery.status === "stopped") {
    return finish("stopped");
  }
  if (targetProgressLoopRecovery.status === "continue") {
    return finish("continue");
  }

  const executeConvergencePrompt = handleExecuteConvergencePrompt({
    callbacks: input.callbacks,
    workflowMode: input.workflowMode,
    runtimeIntent: input.runtimeIntent,
    iteration: input.iteration,
    effectiveMaxIterations: input.effectiveMaxIterations,
    usedExecuteConvergencePrompt: recoveryPromptState.usedExecuteConvergencePrompt,
    recentToolActivity: input.recentToolActivity,
    executeRecoveryMode: executeRecoveryState.mode,
    activateExecuteRecovery: activateExecuteRecoveryAndSync,
  });
  recoveryPromptState = applyExecuteConvergencePromptState(
    recoveryPromptState,
    executeConvergencePrompt,
  );

  logAgentEvent("post_tool_result_continuation", {
    stage: "loop_continue",
    iteration: input.iteration,
    nextIteration: input.iteration + 1,
    pendingExecuteRecovery: !!pendingExecuteRecoveryPrompt,
    pendingPlanRecovery: !!pendingPlanRuntimeRecoveryPrompt,
    usedExecuteConvergencePrompt: recoveryPromptState.usedExecuteConvergencePrompt,
    repeatedEditTargets: Array.from(
      loopGuardRuntimeState.successfulEditTargetsSinceVerification.entries(),
    ).slice(-6),
    runtimeIntent: input.runtimeIntent,
    workflowMode: input.workflowMode,
    planApproved: input.callbacks.getIsPlanApproved(),
  });

  return finish("completed");

  function finish(
    status: ToolResultRecoveryPhaseResult["status"],
  ): ToolResultRecoveryPhaseResult {
    return {
      status,
      planRuntimeState,
      loopGuardRuntimeState,
      executeRecoveryState,
      recoveryPromptState,
      approvedPlanRecoveryState,
      ...(completionAudit ? { completionAudit } : {}),
    };
  }
}
