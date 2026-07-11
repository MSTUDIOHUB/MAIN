export interface RunIdentityMarkerLike {
  runId?: string | null;
  parentRunId?: string | null;
  sessionKey?: string | null;
  turnId?: string | null;
  turnStartMessageIndex?: number | null;
  lastGoalSliceRunId?: string | null;
}

export interface RuntimeRunIdentity {
  runId: string;
  parentRunId: string | null;
  outerRunId: string;
  goalSliceId?: string;
  source: "harness_marker" | "generated_fallback";
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function markerBelongsToTurn(
  marker: RunIdentityMarkerLike | null | undefined,
  sessionKey: string,
  turnId: string,
): boolean {
  return !!marker &&
    nonEmptyString(marker.sessionKey) === sessionKey &&
    nonEmptyString(marker.turnId) === turnId &&
    nonEmptyString(marker.runId) != null;
}

export function markerContinuesLogicalTurn(input: {
  marker?: RunIdentityMarkerLike | null;
  sessionKey: string;
  turnId: string;
  goalSliceId?: string | null;
}): boolean {
  if (!markerBelongsToTurn(input.marker, input.sessionKey, input.turnId)) return false;
  if (nonEmptyString(input.marker?.parentRunId)) return true;
  return !!nonEmptyString(input.goalSliceId) && !!nonEmptyString(input.marker?.lastGoalSliceRunId);
}

export function resolveSubmitRunLineage(input: {
  previousMarker?: RunIdentityMarkerLike | null;
  sessionKey: string;
  turnId: string;
  runId: string;
  currentMessageStartIndex: number;
}): {
  runId: string;
  parentRunId: string | null;
  turnStartMessageIndex: number;
} {
  const previousMarker = input.previousMarker;
  const isSameTurn = markerBelongsToTurn(previousMarker, input.sessionKey, input.turnId);
  const previousStart = Number(previousMarker?.turnStartMessageIndex);
  const inheritedStart = isSameTurn && Number.isInteger(previousStart) && previousStart >= 0
    ? Math.min(previousStart, Math.max(0, input.currentMessageStartIndex))
    : Math.max(0, input.currentMessageStartIndex);

  return {
    runId: input.runId,
    parentRunId: isSameTurn ? nonEmptyString(previousMarker?.runId) : null,
    turnStartMessageIndex: inheritedStart,
  };
}

/**
 * A logical turn is reused only for an explicit runtime continuation or an
 * exact match against the current choice checkpoint. Semantic phrases such as
 * "continue" may preserve intent/context, but still create a new visible turn.
 */
export function shouldReuseLogicalTurnForSubmission(input: {
  explicitReuse: boolean;
  exactChoiceMatch: boolean;
}): boolean {
  return input.explicitReuse || input.exactChoiceMatch;
}

export function resolveRuntimeRunIdentity(input: {
  marker?: RunIdentityMarkerLike | null;
  sessionKey: string;
  turnId: string;
  fallbackRunId: string;
  goalSliceId?: string | null;
}): RuntimeRunIdentity {
  const markerMatches = markerBelongsToTurn(input.marker, input.sessionKey, input.turnId);
  const outerRunId = markerMatches
    ? nonEmptyString(input.marker?.runId) || input.fallbackRunId
    : input.fallbackRunId;
  const baseParentRunId = markerMatches
    ? nonEmptyString(input.marker?.parentRunId)
    : null;
  const goalSliceId = nonEmptyString(input.goalSliceId);

  if (!goalSliceId) {
    return {
      runId: outerRunId,
      parentRunId: baseParentRunId,
      outerRunId,
      source: markerMatches ? "harness_marker" : "generated_fallback",
    };
  }

  const runId = `${outerRunId}:${goalSliceId}`;
  const previousSliceRunId = markerMatches
    ? nonEmptyString(input.marker?.lastGoalSliceRunId)
    : null;
  return {
    runId,
    parentRunId: previousSliceRunId && previousSliceRunId !== runId
      ? previousSliceRunId
      : outerRunId,
    outerRunId,
    goalSliceId,
    source: markerMatches ? "harness_marker" : "generated_fallback",
  };
}
