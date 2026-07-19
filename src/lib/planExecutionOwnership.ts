import type { HarnessRunMarker } from "./harnessCrashTelemetry";
import {
  doesLifecycleRetainPlanExecutionProvenance,
  isPlanExecutionRunProvenanceForOwner,
} from "./planExecutionProvenance";
import type { PlanLifecycleState } from "./planLifecycle";

/**
 * True only when the currently published Harness action owner is the exact
 * admitted Plan attempt whose authority is about to be revoked. A Session may
 * run an unrelated Turn while retaining paused Plan artifacts; that Run must
 * never be aborted merely because the Plan changes.
 */
export function isHarnessMarkerOwnedByPlanExecution(input: {
  lifecycle: PlanLifecycleState | null | undefined;
  marker: HarnessRunMarker | null | undefined;
}): boolean {
  const lifecycle = input.lifecycle;
  const marker = input.marker;
  const execution = lifecycle?.execution;
  const provenance = marker?.activePlanExecutionProvenance;
  if (
    !lifecycle ||
    !execution ||
    !marker ||
    (marker.status !== "running" && marker.status !== "paused") ||
    !provenance
  ) {
    return false;
  }
  return marker.sessionKey === lifecycle.sessionKey &&
    marker.turnId === execution.turnId &&
    (marker.activeRunId || marker.runId) === execution.runId &&
    (marker.activeParentRunId || null) === execution.parentRunId &&
    isPlanExecutionRunProvenanceForOwner(provenance, {
      sessionKey: lifecycle.sessionKey,
      turnId: execution.turnId,
      runId: execution.runId,
      parentRunId: execution.parentRunId,
    }) &&
    doesLifecycleRetainPlanExecutionProvenance(lifecycle, provenance);
}
