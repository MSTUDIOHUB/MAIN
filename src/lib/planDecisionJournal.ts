import type { TurnAggregateV1 } from "./runtime-v2/aggregate";
import { validateUserChoiceAnswer } from "./userQuestions";

/** Complete user-owned decisions projected from the canonical ledger. This
 * is neither assumptions nor execution approval, and has no model/store copy. */
export function buildPlanDecisionJournal(aggregate: TurnAggregateV1 | null | undefined): string | undefined {
  if (!aggregate) return undefined;
  const sections: string[] = [];
  // This observation is authored by the runtime after validating the source
  // draft's exact receipt; model prose never supplies confirmed decisions.
  const inherited = aggregate.events.find(event => event.type === "observation.recorded" && event.evidence.id === "plan-draft-source");
  let inheritedJournal: string | undefined;
  if (inherited?.type === "observation.recorded" && inherited.modelContent) {
    try {
      const journal = JSON.parse(inherited.modelContent).sourcePlanDraftContext?.confirmedChoices;
      if (typeof journal === "string" && journal.trim()) inheritedJournal = journal;
    } catch { /* A malformed historical observation cannot invent choices. */ }
  }
  for (const event of aggregate.events) {
    if (event.type !== "run.decision_recorded" || event.choice === "stop" || !event.answer) continue;
    const question = aggregate.events.find(candidate => candidate.type === "run.paused" && candidate.blocker.requestId === event.requestId);
    if (question?.type !== "run.paused" || !question.blocker.questionnaire) continue;
    const spec = question.blocker.questionnaire;
    const answer = validateUserChoiceAnswer(spec, event.answer, event.requestId);
    if (!answer.ok) continue;
    sections.push(`### ${spec.title}`, `确认记录 / Confirmation: ${event.requestId} · revision ${spec.revision}`, "");
    for (const item of answer.answer.answers) {
      const definition = spec.questions.find(question => question.id === item.questionId)!;
      const values = item.selectedValues.map(id => definition.options.find(option => option.id === id)!.label);
      sections.push(`**${definition.prompt}**`);
      for (const value of [...values, ...(item.text ? [item.text] : [])]) sections.push(`> ${value.replace(/\n/g, "\n> ")}`);
      if (!values.length && !item.text) sections.push("> 未补充 / No additional answer");
      sections.push("");
    }
  }
  const current = sections.length ? ["## 用户选择 / Confirmed choices", "", ...sections].join("\n") : undefined;
  return [inheritedJournal, current].filter(Boolean).join("\n\n") || undefined;
}

export function appendPlanDecisionJournal(markdown: string, journal?: string): string {
  return journal === undefined ? markdown : `${markdown}\n\n${journal}`;
}
