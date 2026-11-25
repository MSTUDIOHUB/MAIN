export interface GrillMeCommand {
  readonly kind: "grill_me";
  readonly command: string;
  readonly request?: string;
}

const GRILL_ME_PREFIX_PATTERN = /^\/(grill-me|grill|追问|深度追问|访谈)(?=$|\s)([\s\S]*)$/i;
const NEGATED_QUESTION_PATTERN = /(?:不要问我|不要提问|无需提问|不用提问|不用问我|别问我|直接给方案|don't ask|do not ask|no questions)/i;
const EXPLICIT_INTERVIEW_PATTERN = /(?:先问我|向我提问|先向我提问|请先提问|有问题请?先问|有不清楚.*问|不确定.*(?:问我|提问)|先提问再|必须.*提问|ask me questions|interview me|grill[\s-]me)/i;

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
