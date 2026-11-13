import { getFileMetadata, readFileWindow, readPlanDocument } from "../../lib/ipc";
import { samePlanDocumentRef } from "../../lib/planDocuments";
import type { PlanContinuationCandidate } from "../../lib/runIntent";
import {
  deriveRuntimeV2PlanExecutionCoverage,
  normalizeRuntimeV2Checkpoint,
  resolveRuntimeV2PlanContinuationPostImages,
  type ApprovedWorkPlanContinuationReference,
  type RuntimeV2PlanContinuation,
  type RuntimeV2TurnIdentity,
  type TurnAggregateV1,
} from "../../lib/runtime-v2";
import type { RuntimeV2PlanAuthority } from "../../lib/runtime-v2/workPlan";
import { resolveSessionRuntimeKey, resolveSessionWorkspaceKey } from "../../lib/sessionTypes";
import { sha256Hex } from "../../lib/sha256";
import { normalizeValidationWorkspaceCwd } from "../../lib/validationContract";
import { approvedPlanExecutionRepair, unresolvedUnityEditorCheck } from "../../lib/runtime-v2/unityCompilation";
import { resolveRuntimeV2SessionEpoch } from "./sessionIdentity";
import { resolveHistoricalRuntimeV2ApprovedWorkPlan } from "./workPlanAdapter";

export function getApprovedWorkPlanContinuationCandidates(state: any): PlanContinuationCandidate[] {
  const scope = resolveSessionWorkspaceKey(state.currentWorkspace);
  const sessionKey = resolveSessionRuntimeKey(scope, state.currentSessionId);
  if (!state.currentWorkspace || !sessionKey) return [];
  const seen = new Set<string>();
  return [...(state.conversationTurns || [])].reverse().flatMap((turn: any): PlanContinuationCandidate[] => {
    if (seen.size >= 6 || turn.uiVisibility === "internal") return [];
    let sessionEpoch: string;
    try {
      sessionEpoch = resolveRuntimeV2SessionEpoch(state, {
        runScopeKey: scope, runSessionKey: sessionKey, runSessionId: state.currentSessionId,
      }, turn);
    } catch { return []; }
    const aggregate = normalizeRuntimeV2Checkpoint(state.runtimeV2Checkpoints?.[turn.id], {
      workspaceKey: scope, sessionKey, sessionEpoch, turnId: turn.id,
    })?.aggregate;
    const workPlan = aggregate?.workPlan;
    if (!aggregate || !workPlan || seen.has(workPlan.id)) return [];
    seen.add(workPlan.id);
    const status = workPlan.status === "pending_review" ? "review"
      : workPlan.status !== "approved" ? "draft"
        : getContinuableApprovedWorkPlan(state, turn.id) ? "canceled"
          : aggregate.run?.status === "paused" ? "paused" : "completed";
    return [{
      id: turn.id as string,
      title: typeof turn.title === "string" ? turn.title.slice(0, 120) : undefined,
      objective: aggregate.objective.text.slice(0, 500),
      status,
    }];
  });
}

export function getApprovedWorkPlanContinuationIssues(state: any, sourceTurnId: string): readonly string[] {
  const source = getContinuableApprovedWorkPlan(state, sourceTurnId);
  if (!source) return [];
  for (const turn of [...(state.conversationTurns || [])].reverse()) {
    if (turn.id !== sourceTurnId && (turn.approvedPlanContinuation?.turn?.turnId !== sourceTurnId ||
        turn.approvedPlanContinuation.approvalEventId !== source.reference.approvalEventId)) continue;
    const aggregate = normalizeRuntimeV2Checkpoint(state.runtimeV2Checkpoints?.[turn.id], {
      workspaceKey: source.reference.turn.workspaceKey, sessionKey: source.reference.turn.sessionKey,
      sessionEpoch: source.reference.turn.sessionEpoch, turnId: turn.id,
    })?.aggregate;
    if (aggregate?.terminalOutcome?.resultKind === "blocked") {
      return aggregate.evidence.filter(evidence =>
        evidence.kind === "tool" && evidence.id.startsWith("approved-plan-drift:")
      ).map(evidence => evidence.target);
    }
  }
  return [];
}

export function getApprovedWorkPlanExecutionRepair(state: any, sourceTurnId: string) {
  const source = getContinuableApprovedWorkPlan(state, sourceTurnId);
  return source?.aggregate.terminalOutcome?.resultKind === "blocked"
    ? approvedPlanExecutionRepair(source.aggregate) : undefined;
}

export function sameWorkPlanAuthority(left: RuntimeV2PlanAuthority, right: RuntimeV2PlanAuthority) {
  return left.id === right.id && left.revision === right.revision &&
    left.digest === right.digest && left.projectionHash === right.projectionHash;
}

function sourceForOwner(state: any, owner: RuntimeV2TurnIdentity, targetTurnId?: string) {
  const checkpoint = normalizeRuntimeV2Checkpoint(state.runtimeV2Checkpoints?.[owner.turnId], owner);
  const aggregate = checkpoint?.aggregate;
  if (!checkpoint || !aggregate?.run) return null;
  const historical = resolveHistoricalRuntimeV2ApprovedWorkPlan(aggregate);
  if (!historical) return null;
  const coverage = deriveRuntimeV2PlanExecutionCoverage(aggregate);
  if (!coverage || (coverage.allMutationTargetsCovered && coverage.allRequiredValidationsPassed &&
      !unresolvedUnityEditorCheck(aggregate) && !approvedPlanExecutionRepair(aggregate))) return null;
  // A newer review or continuation owns this plan. A stale click on an old
  // card must not start parallel work against the same document.
  const superseded = Object.entries(state.runtimeV2Checkpoints || {}).some(([turnId, raw]) => {
    if (turnId === owner.turnId || turnId === targetTurnId) return false;
    const other = normalizeRuntimeV2Checkpoint(raw, {
      workspaceKey: owner.workspaceKey, sessionKey: owner.sessionKey, sessionEpoch: owner.sessionEpoch, turnId,
    })?.aggregate;
    if (!other || other.turn.turnId === owner.turnId) return false;
    return (other.workPlan?.id === historical.plan.id &&
      (other.workPlan.revision > historical.plan.revision ||
        (other.workPlan.revision === historical.plan.revision &&
          (other.events[0]?.at || 0) > (aggregate.events[0]?.at || 0)))) ||
      (other.planContinuation?.source.turn.turnId === owner.turnId);
  });
  if (superseded) return null;
  const reference: ApprovedWorkPlanContinuationReference = {
    turn: checkpoint.owner,
    approvalEventId: historical.approvalEvent.eventId,
    authority: historical.commit.authority,
  };
  return { ...historical, aggregate, coverage, reference };
}

export function getContinuableApprovedWorkPlan(state: any, sourceTurnId: string) {
  const scope = resolveSessionWorkspaceKey(state.currentWorkspace);
  const sessionKey = resolveSessionRuntimeKey(scope, state.currentSessionId);
  if (!state.currentWorkspace || !sessionKey) return null;
  const sourceTurn = state.conversationTurns?.find((turn: any) => turn.id === sourceTurnId);
  if (!sourceTurn) return null;
  try {
    const epoch = resolveRuntimeV2SessionEpoch(state, {
      runScopeKey: scope, runSessionKey: sessionKey, runSessionId: state.currentSessionId,
    }, sourceTurn);
    return sourceForOwner(state, {
      workspaceKey: scope, sessionKey, sessionEpoch: epoch, turnId: sourceTurnId,
      clientSubmissionId: sourceTurn.clientSubmissionId || sourceTurnId,
    });
  } catch {
    return null;
  }
}

export function resolveApprovedWorkPlanContinuation(
  state: any, reference: ApprovedWorkPlanContinuationReference, owner?: RuntimeV2TurnIdentity,
) {
  if (!reference?.turn || !reference.authority) return null;
  const source = owner
    ? reference.turn.workspaceKey === owner.workspaceKey &&
      reference.turn.sessionKey === owner.sessionKey &&
      reference.turn.sessionEpoch === owner.sessionEpoch &&
      reference.turn.turnId !== owner.turnId
      ? sourceForOwner(state, reference.turn, owner.turnId)
      : null
    : getContinuableApprovedWorkPlan(state, reference.turn.turnId);
  return source && source.reference.approvalEventId === reference.approvalEventId &&
    source.reference.turn.workspaceKey === reference.turn.workspaceKey &&
    source.reference.turn.sessionKey === reference.turn.sessionKey &&
    source.reference.turn.sessionEpoch === reference.turn.sessionEpoch &&
    source.reference.turn.clientSubmissionId === reference.turn.clientSubmissionId &&
    sameWorkPlanAuthority(source.reference.authority, reference.authority) ? source : null;
}

type ContinuationSource = NonNullable<ReturnType<typeof resolveApprovedWorkPlanContinuation>>;
type FileFact = { readonly target: string; readonly version: string | null | undefined };

export async function readApprovedPlanTargetVersion(target: string, workspace: string): Promise<string | null | undefined> {
  const path = normalizeValidationWorkspaceCwd(target, workspace);
  if (!path || path === ".") return undefined;
  try {
    const result = await readFileWindow(path, workspace, 1, 1, 1, 1);
    return /^sha256-[a-f0-9]{64}$/.test(result.contentVersion) ? result.contentVersion : undefined;
  } catch {
    try {
      await getFileMetadata(path, workspace);
      return undefined;
    } catch (error) {
      return String(error instanceof Error ? error.message : error).startsWith("FILE_METADATA_NOT_FOUND:")
        ? null : undefined;
    }
  }
}

async function mismatchedTargets(facts: readonly FileFact[], workspace: string, signal: AbortSignal) {
  const changed: string[] = [];
  for (const { target, version } of facts) {
    signal.throwIfAborted();
    if (version === undefined || await readApprovedPlanTargetVersion(target, workspace) !== version) changed.push(target);
  }
  signal.throwIfAborted();
  return changed;
}

export async function checkApprovedPlanArtifact(source: ContinuationSource, signal: AbortSignal) {
  const documentRef = source.commit.artifact.documentRef || source.aggregate.planContinuation?.source.documentRef;
  if (!documentRef) return [];
  signal.throwIfAborted();
  try {
    const current = await readPlanDocument(documentRef);
    signal.throwIfAborted();
    if (samePlanDocumentRef(current, documentRef) && sha256Hex(current.markdown) === documentRef.contentHash) return [];
  } catch {
    signal.throwIfAborted();
  }
  return [documentRef.path];
}

export async function verifyApprovedWorkPlanContinuation(source: ContinuationSource, workspace: string, signal: AbortSignal): Promise<
  { readonly changed: readonly string[] } | { readonly continuation: RuntimeV2PlanContinuation }
> {
  const artifactChanges = await checkApprovedPlanArtifact(source, signal);
  if (artifactChanges.length) return { changed: artifactChanges };
  const documentRef = source.commit.artifact.documentRef || source.aggregate.planContinuation?.source.documentRef;
  const committed = new Map(resolveRuntimeV2PlanContinuationPostImages(source.aggregate).map(entry =>
    [normalizeValidationWorkspaceCwd(entry.target, workspace), entry]));
  const carriedTargets: RuntimeV2PlanContinuation["carriedTargets"][number][] = [];
  const expected = new Map<string, FileFact>();
  const carriedPaths = new Set<string>();
  const completed = new Set(source.coverage.completedStepIndexes);
  const plan = source.plan;
  for (const [index, step] of plan.draft.steps.entries()) {
    for (const target of step.targets) {
      const path = normalizeValidationWorkspaceCwd(target, workspace);
      if (!path || path === ".") return { changed: [target] } as const;
      const previous = committed.get(path);
      if (completed.has(index)) {
        if (!previous || previous.version === undefined) {
          expected.set(path, { target, version: undefined });
          continue;
        }
        if (!carriedPaths.has(path)) {
          carriedPaths.add(path);
          carriedTargets.push({ target, version: previous.version, receiptId: previous.receiptId });
        }
        expected.set(path, { target, version: previous.version });
      } else if (!expected.has(path)) {
        // A partially committed multi-target step cannot be represented as a
        // completed step. Review it explicitly instead of repeating an effect.
        if (previous) {
          expected.set(path, { target, version: undefined });
          continue;
        }
        const versions = [...new Set(plan.evidence.filter((entry) =>
          step.basis.includes(entry.id) && normalizeValidationWorkspaceCwd(entry.target, workspace) === path && entry.version
        ).map((entry) => entry.version!))];
        expected.set(path, { target, version: step.operation === "create" ? null : versions.length === 1 ? versions[0] : undefined });
      } else if (step.operation === "create" && expected.get(path)!.version !== null) {
        expected.set(path, { target, version: undefined });
      }
    }
  }
  const changed = await mismatchedTargets([...expected.values()], workspace, signal);
  if (changed.length) return { changed } as const;
  const continuation: RuntimeV2PlanContinuation = {
    source: {
      turn: source.reference.turn,
      run: source.aggregate.run!.identity,
      approvalEventId: source.reference.approvalEventId,
      workPlan: source.approvalEvent.workPlan,
      ...(documentRef ? { documentRef } : {}),
      ...(!source.commit.artifact.documentRef && source.aggregate.planContinuation?.source.documentRef ? {
        documentTurn: source.aggregate.planContinuation.source.documentTurn || source.aggregate.planContinuation.source.turn,
      } : {}),
    },
    completedStepIndexes: source.coverage.completedStepIndexes,
    carriedTargets,
  };
  return { continuation } as const;
}

export async function checkCarriedWorkPlanTargets(aggregate: TurnAggregateV1, workspace: string, signal: AbortSignal) {
  const baseline = aggregate.planContinuation;
  if (!baseline) return [];
  const latest = new Map(resolveRuntimeV2PlanContinuationPostImages(aggregate).map(entry =>
    [normalizeValidationWorkspaceCwd(entry.target, workspace), entry.receiptId]));
  return mismatchedTargets(baseline.carriedTargets.filter((fact) =>
    latest.get(normalizeValidationWorkspaceCwd(fact.target, workspace)) === fact.receiptId
  ), workspace, signal);
}
