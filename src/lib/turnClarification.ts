/** Semantic input gaps are proposals, never permission or execution consent. */
export interface TurnClarification {
  readonly kind: "target_ambiguity" | "missing_input" | "constraint_conflict";
  readonly field: string;
  readonly evidence: string;
  readonly question: string;
  readonly choices?: readonly string[];
}

export function normalizeTurnClarification(raw: unknown, currentInput: string): TurnClarification | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  // Capability conflicts are constructed by admission, not asserted by a model.
  if (value.kind !== "target_ambiguity" && value.kind !== "missing_input") return null;
  const field = typeof value.field === "string" ? value.field.trim() : "";
  const evidence = typeof value.evidence === "string" ? value.evidence.trim() : "";
  const question = typeof value.question === "string" ? value.question.trim() : "";
  if (!field || !evidence || !question || !currentInput.includes(evidence)) return null;
  const choices = Array.isArray(value.choices) && value.choices.every(choice => typeof choice === "string" && choice.trim())
    ? [...new Set(value.choices.map(choice => (choice as string).trim()))] : [];
  if (value.kind === "target_ambiguity" && (choices.length < 2 || choices.some(choice => !evidence.includes(choice)))) return null;
  return { kind: value.kind, field, evidence, question, ...(choices.length ? { choices } : {}) };
}
