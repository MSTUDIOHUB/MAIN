import { getToolTarget } from "../../lib/toolTarget";
import { buildDurableTurnContext } from "../../lib/durableTurnContext";
import {
  appendRuntimeEvent,
  withEventSchema,
  type MainThreadEvent,
} from "../../lib/turnEvents";
import type { ProgressTaskBlock, TaskBlock } from "../../lib/taskTypes";
import {
  deriveTurnRuntimePhaseForTool,
  withTurnRuntimePhaseStatus,
} from "../../lib/turnPhase";
import { runtimeV2StructuredActionMarkdown } from "../../lib/runtime-v2";
import type {
  ProjectionPort,
  RuntimeV2Command,
  RuntimeV2Projection,
  RuntimeV2ProjectionAudience,
  RuntimeV2ResultKind,
  TurnAggregateV1,
} from "../../lib/runtime-v2";
import { reconcileRuntimeV2SubagentEvents } from "./subagentProjection";
import { localizedRuntimeV2FinalProjection } from "./projectionTerminal";

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
  if (command.kind === "collect_observation") return "get_project_skeleton";
  if (command.kind === "schedule_subagents") return "spawn_subagent";
  if (command.kind === "join_subagents") return "wait_subagents";
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
  if (command.kind === "schedule_subagents") {
    const args =
      command.payload.arguments &&
        typeof command.payload.arguments === "object" &&
        !Array.isArray(command.payload.arguments)
        ? command.payload.arguments as Record<string, unknown>
        : {};
    return String(
      args.name || args.task_key || args.objective || "",
    ).trim();
  }
  if (command.kind === "collect_observation") {
    return command.run.sessionKey;
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

function isInternalTimelineCommand(command: RuntimeV2Command | undefined): boolean {
  return !command ||
    command.kind === "request_model" ||
    command.kind === "finalize_turn" ||
    command.kind === "publish_projection" ||
    command.payload.runtimeControlPlane === true ||
    isRuntimeOwnedPlanArtifactCommand(command);
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

function compactRunStatusTarget(target: string, language: "zh" | "en"): string {
  const normalized = String(target || "").trim().replace(/\\/g, "/").replace(/\/+$/, "");
  const parts = normalized.split("/").filter(Boolean);
  return (parts[parts.length - 1] || normalized).slice(0, 72) ||
    (language === "zh" ? "当前工作区" : "current workspace");
}

function runStatusTitle(
  aggregate: TurnAggregateV1,
  command: RuntimeV2Command | undefined,
  target: string,
  language: "zh" | "en",
): string {
  if (command?.kind === "execute_tool" || command?.kind === "execute_validation") {
    const tool = commandTool(command);
    const name = compactRunStatusTarget(target, language);
    const read = /^(?:read_file|read_document|get_file_outline|code_ast_query|git_status|git_diff|analyze_tabular_document|query_tabular_document|knowledge_get_excerpt)$/i.test(tool);
    const search = /^(?:list_directory|get_project_skeleton|glob_search|grep_search|find_symbol_references|repo_map_status|repo_map_search|repo_map_context|repo_map_files|repo_map_impact|index_workspace_documents|knowledge_search)$/i.test(tool);
    const edit = /^(?:write_file|replace_in_file|apply_patch|delete_workspace_path)$/i.test(tool);
    const commandLine = /^(?:run_command|execute_command|send_pty_input|read_pty_|get_pty_status|clear_pty_buffer)/i.test(tool);
    const browser = /browser/i.test(tool);
    if (language === "en") {
      if (read) return `Reading ${name}`;
      if (search) return `Searching ${name}`;
      if (edit) return `Editing ${name}`;
      if (commandLine) return `Running ${name}`;
      if (browser) return `Validating ${name}`;
    } else {
      if (read) return `正在读取 ${name}`;
      if (search) return `正在搜索 ${name}`;
      if (edit) return `正在编辑 ${name}`;
      if (commandLine) return `正在运行 ${name}`;
      if (browser) return `正在验证 ${name}`;
    }
  }
  if (command) {
    return timelineTitle(command, target, language, aggregate.strategy).replace(/`/g, "");
  }
  const phaseTitles: Record<TurnAggregateV1["phase"], { zh: string; en: string }> = {
    preparing: { zh: "正在准备执行", en: "Preparing" },
    observing: { zh: "正在收集证据", en: "Collecting evidence" },
    planning: { zh: "正在形成计划", en: "Preparing the plan" },
    reviewing: { zh: "正在等待审核", en: "Waiting for review" },
    acting: { zh: "正在实施修改", en: "Implementing the change" },
    validating: { zh: "正在验证结果", en: "Validating the result" },
    finalizing: { zh: "正在整理结论", en: "Preparing the conclusion" },
    completed: { zh: "任务已结束", en: "Run completed" },
  };
  return phaseTitles[aggregate.phase][language];
}

function comparableRunStatusText(value: string): string {
  return String(value || "")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/[*_`~]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[。.!！?？]+$/g, "")
    .toLocaleLowerCase();
}

function buildTimelineToolBlock(input: {
  aggregate: TurnAggregateV1;
  command: RuntimeV2Command;
  projection: RuntimeV2Projection;
  id: number;
  language: "zh" | "en";
}): Extract<TaskBlock, { type: "tool" }> {
  const run = input.aggregate.run!.identity;
  const target = timelineTarget(input.command);
  const tool = commandTool(input.command);
  return {
    id: input.id,
    turnId: run.turnId,
    type: "tool",
    toolName: tool,
    executionName: tool,
    target,
    status: "running",
    toolStatus: "running",
    toolCallId: input.command.idempotencyKey,
    turnPhase: deriveTurnRuntimePhaseForTool({
      toolName: tool,
      target,
      language: input.language,
      status: "running",
    }),
    intentSummary: timelineTitle(
      input.command,
      target,
      input.language,
      input.aggregate.strategy,
    ),
    runId: run.runId,
    parentRunId: run.parentRunId,
    dedupeKey: timelineProgressKey(input.aggregate, input.projection),
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
  const validationOutcomes = new Map(
    aggregate.events
      .filter((event) => event.type === "validation.completed")
      .map((event) => [event.idempotencyKey, event.passed] as const),
  );
  const completions = new Map(
    aggregate.events
      .filter((event) =>
        event.type === "tool.completed" ||
        event.type === "validation.completed"
      )
      .map((event) => [event.idempotencyKey, event] as const),
  );
  return taskFlow.flatMap((block) => {
    if (
      (block.type !== "progress" && block.type !== "tool") ||
      block.turnId !== run.turnId ||
      block.runId !== run.runId ||
      !String(block.dedupeKey || "").startsWith("runtime-v2-timeline:")
    ) {
      return [block];
    }
    const receipt = block.toolCallId ? receipts.get(block.toolCallId) : undefined;
    const blockRunning = block.type === "progress"
      ? block.status === "running"
      : block.toolStatus === "running";
    if (!receipt || !blockRunning) return [block];
    // A canceled command remains canonical in the runtime ledger and final
    // projection. Remove only its provisional UI row instead of relabeling it
    // as either a successful or failed operation.
    if (receipt === "canceled") return [];
    const validationPassed = block.toolCallId
      ? validationOutcomes.get(block.toolCallId)
      : undefined;
    const failed = receipt === "failed" || validationPassed === false;
    if (block.type === "tool") {
      const completion = block.toolCallId
        ? completions.get(block.toolCallId)
        : undefined;
      const toolFailed =
        completion?.type === "tool.completed" &&
        completion.status !== "succeeded";
      const terminalFailed = failed || toolFailed;
      const presentation = completion?.presentation;
      const fallbackMessage = terminalFailed
        ? validationPassed === false
          ? language === "zh"
            ? "有限验证未通过；运行时已保留真实失败输出供后续修复。"
            : "Validation did not pass; Runtime retained the real failure output for the next repair."
          : language === "zh"
            ? "该结构化工具动作未成功完成。"
            : "The structured tool action did not complete successfully."
        : "";
      return [{
        ...block,
        toolName: presentation?.toolName || block.toolName,
        executionName: presentation?.toolName || block.executionName,
        target: presentation?.target || block.target,
        status: terminalFailed ? "error" : "done",
        toolStatus: terminalFailed ? "failed" : "executed",
        turnPhase: withTurnRuntimePhaseStatus(
          block.turnPhase,
          terminalFailed ? "failed" : "done",
          language,
        ),
        message: presentation?.message || fallbackMessage,
        observationSummary:
          presentation?.observationSummary ||
          presentation?.message ||
          fallbackMessage,
        ...(presentation?.diff
          ? {
              diff: { ...presentation.diff },
              workspaceEffect: terminalFailed
                ? "partial" as const
                : "verified" as const,
            }
          : {}),
      }];
    }
    return [{
      ...block,
      status: failed ? "failed" as const : "done" as const,
      evidence: !failed
        ? ""
        : validationPassed === false
          ? language === "zh"
            ? "有限验证未通过；运行时将根据已保留的失败证据继续修复。"
            : "Validation did not pass; Runtime will continue from the retained failure evidence."
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
  visibility: "assistant_update" | "assistant_final",
): boolean {
  return taskFlow.some((block) =>
    block.turnId === turnId &&
    block.type === "agent" &&
    block.content === projection.markdown &&
    block.visibility === visibility,
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
        runtimeEvents = reconcileRuntimeV2SubagentEvents(
          runtimeEvents,
          aggregate,
          state,
          input.language,
        );
        let taskFlow = state.taskFlow || [];
        let conversationTurns = state.conversationTurns || [];
        // Reconcile only the bounded presentation facts committed by the
        // effect adapter. Raw provider/tool transport payloads remain outside
        // TaskFlow, while real targets, summaries and diffs stay inspectable.
        taskFlow = reconcileRuntimeV2TimelineBlocks(taskFlow, aggregate, timestampMs, input.language);

        if (audience === "capsule_live") {
          runtimeEvents = closeRuntimeV2CapsuleEvents(runtimeEvents, aggregate, timestampMs);
          const command = aggregate.scheduledCommands[0];
          const tool = commandTool(command);
          const target = commandTarget(command) || aggregate.evidence[aggregate.evidence.length - 1]?.target || "";
          const title = runStatusTitle(aggregate, command, target, input.language);
          const structuredAction = command
            ? runtimeV2StructuredActionMarkdown(command, aggregate)
            : projection.markdown;
          const summary = comparableRunStatusText(title) === comparableRunStatusText(structuredAction)
            ? ""
            : structuredAction;
          runtimeEvents = appendRuntimeEvent(runtimeEvents, withEventSchema({
            type: "progress.updated",
            threadId: run.sessionKey,
            turnId: run.turnId,
            runId: run.runId,
            parentRunId: run.parentRunId,
            timestampMs,
            progress: {
              phase: phaseFor(aggregate),
              title,
              status: "running",
              action: projection.markdown,
              ...(summary ? { summary } : {}),
              tool,
              target,
              canonicalTarget: target,
              audience: "user",
              dedupeKey: projectionProgressKey(aggregate, projection),
            },
          }));
        } else if (audience === "chat_milestone") {
          if (!hasProjectionBlock(
            taskFlow,
            run.turnId,
            projection,
            "assistant_update",
          )) {
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
          if (isInternalTimelineCommand(command)) {
            // Provider turns, control-plane submissions and runtime-owned
            // artifacts remain auditable in the ledger. Timeline is reserved
            // for concrete tools, validations and child work visible to users.
            storeDisposition = "suppressed_internal";
          } else if (
            command &&
            !taskFlow.some((block: TaskBlock) =>
              (block.type === "progress" || block.type === "tool") &&
              block.turnId === run.turnId &&
              block.runId === run.runId &&
              block.dedupeKey === dedupeKey
            )
          ) {
            const block = buildTimelineToolBlock({
              aggregate,
              command,
              projection,
              id: input.nextTaskId(),
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
          if (!hasProjectionBlock(
            taskFlow,
            run.turnId,
            visibleProjection,
            "assistant_final",
          )) {
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
                ? (() => {
                    const nextTurn = {
                      ...turn,
                      status: terminalTurnStatus(
                        aggregate.terminalOutcome?.resultKind || "partial",
                      ),
                      summary: visibleProjection.markdown,
                      collapsed: false,
                      processCollapsed: false,
                      blockIds: turn.blockIds.includes(block.id)
                        ? turn.blockIds
                        : [...turn.blockIds, block.id],
                      runtimeOutcome: {
                        status: "completed" as const,
                        reason:
                          aggregate.terminalOutcome?.reason ||
                          "runtime_v2_terminal",
                        resultKind:
                          aggregate.terminalOutcome?.resultKind || "partial",
                        runId: run.runId,
                        parentRunId: run.parentRunId,
                        updatedAt: timestampMs,
                      },
                    };
                    const durableContext = buildDurableTurnContext({
                      turnId: run.turnId,
                      turnBlocks: taskFlow.filter(
                        (candidate: TaskBlock) =>
                          candidate.turnId === run.turnId,
                      ),
                      fallbackAssistantText: visibleProjection.markdown,
                      now: timestampMs,
                    });
                    return durableContext
                      ? { ...nextTurn, durableContext }
                      : nextTurn;
                  })()
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
          const existingAgentMessages = Array.isArray(state.agentMessages)
            ? state.agentMessages
            : [];
          const agentMessages = existingAgentMessages.some((message: any) =>
            message?.role === "assistant" &&
            (
              String(message.runtimeTurnId || "").trim() === run.turnId ||
              String(message.content || "").trim() ===
                visibleProjection.markdown.trim()
            )
          )
            ? existingAgentMessages
            : [
                ...existingAgentMessages,
                {
                  role: "assistant" as const,
                  content: visibleProjection.markdown,
                  runtimeTurnId: run.turnId,
                },
              ];
          const marker = state.harnessRunMarker;
          return {
            runtimeEvents,
            taskFlow,
            conversationTurns,
            agentMessages,
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
      const projectedState = input.get();
      const projectedRuntimeEvents = Array.isArray(projectedState?.runtimeEvents)
        ? projectedState.runtimeEvents as MainThreadEvent[]
        : [];
      const projectedTaskFlow = Array.isArray(projectedState?.taskFlow)
        ? projectedState.taskFlow as TaskBlock[]
        : [];
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
          projectionKind: projection.kind,
          dedupeKey: projection.dedupeKey.slice(0, 240),
          dedupeKeyChars: projection.dedupeKey.length,
          markdownChars: projection.markdown.length,
          projectionTitle: projection.markdown
            .split("\n")[0]
            ?.replace(/^#+\s*/, "")
            .trim()
            .slice(0, 240) || "",
          timelineRecordCount: projectedTaskFlow.filter((block) =>
            block.type === "progress" &&
            block.turnId === run.turnId &&
            block.runId === run.runId &&
            String(block.dedupeKey || "").startsWith("runtime-v2-timeline:")
          ).length,
          subagentRecordCount: projectedRuntimeEvents.filter((event) =>
            event.type === "subagent.created" &&
            event.turnId === run.turnId
          ).length,
        },
      );
    },
  };
}
