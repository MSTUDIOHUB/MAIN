import { isExecutionPlanArtifactWrite, isSuccessfulPlanArtifactWriteResult, isTasksPlanWrite, truncateForLog } from "../../orchestrator";
import {
  EDIT_PROGRESS_TOOL_NAMES,
  EXECUTION_VERIFICATION_TOOL_NAMES,
  MAX_PLAN_EVIDENCE_TOOL_ACTIVITY,
  MAX_RECENT_PLAN_TOOL_ACTIVITY,
  PLAN_EXPLORATION_READ_ONLY_TOOLS,
} from "../../orchestrator";
import {
  hasResolvedWorkspaceMutationTarget,
  isWorkspaceMutationToolCall,
  isWorkspaceMutationToolName,
} from "../../workspaceMutationTools";
import { browserResultLooksSuccessful, classifyCommandResultOutcome } from "../../planEvidence";
import type { PlanToolActivitySummary } from "../../planExecutionRecovery";
import {
  extractPlanEvidenceFacts,
  extractPlanEvidenceSourceFacts,
  mergePlanEvidenceFacts,
  summarizePlanEvidenceDetail,
} from "../../planMaterialization";
import { parseToolFeedbackEnvelope } from "../../toolFeedbackEnvelope";
import type { ToolExecutionResult } from "../types";
import { isSuccessfulVerificationToolObservation } from "../../verificationEvidence";
import { normalizeWorkspacePathIdentity } from "../../workspacePaths";
import {
  createRuntimePlanStructuredEvidenceFacts,
  extractRuntimeValidationCapabilityFacts,
  mergePlanStructuredEvidenceFacts,
  type PlanStructuredEvidenceFact,
} from "../../planStructuredEvidence";
import {
  extractRuntimePlanEvidenceDiscovery,
  extractSymbolReferenceOccurrences,
  getPlanEvidenceObligationKey,
  type PlanEvidenceObligation,
} from "../../planEvidenceObligations";
import { isAuthoritativeSubagentClosure } from "../../subagents";
import {
  getToolExecutionArgs,
  getToolExecutionName,
  hasCompletedToolExecution,
  hasObservedWorkspaceMutationEffect,
  hasVerifiedWorkspaceMutationEffect,
} from "../../toolResultEffect";
import {
  extractRuntimePlanSourceObservations,
  normalizePlanSourceObservations,
} from "../../planSourceObservation";
import { resolveToolDiffChangedRange } from "../../toolDiff";

const SUBAGENT_EVIDENCE_TOOLS = new Set([
  "read_file",
  "read_file_window",
  "read_document",
  "get_file_outline",
  "grep_search",
  "code_ast_query",
  "find_symbol_references",
  "git_diff",
]);

function compactLatestActivityDetail(value: string, maxChars: number): string {
  const detail = String(value || "").trim();
  if (detail.length <= maxChars) return detail;
  const separator = " … ";
  const headBudget = Math.min(80, Math.max(0, maxChars - separator.length));
  const tailBudget = Math.max(0, maxChars - separator.length - headBudget);
  return `${detail.slice(0, headBudget)}${separator}${detail.slice(-tailBudget)}`;
}

function sourceReadVersionKey(item: PlanToolActivitySummary): string {
  if (!/^(?:read_file|read_file_window)$/.test(String(item.name || ""))) return "";
  const observation = item.readFileObservation;
  const version = String(observation?.versionToken || "").trim();
  if (version) return `version:${version}`;
  const request = String(observation?.requestSignature || "").trim();
  return request ? `request:${request}` : "";
}

function replaceSourceDerivedActivity(
  existing: PlanToolActivitySummary,
  incoming: PlanToolActivitySummary,
): void {
  existing.facts = incoming.facts ? [...incoming.facts] : undefined;
  existing.structuredFacts = incoming.structuredFacts
    ? incoming.structuredFacts.map((fact) => ({ ...fact }))
    : undefined;
  existing.sourceObservations = incoming.sourceObservations
    ? normalizePlanSourceObservations(incoming.sourceObservations)
    : undefined;
  existing.detail = incoming.detail;
  existing.status = incoming.status;
  existing.mutationObserved = incoming.mutationObserved;
  existing.readFileObservation = incoming.readFileObservation
    ? {
        ...incoming.readFileObservation,
        ...(incoming.readFileObservation.window
          ? { window: { ...incoming.readFileObservation.window } }
          : {}),
      }
    : undefined;
  existing.astObservation = incoming.astObservation
    ? {
        ...incoming.astObservation,
        symbols: incoming.astObservation.symbols.map((symbol) => ({ ...symbol })),
      }
    : undefined;
  existing.discoveryObservation = incoming.discoveryObservation
    ? {
        ...incoming.discoveryObservation,
        targetRefs: [...incoming.discoveryObservation.targetRefs],
        ...(incoming.discoveryObservation.occurrences
          ? { occurrences: incoming.discoveryObservation.occurrences.map((item) => ({ ...item })) }
          : {}),
      }
    : undefined;
  existing.evidenceObligation = incoming.evidenceObligation
    ? { ...incoming.evidenceObligation }
    : undefined;
  existing.obligationClosure = incoming.obligationClosure
    ? {
        role: "obligation_closure",
        obligation: {
          ...incoming.obligationClosure.obligation,
          ...(incoming.obligationClosure.obligation.occurrence
            ? { occurrence: { ...incoming.obligationClosure.obligation.occurrence } }
            : {}),
        },
      }
    : undefined;
}

function sourceObservationPriority(
  activity: PlanToolActivitySummary,
  observationRef: string,
  startLine: number,
  endLine: number,
  incoming: boolean,
): number {
  const window = activity.readFileObservation?.window;
  const isExactReturnedWindow = !!window &&
    window.startLine === startLine &&
    window.endLine === endLine;
  const occurrence = activity.obligationClosure?.obligation.occurrence;
  const closesExactObligation = activity.obligationClosure?.role === "obligation_closure" && (
    occurrence
      ? startLine <= occurrence.startLine && endLine >= occurrence.endLine
      : isExactReturnedWindow
  );
  const supportingFacts = (activity.structuredFacts || []).filter((fact) =>
    fact.sourceObservationRefs?.includes(observationRef)
  );
  const strongestFact = supportingFacts.reduce((priority, fact) => {
    if (fact.kind === "command_contract") return Math.max(priority, 900);
    if (fact.kind === "event_contract") return Math.max(priority, 850);
    if (
      fact.kind === "symbol_relation" ||
      fact.kind === "interaction_target" ||
      fact.kind === "execution_surface" ||
      fact.kind === "validation_capability"
    ) return Math.max(priority, 800);
    if (fact.kind === "permission_contract" || fact.kind === "configuration") {
      return Math.max(priority, 600);
    }
    if (fact.kind === "field_contract" && fact.relation !== "read") {
      return Math.max(priority, 400);
    }
    return Math.max(priority, 100);
  }, 0);
  return (closesExactObligation ? 20_000 : 0) +
    (isExactReturnedWindow ? 10_000 : 0) +
    strongestFact +
    Math.min(99, supportingFacts.length) +
    (incoming ? 1 : 0);
}

/**
 * Source observations and the runtime facts derived from them are one
 * provenance unit. Rank exact/obligation-closing windows before bounded
 * context, then remove every fact reference whose observation was not
 * retained. This prevents a same-version paginated read from producing a
 * receipt with dangling sourceObservationRefs.
 */
function mergeSourceDerivedProvenance(
  existing: PlanToolActivitySummary,
  incoming: PlanToolActivitySummary,
): {
  sourceObservations: PlanToolActivitySummary["sourceObservations"];
  structuredFacts: PlanStructuredEvidenceFact[];
} {
  const candidates = [
    ...(existing.sourceObservations || []).map((observation, index) => ({
      observation,
      priority: sourceObservationPriority(
        existing,
        observation.observationRef,
        observation.startLine,
        observation.endLine,
        false,
      ),
      index,
    })),
    ...(incoming.sourceObservations || []).map((observation, index) => ({
      observation,
      priority: sourceObservationPriority(
        incoming,
        observation.observationRef,
        observation.startLine,
        observation.endLine,
        true,
      ),
      index: (existing.sourceObservations || []).length + index,
    })),
  ].sort((left, right) => right.priority - left.priority || right.index - left.index);
  const sourceObservations = normalizePlanSourceObservations(
    candidates.map((candidate) => candidate.observation),
  );
  const retainedRefs = new Set(sourceObservations.map((item) => item.observationRef));
  const structuredFacts = mergePlanStructuredEvidenceFacts(
    existing.structuredFacts,
    incoming.structuredFacts,
  ).flatMap((fact): PlanStructuredEvidenceFact[] => {
    const originalRefs = fact.sourceObservationRefs || [];
    if (fact.authority !== "runtime_observation") return [fact];
    const sourceObservationRefs = originalRefs.filter((reference) => retainedRefs.has(reference));
    if (sourceObservationRefs.length === 0) return [];
    return [{ ...fact, sourceObservationRefs } as PlanStructuredEvidenceFact];
  });
  return {
    sourceObservations,
    structuredFacts: mergePlanStructuredEvidenceFacts(structuredFacts),
  };
}

function extractAstObservation(
  result: ToolExecutionResult,
): PlanToolActivitySummary["astObservation"] | undefined {
  if (result.name !== "code_ast_query" || result.isError) return undefined;
  const parsedFeedback = parseToolFeedbackEnvelope(result.content || "");
  const body = parsedFeedback?.body || result.content || "";
  let payload: Record<string, unknown>;
  try {
    const parsed = JSON.parse(body);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    payload = parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const path = String(payload.path || result.target || "").trim();
  const language = String(payload.language || "").trim();
  const versionToken = String(payload.versionToken || "").trim();
  const query = String(payload.query || "").trim();
  const rawExactMatchCount = Number(payload.exactMatchCount);
  if (!path || !language || !versionToken || !Array.isArray(payload.symbols)) return undefined;
  const symbols = payload.symbols.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const symbol = item as Record<string, unknown>;
    const name = String(symbol.name || "").trim();
    const kind = String(symbol.kind || "").trim();
    const syntaxKind = String(symbol.syntaxKind || "").trim();
    const rawStartLine = Number(symbol.startLine);
    const rawEndLine = Number(symbol.endLine);
    if (!Number.isFinite(rawStartLine) || !Number.isFinite(rawEndLine)) return [];
    const startLine = Math.floor(rawStartLine);
    const endLine = Math.floor(rawEndLine);
    if (!name || !kind || !syntaxKind || startLine <= 0 || endLine < startLine) return [];
    return [{ name, kind, syntaxKind, startLine, endLine }];
  }).slice(0, 120);
  return {
    path,
    language,
    versionToken,
    query,
    exactMatchCount: Number.isFinite(rawExactMatchCount)
      ? Math.max(0, Math.floor(rawExactMatchCount))
      : 0,
    hasErrors: payload.hasErrors === true,
    truncated: payload.truncated === true || payload.symbols.length > symbols.length,
    symbols,
  };
}

function appendBoundedToolActivity(
  targetList: PlanToolActivitySummary[],
  activity: PlanToolActivitySummary,
  maxItems = MAX_RECENT_PLAN_TOOL_ACTIVITY,
  mergeByTarget = false,
): void {
  if (mergeByTarget) {
    const normalizedTarget = String(activity.target || "").replace(/\\/g, "/").toLowerCase();
    const delegatedIdentity = (item: PlanToolActivitySummary): string => {
      const delegated = item.delegatedObservation;
      if (!delegated) return "";
      if (delegated.sourceObservationKey) return delegated.sourceObservationKey;
      const range = delegated.sourceRange;
      return [
        delegated.sourceVersion || "",
        range ? `${range.startLine}-${range.endLine}/${range.totalLines}` : "",
      ].filter(Boolean).join("::");
    };
    const activityDelegatedIdentity = delegatedIdentity(activity);
    const obligationClosureIdentity = (item: PlanToolActivitySummary): string =>
      item.obligationClosure?.role === "obligation_closure"
        ? getPlanEvidenceObligationKey(item.obligationClosure.obligation)
        : "";
    const activityObligationClosureIdentity = obligationClosureIdentity(activity);
    const existing = targetList.find((item) =>
      item.name === activity.name &&
      String(item.target || "").replace(/\\/g, "/").toLowerCase() === normalizedTarget &&
      obligationClosureIdentity(item) === activityObligationClosureIdentity &&
      (
        !activityDelegatedIdentity ||
        delegatedIdentity(item) === activityDelegatedIdentity
      )
    );
    if (existing) {
      const existingSourceVersion = sourceReadVersionKey(existing);
      const incomingSourceVersion = sourceReadVersionKey(activity);
      if (
        incomingSourceVersion &&
        existingSourceVersion !== incomingSourceVersion
      ) {
        // A target path is not a source snapshot identity. Never combine facts,
        // exact excerpts, AST/discovery data, or summaries across file versions.
        // Same-version pagination still merges below because each window carries
        // the same version token and its own request/range observation.
        replaceSourceDerivedActivity(existing, activity);
        return;
      }
      existing.facts = mergePlanEvidenceFacts(existing.facts, activity.facts);
      const sourceProvenance = mergeSourceDerivedProvenance(existing, activity);
      existing.structuredFacts = sourceProvenance.structuredFacts;
      existing.sourceObservations = sourceProvenance.sourceObservations;
      if (activity.readFileObservation) {
        existing.readFileObservation = {
          ...activity.readFileObservation,
          ...(activity.readFileObservation.window
            ? { window: { ...activity.readFileObservation.window } }
            : {}),
        };
      }
      if (activity.astObservation) {
        existing.astObservation = {
          ...activity.astObservation,
          symbols: activity.astObservation.symbols.map((symbol) => ({ ...symbol })),
        };
      }
      if (activity.discoveryObservation) {
        const existingRefs = existing.discoveryObservation?.targetRefs || [];
        const mergedOccurrences = [
          ...(existing.discoveryObservation?.occurrences || []),
          ...(activity.discoveryObservation.occurrences || []),
        ].filter((occurrence, index, all) => all.findIndex((candidate) =>
          normalizeWorkspacePathIdentity(candidate.targetRef) === normalizeWorkspacePathIdentity(occurrence.targetRef) &&
          candidate.anchorLine === occurrence.anchorLine &&
          candidate.startLine === occurrence.startLine &&
          candidate.endLine === occurrence.endLine
        ) === index).slice(0, 40);
        existing.discoveryObservation = {
          ...activity.discoveryObservation,
          targetRefs: [...new Set([
            ...existingRefs,
            ...activity.discoveryObservation.targetRefs,
          ])].slice(0, 80),
          ...(mergedOccurrences.length > 0 ? { occurrences: mergedOccurrences } : {}),
        };
      }
      if (activity.evidenceObligation) {
        existing.evidenceObligation = {
          ...activity.evidenceObligation,
          ...(activity.evidenceObligation.occurrence
            ? { occurrence: { ...activity.evidenceObligation.occurrence } }
            : {}),
        };
      }
      if (activity.obligationClosure) {
        existing.obligationClosure = {
          role: "obligation_closure",
          obligation: {
            ...activity.obligationClosure.obligation,
            ...(activity.obligationClosure.obligation.occurrence
              ? { occurrence: { ...activity.obligationClosure.obligation.occurrence } }
              : {}),
          },
        };
      }
      if (activity.delegatedObservation) {
        existing.delegatedObservation = {
          ...activity.delegatedObservation,
          owner: { ...activity.delegatedObservation.owner },
          ...(activity.delegatedObservation.sourceRange
            ? { sourceRange: { ...activity.delegatedObservation.sourceRange } }
            : {}),
        };
      }
      existing.mutationObserved = existing.mutationObserved === true || activity.mutationObserved === true;
      if (activity.mutationRange) {
        existing.mutationRange = { ...activity.mutationRange };
      }
      const details = [existing.detail, activity.detail]
        .map((detail) => String(detail || "").trim())
        .filter((detail, index, all) => detail && all.indexOf(detail) === index);
      existing.status = existing.status === "succeeded" || activity.status === "succeeded"
        ? "succeeded"
        : activity.status;
      if (details.length === 1) existing.detail = details[0].slice(0, 440);
      if (details.length > 1) {
        const latest = details[details.length - 1];
        const separator = " | ";
        const latestBudget = Math.min(latest.length, 260);
        const previousBudget = Math.max(0, 440 - separator.length - latestBudget);
        existing.detail = `${compactLatestActivityDetail(details[0], previousBudget)}${separator}${compactLatestActivityDetail(latest, latestBudget)}`;
      }
      return;
    }
  }
  targetList.push(activity);
  if (targetList.length > maxItems) {
    targetList.splice(0, targetList.length - maxItems);
  }
}

export interface ToolActivityRetentionOptions {
  evidenceLedger?: boolean;
  args?: Record<string, unknown>;
  /** Runtime sidecar from exact needs_evidence tool-surface admission. */
  closingEvidenceObligation?: PlanEvidenceObligation;
}

export function extractDelegatedSubagentActivities(
  result: ToolExecutionResult,
  options: ToolActivityRetentionOptions = {},
): PlanToolActivitySummary[] {
  if (result.name !== "wait_subagents" || result.isError) return [];
  const evidenceContent = result.runtimeEvidenceContent || result.content || "";
  const parsedFeedback = parseToolFeedbackEnvelope(evidenceContent);
  const body = parsedFeedback?.body || evidenceContent;
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return [];
  }
  const results = Array.isArray((payload as { results?: unknown[] })?.results)
    ? (payload as { results: unknown[] }).results
    : [];
  const activities: PlanToolActivitySummary[] = [];
  const maxItems = options.evidenceLedger
    ? MAX_PLAN_EVIDENCE_TOOL_ACTIVITY
    : MAX_RECENT_PLAN_TOOL_ACTIVITY;
  for (const envelope of results) {
    const record = envelope && typeof envelope === "object"
      ? envelope as Record<string, unknown>
      : {};
    const status = String(record.status || "");
    const envelopeSubagentId = String(record.subagentId || "").trim();
    if (!/^(?:completed|blocked|degraded)$/.test(status) || !Array.isArray(record.evidence)) continue;
    const closureAudit = record.closureAudit && typeof record.closureAudit === "object"
      ? record.closureAudit as Record<string, unknown>
      : null;
    const recordScopeKey = String(record.scopeKey || "").trim();
    const closureIsAuthoritative = !!closureAudit &&
      !!recordScopeKey &&
      isAuthoritativeSubagentClosure(closureAudit, {
        subagentId: envelopeSubagentId,
        scopeKey: recordScopeKey,
      }) &&
      closureAudit.status === status;
    const obligationClosureState: "satisfied" | "partial" | "unverified" =
      closureIsAuthoritative && closureAudit.state === "satisfied" && status === "completed"
        ? "satisfied"
        : closureIsAuthoritative
          ? "partial"
          : "unverified";
    const requiredPaths = Array.isArray(closureAudit?.requiredPaths)
      ? closureAudit.requiredPaths.map((path) => String(path || "").trim()).filter(Boolean)
      : [];
    const coveredPaths = new Set(Array.isArray(closureAudit?.coveredPaths)
      ? closureAudit.coveredPaths
        .map((path) => normalizeWorkspacePathIdentity(String(path || "")))
        .filter(Boolean)
      : []);
    const failedPaths = Array.isArray(closureAudit?.failedPaths)
      ? closureAudit.failedPaths.map((path) => String(path || "").trim()).filter(Boolean)
      : [];
    const uncoveredPaths = Array.isArray(closureAudit?.uncoveredPaths)
      ? closureAudit.uncoveredPaths.map((path) => String(path || "").trim()).filter(Boolean)
      : [];
    const unresolvedPathIdentities = new Set([...failedPaths, ...uncoveredPaths]
      .map((path) => normalizeWorkspacePathIdentity(path))
      .filter(Boolean));
    const acceptedEvidenceToolCallIds = new Set(Array.isArray(closureAudit?.acceptedEvidenceToolCallIds)
      ? closureAudit.acceptedEvidenceToolCallIds
        .map((toolCallId) => String(toolCallId || "").trim())
        .filter(Boolean)
      : []);
    // allowedPaths is an authorization ceiling, not automatically a mandatory
    // fan-out. Enforce per-path coverage only when the child runtime publishes
    // a non-empty requiredPaths contract.
    const hasPathCoverageAudit = requiredPaths.length > 0;
    for (const item of record.evidence) {
      const evidence = item && typeof item === "object" ? item as Record<string, unknown> : {};
      const observation = evidence.observation && typeof evidence.observation === "object"
        ? evidence.observation as Record<string, unknown>
        : null;
      // Structured observations distinguish tool activity from evidence that
      // can support the parent plan. Empty outlines and other non-substantive
      // observations stay visible in the child run but must not enter the
      // parent's evidence ledger. Legacy evidence without this field keeps the
      // provenance checks below for backward compatibility.
      if (observation && observation.substantive !== true) continue;
      const provenance = evidence.provenance && typeof evidence.provenance === "object"
        ? evidence.provenance as Record<string, unknown>
        : {};
      const sourceObservation = provenance.sourceObservation &&
          typeof provenance.sourceObservation === "object"
        ? provenance.sourceObservation as Record<string, unknown>
        : null;
      const sourceToolCallId = String(provenance.sourceToolCallId || "").trim();
      const sourceObservationKey = String(sourceObservation?.key || "").trim();
      const ownerRecord = provenance.owner && typeof provenance.owner === "object"
        ? provenance.owner as Record<string, unknown>
        : null;
      const ownerSubagentId = String(ownerRecord?.subagentId || "").trim();
      // Child summary prose and legacy unprovenanced payloads are hypotheses,
      // never ledger evidence. At least one concrete tool/observation identity
      // and an owner matching the enclosing child result must accompany a
      // runtime-authored tool_observation entry.
      if (
        provenance.source !== "tool_observation" ||
        (!sourceToolCallId && !sourceObservationKey) ||
        ownerRecord?.agentKind !== "subagent" ||
        !ownerSubagentId ||
        ownerSubagentId !== envelopeSubagentId
      ) continue;
      const name = String(evidence.tool || "").trim();
      const target = String(evidence.target || "").trim();
      if (!SUBAGENT_EVIDENCE_TOOLS.has(name) || !target) continue;
      const evidencePathIdentity = normalizeWorkspacePathIdentity(
        String(observation?.sourcePath || target),
      );
      // Child-task closure and observation usability are separate contracts.
      // A partial/degraded child does not become "completed", but each
      // substantive runtime observation may still support Plan authoring when
      // its exact path is covered and not unresolved. Failed/uncovered paths
      // remain explicit parent obligations below.
      if (
        closureAudit &&
        acceptedEvidenceToolCallIds.size > 0 &&
        (!sourceToolCallId || !acceptedEvidenceToolCallIds.has(sourceToolCallId))
      ) continue;
      if (
        closureAudit &&
        hasPathCoverageAudit &&
        (
          !evidencePathIdentity ||
          !coveredPaths.has(evidencePathIdentity) ||
          unresolvedPathIdentities.has(evidencePathIdentity)
        )
      ) continue;
      const rawFacts = Array.isArray(evidence.facts)
        ? evidence.facts.map((fact) => String(fact || ""))
        : [];
      const referencedFacts = Array.isArray(provenance.factReferences)
        ? provenance.factReferences.map((reference) =>
            reference && typeof reference === "object"
              ? String((reference as Record<string, unknown>).fact || "")
              : ""
          )
        : [];
      const detail = summarizePlanEvidenceDetail({
        tool: name,
        target,
        content: String(evidence.detail || ""),
        // Controlled children already compact repeated observations to a
        // bounded first+latest detail. Preserve that envelope here; a second
        // short prefix trim can discard the newest fact (for example a port
        // found in a later window of the same file).
        maxChars: 440,
      });
      const facts = mergePlanEvidenceFacts(rawFacts, referencedFacts);
      const sourceRangeRecord = provenance.sourceRange && typeof provenance.sourceRange === "object"
        ? provenance.sourceRange as Record<string, unknown>
        : null;
      const sourceRange = sourceRangeRecord &&
          Number.isFinite(Number(sourceRangeRecord.startLine)) &&
          Number.isFinite(Number(sourceRangeRecord.endLine)) &&
          Number.isFinite(Number(sourceRangeRecord.totalLines))
        ? {
            startLine: Math.max(1, Math.floor(Number(sourceRangeRecord.startLine))),
            endLine: Math.max(1, Math.floor(Number(sourceRangeRecord.endLine))),
            totalLines: Math.max(1, Math.floor(Number(sourceRangeRecord.totalLines))),
            truncated: Boolean(sourceRangeRecord.truncated),
          }
        : undefined;
      const observedTargetRefs = Array.isArray(observation?.observedTargetRefs)
        ? observation.observedTargetRefs.map((value) => String(value || "").trim()).filter(Boolean)
        : [];
      const observedOccurrences = Array.isArray(observation?.observedOccurrences)
        ? extractSymbolReferenceOccurrences({
            occurrences: observation.observedOccurrences.map((value) => {
              const occurrence = value && typeof value === "object" && !Array.isArray(value)
                ? value as Record<string, unknown>
                : {};
              return {
                ...occurrence,
                path: occurrence.targetRef,
              };
            }),
          })
        : [];
      const discoveryObservation = name === "find_symbol_references"
        ? {
            kind: "symbol_references" as const,
            ...(String(observation?.queryRef || "").trim()
              ? { queryRef: String(observation?.queryRef || "").trim() }
              : {}),
            targetRefs: observedTargetRefs,
            ...(observedOccurrences.length > 0
              ? { occurrences: observedOccurrences }
              : {}),
          }
        : undefined;
      appendBoundedToolActivity(activities, {
        name,
        target,
        status: "succeeded",
        ...(detail ? { detail } : {}),
        ...(facts.length > 0 ? { facts } : {}),
        ...(discoveryObservation ? { discoveryObservation } : {}),
        delegatedObservation: {
          owner: {
            agentKind: "subagent",
            ...(String(ownerRecord.collaborationTaskId || "").trim()
              ? {
                  collaborationTaskId: String(
                    ownerRecord.collaborationTaskId,
                  ).trim(),
                }
              : {}),
            subagentId: ownerSubagentId,
            ...(String(ownerRecord.parentTurnId || "").trim()
              ? { parentTurnId: String(ownerRecord.parentTurnId).trim() }
              : {}),
            ...(String(ownerRecord.runId || "").trim()
              ? { runId: String(ownerRecord.runId).trim() }
              : {}),
          },
          ...(sourceToolCallId ? { sourceToolCallId } : {}),
          ...(sourceObservationKey ? { sourceObservationKey } : {}),
          ...(String(provenance.sourceVersion || sourceObservation?.versionToken || "").trim()
            ? { sourceVersion: String(provenance.sourceVersion || sourceObservation?.versionToken).trim() }
            : {}),
          ...(String(provenance.sourceContentHash || "").trim()
            ? { sourceContentHash: String(provenance.sourceContentHash).trim() }
            : {}),
          ...(Number.isFinite(Number(provenance.sourceContentChars))
            ? { sourceContentChars: Math.max(0, Math.floor(Number(provenance.sourceContentChars))) }
            : {}),
          ...(sourceRange ? { sourceRange } : {}),
          planningEvidenceState: "reusable",
          joinState: "consumed",
          closureState: obligationClosureState,
          parentContextState: "reference_only",
          requiresParentReread: true,
        },
      }, maxItems, true);
      if (activities.length >= maxItems) return activities;
    }
  }
  return activities;
}

/**
 * Preserve an incomplete child's exact unresolved path handoff. Independently
 * valid covered observations may already be reusable for planning; this marker
 * only exposes the paths that still require a targeted parent read.
 */
export function extractSubagentParentRereadObligations(
  result: ToolExecutionResult,
  options: ToolActivityRetentionOptions = {},
): PlanToolActivitySummary[] {
  if (result.name !== "wait_subagents" || result.isError) return [];
  const evidenceContent = result.runtimeEvidenceContent || result.content || "";
  const parsedFeedback = parseToolFeedbackEnvelope(evidenceContent);
  const body = parsedFeedback?.body || evidenceContent;
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return [];
  }
  const results = Array.isArray((payload as { results?: unknown[] })?.results)
    ? (payload as { results: unknown[] }).results
    : [];
  const obligations: PlanToolActivitySummary[] = [];
  const maxItems = options.evidenceLedger
    ? MAX_PLAN_EVIDENCE_TOOL_ACTIVITY
    : MAX_RECENT_PLAN_TOOL_ACTIVITY;
  for (const envelope of results) {
    const record = envelope && typeof envelope === "object"
      ? envelope as Record<string, unknown>
      : {};
    const subagentId = String(record.subagentId || "").trim();
    const closureAudit = record.closureAudit && typeof record.closureAudit === "object"
      ? record.closureAudit as Record<string, unknown>
      : null;
    const scopeKey = String(record.scopeKey || "").trim();
    if (
      !subagentId ||
      !closureAudit ||
      !scopeKey ||
      !isAuthoritativeSubagentClosure(closureAudit, { subagentId, scopeKey }) ||
      closureAudit.status !== String(record.status || "")
    ) continue;
    const requiredPaths = new Map((Array.isArray(closureAudit.requiredPaths)
      ? closureAudit.requiredPaths
      : []).flatMap((value) => {
        const path = String(value || "").trim();
        const identity = normalizeWorkspacePathIdentity(path);
        return identity ? [[identity, path] as const] : [];
      }));
    const acceptedEvidenceToolCallIds = new Set(Array.isArray(closureAudit.acceptedEvidenceToolCallIds)
      ? closureAudit.acceptedEvidenceToolCallIds
        .map((toolCallId) => String(toolCallId || "").trim())
        .filter(Boolean)
      : []);
    const substantiveEvidencePathIdentities = new Set((Array.isArray(record.evidence)
      ? record.evidence
      : []).flatMap((item) => {
        if (!item || typeof item !== "object") return [];
        const evidence = item as Record<string, unknown>;
        const observation = evidence.observation && typeof evidence.observation === "object"
          ? evidence.observation as Record<string, unknown>
          : null;
        const provenance = evidence.provenance && typeof evidence.provenance === "object"
          ? evidence.provenance as Record<string, unknown>
          : null;
        const owner = provenance?.owner && typeof provenance.owner === "object"
          ? provenance.owner as Record<string, unknown>
          : null;
        const sourceToolCallId = String(provenance?.sourceToolCallId || "").trim();
        if (
          observation?.substantive !== true ||
          provenance?.source !== "tool_observation" ||
          owner?.agentKind !== "subagent" ||
          String(owner.subagentId || "").trim() !== subagentId ||
          (
            acceptedEvidenceToolCallIds.size > 0 &&
            (!sourceToolCallId || !acceptedEvidenceToolCallIds.has(sourceToolCallId))
          )
        ) return [];
        const identity = normalizeWorkspacePathIdentity(
          String(observation.sourcePath || evidence.target || ""),
        );
        return identity ? [identity] : [];
      }));
    const unresolvedPaths = [
      ...[closureAudit.failedPaths, closureAudit.uncoveredPaths]
      .flatMap((value) => Array.isArray(value) ? value : [])
      .map((value) => String(value || "").trim()),
      ...[...requiredPaths.entries()].flatMap(([identity, path]) =>
        substantiveEvidencePathIdentities.has(identity) ? [] : [path]
      ),
    ];
    for (const path of unresolvedPaths) {
      const identity = normalizeWorkspacePathIdentity(path);
      const requiredPath = identity ? requiredPaths.get(identity) : "";
      if (!requiredPath || obligations.some((item) =>
        item.delegatedObservation?.owner.subagentId === subagentId &&
        normalizeWorkspacePathIdentity(item.target) === identity
      )) continue;
      appendBoundedToolActivity(obligations, {
        name: "read_file",
        target: requiredPath,
        status: "failed",
        detail: "Incomplete child closure left this exact scoped path unresolved; parent reread is permitted after join only when consistent with the user instruction.",
        evidenceObligation: {
          kind: "read_target",
          source: "subagent_unresolved",
          targetRef: requiredPath,
        },
        delegatedObservation: {
          owner: {
            agentKind: "subagent",
            ...(String(record.collaborationTaskId || "").trim()
              ? {
                  collaborationTaskId: String(
                    record.collaborationTaskId,
                  ).trim(),
                }
              : {}),
            subagentId,
          },
          planningEvidenceState: "unresolved",
          joinState: "consumed",
          closureState: closureAudit.state === "satisfied" ? "satisfied" : "partial",
          parentContextState: "reference_only",
          requiresParentReread: true,
        },
      }, maxItems, true);
    }
  }
  return obligations;
}

export function toolResultCountsAsExecutionEvidence(
  result: ToolExecutionResult,
  args: Record<string, unknown>,
): boolean {
  if (!hasCompletedToolExecution(result)) return false;
  const executionName = getToolExecutionName(result);
  const executedArgs = getToolExecutionArgs(result, args);
  if (executionName === "send_pty_input") return false;
  // Coordination lifecycle is not task execution evidence. Only concrete
  // child tool observations promoted below, or a parent-side verification of
  // them, may contribute evidence to the execution ledger.
  if (
    executionName === "spawn_subagent" ||
    executionName === "wait_subagents" ||
    executionName === "cancel_subagent"
  ) return false;
  const envelope = parseToolFeedbackEnvelope(result.content || "");
  const feedbackStatus = envelope?.envelope.status || "";
  if (feedbackStatus === "no_op" || feedbackStatus === "no_effect_mutation" || feedbackStatus === "cached") {
    return false;
  }
  const isWorkspaceMutation = isWorkspaceMutationToolCall(executionName, executedArgs);
  if (isWorkspaceMutationToolName(executionName) && !isWorkspaceMutation) return false;
  if (isWorkspaceMutation && !hasVerifiedWorkspaceMutationEffect(result, executedArgs)) return false;
  if (isSuccessfulPlanArtifactWriteResult(result) || isExecutionPlanArtifactWrite(executionName, executedArgs) || isTasksPlanWrite(executionName, executedArgs)) {
    return false;
  }
  if (
    (executionName === "run_command" || executionName === "execute_command") &&
    classifyCommandResultOutcome(executionName, result.content || "") !== "succeeded"
  ) {
    return false;
  }
  if (executionName === "browser_evaluate" && !browserResultLooksSuccessful(result.content || "")) {
    return false;
  }
  return !PLAN_EXPLORATION_READ_ONLY_TOOLS.has(executionName);
}

export function rememberToolActivity(
  targetList: PlanToolActivitySummary[],
  result: ToolExecutionResult,
  options: ToolActivityRetentionOptions = {},
): void {
  if (result.internalFeedback) return;
  const trustedSourceRead = /^(?:read_file|read_file_window)$/.test(result.name) &&
    /\.(?:[cm]?[jt]sx?|rs|py|go|swift|java|kt|cs|cpp|c|h|hpp|vue|svelte|css|scss|html|json|toml|ya?ml)$/i.test(result.target);
  // Keep UI summaries stable for non-source tools. Source evidence follows the
  // exact/runtime or model-facing payload because displayContent is a shorter
  // UI projection that can end before decisive implementation lines.
  const rawDetail = trustedSourceRead
    ? result.runtimeEvidenceContent || result.content || result.displayContent || ""
    : result.displayContent || result.content || "";
  const evidencePayload = result.runtimeEvidenceContent || result.content || result.displayContent || "";
  const planEvidenceDetail = summarizePlanEvidenceDetail({
    tool: result.name,
    target: result.target,
    content: rawDetail,
    maxChars: 220,
  });
  const detail = planEvidenceDetail || (/\bREAD_FILE_RESULT\b/i.test(rawDetail) ? "" : truncateForLog(rawDetail, 120));
  const facts = mergePlanEvidenceFacts(
    extractPlanEvidenceFacts(evidencePayload),
    trustedSourceRead ? extractPlanEvidenceSourceFacts(evidencePayload) : [],
    extractPlanEvidenceFacts(planEvidenceDetail),
  );
  const sourceObservations = trustedSourceRead
    ? extractRuntimePlanSourceObservations({
        target: result.target,
        content: evidencePayload,
        readFileObservation: result.readFileObservation,
      })
    : [];
  // Only exact runtime-owned source reads promote the historical extractor's
  // bounded tokens into acceptance-authoritative typed observations. Child
  // summaries and arbitrary prose remain legacy context until parent-verified.
  const structuredFacts = trustedSourceRead
    ? mergePlanStructuredEvidenceFacts(...sourceObservations.map((observation) =>
        createRuntimePlanStructuredEvidenceFacts(
          [
            ...mergePlanEvidenceFacts(
              extractPlanEvidenceFacts(observation.excerpt),
              extractPlanEvidenceSourceFacts(observation.excerpt),
            ),
            ...extractRuntimeValidationCapabilityFacts({
              path: observation.path,
              source: observation.excerpt,
            }),
          ],
          { sourceObservationRefs: [observation.observationRef] },
        )
      ))
    : [];
  const astObservation = extractAstObservation(result);
  const discoveryObservation = !result.isError
    ? extractRuntimePlanEvidenceDiscovery({
        tool: result.name,
        content: result.runtimeEvidenceContent || result.content || "",
        args: options.args,
      })
    : undefined;
  const executionName = getToolExecutionName(result);
  const executedArgs = getToolExecutionArgs(result, options.args || {});
  // A failed editor may still have changed disk before returning its error.
  // Retain that runtime-observed mutation while keeping the activity failed;
  // downstream evidence gates continue to require successful execution.
  const mutationObserved = hasVerifiedWorkspaceMutationEffect(result, executedArgs) ||
    hasObservedWorkspaceMutationEffect(result);
  const mutationRange = mutationObserved
    ? resolveToolDiffChangedRange(result.workspaceMutationEvidence?.diff)
    : null;
  const noEffectWorkspaceMutation =
    isWorkspaceMutationToolCall(executionName, executedArgs) && !mutationObserved;
  const commandOutcome = !hasCompletedToolExecution(result)
    ? "failed"
    : noEffectWorkspaceMutation
    ? "running"
    : classifyCommandResultOutcome(result.name, result.content || "");
  appendBoundedToolActivity(targetList, {
    name: result.name,
    target: result.target,
    mutationObserved,
    ...(mutationRange ? { mutationRange } : {}),
    status: commandOutcome === "failed"
      ? "failed"
      : commandOutcome === "running"
      ? "called"
      : "succeeded",
    ...(detail ? { detail } : {}),
    ...(facts.length > 0 ? { facts } : {}),
    ...(structuredFacts.length > 0 ? { structuredFacts } : {}),
    ...(sourceObservations.length > 0 ? { sourceObservations } : {}),
    ...(discoveryObservation ? { discoveryObservation } : {}),
    ...(options.closingEvidenceObligation
      ? {
          obligationClosure: {
            role: "obligation_closure" as const,
            obligation: {
              ...options.closingEvidenceObligation,
              ...(options.closingEvidenceObligation.occurrence
                ? { occurrence: { ...options.closingEvidenceObligation.occurrence } }
                : {}),
            },
          },
        }
      : {}),
    ...(result.readFileObservation
      ? {
          readFileObservation: {
            ...result.readFileObservation,
            ...(result.readFileObservation.window
              ? { window: { ...result.readFileObservation.window } }
              : {}),
          },
        }
      : {}),
    ...(astObservation
      ? { astObservation }
      : {}),
  }, options.evidenceLedger ? MAX_PLAN_EVIDENCE_TOOL_ACTIVITY : MAX_RECENT_PLAN_TOOL_ACTIVITY, options.evidenceLedger);
}

export function rememberDelegatedSubagentActivities(
  targetList: PlanToolActivitySummary[],
  activities: PlanToolActivitySummary[],
  options: ToolActivityRetentionOptions = {},
): void {
  activities.forEach((activity) => appendBoundedToolActivity(
    targetList,
    activity,
    options.evidenceLedger ? MAX_PLAN_EVIDENCE_TOOL_ACTIVITY : MAX_RECENT_PLAN_TOOL_ACTIVITY,
    options.evidenceLedger,
  ));
}

export function isEditProgressResult(
  result: ToolExecutionResult,
  args: Record<string, unknown> = {},
): boolean {
  const executionName = getToolExecutionName(result);
  if (EDIT_PROGRESS_TOOL_NAMES.has(executionName)) {
    return hasVerifiedWorkspaceMutationEffect(result, args) &&
      hasResolvedWorkspaceMutationTarget(executionName, result.target || "");
  }
  return hasCompletedToolExecution(result) && String(result.target || "").startsWith("shell-write:");
}

export function isVerificationEvidenceResult(result: ToolExecutionResult): boolean {
  return EXECUTION_VERIFICATION_TOOL_NAMES.has(result.name) &&
    isSuccessfulVerificationToolObservation(result);
}
