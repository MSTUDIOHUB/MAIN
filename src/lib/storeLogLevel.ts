import type { DebugLogLevel } from "./debugLog";

const ERROR_EVENTS = new Set([
  "runtime_v2_execute_infrastructure_failure",
  "runtime_v2_execute_infrastructure_terminal_failed",
  "runtime_v2_execute_emergency_terminal_conflict",
  "canceled_turn_harness_terminal_conflict",
]);

const WARN_SUFFIXES = [
  "_blocked",
  "_rejected",
  "_failed",
  "_conflict",
  "_timeout",
  "_exceeded",
  "_truncated",
  "_degraded",
  "_invalidated",
  "_mismatch",
] as const;

/** Route high-signal failure/retry/diagnostic events to semantic log levels. */
export function resolveStoreEventLogLevel(
  event: string,
  data?: Record<string, unknown>,
): DebugLogLevel {
  const name = String(event || "").trim();
  if (!name) return "info";
  if (
    ERROR_EVENTS.has(name) ||
    name.endsWith("_terminal_failed") ||
    name.endsWith("_emergency_terminal_conflict")
  ) {
    return "error";
  }
  if (
    WARN_SUFFIXES.some((suffix) => name.endsWith(suffix)) ||
    name === "runtime_v2_provider_language_retry" ||
    (name === "runtime_v2_ledger_committed" &&
      data?.eventType === "recovery.exhausted")
  ) {
    return "warn";
  }
  if (
    name === "plan_workspace_hydration_empty" ||
    (name === "active_guidance_cleared" &&
      (!data || Object.keys(data).length === 0))
  ) {
    return "debug";
  }
  return "info";
}
