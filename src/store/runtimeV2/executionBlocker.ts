import type { RuntimeV2ExecutionBlocker, TurnAggregateV1 } from "../../lib/runtime-v2";
import { appendRuntimeV2Checkpoint, normalizeRuntimeV2Checkpoint } from "../../lib/runtime-v2/checkpoint";
import type { UserChoiceActionRequest, UserChoiceResolutionIdentity } from "../../lib/actionRequest";
import { isExactUserChoiceResolutionIdentity } from "../../lib/actionRequest";

export function deriveRuntimeV2ExecutionBlocker(aggregate: TurnAggregateV1, requestId: string, language: "zh" | "en"): RuntimeV2ExecutionBlocker | null {
  if (aggregate.scheduledCommands.length || aggregate.pendingToolCalls.length || aggregate.subagents.some(job => job.status === "running" || job.status === "queued")) return null;
  const latest = [...aggregate.events].reverse().find(event => event.type === "provider.responded" || event.type === "run.resumed");
  if (latest?.type !== "provider.responded") return null;
  const receipt = latest.result.actionReceipts?.find(item => item.status === "rejected" && item.priorFeedbackObserved);
  if (!receipt) return null;
  const action = receipt.call.name;
  const explanation = receipt.reasonCode === "tool_surface_rejected"
    ? language === "zh" ? "该工具未在当前可用工具中提供。" : "This tool is not available in the current decision."
    : receipt.reasonCode === "tool_arguments_rejected"
      ? language === "zh" ? "工具参数未通过校验。" : "The tool arguments did not pass validation."
      : language === "zh" ? "相同动作已被阻止或拒绝，未再次执行。" : "The same action was blocked or rejected and did not run again.";
  return { requestId, reasonCode: "rejected_action_cycle", evidenceSequence: latest.sequence, actionIdentity: receipt.actionIdentity,
    message: language === "zh" ? `模型在收到拒绝原因后再次提交了 ${action}，当前分支已暂停。${explanation}\n\n请处理所需条件后重新检查，或停止任务。重新检查不会扩大权限。`
      : `The model repeated ${action} after receiving its rejection. This branch is paused. ${explanation}\n\nResolve the prerequisite and recheck, or stop. Rechecking grants no additional permissions.`, options: ["recheck", "stop"] };
}

export function createRuntimeV2ExecutionBlockerView(aggregate: TurnAggregateV1, language: "zh" | "en", taskId: number) {
  const blocker = aggregate.run?.blocker;
  if (aggregate.run?.status !== "paused" || !blocker) return null;
  const title = language === "zh" ? "执行需要你的选择" : "Execution needs your input";
  const labels = language === "zh" ? { recheck: "我已处理，重新检查", continue: "继续其他可行工作", stop: "停止任务" } : { recheck: "Recheck after my changes", continue: "Continue independent work", stop: "Stop task" };
  const options = blocker.clarification ? [...(blocker.clarification.choices || []).map(value => ({ label: value, value })), { label: labels.stop, value: "stop" }]
    : blocker.options.map(value => ({ label: labels[value], value }));
  const request: UserChoiceActionRequest = { schemaVersion: 1, kind: "user_choice", requestId: blocker.requestId,
    sessionKey: aggregate.turn.sessionKey, turnId: aggregate.turn.turnId, runId: aggregate.run.identity.runId,
    parentRunId: aggregate.run.identity.parentRunId, title, status: "pending", createdAt: aggregate.updatedAt,
    optionValues: options.map(option => option.value), allowCustomReply: !!blocker.clarification, executionBlocker: { sessionEpoch: aggregate.turn.sessionEpoch } };
  const block = { id: taskId, type: "agent" as const, visibility: "assistant_update" as const, turnId: request.turnId,
    content: `${title}\n\n${blocker.message}`, options, choiceRequest: request };
  return { request, block };
}

export function projectRuntimeV2ExecutionBlocker(input: { aggregate: TurnAggregateV1; get: () => any; set: (value: any) => void; language: "zh" | "en" }): void {
  const view = createRuntimeV2ExecutionBlockerView(input.aggregate, input.language, input.get()._nextTaskId());
  if (!view) return;
  const { request, block } = view;
  input.set((state: any) => {
    if (state.currentTurnId !== request.turnId || state.harnessRunMarker?.runId !== request.runId ||
      state.harnessRunMarker.sessionKey !== request.sessionKey ||
      normalizeRuntimeV2Checkpoint(state.runtimeV2Checkpoints?.[request.turnId])?.owner.sessionEpoch !== request.executionBlocker?.sessionEpoch) return {};
    const exists = state.taskFlow.some((item: any) => item.choiceRequest?.requestId === request.requestId);
    return { activeActionRequest: request, taskFlow: exists ? state.taskFlow : [...state.taskFlow, block] };
  });
}

/** Exact control entry: durable decision precedes dispatch, no resolver closure. */
const pendingDecisions = new WeakMap<() => any, Set<string>>();
export async function resolveRuntimeV2ExecutionBlocker(input: {
  get: () => any; set: (value: any) => void;
  identity: UserChoiceResolutionIdentity; choice: string; sessionEpoch: string;
  persist: (state: any, isCurrent: () => boolean) => Promise<unknown>;
  dispatch: (turn: any, requestId: string) => void; stop: (turnId: string) => void;
}): Promise<boolean> {
  const state = input.get();
  const request = state.activeActionRequest;
  if (request?.kind !== "user_choice" || !request.executionBlocker || !isExactUserChoiceResolutionIdentity(request, input.identity)) return false;
  const checkpoint = normalizeRuntimeV2Checkpoint(state.runtimeV2Checkpoints?.[request.turnId]);
  const aggregate = checkpoint?.aggregate;
  const blocker = aggregate?.run?.blocker;
  const reply = blocker?.clarification && input.choice !== "stop" ? input.choice.trim() : undefined;
  const choice = reply ? "recheck" : input.choice;
  if (!checkpoint || !aggregate || !blocker || aggregate.turn.sessionEpoch !== input.sessionEpoch || request.executionBlocker.sessionEpoch !== input.sessionEpoch || aggregate.run?.status !== "paused" || aggregate.run.identity.runId !== request.runId || blocker.requestId !== request.requestId || !blocker.options.includes(choice as any) || (blocker.clarification && choice !== "stop" && !reply)) return false;
  if (blocker.decision && (blocker.decision !== choice || blocker.decisionReply !== reply)) return false;
  const key = `${input.sessionEpoch}:${request.turnId}:${request.runId}:${request.requestId}:${checkpoint.revision}`;
  const pending = pendingDecisions.get(input.get) || new Set<string>();
  if (pending.has(key)) return false;
  pendingDecisions.set(input.get, pending);
  pending.add(key);
  try {
  const current = () => input.get().currentTurnId === request.turnId && input.get().activeActionRequest?.requestId === request.requestId &&
    input.get().harnessRunMarker?.startedAt === state.harnessRunMarker?.startedAt && input.get().harnessRunMarker?.instanceId === state.harnessRunMarker?.instanceId &&
    normalizeRuntimeV2Checkpoint(input.get().runtimeV2Checkpoints?.[request.turnId])?.owner.sessionEpoch === input.sessionEpoch &&
    input.get().harnessRunMarker?.runId === request.runId && input.get().harnessRunMarker?.status === "paused" &&
    normalizeRuntimeV2Checkpoint(input.get().runtimeV2Checkpoints?.[request.turnId])?.revision === checkpoint.revision;
  const appended = blocker.decision ? { disposition: "committed", checkpoint } : appendRuntimeV2Checkpoint({ checkpoint,
    owner: aggregate.turn, expectedRevision: checkpoint.revision,
    event: { schemaVersion: "runtime-v2-event.v1", type: "run.decision_recorded", eventId: `decision:${blocker.requestId}`,
      at: Math.max(Date.now(), aggregate.updatedAt), sequence: aggregate.nextSequence, run: aggregate.run.identity,
      requestId: blocker.requestId, choice: choice as "recheck" | "continue" | "stop", ...(reply ? { reply } : {}) } });
  if (appended.disposition !== "committed" || !appended.checkpoint || !current()) return false;
  const projected = { ...state, runtimeV2Checkpoints: { ...state.runtimeV2Checkpoints, [request.turnId]: appended.checkpoint } };
  const persisted: any = await input.persist(projected, current);
  if (!current()) return false;
  input.set((latest: any) => ({ runtimeV2Checkpoints: { ...latest.runtimeV2Checkpoints, [request.turnId]: appended.checkpoint },
    ...(persisted?.sessionsByWorkspace ? { sessionsByWorkspace: Object.fromEntries(Object.entries(latest.sessionsByWorkspace || {}).map(([scope, records]) => [scope,
      (records as any[]).map(record => scope === aggregate.turn.workspaceKey && record.id === state.currentSessionId ?
        { ...record, ...(persisted.sessionsByWorkspace[scope] || []).find((saved: any) => saved.id === record.id) } : record)])) } : {}) }));
  if (choice === "stop") input.stop(request.turnId);
  else {
    const turn = input.get().conversationTurns.find((candidate: any) => candidate.id === request.turnId);
    if (!turn) return false;
    input.dispatch(turn, request.requestId);
  }
  return true;
  } finally { pending.delete(key); }
}
