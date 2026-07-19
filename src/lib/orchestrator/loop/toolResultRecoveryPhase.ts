import {
  buildFailedValidationRepairReadLease,
  buildFailedFiniteValidationRecoveryPrompt,
  classifyFailedFiniteValidationOutcome,
  failedFiniteValidationMatchesPendingPlanEvidence,
  hasPendingPlanCommandEvidence,
  resolveFailedFiniteValidationRecoveryPolicy,
  requestedRangeFromReadObservationSignature,
  shouldEnterFailedFiniteValidationRecovery,
} from "../../executeRecoveryTools";
import { buildApprovedPlanScopeConflictFingerprint } from "../../approvedPlanExecutionScope";
import {
  buildBrowserValidationCacheSignature,
  resolvePersistentBrowserFailureCallSignature,
  parseBrowserValidationRecord,
  parseBrowserValidationOutcome,
} from "../../browserValidation";
import { resolveDevServerRuntimeState } from "../../devServerRuntime";
import {
  isReviewablePlanStage,
  isProjectSourceWriteResult,
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
import { getShellToolCwd } from "../../toolExecutionContract";
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
  isPlanTaskSourceMutationObligation,
  planTaskHasUnsatisfiedSourceMutationEvidence,
} from "../../workflowModels";
import {
  buildExecuteEvidenceClosureAudit,
  resolveLatestUnreconciledFailureSignal,
  resolveCommandEvidenceRequirements,
  scopeExecutionEvidenceLedger,
} from "../../verificationEvidence";
import {
  isAbsoluteWorkspacePath,
  relativizeToWorkspacePath,
  workspacePathsReferToSameFile,
} from "../../workspacePaths";
import { isWorkspaceMutationToolName } from "../../workspaceMutationTools";
import type { OrchestratorCallbacks, ToolCallToExecute, ToolExecutionResult } from "../types";
import {
  handleExecuteConvergencePrompt,
  handleNoProgressRecovery,
  handleStrictRepeatGuardRecovery,
  handleTargetProgressLoopRecovery,
} from "./loopRecovery";
import type { ExecuteRecoveryRuntimeState } from "./executeRecoveryRuntime";
import { resolvePtyObservationPolicyDeferral } from "./executeRecoveryRuntime";
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
  resetLoopGuardRuntimeStateAfterMutation,
} from "./loopGuardRuntimeState";
import type { AgentLoopRecoveryPromptRuntimeState } from "./recoveryPromptRuntimeState";
import { applyExecuteConvergencePromptState } from "./recoveryPromptRuntimeState";
import type { AgentLoopEvidenceRuntimeState } from "./evidenceRuntimeState";
import {
  handlePlanQualityRecoveryAfterToolResults,
  shouldPauseForReviewablePlanArtifactAfterToolResults,
} from "./planQualityRecovery";
import { handlePlanReadOnlyConvergence } from "./planConvergence";
import { appendToolResultsToHistory } from "./toolResultHistory";
import {
  joinPendingSubagentsForParent,
  shouldJoinPendingSubagentsAfterScopeDeferral,
} from "./subagentJoinRuntime";
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

function normalizeBrowserDiagnosticToken(value: unknown): string {
  return String(value || "")
    .replace(/\s+/g, " ")
    .replace(/^[`'\"]+|[`'\"]+$/g, "")
    .trim()
    .slice(0, 240);
}

function parseDesktopControlRecord(value: string): Record<string, unknown> | null {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const candidates = [raw];
  const markerMatches = [...raw.matchAll(/DESKTOP_(?:VALIDATION|CONTROL)_FAILED:/gi)];
  const markerMatch = markerMatches[markerMatches.length - 1];
  if (markerMatch?.index !== undefined) {
    const payloadStart = raw.indexOf("\n", markerMatch.index + markerMatch[0].length);
    if (payloadStart >= 0) candidates.unshift(raw.slice(payloadStart + 1).trim());
  }
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // A failed tool result can include a user-facing prefix before the exact
      // adapter JSON. Only the structured payload is authoritative here.
    }
  }
  return null;
}

function extractFailedBrowserLocator(
  args: Record<string, unknown>,
  detail: string,
): string | null {
  const actions = Array.isArray(args.actions)
    ? args.actions
    : typeof args.actions === "string"
    ? args.actions.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    : [];
  for (const action of actions) {
    const actionText = typeof action === "string"
      ? action
      : action && typeof action === "object"
        ? JSON.stringify(action)
        : "";
    const match = actionText.match(/(?:click|fill|press|select_file|wait_for_selector)\s*[:=]\s*([^\n,;}]+)/i) ||
      actionText.match(/"(?:selector|locator|target)"\s*:\s*"([^"]+)"/i);
    const locator = normalizeBrowserDiagnosticToken(match?.[1]);
    if (locator) return locator;
  }
  const detailMatch = detail.match(/(?:locator|selector)\s*(?:not found|missing|failed|timed out)?\s*[:=]?\s*[`'\"]([^`'\"]+)[`'\"]/i) ||
    detail.match(/(?:click|fill|wait_for_selector)\s*[:=]\s*([^\s,;}]+)/i);
  return normalizeBrowserDiagnosticToken(detailMatch?.[1]) || null;
}

function collectBrowserLocatorCandidates(record: Record<string, unknown> | null): string[] {
  if (!record) return [];
  const candidates = new Set<string>();
  const visit = (value: unknown, key = "", depth = 0) => {
    if (depth > 5 || candidates.size >= 24 || value == null) return;
    if (Array.isArray(value)) {
      value.slice(0, 80).forEach((item) => visit(item, key, depth + 1));
      return;
    }
    if (typeof value !== "object") {
      const text = normalizeBrowserDiagnosticToken(value);
      if (!text || text.length < 2 || text.length > 120) return;
      if (/^(?:selector|locator|css)$/i.test(key)) candidates.add(text);
      else if (/^id$/i.test(key)) candidates.add(text.startsWith("#") ? text : `#${text}`);
      else if (/^(?:text|label|name|ariaLabel|visibleText)$/i.test(key)) candidates.add(text);
      return;
    }
    for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
      if (
        depth === 0 &&
        !/(?:interactive|locator|element|control|candidate|dom|inventory)/i.test(childKey)
      ) continue;
      visit(childValue, childKey, depth + 1);
    }
  };
  visit(record);
  return [...candidates];
}

function buildStableBrowserFailureFingerprint(input: {
  args: Record<string, unknown>;
  failureType: string;
  failureReasons: string[];
  failureDetail: string;
}): string {
  const failureClass = [
    input.failureType,
    ...input.failureReasons,
    input.failureDetail
      .toLowerCase()
      .replace(/\b\d+(?:\.\d+)?\s*(?:ms|s|seconds?)\b/g, "<time>")
      .replace(/\b\d+\b/g, "#")
      .replace(/\s+/g, " ")
      .slice(0, 320),
  ].filter(Boolean).join(":");
  return `${buildBrowserValidationCacheSignature(input.args)}::${failureClass}`;
}

function browserDiagnosticTerms(checkpoint: ExecuteRecoveryRuntimeState["decisionCheckpoint"]): string[] {
  return [
    checkpoint?.browserFailedLocator || "",
    ...(checkpoint?.browserLocatorCandidates || []),
  ]
    .map((value) => normalizeBrowserDiagnosticToken(value).toLowerCase())
    .flatMap((value) => value ? [value, value.replace(/^[#.]/, "")] : [])
    .filter((value, index, values) => value.length >= 2 && values.indexOf(value) === index);
}

function browserDiagnosticAttributionTerms(
  checkpoint: ExecuteRecoveryRuntimeState["decisionCheckpoint"],
): string[] {
  const terms = browserDiagnosticTerms(checkpoint);
  const structural = terms.filter((term) =>
    /^(?:#|\.|\[)/.test(term) || /(?:data-|aria-|[_-])/.test(term)
  );
  // Visible text can exist in an initial document/title and is not causal proof
  // of the failed control when the DOM inventory already supplied a structural
  // selector. Use labels only as a bounded fallback when no selector exists.
  return structural.length > 0 ? structural : terms;
}

function queryMatchesBrowserDiagnostic(
  query: string,
  checkpoint: ExecuteRecoveryRuntimeState["decisionCheckpoint"],
): boolean {
  const normalized = normalizeBrowserDiagnosticToken(query).toLowerCase();
  const plain = normalized.replace(/^[#.]/, "");
  if (!normalized || plain.length < 2) return false;
  return browserDiagnosticAttributionTerms(checkpoint).some((term) =>
    term === normalized || term === plain || term.replace(/^[#.]/, "") === plain
  );
}

function sourcePathsFromGrepResult(content: string, workspace: string): string[] {
  const paths = String(content || "").split(/\r?\n/).flatMap((line) => {
    const match = line.match(/^(.+?):\d+:/);
    if (!match) return [];
    const path = relativizeToWorkspacePath(match[1].trim(), workspace)
      .replace(/^\.\//, "")
      .trim();
    return path && path !== "." ? [path] : [];
  });
  return [...new Set(paths)];
}

type ActivateExecuteRecovery = (
  mode: Exclude<ExecuteRecoveryRuntimeState["mode"], "normal">,
  reason: string,
  context?: Record<string, unknown>,
) => ExecuteRecoveryRuntimeState;

type ActivateChatFinalSynthesis = (
  reason: string,
  context?: Record<string, unknown>,
) => void;

const APPROVED_PLAN_SCOPE_BLOCKED_RE = /\bAPPROVED_PLAN_SCOPE_BLOCKED\b/;

function isDirectFileModifyExecution(input: {
  callbacks: OrchestratorCallbacks;
  workflowMode: WorkflowMode;
  runtimeIntent: ResolvedUserIntent;
}): boolean {
  return input.workflowMode === "edit" &&
    isMutationRuntimeIntent(input.runtimeIntent) &&
    !input.callbacks.getIsPlanApproved() &&
    input.callbacks.getCommandDirective?.()?.kind === "file_modify";
}

function structuredCommandDiagnosticText(result: ToolExecutionResult): string {
  const raw = String(result.content || result.displayContent || "");
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return raw;
    return [parsed.stderr, parsed.stdout]
      .filter((value): value is string => typeof value === "string" && !!value.trim())
      .join("\n");
  } catch {
    return raw;
  }
}

function normalizeDiagnosticWorkspacePath(input: {
  path: string;
  cwd: string;
  workspace: string;
}): string | null {
  let candidate = String(input.path || "")
    .trim()
    .replace(/^[`'"(]+|[`'"),]+$/g, "")
    .replace(/\\/g, "/");
  if (!candidate) return null;
  if (isAbsoluteWorkspacePath(candidate)) {
    candidate = relativizeToWorkspacePath(candidate, input.workspace);
    if (isAbsoluteWorkspacePath(candidate)) return null;
  } else {
    const cwd = String(input.cwd || ".")
      .replace(/\\/g, "/")
      .replace(/^\.\//, "")
      .replace(/\/+$/, "");
    candidate = candidate.replace(/^\.\//, "");
    if (cwd && cwd !== "." && !candidate.startsWith(`${cwd}/`)) {
      candidate = `${cwd}/${candidate}`;
    }
  }
  const normalizedParts: string[] = [];
  for (const part of candidate.split("/").filter(Boolean)) {
    if (part === ".") continue;
    if (part === "..") return null;
    normalizedParts.push(part);
  }
  return normalizedParts.join("/") || null;
}

function resolveFiniteValidationRepairTarget(input: {
  result: ToolExecutionResult;
  args: Record<string, unknown>;
  workspace: string;
  recentToolActivity: PlanToolActivitySummary[];
  fallbackTarget?: string | null;
}): string | null {
  const diagnosticText = structuredCommandDiagnosticText(input.result)
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "");
  const pathPatterns = [
    /(?:^|\n)\s*(?:-->|:::)\s+(.+?):\d+:\d+/gm,
    /(?:^|\n)\s*([^\n()]+\.[A-Za-z0-9]+)\(\d+,\d+\)\s*:/gm,
    /(?:^|\n)\s*([^\n:]+\.[A-Za-z0-9]+):\d+:\d+/gm,
  ];
  const cwd = getShellToolCwd(input.args);
  for (const pattern of pathPatterns) {
    for (const match of diagnosticText.matchAll(pattern)) {
      const target = normalizeDiagnosticWorkspacePath({
        path: match[1] || "",
        cwd,
        workspace: input.workspace,
      });
      if (target) return target;
    }
  }
  const latestMutationTarget = [...input.recentToolActivity].reverse().find((activity) =>
    activity.status === "succeeded" &&
    isWorkspaceMutationToolName(activity.name) &&
    !!String(activity.target || "").trim()
  )?.target;
  return String(latestMutationTarget || input.fallbackTarget || "").trim() || null;
}

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
  requestedRange: { startLine?: number; endLine?: number; maxLines?: number } | null;
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
      : null,
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
      completionAudit?: ApprovedPlanCompletionAudit;
    }
  | {
      status: "completed";
      planRuntimeState: PlanLoopRuntimeState;
      loopGuardRuntimeState: AgentLoopGuardRuntimeState;
      executeRecoveryState: ExecuteRecoveryRuntimeState;
      recoveryPromptState: AgentLoopRecoveryPromptRuntimeState;
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
  recoveryPromptState: AgentLoopRecoveryPromptRuntimeState;
  evidenceRuntimeState: AgentLoopEvidenceRuntimeState;
  iterationContext: Pick<TurnIterationContext, "eventThreadId" | "eventTurnId" | "turnContext">;
  emitTurnEvent: (event: MainThreadEventInput) => void;
  emitTurnFailedEvent: (message: string) => void;
  emitTaskOrchestratorPhase: EmitTaskOrchestratorPhase;
  emitPlanExecutionProgress: EmitPlanExecutionProgress;
  activateExecuteRecovery: ActivateExecuteRecovery;
  activateChatFinalSynthesis: ActivateChatFinalSynthesis;
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

  // An active child owns this exact source scope. Close the parent's deferred
  // tool call in protocol history, then join the child deterministically
  // before any generic no-progress or failure accounting can run. Relying on
  // the model to interpret the policy message and call wait_subagents caused
  // repeated parent reads against the same lease and wasted whole iterations.
  if (shouldJoinPendingSubagentsAfterScopeDeferral(input.results)) {
    appendToolResultsToHistory({
      callbacks: input.callbacks,
      toolFeedbackFormat: input.toolFeedbackFormat,
      results: input.results,
      toolArgsByCallId: input.toolArgsByCallId,
      iterationContext: input.iterationContext,
      emitTurnEvent: input.emitTurnEvent,
    });
    const joined = await joinPendingSubagentsForParent({
      callbacks: input.callbacks,
      recentToolActivity: input.recentToolActivity,
      recentPlanToolActivity: input.recentPlanToolActivity,
      reason: "scope_conflict",
    });
    logAgentEvent("parent_scope_conflict_join_completed", {
      iteration: input.iteration,
      joined,
      pendingSubagentIds: input.callbacks.getPendingSubagentIds?.() || [],
      deferredTargets: input.results
        .filter((result) => result.qualityGateReason === "subagent_scope_policy_deferred")
        .map((result) => result.target)
        .filter(Boolean),
      failureKind: "policy",
    });
    input.callbacks.onStatusChange("running");
    return finish("continue");
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
        ...(parentSourceRereadRequirement.requestedRange
          ? { requestedRange: parentSourceRereadRequirement.requestedRange }
          : {}),
        observedVersion: parentSourceRereadRequirement.observedVersion,
        sourceObservationKey: parentSourceRereadRequirement.sourceObservationKey,
      },
    );
    input.callbacks.appendMessage({
      role: "user",
      content: `PARENT_SOURCE_READ_LEASE: Read ${parentSourceRereadRequirement.target}${parentSourceRereadRequirement.requestedRange ? " in the delegated range" : " with the ordinary bounded file window"}, then continue with the pending parent mutation. Do not reopen broad investigation.`,
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
    return finish("continue");
  }

  // Codex-style Plan execution is runtime-owned: once every task in the
  // approved revision has fresh trusted evidence, do not spend another model
  // turn asking it to narrate or declare completion.  Persist the current tool
  // results first, then close the execution lease deterministically.
  if (input.callbacks.getIsPlanApproved()) {
    const planTasks = input.callbacks.getPlanTasks();
    const baseAudit = buildPlanTaskEvidenceAudit({
      tasks: planTasks,
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
      mutationExpected: planTasks.some(isPlanTaskSourceMutationObligation),
      transactionId: input.iterationContext.eventTurnId,
      requiredCommandEvidence: resolveCommandEvidenceRequirements({
        tasks: planTasks,
        commandDirective: input.callbacks.getCommandDirective?.() || null,
      }),
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
    scopeExecutionEvidenceLedger(
      input.callbacks.getPlanExecutionEvidenceLedger(),
      input.iterationContext.eventTurnId,
    ),
  );
  const devServerEvidenceGap = buildExecuteEvidenceClosureAudit({
    ledger: input.callbacks.getPlanExecutionEvidenceLedger(),
    validationExpected: true,
    transactionId: input.iterationContext.eventTurnId,
  }).gap;
  const shouldObservePty =
    devServerRuntime.nextCapability === "observe_pty" &&
    devServerEvidenceGap === "pty_observation_required";
  const shouldBrowserValidate =
    devServerRuntime.nextCapability === "browser" &&
    devServerEvidenceGap === "browser_validation_required";
  const devServerRecoveryCapability = shouldObservePty
    ? "observe_pty"
    : shouldBrowserValidate
    ? "browser_validation"
    : null;
  const currentRecoveryCapability =
    executeRecoveryState.decisionCheckpoint?.nextRequiredCapability || null;
  const canEnterDevServerEvidenceRecovery =
    Boolean(
      devServerRecoveryCapability &&
      (
        executeRecoveryState.mode === "normal" ||
        currentRecoveryCapability !== devServerRecoveryCapability
      )
    ) &&
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
    const nextCapability = devServerRecoveryCapability as
      | "observe_pty"
      | "browser_validation";
    executeRecoveryState = activateExecuteRecoveryAndSync(
      "validation_only",
      shouldObservePty
        ? "long_process_pty_observation_required"
        : "ready_server_browser_validation_required",
      {
        decisionCheckpoint: {
          expectedTarget: executeRecoveryState.expectedTarget,
          sourceObservationKey: executeRecoveryState.sourceObservationKey,
          nextRequiredCapability: nextCapability,
          ...(executeRecoveryState.decisionCheckpoint?.planTaskId
            ? { planTaskId: executeRecoveryState.decisionCheckpoint.planTaskId }
            : {}),
          ...(executeRecoveryState.decisionCheckpoint?.requirementRef
            ? { requirementRef: executeRecoveryState.decisionCheckpoint.requirementRef }
            : {}),
        },
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
    executeRecoveryState,
    executeRecoverySourceObservationKey: executeRecoveryState.sourceObservationKey,
    repairExecutionRequestInChat: input.repairExecutionRequestInChat,
    latestUserPromptText: input.latestUserPromptText,
    isUnapprovedPlanReadOnlyBatch: input.isUnapprovedPlanReadOnlyBatch,
    planReadOnlyConvergenceBatches: planRuntimeState.planReadOnlyConvergenceBatches,
    planReadOnlyConvergenceTools: planRuntimeState.planReadOnlyConvergenceTools,
    remainingTaskText: input.remainingTaskText,
    availableToolNames: input.availableToolNames,
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

  loopGuardRuntimeState = applyToolFailureSignatureRuntimeState(
    loopGuardRuntimeState,
    {
      results: input.results,
      toolFailureSignatures: input.toolFailureSignatures,
    },
  );
  const durableStructuredMutation = input.results.find((result) =>
    !result.internalFeedback && isProjectSourceWriteResult(result)
  );
  if (durableStructuredMutation) {
    loopGuardRuntimeState = resetLoopGuardRuntimeStateAfterMutation(
      loopGuardRuntimeState,
    );
    logAgentEvent("loop_guard_progress_epoch_reset", {
      iteration: input.iteration,
      tool: durableStructuredMutation.name,
      target: durableStructuredMutation.target,
      reason: "durable_structured_mutation",
    });
  }

  appendToolResultsToHistory({
    callbacks: input.callbacks,
    toolFeedbackFormat: input.toolFeedbackFormat,
    results: input.results,
    toolArgsByCallId: input.toolArgsByCallId,
    iterationContext: input.iterationContext,
    emitTurnEvent: input.emitTurnEvent,
  });

  const failedDesktopControl = input.results.find((result) =>
    result.name === "computer_use" && !result.internalFeedback && result.isError
  );
  if (failedDesktopControl) {
    const desktopRecord = parseDesktopControlRecord(
      failedDesktopControl.content || failedDesktopControl.displayContent || "",
    );
    const failureType = normalizeBrowserDiagnosticToken(
      desktopRecord?.failureType || desktopRecord?.failure_type,
    ).toLowerCase();
    if (["permission_required", "unsupported_platform", "automation_unavailable"].includes(failureType)) {
      const language = input.callbacks.getPreferredLanguage();
      const detail = normalizeBrowserDiagnosticToken(
        desktopRecord?.failureSummary || desktopRecord?.failure_summary || desktopRecord?.error,
      ) || (language === "zh" ? "桌面自动化环境当前不可用。" : "Desktop automation is currently unavailable.");
      const permissionRequired = failureType === "permission_required";
      const nextStep = permissionRequired
        ? language === "zh"
          ? "在 macOS“系统设置 → 隐私与安全性 → 辅助功能”和“自动化”中允许 MAIN，然后从当前检查点恢复；MAIN 不会在权限未变化时自动重试。"
          : "Allow MAIN under macOS System Settings > Privacy & Security > Accessibility and Automation, then resume this checkpoint; MAIN will not retry while permission is unchanged."
        : language === "zh"
          ? "保留现有源码与命令证据；在支持 macOS Accessibility 的 MAIN 桌面运行环境中恢复，或把这项真实桌面验收作为明确的人工检查。"
          : "Keep the existing source and command evidence; resume in a MAIN desktop runtime with macOS Accessibility support, or treat this as an explicit manual desktop check.";
      const notice = language === "zh"
        ? [
            "桌面控制已暂停，本次调用不会自动重试。",
            `- 应用：${failedDesktopControl.target || "未识别"}`,
            `- 原因：${detail}`,
            `- 下一步：${nextStep}`,
          ].join("\n")
        : [
            "Desktop control paused and this call will not be retried automatically.",
            `- App: ${failedDesktopControl.target || "unknown"}`,
            `- Reason: ${detail}`,
            `- Next: ${nextStep}`,
          ].join("\n");
      const recoveryReason = `desktop_control_${failureType}`;
      logAgentEvent("desktop_control_environment_blocked", {
        iteration: input.iteration,
        target: failedDesktopControl.target,
        failureType,
        detail: detail.slice(0, 600),
        recoveryReason,
      });
      input.emitPlanExecutionProgress("paused", {
        currentTask: language === "zh" ? "等待桌面控制环境可用" : "waiting for desktop control availability",
        currentTool: "computer_use",
        latestEvidence: detail,
        recoveryReason,
        nextStep,
      });
      input.callbacks.onNonActionableStop(notice, "no_action", {
        phase: "paused",
        currentTask: language === "zh" ? "桌面控制环境阻塞" : "desktop control environment blocked",
        currentTool: "computer_use",
        latestEvidence: detail,
        recoveryReason,
        nextStep,
        repeatedTargets: failedDesktopControl.target ? [failedDesktopControl.target] : [],
      });
      input.callbacks.onStatusChange("idle");
      return finish("stopped");
    }
  }

  const browserDiagnosticCheckpoint =
    executeRecoveryState.decisionCheckpoint?.nextRequiredCapability === "browser_diagnostic"
      ? executeRecoveryState.decisionCheckpoint
      : null;
  if (browserDiagnosticCheckpoint) {
    const attributedRead = input.results.find((result) => {
      if (
        result.name !== "read_file" ||
        result.isError ||
        result.internalFeedback ||
        !result.readFileObservation ||
        result.readFileObservation.source === "stub"
      ) return false;
      const content = String(result.content || result.displayContent || "").toLowerCase();
      return browserDiagnosticAttributionTerms(browserDiagnosticCheckpoint).some((term) =>
        content.includes(term.replace(/^[#.]/, ""))
      );
    });
    const attributedGrep = input.results.find((result) => {
      if (result.name !== "grep_search" || result.isError || result.internalFeedback) return false;
      const args = input.toolArgsByCallId.get(result.toolCallId) || {};
      const query = String(args.query || args.pattern || "").trim();
      return queryMatchesBrowserDiagnostic(query, browserDiagnosticCheckpoint) &&
        sourcePathsFromGrepResult(result.content || result.displayContent || "", input.workspace).length === 1;
    });
    const attributedTarget = attributedRead?.target || (
      attributedGrep
        ? sourcePathsFromGrepResult(
            attributedGrep.content || attributedGrep.displayContent || "",
            input.workspace,
          )[0]
        : ""
    );
    if (attributedTarget) {
      const sourceObservationKey = attributedRead?.readFileObservation?.key || null;
      const needsRead = !sourceObservationKey;
      const readLease = needsRead
        ? buildFailedValidationRepairReadLease({ target: attributedTarget })
        : null;
      executeRecoveryState = activateExecuteRecoveryAndSync(
        needsRead ? "patch_recovery_read" : "mutation_first",
        "browser_diagnostic_source_attributed",
        {
          expectedTarget: attributedTarget,
          readLease,
          sourceObservationKey,
          decisionCheckpoint: {
            ...browserDiagnosticCheckpoint,
            expectedTarget: attributedTarget,
            sourceObservationKey,
            nextRequiredCapability: needsRead ? "targeted_read" : "mutation",
          },
          requestedUrl: browserDiagnosticCheckpoint.browserRequestedUrl,
        },
      );
      logAgentEvent("browser_diagnostic_source_attributed", {
        iteration: input.iteration,
        target: attributedTarget,
        evidenceTool: attributedRead?.name || attributedGrep?.name,
        needsRead,
        browserFailureFingerprint: browserDiagnosticCheckpoint.browserFailureFingerprint || null,
      });
      input.emitPlanExecutionProgress("running", {
        currentTask: input.callbacks.getPreferredLanguage() === "zh"
          ? "按浏览器诊断定位源码"
          : "attributing browser diagnostics to source",
        currentTool: needsRead ? "read_file" : "apply_patch",
        latestEvidence: browserDiagnosticCheckpoint.browserFailureDetail || "",
        recoveryReason: "browser_diagnostic_source_attributed",
        nextStep: input.callbacks.getPreferredLanguage() === "zh"
          ? needsRead
            ? `读取搜索证据唯一指向的 ${attributedTarget}，确认当前版本后再决定是否修改`
            : `诊断词已在 ${attributedTarget} 的当前源码中确认；仅修复该因果问题并重新执行原浏览器验收`
          : needsRead
            ? `read ${attributedTarget}, the unique source named by diagnostic search evidence, before deciding whether to mutate`
            : `the diagnostic term is confirmed in current ${attributedTarget}; repair only that causal issue and rerun the original browser validation`,
      });
      input.callbacks.onStatusChange("running");
      input.callbacks.appendMessage({
        role: "user",
        content: [
          "BROWSER_DIAGNOSTIC_SOURCE_ATTRIBUTED: A locator/label returned by the browser diagnostic is now tied to exactly one source file.",
          `Attributed source: ${attributedTarget}`,
          needsRead
            ? `Read the current ${attributedTarget} under the granted lease before deciding whether source repair is actually needed.`
            : `The current source observation is bound. Repair only the browser-observed causal mismatch if needed.`,
          `Then rerun the original browser interaction at ${browserDiagnosticCheckpoint.browserRequestedUrl || "the retained browser URL"}; do not substitute a non-causal pre-existing text assertion.`,
        ].join("\n"),
      });
      return finish("continue");
    }
  }

  const failedBrowserValidation = input.results.find((result) => {
    if (result.name !== "browser_evaluate" || result.internalFeedback) return false;
    const outcome = parseBrowserValidationOutcome(result.content || "");
    return result.isError || outcome?.ok === false;
  });
  if (failedBrowserValidation) {
    const outcome = parseBrowserValidationOutcome(failedBrowserValidation.content || "");
    const rawRecord = parseBrowserValidationRecord(failedBrowserValidation.content || "");
    const failureType = normalizeBrowserDiagnosticToken(
      rawRecord?.failureType || rawRecord?.failure_type ||
      (outcome as unknown as { failureType?: unknown } | null)?.failureType,
    ).toLowerCase();
    const failureDetail = outcome?.failureSummary ||
      outcome?.pageErrors[0] ||
      outcome?.consoleErrors[0] ||
      outcome?.error ||
      "browser validation failed";
    const failedArgs = input.toolArgsByCallId.get(failedBrowserValidation.toolCallId) || {};
    const browserFailureCallSignature = resolvePersistentBrowserFailureCallSignature(
      failedArgs,
      failedBrowserValidation.content || "",
    );
    const browserFailureFingerprint = buildStableBrowserFailureFingerprint({
      args: failedArgs,
      failureType,
      failureReasons: outcome?.failureReasons || [],
      failureDetail,
    });
    const browserFailedLocator = extractFailedBrowserLocator(failedArgs, failureDetail);
    const browserLocatorCandidates = collectBrowserLocatorCandidates(rawRecord)
      .filter((candidate) => candidate !== browserFailedLocator)
      .slice(0, 24);
    const scopedLedger = scopeExecutionEvidenceLedger(
      input.callbacks.getPlanExecutionEvidenceLedger(),
      input.iterationContext.eventTurnId,
    );
    const failure = resolveLatestUnreconciledFailureSignal({ ledger: scopedLedger });
    const repairTarget = failure?.domain === "browser"
      ? failure.sourceTarget
      : null;
    if (repairTarget) {
      const repairReadLease = buildFailedValidationRepairReadLease({
        target: repairTarget,
        sourceObservationKey: executeRecoveryState.sourceObservationKey,
      });
      executeRecoveryState = activateExecuteRecoveryAndSync(
        "mutation_first",
        "browser_validation_requires_source_repair",
        {
          expectedTarget: repairTarget,
          readLease: repairReadLease,
          sourceObservationKey: null,
          decisionCheckpoint: {
            expectedTarget: repairTarget,
            sourceObservationKey: null,
            nextRequiredCapability: "targeted_read",
            browserFailureFingerprint,
            browserFailureCallSignature,
            browserFailureDetail: String(failureDetail).slice(0, 1_200),
            browserFailedLocator,
            browserLocatorCandidates,
            browserRequestedUrl: failedBrowserValidation.target,
          },
          requestedUrl: failedBrowserValidation.target,
        },
      );
      logAgentEvent("browser_validation_requires_source_repair", {
        iteration: input.iteration,
        target: repairTarget,
        browserTarget: failedBrowserValidation.target,
        failureDetail: String(failureDetail).slice(0, 600),
        nextRequiredCapability:
          executeRecoveryState.decisionCheckpoint?.nextRequiredCapability || null,
      });
      input.emitPlanExecutionProgress("running", {
        currentTask: input.callbacks.getPreferredLanguage() === "zh"
          ? "修复浏览器验收发现的源码错误"
          : "repairing the source error found by browser validation",
        currentTool: "read_file",
        latestEvidence: String(failureDetail).slice(0, 600),
        recoveryReason: "browser_validation_requires_source_repair",
        nextStep: input.callbacks.getPreferredLanguage() === "zh"
          ? `精确复读 ${repairTarget} 的当前版本，修复后重新执行同一浏览器交互验收`
          : `reread the current ${repairTarget}, repair it, then rerun the same browser interaction validation`,
      });
      input.callbacks.onStatusChange("running");
      input.callbacks.appendMessage({
        role: "user",
        content: [
          "BROWSER_SOURCE_REPAIR_REQUIRED: Browser validation executed and found a real application failure.",
          `Target source: ${repairTarget}`,
          `Observed failure: ${String(failureDetail).slice(0, 600)}`,
          `Read the current ${repairTarget} once under the granted lease, repair this failure, then rerun the same browser interaction validation against ${failedBrowserValidation.target}.`,
          "The dev server is already ready; do not restart or reconcile it unless new process evidence shows an actual lifecycle failure.",
        ].join("\n"),
      });
      return finish("continue");
    }

    executeRecoveryState = activateExecuteRecoveryAndSync(
      "action_plus_targeting",
      "browser_validation_requires_diagnostic",
      {
        expectedTarget: null,
        resetExpectedTarget: true,
        sourceObservationKey: null,
        decisionCheckpoint: {
          expectedTarget: null,
          sourceObservationKey: null,
          nextRequiredCapability: "browser_diagnostic",
          browserFailureFingerprint,
          browserFailureCallSignature,
          browserFailureDetail: String(failureDetail).slice(0, 1_200),
          browserFailedLocator,
          browserLocatorCandidates,
          browserRequestedUrl: failedBrowserValidation.target,
        },
        protocolNoProgressFingerprint: browserFailureFingerprint,
        requestedUrl: failedBrowserValidation.target,
      },
    );
    logAgentEvent("browser_validation_requires_diagnostic", {
      iteration: input.iteration,
      browserTarget: failedBrowserValidation.target,
      failureType: failureType || null,
      failureReasons: outcome?.failureReasons || [],
      failureDetail: String(failureDetail).slice(0, 600),
      failedLocator: browserFailedLocator,
      locatorCandidates: browserLocatorCandidates,
      browserFailureFingerprint: browserFailureFingerprint.slice(0, 600),
      browserFailureCallSignature: browserFailureCallSignature
        ? browserFailureCallSignature.slice(0, 600)
        : null,
      protocolNoProgressCount: executeRecoveryState.protocolNoProgressCount,
    });
    input.emitPlanExecutionProgress("running", {
      currentTask: input.callbacks.getPreferredLanguage() === "zh"
        ? "诊断浏览器验收参数与真实 DOM"
        : "diagnosing browser validation against the real DOM",
      currentTool: "browser_evaluate",
      latestEvidence: String(failureDetail).slice(0, 600),
      recoveryReason: "browser_validation_requires_diagnostic",
      nextStep: input.callbacks.getPreferredLanguage() === "zh"
        ? "根据返回的交互元素清单修正 locator/因果断言；若需源码定位，只搜索失败或候选 locator 并读取唯一命中文件"
        : "correct the locator/causal assertion from the returned interactive inventory; if source lookup is needed, search only the failed/candidate locator and read a uniquely matched file",
    });
    input.callbacks.onStatusChange("running");
    input.callbacks.appendMessage({
      role: "user",
      content: [
        "BROWSER_VALIDATION_DIAGNOSTIC_REQUIRED: Browser validation ran, but no browser error stack identifies broken source.",
        `Observed failure: ${String(failureDetail).slice(0, 1_200)}`,
        `Failed locator: ${browserFailedLocator || "(not structured)"}`,
        `DOM-derived candidates: ${browserLocatorCandidates.join(", ") || "(inspect the returned interactive-element inventory)"}`,
        "Treat this as a validation-spec/DOM diagnosis first. Correct the locator or post-action causal assertion and rerun browser_evaluate, or grep only one of the listed locator/label terms and read only a uniquely matched source file.",
        "Do not mutate an arbitrary recently read file, and do not repeat the identical failed action/check while its arguments and page state are unchanged.",
      ].join("\n"),
    });
    return finish("continue");
  }

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
  const failedFiniteValidationArgs = failedFiniteValidation
    ? input.toolArgsByCallId.get(failedFiniteValidation.toolCallId) || {}
    : {};
  const pendingFiniteValidation = failedFiniteValidationCommand
    ? {
        command: failedFiniteValidationCommand,
        cwd: getShellToolCwd(failedFiniteValidationArgs),
        ...(Number.isFinite(Number(failedFiniteValidationArgs.timeout_ms))
          ? { timeoutMs: Math.floor(Number(failedFiniteValidationArgs.timeout_ms)) }
          : {}),
      }
    : null;
  const failedFiniteValidationOutcome = failedFiniteValidation
    ? classifyFailedFiniteValidationOutcome({
        result: failedFiniteValidation.content || failedFiniteValidation.displayContent || "",
        isToolError: failedFiniteValidation.isError,
        lifecycleState: failedFiniteValidation.lifecycleState,
      })
    : null;
  const remainingPlanTasksAfterFailedFiniteValidation = failedFiniteValidation &&
    input.callbacks.getIsPlanApproved()
    ? buildPlanTaskEvidenceAudit({
        tasks: input.callbacks.getPlanTasks(),
        evidenceLedger: input.callbacks.getPlanExecutionEvidenceLedger(),
        preserveMissing: true,
        highlightNext: true,
      }).remainingTasks
    : [];
  const directFileModifyExecution = isDirectFileModifyExecution(input);
  const approvedPlanInvocationRecovery = input.callbacks.getIsPlanApproved() &&
    hasPendingPlanCommandEvidence(remainingPlanTasksAfterFailedFiniteValidation);
  if (
    failedFiniteValidation &&
    failedFiniteValidationOutcome === "invocation_error" &&
    pendingFiniteValidation &&
    (approvedPlanInvocationRecovery || directFileModifyExecution)
  ) {
    const command = failedFiniteValidationCommand;
    const recoveryPolicy = resolveFailedFiniteValidationRecoveryPolicy({
      failedCommand: command,
      tasks: remainingPlanTasksAfterFailedFiniteValidation,
    });
    executeRecoveryState = activateExecuteRecoveryAndSync(
      "finite_validation_only",
      "failed_finite_validation_command",
      {
        command,
        target: failedFiniteValidation.target || "run_command",
        expectedTarget: executeRecoveryState.expectedTarget,
        decisionCheckpoint: {
          expectedTarget: executeRecoveryState.expectedTarget,
          sourceObservationKey: executeRecoveryState.sourceObservationKey,
          nextRequiredCapability: "validation",
          pendingFiniteValidation,
        },
      },
    );
    const recoveryPrompt = buildFailedFiniteValidationRecoveryPrompt({
      command,
      result: failedFiniteValidation.content || failedFiniteValidation.displayContent || "",
      ...recoveryPolicy,
    });
    logAgentEvent(input.callbacks.getIsPlanApproved()
      ? "approved_plan_finite_validation_recovery"
      : "direct_edit_finite_validation_recovery", {
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
  const failedValidationRequiresRepair = failedFiniteValidation &&
    failedFiniteValidationOutcome === "validation_failure" &&
    (
      (input.callbacks.getIsPlanApproved() && failedValidationMatchesPendingTask) ||
      directFileModifyExecution
    );
  if (
    failedFiniteValidation &&
    failedValidationRequiresRepair &&
    pendingFiniteValidation
  ) {
    // A validation that actually ran has produced a source/test/config
    // diagnostic. Command-only recovery cannot fix it, but the current
    // transaction target and failed evidence must remain owned by the same
    // contract. Returning to `normal` here used to reopen broad discovery.
    const repairTarget = resolveFiniteValidationRepairTarget({
      result: failedFiniteValidation,
      args: failedFiniteValidationArgs,
      workspace: input.workspace,
      recentToolActivity: input.recentToolActivity,
      fallbackTarget: executeRecoveryState.expectedTarget,
    });
    executeRecoveryState = activateExecuteRecoveryAndSync(
      "mutation_first",
      "failed_finite_validation_requires_repair",
      {
        expectedTarget: repairTarget,
        // The mutation contract already includes a targeted read. Keep both
        // choices available so an actionable compiler/test diagnostic can be
        // repaired immediately while an uncertain diagnosis can reread first.
        sourceObservationKey: null,
        decisionCheckpoint: {
          expectedTarget: repairTarget,
          sourceObservationKey: null,
          nextRequiredCapability: "mutation",
          pendingFiniteValidation,
        },
      },
    );
    const recoveryPrompt = [
      "FINITE_VALIDATION_REPAIR_REQUIRED: The finite validation command executed, but its validation failed.",
      `Failed command: ${failedFiniteValidationCommand}`,
      "MAIN retained the current execution transaction. Inspect the structured stdout/stderr/exitCode already returned, then either repair the implicated source, test, or configuration directly or reread the current target first when exact context is still missing. Rerun this same command after the repair.",
      "Do not substitute an unrelated successful command: this failed validation remains pending turn evidence until the same concrete command succeeds.",
    ].join("\n");
    logAgentEvent(input.callbacks.getIsPlanApproved()
      ? "approved_plan_finite_validation_requires_repair"
      : "direct_edit_finite_validation_requires_repair", {
      iteration: input.iteration,
      command: failedFiniteValidationCommand,
      target: failedFiniteValidation.target || "",
      previousRecoveryMode: input.executeRecoveryState.mode,
      nextRecoveryMode: executeRecoveryState.mode,
      nextRequiredCapability:
        executeRecoveryState.decisionCheckpoint?.nextRequiredCapability || null,
    });
    input.emitPlanExecutionProgress("running", {
      currentTool: "apply_patch",
      recoveryReason: "failed_finite_validation_requires_repair",
      nextStep: input.callbacks.getPreferredLanguage() === "zh"
        ? "根据命令诊断直接修复；仅在缺少精确上下文时重读当前目标，然后重新运行同一验证命令"
        : "repair the command diagnostic directly; reread the current target only when exact context is missing, then rerun the same validation command",
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

  if (input.unityMcpFallbackPrompt) {
    input.callbacks.appendMessage({
      role: "user",
      content: input.unityMcpFallbackPrompt,
    });
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
    input.callbacks.getIsPlanApproved() &&
    input.results.some((result) => !result.isError)
  ) {
    input.callbacks.onPlanStageChanged("executing");
  }

  if (input.callbacks.getIsPlanApproved()) {
    if (input.results.some((result) => result.isError)) {
      input.emitPlanExecutionProgress("tool_error");
    } else if (input.results.some((result) => !result.isError)) {
      input.emitPlanExecutionProgress("tool_done");
    }
  }

  const strictRepeatGuardRecovery = handleStrictRepeatGuardRecovery({
    callbacks: input.callbacks,
    workspace: input.workspace,
    runtimeIntent: input.runtimeIntent,
    iteration: input.iteration,
    effectiveToolCalls: input.effectiveToolCalls,
    results: input.results,
    recentToolCalls: loopGuardRuntimeState.recentToolCalls,
    repeatGuardRecoveredSignatures:
      loopGuardRuntimeState.repeatGuardRecoveredSignatures,
    recentPlanToolActivity: input.recentPlanToolActivity,
    availableToolNames: input.availableToolNames,
    toolCapabilityRegistry: input.toolCapabilityRegistry,
    toolPermissionPolicy: input.toolPermissionPolicy,
    emitTurnFailedEvent: input.emitTurnFailedEvent,
    executeRecoveryState,
    activateExecuteRecovery: activateExecuteRecoveryAndSync,
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
      ...(completionAudit ? { completionAudit } : {}),
    };
  }
}
