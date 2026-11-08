import {
  renderExplicitSkillActivationContext,
  renderSkillCatalogContext,
  skillCatalogContextCharBudget,
} from "../../lib/agentSkills";
import type { RuntimeV2SubmissionContext } from "./submissionContext";

export const PLAN_VALIDATION_SKILL_GUIDANCE = [
  "Before choosing an implementation or acceptance method, consult an admitted Skill when its metadata matches the task. Reuse any Skill receipt already in the conversation.",
  "Read only the relevant section or linked validation reference with load_skill. Use resource for a reference relative to the Skill and use its returned readTarget for continuations. A small max_chars gives a useful index for a long Skill.",
  "Check prerequisites against observed workspace facts. Use the Skill's documented commands as planned validation steps to run after approval. During Plan, use tool_search only for read-only facts, not to look for shell or editor execution. Specify what behavior the check observes and what proves it passed.",
].join(" ");

export function renderPlanSkillContext(context: RuntimeV2SubmissionContext, objective: string): string {
  const budget = skillCatalogContextCharBudget(context.runtimeContextBudget?.contextLimit);
  const catalog = renderSkillCatalogContext(context.skillCatalog, budget, objective);
  if (!catalog) return "";
  return [
    catalog,
    PLAN_VALIDATION_SKILL_GUIDANCE,
    renderExplicitSkillActivationContext(context.skillCatalog, { maxChars: budget }),
  ].filter(Boolean).join("\n\n");
}
