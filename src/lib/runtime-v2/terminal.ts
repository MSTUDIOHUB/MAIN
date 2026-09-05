import type { TurnAggregateV1 } from "./aggregate";
import type { RuntimeV2CheckpointV3 } from "./checkpoint";
import {
  RUNTIME_V2_EVENT_SCHEMA_VERSION,
  type RuntimeV2ResultKind,
  type RuntimeV2RunIdentity,
  type RuntimeV2TerminalOutcome,
  type RuntimeV2TurnIdentity,
} from "./contracts";
import type { RuntimeV2Event, RuntimeV2EventDraft } from "./events";
import type { CheckpointPort, ProjectionPort } from "./ports";
import { buildRuntimeV2FinalProjection } from "./projection";

export interface RuntimeV2TerminalCheckpointInput {
  readonly checkpoint: CheckpointPort;
  readonly projection: ProjectionPort;
  readonly owner: RuntimeV2TurnIdentity;
  readonly run: RuntimeV2RunIdentity;
  readonly current: RuntimeV2CheckpointV3;
  readonly resultKind: RuntimeV2ResultKind;
  readonly reason: string;
  readonly finalMarkdown?: string;
  readonly now: () => number;
  readonly nextId: (scope: string) => string;
}

/**
 * Close one already-admitted Run from its durable checkpoint. This is shared
 * by non-controller boundaries (Plan generation and approved-Plan handoff)
 * so neither can strand a scheduled command or invent a second terminal path.
 */
export async function finishRuntimeV2CheckpointTerminal(
  input: RuntimeV2TerminalCheckpointInput,
): Promise<RuntimeV2CheckpointV3> {
  let current = input.current;
  let lastAt = current.aggregate.updatedAt;
  const append = async (draft: RuntimeV2EventDraft): Promise<RuntimeV2Event> => {
    const at = Math.max(input.now(), lastAt);
    const event = {
      ...draft,
      schemaVersion: RUNTIME_V2_EVENT_SCHEMA_VERSION,
      sequence: current.aggregate.nextSequence,
      eventId: input.nextId("runtime-v2-terminal-event"),
      at,
    } as RuntimeV2Event;
    const result = await input.checkpoint.append({
      owner: input.owner,
      expectedRevision: current.revision,
      event,
    });
    if (result.disposition === "conflict" || !result.checkpoint) {
      throw new Error("RUNTIME_V2_TERMINAL_CHECKPOINT_CONFLICT");
    }
    current = result.checkpoint;
    lastAt = current.aggregate.updatedAt;
    return event;
  };

  if (!current.aggregate.terminalOutcome) {
    for (const command of [...current.aggregate.scheduledCommands]) {
      await append({
        type: "command.completed",
        run: input.run,
        idempotencyKey: command.idempotencyKey,
        status: input.resultKind === "canceled" ? "canceled" : "failed",
      });
    }
    if (!current.aggregate.events.some((event) => event.type === "command.scheduled" && event.command.kind === "finalize_turn" && event.command.payload.runtimeControlPlane === true)) {
      const phase = current.aggregate.phase;
      if (!phase || phase === "completed") throw new Error("RUNTIME_V2_TERMINAL_PHASE_INVALID");
      const command = {
        idempotencyKey: input.nextId("runtime-v2-terminal-intent"),
        kind: "finalize_turn" as const,
        run: input.run,
        phase,
        payload: { runtimeControlPlane: true, resultKind: input.resultKind, resultReason: input.reason, finalMarkdown: input.finalMarkdown },
      };
      await append({ type: "command.scheduled", run: input.run, command });
      await append({ type: "command.completed", run: input.run, idempotencyKey: command.idempotencyKey, status: "succeeded" });
    }
    if (
      input.resultKind === "canceled" &&
      !current.aggregate.events.some((event) => event.type === "run.aborted")
    ) {
      await append({
        type: "run.aborted",
        run: input.run,
        reason: input.reason,
      });
    }
    if (current.aggregate.phase !== "finalizing") {
      await append({
        type: "phase.changed",
        run: input.run,
        phase: "finalizing",
        reason: "terminal_outcome_preparation",
      });
    }
    const finalProjection = buildRuntimeV2FinalProjection(
      current.aggregate,
      input.nextId("runtime-v2-final"),
      input.resultKind,
      input.reason,
      input.finalMarkdown,
    );
    const outcome: RuntimeV2TerminalOutcome = {
      resultKind: input.resultKind,
      reason: input.reason,
      completedAt: Math.max(input.now(), current.aggregate.updatedAt),
      finalProjectionId: finalProjection.id,
    };
    await append({ type: "run.completed", run: input.run, outcome, finalProjection });
  }

  const outcome = current.aggregate.terminalOutcome!;
  let published = current.aggregate.events.find((event) => event.type === "projection.published" && event.projectionId === outcome.finalProjectionId);
  if (!published) {
    const completed = current.aggregate.events.find((event) => event.type === "run.completed");
    const finalProjection = (completed?.type === "run.completed" && completed.finalProjection) || buildRuntimeV2FinalProjection(
      current.aggregate,
      outcome.finalProjectionId,
      outcome.resultKind,
      outcome.reason,
      input.finalMarkdown,
    );
    published = await append({
      type: "projection.published",
      run: input.run,
      audience: "final",
      projectionId: finalProjection.id,
      projection: finalProjection,
    });
  }
  if (published.type === "projection.published") {
    try {
      await input.projection.publish({
        aggregate: current.aggregate,
        audience: "final",
        projection: published.projection!,
        event: published,
      });
    } catch {
      // The event is durable replay authority; UI publication is recoverable.
    }
  }
  if (!current.aggregate.events.some((event) => event.type === "turn.completed")) {
    await append({
      type: "turn.completed",
      turn: input.owner,
      runId: input.run.runId,
      outcome,
    });
  }
  return current;
}

export function isRuntimeV2TurnTerminallyClosed(
  aggregate: TurnAggregateV1,
): boolean {
  return !!aggregate.terminalOutcome &&
    aggregate.finalProjectionId === aggregate.terminalOutcome.finalProjectionId &&
    aggregate.events.some((event) => event.type === "turn.completed");
}
