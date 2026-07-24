import {
  isAbsoluteWorkspacePath,
  normalizeWorkspacePathIdentity,
  workspacePathsReferToSameFile,
} from "./workspacePaths";

/**
 * Legacy checkpoint-only schema.
 *
 * New Turns must use CollaborationLedgerV1 and semantic CollaborationWorkItemV1
 * records. This decoder remains solely so v1 checkpoints can preserve already
 * adopted evidence without reviving the old path-driven scheduler.
 */
export const LEGACY_PREFERRED_DELEGATION_CHECKPOINT_VERSION =
  "preferred-delegation-scopes.v1" as const;

type LegacyDelegationRuntimePhase =
  | "context"
  | "diagnostic"
  | "mutation"
  | "validation"
  | "finalization";

interface LegacyPreferredDelegationScopeCandidate {
  scopeKey: string;
  allowedPaths: string[];
}

interface LegacyPreferredDelegationScopeRegistration {
  requiredScopeKey: string;
  childScopeKey: string;
  subagentId: string;
  allowedPaths: string[];
  state: "spawned" | "consumed" | "incomplete";
}

export interface LegacyPreferredDelegationCheckpointV1 {
  schemaVersion: typeof LEGACY_PREFERRED_DELEGATION_CHECKPOINT_VERSION;
  lifecyclePhase: LegacyDelegationRuntimePhase;
  scopeFingerprint: string;
  wave: number;
  requiredScopes: LegacyPreferredDelegationScopeCandidate[];
  registrations: LegacyPreferredDelegationScopeRegistration[];
  maxCreatedPerTurn: number;
}

const MAX_LEGACY_SCOPES = 16;
const MAX_PATHS_PER_SCOPE = 24;
const MAX_STRING_CHARS = 4_096;
const LEGACY_PHASES = new Set<LegacyDelegationRuntimePhase>([
  "context",
  "diagnostic",
  "mutation",
  "validation",
  "finalization",
]);
const LEGACY_REGISTRATION_STATES = new Set<
  LegacyPreferredDelegationScopeRegistration["state"]
>(["spawned", "consumed", "incomplete"]);

function requiredString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized &&
      normalized.length <= MAX_STRING_CHARS &&
      normalized === value
    ? normalized
    : null;
}

function normalizeDisplayPath(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value
    .replace(/\\/g, "/")
    .replace(/^[`'"]+|[`'"]+$/g, "")
    .replace(/^\.\//, "")
    .replace(/\/+$/, "")
    .trim();
  return normalized && normalized.length <= MAX_STRING_CHARS
    ? normalized
    : null;
}

function normalizePaths(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > MAX_PATHS_PER_SCOPE) return null;
  const paths: string[] = [];
  const identities = new Set<string>();
  for (const candidate of value) {
    const path = normalizeDisplayPath(candidate);
    if (!path) return null;
    const identity = normalizeWorkspacePathIdentity(path);
    if (!identity || identities.has(identity)) continue;
    identities.add(identity);
    paths.push(path);
  }
  return paths.length > 0 ? paths : null;
}

function pathContains(scopePath: string, targetPath: string): boolean {
  if (workspacePathsReferToSameFile(scopePath, targetPath)) return true;
  const scope = normalizeWorkspacePathIdentity(scopePath);
  const target = normalizeWorkspacePathIdentity(targetPath);
  if (!scope || !target) return false;
  if (isAbsoluteWorkspacePath(scope) !== isAbsoluteWorkspacePath(target)) {
    return false;
  }
  return target.startsWith(`${scope}/`);
}

function scopesOverlap(
  left: LegacyPreferredDelegationScopeCandidate,
  right: LegacyPreferredDelegationScopeCandidate,
): boolean {
  return left.allowedPaths.some((leftPath) =>
    right.allowedPaths.some((rightPath) =>
      pathContains(leftPath, rightPath) || pathContains(rightPath, leftPath)
    )
  );
}

function buildScopeFingerprint(
  scopes: LegacyPreferredDelegationScopeCandidate[],
): string {
  return scopes
    .map((scope) =>
      `${scope.scopeKey}:${scope.allowedPaths
        .map((path) => normalizeWorkspacePathIdentity(path))
        .sort()
        .join(",")}`
    )
    .sort()
    .join("|");
}

/**
 * Decode untrusted v1 persisted state for one-way migration. No creation,
 * materialization, reviewer rewrite, or runtime scheduling API is exported.
 */
export function decodeLegacyPreferredDelegationCheckpointV1(
  value: unknown,
): LegacyPreferredDelegationCheckpointV1 | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    record.schemaVersion !== LEGACY_PREFERRED_DELEGATION_CHECKPOINT_VERSION
  ) {
    return null;
  }

  const maxCreatedPerTurn = Number(record.maxCreatedPerTurn);
  const wave = Number(record.wave);
  if (
    !Number.isSafeInteger(maxCreatedPerTurn) ||
    maxCreatedPerTurn < 2 ||
    maxCreatedPerTurn > MAX_LEGACY_SCOPES ||
    !Number.isSafeInteger(wave) ||
    wave < 1
  ) return null;
  if (
    !Array.isArray(record.requiredScopes) ||
    record.requiredScopes.length < 2 ||
    record.requiredScopes.length > maxCreatedPerTurn ||
    record.requiredScopes.length > MAX_LEGACY_SCOPES ||
    !Array.isArray(record.registrations) ||
    record.registrations.length > maxCreatedPerTurn
  ) return null;

  const requiredScopes: LegacyPreferredDelegationScopeCandidate[] = [];
  const requiredScopeKeys = new Set<string>();
  for (const rawScope of record.requiredScopes) {
    if (!rawScope || typeof rawScope !== "object" || Array.isArray(rawScope)) {
      return null;
    }
    const scope = rawScope as Record<string, unknown>;
    const scopeKey = requiredString(scope.scopeKey);
    const allowedPaths = normalizePaths(scope.allowedPaths);
    if (!scopeKey || !allowedPaths || requiredScopeKeys.has(scopeKey)) return null;
    requiredScopeKeys.add(scopeKey);
    requiredScopes.push({ scopeKey, allowedPaths });
  }
  for (let index = 0; index < requiredScopes.length; index += 1) {
    if (
      requiredScopes.slice(index + 1).some((candidate) =>
        scopesOverlap(requiredScopes[index], candidate)
      )
    ) return null;
  }

  const lifecyclePhase = record.lifecyclePhase as LegacyDelegationRuntimePhase;
  if (!LEGACY_PHASES.has(lifecyclePhase)) return null;

  const registrations: LegacyPreferredDelegationScopeRegistration[] = [];
  const registeredSubagentIds = new Set<string>();
  for (const rawRegistration of record.registrations) {
    if (
      !rawRegistration ||
      typeof rawRegistration !== "object" ||
      Array.isArray(rawRegistration)
    ) return null;
    const registration = rawRegistration as Record<string, unknown>;
    const requiredScopeKey = requiredString(registration.requiredScopeKey);
    const childScopeKey = requiredString(registration.childScopeKey);
    const subagentId = requiredString(registration.subagentId);
    const allowedPaths = normalizePaths(registration.allowedPaths);
    const state =
      registration.state as LegacyPreferredDelegationScopeRegistration["state"];
    const requiredScope = requiredScopes.find((scope) =>
      scope.scopeKey === requiredScopeKey
    );
    if (
      !requiredScopeKey ||
      !childScopeKey ||
      !subagentId ||
      !allowedPaths ||
      !requiredScope ||
      registeredSubagentIds.has(subagentId) ||
      !LEGACY_REGISTRATION_STATES.has(state) ||
      allowedPaths.some((path) =>
        !requiredScope.allowedPaths.some((scopePath) =>
          pathContains(scopePath, path)
        )
      )
    ) return null;
    registeredSubagentIds.add(subagentId);
    registrations.push({
      requiredScopeKey,
      childScopeKey,
      subagentId,
      allowedPaths,
      state,
    });
  }

  return {
    schemaVersion: LEGACY_PREFERRED_DELEGATION_CHECKPOINT_VERSION,
    lifecyclePhase,
    scopeFingerprint: buildScopeFingerprint(requiredScopes),
    wave,
    requiredScopes,
    registrations,
    maxCreatedPerTurn,
  };
}
