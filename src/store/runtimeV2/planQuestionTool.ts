import type { ToolDefinition } from "../../lib/toolSchemas";
import type { RuntimeV2NormalizedProviderResult, TurnAggregateV1 } from "../../lib/runtime-v2";

export const ASK_PLAN_QUESTIONS = "ask_plan_questions";
export const PLAN_CLARIFICATION_GUIDANCE = "Keep clarifying throughout planning, including after earlier answers, during synthesis, and when revising a draft. If a new decision owned by the user would materially change the scope, method, or acceptance checks, use ask_plan_questions with the specific question and why the answer matters. Resolve facts you can discover with safe reads. Treat explicit requirements in the original request and confirmed answers as resolved decisions. Continue directly when there is no unresolved user decision. Answers never approve execution.";

export function hasExecutablePlanChoice(aggregate: TurnAggregateV1): boolean {
  if (aggregate.events.some(event => event.type === "turn.admitted" && !!event.sourcePlanDraft)) return true;
  const confirmation = aggregate.events.find(event => event.type === "run.paused" && event.blocker.questionnaire?.purpose === "plan_confirmation");
  return confirmation?.type === "run.paused" && aggregate.events.some(event =>
    event.type === "run.decision_recorded" && event.requestId === confirmation.blocker.requestId && event.choice !== "stop" &&
    event.answer?.answers.some(answer => answer.questionId === "result_kind" && answer.selectedValues.includes("executable")));
}

export function admittedPlanQuestionPurpose(aggregate: TurnAggregateV1 | null | undefined): "plan" | "rules" | undefined {
  if (aggregate?.planPurpose) return aggregate.planPurpose;
  if (aggregate?.events?.some(event =>
    (event.type === "turn.admitted" && event.sourcePlanDraft) ||
    (event.type === "run.paused" && event.blocker.questionnaire?.purpose === "plan_confirmation")
  )) return "plan";
  return undefined;
}

/** A schema-only WorkPlan response can state blocking questions explicitly.
 * Give the same questionnaire runner that intent without inventing options. */
export function adaptPlanBlockingQuestions(
  calls: RuntimeV2NormalizedProviderResult["toolCalls"],
  workPlanToolName: string,
  language: "zh" | "en",
): RuntimeV2NormalizedProviderResult["toolCalls"] {
  const call = calls.length === 1 ? calls[0] : undefined;
  if (call?.name !== workPlanToolName) return calls;
  const questions = call.arguments.questions;
  if (!Array.isArray(questions) || !questions.length || questions.some(question => typeof question !== "string" || !question.trim())) return calls;
  const prompts = [...new Set(questions.map((question: string) => question.trim()))];
  return [{ ...call, name: ASK_PLAN_QUESTIONS, arguments: {
    title: language === "zh" ? "继续计划前需要确认" : "Decisions needed to continue the plan",
    questions: prompts.map((prompt, index) => ({ id: `decision-${index + 1}`, prompt, selectionMode: "text", options: [], required: true })),
  } }];
}

export const PLAN_QUESTION_TOOL: ToolDefinition = {
  type: "function",
  function: {
    name: ASK_PLAN_QUESTIONS,
    description: "Pause for a consequential user decision at any Plan stage, including after earlier answers. Ask about the decision and why it matters. Always include options: single/multiple need at least one explicit {id,label}; text uses []. Answers provide information, never execution approval.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short title for this interview round." },
        questions: {
          type: "array", minItems: 1,
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "Stable nonempty question ID, unique within this questionnaire." },
              prompt: { type: "string", description: "The complete user-facing question about a real method, scope or constraint decision." },
              selectionMode: { type: "string", enum: ["single", "multiple", "text"], description: "single selects at most one provided option; multiple can select several; text accepts free text and uses options:[]." },
              options: {
                type: "array",
                description: "Always provide this array. single and multiple require at least one explicit option with a stable unique id and a user-facing label. text requires an empty array []. Never omit options or invent the user's answer.",
                items: { type: "object", properties: {
                  id: { type: "string", description: "Stable nonempty option ID unique within this question." },
                  label: { type: "string", description: "Nonempty user-facing choice label." },
                  description: { type: "string" },
                }, required: ["id", "label"] },
              },
              required: { type: "boolean", description: "When true, require a nonempty answer. Selection questions also enforce minSelections; for optional text instead of a selection, use allowText:true and minSelections:0. False or omitted makes this question optional, but the whole questionnaire still requires one actual answer." },
              allowText: { type: "boolean", description: "Allow additional free text. This does not remove minSelections or create choices. text mode always accepts free text." },
              minSelections: { type: "integer", description: "Minimum selected options. Defaults to 1 for required single/multiple questions, otherwise 0; must not exceed maxSelections or option count. text uses 0." },
              maxSelections: { type: "integer", description: "Maximum selected options: single at most 1, multiple at most option count, text 0. Must be at least minSelections." },
            },
            required: ["id", "prompt", "selectionMode", "options"],
          },
        },
      },
      required: ["title", "questions"],
    },
  },
};
