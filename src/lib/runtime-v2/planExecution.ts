import type { TurnAggregateV1 } from "./aggregate";
import type { RuntimeV2Event } from "./events";
import type { SealedWorkPlanV1, WorkPlanDraftV1 } from "./workPlan";
import type { RuntimeV2ExecutionValidationAuthority } from "./contracts";
import { runtimeV2ValidationBoundaryMatchesCurrent } from "./validationReceipt";
import {
  normalizeWorkspacePathIdentity,
  workspacePathsReferToSameFile,
} from "../workspacePaths";

export interface RuntimeV2PlanMutationScope {
  readonly allowed: boolean;
  readonly requestedTargets: readonly string[];
  readonly plannedTargets: readonly string[];
  readonly unexpectedTargets: readonly string[];
}

export interface RuntimeV2PlanValidationScope {
  readonly allowed: boolean;
  readonly matchingValidationIndexes: readonly number[];
}

export interface RuntimeV2PlanExecutionCoverage {
  readonly plannedMutationTargets: readonly string[];
  readonly committedMutationTargets: readonly string[];
  readonly missingMutationTargets: readonly string[];
  readonly requiredValidationIndexes: readonly number[];
  readonly passedRequiredValidationIndexes: readonly number[];
  readonly missingRequiredValidationIndexes: readonly number[];
  readonly allMutationTargetsCovered: boolean;
  readonly allRequiredValidationsPassed: boolean;
}

export interface RuntimeV2PlanSourceFreshnessEntry {
  readonly target: string;
  readonly expectedVersions: readonly string[];
  readonly currentVersion: string | null;
  readonly status: "fresh" | "missing" | "stale" | "unversioned";
}

export interface RuntimeV2PlanSourceFreshness {
  readonly entries: readonly RuntimeV2PlanSourceFreshnessEntry[];
  readonly allFresh: boolean;
  readonly missingTargets: readonly string[];
  readonly staleTargets: readonly string[];
  readonly unversionedTargets: readonly string[];
}

function uniquePaths(values: readonly string[]): string[] {
  const result: string[] = [];
  for (const value of values) {
    const path = String(value || "").trim();
    if (!path) continue;
    if (result.some((candidate) => workspacePathsReferToSameFile(candidate, path))) continue;
    result.push(path);
  }
  return result;
}

function normalizedCommand(value: unknown): string {
  return typeof value === "string"
    ? value.replace(/\s+/g, " ").trim()
    : "";
}

function normalizedCwd(value: unknown): string {
  const normalized = normalizeWorkspacePathIdentity(
    typeof value === "string" ? value : "",
  );
  return !normalized || normalized === "." ? "." : normalized;
}

function argumentsForEvent(
  aggregate: TurnAggregateV1,
  event: Extract<RuntimeV2Event, { type: "validation.completed" }>,
): {
  readonly toolName: string;
  readonly args: Readonly<Record<string, unknown>>;
} | null {
  const scheduled = aggregate.events.find((candidate) =>
    candidate.type === "command.scheduled" &&
    candidate.command.idempotencyKey === event.idempotencyKey &&
    candidate.command.kind === "execute_validation"
  );
  if (!scheduled || scheduled.type !== "command.scheduled") return null;
  const payload = scheduled.command.payload;
  const args = payload.arguments;
  return {
    toolName: typeof payload.toolName === "string" ? payload.toolName.trim() : "",
    args: args && typeof args === "object" && !Array.isArray(args)
      ? args as Readonly<Record<string, unknown>>
      : {},
  };
}

function validationMatches(
  validation: WorkPlanDraftV1["validations"][number],
  toolName: string,
  args: Readonly<Record<string, unknown>>,
): boolean {
  if (validation.kind === "finite_command") {
    return toolName === "run_command" &&
      normalizedCommand(args.command) === normalizedCommand(validation.command) &&
      normalizedCwd(args.cwd ?? args.workdir) === normalizedCwd(validation.cwd);
  }
  if (validation.kind === "browser") return toolName === "browser_evaluate";
  if (validation.kind === "desktop") return toolName === "computer_use";
  return false;
}

export function collectRuntimeV2PlanMutationTargets(
  plan: Pick<SealedWorkPlanV1, "draft">,
): readonly string[] {
  return uniquePaths(plan.draft.steps.flatMap((step) =>
    step.operation === "preserve" ? [] : [...step.targets]
  ));
}

export function resolveRuntimeV2PlanMutationScope(input: {
  readonly plan: Pick<SealedWorkPlanV1, "draft">;
  readonly requestedTargets: readonly string[];
}): RuntimeV2PlanMutationScope {
  const plannedTargets = collectRuntimeV2PlanMutationTargets(input.plan);
  const requestedTargets = uniquePaths(input.requestedTargets);
  const unexpectedTargets = requestedTargets.filter((requested) =>
    !plannedTargets.some((planned) =>
      workspacePathsReferToSameFile(requested, planned)
    )
  );
  return {
    allowed: requestedTargets.length > 0 && unexpectedTargets.length === 0,
    requestedTargets,
    plannedTargets,
    unexpectedTargets,
  };
}

export function resolveRuntimeV2PlanValidationScope(input: {
  readonly plan: Pick<SealedWorkPlanV1, "draft">;
  readonly toolName: string;
  readonly args: Readonly<Record<string, unknown>>;
}): RuntimeV2PlanValidationScope {
  const matchingValidationIndexes = input.plan.draft.validations
    .map((validation, index) =>
      validationMatches(validation, input.toolName, input.args) ? index : -1
    )
    .filter((index) => index >= 0);
  return {
    allowed: matchingValidationIndexes.length > 0,
    matchingValidationIndexes,
  };
}

export function runtimeV2PlanValidationAuthority(input: {
  readonly plan: SealedWorkPlanV1;
  readonly validationIndex: number;
}): RuntimeV2ExecutionValidationAuthority | null {
  const validation = input.plan.draft.validations[input.validationIndex];
  if (!validation) return null;
  const validationId =
    `work-plan-validation-${input.validationIndex + 1}`;
  return {
    kind: "work_plan",
    id: input.plan.id,
    revision: input.plan.revision,
    digest: input.plan.digest,
    validationId,
    criterionIds: [validationId],
    targetPaths: uniquePaths(validation.stepIndexes.flatMap((stepIndex) =>
      input.plan.draft.steps[stepIndex]?.targets || []
    )),
  };
}

function eventIndex(
  aggregate: TurnAggregateV1,
  event: RuntimeV2Event,
): number {
  return aggregate.events.findIndex((candidate) =>
    candidate.sequence === event.sequence && candidate.eventId === event.eventId
  );
}

function latestMutationIndex(aggregate: TurnAggregateV1): number {
  let latest = -1;
  for (const event of aggregate.events) {
    if (
      event.type === "tool.completed" &&
      event.status === "succeeded" &&
      event.evidence.some((evidence) => evidence.kind === "mutation")
    ) {
      latest = Math.max(latest, eventIndex(aggregate, event));
    }
  }
  return latest;
}

function approvedEventIndex(aggregate: TurnAggregateV1): number {
  for (let index = aggregate.events.length - 1; index >= 0; index -= 1) {
    if (aggregate.events[index]?.type === "work_plan.approved") return index;
  }
  return -1;
}

/**
 * Approved modify/delete steps are executable only after the current Run has
 * re-read every target and observed the exact version reviewed by the user.
 * Historical planning evidence alone is deliberately insufficient.
 */
export function deriveRuntimeV2PlanSourceFreshness(
  aggregate: TurnAggregateV1,
): RuntimeV2PlanSourceFreshness | null {
  const plan = aggregate.sealedWorkPlan;
  if (
    aggregate.strategy !== "plan" ||
    aggregate.workPlan?.status !== "approved" ||
    !plan
  ) {
    return null;
  }
  const approvalBoundary = approvedEventIndex(aggregate);
  const entries = uniquePaths(plan.draft.steps.flatMap((step) =>
    step.operation === "modify" || step.operation === "delete"
      ? [...step.targets]
      : []
  )).map((target): RuntimeV2PlanSourceFreshnessEntry => {
    const basisIds = new Set(plan.draft.steps
      .filter((step) =>
        (step.operation === "modify" || step.operation === "delete") &&
        step.targets.some((candidate) =>
          workspacePathsReferToSameFile(candidate, target)
        )
      )
      .flatMap((step) => [...step.basis]));
    const expectedVersions = [...new Set(plan.evidence
      .filter((evidence) =>
        basisIds.has(evidence.id) &&
        !!evidence.version &&
        workspacePathsReferToSameFile(evidence.target, target)
      )
      .map((evidence) => evidence.version as string))];
    let currentVersion: string | null = null;
    for (let index = aggregate.events.length - 1; index > approvalBoundary; index -= 1) {
      const event = aggregate.events[index]!;
      if (event.type !== "tool.completed" || event.status !== "succeeded") continue;
      const evidence = [...event.evidence].reverse().find((candidate) =>
        candidate.kind === "source" &&
        workspacePathsReferToSameFile(candidate.target, target)
      );
      if (evidence) {
        currentVersion = evidence.version;
        break;
      }
    }
    const status = expectedVersions.length === 0
      ? "unversioned"
      : !currentVersion
        ? "missing"
        : expectedVersions.includes(currentVersion)
          ? "fresh"
          : "stale";
    return { target, expectedVersions, currentVersion, status };
  });
  return {
    entries,
    allFresh: entries.every((entry) => entry.status === "fresh"),
    missingTargets: entries.filter((entry) => entry.status === "missing").map((entry) => entry.target),
    staleTargets: entries.filter((entry) => entry.status === "stale").map((entry) => entry.target),
    unversionedTargets: entries.filter((entry) => entry.status === "unversioned").map((entry) => entry.target),
  };
}

export function deriveRuntimeV2PlanExecutionCoverage(
  aggregate: TurnAggregateV1,
): RuntimeV2PlanExecutionCoverage | null {
  const plan = aggregate.sealedWorkPlan;
  if (
    aggregate.strategy !== "plan" ||
    aggregate.workPlan?.status !== "approved" ||
    !plan
  ) {
    return null;
  }

  const plannedMutationTargets = collectRuntimeV2PlanMutationTargets(plan);
  const committedMutationTargets = uniquePaths(
    aggregate.evidence
      .filter((evidence) => evidence.kind === "mutation")
      .map((evidence) => evidence.target),
  );
  const missingMutationTargets = plannedMutationTargets.filter((planned) =>
    !committedMutationTargets.some((committed) =>
      workspacePathsReferToSameFile(committed, planned)
    )
  );

  const requiredValidationIndexes = plan.draft.validations
    .map((validation, index) => validation.required ? index : -1)
    .filter((index) => index >= 0);
  const mutationBoundary = latestMutationIndex(aggregate);
  const passedValidations = aggregate.events.filter(
    (event): event is Extract<RuntimeV2Event, { type: "validation.completed" }> =>
      event.type === "validation.completed" &&
      event.passed &&
      eventIndex(aggregate, event) > mutationBoundary &&
      !!event.authority &&
      runtimeV2ValidationBoundaryMatchesCurrent({
        aggregate,
        targetPaths: event.authority.targetPaths,
        mutationBoundarySequence: event.mutationBoundarySequence,
        validatedMutationVersions: event.validatedMutationVersions,
      }),
  );
  const childValidationReceipts = aggregate.events.flatMap((event) => {
    if (
      event.type !== "subagent.completed" ||
      event.status !== "completed" ||
      !event.report
    ) {
      return [];
    }
    const citedEvidenceIds = new Set(
      event.report.findings.flatMap((finding) => finding.evidenceIds),
    );
    return (event.validationReceipts || []).filter((receipt) =>
      receipt.passed &&
      citedEvidenceIds.has(receipt.evidenceId) &&
      event.evidence.some((evidence) =>
        evidence.id === receipt.evidenceId &&
        evidence.kind === "validation"
      ) &&
      runtimeV2ValidationBoundaryMatchesCurrent({
        aggregate,
        targetPaths: receipt.authority.targetPaths,
        mutationBoundarySequence: receipt.mutationBoundarySequence,
        validatedMutationVersions: receipt.validatedMutationVersions,
      })
    );
  });
  const passedRequiredValidationIndexes = requiredValidationIndexes.filter((index) => {
    const required = plan.draft.validations[index];
    const expectedAuthority = runtimeV2PlanValidationAuthority({
      plan,
      validationIndex: index,
    });
    const authorityMatches = (
      authority: RuntimeV2ExecutionValidationAuthority | undefined,
    ) => !!expectedAuthority &&
      authority?.kind === "work_plan" &&
      authority.id === expectedAuthority.id &&
      authority.revision === expectedAuthority.revision &&
      authority.digest === expectedAuthority.digest &&
      authority.validationId === expectedAuthority.validationId &&
      authority.criterionIds.length ===
        expectedAuthority.criterionIds.length &&
      authority.criterionIds.every((id) =>
        expectedAuthority.criterionIds.includes(id)
      ) &&
      authority.targetPaths.length === expectedAuthority.targetPaths.length &&
      authority.targetPaths.every((target) =>
        expectedAuthority.targetPaths.some((candidate) =>
          workspacePathsReferToSameFile(target, candidate)
        )
      );
    return !!required && (
      passedValidations.some((event) => {
        if (!authorityMatches(event.authority)) return false;
        const invocation = argumentsForEvent(aggregate, event);
        return !!invocation &&
          validationMatches(required, invocation.toolName, invocation.args);
      }) ||
      childValidationReceipts.some((receipt) =>
        authorityMatches(receipt.authority)
      )
    );
  });
  const missingRequiredValidationIndexes = requiredValidationIndexes.filter(
    (index) => !passedRequiredValidationIndexes.includes(index),
  );

  return {
    plannedMutationTargets,
    committedMutationTargets,
    missingMutationTargets,
    requiredValidationIndexes,
    passedRequiredValidationIndexes,
    missingRequiredValidationIndexes,
    allMutationTargetsCovered: missingMutationTargets.length === 0,
    allRequiredValidationsPassed: missingRequiredValidationIndexes.length === 0,
  };
}
