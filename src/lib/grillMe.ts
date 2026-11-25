export interface GrillMeCommand {
  readonly kind: "grill_me";
  readonly command: string;
  readonly request?: string;
}

const GRILL_ME_PREFIX_PATTERN = /^\/(grill-me|grill|追问|深度追问|访谈)(?=$|\s)([\s\S]*)$/i;
const NEGATED_QUESTION_PATTERN = /(?:不要(?:问我|提问|询问)|不要?询问|无需(?:提问|询问)|不用(?:提问|询问|问我)|别(?:问我|询问)|直接给方案|don't ask|do not ask|no questions)/i;
const EXPLICIT_INTERVIEW_PATTERN = /(?:先(?:向我|找我)?(?:提问|询问|发问|确认.{0,6}问题)|(?:向我|对我|找我)(?:提问|询问|发问)|(?:询问|提问|问)我.{0,14}(?:问题|细节|需求|偏好|取舍)|(?:请先|必须先?|务必先?)(?:向我)?(?:提问|询问|问清楚)|(?:有|遇到)(?:任何|什么)?(?:疑问|问题|不确定|不清楚|歧义).{0,12}(?:提问|询问|问我|向我确认)|\b(?:ask\s+me\s+(?:[\w-]+\s+){0,4}questions|interview\s+me|grill[\s-]me|clarify\s+with\s+me\s+first)\b)/i;

/**
 * Parse an explicit `/grill-me` (or `/追问` / `/深度追问` / `/访谈`) command prefix.
 * Unlike ordinary `/plan`, `/grill-me` commits the Planner to conducting a
 * high-signal design-alignment interview before finalizing a plan or document.
 */
export function parseGrillMeCommand(input: string): GrillMeCommand | null {
  const trimmed = String(input || "").trimStart();
  const match = trimmed.match(GRILL_ME_PREFIX_PATTERN);
  if (!match) return null;
  const command = `/${match[1].toLowerCase()}`;
  const request = String(match[2] || "").trim();
  return request
    ? { kind: "grill_me", command, request }
    : { kind: "grill_me", command };
}

/**
 * Detect when the user's natural-language request explicitly asks the agent
 * to ask questions / interview them before finalizing a plan.
 */
export function requestsExplicitPlanInterview(input: string): boolean {
  const text = String(input || "").trim();
  if (!text || NEGATED_QUESTION_PATTERN.test(text)) return false;
  return parseGrillMeCommand(text) !== null || EXPLICIT_INTERVIEW_PATTERN.test(text);
}
