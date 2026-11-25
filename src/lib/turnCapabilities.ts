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

const EXPLICIT_FORBIDDEN_WORKSPACE_READ_PATTERNS = [
  /(?:不要|禁止|不准|切勿|不得|不可|别|勿)(?:读取|查看|扫描|访问|检索|读)(?:任何|一切|当前)?(?:工作区|项目|本地|代码|源码)?(?:文件|源码|目录)/i,
  /\b(?:do\s+not|don'?t|never|forbid(?:den)?)\s+(?:read|inspect|scan|access)\s+(?:any\s+)?(?:workspace|project|local|repo|repository)?\s*(?:files?|source|code|directories)\b/i,
];

const EXPLICIT_APPROVAL_WORKSPACE_READ_PATTERNS = [
  /(?:每次|每当|在)?(?:读取|查看|访问|读)(?:任何|工作区|项目|本地|代码)?(?:文件|源码|目录)(?:之)?前(?:都|先)?(?:必须|请|先)?(?:问我|询问我|向我确认|征求(?:我)?(?:同意|确认|批准)|需要(?:我)?(?:批准|确认))/i,
  /\b(?:ask|confirm\s+with)\s+me\s+before\s+(?:every\s+|each\s+|any\s+)?(?:reading|inspecting|accessing)\s+(?:any\s+)?(?:workspace|project|local)?\s*(?:files?|source|directories)\b/i,
];

/**
 * Deterministic safety net for explicit user-authored workspace-read restrictions
 * or per-read approval demands, complementing semantic preflight.
 */
export function inferExplicitWorkspaceReadGuardsFromText(text: string): {
  readonly forbiddenWorkspaceRead: boolean;
  readonly approvalRequiredWorkspaceRead: boolean;
} {
  const input = String(text || "").trim();
  if (!input) {
    return { forbiddenWorkspaceRead: false, approvalRequiredWorkspaceRead: false };
  }
  return {
    forbiddenWorkspaceRead: EXPLICIT_FORBIDDEN_WORKSPACE_READ_PATTERNS.some((pattern) => pattern.test(input)),
    approvalRequiredWorkspaceRead: EXPLICIT_APPROVAL_WORKSPACE_READ_PATTERNS.some((pattern) => pattern.test(input)),
  };
}
