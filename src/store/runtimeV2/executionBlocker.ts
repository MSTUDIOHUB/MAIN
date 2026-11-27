import { parseSessionRuntimeKey } from "../../lib/sessionTypes";
import type { TurnAggregateV1 } from "../../lib/runtime-v2";
import { appendRuntimeV2Checkpoint, normalizeRuntimeV2Checkpoint } from "../../lib/runtime-v2/checkpoint";
import type { UserChoiceActionRequest, UserChoiceResolutionIdentity } from "../../lib/actionRequest";
import { isExactUserChoiceResolutionIdentity } from "../../lib/actionRequest";
import { renderUserChoiceAnswer, validateUserChoiceAnswer, type UserChoiceAnswer } from "../../lib/userQuestions";
import { deriveRuntimeV2ExecutionContract, scheduledCommandsByKey } from "../../lib/runtime-v2/executionContract";
import { runtimeV2DirectExecuteContractCoverage } from "../../lib/runtime-v2/phaseTransition";
import { deriveRuntimeV2PlanExecutionCoverage } from "../../lib/runtime-v2/planExecution";
import { deriveRuntimeV2TerminalAcceptanceFacts } from "../../lib/runtime-v2/terminalFacts";
import { runtimeV2UnityPlayModeUnavailable } from "../../lib/runtime-v2/unityPlayMode";

const REPORT_PENDING_VALIDATION = "report_pending_validation";
const REPORT_PENDING_EDITOR_VERIFICATION = "report_pending_editor_verification";

function isVerificationBlocker(aggregate: TurnAggregateV1): boolean {
  const blocker = aggregate.run?.blocker;
  return blocker?.reasonCode === "unity_editor_verification_pending" ||
    (blocker?.reasonCode === "recovery_stalled" && aggregate.phase === "validating");
}

export function executionRecoveryOptions(aggregate: TurnAggregateV1) {
  const canRetainChanges = aggregate.phase === "validating" &&
    deriveRuntimeV2TerminalAcceptanceFacts(aggregate).deliveredFiles.length > 0;
  return canRetainChanges
    ? { options: ["recheck", "continue", "stop"] as const, independentWork: [REPORT_PENDING_VALIDATION] }
    : { options: ["recheck", "stop"] as const };
}

function pendingAcceptanceCriteria(aggregate: TurnAggregateV1): readonly string[] {
  const plan = aggregate.sealedWorkPlan?.draft;
  const planCoverage = plan && deriveRuntimeV2PlanExecutionCoverage(aggregate);
  if (plan && planCoverage) return planCoverage.missingRequiredValidationIndexes
    .map((index) => plan.validations[index]?.expectedOutcome || "");
  const contract = deriveRuntimeV2ExecutionContract(aggregate);
  if (contract) return runtimeV2DirectExecuteContractCoverage(aggregate).missingValidationIndexes
    .map((index) => contract.validations[index]?.expectedOutcome || "");
  return aggregate.objective.acceptanceCriteria;
}

function describePendingVerification(aggregate: TurnAggregateV1, language: "zh" | "en") {
  const zh = language === "zh";
  const facts = deriveRuntimeV2TerminalAcceptanceFacts(aggregate);
  const { deliveredFiles, automatedValidations, unityChecks, missingTargets } = facts;
  const passedChecks = [
    ...unityChecks.filter((check) => check.status === "passed").map((check) => check.kind === "csharp"
      ? (zh ? "Unity C# 编译通过" : "Unity C# compilation passed")
      : (zh ? "Unity Shader 导入通过" : "Unity shader import passed")),
    automatedValidations.currentPassedCount > 0 && (zh
      ? `最新修改后 ${automatedValidations.currentPassedCount} 次自动检查通过`
      : `${automatedValidations.currentPassedCount} automated check(s) passed after the latest change`),
  ].filter(Boolean);
  const verified = [
    deliveredFiles.length > 0 && (zh ? `已保存 ${deliveredFiles.length} 个文件的修改` : `Changes saved in ${deliveredFiles.length} file(s)`),
    ...(passedChecks.length > 0 ? passedChecks : [zh ? "本轮尚无通过的验证记录" : "This turn has no recorded passing checks yet"]),
  ].filter(Boolean).join(zh ? "。" : ". ");
  const commands = scheduledCommandsByKey(aggregate);
  const capture = [...aggregate.events].reverse().find((event) => event.sequence > facts.latestMutationSequence &&
    event.type === "tool.completed" && event.run.runId === aggregate.run?.identity.runId &&
    commands.get(event.idempotencyKey)?.payload.toolName === "capture_unity_game_view");
  const criteria = [...new Set(pendingAcceptanceCriteria(aggregate).flatMap((text) => {
    const listed = [...text.matchAll(/^\s*(?:[-*•]\s+|\d{1,2}[.)、]\s*)([^\r\n]+)/gm)].map((item) => item[1]!);
    return (listed.length > 0 ? listed : [text]).map((item) => item.replace(/\s+/g, " ").trim()).filter(Boolean);
  }))].slice(0, 2).map((text) => text.length <= 140 ? text : `${text.slice(0, 139)}…`);
  const separator = zh ? "。" : ". ";
  const pending = [
    ...unityChecks.flatMap((check) => {
      const checkName = check.kind === "csharp" ? (zh ? "Unity C# 编译" : "Unity C# compilation") : (zh ? "Unity Shader 导入" : "Unity shader import");
      if (check.status === "failed") return [zh ? `${checkName}仍有错误` : `${checkName} still has errors`];
      if (check.status === "project_fragment") return [zh ? `${checkName}需要完整的 Unity 项目` : `${checkName} requires the complete Unity project`];
      return ["pending", "unavailable", "deferred_closed"].includes(check.status)
        ? [zh ? `仍需取得${checkName}结果` : `${checkName} result is pending`] : [];
    }),
    runtimeV2UnityPlayModeUnavailable(aggregate) && (zh ? "仍需取得 Unity Play Mode 测试结果" : "Unity Play Mode test results are pending"),
    missingTargets.length > 0 && (zh ? `还有 ${missingTargets.length} 个计划目标待交付` : `${missingTargets.length} planned target(s) are awaiting delivery`),
    automatedValidations.missingRequiredCount > 0 && (zh
      ? `还有 ${automatedValidations.missingRequiredCount} 项必选验收待通过`
      : `${automatedValidations.missingRequiredCount} required acceptance check(s) are pending`),
    automatedValidations.currentFailedCount > 0 && (zh
      ? `最新修改后 ${automatedValidations.currentFailedCount} 次自动检查未通过`
      : `${automatedValidations.currentFailedCount} automated check(s) failed after the latest change`),
    capture?.type === "tool.completed" && (capture.status === "succeeded"
      ? (zh ? "已取得 Game View 截图，画面仍待验收" : "Game View captured, with visual acceptance still pending")
      : (zh ? "仍需取得可供核验的 Game View 截图" : "A usable Game View screenshot is pending")),
  ].filter(Boolean).join(separator);
  const pendingSummary = pending ? `${pending}${zh ? "。" : "."}` : (zh ? "当前修改仍缺与任务目标对应的自动验收结果。" : "The current changes still need an automated result that covers the task goal.");
  const scene = criteria.map((criterion) => zh ? `「${criterion}」` : `“${criterion}”`).join(zh ? "、" : ", ");
  return {
    verified: `${verified}${zh ? "。" : "."}`,
    pending: `${pendingSummary}${scene ? (zh ? `请按实际场景核对${scene}。` : ` Check ${scene} in the actual scenario.`) : ""}`,
  };
}

export function finishPendingExecutionVerification(aggregate: TurnAggregateV1, language: "zh" | "en") {
  const blocker = aggregate.run?.blocker;
  if (blocker?.decision !== "continue" || !isVerificationBlocker(aggregate) ||
      !blocker.independentWork?.some((work) => work === REPORT_PENDING_VALIDATION || work === REPORT_PENDING_EDITOR_VERIFICATION)) return;
  const { pending } = describePendingVerification(aggregate, language);
  const retained = deriveRuntimeV2TerminalAcceptanceFacts(aggregate).deliveredFiles.length > 0;
  const resultReason = language === "zh"
    ? `${retained ? "已保留修改并结束本轮。" : "已结束本轮。"}${pending}`
    : `${retained ? "This turn ended with changes retained." : "This turn ended."} ${pending}`;
  return { resultKind: retained ? "partial" as const : "blocked" as const, resultReason };
}

export function createRuntimeV2ExecutionBlockerView(aggregate: TurnAggregateV1, language: "zh" | "en", taskId: number) {
  const blocker = aggregate.run?.blocker;
  if (aggregate.run?.status !== "paused" || !blocker) return null;
  const saveFailed = blocker.reasonCode === "document_save_failed";
  const editorPending = blocker.reasonCode === "unity_editor_verification_pending";
  const zh = language === "zh";
  const verificationPending = isVerificationBlocker(aggregate);
  const title = (editorPending ? (zh ? "等待 Unity 验收" : "Unity verification pending") : verificationPending
    ? (zh ? "自动验收尚未完成" : "Automated verification pending")
    : saveFailed ? (zh ? "计划文档保存失败" : "Plan document save failed") : blocker.questionnaire?.title) || (zh ? "执行需要你的选择" : "Execution needs your input");
  const labels = zh ? { recheck: "我已处理，重新检查", continue: "继续其他可行工作", stop: "停止任务" } : { recheck: "Recheck after my changes", continue: "Continue independent work", stop: "Stop task" };
  if (saveFailed) labels.recheck = language === "zh" ? "重新保存文档" : "Retry document save";
  if (verificationPending) {
    labels.recheck = editorPending ? (zh ? "重新检查 Unity Editor" : "Recheck Unity Editor") : (zh ? "重新验收" : "Retry verification");
    labels.continue = zh ? "保留修改并结束" : "Finish and retain changes";
    if (blocker.options.includes("continue")) labels.stop = zh ? "取消本轮" : "Cancel this turn";
  }
  const verification = verificationPending ? (() => {
    const { verified, pending } = describePendingVerification(aggregate, language);
    const finish = blocker.options.includes("continue") ? labels.continue : labels.stop;
    return { verified, pending, next: zh
      ? `如果已手动确认结果，或打算稍后再验证，选“${finish}”。验证条件已就绪时，选“${labels.recheck}”。`
      : `Choose “${finish}” if you have checked the result manually or want to check it later. Choose “${labels.recheck}” when the checks can run.` };
  })() : null;
  const options = blocker.questionnaire ? [] : blocker.clarification ? [...(blocker.clarification.choices || []).map(value => ({ label: value, value })), { label: labels.stop, value: "stop" }]
    : blocker.options.map(value => ({ label: labels[value], value }));
  const request: UserChoiceActionRequest = { schemaVersion: 1, kind: "user_choice", requestId: blocker.requestId,
    sessionKey: aggregate.turn.sessionKey, turnId: aggregate.turn.turnId, runId: aggregate.run.identity.runId,
    parentRunId: aggregate.run.identity.parentRunId, title, status: "pending", createdAt: aggregate.updatedAt,
    optionValues: options.map(option => option.value), allowCustomReply: !!blocker.clarification,
    ...(verification ? { verification } : {}),
    ...(blocker.questionnaire ? { questionnaire: blocker.questionnaire } : {}), executionBlocker: { sessionEpoch: aggregate.turn.sessionEpoch } };
  const messageText = String(blocker.message || "").trim();
  const content = verification ? [title, verification.verified, verification.pending, verification.next].join("\n\n")
    : messageText && messageText !== title ? `${title}\n\n${messageText}` : title;
  const block = { id: taskId, type: "agent" as const, visibility: "assistant_update" as const, turnId: request.turnId,
    content, options, choiceRequest: request };
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
  identity: UserChoiceResolutionIdentity; choice: string; source?: "editor_reconnected"; sessionEpoch: string; answer?: UserChoiceAnswer;
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
      requestId: blocker.requestId, choice: choice as "recheck" | "continue" | "stop", ...(input.source ? { source: input.source } : {}), ...(reply ? { reply } : {}), ...(answer ? { answer } : {}) } });
  if (appended.disposition !== "committed" || !appended.checkpoint || !current()) return false;
  const markResolvedChoiceBlock = (blocks: any[]) => blocks.map((item: any) =>
    item?.choiceRequest?.requestId === request.requestId
      ? { ...item, choiceRequest: { ...item.choiceRequest, status: choice === "stop" ? "cancelled" : "resolved" } }
      : item
  );
  const projected = { ...state, taskFlow: markResolvedChoiceBlock(state.taskFlow || []), runtimeV2Checkpoints: { ...state.runtimeV2Checkpoints, [request.turnId]: appended.checkpoint } };
  const persisted: any = await input.persist(projected, current);
  if (!current()) return false;
  const ownerSessionId =
    parseSessionRuntimeKey(aggregate.turn.sessionKey)?.sessionId ?? state.currentSessionId;
  input.set((latest: any) => ({
    taskFlow: markResolvedChoiceBlock(latest.taskFlow || []),
    runtimeV2Checkpoints: { ...latest.runtimeV2Checkpoints, [request.turnId]: appended.checkpoint },
    ...(persisted?.sessionsByWorkspace ? { sessionsByWorkspace: Object.fromEntries(Object.entries(latest.sessionsByWorkspace || {}).map(([scope, records]) => [scope,
      (records as any[]).map(record => scope === aggregate.turn.workspaceKey && record.id === ownerSessionId ?
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
