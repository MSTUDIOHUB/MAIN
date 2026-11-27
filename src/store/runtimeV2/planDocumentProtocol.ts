import type { ToolDefinition } from "../../lib/toolSchemas";
import type { AgentMessage } from "../../lib/agentMessages";
import { buildRuntimeLanguageDirective } from "../../lib/languageContract";
import { renderKnowledgeContextAnchor } from "../../lib/knowledgeReferences";
import { renderProjectBaselineContext } from "../../lib/workspaceAdmission";
import { buildSubagentDelegationGuidance } from "../../lib/turnIntake";
import { planModelToolCandidates } from "./planModelProtocol";
import { renderPlanSkillContext } from "./planSkillContext";
import type { RuntimeV2SubmissionContext } from "./submissionContext";

import { ASK_PLAN_QUESTIONS, PLAN_CLARIFICATION_GUIDANCE, PLAN_QUESTION_TOOL } from "./planQuestionTool";
export { ASK_PLAN_QUESTIONS };
export const SUBMIT_PLAN_DOCUMENT = "submit_plan_document";
const submit: ToolDefinition = { type: "function", function: { name: SUBMIT_PLAN_DOCUMENT,
  description: "Save the confirmed plan or AGENTS.md draft as a real versioned Session document. This does not approve implementation or publish AGENTS.md.",
  parameters: { type: "object", properties: { title: { type: "string" }, markdown: { type: "string" } }, required: ["title", "markdown"] } } };

export function planDocumentTools(context: RuntimeV2SubmissionContext): ToolDefinition[] {
  return [...planModelToolCandidates(context), PLAN_QUESTION_TOOL, submit];
}

export function planDocumentMessages(context: RuntimeV2SubmissionContext, objective: string): AgentMessage[] {
  const rules = context.planPurpose === "rules";
  const grillMode = context.planInterviewMode === "grill";
  const interviewOptional = !rules && !grillMode && !context.planPurpose;
  const collaborationRequirement = context.turnInputContextSignals?.subagentRequirement;
  const collaborationGuidance = buildSubagentDelegationGuidance({
    preference: collaborationRequirement === "required" ? "allowed" : context.turnInputContextSignals?.subagentPreference ?? "unspecified",
    requirement: collaborationRequirement,
    language: context.phaseLanguage,
    scope: "read_only",
  });
  return [{ role: "system", content: [
    grillMode ? "[MAIN /GRILL-ME INTERVIEW]" : "[MAIN PLAN DOCUMENT INTERVIEW]",
    `Respond in ${context.phaseLanguage === "zh" ? "简体中文" : "English"}.`,
    buildRuntimeLanguageDirective(context.phaseLanguage),
    rules ? "Investigate the current project and existing root AGENTS.md, ask only consequential user-owned constraints, then draft an editable AGENTS.md. Preserve existing human rules unless the user changed them. Distinguish observed facts from confirmed preferences. Do not publish AGENTS.md yourself."
      : "Investigate safely, identify consequential gaps, and form a complete useful plan document. Conceptual plans need no invented file targets, shell commands or validations.",
    grillMode
      ? "The user invoked /grill-me: first inspect any relevant project files so you do NOT ask questions that code already answers, then interview the user via ask_plan_questions on key architectural branches, scope boundaries, tradeoffs, edge cases, and verification criteria (provide concrete recommended options first) before saving the plan."
      : interviewOptional
        ? "Decide whether ask_plan_questions is needed: ask ONLY when a consequential method, scope, or deliverable tradeoff is genuinely ambiguous; if the goal is already clear, skip unnecessary questions and call submit_plan_document directly."
        : "Before the first document submission, use ask_plan_questions to confirm a meaningful method, scope, tradeoff, or deliverable decision. Avoid generic permission-to-begin questions.",
    PLAN_CLARIFICATION_GUIDANCE,
    "The saved plan must cover the goal, confirmed user choices, scope, steps, acceptance checks, and risks. MAIN appends a traceable record of the actual questionnaire answers for a plan document; do not invent confirmations or reproduce their ID JSON. For rules drafts, write only the final AGENTS.md rules, without interview transcripts.",
    "Safe reads remain available. Never guess unverified filenames from a directory name; list the directory or search first. When the plan is complete, call submit_plan_document with its actual Markdown body. Do not merely promise to save it. Never call a mutation tool during this interview.",
    context.workspaceInstructionContext ? `[LIVE WORKSPACE INSTRUCTIONS]\n${context.workspaceInstructionContext}` : "",
    collaborationGuidance,
    renderProjectBaselineContext(context.projectBaselineContext || null),
    renderKnowledgeContextAnchor(context.knowledgeContext),
    renderPlanSkillContext(context, objective),
  ].filter(Boolean).join("\n\n") }, { role: "user", content: objective }];
}
