import type {
  DelegationRuntimePhase,
  PreferredDelegationRequirement,
  SpawnSubagentRequest,
  SpawnSubagentResult,
} from "./subagents";
import { normalizeWorkspacePathIdentity } from "./workspacePaths";

export const PREFERRED_DELEGATION_SCOPE_CONTRACT_VERSION =
  "preferred-delegation-scopes.v1" as const;

export interface PreferredDelegationScopeCandidate {
  scopeKey: string;
  allowedPaths: string[];
}

export interface PreferredDelegationScopeRegistration {
  requiredScopeKey: string;
  childScopeKey: string;
  subagentId: string;
  allowedPaths: string[];
  state: "spawned" | "consumed" | "incomplete";
}

export interface PreferredDelegationScopeContract {
  schemaVersion: typeof PREFERRED_DELEGATION_SCOPE_CONTRACT_VERSION;
  /** One bounded collaboration wave inside the longer parent Turn. */
  lifecyclePhase: DelegationRuntimePhase;
  /** Stable identity of the concrete path scopes owned by this wave. */
  scopeFingerprint: string;
  /** Monotonic wave number; joined children release capacity for later waves. */
  wave: number;
  requiredScopes: PreferredDelegationScopeCandidate[];
  registrations: PreferredDelegationScopeRegistration[];
  /** Legacy field name: this is now the creation limit for one wave. */
  maxCreatedPerTurn: number;
}

export interface PreferredDelegationScopeJoinOutcome {
  subagentId: string;
  scopeKey: string;
  status: string;
  closureState: "satisfied" | "partial" | "unverified";
  adoptedEvidenceCount: number;
  /** Exact runtime-owned evidence targets adopted from this child. */
  adoptedEvidenceTargets: string[];
  consumed: boolean;
}

export type PreferredDelegationEarlyMaterializationReason =
  | "runtime_owned_disjoint_scopes"
  | "requirement_inactive"
  | "insufficient_parallel_scope"
  | "runtime_spawn_unavailable"
  | "scopes_already_attempted";

export interface PreferredDelegationEarlyMaterializationPlan {
  action: "materialize" | "skip";
  reason: PreferredDelegationEarlyMaterializationReason;
  /** Stable control-plane obligation; presentation code must not parse this. */
  obligation: "preferred_delegation_scope_contract";
  blockedBy: PreferredDelegationRequirement["reason"] | null;
  requests: Array<{
    scopeKey: string;
    request: SpawnSubagentRequest;
  }>;
}

export interface PreferredDelegationEarlyMaterializationFailure {
  scopeKey: string;
  kind: "deferred" | "runtime_error";
  reason: string;
}

export interface PreferredDelegationEarlyMaterializationResult {
  plan: PreferredDelegationEarlyMaterializationPlan;
  outcomes: SpawnSubagentResult[];
  failures: PreferredDelegationEarlyMaterializationFailure[];
  attemptedScopeKeys: string[];
}

export interface PreferredDelegationEvidenceOwnerActivity {
  name?: string;
  target?: string;
  status?: string;
  readFileObservation?: { path?: string };
  astObservation?: { path?: string };
  discoveryObservation?: {
    kind?: string;
    targetRefs?: string[];
  };
  delegatedObservation?: {
    planningEvidenceState?: "reusable" | "unresolved";
    joinState?: "consumed";
    closureState?: "satisfied" | "partial" | "unverified";
  };
}

export type PreferredDelegationScopeDerivationStrategy =
  | "shallowest_parallel"
  | "stable_top_level";

const AUTHORITATIVE_EVIDENCE_OWNER_TOOLS = new Set([
  "read_file",
  "read_file_window",
  "read_document",
  "code_ast_query",
  "get_file_outline",
]);

const PREFERRED_DELEGATION_REGISTRATION_STATES = new Set<
  PreferredDelegationScopeRegistration["state"]
>(["spawned", "consumed", "incomplete"]);

const MAX_DURABLE_PREFERRED_DELEGATION_SCOPES = 16;

function normalizeDisplayPath(value: unknown): string {
  return String(value || "")
    .replace(/\\/g, "/")
    .replace(/^[`'\"]+|[`'\"]+$/g, "")
    .replace(/^\.\//, "")
    .replace(/\/+$/, "")
    .trim();
}

function pathContains(scopePath: string, targetPath: string): boolean {
  const scope = normalizeWorkspacePathIdentity(scopePath);
  const target = normalizeWorkspacePathIdentity(targetPath);
  if (!scope || !target) return false;
  return scope === "." || scope === target || target.startsWith(`${scope}/`);
}

export function isPreferredDelegationEvidenceTargetWithinScope(
  scopePaths: Iterable<string>,
  targetPath: string,
): boolean {
  return [...scopePaths].some((scopePath) => pathContains(scopePath, targetPath));
}

function scopesOverlap(
  left: PreferredDelegationScopeCandidate,
  right: PreferredDelegationScopeCandidate,
): boolean {
  return left.allowedPaths.some((leftPath) =>
    right.allowedPaths.some((rightPath) =>
      pathContains(leftPath, rightPath) || pathContains(rightPath, leftPath)
    )
  );
}

function uniquePaths(values: Iterable<unknown>): string[] {
  const byIdentity = new Map<string, string>();
  for (const value of values) {
    const path = normalizeDisplayPath(value);
    const identity = normalizeWorkspacePathIdentity(path);
    if (!path || !identity || identity === "." || byIdentity.has(identity)) continue;
    byIdentity.set(identity, path);
  }
  return [...byIdentity.values()];
}

export function buildPreferredDelegationScopeFingerprint(
  scopes: Iterable<PreferredDelegationScopeCandidate>,
): string {
  return [...scopes]
    .map((scope) => ({
      scopeKey: String(scope.scopeKey || "").trim(),
      allowedPaths: uniquePaths(scope.allowedPaths)
        .map((path) => normalizeWorkspacePathIdentity(path))
        .filter(Boolean)
        .sort(),
    }))
    .filter((scope) => scope.scopeKey && scope.allowedPaths.length > 0)
    .sort((left, right) => left.scopeKey.localeCompare(right.scopeKey))
    .map((scope) => `${scope.scopeKey}=${scope.allowedPaths.join(",")}`)
    .join("|");
}

function normalizePreferredDelegationLifecyclePhase(
  phase: DelegationRuntimePhase,
): DelegationRuntimePhase {
  // Context, diagnosis, and Plan finalization are one investigation wave.
  // Mutation and validation remain distinct later lifecycle opportunities.
  return phase === "context" || phase === "finalization"
    ? "diagnostic"
    : phase;
}

export function preferredDelegationScopeContractMatchesWave(input: {
  contract: PreferredDelegationScopeContract | null;
  lifecyclePhase: DelegationRuntimePhase;
  scopes: PreferredDelegationScopeCandidate[];
}): boolean {
  if (!input.contract) return false;
  return normalizePreferredDelegationLifecyclePhase(
    input.contract.lifecyclePhase,
  ) === normalizePreferredDelegationLifecyclePhase(input.lifecyclePhase) &&
    input.contract.scopeFingerprint ===
      buildPreferredDelegationScopeFingerprint(input.scopes);
}

function compactScopeKey(value: unknown, fallback: string): string {
  return String(value || fallback)
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 96) || fallback;
}

function extractAssignedField(
  record: string,
  field: "scope_key" | "allowed_paths",
): string {
  const fieldPattern = new RegExp(
    `${field}\\s*=\\s*([\\s\\S]*?)(?=[,，;；]\\s*(?:scope_key|scope|allowed_paths|expected_output)\\s*=|$)`,
    "i",
  );
  return String(record || "").match(fieldPattern)?.[1]?.trim() || "";
}

/**
 * Structured scope assignments are an input protocol, not natural-language
 * intent detection. The field names are the same provider-neutral tool
 * contract used by spawn_subagent.
 */
export function extractExplicitPreferredDelegationScopes(
  value: string,
): PreferredDelegationScopeCandidate[] {
  const candidates: PreferredDelegationScopeCandidate[] = [];
  for (const line of String(value || "").split(/\r?\n/)) {
    if (!/\bscope_key\s*=/i.test(line) || !/\ballowed_paths\s*=/i.test(line)) continue;
    const scopeKey = extractAssignedField(line, "scope_key");
    const allowedPaths = uniquePaths(
      extractAssignedField(line, "allowed_paths").split(/[,，]/),
    );
    if (!scopeKey || allowedPaths.length === 0) continue;
    const candidate = {
      scopeKey: compactScopeKey(scopeKey, `scope-${candidates.length + 1}`),
      allowedPaths,
    };
    if (candidates.some((existing) => scopesOverlap(existing, candidate))) continue;
    candidates.push(candidate);
  }
  return candidates;
}

function groupPathScopesAtDepth(
  paths: string[],
  depth: number,
): PreferredDelegationScopeCandidate[] {
  const groups = new Map<string, string[]>();
  for (const path of paths) {
    const identity = normalizeWorkspacePathIdentity(path);
    const segments = identity.split("/").filter(Boolean);
    const key = segments.slice(0, Math.min(depth, segments.length)).join("/");
    if (!key) continue;
    groups.set(key, [...(groups.get(key) || []), path]);
  }
  return [...groups.entries()].map(([scopeKey, allowedPaths]) => ({
    scopeKey,
    allowedPaths: uniquePaths(allowedPaths),
  }));
}

function groupStableTopLevelPathScopes(
  paths: string[],
): PreferredDelegationScopeCandidate[] {
  const grouped = groupPathScopesAtDepth(paths, 1);
  const directoryBacked = grouped.filter((scope) =>
    scope.allowedPaths.some((path) =>
      normalizeWorkspacePathIdentity(path).split("/").filter(Boolean).length > 1
    )
  );
  // When the topology exposes directory-backed subsystems, root singletons
  // (manifest/config/README or any other one-segment path) are context, not an
  // extra child. This is purely path topology; filenames and extensions have
  // no special meaning. Explicit typed scopes bypass this inference above.
  return directoryBacked.length > 0
    ? directoryBacked.map((scope) => ({
        scopeKey: scope.scopeKey,
        // The typed skeleton proved this directory prefix exists. Authorize
        // the stable prefix instead of enumerating every shallow file, which
        // keeps the request bounded without exhausting per-child path limits.
        allowedPaths: [scope.scopeKey],
      }))
    : grouped;
}

/**
 * Turn runtime derives stable, non-overlapping work scopes before asking the
 * model to delegate. Explicit typed assignments win. Otherwise the shallowest
 * project boundary that yields parallel work is used (for example `src` and
 * `src-tauri`), avoiding one child per incidental file read.
 */
export function derivePreferredDelegationScopeCandidates(input: {
  candidatePathKeys: Iterable<unknown>;
  structuredInput?: string;
  maxCreatedPerTurn: number;
  strategy?: PreferredDelegationScopeDerivationStrategy;
}): PreferredDelegationScopeCandidate[] {
  const limit = Math.max(0, Math.floor(Number(input.maxCreatedPerTurn) || 0));
  if (limit === 0) return [];
  const explicit = extractExplicitPreferredDelegationScopes(input.structuredInput || "");
  if (explicit.length >= 2) return explicit.slice(0, limit);

  const paths = uniquePaths(input.candidatePathKeys);
  if (paths.length < 2) {
    return paths.map((path) => ({ scopeKey: path, allowedPaths: [path] }));
  }
  if (input.strategy === "stable_top_level") {
    return groupStableTopLevelPathScopes(paths).slice(0, limit);
  }
  const maximumDepth = Math.max(...paths.map((path) =>
    normalizeWorkspacePathIdentity(path).split("/").filter(Boolean).length
  ));
  for (let depth = 1; depth <= maximumDepth; depth += 1) {
    const grouped = groupPathScopesAtDepth(paths, depth);
    if (grouped.length >= 2) return grouped.slice(0, limit);
  }
  return paths.slice(0, limit).map((path) => ({ scopeKey: path, allowedPaths: [path] }));
}

/**
 * Collect the exact source owners that already crossed the runtime evidence
 * boundary. Search terms, model prose, directory listings, and unjoined child
 * output are deliberately excluded so they cannot become delegation scopes.
 */
export function collectAuthoritativePreferredDelegationEvidenceOwnerPaths(
  activities: Iterable<PreferredDelegationEvidenceOwnerActivity>,
): string[] {
  const paths: string[] = [];
  for (const activity of activities) {
    if (
      String(activity.status || "").toLowerCase() !== "succeeded" ||
      !AUTHORITATIVE_EVIDENCE_OWNER_TOOLS.has(String(activity.name || "").toLowerCase())
    ) continue;
    if (activity.delegatedObservation && (
      activity.delegatedObservation.planningEvidenceState !== "reusable" ||
      activity.delegatedObservation.joinState !== "consumed" ||
      activity.delegatedObservation.closureState !== "satisfied"
    )) continue;
    const target = activity.readFileObservation?.path || activity.target;
    if (target) paths.push(target);
  }
  return uniquePaths(paths);
}

/**
 * Project-structure output is topology authority, not source evidence. Accept
 * only the runtime-parsed typed observation produced by get_project_skeleton;
 * ordinary directory summaries, search output, and model prose cannot enter
 * this early delegation boundary.
 */
export function collectTrustedPreferredDelegationWorkspaceTopologyPaths(
  activities: Iterable<PreferredDelegationEvidenceOwnerActivity>,
): string[] {
  const paths: string[] = [];
  for (const activity of activities) {
    if (
      String(activity.status || "").toLowerCase() !== "succeeded" ||
      String(activity.name || "").toLowerCase() !== "get_project_skeleton" ||
      activity.discoveryObservation?.kind !== "project_structure" ||
      !Array.isArray(activity.discoveryObservation.targetRefs)
    ) continue;
    if (activity.delegatedObservation && (
      activity.delegatedObservation.planningEvidenceState !== "reusable" ||
      activity.delegatedObservation.joinState !== "consumed" ||
      activity.delegatedObservation.closureState !== "satisfied"
    )) continue;
    paths.push(...activity.discoveryObservation.targetRefs);
  }
  return uniquePaths(paths);
}

/**
 * Extract concrete workspace paths for an Execute collaboration wave. Search
 * targets are queries, not paths; only runtime-parsed targetRefs may cross
 * this boundary. This prevents natural-language problem statements from
 * becoming allowed_paths.
 */
export function collectPreferredDelegationWorkspacePathCandidates(
  activities: Iterable<PreferredDelegationEvidenceOwnerActivity>,
): string[] {
  const paths: string[] = [];
  for (const activity of activities) {
    if (String(activity.status || "").toLowerCase() !== "succeeded") continue;
    if (activity.delegatedObservation && (
      activity.delegatedObservation.planningEvidenceState !== "reusable" ||
      activity.delegatedObservation.joinState !== "consumed" ||
      activity.delegatedObservation.closureState === "unverified"
    )) continue;
    const tool = String(activity.name || "").toLowerCase();
    if (
      tool === "read_file" ||
      tool === "read_file_window" ||
      tool === "read_document" ||
      tool === "get_file_outline" ||
      tool === "code_ast_query"
    ) {
      const sourcePath =
        activity.readFileObservation?.path ||
        activity.astObservation?.path ||
        activity.target;
      if (sourcePath) paths.push(sourcePath);
    }
    if (Array.isArray(activity.discoveryObservation?.targetRefs)) {
      paths.push(...activity.discoveryObservation.targetRefs);
    }
  }
  return uniquePaths(paths);
}

function compactMaterializationObjective(value: string): string {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 420);
}

/**
 * Convert an admitted preferred-delegation obligation into runtime-owned
 * child requests. This is deliberately separate from provider output: once
 * disjoint scopes are frozen, asking a model to restate `spawn_subagent`
 * only delays work and makes collaboration provider-dependent.
 */
export function resolvePreferredDelegationEarlyMaterializationPlan(input: {
  requirement: PreferredDelegationRequirement;
  parentObjective?: string;
  runSubagentAvailable: boolean;
  attemptedScopeKeys?: Iterable<string>;
}): PreferredDelegationEarlyMaterializationPlan {
  const obligation = "preferred_delegation_scope_contract" as const;
  const skip = (
    reason: Exclude<PreferredDelegationEarlyMaterializationReason, "runtime_owned_disjoint_scopes">,
  ): PreferredDelegationEarlyMaterializationPlan => ({
    action: "skip",
    reason,
    obligation,
    blockedBy: input.requirement.reason,
    requests: [],
  });
  if (!input.requirement.required) return skip("requirement_inactive");
  if (input.requirement.requiredScopes.length < 2) {
    return skip("insufficient_parallel_scope");
  }
  if (!input.runSubagentAvailable) return skip("runtime_spawn_unavailable");

  const attemptedScopeKeys = new Set(
    [...(input.attemptedScopeKeys || [])].map((value) => String(value || "").trim()),
  );
  const remainingScopes = input.requirement.remainingScopes.filter((scope) =>
    !attemptedScopeKeys.has(scope.scopeKey)
  );
  if (remainingScopes.length === 0) return skip("scopes_already_attempted");

  const parentObjective = compactMaterializationObjective(input.parentObjective || "");
  return {
    action: "materialize",
    reason: "runtime_owned_disjoint_scopes",
    obligation,
    blockedBy: null,
    requests: remainingScopes.map((scope, index) => ({
      scopeKey: scope.scopeKey,
      request: {
        name: `scope-${index + 1}`,
        role: "reviewer",
        objective: [
          `Independently inspect the bounded workspace scope ${scope.scopeKey}.`,
          parentObjective ? `Relate material observations to this parent objective: ${parentObjective}` : "",
          "Use read-only tools and return provenance-backed observations plus any remaining uncertainty.",
        ].filter(Boolean).join(" "),
        scopeKey: scope.scopeKey,
        scope: `Independent read-only evidence audit for ${scope.scopeKey}`,
        allowedPaths: scope.allowedPaths.join(","),
        expectedOutput:
          "Provenance-backed material observations within this bounded scope, plus remaining uncertainty.",
      },
    })),
  };
}

/**
 * Schedule every admitted scope without serially waiting for child completion.
 * Each scheduler call still owns capacity, lease, Turn/session epoch, and
 * generation admission. One rejected scope cannot reject its siblings or
 * throw the parent loop out of the current Turn.
 */
export async function materializePreferredDelegationScopesEarly(input: {
  requirement: PreferredDelegationRequirement;
  parentObjective?: string;
  attemptedScopeKeys?: Iterable<string>;
  runSubagent?: (
    request: SpawnSubagentRequest,
    options?: { signal?: AbortSignal },
  ) => Promise<SpawnSubagentResult>;
  signal?: AbortSignal;
}): Promise<PreferredDelegationEarlyMaterializationResult> {
  const plan = resolvePreferredDelegationEarlyMaterializationPlan({
    requirement: input.requirement,
    parentObjective: input.parentObjective,
    runSubagentAvailable: !!input.runSubagent,
    attemptedScopeKeys: input.attemptedScopeKeys,
  });
  if (plan.action === "skip" || !input.runSubagent) {
    return { plan, outcomes: [], failures: [], attemptedScopeKeys: [] };
  }

  const settled = await Promise.all(plan.requests.map(async ({ scopeKey, request }) => {
    try {
      const outcome = await input.runSubagent!(request, { signal: input.signal });
      return outcome.subagentId === null
        ? {
            outcome,
            failure: {
              scopeKey,
              kind: "deferred" as const,
              reason: outcome.reason,
            },
          }
        : { outcome, failure: null };
    } catch (error) {
      return {
        outcome: null,
        failure: {
          scopeKey,
          kind: "runtime_error" as const,
          reason: String(error instanceof Error ? error.message : error || "unknown_error")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 240) || "unknown_error",
        },
      };
    }
  }));
  return {
    plan,
    outcomes: settled.flatMap((entry) => entry.outcome ? [entry.outcome] : []),
    failures: settled.flatMap((entry) => entry.failure ? [entry.failure] : []),
    attemptedScopeKeys: plan.requests.map((entry) => entry.scopeKey),
  };
}

export function createPreferredDelegationScopeContract(input: {
  requiredScopes: PreferredDelegationScopeCandidate[];
  maxCreatedPerTurn: number;
  lifecyclePhase?: DelegationRuntimePhase;
  wave?: number;
}): PreferredDelegationScopeContract | null {
  const limit = Math.max(0, Math.floor(Number(input.maxCreatedPerTurn) || 0));
  const requiredScopes = input.requiredScopes
    .filter((candidate, index, all) =>
      candidate.allowedPaths.length > 0 &&
      all.findIndex((entry) => entry.scopeKey === candidate.scopeKey) === index
    )
    .slice(0, limit)
    .map((candidate) => ({
      scopeKey: candidate.scopeKey,
      allowedPaths: [...candidate.allowedPaths],
    }));
  if (requiredScopes.length < 2) return null;
  return {
    schemaVersion: PREFERRED_DELEGATION_SCOPE_CONTRACT_VERSION,
    lifecyclePhase: normalizePreferredDelegationLifecyclePhase(
      input.lifecyclePhase || "diagnostic",
    ),
    scopeFingerprint: buildPreferredDelegationScopeFingerprint(requiredScopes),
    wave: Math.max(1, Math.floor(Number(input.wave) || 1)),
    requiredScopes,
    registrations: [],
    maxCreatedPerTurn: limit,
  };
}

/**
 * Treat persisted collaboration state as untrusted JSON. The registration
 * count is intentionally retained because it is the active-wave creation
 * budget; dropping incomplete attempts on restore would mint duplicate
 * children inside the same wave.
 */
export function normalizePreferredDelegationScopeContract(
  value: unknown,
): PreferredDelegationScopeContract | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== PREFERRED_DELEGATION_SCOPE_CONTRACT_VERSION) return null;
  const rawLimit = Number(record.maxCreatedPerTurn);
  if (!Number.isSafeInteger(rawLimit) || rawLimit < 2 || rawLimit > MAX_DURABLE_PREFERRED_DELEGATION_SCOPES) {
    return null;
  }
  if (!Array.isArray(record.requiredScopes) || !Array.isArray(record.registrations)) return null;
  if (
    record.requiredScopes.length > MAX_DURABLE_PREFERRED_DELEGATION_SCOPES ||
    record.registrations.length > MAX_DURABLE_PREFERRED_DELEGATION_SCOPES
  ) return null;
  const requiredScopes: PreferredDelegationScopeCandidate[] = [];
  const requiredScopeKeys = new Set<string>();
  for (const rawScope of record.requiredScopes) {
    if (!rawScope || typeof rawScope !== "object" || Array.isArray(rawScope)) return null;
    const scope = rawScope as Record<string, unknown>;
    const scopeKey = String(scope.scopeKey || "").trim();
    const allowedPaths = Array.isArray(scope.allowedPaths)
      ? uniquePaths(scope.allowedPaths)
      : [];
    if (!scopeKey || requiredScopeKeys.has(scopeKey) || allowedPaths.length === 0) return null;
    requiredScopeKeys.add(scopeKey);
    requiredScopes.push({ scopeKey, allowedPaths });
  }
  if (
    requiredScopes.length < 2 ||
    requiredScopes.length > rawLimit ||
    requiredScopes.length > MAX_DURABLE_PREFERRED_DELEGATION_SCOPES
  ) return null;
  for (let index = 0; index < requiredScopes.length; index += 1) {
    if (requiredScopes.slice(index + 1).some((candidate) =>
      scopesOverlap(requiredScopes[index], candidate)
    )) return null;
  }
  const lifecyclePhases = new Set<DelegationRuntimePhase>([
    "context",
    "diagnostic",
    "mutation",
    "validation",
    "finalization",
  ]);
  const lifecyclePhase = normalizePreferredDelegationLifecyclePhase(
    lifecyclePhases.has(record.lifecyclePhase as DelegationRuntimePhase)
      ? record.lifecyclePhase as DelegationRuntimePhase
      : "diagnostic",
  );
  const scopeFingerprint = buildPreferredDelegationScopeFingerprint(requiredScopes);
  const wave = Math.max(1, Math.floor(Number(record.wave) || 1));

  if (record.registrations.length > rawLimit) return null;
  const registrations: PreferredDelegationScopeRegistration[] = [];
  const registeredSubagentIds = new Set<string>();
  for (const rawRegistration of record.registrations) {
    if (!rawRegistration || typeof rawRegistration !== "object" || Array.isArray(rawRegistration)) {
      return null;
    }
    const registration = rawRegistration as Record<string, unknown>;
    const requiredScopeKey = String(registration.requiredScopeKey || "").trim();
    const childScopeKey = String(registration.childScopeKey || "").trim();
    const subagentId = String(registration.subagentId || "").trim();
    const state = String(registration.state || "") as PreferredDelegationScopeRegistration["state"];
    const requiredScope = requiredScopes.find((scope) => scope.scopeKey === requiredScopeKey);
    const allowedPaths = Array.isArray(registration.allowedPaths)
      ? uniquePaths(registration.allowedPaths)
      : [];
    if (
      !requiredScope ||
      !childScopeKey ||
      !subagentId ||
      registeredSubagentIds.has(subagentId) ||
      !PREFERRED_DELEGATION_REGISTRATION_STATES.has(state) ||
      allowedPaths.length === 0 ||
      allowedPaths.some((path) =>
        !isPreferredDelegationEvidenceTargetWithinScope(requiredScope.allowedPaths, path)
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
    schemaVersion: PREFERRED_DELEGATION_SCOPE_CONTRACT_VERSION,
    lifecyclePhase,
    scopeFingerprint,
    wave,
    requiredScopes,
    registrations,
    maxCreatedPerTurn: rawLimit,
  };
}

export interface RestoredPreferredDelegationEvidenceIdentity {
  subagentId: string;
  scopeKey: string;
  target: string;
}

/**
 * Controllers and child promises are process-local. After recreation every
 * active registration is therefore incomplete. A consumed registration may
 * survive only when a separately normalized typed evidence checkpoint still
 * proves ownership inside the frozen scope.
 */
export function reconcilePreferredDelegationScopeContractAfterRestart(input: {
  contract: PreferredDelegationScopeContract | null;
  adoptedEvidence: RestoredPreferredDelegationEvidenceIdentity[];
}): PreferredDelegationScopeContract | null {
  const contract = normalizePreferredDelegationScopeContract(input.contract);
  if (!contract) return null;
  return {
    ...contract,
    registrations: contract.registrations.map((registration) => {
      if (registration.state === "spawned") {
        return { ...registration, state: "incomplete" as const };
      }
      if (registration.state !== "consumed") return registration;
      const hasValidEvidence = input.adoptedEvidence.some((evidence) =>
        evidence.subagentId === registration.subagentId &&
        evidence.scopeKey === registration.requiredScopeKey &&
        isPreferredDelegationEvidenceTargetWithinScope(
          registration.allowedPaths,
          evidence.target,
        )
      );
      return hasValidEvidence
        ? registration
        : { ...registration, state: "incomplete" as const };
    }),
  };
}

export function activatePreferredDelegationScopeContract(
  current: PreferredDelegationScopeContract | null,
  requirement: Pick<
    PreferredDelegationRequirement,
    "requiredScopes" | "lifecyclePhase"
  >,
  maxCreatedPerTurn: number,
): PreferredDelegationScopeContract | null {
  if (current) {
    const progress = getPreferredDelegationScopeProgress(current);
    if (
      progress.activeScopeKeys.length > 0 ||
      progress.open ||
      preferredDelegationScopeContractMatchesWave({
        contract: current,
        lifecyclePhase: requirement.lifecyclePhase,
        scopes: requirement.requiredScopes,
      })
    ) {
      return current;
    }
  }
  return createPreferredDelegationScopeContract({
    requiredScopes: requirement.requiredScopes,
    maxCreatedPerTurn,
    lifecyclePhase: requirement.lifecyclePhase,
    wave: (current?.wave || 0) + 1,
  });
}

export function getPreferredDelegationScopeProgress(
  contract: PreferredDelegationScopeContract | null,
): {
  open: boolean;
  satisfied: boolean;
  exhausted: boolean;
  createdCount: number;
  consumedScopeKeys: string[];
  activeScopeKeys: string[];
  remainingScopes: PreferredDelegationScopeCandidate[];
  creationCapacityRemaining: number;
} {
  if (!contract) {
    return {
      open: false,
      satisfied: false,
      exhausted: false,
      createdCount: 0,
      consumedScopeKeys: [],
      activeScopeKeys: [],
      remainingScopes: [],
      creationCapacityRemaining: 0,
    };
  }
  const consumed = new Set(contract.registrations
    .filter((registration) => registration.state === "consumed")
    .map((registration) => registration.requiredScopeKey));
  const active = new Set(contract.registrations
    .filter((registration) => registration.state === "spawned")
    .map((registration) => registration.requiredScopeKey));
  const remainingScopes = contract.requiredScopes.filter((scope) =>
    !consumed.has(scope.scopeKey) && !active.has(scope.scopeKey)
  );
  const satisfied = contract.requiredScopes.length > 0 &&
    contract.requiredScopes.every((scope) => consumed.has(scope.scopeKey));
  const creationCapacityRemaining = Math.max(
    0,
    contract.maxCreatedPerTurn - contract.registrations.length,
  );
  // A preferred collaboration contract is bounded by the same per-Turn
  // creation budget as the scheduler. Once all attempts are joined and that
  // budget is exhausted, return unresolved evidence to the parent instead of
  // keeping the Plan tool surface empty forever.
  const exhausted = !satisfied && active.size === 0 && creationCapacityRemaining === 0;
  return {
    open: !satisfied && !exhausted,
    satisfied,
    exhausted,
    createdCount: contract.registrations.length,
    consumedScopeKeys: [...consumed],
    activeScopeKeys: [...active],
    remainingScopes,
    creationCapacityRemaining,
  };
}

export function recordPreferredDelegationScopeSpawn(input: {
  contract: PreferredDelegationScopeContract | null;
  outcome: SpawnSubagentResult;
}): PreferredDelegationScopeContract | null {
  const { contract, outcome } = input;
  if (!contract || outcome.subagentId === null) return contract;
  if (contract.registrations.some((entry) => entry.subagentId === outcome.subagentId)) {
    return contract;
  }
  const requiredScope = contract.requiredScopes.find((scope) =>
    scope.scopeKey === outcome.scopeKey
  );
  if (!requiredScope || contract.registrations.length >= contract.maxCreatedPerTurn) {
    return contract;
  }
  return {
    ...contract,
    registrations: [
      ...contract.registrations,
      {
        requiredScopeKey: requiredScope.scopeKey,
        childScopeKey: outcome.scopeKey,
        subagentId: outcome.subagentId,
        // The frozen runtime contract, not model-authored spawn arguments, is
        // the authority used later to validate adopted evidence ownership.
        allowedPaths: [...requiredScope.allowedPaths],
        state: "spawned",
      },
    ],
  };
}

export function applyPreferredDelegationScopeJoinOutcomes(input: {
  contract: PreferredDelegationScopeContract | null;
  outcomes: PreferredDelegationScopeJoinOutcome[];
}): PreferredDelegationScopeContract | null {
  if (!input.contract || input.outcomes.length === 0) return input.contract;
  const bySubagentId = new Map<string, PreferredDelegationScopeJoinOutcome[]>();
  for (const outcome of input.outcomes) {
    bySubagentId.set(
      outcome.subagentId,
      [...(bySubagentId.get(outcome.subagentId) || []), outcome],
    );
  }
  return {
    ...input.contract,
    registrations: input.contract.registrations.map((registration) => {
      if (registration.state !== "spawned") return registration;
      const outcomes = bySubagentId.get(registration.subagentId) || [];
      if (outcomes.length === 0) return registration;
      const outcome = outcomes.find((candidate) =>
        candidate.scopeKey === registration.childScopeKey
      );
      if (!outcome) return { ...registration, state: "incomplete" };
      const evidenceTargets = uniquePaths(outcome.adoptedEvidenceTargets);
      const evidenceWithinRegisteredScope =
        outcome.adoptedEvidenceCount > 0 &&
        evidenceTargets.length > 0 &&
        evidenceTargets.every((target) =>
          registration.allowedPaths.some((allowedPath) => pathContains(allowedPath, target))
        );
      return {
        ...registration,
        state: outcome.consumed && evidenceWithinRegisteredScope
          ? "consumed"
          : "incomplete",
      };
    }),
  };
}

/**
 * At a runtime-required checkpoint, bind each admitted spawn call to one exact
 * remaining scope. This is control-plane normalization, analogous to forcing
 * the reviewer role; it prevents a model from accidentally duplicating the
 * first scope while leaving a second required scope unowned.
 */
export function normalizeRequiredPreferredDelegationScopeCalls<
  T extends { name: string; arguments: string },
>(
  calls: T[],
  requirement: Pick<PreferredDelegationRequirement, "required" | "remainingScopes">,
): T[] {
  if (!requirement.required) return calls;
  let scopeIndex = 0;
  return calls.flatMap((call) => {
    if (call.name !== "spawn_subagent") return [call];
    const scope = requirement.remainingScopes[scopeIndex++];
    if (!scope) return [];
    let parsed: Record<string, unknown> = {};
    try {
      const value = JSON.parse(call.arguments || "{}");
      if (value && typeof value === "object" && !Array.isArray(value)) {
        parsed = value as Record<string, unknown>;
      }
    } catch {
      // The exact runtime contract below remains sufficient to repair a
      // malformed optional argument object.
    }
    return [{
      ...call,
      arguments: JSON.stringify({
        ...parsed,
        role: "reviewer",
        scope_key: scope.scopeKey,
        scope: `Independent read-only evidence audit for ${scope.scopeKey}`,
        allowed_paths: scope.allowedPaths.join(","),
        expected_output: "Provenance-backed material observations within this bounded scope, plus remaining uncertainty.",
      }),
    }];
  });
}
