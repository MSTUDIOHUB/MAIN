import type { TurnAggregateV1 } from "./aggregate";
import type {
  RuntimeV2EvidenceReference,
  RuntimeV2RunIdentity,
  RuntimeV2SubagentJob,
} from "./contracts";
import type { RuntimeV2Event } from "./events";
import { validateRuntimeV2SubagentReport } from "./subagentReport";
import { buildPlanDecisionJournal } from "../planDecisionJournal";
import { samePlanDocumentRef } from "../planDocuments";
import { normalizePlanDraftRecord } from "../planDrafts";
import { resolveSessionWorkspaceKey } from "../sessionTypes";
import { sha256Hex } from "../sha256";
import { isWorkPlanArtifactProjectionBound } from "./workPlan";
import { isValidRuntimeV2PlanContinuation } from "./planContinuation";

export function appendNovelRuntimeV2Evidence(
  existing: readonly RuntimeV2EvidenceReference[],
  additions: readonly RuntimeV2EvidenceReference[],
): readonly RuntimeV2EvidenceReference[] {
  const next = [...existing];
  const known = new Set(existing.map((item) =>
    `${item.id}\u0000${item.target}\u0000${item.version || ""}`
  ));
  for (const evidence of additions) {
    const key =
      `${evidence.id}\u0000${evidence.target}\u0000${evidence.version || ""}`;
    if (known.has(key)) continue;
    known.add(key);
    next.push(evidence);
  }
  return next;
}

export function isValidRuntimeV2SubagentCompletion(input: {
  readonly state: TurnAggregateV1;
  readonly event: Extract<
    RuntimeV2Event,
    { readonly type: "subagent.completed" }
  >;
  readonly job: RuntimeV2SubagentJob;
}): boolean {
  const inheritedEvidence = input.event.inheritedEvidence || [];
  const eventEvidence = [...input.event.evidence, ...inheritedEvidence];
  const eventEvidenceIds = eventEvidence.map((item) => item.id);
  const eventEvidenceIdsAreUnique =
    new Set(eventEvidenceIds).size === eventEvidenceIds.length;
  const childEvidenceIdsKeepExistingMeaning = input.event.evidence.every(
    (item) =>
      !input.state.evidence.some((known) =>
        known.id === item.id &&
        (
          known.kind !== item.kind ||
          known.target !== item.target ||
          known.version !== item.version
        )
      ),
  );
  const known = new Map(input.state.evidence.map((item) => [item.id, item]));
  const inheritedIsKnown = inheritedEvidence.every((item) => {
    const candidate = known.get(item.id);
    return candidate?.kind === item.kind &&
      candidate.target === item.target &&
      candidate.version === item.version;
  });
  const mutationEvidence = input.event.evidence.filter((item) =>
    item.kind === "mutation"
  );
  const writeJob = input.job.taskKind === "implement" &&
    input.job.accessMode === "write";
  const mutationScopeValid = mutationEvidence.every((item) =>
    input.job.allowedPaths.some((path) =>
      item.target === path || item.target.startsWith(`${path.replace(/\/$/, "")}/`)
    )
  );
  const interrupted = input.event.resourceInterruption === "memory" || input.event.resourceInterruption === "provider_capacity";
  return eventEvidenceIdsAreUnique &&
    childEvidenceIdsKeepExistingMeaning &&
    inheritedIsKnown &&
    mutationScopeValid &&
    (writeJob || mutationEvidence.length === 0) &&
    (
      input.event.status !== "completed" ||
      !writeJob ||
      mutationEvidence.length > 0
    ) &&
    (
      input.event.status !== "completed" ||
      validateRuntimeV2SubagentReport({
        report: input.event.report,
        evidence: input.event.evidence,
        inheritedEvidence,
      })
    ) &&
    (!input.event.resourceInterruption || interrupted && input.event.status === "degraded") &&
    (input.event.status !== "degraded" || input.event.evidence.length > 0 || interrupted);
}

export function isValidRuntimeV2SubagentJob(
  job: RuntimeV2SubagentJob,
  parent: RuntimeV2RunIdentity,
): boolean {
  return !!job.id &&
    job.parentRunId === parent.runId &&
    job.run.parentRunId === parent.runId &&
    job.run.sessionKey === parent.sessionKey &&
    job.run.sessionEpoch === parent.sessionEpoch &&
    job.run.turnId === parent.turnId &&
    !!job.scopeKey &&
    !!job.objective &&
    job.allowedPaths.length > 0 &&
    (!job.proactiveKey || (!job.sourceToolCallId && job.accessMode === "read" && job.taskKind !== "implement")) &&
    (
      job.taskKind === "implement"
        ? job.accessMode === "write" &&
          !!job.implementationOperation &&
          !!job.implementationPlan &&
          !job.allowedPaths.includes(".")
        : (job.accessMode || "read") === "read"
    ) &&
    job.status === "queued" &&
    job.firstTokenAt === null &&
    job.closedAt === null &&
    job.summary === null;
}

export function isValidRuntimeV2PlanDraftSourceAdmission(event: Extract<RuntimeV2Event, { type: "turn.admitted" }>): boolean {
  if (event.sourcePlanDraft === undefined) return true;
  const record = normalizePlanDraftRecord(event.sourcePlanDraft);
  return !!record && event.strategy === "plan" && event.planPurpose !== "rules" && record.documentRef.kind === "plan" &&
    record.documentRef.owner.sessionKey === event.turn.sessionKey && record.documentRef.owner.sessionEpoch === event.turn.sessionEpoch &&
    record.documentRef.owner.turnId !== event.turn.turnId && resolveSessionWorkspaceKey(record.documentRef.owner.workspace) === event.turn.workspaceKey;
}

/** Only a runtime-authored exact-document observation can satisfy a selected
 * draft's information-confirmation boundary. It grants no approval. */
export function isValidRuntimeV2PlanDraftSourceObservation(state: TurnAggregateV1,
  event: Extract<RuntimeV2Event, { type: "observation.recorded" }>): boolean {
  const admission = state.events.find(item => item.type === "turn.admitted");
  if (admission?.type !== "turn.admitted" || !admission.sourcePlanDraft || !isValidRuntimeV2PlanDraftSourceAdmission(admission)) return false;
  const admitted = normalizePlanDraftRecord(admission.sourcePlanDraft);
  const observed = normalizePlanDraftRecord(event.sourcePlanDraft);
  if (!admitted || !observed || JSON.stringify(admitted) !== JSON.stringify(observed) || event.evidence.id !== "plan-draft-source" ||
    event.evidence.kind !== "tool" || event.evidence.target !== admitted.documentRef.path || event.evidence.version !== admitted.documentRef.contentHash ||
    !event.modelContent) return false;
  try {
    const context = JSON.parse(event.modelContent).sourcePlanDraftContext;
    return !!context && samePlanDocumentRef(context.documentRef, admitted.documentRef) && typeof context.markdown === "string" &&
      sha256Hex(context.markdown) === admitted.documentRef.contentHash && JSON.stringify(context.diagnostics) === JSON.stringify(admitted.diagnostics) &&
      (context.confirmedChoices === undefined || typeof context.confirmedChoices === "string" && !!context.confirmedChoices.trim() &&
        context.markdown.includes(context.confirmedChoices));
  } catch { return false; }
}

export function hasMatchingRuntimeV2SealedPlanAuthority(input: {
  readonly event: Extract<
    RuntimeV2Event,
    { readonly type: "work_plan.sealed" }
  >;
  readonly state: TurnAggregateV1;
}): boolean {
  const { event, state } = input;
  const plan = event.sealedPlan;
  const commit = event.reviewCommit;
  const hasDraftSourceAdmission = state.events.some(event => event.type === "turn.admitted" && !!event.sourcePlanDraft);
  const draftSource = state.events.find(event => event.type === "observation.recorded" &&
    event.evidence.id === "plan-draft-source" && isValidRuntimeV2PlanDraftSourceObservation(state, event));
  const derivedFrom = draftSource?.type === "observation.recorded" ? draftSource.sourcePlanDraft?.documentRef : undefined;
  const initialQuestion = state.events.find(event => event.type === "run.paused" && event.blocker.questionnaire?.purpose === "plan_confirmation");
  const interviewed = hasDraftSourceAdmission ? !!derivedFrom : state.planPurpose === undefined || (state.planPurpose === "plan" && initialQuestion?.type === "run.paused" &&
    state.events.some(event => event.type === "run.decision_recorded" && event.requestId === initialQuestion.blocker.requestId && event.choice !== "stop" &&
      event.answer?.answers.some(answer => answer.questionId === "result_kind" && answer.selectedValues.includes("executable"))));
  const savedDocument = !commit.artifact.documentRef ? !derivedFrom : state.events.some(receipt => {
    if (receipt.type !== "tool.completed" || receipt.status !== "succeeded" || !receipt.modelContent) return false;
    const command = state.events.find(event => event.type === "command.scheduled" && event.command.idempotencyKey === receipt.idempotencyKey);
    if (command?.type !== "command.scheduled" || command.command.payload.toolName !== "save_plan_document" || command.command.payload.runtimeOwnedPlanArtifact !== true) return false;
    try {
      const record = JSON.parse(receipt.modelContent);
      return record.markdown === plan.markdown && samePlanDocumentRef(record.planDocument, commit.artifact.documentRef) &&
        (!derivedFrom || samePlanDocumentRef(command.command.payload.derivedFrom as typeof derivedFrom, derivedFrom) && samePlanDocumentRef(record.derivedFrom, derivedFrom));
    } catch { return false; }
  });
  const journal = buildPlanDecisionJournal(state);
  const journalMatches = derivedFrom ? plan.decisionJournal === journal :
    plan.decisionJournal === undefined && state.planPurpose === undefined || typeof plan.decisionJournal === "string" && plan.decisionJournal === journal;
  const ready = event.continuation !== undefined
    ? isValidRuntimeV2PlanContinuation(state, event)
    : interviewed && journalMatches && savedDocument;
  return ready && plan.status === "pending_review" &&
    event.workPlan.id === plan.id &&
    event.workPlan.revision === plan.revision &&
    event.workPlan.digest === plan.digest &&
    event.workPlan.projectionHash === plan.projectionHash &&
    commit.schemaVersion === "runtime-v2-plan-review-commit.v1" &&
    commit.authority.id === plan.id &&
    commit.authority.revision === plan.revision &&
    commit.authority.digest === plan.digest &&
    commit.authority.projectionHash === plan.projectionHash &&
    isWorkPlanArtifactProjectionBound(commit.artifact, plan, state.turn) &&
    commit.artifact.content === plan.markdown &&
    commit.artifact.projectionHash === plan.projectionHash &&
    commit.panel.markdown === plan.markdown &&
    commit.review.requestId.trim().length > 0 &&
    commit.review.sessionKey === state.turn.sessionKey &&
    commit.review.sessionEpoch === state.turn.sessionEpoch &&
    commit.review.turnId === state.turn.turnId &&
    commit.review.runId === event.run.runId &&
    commit.review.parentRunId === event.run.parentRunId;
}
