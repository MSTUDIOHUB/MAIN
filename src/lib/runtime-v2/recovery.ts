import type {
  RuntimeV2Command,
  RuntimeV2RecoveryBudget,
  RuntimeV2RecoveryReceipt,
  RuntimeV2RecoveryScope,
} from "./contracts";
import { isRuntimeV2ProviderProtocolError } from "./providerLane";

/**
 * These are product safety limits, not provider/model heuristics. A caller
 * may choose not to spend an available retry, but it may never exceed one.
 */
export const RUNTIME_V2_RECOVERY_LIMITS: Readonly<Record<RuntimeV2RecoveryScope, number>> = Object.freeze({
  transport: 3,
  action: 2,
  context: 1,
  diagnostic: 2,
});

/**
 * Per-fingerprint limits prevent replaying one identical action. These
 * epoch-wide limits also stop a model from evading recovery merely by
 * changing a path, patch body, tool-call id, or shell spelling each round.
 */
export const RUNTIME_V2_RECOVERY_EPOCH_LIMITS: Readonly<
  Record<RuntimeV2RecoveryScope, number>
> = Object.freeze({
  transport: 3,
  action: 4,
  context: 1,
  diagnostic: 2,
});

/** Initial execution is epoch 0; at most two evidence-backed corrective
 * mutation epochs may follow before the existing receipts must converge. */
export const RUNTIME_V2_MAX_CORRECTIVE_EPOCHS = 2;

export function runtimeV2RecoveryScopeForCommandFailure(
  command: RuntimeV2Command,
  error: unknown,
): RuntimeV2RecoveryScope {
  if (command.kind === "request_model") {
    return isRuntimeV2ProviderProtocolError(error) ? "action" : "transport";
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
    .filter(([key]) => key !== "actionFingerprint" && key !== "attempt" && key !== "toolCallId")
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
    .join(",")}}`;
}

/** Stable within a Run and insensitive to the generated idempotency key. */
export function runtimeV2ActionFingerprint(command: Pick<RuntimeV2Command, "kind" | "phase" | "payload">): string {
  const explicit = compact(command.payload.actionFingerprint, 512);
  if (explicit) return explicit;
  return `${command.phase}:${command.kind}:${canonical(command.payload)}`.slice(0, 4_096);
}

export function emptyRuntimeV2RecoveryBudget(): RuntimeV2RecoveryBudget {
  return {
    transportAttempts: 0,
    actionRepeats: 0,
    contextRefreshes: 0,
    diagnosticRepairs: 0,
    epoch: 0,
    receipts: [],
    exhausted: null,
  };
}

export function recoveryReceiptCount(
  budget: RuntimeV2RecoveryBudget,
  scope: RuntimeV2RecoveryScope,
  fingerprint: string,
  epoch = budget.epoch,
): number {
  const normalized = compact(fingerprint);
  return budget.receipts.find((receipt) =>
    receipt.scope === scope &&
    receipt.fingerprint === normalized &&
    receipt.epoch === epoch,
  )?.count || 0;
}

export function recoveryReceiptTotal(
  budget: RuntimeV2RecoveryBudget,
  scope: RuntimeV2RecoveryScope,
  epoch = budget.epoch,
): number {
  return budget.receipts
    .filter((receipt) =>
      receipt.scope === scope && receipt.epoch === epoch
    )
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
      RUNTIME_V2_RECOVERY_EPOCH_LIMITS[scope];
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
    epoch: input.budget.epoch,
    lastAttemptAt: input.at,
  };
  const retained = input.budget.receipts.filter((receipt) => !(
    receipt.scope === input.scope &&
    receipt.fingerprint === fingerprint &&
    receipt.epoch === input.budget.epoch
  ));
  return {
    ...input.budget,
    ...incrementTotal(input.budget, input.scope),
    receipts: [...retained, nextReceipt].slice(-MAX_RECOVERY_RECEIPTS),
  };
}

/** A new epoch must be backed by a novel durable evidence reference. */
export function openRuntimeV2RecoveryEpoch(
  budget: RuntimeV2RecoveryBudget,
): RuntimeV2RecoveryBudget {
  if (!canOpenRuntimeV2RecoveryEpoch(budget)) {
    throw new Error("Runtime v2 corrective recovery epoch limit is exhausted.");
  }
  return {
    ...budget,
    epoch: budget.epoch + 1,
    exhausted: null,
  };
}

export function canOpenRuntimeV2RecoveryEpoch(
  budget: RuntimeV2RecoveryBudget,
): boolean {
  return !budget.exhausted &&
    budget.epoch < RUNTIME_V2_MAX_CORRECTIVE_EPOCHS;
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
