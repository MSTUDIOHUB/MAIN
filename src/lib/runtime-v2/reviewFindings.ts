import { workspacePathsReferToSameFile } from "../workspacePaths";
import type { TurnAggregateV1 } from "./aggregate";
import type { RuntimeV2EvidenceReference } from "./contracts";
import type { RuntimeV2Event } from "./events";
import { approvedRuntimeV2PlanContinuation } from "./planContinuationBaseline";
import { collectRuntimeV2PlanMutationTargets } from "./planExecution";
import type { RuntimeV2SubagentFindingV1 } from "./subagentReport";
import {
  runtimeV2DirectExecuteMutationTargets,
  runtimeV2ValidationBoundaryMatchesCurrent,
  runtimeV2WorkspaceChangeReceipts,
} from "./validationReceipt";
import { isRuntimeV2ValidationAttempt } from "./validationAttempt";

export const RESOLVE_RUNTIME_V2_REVIEW_FINDING_TOOL_NAME = "resolve_review_finding" as const;

export const MAX_REVIEW_REPAIR_ROUNDS = 2 as const;

export type RuntimeV2ReviewFindingSeverity = "blocking" | "advisory";

export type RuntimeV2ReviewFindingDispositionStatus =
  | "pending"
  | "repaired"
  | "falsified"
  | "deferred_unresolved";

export interface RuntimeV2ReviewFindingState {
  readonly findingId: string;
  readonly jobId: string;
  readonly scopeKey: string;
  readonly proactiveKey?: string;
  readonly severity: RuntimeV2ReviewFindingSeverity;
  readonly statement: string;
  readonly evidenceIds: readonly string[];
  readonly targetPaths: readonly string[];
  readonly criterionIds: readonly string[];
  readonly reportedAtSequence: number;
  readonly currentTargetHashes: Readonly<Record<string, string | null>>;
  readonly status: RuntimeV2ReviewFindingDispositionStatus;
  readonly breaksAcceptance: boolean;
  readonly dispositionSummary?: string;
  readonly verificationEvidenceIds: readonly string[];
  readonly dispositionSequence?: number;
}

export interface RuntimeV2ReviewDispositionLedger {
  readonly reviewJobCount: number;
  readonly reviewCompletedJobCount: number;
  readonly reviewDeliveredCount: number;
  readonly reviewAdoptedCount: number;
  readonly findings: readonly RuntimeV2ReviewFindingState[];
  readonly pendingBlockingFindings: readonly RuntimeV2ReviewFindingState[];
  readonly pendingAdvisoryFindings: readonly RuntimeV2ReviewFindingState[];
  readonly repairedFindings: readonly RuntimeV2ReviewFindingState[];
  readonly falsifiedFindings: readonly RuntimeV2ReviewFindingState[];
  readonly deferredUnresolvedFindings: readonly RuntimeV2ReviewFindingState[];
  readonly unresolvedFindings: readonly RuntimeV2ReviewFindingState[];
  readonly pendingBlockingCount: number;
  readonly breaksAcceptance: boolean;
  readonly repairRoundCount: number;
}

export interface ValidatedReviewFindingDisposition {
  readonly ok: true;
  readonly finding: RuntimeV2ReviewFindingState;
  readonly disposition: Exclude<RuntimeV2ReviewFindingDispositionStatus, "pending">;
  readonly summary: string;
  readonly targetPaths: readonly string[];
  readonly criterionIds: readonly string[];
  readonly verificationEvidenceIds: readonly string[];
  readonly targetHashes: Readonly<Record<string, string | null>>;
  readonly breaksAcceptance: boolean;
}

type FindingWithMetadata = RuntimeV2SubagentFindingV1 & {
  readonly id?: string;
  readonly severity?: RuntimeV2ReviewFindingSeverity;
  readonly targetPaths?: readonly string[];
  readonly criterionIds?: readonly string[];
};

const BLOCKING_MARKER_PATTERN = /(?:^|\s)\[BLOCKING\]/i;

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(
    value.map((entry) => (typeof entry === "string" ? entry.trim() : "")).filter(Boolean),
  )];
}

function isFileLikeTarget(target: string): boolean {
  const trimmed = target.trim();
  if (!trimmed || /^https?:/i.test(trimmed)) return false;
  return trimmed.includes("/") || /\.[A-Za-z0-9]{1,8}$/.test(trimmed);
}

function parseFindingSeverity(finding: FindingWithMetadata): RuntimeV2ReviewFindingSeverity {
  if (finding.severity === "blocking" || finding.severity === "advisory") {
    return finding.severity;
  }
  return BLOCKING_MARKER_PATTERN.test(finding.statement) ? "blocking" : "advisory";
}

function extractFindingTargets(input: {
  readonly finding: FindingWithMetadata;
  readonly evidenceById: ReadonlyMap<string, RuntimeV2EvidenceReference>;
  readonly allowedPaths: readonly string[];
}): readonly string[] {
  if (input.finding.targetPaths && input.finding.targetPaths.length > 0) {
    return [...new Set(input.finding.targetPaths.filter(Boolean))];
  }
  const targets: string[] = [];
  for (const id of input.finding.evidenceIds) {
    const item = input.evidenceById.get(id);
    if (
      item &&
      (item.kind === "source" || item.kind === "mutation" || isFileLikeTarget(item.target))
    ) {
      targets.push(item.target);
    }
  }
  if (targets.length === 0) {
    for (const candidate of input.allowedPaths) {
      if (candidate && input.finding.statement.includes(candidate)) {
        targets.push(candidate);
      }
    }
  }
  if (targets.length === 0 && input.allowedPaths.length === 1 && input.allowedPaths[0]) {
    targets.push(input.allowedPaths[0]);
  }
  return [...new Set(targets)];
}

function buildCurrentVersionMap(aggregate: TurnAggregateV1): {
  readonly versions: ReadonlyArray<{ readonly target: string; readonly version: string | null; readonly sequence: number }>;
  readonly mutationSequenceByTarget: ReadonlyArray<{ readonly target: string; readonly sequence: number; readonly version: string | null }>;
} {
  const latestByTarget: { target: string; version: string | null; sequence: number }[] = [];
  const mutationByTarget: { target: string; version: string | null; sequence: number }[] = [];
  const upsert = (
    list: { target: string; version: string | null; sequence: number }[],
    target: string,
    version: string | null,
    sequence: number,
  ) => {
    const existing = list.find((entry) => workspacePathsReferToSameFile(entry.target, target));
    if (existing) {
      if (sequence >= existing.sequence) {
        existing.version = version;
        existing.sequence = sequence;
      }
    } else {
      list.push({ target, version, sequence });
    }
  };

  const continuation = approvedRuntimeV2PlanContinuation(aggregate.events)?.continuation;
  for (const carried of continuation?.carriedTargets || []) {
    upsert(latestByTarget, carried.target, carried.version, 0);
  }
  const writeReceiptIds = new Set(
    runtimeV2WorkspaceChangeReceipts(aggregate).map((event) => event.eventId),
  );
  for (const event of aggregate.events) {
    if (event.type === "observation.recorded" && event.evidence.kind === "source") {
      upsert(latestByTarget, event.evidence.target, event.evidence.version, event.sequence);
      continue;
    }
    if (event.type === "tool.completed" && event.status === "succeeded") {
      for (const ev of event.evidence) {
        if (ev.kind === "source") {
          upsert(latestByTarget, ev.target, ev.version, event.sequence);
        } else if (ev.kind === "mutation" && writeReceiptIds.has(event.eventId)) {
          upsert(latestByTarget, ev.target, ev.version, event.sequence);
          upsert(mutationByTarget, ev.target, ev.version, event.sequence);
        }
      }
      continue;
    }
    if (
      event.type === "subagent.completed" &&
      event.status === "completed" &&
      writeReceiptIds.has(event.eventId)
    ) {
      for (const ev of event.evidence) {
        if (ev.kind === "mutation") {
          upsert(latestByTarget, ev.target, ev.version, event.sequence);
          upsert(mutationByTarget, ev.target, ev.version, event.sequence);
        }
      }
    }
  }
  return { versions: latestByTarget, mutationSequenceByTarget: mutationByTarget };
}

function lookupTargetVersion(
  list: ReadonlyArray<{ readonly target: string; readonly version: string | null }>,
  target: string,
): string | null {
  return list.find((entry) => workspacePathsReferToSameFile(entry.target, target))?.version ?? null;
}

function targetHashesForPaths(
  paths: readonly string[],
  versions: ReadonlyArray<{ readonly target: string; readonly version: string | null }>,
): Readonly<Record<string, string | null>> {
  const result: Record<string, string | null> = {};
  for (const path of paths) {
    result[path] = lookupTargetVersion(versions, path);
  }
  return result;
}

function commandArgumentsByKey(
  aggregate: TurnAggregateV1,
): ReadonlyMap<string, Readonly<Record<string, unknown>>> {
  const result = new Map<string, Readonly<Record<string, unknown>>>();
  for (const event of aggregate.events) {
    if (event.type === "command.scheduled" && event.command.kind === "execute_tool") {
      const args = event.command.payload.arguments;
      if (args && typeof args === "object" && !Array.isArray(args)) {
        result.set(event.command.idempotencyKey, args as Readonly<Record<string, unknown>>);
      }
    }
  }
  return result;
}

function parseJsonObject(raw: string | undefined): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

const dispositionLedgerCache = new WeakMap<TurnAggregateV1, RuntimeV2ReviewDispositionLedger>();

export function deriveRuntimeV2ReviewDispositionLedger(
  aggregate: TurnAggregateV1 | null | undefined,
): RuntimeV2ReviewDispositionLedger {
  if (!aggregate) {
    return {
      reviewJobCount: 0,
      reviewCompletedJobCount: 0,
      reviewDeliveredCount: 0,
      reviewAdoptedCount: 0,
      findings: [],
      pendingBlockingFindings: [],
      pendingAdvisoryFindings: [],
      repairedFindings: [],
      falsifiedFindings: [],
      deferredUnresolvedFindings: [],
      unresolvedFindings: [],
      pendingBlockingCount: 0,
      breaksAcceptance: false,
      repairRoundCount: 0,
    };
  }
  const cached = dispositionLedgerCache.get(aggregate);
  if (cached) return cached;

  const reviewJobs = (aggregate.subagents || []).filter((job) => job.taskKind === "review");
  const reviewJobById = new Map(reviewJobs.map((job) => [job.id, job]));
  const evidenceById = new Map<string, RuntimeV2EvidenceReference>();
  for (const ev of aggregate.evidence || []) evidenceById.set(ev.id, ev);

  const completedByJob = new Map<
    string,
    Extract<RuntimeV2Event, { type: "subagent.completed" }>
  >();
  const deliveredReviewJobIds = new Set<string>();
  const appliedReviewJobIds = new Set<string>();
  for (const event of aggregate.events || []) {
    if (event.type === "subagent.completed" && reviewJobById.has(event.jobId)) {
      completedByJob.set(event.jobId, event);
      for (const ev of [...event.evidence, ...(event.inheritedEvidence || [])]) {
        evidenceById.set(ev.id, ev);
      }
    } else if (event.type === "subagent.handoff_delivered" && reviewJobById.has(event.jobId)) {
      deliveredReviewJobIds.add(event.jobId);
    } else if (event.type === "subagent.handoff_applied" && reviewJobById.has(event.jobId)) {
      appliedReviewJobIds.add(event.jobId);
    }
  }

  const { versions } = buildCurrentVersionMap(aggregate);
  const rawFindings: RuntimeV2ReviewFindingState[] = [];
  for (const job of reviewJobs) {
    if (job.status !== "completed" || !job.report) continue;
    const completedEvent = completedByJob.get(job.id);
    const reportedAtSequence = completedEvent?.sequence ?? 0;
    job.report.findings.forEach((rawFinding, index) => {
      const finding = rawFinding as FindingWithMetadata;
      const findingId = finding.id?.trim() || `${job.id}:f${index + 1}`;
      const targetPaths = extractFindingTargets({
        finding,
        evidenceById,
        allowedPaths: job.allowedPaths,
      });
      rawFindings.push({
        findingId,
        jobId: job.id,
        scopeKey: job.scopeKey,
        ...(job.proactiveKey ? { proactiveKey: job.proactiveKey } : {}),
        severity: parseFindingSeverity(finding),
        statement: finding.statement,
        evidenceIds: [...finding.evidenceIds],
        targetPaths,
        criterionIds: [...(finding.criterionIds || [])],
        reportedAtSequence,
        currentTargetHashes: targetHashesForPaths(targetPaths, versions),
        status: "pending",
        breaksAcceptance: false,
        verificationEvidenceIds: [],
      });
    });
  }

  const argsByKey = commandArgumentsByKey(aggregate);
  const dispositionsByFindingId = new Map<
    string,
    {
      readonly status: Exclude<RuntimeV2ReviewFindingDispositionStatus, "pending">;
      readonly summary: string;
      readonly verificationEvidenceIds: readonly string[];
      readonly targetPaths: readonly string[];
      readonly criterionIds: readonly string[];
      readonly breaksAcceptance: boolean;
      readonly sequence: number;
      readonly jobId: string;
    }
  >();

  for (const event of aggregate.events) {
    if (
      event.type !== "tool.completed" ||
      event.status !== "succeeded" ||
      event.operationName !== "resolve_review_finding"
    ) {
      continue;
    }
    const receiptJson = parseJsonObject(event.modelContent);
    const args = argsByKey.get(event.idempotencyKey);
    const findingId = String(
      receiptJson?.finding_id ?? args?.finding_id ?? args?.findingId ?? "",
    ).trim();
    const disposition = String(
      receiptJson?.disposition ?? args?.disposition ?? "",
    ).trim();
    if (
      !findingId ||
      (disposition !== "repaired" &&
        disposition !== "falsified" &&
        disposition !== "deferred_unresolved")
    ) {
      continue;
    }
    const targetFinding = rawFindings.find((item) => item.findingId === findingId);
    if (!targetFinding) continue;
    dispositionsByFindingId.set(findingId, {
      status: disposition,
      summary: String(receiptJson?.summary ?? args?.summary ?? args?.reason ?? "").trim(),
      verificationEvidenceIds: stringList(
        receiptJson?.verification_evidence_ids ??
          args?.verification_evidence_ids ??
          args?.verificationEvidenceIds,
      ),
      targetPaths: stringList(receiptJson?.target_paths ?? args?.target_paths ?? args?.targetPaths),
      criterionIds: stringList(receiptJson?.criterion_ids ?? args?.criterion_ids ?? args?.criterionIds),
      breaksAcceptance:
        disposition === "deferred_unresolved" &&
        Boolean(receiptJson?.breaks_acceptance ?? args?.breaks_acceptance ?? args?.breaksAcceptance),
      sequence: event.sequence,
      jobId: targetFinding.jobId,
    });
    appliedReviewJobIds.add(targetFinding.jobId);
  }

  const findings = rawFindings.map((finding): RuntimeV2ReviewFindingState => {
    const applied = dispositionsByFindingId.get(finding.findingId);
    if (!applied || applied.sequence <= finding.reportedAtSequence) return finding;
    return {
      ...finding,
      status: applied.status,
      breaksAcceptance: applied.breaksAcceptance,
      dispositionSummary: applied.summary,
      verificationEvidenceIds: applied.verificationEvidenceIds,
      targetPaths: applied.targetPaths.length > 0 ? applied.targetPaths : finding.targetPaths,
      criterionIds: applied.criterionIds.length > 0 ? applied.criterionIds : finding.criterionIds,
      dispositionSequence: applied.sequence,
    };
  });

  const firstBlockingSeq = findings
    .filter((item) => item.severity === "blocking")
    .reduce((min, item) => Math.min(min, item.reportedAtSequence), Number.POSITIVE_INFINITY);
  const repairMutations = Number.isFinite(firstBlockingSeq)
    ? runtimeV2WorkspaceChangeReceipts(aggregate).filter(
        (event) => event.sequence > firstBlockingSeq,
      ).length
    : 0;

  const pendingBlockingFindings = findings.filter(
    (item) => item.status === "pending" && item.severity === "blocking",
  );
  const pendingAdvisoryFindings = findings.filter(
    (item) => item.status === "pending" && item.severity === "advisory",
  );
  const repairedFindings = findings.filter((item) => item.status === "repaired");
  const falsifiedFindings = findings.filter((item) => item.status === "falsified");
  const deferredUnresolvedFindings = findings.filter(
    (item) => item.status === "deferred_unresolved",
  );
  const unresolvedFindings = [...pendingBlockingFindings, ...deferredUnresolvedFindings];

  const ledger: RuntimeV2ReviewDispositionLedger = {
    reviewJobCount: reviewJobs.length,
    reviewCompletedJobCount: completedByJob.size,
    reviewDeliveredCount:
      deliveredReviewJobIds.size > 0 ? deliveredReviewJobIds.size : completedByJob.size,
    reviewAdoptedCount: appliedReviewJobIds.size,
    findings,
    pendingBlockingFindings,
    pendingAdvisoryFindings,
    repairedFindings,
    falsifiedFindings,
    deferredUnresolvedFindings,
    unresolvedFindings,
    pendingBlockingCount: pendingBlockingFindings.length,
    breaksAcceptance: deferredUnresolvedFindings.some((item) => item.breaksAcceptance),
    repairRoundCount: Math.max(repairMutations, repairedFindings.length),
  };
  dispositionLedgerCache.set(aggregate, ledger);
  return ledger;
}

function eventSequenceForEvidenceId(
  aggregate: TurnAggregateV1,
  evidenceId: string,
): number {
  for (const event of aggregate.events) {
    if (
      (event.type === "observation.recorded" && event.evidence.id === evidenceId) ||
      ((event.type === "tool.completed" ||
        event.type === "validation.completed" ||
        event.type === "subagent.completed") &&
        event.evidence.some((item) => item.id === evidenceId))
    ) {
      return event.sequence;
    }
  }
  return -1;
}

export function validateResolveReviewFindingCall(input: {
  readonly aggregate: TurnAggregateV1;
  readonly args: Readonly<Record<string, unknown>>;
}): ValidatedReviewFindingDisposition | { readonly ok: false; readonly message: string } {
  const ledger = deriveRuntimeV2ReviewDispositionLedger(input.aggregate);
  const findingId = String(input.args.finding_id ?? input.args.findingId ?? "").trim();
  const disposition = String(input.args.disposition ?? "").trim();
  const summary = String(input.args.summary ?? input.args.reason ?? "").trim();
  if (!findingId) {
    return { ok: false, message: "resolve_review_finding requires finding_id." };
  }
  const finding = ledger.findings.find((item) => item.findingId === findingId);
  if (!finding) {
    return {
      ok: false,
      message: `Unknown finding_id "${findingId}". Available finding_ids: ${ledger.findings.map((f) => f.findingId).join(", ") || "none"}.`,
    };
  }
  if (
    disposition !== "repaired" &&
    disposition !== "falsified" &&
    disposition !== "deferred_unresolved"
  ) {
    return {
      ok: false,
      message: 'resolve_review_finding disposition must be "repaired", "falsified", or "deferred_unresolved".',
    };
  }
  if (!summary) {
    return {
      ok: false,
      message: "resolve_review_finding requires a non-empty summary explaining the disposition.",
    };
  }

  const evidenceIds = stringList(
    input.args.verification_evidence_ids ?? input.args.verificationEvidenceIds,
  );
  const targetPathsArg = stringList(input.args.target_paths ?? input.args.targetPaths);
  const criterionIdsArg = stringList(input.args.criterion_ids ?? input.args.criterionIds);
  const effectiveTargets = targetPathsArg.length > 0 ? targetPathsArg : finding.targetPaths;
  const effectiveCriteria = criterionIdsArg.length > 0 ? criterionIdsArg : finding.criterionIds;

  const evidenceMap = new Map(input.aggregate.evidence.map((item) => [item.id, item]));
  for (const id of evidenceIds) {
    if (!evidenceMap.has(id)) {
      return {
        ok: false,
        message: `resolve_review_finding references unknown verification_evidence_id "${id}".`,
      };
    }
  }

  const { versions } = buildCurrentVersionMap(input.aggregate);
  const targetHashes = targetHashesForPaths(effectiveTargets, versions);

  if (disposition === "repaired") {
    const postFindingMutations = runtimeV2WorkspaceChangeReceipts(input.aggregate).filter(
      (event) => event.sequence > finding.reportedAtSequence,
    );
    const matchingMutationIds = new Set<string>();
    for (const event of postFindingMutations) {
      for (const ev of event.evidence) {
        if (ev.kind !== "mutation") continue;
        const explicit = evidenceIds.includes(ev.id);
        const targetMatch =
          effectiveTargets.length === 0 ||
          effectiveTargets.some((target) => workspacePathsReferToSameFile(target, ev.target));
        if (explicit || (evidenceIds.length === 0 && targetMatch)) {
          matchingMutationIds.add(ev.id);
        }
      }
    }
    if (matchingMutationIds.size === 0) {
      return {
        ok: false,
        message:
          'Disposition "repaired" requires committed workspace mutation evidence produced after the finding was reported.',
      };
    }
    return {
      ok: true,
      finding,
      disposition,
      summary,
      targetPaths: effectiveTargets,
      criterionIds: effectiveCriteria,
      verificationEvidenceIds: [...new Set([...evidenceIds, ...matchingMutationIds])],
      targetHashes,
      breaksAcceptance: false,
    };
  }

  if (disposition === "falsified") {
    const backingIds = evidenceIds.filter((id) => {
      const ev = evidenceMap.get(id);
      return ev?.kind === "source" || ev?.kind === "validation";
    });
    if (backingIds.length === 0) {
      return {
        ok: false,
        message:
          'Disposition "falsified" requires citing current-hash "source" or passing "validation" verification_evidence_ids.',
      };
    }
    for (const id of backingIds) {
      const ev = evidenceMap.get(id)!;
      if (ev.kind === "source") {
        const currentHash = lookupTargetVersion(versions, ev.target);
        if (!ev.version || (currentHash && ev.version !== currentHash)) {
          return {
            ok: false,
            message: `Source evidence "${id}" for ${ev.target} is stale and does not match the current workspace file version.`,
          };
        }
      } else if (ev.kind === "validation") {
        const seq = eventSequenceForEvidenceId(input.aggregate, id);
        const valEvent = input.aggregate.events.find(
          (event): event is Extract<RuntimeV2Event, { type: "validation.completed" }> =>
            event.sequence === seq && isRuntimeV2ValidationAttempt(event),
        );
        if (
          !valEvent ||
          !valEvent.passed ||
          !runtimeV2ValidationBoundaryMatchesCurrent({
            aggregate: input.aggregate,
            targetPaths: valEvent.authority?.targetPaths || effectiveTargets,
            mutationBoundarySequence: valEvent.mutationBoundarySequence,
            validatedMutationVersions: valEvent.validatedMutationVersions,
          })
        ) {
          return {
            ok: false,
            message: `Validation evidence "${id}" is not a passing validation for the current workspace revision.`,
          };
        }
      }
    }
    return {
      ok: true,
      finding,
      disposition,
      summary,
      targetPaths: effectiveTargets,
      criterionIds: effectiveCriteria,
      verificationEvidenceIds: evidenceIds,
      targetHashes,
      breaksAcceptance: false,
    };
  }

  const breaksAcceptanceRaw = input.args.breaks_acceptance ?? input.args.breaksAcceptance;
  if (typeof breaksAcceptanceRaw !== "boolean") {
    return {
      ok: false,
      message:
        'Disposition "deferred_unresolved" requires boolean breaks_acceptance indicating whether this defect prevents the approved acceptance criteria from holding.',
    };
  }
  return {
    ok: true,
    finding,
    disposition,
    summary,
    targetPaths: effectiveTargets,
    criterionIds: effectiveCriteria,
    verificationEvidenceIds: evidenceIds,
    targetHashes,
    breaksAcceptance: breaksAcceptanceRaw,
  };
}

function approvedPlanSequence(aggregate: TurnAggregateV1): number {
  for (let index = aggregate.events.length - 1; index >= 0; index -= 1) {
    const event = aggregate.events[index];
    if (event?.type === "work_plan.approved") return event.sequence;
  }
  return -1;
}

/** Pre-authorized same-turn defect correction applies ONLY to new plans carrying
 * `sameTurnDefectCorrection === "authorized"` and ONLY to approved plan targets
 * created or modified during this approved turn when a blocking review finding
 * exists against that target (capped at MAX_REVIEW_REPAIR_ROUNDS). */
export function isApprovedSameTurnDefectCorrection(input: {
  readonly aggregate: TurnAggregateV1 | null | undefined;
  readonly targetPath: string;
  readonly operation?: "create" | "modify" | "delete" | null;
}): boolean {
  const aggregate = input.aggregate;
  const plan = aggregate?.sealedWorkPlan;
  if (
    !aggregate ||
    aggregate.strategy !== "plan" ||
    aggregate.workPlan?.status !== "approved" ||
    !aggregate.planReviewCommit ||
    !plan ||
    plan.draft.sameTurnDefectCorrection !== "authorized" ||
    input.operation === "delete"
  ) {
    return false;
  }
  const plannedTargets = collectRuntimeV2PlanMutationTargets(plan);
  if (!plannedTargets.some((target) => workspacePathsReferToSameFile(target, input.targetPath))) {
    return false;
  }
  const approvedSeq = approvedPlanSequence(aggregate);
  const mutatedInThisTurn = runtimeV2WorkspaceChangeReceipts(aggregate).some(
    (event) =>
      event.sequence > approvedSeq &&
      event.evidence.some(
        (ev) => ev.kind === "mutation" && workspacePathsReferToSameFile(ev.target, input.targetPath),
      ),
  );
  if (!mutatedInThisTurn) return false;

  const ledger = deriveRuntimeV2ReviewDispositionLedger(aggregate);
  if (ledger.repairRoundCount >= MAX_REVIEW_REPAIR_ROUNDS) return false;

  return ledger.pendingBlockingFindings.some((finding) => {
    if (finding.targetPaths.some((target) => workspacePathsReferToSameFile(target, input.targetPath))) {
      return true;
    }
    return finding.statement.includes(input.targetPath) ||
      runtimeV2DirectExecuteMutationTargets(aggregate).some((t) =>
        workspacePathsReferToSameFile(t, input.targetPath) && finding.statement.includes(t),
      );
  });
}
