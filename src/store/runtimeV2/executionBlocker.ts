import type { TurnAggregateV1 } from "../../lib/runtime-v2";
import { appendRuntimeV2Checkpoint, normalizeRuntimeV2Checkpoint } from "../../lib/runtime-v2/checkpoint";
import type { UserChoiceActionRequest, UserChoiceResolutionIdentity } from "../../lib/actionRequest";
import { isExactUserChoiceResolutionIdentity } from "../../lib/actionRequest";
import { renderUserChoiceAnswer, validateUserChoiceAnswer, type UserChoiceAnswer } from "../../lib/userQuestions";

export function createRuntimeV2ExecutionBlockerView(aggregate: TurnAggregateV1, language: "zh" | "en", taskId: number) {
  const blocker = aggregate.run?.blocker;
  if (aggregate.run?.status !== "paused" || !blocker) return null;
  const saveFailed = blocker.reasonCode === "document_save_failed";
  const title = (saveFailed ? (language === "zh" ? "计划文档保存失败" : "Plan document save failed") : blocker.questionnaire?.title) || (language === "zh" ? "执行需要你的选择" : "Execution needs your input");
  const labels = language === "zh" ? { recheck: "我已处理，重新检查", continue: "继续其他可行工作", stop: "停止任务" } : { recheck: "Recheck after my changes", continue: "Continue independent work", stop: "Stop task" };
  if (saveFailed) labels.recheck = language === "zh" ? "重新保存文档" : "Retry document save";
  const options = blocker.questionnaire ? [] : blocker.clarification ? [...(blocker.clarification.choices || []).map(value => ({ label: value, value })), { label: labels.stop, value: "stop" }]
    : blocker.options.map(value => ({ label: labels[value], value }));
  const request: UserChoiceActionRequest = { schemaVersion: 1, kind: "user_choice", requestId: blocker.requestId,
    sessionKey: aggregate.turn.sessionKey, turnId: aggregate.turn.turnId, runId: aggregate.run.identity.runId,
    parentRunId: aggregate.run.identity.parentRunId, title, status: "pending", createdAt: aggregate.updatedAt,
    optionValues: options.map(option => option.value), allowCustomReply: !!blocker.clarification,
    ...(blocker.questionnaire ? { questionnaire: blocker.questionnaire } : {}), executionBlocker: { sessionEpoch: aggregate.turn.sessionEpoch } };
  const block = { id: taskId, type: "agent" as const, visibility: "assistant_update" as const, turnId: request.turnId,
    content: `${title}\n\n${blocker.message}`, options, choiceRequest: request };
  return { request, block };
}

export function resolveRuntimeV2StructuredUserChoice(input: Omit<Parameters<typeof resolveRuntimeV2ExecutionBlocker>[0], "choice" | "answer"> & {
  answer: UserChoiceAnswer;
}): Promise<boolean> {
  return resolveRuntimeV2ExecutionBlocker({ ...input, choice: "recheck" });
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
  identity: UserChoiceResolutionIdentity; choice: string; sessionEpoch: string; answer?: UserChoiceAnswer;
  persist: (state: any, isCurrent: () => boolean) => Promise<unknown>;
  dispatch: (turn: any, requestId: string) => void; stop: (turnId: string) => void;
}): Promise<boolean> {
  const state = input.get();
  const request = state.activeActionRequest;
  if (request?.kind !== "user_choice" || !request.executionBlocker || !isExactUserChoiceResolutionIdentity(request, input.identity)) return false;
  const checkpoint = normalizeRuntimeV2Checkpoint(state.runtimeV2Checkpoints?.[request.turnId]);
  const aggregate = checkpoint?.aggregate;
  const blocker = aggregate?.run?.blocker;
  const validated = blocker?.questionnaire && input.choice !== "stop" ? validateUserChoiceAnswer(blocker.questionnaire, input.answer, blocker.requestId) : null;
  if (validated && !validated.ok) return false;
  const answer = validated?.ok ? validated.answer : undefined;
  const reply = blocker?.questionnaire && answer ? renderUserChoiceAnswer(blocker.questionnaire, answer)
    : blocker?.clarification && input.choice !== "stop" ? input.choice.trim() : undefined;
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
      requestId: blocker.requestId, choice: choice as "recheck" | "continue" | "stop", ...(reply ? { reply } : {}), ...(answer ? { answer } : {}) } });
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
