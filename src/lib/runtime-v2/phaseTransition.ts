import type { TurnAggregateV1 } from "./aggregate";
import type { RuntimeV2Command } from "./contracts";
import type { RuntimeV2Event } from "./events";
import { deriveRuntimeV2PlanExecutionCoverage } from "./planExecution";
import { deriveRuntimeV2ExecutionContractCoverage } from "./executionContractCoverage";

export type RuntimeV2ExecutePhaseTransition =
  | {
      readonly from: "observing";
      readonly to: "acting";
      readonly reason: "pending_mutation_call" | "observation_cycle_complete";
    }
  | {
      readonly from: "acting";
      readonly to: "validating";
      readonly reason: "mutation_committed";
    }
  | {
      readonly from: "validating";
      readonly to: "acting";
      readonly reason: "validation_failed";
    };

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

function committedMutationKeys(
  events: readonly RuntimeV2Event[],
  isMutationToolName: RuntimeV2ExecutePhaseTransitionInput["isMutationToolName"],
): ReadonlySet<string> {
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
  const committed = new Set<string>();
  for (const event of events) {
    if (
      event.type === "tool.completed" &&
      event.status === "succeeded" &&
      mutations.has(event.idempotencyKey)
    ) {
      committed.add(event.idempotencyKey);
    }
  }
  return committed;
}

export interface RuntimeV2ExecuteEvidenceSummary {
  readonly mutationCount: number;
  readonly passedValidationCount: number;
  readonly failedValidationCount: number;
  readonly stalledValidationCount: number;
  readonly failedOperationCount: number;
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
  return {
    mutationCount: committedMutationKeys(state.events, input.isMutationToolName).size,
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

  const pendingMutation = state.pendingToolCalls.some((call) =>
    input.isMutationToolName(call.name)
  );
  const hasExecutionAuthority =
    state.strategy === "plan"
      ? state.workPlan?.status === "approved"
      : state.executionContract?.status === "active";
  if (
    state.phase === "observing" &&
    pendingMutation &&
    hasExecutionAuthority
  ) {
    return {
      from: "observing",
      to: "acting",
      reason: "pending_mutation_call",
    };
  }

  if (state.pendingToolCalls.length > 0) return null;
  const phaseEvents = currentPhaseEvents(state);

  if (state.phase === "observing") {
    const parentResponded = phaseEvents.some((event) => event.type === "provider.responded");
    if (
      state.evidence.length > 0 &&
      parentResponded &&
      hasExecutionAuthority
    ) {
      return {
        from: "observing",
        to: "acting",
        reason: "observation_cycle_complete",
      };
    }
    return null;
  }

  if (state.phase === "acting") {
    const currentPhaseMutationCount =
      committedMutationKeys(phaseEvents, input.isMutationToolName).size;
    const approvedPlanCoverage = state.strategy === "plan"
      ? deriveRuntimeV2PlanExecutionCoverage(state)
      : null;
    const executionContractCoverage = state.strategy === "execute"
      ? deriveRuntimeV2ExecutionContractCoverage(state)
      : null;
    const mutationBoundarySatisfied = approvedPlanCoverage
      ? approvedPlanCoverage.allMutationTargetsCovered
      : executionContractCoverage
        ? executionContractCoverage.missingMutationTargets.length === 0
        : false;
    if (currentPhaseMutationCount > 0 && mutationBoundarySatisfied) {
    return {
      from: "acting",
      to: "validating",
      reason: "mutation_committed",
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
