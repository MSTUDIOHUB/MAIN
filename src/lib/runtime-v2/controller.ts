import type { TurnAggregateV1 } from "./aggregate";
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
  canRecordRuntimeV2Recovery,
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
        await this.apply(asEvent({
          ...this.eventBase(),
          type: "provider.responded",
          run: command.run,
          idempotencyKey: command.idempotencyKey,
          result,
        }));
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
        const rebased = this.rebasePortEvent(event);
        await this.apply(rebased);
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
            const committedChildren = this.requireAggregate().subagents.filter((job) =>
              job.parentRunId === command.run.runId &&
              (job.status === "queued" || job.status === "running")
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

  private recoveryScopeFor(command: RuntimeV2Command, error: unknown): RuntimeV2RecoveryScope {
    if (command.kind === "request_model") return "transport";
    const message = error instanceof Error ? error.message : String(error || "");
    return /context|token|window/i.test(message) ? "context" : "action";
  }

  private async handleCommandFailure(command: RuntimeV2Command, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error || "Runtime v2 command failed.");
    await this.settleScheduledCommand(command, "failed");
    const state = this.requireAggregate();
    if (!state.run || state.terminalOutcome) return;
    const scope = this.recoveryScopeFor(command, error);
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
      scope === "transport" ? "error" : "partial",
      scope === "transport"
        ? "provider_transport_exhausted"
        : "本轮已经达到可恢复重试上限；已保留已完成操作和证据，没有让任务停留在未结束状态。",
    );
  }

  /** A backend can return a well-formed failure event without throwing. It
   * still consumes the same structural recovery budget as a rejected promise,
   * otherwise a model can keep receiving fresh retries without the ledger
   * ever recording why progress stopped. */
  private async recordSemanticFailureIfNeeded(
    command: RuntimeV2Command,
    event: RuntimeV2Event,
  ): Promise<void> {
    const failed = (event.type === "tool.completed" && event.status !== "succeeded") ||
      (event.type === "validation.completed" && !event.passed);
    if (!failed) return;
    const state = this.requireAggregate();
    if (!state.run || state.terminalOutcome) return;
    const validationFailed = event.type === "validation.completed" && !event.passed;
    const scope: RuntimeV2RecoveryScope = validationFailed ? "diagnostic" : "action";
    // Different commands that test the same Turn acceptance boundary are not
    // independent recovery lineages. Otherwise a weak model can evade the
    // diagnostic budget simply by changing the shell spelling each round.
    const diagnosticBoundary = state.objective.acceptanceCriteria.join("\u0000") ||
      state.objective.text;
    const fingerprint = validationFailed
      ? `diagnostic:${diagnosticBoundary.trim().slice(0, 2_048)}`
      : `${scope}:${runtimeV2ActionFingerprint(command)}`;
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
      reason: validationFailed
        ? "同一验收边界的有限验证已重复失败，诊断修复预算耗尽，准备以部分结果收口。"
        : "当前工具动作已重复失败，已停止重复执行并准备以部分结果收口。",
    }));
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
