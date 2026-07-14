/**
 * Model-facing orchestration uses one canonical protocol language so tool
 * names, state transitions, and recovery constraints do not change with the
 * UI locale. User-visible narration and final responses still follow the
 * configured response-language preference.
 */
export const MODEL_CONTROL_LANGUAGE = "en" as const;

export type ModelControlLanguage = typeof MODEL_CONTROL_LANGUAGE;
