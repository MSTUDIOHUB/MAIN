import type { TurnAggregateV1 } from "./aggregate";
import type {
  RuntimeV2Command,
  RuntimeV2Projection,
  RuntimeV2RecoveryScope,
} from "./contracts";
import type { RuntimeV2Event } from "./events";
import { isRuntimeV2ProviderProtocolError } from "./providerLane";
import {
  canRecordRuntimeV2Recovery,
  runtimeV2ActionFingerprint,
  runtimeV2RecoveryScopeForCommandFailure,
} from "./recovery";
import { workspacePathsReferToSameFile } from "../workspacePaths";

type RuntimeV2SoftSignal = Extract<
  RuntimeV2Event,
  { readonly type: "soft_signal.observed" }
>["signal"];

function currentPhaseBoundary(aggregate: TurnAggregateV1): number {
  for (let index = aggregate.events.length - 1; index >= 0; index -= 1) {
    const event = aggregate.events[index]!;
    if (
      (event.type === "phase.changed" &&
        event.phase === aggregate.phase) ||
      (event.type === "run.started" &&
        event.phase === aggregate.phase)
    ) {
      return index + 1;
    }
  }
  return 0;
}

/** Soft signals are durable state, not an iteration transcript. Retain one
 * occurrence per phase, except repeated-source pressure which is retained
 * once per concrete source target. */
export function shouldRecordRuntimeV2SoftSignal(input: {
  readonly aggregate: TurnAggregateV1;
  readonly signal: RuntimeV2SoftSignal;
}): boolean {
  const phaseEvents = input.aggregate.events.slice(
    currentPhaseBoundary(input.aggregate),
  );
  if (input.signal !== "repeat") {
    return !phaseEvents.some((event) =>
      event.type === "soft_signal.observed" &&
      event.signal === input.signal
    );
  }
  const latestSource = [...phaseEvents].reverse().find((event) =>
    event.type === "tool.completed" &&
    event.status === "succeeded" &&
    event.evidence.some((evidence) => evidence.kind === "source")
  );
  const target = latestSource?.type === "tool.completed"
    ? latestSource.evidence.find((evidence) =>
        evidence.kind === "source"
      )?.target || ""
    : "";
  if (!target) return true;
  return !phaseEvents.some((event, index) => {
    if (
      event.type !== "soft_signal.observed" ||
      event.signal !== "repeat"
    ) {
      return false;
    }
    for (let sourceIndex = index - 1; sourceIndex >= 0; sourceIndex -= 1) {
      const sourceEvent = phaseEvents[sourceIndex]!;
      if (
        sourceEvent.type === "tool.completed" &&
        sourceEvent.status === "succeeded"
      ) {
        return sourceEvent.evidence.some((evidence) =>
          evidence.kind === "source" &&
          evidence.target === target
        );
      }
    }
    return false;
  });
}

/** Presentation updates are replayable but semantically identical updates in
 * one phase carry no new lifecycle fact. Coalescing them keeps checkpoint
 * capacity for commands, evidence and terminal receipts. */
export function repeatsRuntimeV2ProjectionInCurrentPhase(input: {
  readonly aggregate: TurnAggregateV1;
  readonly projection: RuntimeV2Projection;
}): boolean {
  if (input.projection.audience === "final") return false;
  return input.aggregate.events
    .slice(currentPhaseBoundary(input.aggregate))
    .some((event) =>
      event.type === "projection.published" &&
      event.audience === input.projection.audience &&
      event.projection.kind === input.projection.kind &&
      event.projection.markdown === input.projection.markdown
    );
}

export type RuntimeV2FailureRecoveryDecision =
  | {
      readonly kind: "signal";
      readonly signal:
        | "protocol_drift"
        | "context_pressure"
        | "repeated_action";
      readonly publish: boolean;
    }
  | {
      readonly kind: "record";
      readonly scope: RuntimeV2RecoveryScope;
      readonly fingerprint: string;
      readonly publish: boolean;
    }
  | {
      readonly kind: "exhaust";
      readonly scope: "transport";
      readonly fingerprint: string;
      readonly reason: "provider_transport_exhausted";
    };

export function decideRuntimeV2CommandFailureRecovery(input: {
  readonly aggregate: TurnAggregateV1;
  readonly command: RuntimeV2Command;
  readonly error: unknown;
}): RuntimeV2FailureRecoveryDecision {
  if (isRuntimeV2ProviderProtocolError(input.error)) {
    return {
      kind: "signal",
      signal: "protocol_drift",
      publish: true,
    };
  }
  const scope = runtimeV2RecoveryScopeForCommandFailure(
    input.command,
    input.error,
  );
  if (scope === "context") {
    return {
      kind: "signal",
      signal: "context_pressure",
      publish: false,
    };
  }
  const fingerprint =
    `${scope}:${runtimeV2ActionFingerprint(input.command)}`;
  if (
    canRecordRuntimeV2Recovery(
      input.aggregate.recovery,
      scope,
      fingerprint,
    )
  ) {
    return {
      kind: "record",
      scope,
      fingerprint,
      publish: true,
    };
  }
  if (scope !== "transport") {
    return {
      kind: "signal",
      signal: "repeated_action",
      publish: true,
    };
  }
  return {
    kind: "exhaust",
    scope,
    fingerprint,
    reason: "provider_transport_exhausted",
  };
}

export function decideRuntimeV2SemanticFailureRecovery(input: {
  readonly aggregate: TurnAggregateV1;
  readonly command: RuntimeV2Command;
  readonly event: RuntimeV2Event;
}): Exclude<RuntimeV2FailureRecoveryDecision, {
  readonly kind: "exhaust";
}> | null {
  const toolFailed =
    input.event.type === "tool.completed" &&
    input.event.status !== "succeeded";
  const validationStructurallyFailed =
    input.event.type === "validation.completed" &&
    !input.event.passed &&
    (
      input.event.failureKind === "protocol_invalid" ||
      input.event.failureKind === "not_authorized"
    );
  if (!toolFailed && !validationStructurallyFailed) return null;
  const scope: RuntimeV2RecoveryScope = "action";
  const fingerprint =
    `${scope}:${runtimeV2ActionFingerprint(input.command)}`;
  if (
    canRecordRuntimeV2Recovery(
      input.aggregate.recovery,
      scope,
      fingerprint,
    )
  ) {
    return {
      kind: "record",
      scope,
      fingerprint,
      publish: false,
    };
  }
  return {
    kind: "signal",
    signal: "repeated_action",
    publish: false,
  };
}

export function repeatsCommittedRuntimeV2SourceEvidence(input: {
  readonly aggregate: TurnAggregateV1;
  readonly event: RuntimeV2Event;
  readonly command: RuntimeV2Command;
}): boolean {
  const { aggregate, event } = input;
  if (
    event.type !== "tool.completed" ||
    event.status !== "succeeded" ||
    event.evidence.length === 0 ||
    !event.evidence.every((item) => item.kind === "source")
  ) {
    return false;
  }
  return aggregate.events.some((candidate) =>
    candidate.type === "tool.completed" &&
    candidate.status === "succeeded" &&
    event.evidence.every((incoming) =>
      candidate.evidence.some((existing) =>
        existing.kind === incoming.kind &&
        workspacePathsReferToSameFile(
          existing.target,
          incoming.target,
        ) &&
        (existing.version || null) === (incoming.version || null)
      )
    )
  );
}
