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
  return normalizeCapabilityList(value, "TURN_CAPABILITY_RESTRICTIONS_INVALID");
}

/** Current-request manual review requirements only narrow existing authority.
 * A missing field is accepted solely for trusted legacy admissions/replay. */
export function normalizeTurnApprovalCapabilities(value: unknown): TurnCapability[] {
  return normalizeCapabilityList(value, "TURN_APPROVAL_CAPABILITIES_INVALID");
}

function normalizeCapabilityList(value: unknown, errorCode: string): TurnCapability[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) =>
    typeof entry !== "string" ||
    !(TURN_CAPABILITIES as readonly string[]).includes(entry)
  )) {
    throw new Error(errorCode);
  }
  return [...new Set(value)] as TurnCapability[];
}
