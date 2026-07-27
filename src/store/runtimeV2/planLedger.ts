import {
  RUNTIME_V2_EVENT_SCHEMA_VERSION,
  buildRuntimeV2CapsuleProjection,
  buildRuntimeV2TimelineProjection,
  canRecordRuntimeV2Recovery,
  createRuntimeV2Checkpoint,
  finishRuntimeV2CheckpointTerminal,
  type CheckpointPort,
  type ProjectionPort,
  type RuntimeV2Command,
  type RuntimeV2Event,
  type RuntimeV2EventDraft,
  type RuntimeV2Projection,
  type RuntimeV2RecoveryScope,
  type RuntimeV2ResultKind,
  type RuntimeV2RunIdentity,
  type RuntimeV2TurnIdentity,
  type TurnAggregateV1,
} from "../../lib/runtime-v2";

export class PlanLedger {
  private revision: number;
  private aggregate: TurnAggregateV1 | null;
  private ordinal = 0;
  private lastAt = 0;

  constructor(
    private readonly owner: RuntimeV2TurnIdentity,
    private readonly port: CheckpointPort,
    private readonly projection: ProjectionPort,
    initial: { readonly revision: number; readonly aggregate: TurnAggregateV1 } | null,
  ) {
    this.revision = initial?.revision || 0;
    this.aggregate = initial?.aggregate || null;
    this.lastAt = initial?.aggregate.updatedAt || 0;
  }

  snapshot(): TurnAggregateV1 | null {
    return this.aggregate;
  }

  nextId(scope: string): string {
    this.ordinal += 1;
    return `${scope}:${this.owner.turnId}:${Date.now().toString(36)}:${this.ordinal}`;
  }

  private eventBase() {
    const at = Math.max(Date.now(), this.lastAt);
    this.lastAt = at;
    return {
      schemaVersion: RUNTIME_V2_EVENT_SCHEMA_VERSION,
      sequence: this.aggregate?.nextSequence || 0,
      eventId: this.nextId("runtime-v2-plan-event"),
      at,
    };
  }

  async append(draft: RuntimeV2EventDraft): Promise<RuntimeV2Event> {
    const event = { ...draft, ...this.eventBase() } as RuntimeV2Event;
    const result = await this.port.append({
      owner: this.owner,
      expectedRevision: this.revision,
      event,
    });
    if (result.disposition === "conflict" || !result.checkpoint) {
      throw new Error("RUNTIME_V2_PLAN_CHECKPOINT_CONFLICT");
    }
    this.revision = result.checkpoint.revision;
    this.aggregate = result.checkpoint.aggregate;
    return event;
  }

  async settleCommand(
    draft: Extract<
      RuntimeV2EventDraft,
      {
        type:
          | "command.completed"
          | "provider.responded"
          | "tool.completed"
          | "validation.completed";
      }
    >,
  ): Promise<RuntimeV2Event> {
    const event = await this.append(draft);
    if (this.aggregate?.run && !this.aggregate.terminalOutcome) {
      await this.publish(buildRuntimeV2CapsuleProjection(
        this.aggregate,
        this.nextId("runtime-v2-plan-capsule"),
      ));
    }
    return event;
  }

  async schedule(
    run: RuntimeV2RunIdentity,
    kind: RuntimeV2Command["kind"],
    payload: Readonly<Record<string, unknown>>,
  ): Promise<RuntimeV2Command> {
    const phase = this.aggregate?.phase;
    if (!phase || phase === "completed") throw new Error("RUNTIME_V2_PLAN_RUN_NOT_ACTIVE");
    const command: RuntimeV2Command = {
      idempotencyKey: this.nextId(`runtime-v2-plan-${kind}`),
      kind,
      run,
      phase,
      payload,
    };
    await this.append({
      type: "command.scheduled",
      run,
      command,
    });
    const aggregate = this.aggregate!;
    await this.publish(buildRuntimeV2CapsuleProjection(
      aggregate,
      this.nextId("runtime-v2-plan-capsule"),
    ));
    await this.publish(buildRuntimeV2TimelineProjection(
      this.aggregate!,
      command,
      this.nextId("runtime-v2-plan-timeline"),
    ));
    return command;
  }

  async publish(projection: RuntimeV2Projection): Promise<void> {
    const aggregate = this.aggregate;
    const run = aggregate?.run?.identity;
    if (!aggregate || !run) throw new Error("RUNTIME_V2_PLAN_RUN_NOT_ACTIVE");
    const event = await this.append({
      type: "projection.published",
      run,
      audience: projection.audience,
      projectionId: projection.id,
      projection,
    });
    try {
      await this.projection.publish({
        aggregate: this.aggregate!,
        audience: projection.audience,
        projection,
        event: event as Extract<RuntimeV2Event, { type: "projection.published" }>,
      });
    } catch {
      // The durable projection event is replay authority. Presentation failure
      // must not strand a command or turn the Plan Run into a model retry.
    }
  }

  async settleScheduled(
    run: RuntimeV2RunIdentity,
    status: "succeeded" | "failed" | "canceled",
  ): Promise<void> {
    for (const command of [...(this.aggregate?.scheduledCommands || [])]) {
      await this.settleCommand({
        type: "command.completed",
        run,
        idempotencyKey: command.idempotencyKey,
        status,
      });
    }
  }

  async recordRecovery(input: {
    readonly run: RuntimeV2RunIdentity;
    readonly scope: RuntimeV2RecoveryScope;
    readonly fingerprint: string;
    readonly reason: string;
  }): Promise<boolean> {
    const aggregate = this.aggregate;
    if (!aggregate || aggregate.recovery.exhausted) return false;
    if (canRecordRuntimeV2Recovery(
      aggregate.recovery,
      input.scope,
      input.fingerprint,
    )) {
      await this.append({
        type: "recovery.recorded",
        run: input.run,
        scope: input.scope,
        fingerprint: input.fingerprint,
      });
      return true;
    }
    await this.append({
      type: "recovery.exhausted",
      run: input.run,
      scope: input.scope,
      fingerprint: input.fingerprint,
      reason: input.reason,
    });
    return false;
  }

  async recordSoftSignal(
    run: RuntimeV2RunIdentity,
    signal: "no_tool_call" | "empty_response" | "repeat" | "context_pressure" | "iteration_limit",
  ): Promise<void> {
    await this.append({ type: "soft_signal.observed", run, signal });
  }

  async finishTerminal(input: {
    readonly run: RuntimeV2RunIdentity;
    readonly resultKind: RuntimeV2ResultKind;
    readonly reason: string;
    readonly finalMarkdown?: string;
  }): Promise<void> {
    const aggregate = this.aggregate;
    if (!aggregate || !aggregate.run) throw new Error("RUNTIME_V2_PLAN_RUN_NOT_ACTIVE");
    const checkpoint = await finishRuntimeV2CheckpointTerminal({
      checkpoint: this.port,
      projection: this.projection,
      owner: this.owner,
      run: input.run,
      current: createRuntimeV2Checkpoint({
        revision: this.revision,
        aggregate,
        updatedAt: aggregate.updatedAt,
      }),
      resultKind: input.resultKind,
      reason: input.reason,
      ...(input.finalMarkdown ? { finalMarkdown: input.finalMarkdown } : {}),
      now: Date.now,
      nextId: (scope) => this.nextId(scope),
    });
    this.revision = checkpoint.revision;
    this.aggregate = checkpoint.aggregate;
    this.lastAt = checkpoint.aggregate.updatedAt;
  }
}
