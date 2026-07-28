import type { TurnAggregateV1 } from "./aggregate";
import { deriveRuntimeV2ExecutionContractCoverage } from "./executionContractCoverage";
import { workspacePathsReferToSameFile } from "../workspacePaths";

export function currentRuntimeV2PhaseEvents(
  state: TurnAggregateV1,
) {
  for (let index = state.events.length - 1; index >= 0; index -= 1) {
    const event = state.events[index]!;
    if (
      (event.type === "phase.changed" && event.phase === state.phase) ||
      (event.type === "run.started" && event.phase === state.phase)
    ) {
      return state.events.slice(index + 1);
    }
  }
  return state.events;
}

export function latestRuntimeV2RepeatedSourceTarget(
  state: TurnAggregateV1,
): string | null {
  const phaseEvents = currentRuntimeV2PhaseEvents(state);
  let repeatIndex = -1;
  for (let index = phaseEvents.length - 1; index >= 0; index -= 1) {
    const event = phaseEvents[index]!;
    if (
      event.type === "soft_signal.observed" &&
      event.signal === "repeat"
    ) {
      repeatIndex = index;
      break;
    }
  }
  if (repeatIndex < 0) return null;
  for (let index = repeatIndex - 1; index >= 0; index -= 1) {
    const event = phaseEvents[index]!;
    if (
      event.type === "tool.completed" &&
      event.status === "succeeded"
    ) {
      const source = event.evidence.find((evidence) =>
        evidence.kind === "source"
      );
      return source?.target || null;
    }
  }
  return null;
}

export function runtimeV2ObservationContractRequired(
  state: TurnAggregateV1,
): boolean {
  const phaseEvents = currentRuntimeV2PhaseEvents(state);
  let repeatIndex = -1;
  for (let index = phaseEvents.length - 1; index >= 0; index -= 1) {
    const event = phaseEvents[index]!;
    if (
      event.type === "soft_signal.observed" &&
      event.signal === "repeat"
    ) {
      repeatIndex = index;
      break;
    }
  }
  if (repeatIndex < 0) return false;
  return phaseEvents.slice(repeatIndex + 1).some((event) =>
    (
      event.type === "tool.completed" &&
      event.status === "succeeded" &&
      event.evidence.some((evidence) => evidence.kind === "source")
    ) ||
    (
      event.type === "command.scheduled" &&
      event.command.kind === "execute_tool" &&
      event.command.payload.repeatedActionRejected === true &&
      event.command.payload.repeatedActionReason ===
        "unchanged_source_repeat"
    )
  );
}

export function runtimeV2ExecutionEvidenceCatalog(
  state: TurnAggregateV1,
): readonly {
  readonly id: string;
  readonly kind: "source";
  readonly target: string;
  readonly version: string;
}[] {
  return state.evidence
    .filter((evidence): evidence is typeof evidence & {
      readonly kind: "source";
      readonly version: string;
    } =>
      evidence.kind === "source" &&
      typeof evidence.version === "string" &&
      evidence.version.length > 0
    )
    .slice(-32)
    .map((evidence) => ({
      id: evidence.id,
      kind: "source",
      target: evidence.target,
      version: evidence.version,
    }));
}

export function latestRuntimeV2ExecutionContractRejection(
  state: TurnAggregateV1,
): string | null {
  for (let index = state.events.length - 1; index >= 0; index -= 1) {
    const event = state.events[index]!;
    if (event.type === "execution_contract.committed") return null;
    if (event.type === "execution_contract.rejected") {
      return event.reason;
    }
  }
  return null;
}

export function requiredRuntimeV2ExecutionContractSourceTarget(
  state: TurnAggregateV1,
): string | null {
  const rejection = latestRuntimeV2ExecutionContractRejection(state);
  const marker = "versioned_basis_missing:";
  const markerIndex = rejection?.indexOf(marker) ?? -1;
  if (!rejection || markerIndex < 0) return null;
  const target = rejection
    .slice(markerIndex + marker.length)
    .split(/\r?\n/, 1)[0]!
    .trim();
  if (!target) return null;
  const alreadyVersioned = state.evidence.some((evidence) =>
    evidence.kind === "source" &&
    !!evidence.version &&
    workspacePathsReferToSameFile(evidence.target, target)
  );
  return alreadyVersioned ? null : target;
}

export function activeRuntimeV2ExecutionContractDraft(
  state: TurnAggregateV1,
): Readonly<Record<string, unknown>> | null {
  const contract = state.executionContract;
  if (!contract) return null;
  return {
    criteria: contract.criteria.map((criterion) => ({
      id: criterion.id,
      evidence_requirement: criterion.evidenceRequirement,
    })),
    changes: contract.changes.map((change) => ({
      operation: change.operation,
      target: change.target,
      basis_evidence_ids: change.basisEvidenceIds,
    })),
    validations: contract.validations.map((validation) => {
      const primitive = validation.primitive;
      const interaction =
        primitive.kind === "browser_interaction" ||
          primitive.kind === "desktop_interaction"
          ? {
              actions: primitive.actions,
              assertions: primitive.assertions.map((assertion) => ({
                kind: assertion.kind,
                target: assertion.target,
                ...(assertion.afterActionId
                  ? { after_action_id: assertion.afterActionId }
                  : {}),
                ...(assertion.expected !== undefined
                  ? { expected: assertion.expected }
                  : {}),
              })),
              require_causal_assertion:
                primitive.requireCausalAssertion === true,
            }
          : {};
      return {
        id: validation.id,
        criterion_ids: validation.criterionIds,
        target_paths: validation.targetPaths,
        kind: validation.kind,
        ...(validation.command ? { command: validation.command } : {}),
        ...(validation.cwd ? { cwd: validation.cwd } : {}),
        ...interaction,
        expected_outcome: validation.expectedOutcome,
      };
    }),
  };
}

export function runtimeV2ActingMutationProgressionRequired(
  state: TurnAggregateV1,
): boolean {
  const phaseEvents = currentRuntimeV2PhaseEvents(state);
  const contractCoverage =
    deriveRuntimeV2ExecutionContractCoverage(state);
  if (
    contractCoverage &&
    contractCoverage.missingMutationTargets.length > 0
  ) {
    for (let index = phaseEvents.length - 1; index >= 0; index -= 1) {
      const event = phaseEvents[index]!;
      if (
        event.type !== "tool.completed" ||
        event.status !== "succeeded"
      ) {
        continue;
      }
      const latestSource = event.evidence.find((evidence) =>
        evidence.kind === "source" && !!evidence.version
      );
      if (latestSource) {
        return contractCoverage.missingMutationTargets.some((target) =>
          workspacePathsReferToSameFile(target, latestSource.target)
        );
      }
    }
  }
  let latestRepeatIndex = -1;
  let latestMutationIndex = -1;
  for (let index = 0; index < phaseEvents.length; index += 1) {
    const event = phaseEvents[index]!;
    if (
      event.type === "soft_signal.observed" &&
      (
        event.signal === "repeat" ||
        event.signal === "repeated_action"
      )
    ) {
      latestRepeatIndex = index;
    }
    if (
      event.type === "tool.completed" &&
      event.status === "succeeded" &&
      event.evidence.some((evidence) => evidence.kind === "mutation")
    ) {
      latestMutationIndex = index;
    }
  }
  return latestRepeatIndex > latestMutationIndex;
}

function latestSuccessfulSourceTarget(
  state: TurnAggregateV1,
): string | null {
  const phaseEvents = currentRuntimeV2PhaseEvents(state);
  for (let index = phaseEvents.length - 1; index >= 0; index -= 1) {
    const event = phaseEvents[index]!;
    if (
      event.type !== "tool.completed" ||
      event.status !== "succeeded"
    ) {
      continue;
    }
    const source = event.evidence.find((evidence) =>
      evidence.kind === "source" && !!evidence.version
    );
    if (source) return source.target;
  }
  return null;
}

export function requiredRuntimeV2MutationSourceTarget(
  state: TurnAggregateV1,
  mutationProgressionRequired: boolean,
): string | null {
  const coverage = deriveRuntimeV2ExecutionContractCoverage(state);
  if (!coverage || coverage.missingMutationTargets.length === 0) {
    return null;
  }
  if (mutationProgressionRequired) return null;
  const latestSourceTarget = latestSuccessfulSourceTarget(state);
  if (
    latestSourceTarget &&
    coverage.missingMutationTargets.some((target) =>
      workspacePathsReferToSameFile(target, latestSourceTarget)
    )
  ) {
    return null;
  }
  return coverage.missingMutationTargets[0] || null;
}

/**
 * Validation normally exposes only acceptance-capable tools. If a child
 * started in this validation phase fails, the parent gets one successful
 * source observation to recover the missing handoff. The next decision then
 * removes source tools again and requires the declared validator.
 */
export function runtimeV2ValidationParentTakeoverReadRequired(
  state: TurnAggregateV1,
): boolean {
  if (state.phase !== "validating") return false;
  const phaseEvents = currentRuntimeV2PhaseEvents(state);
  let latestFailedChildIndex = -1;
  for (let index = phaseEvents.length - 1; index >= 0; index -= 1) {
    const event = phaseEvents[index]!;
    if (
      event.type === "subagent.completed" &&
      event.status === "failed"
    ) {
      latestFailedChildIndex = index;
      break;
    }
  }
  if (latestFailedChildIndex < 0) return false;
  return !phaseEvents.slice(latestFailedChildIndex + 1).some((event) =>
    event.type === "tool.completed" &&
    event.status === "succeeded" &&
    event.evidence.some((evidence) => evidence.kind === "source")
  );
}

export function latestRuntimeV2BrowserValidationTarget(
  state: TurnAggregateV1,
): string | null {
  for (let index = state.events.length - 1; index >= 0; index -= 1) {
    const event = state.events[index]!;
    if (
      event.type !== "command.scheduled" ||
      event.command.kind !== "execute_validation" ||
      event.command.payload.toolName !== "browser_evaluate"
    ) {
      continue;
    }
    const args = event.command.payload.arguments;
    const target =
      args && typeof args === "object" && !Array.isArray(args)
        ? String(
            (args as Readonly<Record<string, unknown>>).url || "",
          ).trim()
        : "";
    if (target) return target;
  }
  return null;
}

/**
 * Acting permits a small, ledger-bounded source-gap pass. Structural retries
 * are guarded by exact side-effect fingerprints; an editor class itself is
 * never removed merely because a different patch using that editor failed.
 */
export function runtimeV2ActingExecutePolicy(
  state: TurnAggregateV1,
):
  | "source_refresh_required"
  | "source_reorientation_required"
  | "source_gap_allowed"
  | "mutation_required" {
  const phaseEvents = currentRuntimeV2PhaseEvents(state);
  const isSuccessfulSourceOperation = (event: (typeof phaseEvents)[number]) =>
    event.type === "tool.completed" &&
    event.status === "succeeded" &&
    event.evidence.length > 0 &&
    event.evidence.every((evidence) => evidence.kind === "source");
  const successfulSourceOperations = phaseEvents.filter(
    isSuccessfulSourceOperation,
  ).length;
  const pressureObserved = phaseEvents.some((event) =>
    event.type === "soft_signal.observed" &&
    event.signal === "repeat"
  );
  let latestRecoveryFailureIndex = -1;
  let latestRecoveryFailureKind:
    | "mutation_rejected"
    | "source_mismatch"
    | "target_invalid"
    | null = null;
  for (let index = phaseEvents.length - 1; index >= 0; index -= 1) {
    const event = phaseEvents[index]!;
    if (
      event.type === "tool.completed" &&
      event.status !== "succeeded" &&
      (
        event.failureKind === "mutation_rejected" ||
        event.failureKind === "source_mismatch" ||
        event.failureKind === "target_invalid"
      )
    ) {
      latestRecoveryFailureIndex = index;
      latestRecoveryFailureKind = event.failureKind;
      break;
    }
  }
  if (latestRecoveryFailureIndex >= 0) {
    const refreshedSourceOperations = phaseEvents
      .slice(latestRecoveryFailureIndex + 1)
      .filter(isSuccessfulSourceOperation)
      .length;
    if (
      latestRecoveryFailureKind === "source_mismatch" ||
      latestRecoveryFailureKind === "mutation_rejected"
    ) {
      return refreshedSourceOperations > 0
        ? "mutation_required"
        : "source_refresh_required";
    }
    return refreshedSourceOperations >= 2
      ? "mutation_required"
      : "source_reorientation_required";
  }
  const executionCoverage =
    deriveRuntimeV2ExecutionContractCoverage(state);
  const latestSourceTarget = latestSuccessfulSourceTarget(state);
  if (
    executionCoverage &&
    latestSourceTarget &&
    executionCoverage.missingMutationTargets.some((target) =>
      workspacePathsReferToSameFile(target, latestSourceTarget)
    )
  ) {
    return "mutation_required";
  }
  let phaseBoundaryIndex = -1;
  for (let index = state.events.length - 1; index >= 0; index -= 1) {
    const event = state.events[index]!;
    if (event.type === "phase.changed" && event.phase === "acting") {
      phaseBoundaryIndex = index;
      break;
    }
  }
  let previousBoundaryIndex = -1;
  for (let index = phaseBoundaryIndex - 1; index >= 0; index -= 1) {
    const event = state.events[index]!;
    if (event.type === "phase.changed" || event.type === "run.started") {
      previousBoundaryIndex = index;
      break;
    }
  }
  const previousBoundary = previousBoundaryIndex >= 0
    ? state.events[previousBoundaryIndex]
    : null;
  const correctivePhase = phaseBoundaryIndex >= 0 &&
    previousBoundary?.type !== undefined &&
    "phase" in previousBoundary &&
    previousBoundary.phase === "validating" &&
    state.events
      .slice(previousBoundaryIndex + 1, phaseBoundaryIndex)
      .some((event) =>
        event.type === "validation.completed" && !event.passed
      );
  if (correctivePhase) {
    return successfulSourceOperations === 0
      ? "source_refresh_required"
      : "mutation_required";
  }
  return successfulSourceOperations >= 2 || pressureObserved
    ? "mutation_required"
    : "source_gap_allowed";
}
