import type { AgentMessage } from "../../lib/agentMessages";
import { normalizeUserQuestionnaire, validateUserChoiceAnswer, validateUserQuestionnaireDefinition, userQuestionnaireDefinitionFeedback,
  type UserQuestion, type UserQuestionAnswer, type UserQuestionnaire } from "../../lib/userQuestions";
import type { RuntimeV2NormalizedToolCall, RuntimeV2RunIdentity, TurnAggregateV1 } from "../../lib/runtime-v2";
import type { RuntimeV2PlanRunnerInput } from "./planRunnerTypes";
import type { PlanLedger } from "./planLedger";
import { projectRuntimeV2ExecutionBlocker } from "./executionBlocker";
import { createRuntimeV2RunnerSettlement } from "./executionRunnerIdentity";
import { pausedAgentLoopOutcome } from "../../lib/runOutcome";
import { ASK_PLAN_QUESTIONS } from "./planQuestionTool";
import { settlePlanTool } from "./planEvidencePort";
import { appendPlanToolResult } from "./planHistory";

function withPlanResultQuestion(input: RuntimeV2PlanRunnerInput, questionnaire: UserQuestionnaire): UserQuestionnaire | null {
  const zh = input.context.phaseLanguage === "zh";
  const rules = input.context.planPurpose === "rules";
  return normalizeUserQuestionnaire({ ...questionnaire, purpose: rules ? "rules_interview" : "plan_confirmation",
    questions: [...questionnaire.questions.filter(question => question.id !== "result_kind"),
      ...(!rules ? [{ id: "result_kind", prompt: zh ? "这次需要什么结果？" : "What should this turn deliver?", selectionMode: "single", required: true,
        options: [{ id: "document", label: zh ? "形成并保存计划文档" : "Save a plan document" }, ...(input.context.runWorkspace ? [{ id: "executable", label: zh ? "形成可审核的实施计划（之后另行批准执行）" : "Prepare an implementation plan for separate approval" }] : [])] }] : []),
    ] });
}

async function pausePlanQuestionnaire(input: RuntimeV2PlanRunnerInput, ledger: PlanLedger, run: RuntimeV2RunIdentity, questionnaire: UserQuestionnaire) {
  const signal = input.context.abortCtrl.signal;
  signal.throwIfAborted();
  const objective = ledger.snapshot()!.objective;
  const zh = input.context.phaseLanguage === "zh";
  questionnaire = { ...questionnaire, summary: [
    `${zh ? "本次目标" : "Goal"}: ${objective.text}`,
    ...(objective.constraints.length ? [`${zh ? "已知约束" : "Known constraints"}: ${objective.constraints.join("; ")}`] : []),
  ].join("\n") };
  await ledger.append({ type: "run.paused", run, blocker: { requestId: ledger.nextId(`plan-questionnaire-${questionnaire.revision}`), reasonCode: "user_questionnaire",
    evidenceSequence: ledger.snapshot()!.nextSequence - 1, message: questionnaire.title, options: ["recheck", "stop"], questionnaire } });
  signal.throwIfAborted();
  projectRuntimeV2ExecutionBlocker({ aggregate: ledger.snapshot()!, get: input.get, set: input.set, language: input.context.phaseLanguage });
  return createRuntimeV2RunnerSettlement(input.context, pausedAgentLoopOutcome("user_questionnaire", "action_required"));
}

function sameRun(left: RuntimeV2RunIdentity, right: RuntimeV2RunIdentity): boolean {
  return left.sessionKey === right.sessionKey && left.sessionEpoch === right.sessionEpoch &&
    left.turnId === right.turnId && left.runId === right.runId &&
    left.parentRunId === right.parentRunId && left.attemptId === right.attemptId;
}

function questionDefinitionKey({ id: _id, ...definition }: UserQuestion): string {
  // These definitions have been normalized, including the answer defaults.
  return JSON.stringify(definition);
}

function confirmedPlanAnswers(aggregate: TurnAggregateV1, run: RuntimeV2RunIdentity) {
  const questionnaires = new Map<string, UserQuestionnaire>();
  const answers = new Map<string, UserQuestionAnswer>();
  for (const event of aggregate.events) {
    if ((event.type !== "run.paused" && event.type !== "run.decision_recorded") || !sameRun(event.run, run)) continue;
    if (event.type === "run.paused") {
      const questionnaire = normalizeUserQuestionnaire(event.blocker.questionnaire);
      if (questionnaire) questionnaires.set(event.blocker.requestId, questionnaire);
      continue;
    }
    if (event.choice === "stop" || !event.answer) continue;
    const questionnaire = questionnaires.get(event.requestId);
    if (!questionnaire) continue;
    const checked = validateUserChoiceAnswer(questionnaire, event.answer, event.requestId);
    if (!checked.ok) continue;
    for (const answer of checked.answer.answers) {
      if (!answer.selectedValues.length && !answer.text) continue;
      const question = questionnaire.questions.find(item => item.id === answer.questionId)!;
      answers.set(questionDefinitionKey(question), answer);
    }
  }
  return answers;
}

/** Both Plan runners admit questions here, after provider normalization. */
export async function handlePlanQuestionTool(input: {
  runner: RuntimeV2PlanRunnerInput;
  ledger: PlanLedger;
  run: RuntimeV2RunIdentity;
  call: RuntimeV2NormalizedToolCall;
  messages: AgentMessage[];
  includeResultChoice?: boolean;
  receiptAlreadySettled?: boolean;
  joinChildren: () => Promise<boolean>;
}) {
  const { runner, ledger, run, call, messages } = input;
  const signal = runner.context.abortCtrl.signal;
  const respond = async (status: "succeeded" | "blocked" | "failed", content: string) => {
    signal.throwIfAborted();
    if (input.receiptAlreadySettled) {
      // An older checkpoint may have acknowledged the call before admission.
      // Keep its receipt and update only the feedback in this request view.
      if (status !== "succeeded") appendPlanToolResult(messages, call.id, content);
      return;
    }
    await settlePlanTool({ ledger, run, call, status, modelContent: content,
      ...(status === "failed" ? { failureKind: "protocol_invalid" as const } : {}) });
    appendPlanToolResult(messages, call.id, content);
  };
  const aggregate = ledger.snapshot()!;
  const revision = aggregate.events.filter(event => event.type === "run.paused" && event.blocker.questionnaire).length + 1;
  const purpose = runner.context.planPurpose === "rules" ? "rules_interview" : "plan_interview";
  const checked = validateUserQuestionnaireDefinition({ ...call.arguments, revision, purpose });
  if (!checked.ok) {
    await respond("failed", userQuestionnaireDefinitionFeedback(checked.issue));
    return null;
  }
  const questionnaire = input.includeResultChoice && revision === 1
    ? withPlanResultQuestion(runner, checked.questionnaire) : checked.questionnaire;
  if (!questionnaire) {
    await respond("failed", userQuestionnaireDefinitionFeedback({ path: "questions", message: "Provide a specific decision owned by the user." }));
    return null;
  }

  const confirmed = confirmedPlanAnswers(aggregate, run);
  const answers = questionnaire.questions.flatMap(question => {
    const answer = confirmed.get(questionDefinitionKey(question));
    return answer ? [{ ...answer, questionId: question.id, prompt: question.prompt,
      selectedLabels: answer.selectedValues.map(id => question.options.find(option => option.id === id)!.label) }] : [];
  });
  const unresolved = questionnaire.questions.filter(question => !answers.some(answer => answer.questionId === question.id));
  if (!unresolved.length) {
    await respond("blocked", JSON.stringify({ code: "PLAN_QUESTION_ALREADY_ANSWERED", effect: "none", answers,
      instruction: "Use these confirmed answers and continue planning. Ask only about a new material decision and explain what changed." }));
    await ledger.recordSoftSignal(run, "repeated_action");
    return null;
  }
  if (!await input.joinChildren()) {
    await respond("blocked", "Planning children have not settled. Finish the pending children before asking the user.");
    return null;
  }
  await respond("succeeded", JSON.stringify({ questionRevision: revision, awaitingUserInformation: true,
    ...(answers.length ? { alreadyAnswered: answers } : {}) }));
  return pausePlanQuestionnaire(runner, ledger, run, { ...questionnaire, questions: unresolved });
}

export async function settlePlanPause(input: RuntimeV2PlanRunnerInput, ledger: PlanLedger, run: RuntimeV2RunIdentity) {
  const aggregate = ledger.snapshot()!;
  if (aggregate.run?.status !== "paused") return null;
  const blocker = aggregate.run.blocker;
  if (blocker?.decision && blocker.decision !== "stop") {
    await ledger.append({ type: "run.resumed", run, requestId: blocker.requestId });
    return null;
  }
  if (!blocker?.decision) projectRuntimeV2ExecutionBlocker({ aggregate, get: input.get, set: input.set, language: input.context.phaseLanguage });
  return createRuntimeV2RunnerSettlement(input.context, pausedAgentLoopOutcome(blocker?.reasonCode || "user_questionnaire", "action_required"));
}

export function recoverPlanQuestion(aggregate: TurnAggregateV1, run: RuntimeV2RunIdentity) {
  const events = aggregate.events.filter(event => "run" in event && sameRun(event.run, run));
  const latest = [...events].reverse();
  const response = latest.find(event => event.type === "provider.responded");
  const lastPause = latest.find(event => event.type === "run.paused");
  if (!response || response.sequence <= (lastPause?.sequence ?? -1) || response.result.toolCalls.length !== 1) return null;
  const call = response.result.toolCalls[0]!;
  if (call.name !== ASK_PLAN_QUESTIONS) return null;
  if (aggregate.pendingToolCalls.some(pending => pending.id === call.id && pending.name === call.name)) {
    return { result: response.result, settled: false };
  }
  const command = events.find(event => event.sequence > response.sequence && event.type === "command.scheduled" &&
    event.command.payload.toolCallId === call.id && event.command.payload.toolName === call.name);
  return command?.type === "command.scheduled" && events.some(event => event.sequence > command.sequence && event.type === "tool.completed" &&
    event.idempotencyKey === command.command.idempotencyKey && event.status === "succeeded")
    ? { result: response.result, settled: true } : null;
}

