import type { TurnAggregateV1 } from "./aggregate";
import {
  RUNTIME_V2_EVENT_SCHEMA_VERSION,
  type RuntimeV2Command,
  type RuntimeV2Projection,
  type RuntimeV2ResultKind,
  type RuntimeV2RunIdentity,
  type RuntimeV2Strategy,
  type RuntimeV2TerminalOutcome,
  type RuntimeV2TurnIdentity,
} from "./contracts";
import { decideNextCommands, type RuntimeV2DecisionInput } from "./decision";
import type { RuntimeV2Event, RuntimeV2EventDraft } from "./events";
import type { RuntimeV2Ports } from "./ports";
import {
  buildRuntimeV2CapsuleProjection,
  buildRuntimeV2FinalProjection,
  buildRuntimeV2MilestoneProjection,
  buildRuntimeV2TimelineProjection,
} from "./projection";
import { transition } from "./reducer";
import {
  decideRuntimeV2CommandFailureRecovery,
  decideRuntimeV2SemanticFailureRecovery,
  repeatsCommittedRuntimeV2SourceEvidence,
  repeatsRuntimeV2ProjectionInCurrentPhase,
  shouldRecordRuntimeV2SoftSignal,
} from "./controllerRecovery";
import {
  referencedRuntimeV2SubagentEvidenceIds,
  runtimeV2SubagentHandoffApplicationSource,
} from "./subagentHandoff";
export interface RuntimeV2ControllerSnapshot {
  readonly aggregate: TurnAggregateV1 | null;
  readonly revision: number;
}
type RuntimeV2SoftSignal = Extract<
  RuntimeV2Event,
  { readonly type: "soft_signal.observed" }
>["signal"];
export interface RuntimeV2Admission {
  readonly turn: RuntimeV2TurnIdentity;
  readonly run: RuntimeV2RunIdentity;
  readonly strategy: RuntimeV2Strategy;
  readonly objective: string;
  readonly constraints?: readonly string[];
  readonly acceptanceCriteria?: readonly string[];
  readonly acceptanceCriterionIds?: readonly string[];
  readonly acceptanceEvidenceRequirements?: readonly (
    "static" | "behavioral" | "interaction"
  )[];
  readonly initialPhase?: "preparing" | "observing" | "planning" | "acting" | "validating" | "finalizing";
}
function asEvent<T extends RuntimeV2Event>(value: T): T { return value; }
/** Thin command runner around the pure reducer. It writes `command.scheduled`
 * before every side effect and accepts results only through the same event
 * ledger. Concrete UI/store/provider adapters live outside this class.
 */
export class RuntimeV2Controller {
  private aggregate: TurnAggregateV1 | null = null;
  private revision = 0;
  private readonly abortSignal: AbortSignal | null;

  constructor(
    private readonly ports: RuntimeV2Ports,
    initial?: RuntimeV2ControllerSnapshot,
    options?: { readonly abortSignal?: AbortSignal },
  ) {
    this.aggregate = initial?.aggregate || null;
    this.revision = initial?.revision || 0;
    this.abortSignal = options?.abortSignal || null;
  }

  snapshot(): RuntimeV2ControllerSnapshot {
    return { aggregate: this.aggregate, revision: this.revision };
  }

  private eventBase(): { readonly schemaVersion: typeof RUNTIME_V2_EVENT_SCHEMA_VERSION; readonly sequence: number; readonly eventId: string; readonly at: number } {
    return {
      schemaVersion: RUNTIME_V2_EVENT_SCHEMA_VERSION,
      sequence: this.aggregate?.nextSequence || 0,
      eventId: this.ports.clockId.nextId("runtime-v2-event"),
      at: this.ports.clockId.now(),
    };
  }

  /** Controller-owned identity prevents a late callback publishing a stale
   * ledger position. */
  private rebasePortEvent(event: RuntimeV2EventDraft): RuntimeV2Event {
    return { ...event, ...this.eventBase() } as RuntimeV2Event;
  }

  private async apply(event: RuntimeV2Event): Promise<TurnAggregateV1> {
    const next = transition(this.aggregate, event);
    const checkpoint = await this.ports.checkpoint.append({
      owner: next.turn,
      expectedRevision: this.revision,
      event,
    });
    if (checkpoint.disposition === "conflict" || !checkpoint.checkpoint) {
      throw new Error("Runtime v2 checkpoint ownership or revision conflict.");
    }
    this.aggregate = next;
    this.revision = checkpoint.checkpoint.revision;
    return next;
  }

  private requireAggregate(): TurnAggregateV1 {
    if (!this.aggregate) throw new Error("Runtime v2 Turn has not been admitted.");
    return this.aggregate;
  }

  async admit(input: RuntimeV2Admission): Promise<TurnAggregateV1> {
    if (this.aggregate) throw new Error("Runtime v2 Turn is already admitted.");
    await this.apply(asEvent({
      ...this.eventBase(),
      type: "turn.admitted",
      turn: input.turn,
      strategy: input.strategy,
      objective: input.objective,
      constraints: input.constraints || [],
      acceptanceCriteria: input.acceptanceCriteria || [],
      ...(input.acceptanceCriterionIds
        ? { acceptanceCriterionIds: input.acceptanceCriterionIds }
        : {}),
      ...(input.acceptanceEvidenceRequirements
        ? {
            acceptanceEvidenceRequirements:
              input.acceptanceEvidenceRequirements,
          }
        : {}),
    }));
    return this.apply(asEvent({
      ...this.eventBase(),
      type: "run.started",
      run: input.run,
      phase: input.initialPhase || (input.strategy === "plan" ? "planning" : "preparing"),
    }));
  }

  async changePhase(
    phase: Exclude<TurnAggregateV1["phase"], "completed">,
    reason: string,
  ): Promise<TurnAggregateV1> {
    const state = this.requireAggregate();
    if (!state.run) throw new Error("Runtime v2 Run is not active.");
    const next = await this.apply(asEvent({
      ...this.eventBase(),
      type: "phase.changed",
      run: state.run.identity,
      phase,
      reason,
    }));
    await this.publishMilestoneIfEligible(next.events[next.events.length - 1]);
    return next;
  }

  /** Record a non-terminal pressure signal in the ordered ledger. Soft
   * signals may trigger compaction or a strategy pivot, but never decide the
   * Turn outcome by themselves. */
  async recordSoftSignal(
    signal: RuntimeV2SoftSignal,
  ): Promise<TurnAggregateV1> {
    return this.applySoftSignal(signal);
  }

  private async applySoftSignal(
    signal: RuntimeV2SoftSignal,
  ): Promise<TurnAggregateV1> {
    const state = this.requireAggregate();
    if (!state.run) throw new Error("Runtime v2 Run is not active.");
    if (!shouldRecordRuntimeV2SoftSignal({
      aggregate: state,
      signal,
    })) return state;
    return this.apply(asEvent({
      ...this.eventBase(),
      type: "soft_signal.observed",
      run: state.run.identity,
      signal,
    }));
  }

  async recordObservation(input: { id: string; kind: "source" | "tool" | "validation" | "subagent" | "user"; target: string; version?: string | null }): Promise<TurnAggregateV1> {
    const state = this.requireAggregate();
    if (!state.run) throw new Error("Runtime v2 Run is not active.");
    const next = await this.apply(asEvent({
      ...this.eventBase(),
      type: "observation.recorded",
      run: state.run.identity,
      evidence: {
        id: input.id,
        kind: input.kind,
        target: input.target,
        version: input.version || null,
      },
    }));
    await this.publishMilestoneIfEligible(next.events[next.events.length - 1]);
    return next;
  }

  /**
   * Publish supervisor-owned live guidance without scheduling a fake effect.
   * The text must already be public presentation data derived from structured
   * runtime state; it cannot affect any lifecycle decision.
   */
  async publishLiveStatus(
    markdown: string,
    dedupeKey: string,
  ): Promise<void> {
    await this.publishSupervisorProjection(
      "capsule_live",
      "live_action",
      markdown,
      dedupeKey,
    );
  }

  /** Durable, non-repeating Chat checkpoint for supervisor runtimes. */
  async publishMilestoneStatus(
    markdown: string,
    dedupeKey: string,
  ): Promise<void> {
    await this.publishSupervisorProjection(
      "chat_milestone",
      "milestone",
      markdown,
      dedupeKey,
    );
  }

  private async publishSupervisorProjection(
    audience: Extract<RuntimeV2Projection["audience"], "capsule_live" | "chat_milestone">,
    kind: Extract<RuntimeV2Projection["kind"], "live_action" | "milestone">,
    markdown: string,
    dedupeKey: string,
  ): Promise<void> {
    const state = this.requireAggregate();
    const content = String(markdown || "").trim().slice(0, 24_000);
    const key = String(dedupeKey || "").trim().slice(0, 2_000);
    if (!content || !key) return;
    await this.publish({
      id: this.ports.clockId.nextId(
        audience === "capsule_live" ? "capsule" : "milestone",
      ),
      audience,
      markdown: content,
      kind,
      dedupeKey: `${state.turn.turnId}:supervisor:${key}`,
    });
  }

  async invalidateWorkPlan(reason: string): Promise<TurnAggregateV1> {
    const state = this.requireAggregate();
    if (!state.run || !state.workPlan) {
      throw new Error("Runtime v2 has no active WorkPlan to invalidate.");
    }
    const next = await this.apply(asEvent({
      ...this.eventBase(),
      type: "work_plan.invalidated",
      run: state.run.identity,
      workPlan: { ...state.workPlan, status: "invalidated" },
      reason: String(reason || "work_plan_source_version_changed").trim().slice(0, 2_000),
    }));
    await this.publishMilestoneIfEligible(next.events[next.events.length - 1]);
    return next;
  }

  async schedule(command: RuntimeV2Command): Promise<TurnAggregateV1> {
    const state = this.requireAggregate();
    if (!state.run) throw new Error("Runtime v2 Run is not active.");
    const scheduledEvent = asEvent({
      ...this.eventBase(),
      type: "command.scheduled",
      run: state.run.identity,
      command,
    });
    await this.apply(scheduledEvent);
    await this.recordAppliedSubagentHandoffs(scheduledEvent);
    const next = this.requireAggregate();
    await this.publish(buildRuntimeV2CapsuleProjection(next, this.ports.clockId.nextId("capsule")));
    await this.publish(buildRuntimeV2TimelineProjection(next, command, this.ports.clockId.nextId("timeline")));
    return this.requireAggregate();
  }

  private async recordAppliedSubagentHandoffs(
    sourceEvent: RuntimeV2Event,
  ): Promise<void> {
    const source = runtimeV2SubagentHandoffApplicationSource(sourceEvent);
    if (!source) return;
    const state = this.requireAggregate();
    if (!state.run) return;
    const alreadyApplied = new Map<string, Set<string>>();
    for (const event of state.events) {
      if (event.type !== "subagent.handoff_applied") continue;
      const evidenceIds = alreadyApplied.get(event.jobId) || new Set<string>();
      for (const evidenceId of event.evidenceIds) {
        evidenceIds.add(evidenceId);
      }
      alreadyApplied.set(event.jobId, evidenceIds);
    }
    const deliveries = state.events.filter(
      (event): event is Extract<
        RuntimeV2Event,
        { readonly type: "subagent.handoff_delivered" }
      > =>
        event.type === "subagent.handoff_delivered" &&
        event.sequence < sourceEvent.sequence,
    );
    for (const delivery of deliveries) {
      const used = alreadyApplied.get(delivery.jobId) || new Set<string>();
      const evidenceIds = referencedRuntimeV2SubagentEvidenceIds({
        sourceEvent,
        evidenceIds: delivery.evidenceIds,
      }).filter((evidenceId) => !used.has(evidenceId));
      if (evidenceIds.length === 0) continue;
      await this.apply(asEvent({
        ...this.eventBase(),
        type: "subagent.handoff_applied",
        run: state.run.identity,
        jobId: delivery.jobId,
        evidenceIds,
        sourceEventId: sourceEvent.eventId,
        source,
      }));
      alreadyApplied.set(
        delivery.jobId,
        new Set([...used, ...evidenceIds]),
      );
    }
  }

  async driveOnce(input: RuntimeV2DecisionInput = {}): Promise<boolean> {
    if (this.abortSignal?.aborted) {
      if (this.aggregate?.run && !this.aggregate.terminalOutcome) {
        await this.finishTerminal("canceled", "用户已停止本轮执行；已保留此前已提交的证据和修改。");
      }
      return false;
    }
    const state = this.requireAggregate();
    const next = decideNextCommands(state, input)[0];
    if (!next) return false;
    try {
      await this.schedule(next);
    } catch (error) {
      // Recovery owns only commands that crossed the durable scheduling
      // boundary. A rejected transition/CAS is an infrastructure failure;
      // treating it as a provider failure can retry an uncommitted identity
      // forever without advancing the ledger.
      if (!this.aggregate?.scheduledCommands.some(
        (command) => command.idempotencyKey === next.idempotencyKey,
      )) {
        throw error;
      }
      // A later scheduling projection/handoff failure must not strand the
      // already durable command.
      await this.handleCommandFailure(next, error);
      return true;
    }
    await this.execute(next);
    return true;
  }

  private async execute(command: RuntimeV2Command): Promise<void> {
    try {
      const signal = this.abortSignal || new AbortController().signal;
      switch (command.kind) {
      case "request_model": {
        const result = await this.ports.provider.request({ run: command.run, command, signal });
        const providerEvent = asEvent({
          ...this.eventBase(),
          type: "provider.responded",
          run: command.run,
          idempotencyKey: command.idempotencyKey,
          result,
        });
        const applied = await this.apply(providerEvent);
        await this.publishMilestoneIfEligible(
          applied.events[applied.events.length - 1],
        );
        await this.recordAppliedSubagentHandoffs(providerEvent);
        const responseMode = String(command.payload.mode || "").trim();
        if (
          result.toolCalls.length === 0 &&
          responseMode !== "conclude" &&
          responseMode !== "chat" &&
          responseMode !== "analyze"
        ) {
          await this.applySoftSignal(
            !String(result.visibleText || "").trim() ||
                result.diagnostics.length > 0
              ? "empty_response"
              : "no_tool_call",
          );
        }
        await this.publish(buildRuntimeV2CapsuleProjection(this.requireAggregate(), this.ports.clockId.nextId("capsule")));
        return;
      }
      case "execute_tool": {
        const event = await this.ports.tool.execute({ run: command.run, command, signal });
        const rebased = this.rebasePortEvent(event);
        const repeatedSourceEvidence =
          (
            rebased.type === "tool.completed" &&
            rebased.receiptOrigin === "replayed"
          ) ||
          repeatsCommittedRuntimeV2SourceEvidence({
            aggregate: this.requireAggregate(),
            event: rebased,
            command,
          });
        await this.apply(rebased);
        if (
          repeatedSourceEvidence
        ) {
          await this.applySoftSignal("repeat");
        }
        await this.recordSemanticFailureIfNeeded(command, rebased);
        await this.publish(buildRuntimeV2CapsuleProjection(this.requireAggregate(), this.ports.clockId.nextId("capsule")));
        return;
      }
      case "execute_validation": {
        const event = await this.ports.tool.execute({ run: command.run, command, signal });
        const rebased = this.rebasePortEvent(event);
        await this.apply(rebased);
        await this.recordSemanticFailureIfNeeded(command, rebased);
        await this.publish(buildRuntimeV2CapsuleProjection(this.requireAggregate(), this.ports.clockId.nextId("capsule")));
        return;
      }
      case "collect_observation":
      case "schedule_subagents":
      case "join_subagents": {
        let event: RuntimeV2EventDraft | readonly RuntimeV2EventDraft[];
        if (command.kind === "collect_observation") {
          event = await this.ports.tool.execute({ run: command.run, command, signal });
        } else {
          if (command.kind === "schedule_subagents") {
            const sourceToolCallId =
              typeof command.payload.toolCallId === "string"
                ? command.payload.toolCallId
                : "";
            const committedChildren = this.requireAggregate().subagents.filter((job) =>
              job.parentRunId === command.run.runId &&
              (job.status === "queued" || job.status === "running") &&
              (!sourceToolCallId ||
                job.sourceToolCallId === sourceToolCallId)
            );
            if (committedChildren.length === 0) {
              const prepared = await this.ports.scheduler.prepareSchedule?.({ run: command.run, command, signal });
              if (prepared) {
                const applied = await this.apply(this.rebasePortEvent(prepared));
                await this.publishMilestoneIfEligible(applied.events[applied.events.length - 1]);
              }
            }
          }
          const scheduledSubagents = command.kind === "schedule_subagents" || command.kind === "join_subagents"
            ? this.requireAggregate().subagents
            : undefined;
          event = await this.ports.scheduler.execute({
            run: command.run,
            command,
            signal,
            ...(scheduledSubagents ? { scheduledSubagents } : {}),
          });
        }
        await this.apply(asEvent({
          ...this.eventBase(),
          type: "command.completed",
          run: command.run,
          idempotencyKey: command.idempotencyKey,
          status: "succeeded",
        }));
        const events = Array.isArray(event) ? event : [event];
        for (const emitted of events) {
          if (emitted.type !== "command.completed") {
            const applied = await this.apply(this.rebasePortEvent(emitted));
            await this.publishMilestoneIfEligible(applied.events[applied.events.length - 1]);
          }
        }
        await this.publish(buildRuntimeV2CapsuleProjection(this.requireAggregate(), this.ports.clockId.nextId("capsule")));
        return;
      }
      case "publish_projection":
        throw new Error("Projection commands are published through RuntimeV2Controller.publish.");
      case "finalize_turn": {
        const resultKind = command.payload.resultKind as RuntimeV2ResultKind;
        const reason = String(command.payload.resultReason || "").trim();
        if (!resultKind || !reason) throw new Error("A finalization command requires a result kind and reason.");
        const finalMarkdown = typeof command.payload.finalMarkdown === "string"
          ? command.payload.finalMarkdown.trim().slice(0, 24_000)
          : undefined;
        await this.complete(command, resultKind, reason, finalMarkdown);
        return;
      }
      }
    } catch (error) {
      if (this.abortSignal?.aborted) {
        await this.settleScheduledCommand(command, "canceled");
        if (!this.requireAggregate().terminalOutcome) {
          await this.finishTerminal("canceled", "用户已停止本轮执行；已保留此前已提交的证据和修改。");
        }
        return;
      }
      await this.handleCommandFailure(command, error);
    }
  }

  /** Resume one durable in-flight command without inventing a new decision. */
  async resumeScheduled(): Promise<boolean> {
    const state = this.requireAggregate();
    const command = state.scheduledCommands[0];
    if (!command || state.terminalOutcome) return false;
    await this.execute(command);
    return true;
  }

  /** v3 migration fence: discard an unresumable scheduled effect without
   * executing it. The caller must then drive an explicit truthful terminal
   * result; this method never manufactures new mutation authority. */
  async discardScheduledForMigration(): Promise<void> {
    const state = this.requireAggregate();
    for (const command of [...state.scheduledCommands]) {
      await this.settleScheduledCommand(command, "failed");
    }
  }

  /** An unmodified legacy Execute may continue after its scheduled effect is
   * discarded. Re-enter observation so the provider sees current source
   * evidence before the next mutation. */
  async reobserveAfterLegacyMigration(): Promise<void> {
    await this.discardScheduledForMigration();
    let state = this.requireAggregate();
    if (state.phase === "observing") return;
    if (
      state.phase === "validating" ||
      state.phase === "planning" ||
      state.phase === "reviewing"
    ) {
      await this.changePhase(
        "acting",
        "Legacy migration discarded an unresumable scheduled effect.",
      );
      state = this.requireAggregate();
    }
    if (state.phase === "preparing" || state.phase === "acting") {
      await this.changePhase(
        "observing",
        "Legacy migration requires fresh source observation.",
      );
      return;
    }
    if (state.phase !== "observing") {
      throw new Error(
        `RUNTIME_V2_V3_MIGRATION_PHASE_UNRECOVERABLE:${state.phase}`,
      );
    }
  }

  private async settleScheduledCommand(
    command: RuntimeV2Command,
    status: "succeeded" | "failed" | "canceled",
  ): Promise<void> {
    const state = this.requireAggregate();
    if (!state.run || !state.scheduledCommands.some((item) => item.idempotencyKey === command.idempotencyKey)) return;
    await this.apply(asEvent({
      ...this.eventBase(),
      type: "command.completed",
      run: state.run.identity,
      idempotencyKey: command.idempotencyKey,
      status,
    }));
  }

  private async handleCommandFailure(command: RuntimeV2Command, error: unknown): Promise<void> {
    const decision = decideRuntimeV2CommandFailureRecovery({
      aggregate: this.requireAggregate(),
      command,
      error,
    });
    await this.settleScheduledCommand(
      command,
      decision.kind === "lifecycle_boundary" ? "canceled" : "failed",
    );
    const state = this.requireAggregate();
    if (
      !state.run ||
      state.terminalOutcome ||
      decision.kind === "lifecycle_boundary"
    ) return;
    if (decision.kind === "signal") {
      await this.applySoftSignal(decision.signal);
    } else if (decision.kind === "record") {
      await this.apply(asEvent({
        ...this.eventBase(),
        type: "recovery.recorded",
        run: state.run.identity,
        scope: decision.scope,
        fingerprint: decision.fingerprint,
      }));
    } else if (decision.kind === "hard_stop") {
      await this.apply(asEvent({
        ...this.eventBase(),
        type: "recovery.exhausted",
        run: state.run.identity,
        scope: decision.scope,
        fingerprint: decision.fingerprint,
        reason: decision.reason,
      }));
    }
    if (decision.publish) {
      await this.publish(buildRuntimeV2CapsuleProjection(
        this.requireAggregate(),
        this.ports.clockId.nextId("capsule"),
      ));
    }
  }

  /** A backend can return a well-formed structural failure without throwing.
   * It records a retry guard just like a rejected promise. Once the same side
   * effect reaches its guard, only that duplicate is rejected and the Turn
   * remains active. An unmet acceptance condition is ordinary loop evidence. */
  private async recordSemanticFailureIfNeeded(
    command: RuntimeV2Command,
    event: RuntimeV2Event,
  ): Promise<void> {
    const state = this.requireAggregate();
    if (!state.run || state.terminalOutcome) return;
    const decision = decideRuntimeV2SemanticFailureRecovery({
      aggregate: state,
      command,
      event,
    });
    if (!decision) return;
    if (decision.kind === "record") {
      await this.apply(asEvent({
        ...this.eventBase(),
        type: "recovery.recorded",
        run: state.run.identity,
        scope: decision.scope,
        fingerprint: decision.fingerprint,
      }));
      return;
    }
    await this.applySoftSignal("repeated_action");
  }

  private async publish(projection: ReturnType<typeof buildRuntimeV2CapsuleProjection>): Promise<void> {
    const state = this.requireAggregate();
    if (!state.run) return;
    if (repeatsRuntimeV2ProjectionInCurrentPhase({
      aggregate: state,
      projection,
    })) return;
    const event = asEvent({
      ...this.eventBase(),
      type: "projection.published",
      run: state.run.identity,
      audience: projection.audience,
      projectionId: projection.id,
      projection,
    });
    await this.apply(event);
    // Projection is a replayable view of the ledger, not a second state
    // owner. A temporary UI/store projection failure must not make the Turn
    // lose its terminal path or leave a command perpetually scheduled.
    try {
      await this.ports.projection.publish({
        aggregate: this.requireAggregate(),
        audience: projection.audience,
        projection,
        event,
      });
    } catch {
      // The committed projection event is enough for the adapter to replay on
      // the next Store refresh. Intentionally do not create a model-facing
      // retry from this presentation-only failure.
    }
  }

  private async publishMilestoneIfEligible(event: RuntimeV2Event): Promise<void> {
    const state = this.requireAggregate();
    const projection = buildRuntimeV2MilestoneProjection(
      state,
      event,
      this.ports.clockId.nextId("milestone"),
    );
    if (projection) await this.publish(projection);
  }

  private async complete(
    command: RuntimeV2Command,
    resultKind: RuntimeV2ResultKind,
    reason: string,
    finalMarkdown?: string,
  ): Promise<void> {
    await this.settleScheduledCommand(command, "succeeded");
    await this.finishTerminal(resultKind, reason, finalMarkdown);
  }

  async finishTerminal(
    resultKind: RuntimeV2ResultKind,
    reason: string,
    finalMarkdown?: string,
  ): Promise<void> {
    const state = this.requireAggregate();
    const run = state.run;
    if (!run) throw new Error("Runtime v2 Run is not active.");
    for (const command of [...state.scheduledCommands]) {
      await this.settleScheduledCommand(
        command,
        resultKind === "canceled" ? "canceled" : "failed",
      );
    }
    if (
      resultKind === "canceled" &&
      !this.requireAggregate().events.some((event) => event.type === "run.aborted")
    ) {
      await this.apply(asEvent({
        ...this.eventBase(),
        type: "run.aborted",
        run: run.identity,
        reason,
      }));
    }
    if (this.requireAggregate().phase !== "finalizing") {
      await this.apply(asEvent({
        ...this.eventBase(),
        type: "phase.changed",
        run: run.identity,
        phase: "finalizing",
        reason: "terminal_outcome_preparation",
      }));
    }
    const latest = this.requireAggregate();
    const finalProjection = buildRuntimeV2FinalProjection(
      latest,
      this.ports.clockId.nextId("final"),
      resultKind,
      reason,
      finalMarkdown,
    );
    const outcome: RuntimeV2TerminalOutcome = {
      resultKind,
      reason,
      completedAt: this.ports.clockId.now(),
      finalProjectionId: finalProjection.id,
    };
    await this.apply(asEvent({
      ...this.eventBase(),
      type: "run.completed",
      run: run.identity,
      outcome,
    }));
    await this.publish(finalProjection);
    await this.apply(asEvent({
      ...this.eventBase(),
      type: "turn.completed",
      turn: this.requireAggregate().turn,
      runId: run.identity.runId,
      outcome,
    }));
  }
}
