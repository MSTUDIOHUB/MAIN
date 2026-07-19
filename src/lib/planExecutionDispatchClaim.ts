const activePlanExecutionDispatchClaims = new Set<string>();

/**
 * Process-local duplicate-dispatch guard. This is deliberately not an
 * execution authority: only the persisted Plan lifecycle CAS can authorize a
 * Run after Harness admission.
 */
export function claimPlanExecutionDispatch(executionLeaseId: string): boolean {
  const normalized = String(executionLeaseId || "").trim();
  if (!normalized || activePlanExecutionDispatchClaims.has(normalized)) return false;
  activePlanExecutionDispatchClaims.add(normalized);
  return true;
}

export function releasePlanExecutionDispatch(executionLeaseId: string | null | undefined): void {
  const normalized = String(executionLeaseId || "").trim();
  if (normalized) activePlanExecutionDispatchClaims.delete(normalized);
}

export function hasPlanExecutionDispatchClaim(executionLeaseId: string): boolean {
  return activePlanExecutionDispatchClaims.has(String(executionLeaseId || "").trim());
}
