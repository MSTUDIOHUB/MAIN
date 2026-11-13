import type { TurnAggregateV1 } from "./runtime-v2/aggregate";
import type { RuntimeV2RunIdentity } from "./runtime-v2/contracts";
import { normalizeUserQuestionnaire, validateUserChoiceAnswer, type UserQuestionnaire } from "./userQuestions";

export interface UserQuestionHistoryItem {
  readonly id: string;
  readonly prompt: string;
  readonly selectedLabels: readonly string[];
  readonly text?: string;
}

export interface UserQuestionHistoryEntry {
  readonly requestId: string;
  readonly runId: string;
  readonly title: string;
  readonly revision: number;
  readonly questions: readonly UserQuestionHistoryItem[];
}

function requestKey(run: RuntimeV2RunIdentity, requestId: string): string {
  return JSON.stringify([run.sessionKey, run.sessionEpoch, run.turnId, run.runId, run.parentRunId, run.attemptId, requestId]);
}

/** Read-only presentation of committed user answers from the canonical ledger.
 * Pair each decision with its preceding question and exact Run owner. */
export function buildUserQuestionHistory(aggregate: TurnAggregateV1 | null | undefined): readonly UserQuestionHistoryEntry[] {
  if (!aggregate) return [];
  const questions = new Map<string, UserQuestionnaire>();
  const displayed = new Set<string>();
  const entries: UserQuestionHistoryEntry[] = [];
  for (const event of aggregate.events) {
    if (event.type !== "run.paused" && event.type !== "run.decision_recorded") continue;
    if (event.run.sessionKey !== aggregate.turn.sessionKey || event.run.sessionEpoch !== aggregate.turn.sessionEpoch || event.run.turnId !== aggregate.turn.turnId) continue;
    if (event.type === "run.paused") {
      const spec = normalizeUserQuestionnaire(event.blocker.questionnaire);
      if (spec) questions.set(requestKey(event.run, event.blocker.requestId), spec);
      continue;
    }
    if (event.choice === "stop" || !event.answer) continue;
    const key = requestKey(event.run, event.requestId);
    const spec = questions.get(key);
    if (!spec) continue;
    const checked = validateUserChoiceAnswer(spec, event.answer, event.requestId);
    const displayKey = `${key}:${spec.revision}`;
    if (!checked.ok || displayed.has(displayKey)) continue;
    displayed.add(displayKey);
    entries.push({ requestId: event.requestId, runId: event.run.runId, title: spec.title, revision: spec.revision,
      questions: checked.answer.answers.map(answer => {
        const question = spec.questions.find(item => item.id === answer.questionId)!;
        return { id: question.id, prompt: question.prompt,
          selectedLabels: answer.selectedValues.map(id => question.options.find(option => option.id === id)!.label),
          ...(answer.text ? { text: answer.text } : {}) };
      }),
    });
  }
  return entries;
}
