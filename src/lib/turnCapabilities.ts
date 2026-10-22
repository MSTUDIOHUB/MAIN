/** Task requirements describe capability needs; restrictions only narrow
 * existing tool authority. Neither list grants approval or a path lease. */
export const TURN_CAPABILITIES = [
  "workspace_read",
  "workspace_write",
  "command",
  "external_interaction",
  "network",
] as const;

export type TurnCapability = typeof TURN_CAPABILITIES[number];
export type SemanticCapability = TurnCapability;

export function normalizeTurnCapabilityRestrictions(value: unknown): TurnCapability[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) =>
    typeof entry !== "string" ||
    !(TURN_CAPABILITIES as readonly string[]).includes(entry)
  )) {
    throw new Error("TURN_CAPABILITY_RESTRICTIONS_INVALID");
  }
  return [...new Set(value)] as TurnCapability[];
}
