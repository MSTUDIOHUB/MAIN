import type { TurnAggregateV1 } from "./aggregate";
import type { RuntimeV2Event } from "./events";
import type {
  SealedWorkPlanV1,
  WorkPlanDraftV1,
  WorkPlanOperation,
} from "./workPlan";
import type { RuntimeV2ExecutionValidationAuthority } from "./contracts";
import { runtimeV2ValidationBoundaryMatchesCurrent } from "./validationReceipt";
import {
  normalizeWorkspacePathIdentity,
  workspacePathsReferToSameFile,
} from "../workspacePaths";
import { resolveWorkspaceMutationRequests } from "../workspaceMutationTools";

export interface RuntimeV2PlanMutationScope {
  readonly allowed: boolean;
  readonly requestedTargets: readonly string[];
  readonly plannedTargets: readonly string[];
  readonly unexpectedTargets: readonly string[];
  readonly blockedTargets: readonly string[];
  readonly operationMismatchTargets: readonly string[];
  readonly matchingReadyStepIndexes: readonly number[];
}

export interface RuntimeV2PlanValidationScope {
  readonly allowed: boolean;
  readonly matchingValidationIndexes: readonly number[];
}

export interface RuntimeV2PlanExecutionFrontierStep {
  readonly stepIndex: number;
  readonly operation: WorkPlanOperation;
  readonly targets: readonly string[];
  readonly status: "completed" | "ready" | "blocked";
  readonly completionSequence: number | null;
  readonly unsatisfiedDependencyIndexes: readonly number[];
}

export interface RuntimeV2PlanExecutionFrontier {
  readonly steps: readonly RuntimeV2PlanExecutionFrontierStep[];
  readonly completedStepIndexes: readonly number[];
  readonly readyStepIndexes: readonly number[];
  readonly blockedStepIndexes: readonly number[];
  readonly readyMutationTargets: readonly string[];
  readonly allExecutableStepsCompleted: boolean;
  readonly validationReady: boolean;
}

export interface RuntimeV2PlanValidationCorrectionScope {
  readonly active: boolean;
  readonly validationIndex: number | null;
  readonly failureSequence: number | null;
  readonly stepIndexes: readonly number[];
  readonly targets: readonly string[];
}

export interface RuntimeV2PlanExecutionCoverage {
  readonly plannedMutationTargets: readonly string[];
  readonly committedMutationTargets: readonly string[];
  readonly missingMutationTargets: readonly string[];
  readonly completedStepIndexes: readonly number[];
  readonly readyStepIndexes: readonly number[];
  readonly blockedStepIndexes: readonly number[];
  readonly missingStepIndexes: readonly number[];
  readonly requiredValidationIndexes: readonly number[];
  readonly passedRequiredValidationIndexes: readonly number[];
  readonly missingRequiredValidationIndexes: readonly number[];
  readonly allMutationTargetsCovered: boolean;
  readonly allRequiredValidationsPassed: boolean;
}

interface RuntimeV2PlanMutationReceipt {
  readonly sequence: number;
  readonly requests: readonly {
    readonly target: string;
    readonly operation: Exclude<WorkPlanOperation, "preserve">;
  }[];
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

function successfulPlanMutationReceipts(
  aggregate: TurnAggregateV1,
): RuntimeV2PlanMutationReceipt[] {
  const approvalBoundary = approvedEventIndex(aggregate);
  const scheduledByKey = new Map(aggregate.events.flatMap((event) =>
    event.type === "command.scheduled" && event.command.kind === "execute_tool"
      ? [[event.command.idempotencyKey, event.command] as const]
      : []
  ));
  const receipts: RuntimeV2PlanMutationReceipt[] = [];
  for (let index = approvalBoundary + 1; index < aggregate.events.length; index += 1) {
    const event = aggregate.events[index]!;
    if (event.type === "tool.completed" && event.status === "succeeded") {
      const command = scheduledByKey.get(event.idempotencyKey);
      if (!command) continue;
      const toolName = String(command.payload.toolName || "").trim();
      const args = command.payload.arguments &&
          typeof command.payload.arguments === "object" &&
          !Array.isArray(command.payload.arguments)
        ? command.payload.arguments as Record<string, unknown>
        : {};
      const presentationTarget = event.presentation?.target || "";
      const mutations = resolveWorkspaceMutationRequests(
        toolName,
        args,
        presentationTarget,
      ).flatMap((request) => {
        if (!request.operation) return [];
        const proved = event.evidence.some((evidence) =>
          evidence.kind === "mutation" &&
          workspacePathsReferToSameFile(evidence.target, request.target)
        );
        return proved
          ? [{
              target: request.target,
              operation: request.operation,
            }]
          : [];
      });
      if (mutations.length > 0) {
        receipts.push({ sequence: event.sequence, requests: mutations });
      }
      continue;
    }
    if (event.type !== "subagent.completed" || event.status !== "completed") {
      continue;
    }
    const job = aggregate.subagents.find((candidate) => candidate.id === event.jobId);
    const operation = job?.implementationOperation;
    if (!operation) continue;
    const mutations = event.evidence.flatMap((evidence) =>
      evidence.kind === "mutation"
        ? [{ target: evidence.target, operation }]
        : []
    );
    if (mutations.length > 0) {
      receipts.push({ sequence: event.sequence, requests: mutations });
    }
  }
  return receipts.sort((left, right) => left.sequence - right.sequence);
}

/**
 * Derive the approved WorkPlan's current mutation frontier solely from its
 * semantic dependency graph and canonical, post-approval effect receipts.
 * Status is replayed rather than persisted so a restart cannot drift from the
 * reviewed authority. One receipt target is consumed by at most one step;
 * repeated targets therefore need a distinct later mutation receipt.
 */
export function deriveRuntimeV2PlanExecutionFrontier(
  aggregate: TurnAggregateV1,
): RuntimeV2PlanExecutionFrontier | null {
  const plan = aggregate.sealedWorkPlan;
  if (
    aggregate.strategy !== "plan" ||
    aggregate.workPlan?.status !== "approved" ||
    !plan
  ) {
    return null;
  }
  const approvalIndex = approvedEventIndex(aggregate);
  const approvalSequence = approvalIndex >= 0
    ? aggregate.events[approvalIndex]!.sequence
    : -1;
  const receipts = successfulPlanMutationReceipts(aggregate);
  const consumed = new Set<string>();
  const steps: RuntimeV2PlanExecutionFrontierStep[] = [];

  for (const [stepIndex, step] of plan.draft.steps.entries()) {
    const unsatisfiedDependencyIndexes = step.dependsOn.filter((dependency) =>
      steps[dependency]?.status !== "completed"
    );
    if (unsatisfiedDependencyIndexes.length > 0) {
      steps.push({
        stepIndex,
        operation: step.operation,
        targets: [...step.targets],
        status: "blocked",
        completionSequence: null,
        unsatisfiedDependencyIndexes,
      });
      continue;
    }
    const dependencyBoundary = Math.max(
      approvalSequence,
      ...step.dependsOn.map((dependency) =>
        steps[dependency]?.completionSequence ?? approvalSequence
      ),
    );
    if (step.operation === "preserve") {
      steps.push({
        stepIndex,
        operation: step.operation,
        targets: [...step.targets],
        status: "completed",
        completionSequence: dependencyBoundary,
        unsatisfiedDependencyIndexes: [],
      });
      continue;
    }

    const matchedKeys: string[] = [];
    const matchedSequences: number[] = [];
    let complete = true;
    for (const target of uniquePaths(step.targets)) {
      let matchKey = "";
      let matchSequence = -1;
      for (const receipt of receipts) {
        if (receipt.sequence <= dependencyBoundary) continue;
        for (const [requestIndex, request] of receipt.requests.entries()) {
          const key = `${receipt.sequence}:${requestIndex}`;
          if (
            consumed.has(key) ||
            matchedKeys.includes(key) ||
            request.operation !== step.operation ||
            !workspacePathsReferToSameFile(request.target, target)
          ) {
            continue;
          }
          matchKey = key;
          matchSequence = receipt.sequence;
          break;
        }
        if (matchKey) break;
      }
      if (!matchKey) {
        complete = false;
        break;
      }
      matchedKeys.push(matchKey);
      matchedSequences.push(matchSequence);
    }
    if (complete && matchedKeys.length > 0) {
      for (const key of matchedKeys) consumed.add(key);
      steps.push({
        stepIndex,
        operation: step.operation,
        targets: [...step.targets],
        status: "completed",
        completionSequence: Math.max(...matchedSequences),
        unsatisfiedDependencyIndexes: [],
      });
    } else {
      steps.push({
        stepIndex,
        operation: step.operation,
        targets: [...step.targets],
        status: "ready",
        completionSequence: null,
        unsatisfiedDependencyIndexes: [],
      });
    }
  }

  const executableSteps = steps.filter((step) => step.operation !== "preserve");
  const completedStepIndexes = executableSteps
    .filter((step) => step.status === "completed")
    .map((step) => step.stepIndex);
  const readyStepIndexes = executableSteps
    .filter((step) => step.status === "ready")
    .map((step) => step.stepIndex);
  const blockedStepIndexes = executableSteps
    .filter((step) => step.status === "blocked")
    .map((step) => step.stepIndex);
  const allExecutableStepsCompleted = executableSteps.every(
    (step) => step.status === "completed",
  );
  return {
    steps,
    completedStepIndexes,
    readyStepIndexes,
    blockedStepIndexes,
    readyMutationTargets: uniquePaths(executableSteps.flatMap((step) =>
      step.status === "ready" ? [...step.targets] : []
    )),
    allExecutableStepsCompleted,
    validationReady: allExecutableStepsCompleted,
  };
}

export function resolveRuntimeV2PlanMutationScope(input: {
  readonly plan: Pick<SealedWorkPlanV1, "draft">;
  readonly requestedTargets: readonly string[];
  readonly requestedMutations?: readonly {
    readonly target: string;
    readonly operation: Exclude<WorkPlanOperation, "preserve"> | null;
  }[];
  readonly aggregate?: TurnAggregateV1;
}): RuntimeV2PlanMutationScope {
  const plannedTargets = collectRuntimeV2PlanMutationTargets(input.plan);
  const requestedTargets = uniquePaths(input.requestedTargets);
  const unexpectedTargets = requestedTargets.filter((requested) =>
    !plannedTargets.some((planned) =>
      workspacePathsReferToSameFile(requested, planned)
    )
  );
  const frontier = input.aggregate
    ? deriveRuntimeV2PlanExecutionFrontier(input.aggregate)
    : null;
  const readySteps = frontier
    ? frontier.steps.filter((step) => step.status === "ready")
    : input.plan.draft.steps.map((step, stepIndex) => ({
        ...step,
        stepIndex,
        status: "ready" as const,
      }));
  const blockedTargets = requestedTargets.filter((requested) =>
    !unexpectedTargets.some((unexpected) =>
      workspacePathsReferToSameFile(unexpected, requested)
    ) &&
    !readySteps.some((step) => step.targets.some((target) =>
      workspacePathsReferToSameFile(target, requested)
    ))
  );
  const requestedMutations = input.requestedMutations || requestedTargets.map(
    (target) => ({ target, operation: null }),
  );
  const enforceOperation = !!input.requestedMutations;
  const operationMismatchTargets = enforceOperation
    ? requestedMutations.filter((request) =>
        !unexpectedTargets.some((unexpected) =>
          workspacePathsReferToSameFile(unexpected, request.target)
        ) &&
        !blockedTargets.some((blocked) =>
          workspacePathsReferToSameFile(blocked, request.target)
        ) &&
        !readySteps.some((step) =>
          step.operation === request.operation &&
          step.targets.some((target) =>
            workspacePathsReferToSameFile(target, request.target)
          )
        )
      ).map((request) => request.target)
    : [];
  const matchingReadyStepIndexes = readySteps
    .filter((step) => requestedMutations.some((request) =>
      (!enforceOperation || step.operation === request.operation) &&
      step.targets.some((target) =>
        workspacePathsReferToSameFile(target, request.target)
      )
    ))
    .map((step) => step.stepIndex);
  return {
    allowed: requestedTargets.length > 0 &&
      unexpectedTargets.length === 0 &&
      blockedTargets.length === 0 &&
      operationMismatchTargets.length === 0 &&
      requestedMutations.every((request) => readySteps.some((step) =>
        (!enforceOperation || step.operation === request.operation) &&
        step.targets.some((target) =>
          workspacePathsReferToSameFile(target, request.target)
        )
      )),
    requestedTargets,
    plannedTargets,
    unexpectedTargets,
    blockedTargets,
    operationMismatchTargets,
    matchingReadyStepIndexes,
  };
}

export function resolveRuntimeV2PlanValidationScope(input: {
  readonly plan: Pick<SealedWorkPlanV1, "draft">;
  readonly toolName: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly aggregate?: TurnAggregateV1;
}): RuntimeV2PlanValidationScope {
  const matchingValidationIndexes = input.plan.draft.validations
    .map((validation, index) =>
      validationMatches(validation, input.toolName, input.args) ? index : -1
    )
    .filter((index) => index >= 0);
  return {
    allowed: matchingValidationIndexes.length > 0 &&
      (!input.aggregate ||
        deriveRuntimeV2PlanExecutionFrontier(input.aggregate)
          ?.validationReady === true),
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
    criterionIds: validation.criterionIds?.length
      ? [...validation.criterionIds]
      : [validationId],
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
      (
        (event.type === "tool.completed" && event.status === "succeeded") ||
        (event.type === "subagent.completed" && event.status === "completed")
      ) &&
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
 * A real failed required WorkPlan validator opens one bounded correction
 * scope. The semantic plan stages remain completed; this lease authorizes a
 * new modification boundary only for files owned by the failed validator.
 * Any later committed mutation closes the lease and invalidates older passes,
 * after which the complete required validation set is evaluated again.
 */
export function deriveRuntimeV2PlanValidationCorrectionScope(
  aggregate: TurnAggregateV1,
): RuntimeV2PlanValidationCorrectionScope {
  const inactive: RuntimeV2PlanValidationCorrectionScope = {
    active: false,
    validationIndex: null,
    failureSequence: null,
    stepIndexes: [],
    targets: [],
  };
  const plan = aggregate.sealedWorkPlan;
  if (
    aggregate.strategy !== "plan" ||
    aggregate.workPlan?.status !== "approved" ||
    !plan
  ) {
    return inactive;
  }
  let failure: Extract<RuntimeV2Event, { type: "validation.completed" }> | null =
    null;
  let validationIndex = -1;
  const passedAfterFailure = new Set<string>();
  for (let index = aggregate.events.length - 1; index >= 0; index -= 1) {
    const event = aggregate.events[index]!;
    if (event.type !== "validation.completed") continue;
    const authorityId = event.authority?.kind === "work_plan"
      ? event.authority.validationId
      : "";
    if (!authorityId) continue;
    if (event.passed) {
      passedAfterFailure.add(authorityId);
      continue;
    }
    if (
      passedAfterFailure.has(authorityId) ||
      (event.failureKind !== "assertion_failed" &&
        event.failureKind !== "execution_failed")
    ) {
      continue;
    }
    validationIndex = plan.draft.validations.findIndex((_, candidateIndex) =>
      authorityId === `work-plan-validation-${candidateIndex + 1}`
    );
    if (validationIndex >= 0) {
      failure = event;
      break;
    }
  }
  if (!failure || validationIndex < 0) return inactive;
  const newerMutation = aggregate.events.some((event) =>
    event.sequence > failure!.sequence &&
    (
      (event.type === "tool.completed" && event.status === "succeeded") ||
      (event.type === "subagent.completed" && event.status === "completed")
    ) &&
    event.evidence.some((evidence) => evidence.kind === "mutation")
  );
  if (newerMutation) return inactive;
  const validation = plan.draft.validations[validationIndex]!;
  const stepIndexes = [...validation.stepIndexes];
  return {
    active: true,
    validationIndex,
    failureSequence: failure.sequence,
    stepIndexes,
    targets: uniquePaths(stepIndexes.flatMap((stepIndex) =>
      plan.draft.steps[stepIndex]?.operation === "preserve"
        ? []
        : plan.draft.steps[stepIndex]?.targets || []
    )),
  };
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
  const frontier = deriveRuntimeV2PlanExecutionFrontier(aggregate);
  const completedStepIndexes = frontier?.completedStepIndexes || [];
  const readyStepIndexes = frontier?.readyStepIndexes || [];
  const blockedStepIndexes = frontier?.blockedStepIndexes || [];
  const missingStepIndexes = plan.draft.steps
    .map((step, index) =>
      step.operation !== "preserve" && !completedStepIndexes.includes(index)
        ? index
        : -1
    )
    .filter((index) => index >= 0);

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
    return !!required && passedValidations.some((event) => {
      if (!authorityMatches(event.authority)) return false;
      const invocation = argumentsForEvent(aggregate, event);
      return !!invocation &&
        validationMatches(required, invocation.toolName, invocation.args);
    });
  });
  const missingRequiredValidationIndexes = requiredValidationIndexes.filter(
    (index) => !passedRequiredValidationIndexes.includes(index),
  );

  return {
    plannedMutationTargets,
    committedMutationTargets,
    missingMutationTargets,
    completedStepIndexes,
    readyStepIndexes,
    blockedStepIndexes,
    missingStepIndexes,
    requiredValidationIndexes,
    passedRequiredValidationIndexes,
    missingRequiredValidationIndexes,
    allMutationTargetsCovered: missingMutationTargets.length === 0 &&
      missingStepIndexes.length === 0,
    allRequiredValidationsPassed: missingRequiredValidationIndexes.length === 0,
  };
}
