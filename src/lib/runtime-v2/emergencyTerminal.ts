import type {
  RuntimeV2RunIdentity,
  RuntimeV2TurnIdentity,
} from "./contracts";

export const RUNTIME_V2_EMERGENCY_TERMINAL_ENVELOPE_SCHEMA_VERSION =
  "runtime-v2-emergency-terminal-envelope.v1" as const;

export type RuntimeV2EmergencyTerminalReasonCode =
  | "checkpoint_event_budget_exceeded"
  | "checkpoint_size_budget_exceeded"
  | "checkpoint_persist_failed";

export type RuntimeV2EmergencyTerminalResultKind =
  | "partial"
  | "error"
  | "canceled";

/**
 * Last-resort durable terminal fact. This is deliberately not another
 * aggregate or event stream: the canonical ledger remains the normal owner.
 * The discriminator plus these eight fields are the complete persisted
 * whitelist; Store state, events and provider text are never accepted.
 */
export interface RuntimeV2EmergencyTerminalEnvelopeV1 {
  readonly schemaVersion:
    typeof RUNTIME_V2_EMERGENCY_TERMINAL_ENVELOPE_SCHEMA_VERSION;
  readonly owner: RuntimeV2TurnIdentity;
  readonly run: RuntimeV2RunIdentity;
  readonly resultKind: RuntimeV2EmergencyTerminalResultKind;
  readonly reasonCode: RuntimeV2EmergencyTerminalReasonCode;
  readonly reason: string;
  readonly at: number;
  readonly lastRevision: number;
  readonly hasMutation: boolean;
}

export type RuntimeV2EmergencyTerminalEnvelopeMap =
  Record<string, RuntimeV2EmergencyTerminalEnvelopeV1>;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyTrimmedString(value: unknown): value is string {
  return typeof value === "string" &&
    value.length > 0 &&
    value.trim() === value;
}

function normalizeOwner(value: unknown): RuntimeV2TurnIdentity | null {
  if (!isPlainRecord(value)) return null;
  const owner = value as unknown as RuntimeV2TurnIdentity;
  return [
      owner.workspaceKey,
      owner.sessionKey,
      owner.sessionEpoch,
      owner.clientSubmissionId,
      owner.turnId,
    ].every(nonEmptyTrimmedString)
    ? {
        workspaceKey: owner.workspaceKey,
        sessionKey: owner.sessionKey,
        sessionEpoch: owner.sessionEpoch,
        clientSubmissionId: owner.clientSubmissionId,
        turnId: owner.turnId,
      }
    : null;
}

function normalizeRun(value: unknown): RuntimeV2RunIdentity | null {
  if (!isPlainRecord(value)) return null;
  const run = value as unknown as RuntimeV2RunIdentity;
  if (
    ![
      run.sessionKey,
      run.sessionEpoch,
      run.turnId,
      run.runId,
      run.attemptId,
    ].every(nonEmptyTrimmedString) ||
    !(
      run.parentRunId === null ||
      nonEmptyTrimmedString(run.parentRunId)
    )
  ) {
    return null;
  }
  return {
    sessionKey: run.sessionKey,
    sessionEpoch: run.sessionEpoch,
    turnId: run.turnId,
    runId: run.runId,
    parentRunId: run.parentRunId,
    attemptId: run.attemptId,
  };
}

function sameOwner(
  left: RuntimeV2TurnIdentity,
  right: Partial<RuntimeV2TurnIdentity>,
): boolean {
  return Object.entries(right).every(([key, expected]) =>
    expected === undefined ||
    left[key as keyof RuntimeV2TurnIdentity] === expected
  );
}

export function sameRuntimeV2EmergencyTerminalRun(
  left: RuntimeV2RunIdentity,
  right: RuntimeV2RunIdentity,
): boolean {
  return left.sessionKey === right.sessionKey &&
    left.sessionEpoch === right.sessionEpoch &&
    left.turnId === right.turnId &&
    left.runId === right.runId &&
    left.parentRunId === right.parentRunId &&
    left.attemptId === right.attemptId;
}

export function runtimeV2EmergencyTerminalReason(input: {
  readonly reasonCode: RuntimeV2EmergencyTerminalReasonCode;
  readonly resultKind: RuntimeV2EmergencyTerminalResultKind;
  readonly language: "zh" | "en";
}): string {
  const boundary = input.language === "zh"
    ? {
        checkpoint_event_budget_exceeded:
          "运行时事件账本已达到安全容量边界。",
        checkpoint_size_budget_exceeded:
          "运行时检查点已达到安全大小边界。",
        checkpoint_persist_failed:
          "运行时检查点未能持久化。",
      }[input.reasonCode]
    : {
        checkpoint_event_budget_exceeded:
          "The runtime event ledger reached its safe capacity boundary.",
        checkpoint_size_budget_exceeded:
          "The runtime checkpoint reached its safe size boundary.",
        checkpoint_persist_failed:
          "The runtime checkpoint could not be persisted.",
      }[input.reasonCode];
  const outcome = input.language === "zh"
    ? {
        partial:
          "已保留实际修改，但验收尚未完整持久化，因此本轮以部分完成收口。",
        error:
          "本轮没有形成可验收的实际修改，已以错误结论收口。",
        canceled:
          "用户已停止本轮执行；此前已提交的修改仍予保留。",
      }[input.resultKind]
    : {
        partial:
          "Actual changes were retained, but acceptance was not fully persisted, so this turn closed as partial.",
        error:
          "This turn produced no accepted change and closed with an error.",
        canceled:
          "The user stopped this run; any previously committed changes remain preserved.",
      }[input.resultKind];
  return `${boundary} ${outcome}`;
}

export function createRuntimeV2EmergencyTerminalEnvelope(input: {
  readonly owner: RuntimeV2TurnIdentity;
  readonly run: RuntimeV2RunIdentity;
  readonly resultKind: RuntimeV2EmergencyTerminalResultKind;
  readonly reasonCode: RuntimeV2EmergencyTerminalReasonCode;
  readonly language: "zh" | "en";
  readonly at: number;
  readonly lastRevision: number;
  readonly hasMutation: boolean;
}): RuntimeV2EmergencyTerminalEnvelopeV1 {
  const candidate = normalizeRuntimeV2EmergencyTerminalEnvelope({
    schemaVersion:
      RUNTIME_V2_EMERGENCY_TERMINAL_ENVELOPE_SCHEMA_VERSION,
    owner: input.owner,
    run: input.run,
    resultKind: input.resultKind,
    reasonCode: input.reasonCode,
    reason: runtimeV2EmergencyTerminalReason(input),
    at: input.at,
    lastRevision: input.lastRevision,
    hasMutation: input.hasMutation,
  }, input.owner);
  if (
    !candidate ||
    !sameRuntimeV2EmergencyTerminalRun(candidate.run, input.run)
  ) {
    throw new Error("RUNTIME_V2_EMERGENCY_TERMINAL_INPUT_INVALID");
  }
  return candidate;
}

export function normalizeRuntimeV2EmergencyTerminalEnvelope(
  value: unknown,
  expectedOwner?: Partial<RuntimeV2TurnIdentity>,
): RuntimeV2EmergencyTerminalEnvelopeV1 | null {
  if (!isPlainRecord(value)) return null;
  if (
    value.schemaVersion !==
      RUNTIME_V2_EMERGENCY_TERMINAL_ENVELOPE_SCHEMA_VERSION
  ) {
    return null;
  }
  const owner = normalizeOwner(value.owner);
  const run = normalizeRun(value.run);
  if (
    !owner ||
    !run ||
    (expectedOwner && !sameOwner(owner, expectedOwner)) ||
    run.sessionKey !== owner.sessionKey ||
    run.sessionEpoch !== owner.sessionEpoch ||
    run.turnId !== owner.turnId
  ) {
    return null;
  }
  const resultKind = value.resultKind;
  if (
    resultKind !== "partial" &&
    resultKind !== "error" &&
    resultKind !== "canceled"
  ) {
    return null;
  }
  const reasonCode = value.reasonCode;
  if (
    reasonCode !== "checkpoint_event_budget_exceeded" &&
    reasonCode !== "checkpoint_size_budget_exceeded" &&
    reasonCode !== "checkpoint_persist_failed"
  ) {
    return null;
  }
  const reason = nonEmptyTrimmedString(value.reason)
    ? value.reason
    : "";
  if (
    reason !== runtimeV2EmergencyTerminalReason({
      reasonCode,
      resultKind,
      language: "zh",
    }) &&
    reason !== runtimeV2EmergencyTerminalReason({
      reasonCode,
      resultKind,
      language: "en",
    })
  ) {
    return null;
  }
  const at = Number(value.at);
  const lastRevision = Number(value.lastRevision);
  if (
    !Number.isSafeInteger(at) ||
    at < 946_684_800_000 ||
    !Number.isSafeInteger(lastRevision) ||
    lastRevision < 0 ||
    typeof value.hasMutation !== "boolean"
  ) {
    return null;
  }
  return {
    schemaVersion:
      RUNTIME_V2_EMERGENCY_TERMINAL_ENVELOPE_SCHEMA_VERSION,
    owner,
    run,
    resultKind,
    reasonCode,
    reason,
    at,
    lastRevision,
    hasMutation: value.hasMutation,
  };
}

export function normalizeRuntimeV2EmergencyTerminalEnvelopeMap(
  value: unknown,
  expectedOwner?: Partial<RuntimeV2TurnIdentity>,
): RuntimeV2EmergencyTerminalEnvelopeMap {
  if (!isPlainRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .map(([turnId, candidate]) => [
        turnId,
        normalizeRuntimeV2EmergencyTerminalEnvelope(candidate, {
          ...expectedOwner,
          turnId,
        }),
      ] as const)
      .filter((
        entry,
      ): entry is [string, RuntimeV2EmergencyTerminalEnvelopeV1] =>
        !!entry[1]
      ),
  );
}
