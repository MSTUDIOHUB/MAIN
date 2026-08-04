import type { TurnAggregateV1 } from "./aggregate";
import type {
  RuntimeV2Command,
  RuntimeV2Projection,
  RuntimeV2RecoveryScope,
} from "./contracts";
import type { RuntimeV2Event } from "./events";
import {
  isRuntimeV2ProviderProtocolError,
  isRuntimeV2ProviderTransportsUnavailableError,
} from "./providerLane";
import { isRuntimeV2LifecycleDeadlineError } from "./lifecycle";
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

function currentMutationBoundary(
  aggregate: TurnAggregateV1,
  phaseBoundary: number,
): number {
  for (
    let index = aggregate.events.length - 1;
    index >= phaseBoundary;
    index -= 1
  ) {
    const event = aggregate.events[index]!;
    if (
      event.type === "tool.completed" &&
      event.status === "succeeded" &&
      event.evidence.some((evidence) => evidence.kind === "mutation")
    ) {
      return index + 1;
    }
  }
  return phaseBoundary;
}

/** Soft signals are durable pressure facts, not an iteration transcript.
 * Presence signals are retained once per phase. Repeated safe reads are
 * represented by their ordinary tool receipt and bounded provider feedback,
 * so one repeat signal per phase and mutation boundary is sufficient. */
export function shouldRecordRuntimeV2SoftSignal(input: {
  readonly aggregate: TurnAggregateV1;
  readonly signal: RuntimeV2SoftSignal;
}): boolean {
  const phaseBoundary = currentPhaseBoundary(input.aggregate);
  const signalBoundary = input.signal === "repeat"
    ? currentMutationBoundary(input.aggregate, phaseBoundary)
    : phaseBoundary;
  const phaseEvents = input.aggregate.events.slice(
    signalBoundary,
  );
  return !phaseEvents.some((event) =>
    event.type === "soft_signal.observed" &&
    event.signal === input.signal
  );
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
      /** An explicit caller-owned absolute budget owns the terminal decision. */
      readonly kind: "lifecycle_boundary";
      readonly publish: false;
    }
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
      /**
       * The failed command receipt already is the durable progress signal.
       * Saturating the bounded diagnostic ledger must not become a lifecycle
       * terminal; a real recovery-stall or caller-owned boundary owns that
       * decision outside this retry ledger.
       */
      readonly kind: "continue";
      readonly publish: boolean;
    }
  | {
      /** The provider adapter, rather than a retry count, proved that no
       * compatible request path remains for this Run. */
      readonly kind: "hard_stop";
      readonly scope: "transport";
      readonly fingerprint: string;
      readonly reason: "provider_transports_unavailable";
      readonly publish: true;
    };

export function decideRuntimeV2CommandFailureRecovery(input: {
  readonly aggregate: TurnAggregateV1;
  readonly command: RuntimeV2Command;
  readonly error: unknown;
}): RuntimeV2FailureRecoveryDecision {
  if (isRuntimeV2LifecycleDeadlineError(input.error)) {
    return {
      kind: "lifecycle_boundary",
      publish: false,
    };
  }
  if (isRuntimeV2ProviderProtocolError(input.error)) {
    return {
      kind: "signal",
      signal: "protocol_drift",
      publish: true,
    };
  }
  if (isRuntimeV2ProviderTransportsUnavailableError(input.error)) {
    return {
      kind: "hard_stop",
      scope: "transport",
      fingerprint:
        `transport:${runtimeV2ActionFingerprint(input.command)}`,
      reason: "provider_transports_unavailable",
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
    kind: "continue",
    publish: true,
  };
}

export function decideRuntimeV2SemanticFailureRecovery(input: {
  readonly aggregate: TurnAggregateV1;
  readonly command: RuntimeV2Command;
  readonly event: RuntimeV2Event;
}): Exclude<RuntimeV2FailureRecoveryDecision, {
  readonly kind: "continue" | "hard_stop" | "lifecycle_boundary";
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
