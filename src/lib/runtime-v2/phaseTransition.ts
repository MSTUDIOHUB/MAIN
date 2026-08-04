import type { TurnAggregateV1 } from "./aggregate";
import type { RuntimeV2Command } from "./contracts";
import type { RuntimeV2Event } from "./events";
import { analyzeValidationCommand } from "../validationContract";
import { deriveRuntimeV2PlanExecutionCoverage } from "./planExecution";
import { workspacePathsReferToSameFile } from "../workspacePaths";
import {
  runtimeV2DirectExecuteAuthorityDigest,
  runtimeV2DirectExecuteCriterionIds,
  runtimeV2DirectExecuteMutationTargets,
  runtimeV2ValidationBoundaryMatchesCurrent,
} from "./validationReceipt";

export interface RuntimeV2ExecutePhaseTransition {
  readonly from: "observing" | "acting" | "validating";
  readonly to: "acting" | "validating";
  readonly reason:
    | "pending_mutation_call"
    | "pending_validation_call"
    | "mutation_committed"
    | "unvalidated_mutation_pending"
    | "validation_failed";
}

export interface RuntimeV2ExecutePhaseTransitionInput {
  /**
   * Tool capability classification belongs to the adapter. The Runtime core
   * consumes only this provider-neutral predicate and never branches on a
   * provider, model, natural-language response, or hard-coded tool list.
   */
  readonly isMutationToolName: (toolName: string) => boolean;
}

export function hasCompletedRuntimeV2InitialObservation(
  state: TurnAggregateV1,
): boolean {
  let boundaryIndex = -1;
  for (let index = state.events.length - 1; index >= 0; index -= 1) {
    const event = state.events[index]!;
    if (
      event.type === "work_plan.approved" ||
      event.type === "run.started"
    ) {
      boundaryIndex = index;
      break;
    }
  }
  const scheduled = new Set(
    state.events
      .slice(boundaryIndex + 1)
      .filter((event): event is Extract<RuntimeV2Event, { type: "command.scheduled" }> =>
        event.type === "command.scheduled" &&
        event.command.kind === "collect_observation"
      )
      .map((event) => event.command.idempotencyKey),
  );
  return state.events.slice(boundaryIndex + 1).some((event) =>
    event.type === "command.completed" &&
    event.status === "succeeded" &&
    scheduled.has(event.idempotencyKey)
  );
}

function currentPhaseEvents(state: TurnAggregateV1): readonly RuntimeV2Event[] {
  for (let index = state.events.length - 1; index >= 0; index -= 1) {
    const event = state.events[index]!;
    if (
      (event.type === "phase.changed" && event.phase === state.phase) ||
      (event.type === "run.started" && event.phase === state.phase)
    ) {
      return state.events.slice(index + 1);
    }
  }
  return [];
}

function toolName(command: RuntimeV2Command): string {
  return typeof command.payload.toolName === "string"
    ? command.payload.toolName.trim()
    : "";
}

export function isRuntimeV2ValidationToolCall(
  call: Pick<
    TurnAggregateV1["pendingToolCalls"][number],
    "name" | "arguments"
  >,
): boolean {
  if (call.name === "run_command") {
    const command = String(
      call.arguments.command || call.arguments.cmd || "",
    ).trim();
    return analyzeValidationCommand(command).spec?.kind ===
      "finite_command";
  }
  return call.name === "browser_evaluate" ||
    call.name === "computer_use";
}

function committedMutationSequences(
  events: readonly RuntimeV2Event[],
  isMutationToolName: RuntimeV2ExecutePhaseTransitionInput["isMutationToolName"],
): readonly number[] {
  const mutations = new Set(
    events
      .filter((event): event is Extract<RuntimeV2Event, { type: "command.scheduled" }> =>
        event.type === "command.scheduled" && event.command.kind === "execute_tool"
      )
      .filter((event) => {
        const name = toolName(event.command);
        return event.command.payload.runtimeOwnedPlanArtifact !== true &&
          !!name &&
          isMutationToolName(name);
      })
      .map((event) => event.command.idempotencyKey),
  );
  const parentMutations = events
    .filter((event): event is Extract<RuntimeV2Event, { type: "tool.completed" }> =>
      event.type === "tool.completed" &&
      event.status === "succeeded" &&
      mutations.has(event.idempotencyKey)
    )
    .map((event) => event.sequence);
  const childMutations = events
    .filter((event): event is Extract<RuntimeV2Event, { type: "subagent.completed" }> =>
      event.type === "subagent.completed" &&
      event.status === "completed" &&
      event.evidence.some((evidence) => evidence.kind === "mutation")
    )
    .map((event) => event.sequence);
  return [...parentMutations, ...childMutations];
}

function latestSequence(values: readonly number[]): number {
  return values.length > 0 ? Math.max(...values) : -1;
}

export interface RuntimeV2ExecuteEvidenceSummary {
  readonly mutationCount: number;
  readonly passedValidationCount: number;
  readonly failedValidationCount: number;
  readonly stalledValidationCount: number;
  readonly failedOperationCount: number;
  readonly failedProviderRequestCount: number;
}

/** Three identical acceptance failures across mutation boundaries prove that
 * edits are not changing the observed defect. This is a semantic no-progress
 * boundary, not a wall-clock or total-step limit: any materially different
 * validation result resets the consecutive count. */
export const RUNTIME_V2_STALLED_VALIDATION_FAILURE_LIMIT = 3;

function validationSupportsRequirement(
  event: Extract<RuntimeV2Event, { type: "validation.completed" }>,
  requirement: "static" | "behavioral" | "interaction" | undefined,
): boolean {
  if (!event.passed) return false;
  const toolName = event.presentation?.toolName || "";
  const interaction =
    toolName === "browser_evaluate" || toolName === "computer_use";
  const finite = toolName === "run_command"
    ? analyzeValidationCommand(event.presentation?.target || "").spec
    : null;
  const behavioral =
    interaction ||
    (
      finite?.kind === "finite_command" &&
      (
        finite.capability === "test" ||
        finite.capability === "inline_assertion"
      )
    );
  if (requirement === "static") {
    return interaction || finite?.kind === "finite_command";
  }
  if (requirement === "interaction") return interaction;
  if (requirement === "behavioral") return behavioral;
  // Direct Execute admission preserves the user's objective but does not
  // invent a semantic class from prose. Any real finite validator may cover
  // an unclassified criterion; typed Goal and WorkPlan criteria retain their
  // explicit stronger requirement.
  return interaction || finite?.kind === "finite_command";
}

function validationAuthorityWasAdmitted(
  state: TurnAggregateV1,
  event: Extract<RuntimeV2Event, { type: "validation.completed" }>,
): boolean {
  const authority = event.authority;
  if (!authority) return false;
  const scheduled = state.events.find((candidate) =>
    candidate.type === "command.scheduled" &&
    candidate.command.kind === "execute_validation" &&
    candidate.command.idempotencyKey === event.idempotencyKey
  );
  const admitted = scheduled?.type === "command.scheduled"
    ? scheduled.command.payload.validationAuthority
    : null;
  if (
    !admitted ||
    typeof admitted !== "object" ||
    Array.isArray(admitted)
  ) {
    return false;
  }
  const value = admitted as Record<string, unknown>;
  const admittedCriterionIds = Array.isArray(value.criterionIds)
    ? value.criterionIds as unknown[]
    : [];
  const admittedTargetPaths = Array.isArray(value.targetPaths)
    ? value.targetPaths as unknown[]
    : [];
  return value.kind === authority.kind &&
    value.id === authority.id &&
    value.revision === authority.revision &&
    value.digest === authority.digest &&
    value.validationId === authority.validationId &&
    admittedCriterionIds.length === authority.criterionIds.length &&
    authority.criterionIds.every((id) =>
      admittedCriterionIds.includes(id)
    ) &&
    admittedTargetPaths.length === authority.targetPaths.length &&
    authority.targetPaths.every((target) =>
      admittedTargetPaths.some((candidate) =>
        workspacePathsReferToSameFile(String(candidate), target)
      )
    );
}

export function runtimeV2DirectExecuteReadyForConclusion(
  state: TurnAggregateV1,
): boolean {
  const mutationTargets = runtimeV2DirectExecuteMutationTargets(state);
  const latestMutationSequence = state.events.reduce(
    (latest, event) =>
      (
        (
          event.type === "tool.completed" &&
          event.status === "succeeded"
        ) ||
        (
          event.type === "subagent.completed" &&
          event.status === "completed"
        )
      ) &&
        event.evidence.some((evidence) => evidence.kind === "mutation")
        ? Math.max(latest, event.sequence)
        : latest,
    -1,
  );
  if (latestMutationSequence < 0) return false;
  const criterionIds = runtimeV2DirectExecuteCriterionIds(state.objective);
  if (criterionIds.length === 0 || mutationTargets.length === 0) return false;
  const expectedDigest = runtimeV2DirectExecuteAuthorityDigest({
    turnId: state.turn.turnId,
    objective: state.objective,
  });
  const validations = state.events.filter((
    event,
  ): event is Extract<RuntimeV2Event, { type: "validation.completed" }> =>
    event.type === "validation.completed" &&
    event.sequence > latestMutationSequence
  );
  const validPasses = validations.filter((event) => {
    const authority = event.authority;
    return event.passed &&
      authority?.kind === "direct_execute" &&
      authority.id === state.turn.turnId &&
      authority.revision === 1 &&
      authority.digest === expectedDigest &&
      authority.validationId.length > 0 &&
      authority.criterionIds.length > 0 &&
      authority.criterionIds.every((id) => criterionIds.includes(id)) &&
      authority.targetPaths.length > 0 &&
      authority.targetPaths.every((target) =>
        mutationTargets.some((mutationTarget) =>
          workspacePathsReferToSameFile(mutationTarget, target)
        )
      ) &&
      validationAuthorityWasAdmitted(state, event) &&
      event.evidence.some((evidence) => evidence.kind === "validation") &&
      runtimeV2ValidationBoundaryMatchesCurrent({
        aggregate: state,
        targetPaths: authority.targetPaths,
        mutationBoundarySequence: event.mutationBoundarySequence,
        validatedMutationVersions: event.validatedMutationVersions,
      });
  });
  if (validPasses.length === 0) return false;
  const latestPassSequence = Math.max(
    ...validPasses.map((event) => event.sequence),
  );
  if (
    validations.some((event) =>
      event.sequence > latestPassSequence && !event.passed
    )
  ) {
    return false;
  }
  const requirements = state.objective.acceptanceEvidenceRequirements || [];
  const allCriteriaCovered = criterionIds.every((criterionId, index) =>
    validPasses.some((event) =>
      event.authority!.criterionIds.includes(criterionId) &&
      validationSupportsRequirement(event, requirements[index])
    )
  );
  const allMutationTargetsCovered = mutationTargets.every((mutationTarget) =>
    validPasses.some((event) =>
      event.authority!.targetPaths.some((target) =>
        workspacePathsReferToSameFile(mutationTarget, target)
      )
    )
  );
  return allCriteriaCovered && allMutationTargetsCovered;
}

function validationFailureFingerprint(
  event: Extract<RuntimeV2Event, { type: "validation.completed" }>,
): string {
  return [
    event.failureKind || "validation_failed",
    ...event.evidence
      .filter((evidence) => evidence.kind === "validation")
      .map((evidence) =>
        `${evidence.target}:${evidence.version || "unversioned"}`
      )
      .sort(),
  ].join("|");
}

function failedValidationSummarySinceLastPass(
  events: readonly RuntimeV2Event[],
): { total: number; stalled: number } {
  let count = 0;
  let stalled = 0;
  let latestFingerprint = "";
  let countingStalled = true;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.type !== "validation.completed") continue;
    if (event.passed) break;
    count += 1;
    const fingerprint = validationFailureFingerprint(event);
    if (!latestFingerprint) latestFingerprint = fingerprint;
    if (countingStalled && fingerprint === latestFingerprint) {
      stalled += 1;
    } else {
      countingStalled = false;
    }
  }
  return { total: count, stalled };
}

/** Durable execution facts reconstructed from the ledger. Process-local
 * counters cannot be used for completion because they disappear on restore. */
export function summarizeRuntimeV2ExecuteEvidence(
  state: TurnAggregateV1 | null,
  input: RuntimeV2ExecutePhaseTransitionInput,
): RuntimeV2ExecuteEvidenceSummary {
  if (!state) {
    return {
      mutationCount: 0,
      passedValidationCount: 0,
      failedValidationCount: 0,
      stalledValidationCount: 0,
      failedOperationCount: 0,
      failedProviderRequestCount: 0,
    };
  }
  const latestMutationSequence = state.events.reduce((latest, event) =>
    event.type === "tool.completed" &&
    event.status === "succeeded" &&
    event.evidence.some((evidence) => evidence.kind === "mutation")
      ? Math.max(latest, event.sequence)
      : latest
  , -1);
  const failedValidations = failedValidationSummarySinceLastPass(
    state.events,
  );
  const providerRequestKeys = new Set(
    state.events.flatMap((event) =>
      event.type === "command.scheduled" &&
        event.command.kind === "request_model"
        ? [event.command.idempotencyKey]
        : []
    ),
  );
  const failedProviderDecisionKeys = new Set(
    state.events.flatMap((event) => {
      if (
        event.type === "command.completed" &&
        event.status === "failed" &&
        providerRequestKeys.has(event.idempotencyKey)
      ) {
        return [event.idempotencyKey];
      }
      if (
        event.type === "provider.responded" &&
        event.result.toolCalls.length === 0 &&
        (
          event.result.diagnostics.length > 0 ||
          !String(event.result.visibleText || "").trim()
        )
      ) {
        return [event.idempotencyKey];
      }
      return [];
    }),
  );
  return {
    mutationCount:
      committedMutationSequences(state.events, input.isMutationToolName).length,
    passedValidationCount: state.events.filter((event) =>
      event.type === "validation.completed" &&
      event.passed &&
      event.sequence > latestMutationSequence
    ).length,
    failedValidationCount: failedValidations.total,
    stalledValidationCount: failedValidations.stalled,
    failedOperationCount: state.events.filter((event) =>
      (event.type === "tool.completed" && event.status !== "succeeded") ||
      (event.type === "validation.completed" && !event.passed)
    ).length,
    failedProviderRequestCount: failedProviderDecisionKeys.size,
  };
}

function latestValidation(
  events: readonly RuntimeV2Event[],
): Extract<RuntimeV2Event, { type: "validation.completed" }> | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.type === "validation.completed") return event;
  }
  return null;
}

/**
 * Pure Execute phase policy.
 *
 * Phase changes are derived from the durable aggregate only. Provider prose,
 * endpoint identity, model identity, and process-local counters cannot advance
 * the lifecycle. A scheduled effect also fences phase changes until its
 * completion is committed.
 */
export function decideRuntimeV2ExecutePhaseTransition(
  state: TurnAggregateV1 | null,
  input: RuntimeV2ExecutePhaseTransitionInput,
): RuntimeV2ExecutePhaseTransition | null {
  if (
    !state ||
    (
      state.strategy !== "execute" &&
      !(state.strategy === "plan" && state.workPlan?.status === "approved")
    ) ||
    !state.run ||
    state.run.status !== "running" ||
    state.terminalOutcome ||
    state.scheduledCommands.length > 0
  ) {
    return null;
  }
  if (
    state.phase !== "observing" &&
    state.phase !== "acting" &&
    state.phase !== "validating"
  ) {
    return null;
  }
  const approvedPlanCoverage = state.strategy === "plan"
    ? deriveRuntimeV2PlanExecutionCoverage(state)
    : null;
  if (state.strategy === "plan" && !approvedPlanCoverage) return null;

  const pendingMutation = state.pendingToolCalls.some((call) =>
    input.isMutationToolName(call.name)
  );
  if (
    pendingMutation &&
    state.phase !== "acting"
  ) {
    return {
      from: state.phase,
      to: "acting",
      reason: "pending_mutation_call",
    };
  }
  const pendingValidation = state.pendingToolCalls.some((call) =>
    isRuntimeV2ValidationToolCall(call)
  );
  if (pendingValidation && state.phase !== "validating") {
    return {
      from: state.phase,
      to: "validating",
      reason: "pending_validation_call",
    };
  }

  if (state.pendingToolCalls.length > 0) return null;
  const phaseEvents = currentPhaseEvents(state);

  if (state.phase === "acting") {
    const latestPhaseMutationSequence = latestSequence(
      committedMutationSequences(
        phaseEvents,
        input.isMutationToolName,
      ),
    );
    const latestMutationSequence = latestSequence(
      committedMutationSequences(
        state.events,
        input.isMutationToolName,
      ),
    );
    const latestValidationSequence = latestSequence(
      state.events
        .filter((event) => event.type === "validation.completed")
        .map((event) => event.sequence),
    );
    if (
      latestMutationSequence > latestValidationSequence &&
      (
        state.strategy !== "plan" ||
        approvedPlanCoverage?.allMutationTargetsCovered
      )
    ) {
      return {
        from: "acting",
        to: "validating",
        reason: latestPhaseMutationSequence >= 0
          ? "mutation_committed"
          : "unvalidated_mutation_pending",
      };
    }
  }

  if (state.phase === "validating") {
    const validation = latestValidation(phaseEvents);
    if (validation && !validation.passed) {
      return {
        from: "validating",
        to: "acting",
        reason: "validation_failed",
      };
    }
  }

  return null;
}
