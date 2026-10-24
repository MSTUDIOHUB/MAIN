import type {
  CanceledTurnProjectionResult,
  CanceledTurnProjectionState,
} from "../../lib/canceledTurnProjection";
import {
  appendRuntimeV2Checkpoint,
  buildRuntimeV2FinalProjection,
  commitRuntimeV2EmergencyTerminalEnvelope,
  createRuntimeV2EmergencyTerminalEnvelope,
  normalizeRuntimeV2Checkpoint,
  normalizeRuntimeV2EmergencyTerminalEnvelope,
  RUNTIME_V2_EVENT_SCHEMA_VERSION,
  runtimeV2CheckpointWriteFailureReason,
  sameRuntimeV2EmergencyTerminalRun,
  RuntimeV2Controller,
  type RuntimeV2Ports,
  type RuntimeV2TerminalOutcome,
  type TurnAggregateV1,
} from "../../lib/runtime-v2";
import { createRuntimeV2ProjectionPort } from "./projectionPort";

/** Prepare Stop in isolation, using the same controller and presentation
 * contracts as ordinary execution. The caller persists and publishes the
 * entire terminal transaction under the captured Session owner. */
export async function projectRuntimeV2CanceledTurn<
  TState extends CanceledTurnProjectionState,
>(input: {
  state: TState;
  sessionKey: string;
  turnId: string;
  runId: string;
  parentRunId?: string | null;
  reason: string;
  message: string;
  nextTaskId: () => number;
  nowMs: () => number;
  log?: (event: string, data?: Record<string, unknown>) => void;
}): Promise<CanceledTurnProjectionResult<TState> | null> {
  const source = input.state as TState & Record<string, any>;
  let checkpoint = normalizeRuntimeV2Checkpoint(
    source.runtimeV2Checkpoints?.[input.turnId],
    { sessionKey: input.sessionKey, turnId: input.turnId },
  );
  if (!checkpoint) return null;
  const sourceCheckpoint = checkpoint;
  const hadRun = !!checkpoint.aggregate.run;
  const candidateEmergency = normalizeRuntimeV2EmergencyTerminalEnvelope(
    source.runtimeV2EmergencyTerminalEnvelopes?.[input.turnId], checkpoint.owner,
  );
  const admittedEmergencyRun = !hadRun && candidateEmergency &&
    commitRuntimeV2EmergencyTerminalEnvelope({
      checkpoint, currentEnvelope: null, owner: checkpoint.owner,
      run: candidateEmergency.run, expectedRevision: checkpoint.revision,
      envelope: candidateEmergency,
    }).disposition !== "conflict"
    ? candidateEmergency.run : null;
  const run = checkpoint.aggregate.run?.identity || admittedEmergencyRun || {
    sessionKey: checkpoint.owner.sessionKey,
    sessionEpoch: checkpoint.owner.sessionEpoch,
    turnId: checkpoint.owner.turnId,
    runId: input.runId,
    parentRunId: input.parentRunId || null,
    attemptId: `attempt-cancel-${input.runId}`,
  };
  const sourceMarker = source.harnessRunMarker;
  const existingEmergency = candidateEmergency &&
    (hadRun || !!admittedEmergencyRun) &&
    candidateEmergency.lastRevision === checkpoint.revision &&
    sameRuntimeV2EmergencyTerminalRun(candidateEmergency.run, run)
    ? candidateEmergency
    : null;
  const markerOwnsTarget = sourceMarker?.sessionKey === input.sessionKey &&
    sourceMarker.turnId === input.turnId;
  const action = source.activeActionRequest;
  const foreignControls = source.currentTurnId !== input.turnId ||
    (!!sourceMarker && sourceMarker.sessionKey === input.sessionKey && !markerOwnsTarget) ||
    (!!action && action.sessionKey === input.sessionKey && action.turnId !== input.turnId);
  // The common presentation adapter verifies the canonical Run. An outer
  // process lease may expose a child action owner, so adapt only this isolated
  // view and restore the actual Harness lease before returning it.
  let projected: any = {
    ...source,
    harnessRunMarker: {
      ...sourceMarker,
      sessionKey: run.sessionKey,
      turnId: run.turnId,
      runId: run.runId,
      status: "running",
    },
  };
  const checkpointPort: RuntimeV2Ports["checkpoint"] = {
    load: async () => checkpoint,
    append: async ({ owner, expectedRevision, event }) => {
      const appended = appendRuntimeV2Checkpoint({
        checkpoint, owner, expectedRevision, event,
      });
      if (appended.disposition === "committed" || appended.disposition === "idempotent") {
        checkpoint = appended.checkpoint;
        projected = {
          ...projected,
          runtimeV2Checkpoints: {
            ...projected.runtimeV2Checkpoints,
            [input.turnId]: checkpoint,
          },
        };
      }
      return appended.disposition === "conflict"
        ? { disposition: "conflict", checkpoint: null }
        : { disposition: appended.disposition, checkpoint: appended.checkpoint };
    },
    commitEmergencyTerminal: async ({ owner, run: emergencyRun, expectedRevision, envelope }) => {
      const committed = commitRuntimeV2EmergencyTerminalEnvelope({
        checkpoint, currentEnvelope: existingEmergency, owner, run: emergencyRun,
        expectedRevision, envelope,
      });
      if (committed.disposition !== "conflict") {
        projected = {
          ...projected,
          runtimeV2EmergencyTerminalEnvelopes: {
            ...projected.runtimeV2EmergencyTerminalEnvelopes,
            [input.turnId]: committed.envelope,
          },
        };
      }
      return committed;
    },
  };
  const presentation = createRuntimeV2ProjectionPort({
    get: () => projected,
    set: (patchOrUpdater) => {
      const patch = typeof patchOrUpdater === "function"
        ? patchOrUpdater(projected)
        : patchOrUpdater;
      projected = { ...projected, ...patch };
    },
    nextTaskId: input.nextTaskId,
    language: source.config?.language === "en" ? "en" : "zh",
    logStoreEvent: input.log || (() => {}),
  });
  const unavailable = async (): Promise<never> => {
    throw new Error("Cancellation projection cannot execute effects.");
  };
  const publishPresentation: RuntimeV2Ports["projection"]["publish"] = async (publication) => {
    if (publication.audience === "final") {
      projected = {
        ...projected,
        taskFlow: projected.taskFlow.map((block: any) =>
          block.turnId === input.turnId && block.visibility === "assistant_final" &&
            block.content !== publication.projection.markdown
            ? { ...block, visibility: "assistant_update" }
            : block
        ),
      };
    }
    await presentation.publish(publication);
  };
  const controller = new RuntimeV2Controller({
    checkpoint: checkpointPort,
    provider: { request: unavailable },
    tool: { execute: unavailable },
    scheduler: { execute: unavailable },
    projection: { publish: publishPresentation },
    clockId: {
      now: input.nowMs,
      nextId: (scope) => `${scope}-${globalThis.crypto.randomUUID()}`,
      nextIdempotencyKey: ({ run: owner, kind }) => `${owner.runId}:cancel:${kind}`,
    },
  }, { aggregate: checkpoint.aggregate, revision: checkpoint.revision });
  const alreadyClosed = !!checkpoint.aggregate.terminalOutcome || !!existingEmergency;
  let outcome: RuntimeV2TerminalOutcome | null = null;
  const publishTerminalView = async (terminal: RuntimeV2TerminalOutcome) => {
    // This view derives only from a committed Run outcome or the typed
    // emergency envelope. It never becomes a second persisted aggregate.
    const aggregate: TurnAggregateV1 = {
      ...sourceCheckpoint.aggregate,
      phase: "completed",
      terminalOutcome: terminal,
      finalProjectionId: terminal.finalProjectionId,
      run: { identity: run, status: "completed", phase: "completed", terminalOutcome: terminal },
      scheduledCommands: [], pendingToolCalls: [],
    };
    const completed = sourceCheckpoint.aggregate.events.find((event) => event.type === "run.completed");
    const published = sourceCheckpoint.aggregate.events.find((event) =>
      event.type === "projection.published" && event.projectionId === terminal.finalProjectionId);
    const finalized = [...sourceCheckpoint.aggregate.events].reverse().find((event) =>
      event.type === "command.scheduled" && event.command.kind === "finalize_turn");
    const existingFinal = [...source.taskFlow].reverse().find((block: any) =>
      block.turnId === input.turnId && block.type === "agent" && block.visibility === "assistant_final");
    const finalMarkdown = sourceCheckpoint.aggregate.terminalOutcome
      ? finalized?.type === "command.scheduled"
        ? String(finalized.command.payload.finalMarkdown || "")
        : existingFinal?.type === "agent" ? existingFinal.content : undefined
      : input.message;
    const projection = completed?.type === "run.completed" && completed.finalProjection ||
      published?.type === "projection.published" && published.projection ||
      buildRuntimeV2FinalProjection(aggregate, terminal.finalProjectionId,
        terminal.resultKind, terminal.reason, finalMarkdown);
    await publishPresentation({ aggregate, audience: "final", projection, event: {
      schemaVersion: RUNTIME_V2_EVENT_SCHEMA_VERSION,
      sequence: aggregate.nextSequence, eventId: `terminal-view-${globalThis.crypto.randomUUID()}`,
      at: terminal.completedAt, type: "projection.published", run,
      audience: "final", projectionId: projection.id, projection,
    } });
  };
  try {
    if (existingEmergency) throw new Error("RUNTIME_V2_EXISTING_EMERGENCY_TERMINAL");
    if (!hadRun) await controller.startRun(run);
    await controller.finishTerminal("canceled", input.reason, input.message);
    await controller.resumeTerminalProjection();
    outcome = controller.snapshot().aggregate?.terminalOutcome || null;
  } catch (error) {
    const reasonCode = existingEmergency?.reasonCode || runtimeV2CheckpointWriteFailureReason(error);
    if (reasonCode !== "checkpoint_event_budget_exceeded" && reasonCode !== "checkpoint_size_budget_exceeded" && !existingEmergency) throw error;
    // A partially prepared terminal was never published or persisted. Restore
    // the original durable ledger before sealing its exact revision; its size
    // bound is unchanged and no partial cancel events are saved alongside it.
    checkpoint = sourceCheckpoint;
    projected = {
      ...source,
      harnessRunMarker: {
        ...sourceMarker, sessionKey: run.sessionKey, turnId: run.turnId,
        runId: run.runId, status: "running",
      },
      runtimeV2Checkpoints: { ...source.runtimeV2Checkpoints, [input.turnId]: sourceCheckpoint },
    };
    if (sourceCheckpoint.aggregate.terminalOutcome) {
      // A completed successful Run remains authoritative even when there is
      // no room left to append its presentation acknowledgment.
      outcome = sourceCheckpoint.aggregate.terminalOutcome;
    } else {
      const envelope = existingEmergency || createRuntimeV2EmergencyTerminalEnvelope({
        owner: sourceCheckpoint.owner, run, resultKind: "canceled", reasonCode: reasonCode!,
        language: source.config?.language === "en" ? "en" : "zh", at: input.nowMs(),
        lastRevision: sourceCheckpoint.revision,
        hasMutation: sourceCheckpoint.aggregate.evidence.some((evidence) => evidence.kind === "mutation"),
      });
      const sealed = await checkpointPort.commitEmergencyTerminal({
        owner: sourceCheckpoint.owner, run, expectedRevision: sourceCheckpoint.revision, envelope,
      });
      if (sealed.disposition === "conflict" || !sealed.envelope) throw error;
      outcome = {
        resultKind: sealed.envelope.resultKind, reason: sealed.envelope.reason,
        completedAt: sealed.envelope.at,
        finalProjectionId: `emergency-final-${run.runId}-${sealed.envelope.lastRevision}`,
      };
    }
    await publishTerminalView(outcome);
  }
  const harnessRunMarker = sourceMarker && markerOwnsTarget
    ? {
        ...sourceMarker,
        status: outcome?.resultKind === "error" ? "error" as const : "completed" as const,
        terminalResultKind: outcome?.resultKind,
        updatedAt: input.nowMs(),
        closedAt: input.nowMs(),
        closeReason: outcome?.reason || input.reason,
      }
    : sourceMarker || null;
  projected = {
    ...projected,
    harnessRunMarker,
    ...(foreignControls
      ? {
          agentStatus: source.agentStatus,
          isGenerating: source.isGenerating,
          abortController: source.abortController,
          activeActionRequest: source.activeActionRequest,
          pendingReviewResolve: source.pendingReviewResolve,
          pendingReviewTaskId: source.pendingReviewTaskId,
          pendingToolCall: source.pendingToolCall,
        }
      : { pendingReviewResolve: null, pendingReviewTaskId: null }),
  };
  return {
    state: projected as TState,
    cancellationRunId: run.runId,
    harnessRunMarker,
    disposition: alreadyClosed ? "already_closed" : "committed",
  };
}
