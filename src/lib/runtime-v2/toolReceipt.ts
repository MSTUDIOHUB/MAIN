/** A settled provider pair can represent a canceled dependency, not an
 * attempted tool action. Keep this distinction in every ledger consumer. */
export function isRuntimeV2UnexecutedToolReceipt<T extends {
  readonly type: string;
  readonly failureReasonCode?: string;
}>(event: T): event is Extract<T, { readonly type: "tool.completed" }> & {
  readonly failureReasonCode: "provider_batch_predecessor_failed" | "provider_batch_predecessor_unsettled";
} {
  return event.type === "tool.completed" &&
    (event.failureReasonCode === "provider_batch_predecessor_failed" ||
      event.failureReasonCode === "provider_batch_predecessor_unsettled");
}
