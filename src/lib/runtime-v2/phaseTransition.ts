import type { TurnAggregateV1 } from "./aggregate";
import type { RuntimeV2Command } from "./contracts";
import type { RuntimeV2Event } from "./events";
import { analyzeValidationCommand } from "../validationContract";
import { deriveRuntimeV2PlanExecutionCoverage } from "./planExecution";

export interface RuntimeV2ExecutePhaseTransition {
  readonly from: "observing" | "acting" | "validating";
  readonly to: "acting" | "validating";
  readonly reason:
    | "pending_mutation_call"
    | "pending_validation_call"
    | "mutation_committed"
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

const VALIDATION_TOOL_NAMES = new Set([
  "run_command",
  "browser_evaluate",
  "computer_use",
]);

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

function validationCoversObjective(
  state: TurnAggregateV1,
  event: Extract<RuntimeV2Event, { type: "validation.completed" }>,
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
  const requirements =
    state.objective.acceptanceEvidenceRequirements?.length
      ? state.objective.acceptanceEvidenceRequirements
      : ["behavioral" as const];
  return requirements.every((requirement) =>
    requirement === "static"
      ? interaction || finite?.kind === "finite_command"
      : requirement === "interaction"
        ? interaction
        : behavioral
  );
}

export function runtimeV2DirectExecuteReadyForConclusion(
  state: TurnAggregateV1,
): boolean {
  const latestMutationSequence = state.events.reduce((latest, event) =>
    event.type === "tool.completed" &&
      event.status === "succeeded" &&
      event.evidence.some((evidence) => evidence.kind === "mutation")
      ? Math.max(latest, event.sequence)
      : latest
  , -1);
  if (latestMutationSequence < 0) return false;
  const validations = state.events.filter((
    event,
  ): event is Extract<RuntimeV2Event, { type: "validation.completed" }> =>
    event.type === "validation.completed" &&
    event.sequence > latestMutationSequence
  );
  let latestPassIndex = -1;
  for (let index = validations.length - 1; index >= 0; index -= 1) {
    if (validations[index]!.passed) {
      latestPassIndex = index;
      break;
    }
  }
  if (latestPassIndex < 0) return false;
  if (validations.slice(latestPassIndex + 1).some((event) => !event.passed)) {
    return false;
  }
  return validations.some((event) => validationCoversObjective(state, event));
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
    VALIDATION_TOOL_NAMES.has(call.name)
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
    const currentPhaseMutationCount =
      committedMutationKeys(phaseEvents, input.isMutationToolName).size;
    if (
      currentPhaseMutationCount > 0 &&
      (
        state.strategy !== "plan" ||
        approvedPlanCoverage?.allMutationTargetsCovered
      )
    ) {
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
