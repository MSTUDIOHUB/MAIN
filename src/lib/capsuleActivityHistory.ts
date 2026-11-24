import { describeCapsuleToolActivity } from "./capsuleToolActivity";
import type { TurnAggregateV1 } from "./runtime-v2/aggregate";
import type { RuntimeV2Command, RuntimeV2ResultKind, RuntimeV2RunIdentity } from "./runtime-v2/contracts";
import type { RuntimeV2Event } from "./runtime-v2/events";
import { isRuntimeV2UnexecutedToolReceipt } from "./runtime-v2/toolReceipt";
import type { TaskBlock } from "./taskTypes";
import type { MainThreadEvent, TerminalResultKind } from "./turnEvents";

export type CapsuleActivityOutcome =
  | "succeeded" | "failed" | "blocked" | "not_executed"
  | "waiting" | "resumed" | "partial" | "canceled";

export interface CapsuleActivityHistoryRow {
  readonly key: string;
  readonly at: number | null;
  readonly title: string;
  readonly target?: string;
  readonly outcome: CapsuleActivityOutcome;
}

interface CapsuleActivityHistoryInput {
  /** A checkpoint aggregate must already have passed normal replay and owner verification. */
  readonly aggregate?: TurnAggregateV1 | null;
  readonly sessionKey: string;
  readonly sessionEpoch?: string | null;
  readonly turnId: string;
  readonly runId: string;
  readonly parentRunId?: string | null;
  readonly workspaceKey?: string | null;
  readonly language: "zh" | "en";
  readonly legacyEvents?: readonly MainThreadEvent[];
  /** These blocks come from the selected session's task flow. */
  readonly legacyBlocks?: readonly TaskBlock[];
}

const MAX_HISTORY_ROWS = 6;
const INTERNAL_TOOL_NAMES = new Set([
  "ask_plan_questions",
  "record_runtime_v2_execution_contract",
  "submit_runtime_v2_work_plan",
]);

type ToolCompletion = Extract<RuntimeV2Event, { type: "tool.completed" | "validation.completed" }>;

function sameRun(left: RuntimeV2RunIdentity, right: RuntimeV2RunIdentity): boolean {
  return left.sessionKey === right.sessionKey &&
    left.sessionEpoch === right.sessionEpoch &&
    left.turnId === right.turnId &&
    left.runId === right.runId &&
    left.parentRunId === right.parentRunId &&
    left.attemptId === right.attemptId;
}

function completionOutcome(event: ToolCompletion): CapsuleActivityOutcome {
  if (isRuntimeV2UnexecutedToolReceipt(event) ||
    (event.type === "validation.completed" && event.failureKind === "not_executed")) return "not_executed";
  if (event.failureKind === "not_authorized") return "blocked";
  if (event.type === "tool.completed") return event.status;
  return event.passed ? "succeeded" : "failed";
}

function terminalOutcome(result: RuntimeV2ResultKind | TerminalResultKind): CapsuleActivityOutcome {
  if (result === "success") return "succeeded";
  if (result === "error") return "failed";
  return result;
}

function approvalTitle(kind: "tool_permission" | "plan_review" | "user_choice", zh: boolean): string {
  switch (kind) {
    case "tool_permission": return zh ? "请求工具权限" : "Requested tool permission";
    case "plan_review": return zh ? "等待审核计划" : "Waiting for plan review";
    case "user_choice": return zh ? "等待你的选择" : "Waiting for your choice";
  }
}

function commandTarget(command: RuntimeV2Command, toolName: string): string {
  const args = command.payload.arguments;
  if (args && typeof args === "object" && !Array.isArray(args)) {
    const fields = args as Record<string, unknown>;
    const target = toolName === "web_fetch" || toolName === "browser_evaluate" ? fields.url : fields.path;
    if (typeof target === "string") return target;
  }
  return typeof command.payload.target === "string" ? command.payload.target : "";
}

function collectCanonicalRows(
  aggregate: TurnAggregateV1,
  input: CapsuleActivityHistoryInput,
  rows: Map<string, CapsuleActivityHistoryRow>,
) {
  const run = aggregate.run?.identity;
  if (!run || aggregate.turn.sessionKey !== input.sessionKey || aggregate.turn.turnId !== input.turnId ||
    run.sessionKey !== aggregate.turn.sessionKey || run.sessionEpoch !== aggregate.turn.sessionEpoch ||
    run.turnId !== aggregate.turn.turnId || run.runId !== input.runId ||
    (input.sessionEpoch != null && aggregate.turn.sessionEpoch !== input.sessionEpoch) ||
    (input.parentRunId !== undefined && run.parentRunId !== input.parentRunId)) return;

  const commands = new Map<string, RuntimeV2Command>();
  const zh = input.language === "zh";
  for (const [index, event] of aggregate.events.entries()) {
    if (!("run" in event) || !sameRun(event.run, run)) continue;
    const add = (key: string, title: string, outcome: CapsuleActivityOutcome) => {
      rows.set(key, { key, at: event.at, title, outcome });
    };
    switch (event.type) {
      case "command.scheduled":
        if (sameRun(event.command.run, run)) commands.set(event.command.idempotencyKey, event.command);
        break;
      case "observation.recorded": {
        // Both the Plan bootstrap and the Execute controller append a
        // workspace overview immediately after settling collect_observation.
        // The settlement alone also occurs for deferred work. Plan can reuse
        // its admission baseline here, so the label only claims preparation.
        const previous = aggregate.events[index - 1];
        if (previous?.type === "command.completed" && sameRun(previous.run, run) &&
          previous.status === "succeeded" && event.evidence.kind === "source" &&
          commands.get(previous.idempotencyKey)?.kind === "collect_observation") {
          add(`tool:${previous.idempotencyKey}`, zh ? "准备工作区概览" : "Prepared workspace overview", "succeeded");
        }
        break;
      }
      case "tool.completed":
      case "validation.completed": {
        if (event.type === "tool.completed" && event.receiptOrigin === "replayed") break;
        const command = commands.get(event.idempotencyKey);
        if (!command || command.kind !== (event.type === "tool.completed" ? "execute_tool" : "execute_validation") ||
          command.payload.runtimeControlPlane === true || command.payload.runtimeOwnedPlanArtifact === true) break;
        const toolName = event.presentation?.toolName ||
          (typeof command.payload.toolName === "string" ? command.payload.toolName : "");
        if (INTERNAL_TOOL_NAMES.has(toolName)) break;
        const key = `tool:${event.idempotencyKey}`;
        rows.set(key, {
          key,
          at: event.at,
          outcome: completionOutcome(event),
          ...describeCapsuleToolActivity({
            toolName,
            target: event.presentation?.target || event.evidence[0]?.target || commandTarget(command, toolName),
            validation: event.type === "validation.completed",
            workspaceKey: input.workspaceKey ?? aggregate.turn.workspaceKey,
            language: input.language,
          }),
        });
        break;
      }
      case "run.wait_started":
        add(`wait:${event.requestId}`, approvalTitle("tool_permission", zh), "waiting");
        break;
      case "run.paused": {
        const reason = event.blocker.reasonCode;
        const title = reason === "user_questionnaire" || reason === "intent_clarification"
          ? zh ? "等待你的回答" : "Waiting for your answer"
          : reason === "document_save_failed"
            ? zh ? "等待重试保存" : "Waiting to retry saving"
            : zh ? "暂停，等待处理" : "Paused for input";
        add(`wait:${event.blocker.requestId}`, title, "waiting");
        break;
      }
      case "run.resumed":
        add(`resume:${event.requestId}`, zh ? "继续运行" : "Resumed run", "resumed");
        break;
      case "work_plan.sealed":
        add(`review:${event.workPlan.id}:${event.workPlan.revision}`, approvalTitle("plan_review", zh), "waiting");
        break;
      case "work_plan.approved":
        add(`approval:${event.workPlan.id}:${event.workPlan.revision}`, zh ? "计划已确认" : "Plan approved", "succeeded");
        break;
      case "run.completed":
        add("terminal", zh ? "运行结束" : "Run ended", terminalOutcome(event.outcome.resultKind));
        break;
    }
  }
}

function collectLegacyRows(
  input: CapsuleActivityHistoryInput,
  rows: Map<string, CapsuleActivityHistoryRow>,
) {
  const zh = input.language === "zh";
  // Old tool blocks have no timestamp. Bind their structured completion event
  // only when the exact call ID identifies one owner in the selected turn.
  const blocks = new Map<string, Extract<TaskBlock, { type: "tool" }> | null>();
  for (const block of input.legacyBlocks || []) {
    if (block.type !== "tool" || block.turnId !== input.turnId || block.audience === "internal") continue;
    const exactRun = block.runId === input.runId &&
      (input.parentRunId === undefined || (block.parentRunId ?? null) === input.parentRunId);
    const callId = block.toolCallId;
    if (callId) {
      const previous = blocks.get(callId);
      blocks.set(callId, exactRun && previous !== null ? block : null);
    }
    if (!exactRun) continue;
    const outcome = block.toolOutcome ||
      (block.toolStatus === "executed" ? "succeeded" : block.toolStatus === "failed" ? "failed"
        : block.toolStatus === "rejected" ? "blocked" : null);
    if (!outcome) continue;
    const toolName = block.executionName || block.toolName;
    if (INTERNAL_TOOL_NAMES.has(toolName)) continue;
    const key = `tool:${callId || block.id}`;
    rows.set(key, {
      key, at: null, outcome,
      ...describeCapsuleToolActivity({ toolName, target: block.target, workspaceKey: input.workspaceKey, language: input.language }),
    });
  }
  for (const event of input.legacyEvents || []) {
    if (event.threadId !== input.sessionKey || !("turnId" in event) || event.turnId !== input.turnId) continue;
    const parentMatches = input.parentRunId === undefined ||
      ("parentRunId" in event ? event.parentRunId ?? null : null) === input.parentRunId;
    const hasRunOwner = "runId" in event;
    const exactRun = hasRunOwner && event.runId === input.runId && parentMatches;
    const add = (key: string, title: string, outcome: CapsuleActivityOutcome) => {
      rows.set(key, { key, at: event.timestampMs, title, outcome });
    };
    if (event.type === "item.completed") {
      const details = event.item.details;
      if (details.type !== "tool_call" && details.type !== "tool_result" && details.type !== "tool_lifecycle") continue;
      if (!exactRun && (hasRunOwner || ("parentRunId" in event && !parentMatches) ||
        !blocks.get(details.toolCallId))) continue;
      const toolName = blocks.get(details.toolCallId)?.executionName || details.tool;
      if (INTERNAL_TOOL_NAMES.has(toolName)) continue;
      const key = `tool:${details.toolCallId}`;
      const known = rows.get(key);
      const eventOutcome = details.status === "completed" ? "succeeded"
        : details.status === "failed" ? "failed"
        : details.status === "declined" || details.status === "blocked" ? "blocked" : null;
      if (eventOutcome) {
        rows.set(key, {
          key, at: event.timestampMs, outcome: known?.outcome || eventOutcome,
          ...describeCapsuleToolActivity({ toolName, target: details.target, workspaceKey: input.workspaceKey, language: input.language }),
        });
      }
    } else if (exactRun && event.type === "approval.requested") {
      add(`wait:${event.requestId}`, approvalTitle(event.actionKind, zh), "waiting");
    } else if (exactRun && event.type === "run.paused") {
      const key = `wait:${event.requestId || event.timestampMs}`;
      if (!rows.has(key)) add(key, zh ? "暂停，等待处理" : "Paused for input", "waiting");
    } else if (exactRun && event.type === "run.completed" && event.resultKind) {
      add("terminal", zh ? "运行结束" : "Run ended", terminalOutcome(event.resultKind));
    }
  }
}

/** Recent receipts from one selected Run. Transient activity snapshots have
 * no place in this projection, even when a compatibility emitter marks them done. */
export function buildCapsuleActivityHistory(input: CapsuleActivityHistoryInput): readonly CapsuleActivityHistoryRow[] {
  if (!input.sessionKey || !input.turnId || !input.runId) return [];
  const rows = new Map<string, CapsuleActivityHistoryRow>();
  if (input.aggregate) {
    collectCanonicalRows(input.aggregate, input, rows);
  } else {
    collectLegacyRows(input, rows);
  }
  return [...rows.values()].reverse()
    .sort((left, right) => (right.at ?? -Infinity) - (left.at ?? -Infinity))
    .slice(0, MAX_HISTORY_ROWS);
}
