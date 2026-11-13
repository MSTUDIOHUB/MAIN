import type { RuntimeV2PlanContinuation } from "./contracts";

interface ContinuationLedgerEvent {
  readonly type: string;
  readonly sequence: number;
  readonly continuation?: RuntimeV2PlanContinuation;
  readonly continuationApprovalId?: string;
}

/** The baseline takes effect with the new owner's approval, never at seal. */
export function approvedRuntimeV2PlanContinuation(events: readonly ContinuationLedgerEvent[]): {
  readonly continuation: RuntimeV2PlanContinuation;
  readonly sequence: number;
} | null {
  let approval: ContinuationLedgerEvent | undefined;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.type === "work_plan.invalidated") return null;
    if (event.type === "work_plan.approved") {
      if (!event.continuationApprovalId || approval) return null;
      approval = event;
    }
    if (event.type === "work_plan.sealed") {
      const continuation = event.continuation;
      return approval && continuation && continuation.source.approvalEventId === approval.continuationApprovalId
        ? { continuation, sequence: approval.sequence } : null;
    }
  }
  return null;
}
