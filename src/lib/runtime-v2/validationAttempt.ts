/** Transport settlement is distinct from validation execution. This leaf
 * predicate deliberately depends on no ledger types, so event definitions and
 * every semantic consumer can share it without introducing a type cycle. */
export function isRuntimeV2ValidationAttempt<
  T extends { readonly type: string; readonly failureKind?: string },
>(event: T): event is Extract<T, { readonly type: "validation.completed" }> {
  // A contradictory passed=true cannot promote an explicitly unexecuted
  // receipt into validation evidence or progress.
  return event.type === "validation.completed" && event.failureKind !== "not_executed";
}
