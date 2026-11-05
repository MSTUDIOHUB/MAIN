export type ExternalSkillSource = "codex" | "claude" | "gemini" | "custom";
export type ExternalSkillSources = Record<ExternalSkillSource, boolean>;

/** Existing installations keep discovery available until a source is disabled.
 * The source switch is independent of each Skill's explicit admission record. */
export function normalizeExternalSkillSources(value: unknown): ExternalSkillSources {
  const result: ExternalSkillSources = { codex: true, claude: true, gemini: true, custom: true };
  if (!value || typeof value !== "object" || Array.isArray(value)) return result;
  const record = value as Record<string, unknown>;
  for (const source of Object.keys(result) as ExternalSkillSource[]) {
    if (typeof record[source] === "boolean") result[source] = record[source];
  }
  return result;
}

/** Native discovery reports known sources. A legacy/unrecognized origin is
 * governed by Custom rather than inheriting another platform's toggle. */
export function isExternalSkillSourceEnabled(input: unknown, source: unknown): boolean {
  const key: ExternalSkillSource = source === "codex" || source === "claude" || source === "gemini"
    ? source : "custom";
  return normalizeExternalSkillSources(input)[key];
}
