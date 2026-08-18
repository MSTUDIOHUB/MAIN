import type { RuntimeV2ProviderRecoveryPressure } from "./decision";

export const RUNTIME_V2_LIFECYCLE_DEADLINE_CODE =
  "RUNTIME_V2_LIFECYCLE_DEADLINE_REACHED";

/**
 * This is not a Turn duration limit. It starts only after the provider has
 * returned a non-actionable decision and is cleared by the next actionable
 * decision or evidence boundary. In-flight model/tool work is never canceled
 * by this lease merely because it is slow.
 */
export const RUNTIME_V2_PROVIDER_RECOVERY_STALL_MS = 10 * 60_000;

export interface RuntimeV2ProviderRecoveryStallLease {
  readonly startedAt: number;
  readonly reason: RuntimeV2ProviderRecoveryPressure["reason"];
  readonly latestOccurrence: number;
}

export function advanceRuntimeV2ProviderRecoveryStallLease(input: {
  readonly current: RuntimeV2ProviderRecoveryStallLease | null;
  readonly pressure: RuntimeV2ProviderRecoveryPressure | null;
  /** Canonical ledger time, used when reconstructing the lease after restart. */
  readonly startedAt?: number;
  readonly now: number;
}): RuntimeV2ProviderRecoveryStallLease | null {
  if (!input.pressure) return null;
  const startedAt = input.current &&
      Number.isFinite(input.current.startedAt)
    ? input.current.startedAt
    : Number.isFinite(input.startedAt)
      ? Number(input.startedAt)
      : input.now;
  return {
    startedAt,
    reason: input.pressure.reason,
    latestOccurrence: input.pressure.occurrence,
  };
}

export function runtimeV2ProviderRecoveryStallExpired(
  lease: RuntimeV2ProviderRecoveryStallLease | null,
  now: number,
): boolean {
  return !!lease &&
    Number.isFinite(now) &&
    now - lease.startedAt >= RUNTIME_V2_PROVIDER_RECOVERY_STALL_MS;
}

export interface RuntimeV2ChildRecoveryStallLease {
  readonly startedAt: number;
  readonly occurrence: number;
}

export function advanceRuntimeV2ChildRecoveryStallLease(input: {
  readonly current: RuntimeV2ChildRecoveryStallLease | null;
  readonly progressed: boolean;
  readonly now: number;
}): RuntimeV2ChildRecoveryStallLease | null {
  if (input.progressed) return null;
  return {
    startedAt: input.current?.startedAt ?? input.now,
    occurrence: (input.current?.occurrence || 0) + 1,
  };
}

export function runtimeV2ChildRecoveryStallExpired(
  lease: RuntimeV2ChildRecoveryStallLease | null,
  now: number,
): boolean {
  return !!lease &&
    Number.isFinite(now) &&
    now - lease.startedAt >= RUNTIME_V2_PROVIDER_RECOVERY_STALL_MS;
}

/**
 * An explicit caller-owned Run budget expired while an effect was in flight.
 * Ordinary Execute does not install this boundary. When a bounded surface
 * does provide one, it remains control-plane truth rather than evidence that
 * the provider or tool transport failed.
 */
export class RuntimeV2LifecycleDeadlineError extends Error {
  readonly code = RUNTIME_V2_LIFECYCLE_DEADLINE_CODE;

  constructor() {
    super(RUNTIME_V2_LIFECYCLE_DEADLINE_CODE);
    this.name = "RuntimeV2LifecycleDeadlineError";
  }
}

export function isRuntimeV2LifecycleDeadlineError(
  error: unknown,
): error is RuntimeV2LifecycleDeadlineError {
  if (error instanceof RuntimeV2LifecycleDeadlineError) return true;
  if (!error || typeof error !== "object") return false;
  const candidate = error as { readonly code?: unknown; readonly name?: unknown };
  return candidate.code === RUNTIME_V2_LIFECYCLE_DEADLINE_CODE ||
    candidate.name === "RuntimeV2LifecycleDeadlineError";
}
