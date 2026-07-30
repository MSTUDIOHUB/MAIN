import type {
  RuntimeV2Command,
  RuntimeV2RecoveryBudget,
  RuntimeV2RecoveryReceipt,
  RuntimeV2RecoveryScope,
} from "./contracts";
import { isRuntimeV2ProviderProtocolError } from "./providerLane";
import { sha256Hex } from "../sha256";

/**
 * Bounded diagnostic receipt retention. Reaching these limits only coalesces
 * repeated recovery telemetry; it never ends a Run or revokes a tool.
 */
export const RUNTIME_V2_RECOVERY_LIMITS: Readonly<Record<RuntimeV2RecoveryScope, number>> = Object.freeze({
  transport: 3,
  action: 2,
  context: 1,
  diagnostic: 2,
});

/** Keep recovery telemetry bounded for one Run. Side-effect replay is
 * enforced separately by the action guard and lifecycle completion is owned
 * by explicit hard boundaries. */
export const RUNTIME_V2_RECOVERY_TOTAL_LIMITS: Readonly<
  Record<RuntimeV2RecoveryScope, number>
> = Object.freeze({
  transport: 3,
  action: 4,
  context: 1,
  diagnostic: 2,
});

export function runtimeV2RecoveryScopeForCommandFailure(
  command: RuntimeV2Command,
  error: unknown,
): RuntimeV2RecoveryScope {
  if (command.kind === "request_model") {
    return isRuntimeV2ProviderProtocolError(error)
      ? "diagnostic"
      : "transport";
  }
  const message = error instanceof Error ? error.message : String(error || "");
  return /context|token|window/i.test(message) ? "context" : "action";
}

const MAX_RECOVERY_RECEIPTS = 96;

function compact(value: unknown, max = 512): string {
  return typeof value === "string"
    ? value.replace(/\s+/g, " ").trim().slice(0, max)
    : "";
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (!value || typeof value !== "object") return JSON.stringify(value);
  return `{${Object.entries(value as Record<string, unknown>)
    // `toolCallId` is issued by a provider transport and is not the semantic
    // identity of the requested file/command. Do not let it defeat bounded
    // recovery when a provider retries the same action with a new id.
    .filter(([key]) =>
      key !== "actionFingerprint" &&
      key !== "attempt" &&
      key !== "toolCallId" &&
      key !== "effectPressure"
    )
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
    .join(",")}}`;
}

/** Stable within a Run and insensitive to the generated idempotency key. */
export function runtimeV2ActionFingerprint(command: Pick<RuntimeV2Command, "kind" | "phase" | "payload">): string {
  const explicit = compact(command.payload.actionFingerprint, 4_096);
  if (/^runtime-v2-action-sha256-[0-9a-f]{64}$/.test(explicit)) {
    return explicit;
  }
  const identity = explicit ||
    `${command.phase}:${command.kind}:${canonical(command.payload)}`;
  return `runtime-v2-action-sha256-${sha256Hex(identity)}`;
}

export function emptyRuntimeV2RecoveryBudget(): RuntimeV2RecoveryBudget {
  return {
    transportAttempts: 0,
    actionRepeats: 0,
    contextRefreshes: 0,
    diagnosticRepairs: 0,
    receipts: [],
    exhausted: null,
  };
}

export function recoveryReceiptCount(
  budget: RuntimeV2RecoveryBudget,
  scope: RuntimeV2RecoveryScope,
  fingerprint: string,
): number {
  const normalized = compact(fingerprint);
  return budget.receipts.find((receipt) =>
    receipt.scope === scope &&
    receipt.fingerprint === normalized,
  )?.count || 0;
}

export function recoveryReceiptTotal(
  budget: RuntimeV2RecoveryBudget,
  scope: RuntimeV2RecoveryScope,
): number {
  return budget.receipts
    .filter((receipt) => receipt.scope === scope)
    .reduce((total, receipt) => total + receipt.count, 0);
}

export function canRecordRuntimeV2Recovery(
  budget: RuntimeV2RecoveryBudget,
  scope: RuntimeV2RecoveryScope,
  fingerprint: string,
): boolean {
  return !budget.exhausted &&
    !!compact(fingerprint) &&
    recoveryReceiptCount(budget, scope, fingerprint) <
      RUNTIME_V2_RECOVERY_LIMITS[scope] &&
    recoveryReceiptTotal(budget, scope) <
      RUNTIME_V2_RECOVERY_TOTAL_LIMITS[scope];
}

function incrementTotal(
  budget: RuntimeV2RecoveryBudget,
  scope: RuntimeV2RecoveryScope,
): Pick<RuntimeV2RecoveryBudget, "transportAttempts" | "actionRepeats" | "contextRefreshes" | "diagnosticRepairs"> {
  return {
    transportAttempts: budget.transportAttempts + (scope === "transport" ? 1 : 0),
    actionRepeats: budget.actionRepeats + (scope === "action" ? 1 : 0),
    contextRefreshes: budget.contextRefreshes + (scope === "context" ? 1 : 0),
    diagnosticRepairs: budget.diagnosticRepairs + (scope === "diagnostic" ? 1 : 0),
  };
}

/** Apply a recovery receipt only after the reducer has accepted the event. */
export function recordRuntimeV2Recovery(input: {
  readonly budget: RuntimeV2RecoveryBudget;
  readonly scope: RuntimeV2RecoveryScope;
  readonly fingerprint: string;
  readonly at: number;
}): RuntimeV2RecoveryBudget {
  const fingerprint = compact(input.fingerprint);
  if (!canRecordRuntimeV2Recovery(input.budget, input.scope, fingerprint)) {
    throw new Error("Runtime v2 recovery budget is exhausted for this structural action.");
  }
  const previous = recoveryReceiptCount(input.budget, input.scope, fingerprint);
  const nextReceipt: RuntimeV2RecoveryReceipt = {
    scope: input.scope,
    fingerprint,
    count: previous + 1,
    lastAttemptAt: input.at,
  };
  const retained = input.budget.receipts.filter((receipt) => !(
    receipt.scope === input.scope &&
    receipt.fingerprint === fingerprint
  ));
  return {
    ...input.budget,
    ...incrementTotal(input.budget, input.scope),
    receipts: [...retained, nextReceipt].slice(-MAX_RECOVERY_RECEIPTS),
  };
}

export function exhaustRuntimeV2Recovery(input: {
  readonly budget: RuntimeV2RecoveryBudget;
  readonly scope: RuntimeV2RecoveryScope;
  readonly fingerprint: string;
  readonly reason: string;
  readonly at: number;
}): RuntimeV2RecoveryBudget {
  if (input.budget.exhausted) return input.budget;
  return {
    ...input.budget,
    exhausted: {
      scope: input.scope,
      fingerprint: compact(input.fingerprint),
      reason: compact(input.reason, 1_024) || "recovery_budget_exhausted",
      at: input.at,
    },
  };
}
