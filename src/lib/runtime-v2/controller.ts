import type { TurnAggregateV1 } from "./aggregate";
import { exhaustedRuntimeV2ResultKind } from "./completion";
import {
  RUNTIME_V2_EVENT_SCHEMA_VERSION,
  type RuntimeV2Command,
  type RuntimeV2RecoveryScope,
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
import {
  canOpenRuntimeV2RecoveryEpoch,
  canRecordRuntimeV2Recovery,
  runtimeV2RecoveryScopeForCommandFailure,
  runtimeV2ActionFingerprint,
} from "./recovery";
import { transition } from "./reducer";

export interface RuntimeV2ControllerSnapshot {
  readonly aggregate: TurnAggregateV1 | null;
  readonly revision: number;
}

export interface RuntimeV2Admission {
  readonly turn: RuntimeV2TurnIdentity;
  readonly run: RuntimeV2RunIdentity;
  readonly strategy: RuntimeV2Strategy;
  readonly objective: string;
  readonly constraints?: readonly string[];
  readonly acceptanceCriteria?: readonly string[];
  readonly initialPhase?: "preparing" | "observing" | "planning" | "acting" | "validating" | "finalizing";
}

function asEvent<T extends RuntimeV2Event>(value: T): T {
  return value;
}

function structuralIdentity(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(structuralIdentity).join(",")}]`;
  }
  if (!value || typeof value !== "object") return JSON.stringify(value);
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) =>
      `${JSON.stringify(key)}:${structuralIdentity(entry)}`
    )
    .join(",")}}`;
}

function sourceCommandIdentity(command: RuntimeV2Command): string {
  return [
    String(command.payload.toolName || ""),
    structuralIdentity(command.payload.arguments || {}),
  ].join(":");
}

function repeatsCommittedSourceEvidence(
  state: TurnAggregateV1,
  event: RuntimeV2Event,
  command: RuntimeV2Command,
): boolean {
  if (
    event.type !== "tool.completed" ||
    event.status !== "succeeded" ||
    event.evidence.length === 0 ||
    !event.evidence.every((item) => item.kind === "source")
  ) {
    return false;
  }
  const identity = sourceCommandIdentity(command);
  const priorCommandKeys = new Set(state.events
    .filter((candidate): candidate is Extract<
      RuntimeV2Event,
      { type: "command.scheduled" }
    > =>
      candidate.type === "command.scheduled" &&
      candidate.command.kind === "execute_tool" &&
      candidate.command.idempotencyKey !== command.idempotencyKey &&
      sourceCommandIdentity(candidate.command) === identity
    )
    .map((candidate) => candidate.command.idempotencyKey));
  return state.events.some((candidate) =>
    candidate.type === "tool.completed" &&
    candidate.status === "succeeded" &&
    priorCommandKeys.has(candidate.idempotencyKey) &&
    event.evidence.every((incoming) =>
      candidate.evidence.some((existing) =>
        existing.kind === incoming.kind &&
        existing.target === incoming.target &&
        (existing.version || null) === (incoming.version || null)
      )
    )
  );
}

/**
 * Thin command runner around the pure reducer. It writes `command.scheduled`
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

  /** Ports supply semantic result fields only. The controller owns sequence,
   * timestamp and event identity so a late external callback cannot publish a
   * stale ledger position. */
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
    signal: "no_tool_call" | "empty_response" | "repeat" | "context_pressure" | "iteration_limit",
  ): Promise<TurnAggregateV1> {
    const state = this.requireAggregate();
    if (!state.run) throw new Error("Runtime v2 Run is not active.");
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
    const next = await this.apply(asEvent({
      ...this.eventBase(),
      type: "command.scheduled",
      run: state.run.identity,
      command,
    }));
    await this.publish(buildRuntimeV2CapsuleProjection(next, this.ports.clockId.nextId("capsule")));
    await this.publish(buildRuntimeV2TimelineProjection(next, command, this.ports.clockId.nextId("timeline")));
    return this.requireAggregate();
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
    if (next.kind === "finalize_turn" && next.payload.recoveryExhausted === true) {
      const latest = this.requireAggregate();
      if (!latest.recovery.exhausted && latest.run) {
        const recoveryScope = next.payload.recoveryScope;
        await this.apply(asEvent({
          ...this.eventBase(),
          type: "recovery.exhausted",
          run: latest.run.identity,
          scope: recoveryScope === "transport" ||
              recoveryScope === "context" ||
              recoveryScope === "diagnostic"
            ? recoveryScope
            : "action",
          fingerprint: String(next.payload.recoveryFingerprint || runtimeV2ActionFingerprint(next)),
          reason: String(next.payload.resultReason || "recovery_budget_exhausted"),
        }));
      }
    }
    try {
      await this.schedule(next);
      await this.execute(next);
    } catch (error) {
      // A projection adapter must never strand a scheduled command. The
      // controller settles the durable command through the same bounded
      // recovery policy as an executor failure.
      await this.handleCommandFailure(next, error);
    }
    return true;
  }

  private async execute(command: RuntimeV2Command): Promise<void> {
    try {
      const signal = this.abortSignal || new AbortController().signal;
      switch (command.kind) {
      case "request_model": {
        const result = await this.ports.provider.request({ run: command.run, command, signal });
        const applied = await this.apply(asEvent({
          ...this.eventBase(),
          type: "provider.responded",
          run: command.run,
          idempotencyKey: command.idempotencyKey,
          result,
        }));
        await this.publishMilestoneIfEligible(
          applied.events[applied.events.length - 1],
        );
        if (result.toolCalls.length === 0 && !String(result.visibleText || "").trim()) {
          await this.apply(asEvent({
            ...this.eventBase(),
            type: "soft_signal.observed",
            run: command.run,
            signal: result.diagnostics.length > 0 ? "empty_response" : "no_tool_call",
          }));
        }
        await this.publish(buildRuntimeV2CapsuleProjection(this.requireAggregate(), this.ports.clockId.nextId("capsule")));
        return;
      }
      case "execute_tool": {
        const event = await this.ports.tool.execute({ run: command.run, command, signal });
        let rebased = this.rebasePortEvent(event);
        const repeatedSourceEvidence = repeatsCommittedSourceEvidence(
          this.requireAggregate(),
          rebased,
          command,
        );
        if (await this.openRecoveryEpochForCorrectiveEvidence(rebased)) {
          rebased = this.rebasePortEvent(event);
        }
        await this.apply(rebased);
        if (
          repeatedSourceEvidence &&
          !this.requireAggregate().events.some((item) =>
            item.type === "soft_signal.observed" && item.signal === "repeat"
          )
        ) {
          await this.apply(asEvent({
            ...this.eventBase(),
            type: "soft_signal.observed",
            run: command.run,
            signal: "repeat",
          }));
        }
        await this.recordSemanticFailureIfNeeded(command, rebased);
        await this.publish(buildRuntimeV2CapsuleProjection(this.requireAggregate(), this.ports.clockId.nextId("capsule")));
        return;
      }
      case "execute_validation": {
        const event = await this.ports.tool.execute({ run: command.run, command, signal });
        let rebased = this.rebasePortEvent(event);
        if (await this.openRecoveryEpochForCorrectiveEvidence(rebased)) {
          rebased = this.rebasePortEvent(event);
        }
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
    const message = error instanceof Error ? error.message : String(error || "Runtime v2 command failed.");
    await this.settleScheduledCommand(command, "failed");
    const state = this.requireAggregate();
    if (!state.run || state.terminalOutcome) return;
    const scope = runtimeV2RecoveryScopeForCommandFailure(command, error);
    const fingerprint = `${scope}:${runtimeV2ActionFingerprint(command)}`;
    if (canRecordRuntimeV2Recovery(state.recovery, scope, fingerprint)) {
      await this.apply(asEvent({
        ...this.eventBase(),
        type: "recovery.recorded",
        run: state.run.identity,
        scope,
        fingerprint,
      }));
      await this.publish(buildRuntimeV2CapsuleProjection(this.requireAggregate(), this.ports.clockId.nextId("capsule")));
      return;
    }
    await this.apply(asEvent({
      ...this.eventBase(),
      type: "recovery.exhausted",
      run: state.run.identity,
      scope,
      fingerprint,
      reason: `无法继续执行当前结构化动作：${message.slice(0, 512)}`,
    }));
    await this.finishTerminal(
      scope === "transport" ? "error" : exhaustedRuntimeV2ResultKind(state),
      scope === "transport"
        ? "provider_transport_exhausted"
        : "本轮已经达到可恢复重试上限；已保留已完成操作和证据，没有让任务停留在未结束状态。",
    );
  }

  /** A backend can return a well-formed structural failure without throwing.
   * It consumes action recovery just like a rejected promise. A validator
   * that ran and reported an unmet acceptance condition is different: that
   * is ordinary loop evidence and must lead back to Acting, not consume a
   * transport/action recovery budget. */
  private async recordSemanticFailureIfNeeded(
    command: RuntimeV2Command,
    event: RuntimeV2Event,
  ): Promise<void> {
    const toolFailed =
      event.type === "tool.completed" && event.status !== "succeeded";
    const validationStructurallyFailed =
      event.type === "validation.completed" &&
      !event.passed &&
      (
        event.failureKind === "protocol_invalid" ||
        event.failureKind === "not_authorized"
      );
    if (!toolFailed && !validationStructurallyFailed) return;
    const state = this.requireAggregate();
    if (!state.run || state.terminalOutcome) return;
    const scope: RuntimeV2RecoveryScope = "action";
    const fingerprint = `${scope}:${runtimeV2ActionFingerprint(command)}`;
    if (canRecordRuntimeV2Recovery(state.recovery, scope, fingerprint)) {
      await this.apply(asEvent({
        ...this.eventBase(),
        type: "recovery.recorded",
        run: state.run.identity,
        scope,
        fingerprint,
      }));
      return;
    }
    await this.apply(asEvent({
      ...this.eventBase(),
      type: "recovery.exhausted",
      run: state.run.identity,
      scope,
      fingerprint,
      reason: "当前工具动作已重复失败，已停止重复执行并准备以部分结果收口。",
    }));
  }

  private async openRecoveryEpochForCorrectiveEvidence(
    event: RuntimeV2Event,
  ): Promise<boolean> {
    const state = this.requireAggregate();
    if (
      !state.run ||
      state.recovery.exhausted ||
      event.type !== "tool.completed" ||
      event.status !== "succeeded"
    ) {
      return false;
    }
    const currentEpochHasFailure = state.recovery.receipts.some(
      (receipt) => receipt.epoch === state.recovery.epoch,
    );
    const mutationEvidence = event.evidence.filter(
      (evidence) => evidence.kind === "mutation",
    );
    const sourceEvidence = event.evidence.filter(
      (evidence) => evidence.kind === "source",
    );
    const epochBoundary = state.events.map((candidate) => candidate.type)
      .lastIndexOf("recovery.epoch_opened");
    const epochEvents = state.events.slice(epochBoundary + 1);
    let latestRecoverableFailureIndex = -1;
    for (let index = epochEvents.length - 1; index >= 0; index -= 1) {
      const candidate = epochEvents[index]!;
      if (
        candidate.type === "tool.completed" &&
        candidate.status !== "succeeded" &&
        (
          candidate.failureKind === "mutation_rejected" ||
          candidate.failureKind === "source_mismatch"
        )
      ) {
        latestRecoverableFailureIndex = index;
        break;
      }
    }
    const latestRecoverableEditFailure =
      latestRecoverableFailureIndex >= 0 &&
      !epochEvents.slice(latestRecoverableFailureIndex + 1).some(
        (candidate) =>
          candidate.type === "tool.completed" &&
          candidate.status === "succeeded" &&
          candidate.evidence.some((evidence) => evidence.kind === "source"),
      );
    const recoveryEvidence = mutationEvidence.length > 0
      ? mutationEvidence
      : latestRecoverableEditFailure && sourceEvidence.length > 0
        ? sourceEvidence
        : [];
    if (
      !currentEpochHasFailure ||
      recoveryEvidence.length === 0 ||
      !canOpenRuntimeV2RecoveryEpoch(state.recovery)
    ) {
      return false;
    }
    await this.apply(asEvent({
      ...this.eventBase(),
      type: "recovery.epoch_opened",
      run: state.run.identity,
      reason: mutationEvidence.length > 0
        ? "corrective_mutation_committed_after_recoverable_failure"
        : "corrective_source_refreshed_after_rejected_mutation",
      evidence: recoveryEvidence,
    }));
    return true;
  }

  private async publish(projection: ReturnType<typeof buildRuntimeV2CapsuleProjection>): Promise<void> {
    const state = this.requireAggregate();
    if (!state.run) return;
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

  private async finishTerminal(
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
