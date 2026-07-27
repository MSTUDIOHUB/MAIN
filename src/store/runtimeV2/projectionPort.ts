import { getToolTarget } from "../../lib/toolTarget";
import {
  appendRuntimeEvent,
  withEventSchema,
  type MainThreadEvent,
} from "../../lib/turnEvents";
import type { ProgressTaskBlock, TaskBlock } from "../../lib/taskTypes";
import type {
  ProjectionPort,
  RuntimeV2Command,
  RuntimeV2Projection,
  RuntimeV2ProjectionAudience,
  RuntimeV2ResultKind,
  TurnAggregateV1,
} from "../../lib/runtime-v2";

type StoreGet = () => any;
type StoreSet = (patchOrUpdater: any) => void;

export interface RuntimeV2ProjectionStoreAdapterInput {
  readonly get: StoreGet;
  readonly set: StoreSet;
  readonly nextTaskId: () => number;
  readonly language: "zh" | "en";
  readonly logStoreEvent: (event: string, data?: Record<string, unknown>) => void;
}

function phaseFor(aggregate: TurnAggregateV1): ProgressTaskBlock["phase"] {
  const phases: Record<TurnAggregateV1["phase"], ProgressTaskBlock["phase"]> = {
    preparing: "understanding",
    observing: "investigating",
    planning: "investigating",
    reviewing: "investigating",
    acting: "editing",
    validating: "verifying",
    finalizing: "summarizing",
    completed: "summarizing",
  };
  return phases[aggregate.phase];
}

function commandTool(command: RuntimeV2Command | undefined): string {
  if (!command) return "";
  if (command.kind === "execute_tool") return String(command.payload.toolName || "").trim();
  if (command.kind === "execute_validation") {
    return String(command.payload.toolName || "run_command").trim();
  }
  if (command.kind === "collect_observation") return "collect_observation";
  if (command.kind === "schedule_subagents" || command.kind === "join_subagents") return command.kind;
  return command.kind;
}

function commandTarget(command: RuntimeV2Command | undefined): string {
  if (!command) return "";
  const args = command.payload.arguments;
  if (args && typeof args === "object" && !Array.isArray(args)) {
    return getToolTarget(commandTool(command), args as Record<string, unknown>);
  }
  return String(command.payload.target || command.payload.objective || "").trim();
}

function timelineTarget(command: RuntimeV2Command): string {
  if (command.kind === "execute_tool" || command.kind === "execute_validation") {
    return commandTarget(command);
  }
  if (command.kind === "join_subagents") {
    const jobIds = Array.isArray(command.payload.jobIds)
      ? command.payload.jobIds.map(String).map((value) => value.trim()).filter(Boolean)
      : [];
    return jobIds.join(", ");
  }
  return "";
}

function projectionProgressKey(aggregate: TurnAggregateV1, projection: RuntimeV2Projection): string {
  return `runtime-v2:${aggregate.turn.turnId}:${projection.dedupeKey}`;
}

function timelineProgressKey(aggregate: TurnAggregateV1, projection: RuntimeV2Projection): string {
  return `runtime-v2-timeline:${aggregate.turn.turnId}:${projection.dedupeKey}`;
}

function isRuntimeOwnedPlanArtifactCommand(command: RuntimeV2Command | undefined): boolean {
  return command?.kind === "execute_tool" &&
    command.payload.runtimeOwnedPlanArtifact === true;
}

function timelineTitle(
  command: RuntimeV2Command,
  target: string,
  language: "zh" | "en",
  strategy: TurnAggregateV1["strategy"],
): string {
  const codeTarget = target ? `\`${target.replace(/`/g, "")}\`` : "";
  if (language === "en") {
    if (command.kind === "collect_observation") return "Collect relevant workspace evidence";
    if (command.kind === "request_model") {
      const mode = String(command.payload.mode || "");
      if (mode === "chat") return "Compose a conversation reply";
      if (mode === "analyze") return "Compose an evidence-backed workspace answer";
      if (mode === "plan") return "Synthesize the evidence into a repair plan";
      if (mode === "execute") return "Select the next evidence-backed edit";
      if (mode === "validate") return "Evaluate the acceptance criteria";
      return "Evaluate the current evidence";
    }
    if (command.kind === "execute_validation") return codeTarget ? `Validate with ${codeTarget}` : "Run finite validation";
    if (command.kind === "execute_tool") return codeTarget ? `Run ${commandTool(command)} on ${codeTarget}` : `Run ${commandTool(command)}`;
    if (command.kind === "schedule_subagents") return "Start scoped read-only child investigations";
    if (command.kind === "join_subagents") return "Join child investigation evidence";
    if (command.kind === "finalize_turn") {
      return strategy === "chat"
        ? "Finish the conversation reply"
        : "Prepare the verified result";
    }
    return "Publish structured task state";
  }
  if (command.kind === "collect_observation") return "收集与问题相关的工作区证据";
  if (command.kind === "request_model") {
    const mode = String(command.payload.mode || "");
    if (mode === "chat") return "结合当前对话组织完整回复";
    if (mode === "analyze") return "结合工作区只读证据组织完整答复";
    if (mode === "plan") return "把已确认的证据整理成修复计划";
    if (mode === "execute") return "根据证据选择下一项修改";
    if (mode === "validate") return "根据验收条件判断当前结果";
    return "根据当前证据判断根本原因";
  }
  if (command.kind === "execute_validation") return codeTarget ? `使用 ${codeTarget} 执行验证` : "执行有限验证";
  if (command.kind === "execute_tool") return codeTarget ? `对 ${codeTarget} 执行 ${commandTool(command)}` : `执行 ${commandTool(command)}`;
  if (command.kind === "schedule_subagents") return "启动有明确范围的只读子智能体调查";
  if (command.kind === "join_subagents") return "汇合子智能体的调查证据";
  if (command.kind === "finalize_turn") {
    return strategy === "chat"
      ? "整理本轮对话的完整回复"
      : "整理已验证的执行结果";
  }
  return "同步结构化任务状态";
}

function buildTimelineProgressBlock(input: {
  aggregate: TurnAggregateV1;
  command: RuntimeV2Command;
  projection: RuntimeV2Projection;
  id: number;
  timestampMs: number;
  language: "zh" | "en";
}): ProgressTaskBlock {
  const run = input.aggregate.run!.identity;
  const target = timelineTarget(input.command);
  const tool = commandTool(input.command);
  return {
    id: input.id,
    turnId: run.turnId,
    type: "progress",
    phase: input.command.kind === "execute_validation" ? "verifying" : phaseFor(input.aggregate),
    title: timelineTitle(
      input.command,
      target,
      input.language,
      input.aggregate.strategy,
    ),
    why: "",
    action: input.projection.markdown,
    evidence: "",
    next: "",
    targets: target ? [target] : [],
    tool,
    toolName: tool,
    target,
    canonicalTarget: target,
    status: "running",
    source: "runtime",
    runId: run.runId,
    parentRunId: run.parentRunId,
    toolCallId: input.command.idempotencyKey,
    dedupeKey: timelineProgressKey(input.aggregate, input.projection),
    createdAt: input.timestampMs,
    updatedAt: input.timestampMs,
  };
}

function reconcileRuntimeV2TimelineBlocks(
  taskFlow: readonly TaskBlock[],
  aggregate: TurnAggregateV1,
  timestampMs: number,
  language: "zh" | "en",
): TaskBlock[] {
  const run = aggregate.run?.identity;
  if (!run) return [...taskFlow];
  const receipts = new Map(
    aggregate.completedCommands.map((receipt) => [receipt.idempotencyKey, receipt.status] as const),
  );
  return taskFlow.flatMap((block) => {
    if (
      block.type !== "progress" ||
      block.turnId !== run.turnId ||
      block.runId !== run.runId ||
      !String(block.dedupeKey || "").startsWith("runtime-v2-timeline:")
    ) {
      return [block];
    }
    const receipt = block.toolCallId ? receipts.get(block.toolCallId) : undefined;
    if (!receipt || block.status !== "running") return [block];
    // A canceled command remains canonical in the runtime ledger and final
    // projection. Remove only its provisional UI row instead of relabeling it
    // as either a successful or failed operation.
    if (receipt === "canceled") return [];
    return [{
      ...block,
      status: receipt === "succeeded" ? "done" as const : "failed" as const,
      evidence: receipt === "succeeded"
        ? ""
        : language === "zh"
          ? "该结构化动作已记录为失败，运行时将从已保留的证据继续恢复。"
          : "The structured action was recorded as failed; recovery will continue from retained evidence.",
      updatedAt: timestampMs,
    }];
  });
}

function terminalTurnStatus(resultKind: RuntimeV2ResultKind): "done" | "error" {
  return resultKind === "error" ? "error" : "done";
}

function ensureRuntimeV2RunStartedEvent(
  events: readonly MainThreadEvent[],
  aggregate: TurnAggregateV1,
  fallbackTimestampMs: number,
): MainThreadEvent[] {
  const run = aggregate.run?.identity;
  if (!run) return [...events];
  if (events.some((event) =>
    event.type === "run.started" &&
    event.threadId === run.sessionKey &&
    event.turnId === run.turnId &&
    event.runId === run.runId
  )) {
    return [...events];
  }
  const admittedAt = aggregate.events.find((event) => event.type === "run.started")?.at;
  return appendRuntimeEvent([...events], withEventSchema({
    type: "run.started",
    threadId: run.sessionKey,
    turnId: run.turnId,
    runId: run.runId,
    parentRunId: run.parentRunId,
    timestampMs: admittedAt || fallbackTimestampMs,
  }));
}

function localizedRuntimeV2FinalProjection(
  aggregate: TurnAggregateV1,
  projection: RuntimeV2Projection,
  language: "zh" | "en",
): RuntimeV2Projection {
  if (aggregate.terminalOutcome?.reason !== "provider_transport_exhausted") {
    return projection;
  }
  const markdown = language === "en"
    ? [
        "### Execution failed",
        "",
        "The task did not finish because every bounded model-provider transport attempt failed. No model response was accepted, and all committed evidence was preserved.",
      ].join("\n")
    : [
        "### 执行失败",
        "",
        "模型服务的有限传输重试均失败，本轮没有接受任何模型回复；已经保留全部已提交证据。",
      ].join("\n");
  return { ...projection, markdown };
}

function ownsProjection(state: any, aggregate: TurnAggregateV1): boolean {
  const run = aggregate.run?.identity;
  const marker = state?.harnessRunMarker;
  if (!run || !marker) return false;
  return marker.sessionKey === run.sessionKey &&
    marker.turnId === run.turnId &&
    marker.runId === run.runId &&
    (marker.status === "running" || marker.status === "paused" || marker.status === "completed");
}

function closeRuntimeV2CapsuleEvents(
  events: readonly MainThreadEvent[],
  aggregate: TurnAggregateV1,
  timestampMs: number,
): MainThreadEvent[] {
  const run = aggregate.run?.identity;
  if (!run) return [...events];
  return events.map((event) =>
    event.type === "progress.updated" &&
    event.threadId === run.sessionKey &&
    event.turnId === run.turnId &&
    event.runId === run.runId &&
    String(event.progress.dedupeKey || "").startsWith("runtime-v2:") &&
    String(event.progress.status || "running") === "running"
      ? withEventSchema({
          ...event,
          timestampMs,
          progress: { ...event.progress, status: "done" },
        })
      : event,
  );
}

function hasProjectionBlock(
  taskFlow: readonly TaskBlock[],
  turnId: string,
  projection: RuntimeV2Projection,
): boolean {
  return taskFlow.some((block) =>
    block.turnId === turnId &&
    block.type === "agent" &&
    block.content === projection.markdown &&
    (block.visibility === "assistant_update" || block.visibility === "assistant_final"),
  );
}

/**
 * Audience-specific UI projection. It accepts only a projection already
 * committed to the v2 ledger; no component/model text can write lifecycle
 * state back into the controller.
 */
export function createRuntimeV2ProjectionPort(
  input: RuntimeV2ProjectionStoreAdapterInput,
): ProjectionPort {
  return {
    async publish({ aggregate, audience, projection }) {
      const timestampMs = Date.now();
      const run = aggregate.run?.identity;
      if (!run) return;
      let storeDisposition:
        | "owner_mismatch"
        | "projected"
        | "deduped"
        | "suppressed_internal" = "owner_mismatch";
      input.set((state: any) => {
        if (!ownsProjection(state, aggregate)) return {};
        storeDisposition = "projected";
        let runtimeEvents = ensureRuntimeV2RunStartedEvent(
          state.runtimeEvents || [],
          aggregate,
          timestampMs,
        );
        let taskFlow = state.taskFlow || [];
        let conversationTurns = state.conversationTurns || [];
        // Failure detail belongs to the runtime/debug ledger. The public
        // timeline records only the structured outcome and never copies raw
        // model or tool output.
        taskFlow = reconcileRuntimeV2TimelineBlocks(taskFlow, aggregate, timestampMs, input.language);

        if (audience === "capsule_live") {
          runtimeEvents = closeRuntimeV2CapsuleEvents(runtimeEvents, aggregate, timestampMs);
          const command = aggregate.scheduledCommands[0];
          const tool = commandTool(command);
          const target = commandTarget(command) || aggregate.evidence[aggregate.evidence.length - 1]?.target || "";
          runtimeEvents = appendRuntimeEvent(runtimeEvents, withEventSchema({
            type: "progress.updated",
            threadId: run.sessionKey,
            turnId: run.turnId,
            runId: run.runId,
            parentRunId: run.parentRunId,
            timestampMs,
            progress: {
              phase: phaseFor(aggregate),
              title: projection.markdown.split("\n")[0]?.replace(/^#+\s*/, "") || "运行中",
              status: "running",
              action: projection.markdown,
              summary: projection.markdown,
              tool,
              target,
              canonicalTarget: target,
              audience: "user",
              dedupeKey: projectionProgressKey(aggregate, projection),
            },
          }));
        } else if (audience === "chat_milestone") {
          if (!hasProjectionBlock(taskFlow, run.turnId, projection)) {
            const block: TaskBlock = {
              id: input.nextTaskId(),
              turnId: run.turnId,
              type: "agent",
              content: projection.markdown,
              streaming: false,
              hiddenProcess: false,
              visibility: "assistant_update",
            };
            taskFlow = [...taskFlow, block];
            conversationTurns = conversationTurns.map((turn: any) =>
              turn.id === run.turnId && !turn.blockIds.includes(block.id)
                ? { ...turn, blockIds: [...turn.blockIds, block.id] }
                : turn,
            );
          } else {
            storeDisposition = "deduped";
          }
        } else if (audience === "timeline") {
          const command = aggregate.scheduledCommands[0];
          const dedupeKey = timelineProgressKey(aggregate, projection);
          if (isRuntimeOwnedPlanArtifactCommand(command)) {
            // The Plan artifact is runtime checkpoint storage, not a project
            // implementation edit. Keep it in the ledger without presenting a
            // misleading "modified .MAIN/plans/plan.md" user step.
            storeDisposition = "suppressed_internal";
          } else if (
            command &&
            !taskFlow.some((block: TaskBlock) =>
              block.type === "progress" &&
              block.turnId === run.turnId &&
              block.runId === run.runId &&
              block.dedupeKey === dedupeKey
            )
          ) {
            const block = buildTimelineProgressBlock({
              aggregate,
              command,
              projection,
              id: input.nextTaskId(),
              timestampMs,
              language: input.language,
            });
            taskFlow = [...taskFlow, block];
            conversationTurns = conversationTurns.map((turn: any) =>
              turn.id === run.turnId && !turn.blockIds.includes(block.id)
                ? { ...turn, blockIds: [...turn.blockIds, block.id] }
                : turn,
            );
          } else {
            storeDisposition = "deduped";
          }
        } else if (audience === "final") {
          const visibleProjection = localizedRuntimeV2FinalProjection(
            aggregate,
            projection,
            input.language,
          );
          runtimeEvents = closeRuntimeV2CapsuleEvents(runtimeEvents, aggregate, timestampMs);
          if (!hasProjectionBlock(taskFlow, run.turnId, visibleProjection)) {
            const block: TaskBlock = {
              id: input.nextTaskId(),
              turnId: run.turnId,
              type: "agent",
              content: visibleProjection.markdown,
              streaming: false,
              hiddenProcess: false,
              visibility: "assistant_final",
            };
            taskFlow = [...taskFlow, block];
            conversationTurns = conversationTurns.map((turn: any) =>
              turn.id === run.turnId
                ? {
                    ...turn,
                    status: terminalTurnStatus(aggregate.terminalOutcome?.resultKind || "partial"),
                    summary: visibleProjection.markdown,
                    collapsed: false,
                    processCollapsed: false,
                    blockIds: turn.blockIds.includes(block.id) ? turn.blockIds : [...turn.blockIds, block.id],
                    runtimeOutcome: {
                      status: "completed",
                      reason: aggregate.terminalOutcome?.reason || "runtime_v2_terminal",
                      resultKind: aggregate.terminalOutcome?.resultKind || "partial",
                      runId: run.runId,
                      parentRunId: run.parentRunId,
                      updatedAt: timestampMs,
                    },
                  }
                : turn,
            );
          }
          const resultKind = aggregate.terminalOutcome?.resultKind || "partial";
          if (
            resultKind === "canceled" &&
            !runtimeEvents.some((event: MainThreadEvent) =>
              event.type === "run.aborted" &&
              event.threadId === run.sessionKey &&
              event.turnId === run.turnId &&
              event.runId === run.runId
            )
          ) {
            runtimeEvents = appendRuntimeEvent(runtimeEvents, withEventSchema({
              type: "run.aborted",
              threadId: run.sessionKey,
              turnId: run.turnId,
              runId: run.runId,
              parentRunId: run.parentRunId,
              timestampMs,
              reason: aggregate.terminalOutcome?.reason || "runtime_v2_canceled",
              message: visibleProjection.markdown,
            }));
          }
          if (!runtimeEvents.some((event: MainThreadEvent) =>
            event.type === "run.completed" &&
            event.threadId === run.sessionKey &&
            event.turnId === run.turnId &&
            event.runId === run.runId,
          )) {
            runtimeEvents = appendRuntimeEvent(runtimeEvents, withEventSchema({
              type: "run.completed",
              threadId: run.sessionKey,
              turnId: run.turnId,
              runId: run.runId,
              parentRunId: run.parentRunId,
              timestampMs,
              resultKind,
              summary: visibleProjection.markdown,
            }));
          }
          if (!runtimeEvents.some((event: MainThreadEvent) =>
            event.type === "turn.completed" &&
            event.threadId === run.sessionKey && event.turnId === run.turnId,
          )) {
            runtimeEvents = appendRuntimeEvent(runtimeEvents, withEventSchema({
              type: "turn.completed",
              threadId: run.sessionKey,
              turnId: run.turnId,
              timestampMs,
              resultKind,
            }));
          }
          const marker = state.harnessRunMarker;
          return {
            runtimeEvents,
            taskFlow,
            conversationTurns,
            harnessRunMarker: marker?.runId === run.runId
              ? {
                  ...marker,
                  status: "completed",
                  terminalResultKind: resultKind,
                  closeReason: "runtime_v2_terminal",
                  closedAt: timestampMs,
                  updatedAt: timestampMs,
                }
              : marker,
            currentTurnExecutionConsent: { turnId: null, granted: false },
            activeActionRequest: null,
            pendingToolCall: null,
            agentStatus: resultKind === "error" ? "error" : "idle",
            isGenerating: false,
            abortController: null,
          };
        }

        return { runtimeEvents, taskFlow, conversationTurns };
      });
      const accepted = storeDisposition !== "owner_mismatch";
      input.logStoreEvent(
        accepted
          ? "runtime_v2_projection_published"
          : "runtime_v2_projection_skipped",
        {
          audience: audience as RuntimeV2ProjectionAudience,
          projectionId: projection.id,
          turnId: run.turnId,
          runId: run.runId,
          storeDisposition,
        },
      );
    },
  };
}
