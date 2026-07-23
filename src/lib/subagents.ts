import type { AppConfig } from "./appTypes";
import { resolveRuntimeLaneKey } from "./appConfig";
import { getModelLaneBurstAdmission } from "./modelLaneCoordinator";
import type { SubagentDelegationPreference } from "./turnIntake";
export type { SubagentDelegationPreference } from "./turnIntake";
import type {
  FileReadObservationIdentity,
  FileReadWindowIdentity,
} from "./orchestrator/fileReadCache";
import { appendRuntimeEvent, withEventSchema, type MainThreadEvent } from "./turnEvents";
import {
  normalizeWorkspacePathIdentity,
  relativizeToWorkspacePath,
} from "./workspacePaths";
import {
  buildPreferredDelegationScopeFingerprint,
  getPreferredDelegationScopeProgress,
  preferredDelegationScopeContractMatchesWave,
  type PreferredDelegationScopeCandidate,
  type PreferredDelegationScopeContract,
} from "./preferredDelegationScopes";

export type SubagentStatus =
  | "queued"
  | "starting"
  | "running"
  | "summarizing"
  | "completed"
  | "blocked"
  | "degraded"
  | "failed"
  | "canceled";

export type SubagentActivityStatus = "running" | "completed" | "failed" | "canceled";

export interface SubagentActivity {
  id: string;
  timestampMs: number;
  status: SubagentActivityStatus;
  title: string;
  tool?: string;
  target?: string;
  detail?: string;
}

export interface SubagentProgress {
  phase: "queued" | "starting" | "waiting" | "thinking" | "tool" | "summarizing" | "done";
  title: string;
  tool?: string;
  target?: string;
  completedToolCalls?: number;
}

export const SUBAGENT_CLOSURE_SCHEMA_VERSION = 1 as const;

export interface SubagentClosureOwner {
  agentKind: "subagent";
  threadId: string;
  parentTurnId: string;
  subagentId: string;
  runId: string;
  parentRunId: string | null;
}

/**
 * Runtime-authored closure truth for one controlled child run. The model's
 * report remains display-only and must never be parsed to manufacture this
 * contract or to promote a partial handoff to completed.
 */
export interface SubagentClosureEnvelope {
  schemaVersion: typeof SUBAGENT_CLOSURE_SCHEMA_VERSION;
  owner: SubagentClosureOwner;
  scopeKey: string;
  status: Extract<SubagentStatus, "completed" | "blocked" | "degraded" | "failed" | "canceled">;
  state: "satisfied" | "partial" | "blocked";
  /** Null is the sole completed representation; incomplete closures carry runtime-owned work. */
  remainingWork: string | null;
  observationCount: number;
  substantiveEvidenceCount: number;
  acceptedEvidenceToolCallIds: string[];
  requiredPaths: string[];
  coveredPaths: string[];
  failedPaths: string[];
  uncoveredPaths: string[];
  /** Stable runtime code. `reason` is presentation detail and is not parsed. */
  reasonCode: string;
  reason: string;
}

export interface SubagentRunSnapshot {
  id: string;
  parentTurnId: string;
  threadId: string;
  name: string;
  role: string;
  objective: string;
  scopeKey?: string;
  scope?: string;
  allowedPaths?: string[];
  expectedOutput?: string;
  /** Fresh runtime identity; absent only on persisted pre-closure-contract records. */
  runId?: string;
  parentRunId?: string | null;
  status: SubagentStatus;
  profile: "local" | "cloud";
  provider: string;
  model: string;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  completedAt?: number;
  closedAt?: number;
  summary?: string;
  error?: string;
  /** Provenance-backed tool observations returned by the child runtime. */
  evidenceCount?: number;
  observationCount?: number;
  substantiveEvidenceCount?: number;
  closureState?: "satisfied" | "partial" | "blocked";
  closureAudit?: SubagentClosureEnvelope;
  remainingWork?: string;
  parentHandoff?: string;
  progress?: SubagentProgress;
}

export type SubagentRunPatch = Partial<Pick<
  SubagentRunSnapshot,
  | "status"
  | "updatedAt"
  | "startedAt"
  | "completedAt"
  | "closedAt"
  | "summary"
  | "error"
  | "evidenceCount"
  | "observationCount"
  | "substantiveEvidenceCount"
  | "closureState"
  | "closureAudit"
  | "remainingWork"
  | "parentHandoff"
  | "progress"
>>;

export interface SubagentRunRecord extends SubagentRunSnapshot {
  activities: SubagentActivity[];
}

export interface SpawnSubagentRequest {
  name?: string;
  role?: string;
  objective: string;
  scopeKey?: string;
  scope?: string;
  contextHints?: string;
  allowedPaths?: string;
  expectedOutput?: string;
}

export type DelegationRuntimePhase =
  | "context"
  | "diagnostic"
  | "mutation"
  | "validation"
  | "finalization";

export type DelegationDecisionAction = "admit" | "defer" | "deny";

export type DelegationDecisionReason =
  | "explicit_preference"
  | "explicit_permission"
  | "adaptive_multi_scope"
  | "insufficient_independent_scope"
  | "pending_subagents_require_join"
  | "phase_not_eligible"
  | "user_forbidden"
  | "workspace_unavailable"
  | "subagent_recursion_forbidden"
  | "turn_capacity_reached"
  | "overlapping_active_scope"
  | "parent_scope_already_observed"
  | "runtime_health_unavailable"
  | "runtime_capacity_busy"
  | "runtime_capacity_degraded";

export interface DelegationRuntimeHealth {
  laneKey: string;
  profile: "local" | "cloud";
  state: "ready" | "busy" | "degraded" | "unknown";
  activeChildren: number;
  queuedChildren: number;
  capacityLimit: number;
  memorySafety: "safe" | "unsafe" | "unknown" | "not_applicable";
  recentSuccessfulRuns: number;
  latestStartupMs: number | null;
  latestCapacityWaitMs: number | null;
}

export interface DelegationDecision {
  action: DelegationDecisionAction;
  reason: DelegationDecisionReason;
  phase: DelegationRuntimePhase;
  preference: SubagentDelegationPreference;
  independentScopeCount: number;
  explicitScopeCount: number;
  observedScopeCount: number;
  plannedWorkItemCount: number;
  pendingSubagentCount: number;
  runtimeHealthState: DelegationRuntimeHealth["state"] | "not_provided";
}

export type PreferredDelegationRequirementReason =
  | "required"
  | "not_preferred"
  | "all_required_scopes_consumed"
  | "awaiting_scope_join"
  | "scope_creation_capacity_reached"
  | "runtime_materialization_failed"
  | "evidence_topology_open"
  | "insufficient_parallel_scope"
  | "spawn_unavailable"
  | DelegationDecisionReason;

export interface PreferredDelegationRequirement {
  required: boolean;
  reason: PreferredDelegationRequirementReason;
  candidateScopeKeys: string[];
  /** Frozen runtime-owned scopes that must each cross spawn -> join -> consume. */
  requiredScopes: import("./preferredDelegationScopes").PreferredDelegationScopeCandidate[];
  /** Exact scopes eligible for the next bounded spawn batch. */
  remainingScopes: import("./preferredDelegationScopes").PreferredDelegationScopeCandidate[];
  contractOpen: boolean;
  consumedScopeKeys: string[];
  /** Runtime phase that owns this bounded collaboration wave. */
  lifecyclePhase: DelegationRuntimePhase;
  /** Concrete path-scope identity used to prevent duplicate waves. */
  scopeFingerprint: string;
}

export type SpawnSubagentResult =
  | {
      subagentId: string;
      name: string;
      status: "queued" | "running";
      scopeKey: string;
      /** Runtime-normalized authorization roots used to settle scope ownership. */
      allowedPaths: string[];
    }
  | {
      subagentId: null;
      name: string;
      status: "deferred";
      scopeKey: string;
      reason: DelegationDecisionReason;
      conflictingSubagentId?: string;
      conflictingScopeKey?: string;
    };

export interface SubagentEvidenceFactReference {
  fact: string;
  sourceToolCallId?: string;
  sourceObservationKey?: string;
  sourceVersion?: string;
  sourceRange?: FileReadWindowIdentity;
}

export interface SubagentObservationOwner {
  agentKind: "subagent";
  subagentId: string;
  parentTurnId?: string;
  runId?: string;
}

export interface SubagentEvidenceProvenance {
  source: "tool_observation";
  /** The child run that actually observed this source. */
  owner: SubagentObservationOwner;
  sourceToolCallId?: string;
  sourceObservation?: FileReadObservationIdentity;
  sourceVersion?: string;
  sourceContentHash?: string;
  sourceContentChars?: number;
  sourceRange?: FileReadWindowIdentity;
  factReferences?: SubagentEvidenceFactReference[];
}

export interface SubagentEvidenceItem {
  tool: string;
  target: string;
  detail: string;
  facts?: string[];
  observation?: {
    kind: "source" | "structure" | "search" | "diff";
    sourcePath: string;
    contentChars: number;
    negative: boolean;
    substantive: boolean;
    /** Exact paths parsed from a runtime-owned search/reference result. */
    observedTargetRefs?: string[];
    /** Exact syntax occurrences parsed from that result; child prose cannot author these. */
    observedOccurrences?: Array<{
      targetRef: string;
      anchorLine: number;
      startLine: number;
      endLine: number;
      role?: string;
      syntaxKind?: string;
    }>;
    /** Exact symbol used by the runtime-owned reference query. */
    queryRef?: string;
  };
  provenance: SubagentEvidenceProvenance;
}

export interface SubagentPathCoverageAudit {
  requiredPaths: string[];
  coveredPaths: string[];
  /** Required paths whose latest runtime state is still failed. */
  failedPaths: string[];
  /** Required paths without a successful observation, including failed paths. */
  uncoveredPaths: string[];
}

/**
 * Reconcile required child-scope roots with runtime-owned observations. A
 * later successful observation resolves an earlier failure for the same path;
 * activity on a descendant does not claim that an entire directory root was
 * covered.
 */
export function resolveSubagentPathCoverage(input: {
  requiredPaths: string[];
  observedPaths: Iterable<string>;
  failedPaths: Iterable<string>;
}): SubagentPathCoverageAudit {
  const requiredByIdentity = new Map<string, string>();
  for (const path of input.requiredPaths) {
    const identity = normalizeSubagentScopePathIdentity(String(path || ""));
    if (identity && !requiredByIdentity.has(identity)) {
      requiredByIdentity.set(identity, String(path || "").trim().replace(/\\/g, "/"));
    }
  }
  const observedIdentities = new Set([...input.observedPaths]
    .map((path) => normalizeSubagentScopePathIdentity(String(path || "")))
    .filter(Boolean));
  const failedIdentities = new Set([...input.failedPaths]
    .map((path) => normalizeSubagentScopePathIdentity(String(path || "")))
    .filter(Boolean));
  const requiredEntries = [...requiredByIdentity.entries()];
  const coveredPaths = requiredEntries
    .filter(([identity]) => observedIdentities.has(identity))
    .map(([, path]) => path);
  const failedPaths = requiredEntries
    .filter(([identity]) => !observedIdentities.has(identity) && failedIdentities.has(identity))
    .map(([, path]) => path);
  const uncoveredPaths = requiredEntries
    .filter(([identity]) => !observedIdentities.has(identity))
    .map(([, path]) => path);
  return {
    requiredPaths: requiredEntries.map(([, path]) => path),
    coveredPaths,
    failedPaths,
    uncoveredPaths,
  };
}

export interface SubagentResultEnvelope {
  subagentId: string;
  name: string;
  scopeKey: string;
  status: SubagentStatus;
  summary: string;
  /** Child-authored synthesis is a hypothesis; only provenance-backed evidence is trusted. */
  summaryTrust: "unverified_hypothesis";
  evidence: SubagentEvidenceItem[];
  /** Sole runtime authority for whether this child scope is closed. */
  closureAudit: SubagentClosureEnvelope;
  blocker?: string;
  remainingWork?: string;
  /** Work that is intentionally outside the child's read-only ownership. */
  parentHandoff?: string;
  error?: string;
}

export interface WaitSubagentsRequest {
  subagentIds?: string[];
}

export interface WaitSubagentsResult {
  results: SubagentResultEnvelope[];
  pendingIds: string[];
}

export interface SubagentExecutionScope {
  subagentId: string;
  parentSessionKey: string;
  scopeKey: string;
  workspace: string;
  allowedPaths: string[];
  /** Paths confirmed as files before the child model receives its first tool surface. */
  allowedFilePaths: string[];
  /** Remaining exact paths; directory tools may target only these entries. */
  allowedDirectoryPaths: string[];
  scopeKind: "exact_files" | "directory_or_mixed";
  /** A scope-invalid tool is removed after its first blocked call in this child run. */
  blockedToolNames: string[];
}

export interface RuntimeTraceContext {
  threadId: string;
  turnId: string;
  runId: string;
  parentRunId: string | null;
  agentKind: "parent" | "subagent";
  subagentId?: string;
}

export interface SubagentCapacityPolicy {
  laneKey: string;
  profile: "local" | "cloud";
  provider: string;
  model: string;
  maxActiveRequests: number;
  maxBurstActiveRequests: number;
  maxCreatedPerTurn: number;
  childMaxIterations: number;
}

function boundedCount(value: unknown): number {
  return Math.max(0, Math.floor(Number(value || 0)));
}

/**
 * Resolve dot segments before a path participates in a child-scope decision.
 * A raw prefix check is not a security boundary: `src/../package.json` is not
 * inside `src`, while `other/../src/main.ts` does overlap a `src` lease.
 * Traversal above the supplied workspace-relative root is rejected.
 */
function normalizeSubagentScopePathIdentity(value: string): string {
  const normalized = normalizeWorkspacePathIdentity(value);
  if (!normalized) return "";
  const drive = normalized.match(/^([a-z]:)\/(.*)$/i);
  const absolute = normalized.startsWith("/");
  const source = drive ? drive[2] : absolute ? normalized.slice(1) : normalized;
  const segments: string[] = [];
  for (const segment of source.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) return "";
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  const joined = segments.join("/");
  if (drive) return joined ? `${drive[1]}/${joined}` : `${drive[1]}/`;
  if (absolute) return joined ? `/${joined}` : "/";
  return joined || ".";
}

function normalizeSubagentScopeDisplayPath(value: unknown): string {
  const normalized = String(value || "")
    .replace(/\\/g, "/")
    .replace(/^[`'\"]+|[`'\"]+$/g, "")
    .replace(/^\.\//, "")
    .replace(/\/+$/, "")
    .trim();
  if (!normalized) return "";
  const drive = normalized.match(/^([a-z]:)\/(.*)$/i);
  const absolute = normalized.startsWith("/");
  const source = drive ? drive[2] : absolute ? normalized.slice(1) : normalized;
  const segments: string[] = [];
  for (const segment of source.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) return "";
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  const joined = segments.join("/");
  if (drive) return joined ? `${drive[1]}/${joined}` : `${drive[1]}/`;
  if (absolute) return joined ? `/${joined}` : "/";
  return joined || ".";
}

function collectIndependentDelegationScopes(values: unknown[]): Array<{
  identity: string;
  displayPath: string;
}> {
  const displayPathByIdentity = new Map<string, string>();
  for (const value of values) {
    const displayPath = normalizeSubagentScopeDisplayPath(value);
    const identity = normalizeSubagentScopePathIdentity(displayPath);
    if (!identity || identity === "." || displayPathByIdentity.has(identity)) continue;
    displayPathByIdentity.set(identity, displayPath);
  }
  const normalized = [...displayPathByIdentity.entries()]
    .map(([identity, displayPath]) => ({ identity, displayPath }))
    .sort((left, right) => left.identity.length - right.identity.length
      || left.identity.localeCompare(right.identity));
  const independent: typeof normalized = [];
  for (const candidate of normalized) {
    if (independent.some((scope) =>
      pathContains(scope.identity, candidate.identity)
      || pathContains(candidate.identity, scope.identity))) {
      continue;
    }
    independent.push(candidate);
  }
  return independent;
}

/**
 * Reduce path-like delegation hints to non-overlapping, canonical scopes.
 * Task count is deliberately excluded: several checklist items can still own
 * the same file and therefore do not prove that parallel work is independent.
 */
export function normalizeIndependentDelegationScopeKeys(values: unknown[]): string[] {
  return collectIndependentDelegationScopes(values).map((scope) => scope.identity);
}

/**
 * Provider-neutral delegation admission. Adaptive fan-out remains an initial
 * context optimization. An explicit preferred lifecycle may also open bounded
 * mutation/validation review waves after decisive runtime evidence; model and
 * provider identity never participate in the decision.
 */
export function resolveDelegationDecision(input: {
  preference?: SubagentDelegationPreference;
  phase: DelegationRuntimePhase;
  hasWorkspace: boolean;
  explicitScopeCount?: number;
  observedScopeCount?: number;
  plannedWorkItemCount?: number;
  independentScopeKeys?: string[];
  pendingSubagentCount?: number;
  subagentDepth?: number;
  runtimeHealth?: DelegationRuntimeHealth | null;
}): DelegationDecision {
  const preference = input.preference || "unspecified";
  const explicitScopeCount = boundedCount(input.explicitScopeCount);
  const observedScopeCount = boundedCount(input.observedScopeCount);
  const plannedWorkItemCount = boundedCount(input.plannedWorkItemCount);
  const pendingSubagentCount = boundedCount(input.pendingSubagentCount);
  const independentScopeCount = normalizeIndependentDelegationScopeKeys(
    input.independentScopeKeys || [],
  ).length;
  const decision = (
    action: DelegationDecisionAction,
    reason: DelegationDecisionReason,
  ): DelegationDecision => ({
    action,
    reason,
    phase: input.phase,
    preference,
    independentScopeCount,
    explicitScopeCount,
    observedScopeCount,
    plannedWorkItemCount,
    pendingSubagentCount,
    runtimeHealthState: input.runtimeHealth?.state || "not_provided",
  });

  if (boundedCount(input.subagentDepth) > 0) {
    return decision("deny", "subagent_recursion_forbidden");
  }
  if (!input.hasWorkspace) return decision("deny", "workspace_unavailable");
  if (preference === "forbidden") return decision("deny", "user_forbidden");
  const preferredLifecyclePhase =
    preference === "preferred" &&
    (input.phase === "mutation" || input.phase === "validation");
  if (
    input.phase !== "context" &&
    input.phase !== "diagnostic" &&
    !preferredLifecyclePhase
  ) {
    return decision("defer", "phase_not_eligible");
  }
  if (pendingSubagentCount > 0) {
    return decision("defer", "pending_subagents_require_join");
  }
  if (preference === "preferred" || preference === "allowed") {
    // Preference changes priority, never the existence of useful work. The
    // parent must identify at least one concrete path scope before spawning;
    // runtime health remains an admission boundary just as it is for adaptive
    // fan-out.
    if (independentScopeCount === 0) {
      return decision("defer", "insufficient_independent_scope");
    }
    if (input.runtimeHealth?.state === "degraded") {
      return decision("defer", "runtime_capacity_degraded");
    }
    if (input.runtimeHealth?.state === "busy") {
      return decision("defer", "runtime_capacity_busy");
    }
    return decision(
      "admit",
      preference === "preferred" ? "explicit_preference" : "explicit_permission",
    );
  }
  // Auto delegation is an initial-context optimization only. Files already
  // read by the parent and checklist length are evidence/telemetry, not a
  // reason to reopen fan-out during diagnosis.
  if (
    input.phase === "context" &&
    explicitScopeCount >= 2 &&
    independentScopeCount >= 2
  ) {
    if (!input.runtimeHealth || input.runtimeHealth.state === "unknown") {
      return decision("defer", "runtime_health_unavailable");
    }
    if (input.runtimeHealth.state === "degraded") {
      return decision("defer", "runtime_capacity_degraded");
    }
    if (input.runtimeHealth.state === "busy") {
      return decision("defer", "runtime_capacity_busy");
    }
    return decision("admit", "adaptive_multi_scope");
  }
  return decision("defer", "insufficient_independent_scope");
}

/**
 * A checked collaboration preference is stronger than a prompt hint once the
 * runtime has proved that useful parallel work exists. Keep this obligation
 * behind the normal delegation admission decision so workspace, recursion,
 * phase, capacity, and memory-safety boundaries remain authoritative.
 *
 * Two independent scopes are required: one can remain with the parent while
 * the other is delegated without manufacturing duplicate work.
 */
export function resolvePreferredDelegationRequirement(input: {
  decision: DelegationDecision;
  independentScopeKeys: string[];
  scopeCandidates?: PreferredDelegationScopeCandidate[];
  scopeContract?: PreferredDelegationScopeContract | null;
  /** False while a Plan still has typed evidence owners left to discover. */
  activationAllowed?: boolean;
  /** Process-local scheduler failures already returned to the parent runtime. */
  blockedScopeKeys?: Iterable<string>;
  spawnToolAvailable: boolean;
}): PreferredDelegationRequirement {
  const fallbackScopes = collectIndependentDelegationScopes(
    input.independentScopeKeys,
  ).slice(0, 8).map((scope) => ({
    scopeKey: scope.displayPath,
    allowedPaths: [scope.displayPath],
  }));
  const initialScopes = (input.scopeCandidates?.length
    ? input.scopeCandidates
    : fallbackScopes).map((scope) => ({
      scopeKey: scope.scopeKey,
      allowedPaths: [...scope.allowedPaths],
    }));
  const storedProgress = getPreferredDelegationScopeProgress(input.scopeContract || null);
  const scopeContractMatchesWave = preferredDelegationScopeContractMatchesWave({
    contract: input.scopeContract || null,
    lifecyclePhase: input.decision.phase,
    scopes: initialScopes,
  });
  // An active wave must always be joined before phase rebasing. A settled wave
  // belongs only to its phase+scope fingerprint and cannot permanently close
  // collaboration for the rest of the parent Turn.
  const effectiveScopeContract =
    storedProgress.activeScopeKeys.length > 0 ||
    storedProgress.open ||
    scopeContractMatchesWave
      ? input.scopeContract || null
      : null;
  const progress = getPreferredDelegationScopeProgress(effectiveScopeContract);
  const requiredScopes = effectiveScopeContract?.requiredScopes || initialScopes;
  const rawRemainingScopes = effectiveScopeContract
    ? progress.remainingScopes.slice(0, progress.creationCapacityRemaining)
    : initialScopes;
  const blockedScopeKeys = new Set(
    [...(
      input.scopeContract && !effectiveScopeContract
        ? []
        : input.blockedScopeKeys || []
    )].map((value) => String(value || "").trim()),
  );
  const remainingScopes = rawRemainingScopes.filter((scope) =>
    !blockedScopeKeys.has(scope.scopeKey)
  );
  const candidateScopeKeys = requiredScopes.map((scope) => scope.scopeKey);
  const result = (
    required: boolean,
    reason: PreferredDelegationRequirementReason,
    contractOpen = false,
  ): PreferredDelegationRequirement => ({
    required,
    reason,
    candidateScopeKeys,
    requiredScopes,
    remainingScopes,
    contractOpen,
    consumedScopeKeys: progress.consumedScopeKeys,
    lifecyclePhase: input.decision.phase,
    scopeFingerprint: buildPreferredDelegationScopeFingerprint(requiredScopes),
  });

  if (input.decision.preference !== "preferred") {
    return result(false, "not_preferred");
  }
  if (!effectiveScopeContract && input.activationAllowed === false) {
    return result(false, "evidence_topology_open");
  }
  if (effectiveScopeContract && progress.satisfied) {
    return result(false, "all_required_scopes_consumed");
  }
  if (effectiveScopeContract && progress.activeScopeKeys.length > 0) {
    return result(false, "awaiting_scope_join", true);
  }
  if (effectiveScopeContract && progress.creationCapacityRemaining <= 0) {
    return result(false, "scope_creation_capacity_reached", progress.open);
  }
  if (rawRemainingScopes.length > 0 && remainingScopes.length === 0) {
    // Admission/scheduler failures are bounded for this process run. Release
    // the evidence surface to the parent instead of repeatedly asking either
    // the runtime or the model to recreate the same rejected child scopes.
    return result(false, "runtime_materialization_failed", false);
  }
  if (input.decision.action !== "admit") {
    return result(false, input.decision.reason, progress.open);
  }
  if (!effectiveScopeContract && requiredScopes.length < 2) {
    return result(false, "insufficient_parallel_scope");
  }
  if (!input.spawnToolAvailable) {
    return result(false, "spawn_unavailable", progress.open);
  }
  return result(true, "required", true);
}

export function buildPreferredDelegationActionContract(input: {
  language: "zh" | "en";
  candidateScopeKeys: string[];
  remainingScopes?: PreferredDelegationScopeCandidate[];
}): string {
  const scopes = (input.remainingScopes?.length
    ? input.remainingScopes
    : collectIndependentDelegationScopes(input.candidateScopeKeys)
      .slice(0, 8)
      .map((scope) => ({ scopeKey: scope.displayPath, allowedPaths: [scope.displayPath] })))
    .map((scope) => `- scope_key=${scope.scopeKey}; allowed_paths=${scope.allowedPaths.join(",")}`)
    .join("\n");
  if (input.language === "en") {
    return [
      "PREFERRED_DELEGATION_ACTION_REQUIRED: The user enabled subagent collaboration, and the runtime has admitted useful parallel read-only work.",
      "This is the final action contract for the current request. The only available action is spawn_subagent. Call it now before any additional parent read, mutation, validation, or final response; do not emit a progress paragraph first.",
      "If the evidence contract names a missing source owner, delegate that exact bounded observation to the child instead of calling read_file or search from the parent. Use a concrete path already present in the project structure or evidence; do not invent one.",
      "Create one child for every remaining runtime-owned scope listed below. Use role=reviewer for each pre-draft independent audit. You may issue all listed spawn_subagent calls in this response; the runtime enforces the existing concurrency and memory-safety policy. allowed_paths is the authorization ceiling for that scope, not a claim that every file below a directory was inspected. A scope is consumed only after join returns a satisfied typed closure with at least one material provenance-backed observation; any exact evidence obligations left open return to the parent runtime.",
      "Remaining required scopes:",
      scopes || "- Select a concrete non-overlapping scope from the current evidence.",
    ].join("\n");
  }
  return [
    "PREFERRED_DELEGATION_ACTION_REQUIRED：用户已开启子智能体协作，且运行时已确认存在可并行的有价值只读范围。",
    "这是当前请求最后生效的动作契约，唯一可用动作是 spawn_subagent。现在必须先调用 spawn_subagent，再进行主体追加读取、修改、验证或最终回答；工具调用前不要输出进度段落。",
    "如果证据契约指出缺失的源码拥有者，就把该精确且有界的观察委派给子智能体，不要由主体调用 read_file 或搜索。路径必须已经出现在项目结构或证据中，不得虚构。",
    "下面每个尚未完成的运行时 scope 都必须各创建一个子智能体，并设置 role=reviewer。可以在本次响应中并列调用全部列出的 spawn_subagent；运行时会继续执行既有并发和内存安全策略。allowed_paths 是该 scope 的授权上限，不表示目录下每个文件均已检查。只有 join 返回 typed closure=satisfied 且至少包含一条有实质内容的 provenance 观察，该 scope 才算 consumed；仍未关闭的精确证据义务会交回父运行时，partial 或无证据结果不算完成。",
    "尚未完成的必需 scope：",
    scopes || "- 请从当前证据中选择一个具体且不重叠的范围。",
  ].join("\n");
}

/**
 * A required preferred-delegation checkpoint happens after the parent has
 * proved useful independent scopes. Normal discovery correctly rejects a
 * child that merely repeats parent-owned evidence, but this checkpoint asks
 * for an independent pre-draft audit. Normalize only spawn calls admitted by
 * that runtime checkpoint to the existing reviewer contract; all adaptive and
 * optional delegation keeps the ordinary duplicate-work policy.
 */
export function normalizeRequiredPreferredDelegationReviewerCalls<
  T extends { name: string; arguments: string },
>(calls: T[], required: boolean): T[] {
  if (!required) return calls;
  return calls.map((call) => {
    if (call.name !== "spawn_subagent") return call;
    try {
      const parsed = JSON.parse(call.arguments) as Record<string, unknown>;
      if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") return call;
      if (/reviewer|independent[_ -]?review/i.test(String(parsed.role || ""))) {
        return call;
      }
      return {
        ...call,
        arguments: JSON.stringify({ ...parsed, role: "reviewer" }),
      };
    } catch {
      return call;
    }
  });
}

export function buildSubagentPolicyDeferral(input: {
  name?: string;
  scopeKey?: string;
  reason: DelegationDecisionReason;
  conflictingSubagentId?: string;
  conflictingScopeKey?: string;
}): Extract<SpawnSubagentResult, { status: "deferred" }> {
  return {
    subagentId: null,
    name: String(input.name || "delegation").trim().slice(0, 32) || "delegation",
    status: "deferred",
    scopeKey: String(input.scopeKey || "delegation").trim().slice(0, 96) || "delegation",
    reason: input.reason,
    ...(input.conflictingSubagentId
      ? { conflictingSubagentId: input.conflictingSubagentId }
      : {}),
    ...(input.conflictingScopeKey
      ? { conflictingScopeKey: input.conflictingScopeKey }
      : {}),
  };
}

const TERMINAL_SUBAGENT_STATUSES = new Set<SubagentStatus>([
  "completed",
  "blocked",
  "degraded",
  "failed",
  "canceled",
]);

const ACTIVE_SUBAGENT_STATUSES = new Set<SubagentStatus>([
  "queued",
  "starting",
  "running",
  "summarizing",
]);

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

/**
 * Validate a child closure at a persistence or join boundary. Missing and
 * pre-contract payloads deliberately return false: compatibility is
 * fail-closed, never a prose-based completion upgrade.
 */
export function isAuthoritativeSubagentClosure(
  value: unknown,
  expectedOwner?: Partial<SubagentClosureOwner> & { scopeKey?: string },
): value is SubagentClosureEnvelope {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const closure = value as Partial<SubagentClosureEnvelope>;
  const owner = closure.owner;
  if (
    closure.schemaVersion !== SUBAGENT_CLOSURE_SCHEMA_VERSION ||
    !owner ||
    owner.agentKind !== "subagent" ||
    !String(owner.threadId || "").trim() ||
    !String(owner.parentTurnId || "").trim() ||
    !String(owner.subagentId || "").trim() ||
    !String(owner.runId || "").trim() ||
    !(owner.parentRunId === null || typeof owner.parentRunId === "string") ||
    !String(closure.scopeKey || "").trim() ||
    !["completed", "blocked", "degraded", "failed", "canceled"].includes(String(closure.status || "")) ||
    !["satisfied", "partial", "blocked"].includes(String(closure.state || "")) ||
    !(closure.remainingWork === null || typeof closure.remainingWork === "string") ||
    !isNonNegativeInteger(closure.observationCount) ||
    !isNonNegativeInteger(closure.substantiveEvidenceCount) ||
    Number(closure.substantiveEvidenceCount) > Number(closure.observationCount) ||
    !isStringArray(closure.acceptedEvidenceToolCallIds) ||
    !isStringArray(closure.requiredPaths) ||
    !isStringArray(closure.coveredPaths) ||
    !isStringArray(closure.failedPaths) ||
    !isStringArray(closure.uncoveredPaths) ||
    !String(closure.reasonCode || "").trim() ||
    !String(closure.reason || "").trim()
  ) {
    return false;
  }

  for (const [key, expected] of Object.entries(expectedOwner || {})) {
    if (expected === undefined) continue;
    const actual = key === "scopeKey"
      ? closure.scopeKey
      : owner[key as keyof SubagentClosureOwner];
    if (actual !== expected) return false;
  }

  const remainingWork = String(closure.remainingWork || "").trim();
  if (closure.status === "completed") {
    return closure.state === "satisfied" &&
      closure.remainingWork === null &&
      closure.uncoveredPaths.length === 0 &&
      closure.failedPaths.length === 0;
  }
  if (closure.status === "degraded") {
    return closure.state === "partial" &&
      closure.substantiveEvidenceCount > 0 &&
      remainingWork.length > 0;
  }
  return closure.state === "blocked" && remainingWork.length > 0;
}

function projectFailClosedSubagentCompletion(
  record: SubagentRunRecord,
): SubagentRunRecord {
  if (record.status !== "completed") return record;
  const closureIsAuthoritative = isAuthoritativeSubagentClosure(record.closureAudit, {
    threadId: record.threadId,
    parentTurnId: record.parentTurnId,
    subagentId: record.id,
    ...(record.runId ? { runId: record.runId } : {}),
    ...(record.parentRunId !== undefined ? { parentRunId: record.parentRunId } : {}),
    ...(record.scopeKey ? { scopeKey: record.scopeKey } : {}),
  }) && record.closureAudit.status === record.status;
  if (closureIsAuthoritative) return record;
  const error = "SUBAGENT_CLOSURE_CONTRACT_MISSING: a persisted completion has no matching runtime-authored closure envelope.";
  return {
    ...record,
    status: "blocked",
    closureState: "blocked",
    remainingWork: record.objective,
    error: record.error || error,
  };
}

function resolveConfiguredModel(config: AppConfig): { provider: string; model: string } {
  if (config.activeProfile === "local") {
    return {
      provider: String(config.local.provider || "Local"),
      model: String(config.local.model || "Unselected local model"),
    };
  }

  const activeServer = config.cloudServers.find((server) => server.id === config.activeCloudServerId);
  return {
    provider: String(activeServer?.provider || config.cloud.provider || "Cloud"),
    model: String(activeServer?.model || config.cloud.model || "Unselected cloud model"),
  };
}

export function resolveSubagentCapacityPolicy(config: AppConfig): SubagentCapacityPolicy {
  const profile = config.activeProfile === "cloud" ? "cloud" : "local";
  const configured = resolveConfiguredModel(config);
  return {
    laneKey: resolveRuntimeLaneKey(config),
    profile,
    provider: configured.provider,
    model: configured.model,
    // This is the number of child workflows. Model-request concurrency is
    // coordinated separately and reserves capacity for the parent thread.
    maxActiveRequests: profile === "local" ? 2 : 3,
    maxBurstActiveRequests: 3,
    maxCreatedPerTurn: profile === "local" ? 3 : 6,
    childMaxIterations: profile === "local" ? 6 : 8,
  };
}

export function isSubagentTerminalStatus(status: SubagentStatus): boolean {
  return TERMINAL_SUBAGENT_STATUSES.has(status);
}

export function isSubagentActiveStatus(status: SubagentStatus): boolean {
  return ACTIVE_SUBAGENT_STATUSES.has(status);
}

export function projectSubagentRuns(events: readonly MainThreadEvent[]): SubagentRunRecord[] {
  const records = new Map<string, SubagentRunRecord>();

  for (const event of events) {
    if (event.type === "subagent.created") {
      records.set(event.subagent.id, {
        ...event.subagent,
        activities: [],
      });
      continue;
    }

    if (event.type === "subagent.updated") {
      const current = records.get(event.subagentId);
      if (!current) continue;
      const activities = event.activity
        ? [...current.activities, event.activity].slice(-80)
        : current.activities;
      records.set(event.subagentId, projectFailClosedSubagentCompletion({
        ...current,
        ...event.patch,
        activities,
      }));
      continue;
    }

    if (event.type === "subagent.closed") {
      const current = records.get(event.subagentId);
      if (!current) continue;
      const requestedTerminalStatus = isSubagentTerminalStatus(event.reason as SubagentStatus)
        ? event.reason as SubagentStatus
        : event.reason === "orphaned_after_restart" || event.reason === "runtime_controller_missing"
          ? "canceled"
          : current.status;
      const terminalStatus = requestedTerminalStatus === "completed" && current.status !== "completed"
        ? "blocked"
        : requestedTerminalStatus;
      records.set(event.subagentId, projectFailClosedSubagentCompletion({
        ...current,
        status: terminalStatus,
        closedAt: event.closedAt,
        ...(isSubagentTerminalStatus(terminalStatus) && !current.completedAt
          ? { completedAt: event.closedAt }
          : {}),
        updatedAt: Math.max(current.updatedAt, event.closedAt),
      }));
      continue;
    }

    if (event.type === "subagent.dismissed") {
      records.delete(event.subagentId);
    }
  }

  return [...records.values()].sort((a, b) => a.createdAt - b.createdAt);
}

export function getSubagentRunsForTurn(
  events: readonly MainThreadEvent[],
  parentTurnId: string,
): SubagentRunRecord[] {
  return projectSubagentRuns(events).filter((run) => run.parentTurnId === parentTurnId);
}

interface CapacityWaiter {
  signal?: AbortSignal;
  resolve: () => void;
  reject: (error: Error) => void;
  onAbort?: () => void;
}

interface CapacityLaneState {
  active: number;
  limit: number;
  queue: CapacityWaiter[];
  policy: SubagentCapacityPolicy;
  reevaluationTimer: ReturnType<typeof setTimeout> | null;
}

const capacityLanes = new Map<string, CapacityLaneState>();
const degradedUntilByLane = new Map<string, number>();
interface SubagentRuntimeOwnership {
  sessionEpoch: string;
  generation: string;
}

interface OwnedSubagentAbortController extends SubagentRuntimeOwnership {
  subagentId: string;
  threadId: string;
  parentTurnId: string;
  controller: AbortController;
}

const childAbortControllers = new Map<string, OwnedSubagentAbortController>();
const SUBAGENT_RUNTIME_HEALTH_TTL_MS = 10 * 60_000;

interface SubagentRuntimeSample {
  recordedAt: number;
  startupMs: number;
  capacityWaitMs: number;
  successful: boolean;
}

const runtimeSamplesByLane = new Map<string, SubagentRuntimeSample[]>();

export interface CoordinatedSubagentRun {
  threadId: string;
  /** Session-instance fence. Runtime registrations always normalize this value. */
  sessionEpoch?: string;
  parentTurnId: string;
  subagentId: string;
  /** Runtime-instance fence for same-owner replacement races. */
  generation?: string;
  name: string;
  scopeKey: string;
  objective?: string;
  runId?: string;
  parentRunId?: string | null;
  completion: Promise<SubagentResultEnvelope>;
  result?: SubagentResultEnvelope;
  createdAt?: number;
  completedAt?: number;
  cleanupTimer?: ReturnType<typeof setTimeout>;
}

export interface SubagentScopeLease {
  threadId: string;
  /** Session-instance fence. Runtime leases always normalize this value. */
  sessionEpoch?: string;
  parentTurnId: string;
  subagentId: string;
  /** Runtime-instance fence for same-owner replacement races. */
  generation?: string;
  scopeKey: string;
  workspace: string;
  allowedPaths: string[];
  createdAt: number;
}

const coordinatedRuns = new Map<string, CoordinatedSubagentRun>();
const scopeLeases = new Map<string, SubagentScopeLease>();
// Reservations serialize child ownership without blocking the parent. They
// become active leases only when a child begins a real source-tool operation.
const scopeReservations = new Map<string, SubagentScopeLease>();
const COORDINATED_RESULT_TTL_MS = 10 * 60_000;
const LEGACY_SUBAGENT_SESSION_EPOCH = "legacy-session-epoch";
let coordinationGenerationSequence = 0;

export function normalizeSubagentSessionEpoch(value: unknown): string {
  return String(value || "").trim() || LEGACY_SUBAGENT_SESSION_EPOCH;
}

function normalizeSubagentGeneration(value: unknown): string {
  return String(value || "").trim() || `subagent-generation-${++coordinationGenerationSequence}`;
}

function normalizedRuntimeOwnership(
  input: Partial<SubagentRuntimeOwnership>,
  legacyGeneration?: string,
): SubagentRuntimeOwnership {
  return {
    sessionEpoch: normalizeSubagentSessionEpoch(input.sessionEpoch),
    generation: String(input.generation || "").trim() ||
      String(legacyGeneration || "").trim() ||
      normalizeSubagentGeneration(undefined),
  };
}

function coordinationKey(
  threadId: string,
  sessionEpoch: string | undefined,
  parentTurnId: string,
  subagentId: string,
): string {
  return `${threadId}::${normalizeSubagentSessionEpoch(sessionEpoch)}::${parentTurnId}::${subagentId}`;
}

function scopeOwnershipKey(input: {
  threadId: string;
  sessionEpoch?: string;
  parentTurnId: string;
  subagentId: string;
  generation?: string;
}): string {
  return [
    input.threadId,
    normalizeSubagentSessionEpoch(input.sessionEpoch),
    input.parentTurnId,
    input.subagentId,
    String(input.generation || "").trim(),
  ].join("::");
}

function hasRuntimeOwnership(
  value: Pick<CoordinatedSubagentRun, "sessionEpoch" | "generation">,
  expected: SubagentRuntimeOwnership,
): boolean {
  return normalizeSubagentSessionEpoch(value.sessionEpoch) === expected.sessionEpoch &&
    String(value.generation || "").trim() === expected.generation;
}

function releaseCoordinatedRun(key: string, expected: SubagentRuntimeOwnership): boolean {
  const run = coordinatedRuns.get(key);
  if (!run || !hasRuntimeOwnership(run, expected)) return false;
  if (run.cleanupTimer) clearTimeout(run.cleanupTimer);
  coordinatedRuns.delete(key);
  // Coordination records can be released by join, TTL cleanup, or parent
  // finalization. All are terminal ownership boundaries for this parent turn,
  // so a stale scope lease must never survive the record that owned it.
  releaseSubagentScopeLease(run.subagentId, {
    threadId: run.threadId,
    sessionEpoch: expected.sessionEpoch,
    parentTurnId: run.parentTurnId,
    generation: expected.generation,
  });
  return true;
}

export function parseSubagentAllowedPaths(value: unknown, workspace = ""): string[] {
  const paths = String(value || "")
    .split(/[\n,;]+/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => relativizeToWorkspacePath(entry, workspace))
    .map((entry) => String(entry || "")
      .replace(/\\/g, "/")
      .replace(/^[`'\"]+|[`'\"]+$/g, "")
      .replace(/^\.\//, "")
      .replace(/\/+$/, "")
      .trim())
    .filter(Boolean);
  const seen = new Set<string>();
  return paths.filter((path) => {
    const identity = normalizeSubagentScopePathIdentity(path);
    if (!identity || seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

/**
 * Count delegated paths already covered by parent-owned source observations.
 * `path:` is the canonical runtime evidence key; `file:` remains accepted for
 * snapshots created before the targeting-ledger rename.
 */
export function countParentObservedDelegationPaths(input: {
  allowedPaths: string[];
  evidenceKeys: Iterable<string>;
}): number {
  const observedPaths = [...input.evidenceKeys]
    .map((entry) => {
      if (entry.startsWith("path:")) return entry.slice("path:".length);
      if (entry.startsWith("file:")) return entry.slice("file:".length);
      return "";
    })
    .map(normalizeSubagentScopePathIdentity)
    .filter(Boolean);
  return input.allowedPaths
    .map(normalizeSubagentScopePathIdentity)
    .filter(Boolean)
    .filter((allowed) => observedPaths.some((observed) =>
      pathContains(allowed, observed) || pathContains(observed, allowed)
    )).length;
}

function pathContains(scopePath: string, targetPath: string): boolean {
  const scope = normalizeSubagentScopePathIdentity(scopePath);
  const target = normalizeSubagentScopePathIdentity(targetPath);
  if (!scope || !target) return false;
  if (scope === ".") return true;
  return target === scope || target.startsWith(`${scope}/`);
}

export function acquireSubagentScopeLease(input: SubagentScopeLease): void {
  const ownership = normalizedRuntimeOwnership(input, `legacy-generation:${input.subagentId}`);
  const lease: SubagentScopeLease = {
    ...input,
    ...ownership,
    allowedPaths: input.allowedPaths.map(normalizeSubagentScopePathIdentity).filter(Boolean),
  };
  scopeLeases.set(scopeOwnershipKey(lease), lease);
}

export function reserveSubagentScope(input: SubagentScopeLease): void {
  const ownership = normalizedRuntimeOwnership(input, `legacy-generation:${input.subagentId}`);
  const lease: SubagentScopeLease = {
    ...input,
    ...ownership,
    allowedPaths: input.allowedPaths.map(normalizeSubagentScopePathIdentity).filter(Boolean),
  };
  scopeReservations.set(scopeOwnershipKey(lease), lease);
}

interface SubagentScopeOwnershipExpectation extends SubagentRuntimeOwnership {
  threadId: string;
  parentTurnId: string;
}

function matchesScopeOwnership(
  lease: SubagentScopeLease,
  subagentId: string,
  expected?: SubagentScopeOwnershipExpectation,
): boolean {
  if (lease.subagentId !== subagentId) return false;
  if (!expected) return true;
  return lease.threadId === expected.threadId &&
    lease.parentTurnId === expected.parentTurnId &&
    normalizeSubagentSessionEpoch(lease.sessionEpoch) === expected.sessionEpoch &&
    String(lease.generation || "").trim() === expected.generation;
}

export function activateSubagentScopeLease(
  subagentId: string,
  expected?: SubagentScopeOwnershipExpectation,
): boolean {
  const alreadyActive = [...scopeLeases.values()].some((lease) =>
    matchesScopeOwnership(lease, subagentId, expected)
  );
  if (alreadyActive) return true;
  const reservations = [...scopeReservations.entries()].filter(([, lease]) =>
    matchesScopeOwnership(lease, subagentId, expected)
  );
  if (reservations.length === 0) return false;
  for (const [key, reservation] of reservations) {
    scopeReservations.delete(key);
    scopeLeases.set(key, reservation);
  }
  return true;
}

export function releaseSubagentScopeLease(
  subagentId: string,
  expected?: SubagentScopeOwnershipExpectation,
): void {
  for (const [key, lease] of scopeLeases.entries()) {
    if (matchesScopeOwnership(lease, subagentId, expected)) scopeLeases.delete(key);
  }
  for (const [key, reservation] of scopeReservations.entries()) {
    if (matchesScopeOwnership(reservation, subagentId, expected)) scopeReservations.delete(key);
  }
}

export function findSubagentScopeConflict(input: {
  threadId: string;
  sessionEpoch?: string;
  targetPath: string;
  currentSubagentId?: string | null;
}): SubagentScopeLease | null {
  // A reservation is ownership from the moment spawn is admitted. Waiting for
  // the child to make its first tool call allowed the parent to duplicate the
  // same reads during model startup.
  const childOwnership = new Map<string, SubagentScopeLease>([
    ...scopeReservations.entries(),
    ...scopeLeases.entries(),
  ]);
  for (const lease of childOwnership.values()) {
    if (lease.threadId !== input.threadId) continue;
    if (
      input.sessionEpoch &&
      normalizeSubagentSessionEpoch(lease.sessionEpoch) !== normalizeSubagentSessionEpoch(input.sessionEpoch)
    ) continue;
    if (lease.subagentId === input.currentSubagentId) continue;
    const target = normalizeSubagentScopePathIdentity(
      relativizeToWorkspacePath(input.targetPath, lease.workspace),
    );
    if (!target) continue;
    if (lease.allowedPaths.some((allowed) =>
      pathContains(allowed, target) || pathContains(target, allowed)
    )) return lease;
  }
  return null;
}

export function findSubagentLeaseOverlap(input: {
  threadId: string;
  sessionEpoch?: string;
  workspace: string;
  allowedPaths: string[];
}): SubagentScopeLease | null {
  const candidates = input.allowedPaths
    .map((path) => normalizeSubagentScopePathIdentity(relativizeToWorkspacePath(path, input.workspace)))
    .filter(Boolean);
  const childOwnership = new Map<string, SubagentScopeLease>([
    ...scopeReservations.entries(),
    ...scopeLeases.entries(),
  ]);
  for (const lease of childOwnership.values()) {
    if (lease.threadId !== input.threadId) continue;
    if (
      input.sessionEpoch &&
      normalizeSubagentSessionEpoch(lease.sessionEpoch) !== normalizeSubagentSessionEpoch(input.sessionEpoch)
    ) continue;
    if (candidates.some((candidate) => lease.allowedPaths.some((allowed) =>
      pathContains(allowed, candidate) || pathContains(candidate, allowed)
    ))) return lease;
  }
  return null;
}

export function validateSubagentScopeTarget(
  scope: SubagentExecutionScope,
  targetPath: string,
): boolean {
  const target = normalizeSubagentScopePathIdentity(
    relativizeToWorkspacePath(targetPath, scope.workspace),
  );
  return !!target && scope.allowedPaths.some((allowed) => pathContains(allowed, target));
}

export function resolveSubagentScopedReadTargets(input: {
  scope: SubagentExecutionScope;
  requestedPath: string;
}):
  | { action: "allow"; requestedPath: string; targets: string[] }
  | { action: "narrow"; requestedPath: string; targets: string[]; reason: "root_default" | "ancestor_narrowed" }
  | { action: "block"; requestedPath: string; targets: [] } {
  const rawRequestedPath = String(input.requestedPath || "").trim().replace(/\\/g, "/");
  if (rawRequestedPath && validateSubagentScopeTarget(input.scope, rawRequestedPath)) {
    return { action: "allow", requestedPath: rawRequestedPath, targets: [rawRequestedPath] };
  }

  const isRootDefault = !rawRequestedPath || rawRequestedPath === "." || rawRequestedPath === "./";
  const normalizedRequested = isRootDefault
    ? "."
    : normalizeSubagentScopePathIdentity(
        relativizeToWorkspacePath(rawRequestedPath, input.scope.workspace),
      );
  // Invalid traversal and unrelated paths remain hard failures. Only a root
  // default or a genuine ancestor of an owned path can be safely narrowed.
  if (!isRootDefault && !normalizedRequested) {
    return { action: "block", requestedPath: rawRequestedPath || ".", targets: [] };
  }
  const candidates = input.scope.allowedPaths.filter((allowed) =>
    isRootDefault || pathContains(normalizedRequested, allowed)
  );
  if (candidates.length === 0) {
    return { action: "block", requestedPath: rawRequestedPath || ".", targets: [] };
  }
  const candidateIdentities = new Set(candidates.map(normalizeSubagentScopePathIdentity));
  const ownedDirectories = input.scope.allowedDirectoryPaths
    .filter((path) => candidateIdentities.has(normalizeSubagentScopePathIdentity(path)));
  const targets = candidates.filter((candidate, index) => {
    const identity = normalizeSubagentScopePathIdentity(candidate);
    if (!identity || candidates.findIndex((item) =>
      normalizeSubagentScopePathIdentity(item) === identity
    ) !== index) return false;
    return !ownedDirectories.some((directory) => {
      const directoryIdentity = normalizeSubagentScopePathIdentity(directory);
      return directoryIdentity !== identity && pathContains(directoryIdentity, identity);
    });
  });
  return {
    action: "narrow",
    requestedPath: rawRequestedPath || ".",
    targets,
    reason: isRootDefault ? "root_default" : "ancestor_narrowed",
  };
}

export function recordSubagentScopeBlockedTool(
  scope: SubagentExecutionScope,
  toolName: string,
): boolean {
  const normalized = String(toolName || "").trim();
  if (!normalized || scope.blockedToolNames.includes(normalized)) return false;
  scope.blockedToolNames.push(normalized);
  return true;
}

function normalizeCoordinatedSubagentResult(
  run: CoordinatedSubagentRun,
  value: unknown,
): SubagentResultEnvelope {
  const record = value && typeof value === "object" && !Array.isArray(value)
    ? value as Partial<SubagentResultEnvelope>
    : {};
  const expectedRunId = run.runId || `run-${run.subagentId}`;
  const expectedParentRunId = run.parentRunId ?? null;
  const authoritative =
    record.subagentId === run.subagentId &&
    record.scopeKey === run.scopeKey &&
    isAuthoritativeSubagentClosure(record.closureAudit, {
      threadId: run.threadId,
      parentTurnId: run.parentTurnId,
      subagentId: run.subagentId,
      runId: expectedRunId,
      parentRunId: expectedParentRunId,
      scopeKey: run.scopeKey,
    }) &&
    record.status === record.closureAudit.status;
  if (authoritative) return record as SubagentResultEnvelope;

  const summary = typeof record.summary === "string" ? record.summary : "";
  const evidence = Array.isArray(record.evidence) ? record.evidence : [];
  const remainingWork = String(run.objective || run.scopeKey || "The assigned child scope remains unresolved.").trim();
  const reason = "SUBAGENT_CLOSURE_CONTRACT_INVALID: joined child result was missing a matching runtime-authored closure envelope.";
  const closureAudit: SubagentClosureEnvelope = {
    schemaVersion: SUBAGENT_CLOSURE_SCHEMA_VERSION,
    owner: {
      agentKind: "subagent",
      threadId: run.threadId,
      parentTurnId: run.parentTurnId,
      subagentId: run.subagentId,
      runId: expectedRunId,
      parentRunId: expectedParentRunId,
    },
    scopeKey: run.scopeKey,
    status: "blocked",
    state: "blocked",
    remainingWork,
    observationCount: evidence.length,
    substantiveEvidenceCount: 0,
    acceptedEvidenceToolCallIds: [],
    requiredPaths: [],
    coveredPaths: [],
    failedPaths: [],
    uncoveredPaths: [],
    reasonCode: "invalid_closure_envelope",
    reason,
  };
  return {
    subagentId: run.subagentId,
    name: run.name,
    scopeKey: run.scopeKey,
    status: "blocked",
    summary,
    summaryTrust: "unverified_hypothesis",
    evidence,
    closureAudit,
    blocker: reason,
    remainingWork,
    error: reason,
  };
}

export function registerCoordinatedSubagentRun(input: CoordinatedSubagentRun): void {
  const sessionEpoch = normalizeSubagentSessionEpoch(input.sessionEpoch);
  const explicitGeneration = String(input.generation || "").trim();
  const existingScopeGeneration = [...scopeReservations.values(), ...scopeLeases.values()]
    .find((lease) =>
      lease.threadId === input.threadId &&
      normalizeSubagentSessionEpoch(lease.sessionEpoch) === sessionEpoch &&
      lease.parentTurnId === input.parentTurnId &&
      lease.subagentId === input.subagentId
    )?.generation;
  const generation = normalizeSubagentGeneration(explicitGeneration || existingScopeGeneration);
  const ownership = { sessionEpoch, generation };
  const key = coordinationKey(input.threadId, sessionEpoch, input.parentTurnId, input.subagentId);
  const previous = coordinatedRuns.get(key);
  if (previous) {
    if (previous.cleanupTimer) clearTimeout(previous.cleanupTimer);
    releaseSubagentScopeLease(previous.subagentId, {
      threadId: previous.threadId,
      sessionEpoch: normalizeSubagentSessionEpoch(previous.sessionEpoch),
      parentTurnId: previous.parentTurnId,
      generation: String(previous.generation || "").trim(),
    });
  }
  const run: CoordinatedSubagentRun = {
    ...input,
    ...ownership,
    createdAt: input.createdAt || Date.now(),
  };
  run.completion = input.completion.then((result) => normalizeCoordinatedSubagentResult(run, result));
  coordinatedRuns.set(key, run);
  void run.completion.then((result) => {
    const current = coordinatedRuns.get(key);
    // A completion callback belongs to the exact registration instance that
    // installed it. A same-key replacement must remain untouched when an old
    // promise settles later.
    if (current !== run || !hasRuntimeOwnership(current, ownership)) return;
    run.result = result;
    run.completedAt = Date.now();
    run.cleanupTimer = setTimeout(() => {
      releaseCoordinatedRun(key, ownership);
    }, COORDINATED_RESULT_TTL_MS);
  });
}

export function getPendingCoordinatedSubagentIds(
  threadId: string,
  parentTurnId: string,
  sessionEpoch?: string,
): string[] {
  const normalizedSessionEpoch = normalizeSubagentSessionEpoch(sessionEpoch);
  return [...coordinatedRuns.values()]
    .filter((run) =>
      run.threadId === threadId &&
      normalizeSubagentSessionEpoch(run.sessionEpoch) === normalizedSessionEpoch &&
      run.parentTurnId === parentTurnId
    )
    .map((run) => run.subagentId);
}

export async function waitForCoordinatedSubagents(input: {
  threadId: string;
  sessionEpoch?: string;
  parentTurnId: string;
  subagentIds?: string[];
  signal?: AbortSignal;
}): Promise<WaitSubagentsResult> {
  const sessionEpoch = normalizeSubagentSessionEpoch(input.sessionEpoch);
  const parentRuns = [...coordinatedRuns.values()].filter((run) =>
    run.threadId === input.threadId &&
    normalizeSubagentSessionEpoch(run.sessionEpoch) === sessionEpoch &&
    run.parentTurnId === input.parentTurnId
  );
  if (parentRuns.length === 0) return { results: [], pendingIds: [] };

  const requestedIds = new Set((input.subagentIds || [])
    .map((value) => String(value || "").trim())
    .filter(Boolean));
  const requestsAllRegistered = [...requestedIds].some((value) => value.toLowerCase() === "all");
  const explicitlyMatchedRuns = requestedIds.size > 0
    ? parentRuns.filter((run) => requestedIds.has(run.subagentId))
    : [];
  // The coordination ledger, not model-authored IDs, owns the wait boundary.
  // Empty, wildcard-like, stale, or otherwise unmatched requests therefore
  // mean "join the currently registered children for this parent Turn". This
  // prevents an invalid ID from returning an empty result and spending another
  // model iteration on the same wait. A genuinely matching subset remains a
  // supported way to join only selected children.
  const runs = requestedIds.size === 0 || requestsAllRegistered || explicitlyMatchedRuns.length === 0
    ? parentRuns
    : explicitlyMatchedRuns;

  const completions = Promise.all(runs.map((run) => run.completion));
  const waitSignal = input.signal;
  const settledResults = waitSignal
    ? await new Promise<SubagentResultEnvelope[]>((resolve, reject) => {
        if (waitSignal.aborted) {
          reject(makeAbortError());
          return;
        }
        const onAbort = () => reject(makeAbortError());
        const settle = <T>(handler: (value: T) => void) => (value: T) => {
          waitSignal.removeEventListener("abort", onAbort);
          handler(value);
        };
        waitSignal.addEventListener("abort", onAbort, { once: true });
        completions.then(settle(resolve), settle(reject));
      })
    : await completions;
  const results: SubagentResultEnvelope[] = [];
  for (const [index, run] of runs.entries()) {
    const ownership = {
      sessionEpoch: normalizeSubagentSessionEpoch(run.sessionEpoch),
      generation: String(run.generation || "").trim(),
    };
    const key = coordinationKey(run.threadId, ownership.sessionEpoch, run.parentTurnId, run.subagentId);
    // If the slot was replaced while this wait was blocked, the old result is
    // stale evidence. Do not consume it or release the replacement.
    if (coordinatedRuns.get(key) !== run) continue;
    results.push(settledResults[index]);
    releaseCoordinatedRun(key, ownership);
  }
  return {
    results,
    pendingIds: getPendingCoordinatedSubagentIds(input.threadId, input.parentTurnId, sessionEpoch),
  };
}

export function getCoordinatedSubagentRunCount(
  threadId: string,
  parentTurnId: string,
  sessionEpoch?: string,
): number {
  const normalizedSessionEpoch = normalizeSubagentSessionEpoch(sessionEpoch);
  return [...coordinatedRuns.values()].filter((run) =>
    run.threadId === threadId &&
    normalizeSubagentSessionEpoch(run.sessionEpoch) === normalizedSessionEpoch &&
    run.parentTurnId === parentTurnId
  ).length;
}

export interface ParentSubagentFinalizationResult {
  requestedIds: string[];
  canceledIds: string[];
  controllerMissingIds: string[];
  settledIds: string[];
  timedOutIds: string[];
  releasedCount: number;
}

export async function finalizeCoordinatedSubagentsForParent(input: {
  threadId: string;
  sessionEpoch?: string;
  parentTurnId: string;
  graceMs?: number;
}): Promise<ParentSubagentFinalizationResult> {
  const sessionEpoch = normalizeSubagentSessionEpoch(input.sessionEpoch);
  const runs = [...coordinatedRuns.values()].filter((run) =>
    run.threadId === input.threadId &&
    normalizeSubagentSessionEpoch(run.sessionEpoch) === sessionEpoch &&
    run.parentTurnId === input.parentTurnId
  );
  const requestedIds = runs.filter((run) => !run.result).map((run) => run.subagentId);
  const canceledIds: string[] = [];
  const controllerMissingIds: string[] = [];
  for (const id of requestedIds) {
    const run = runs.find((candidate) => candidate.subagentId === id);
    if (run && cancelSubagentRun(id, {
      threadId: run.threadId,
      sessionEpoch,
      parentTurnId: run.parentTurnId,
      generation: String(run.generation || "").trim(),
    })) canceledIds.push(id);
    else controllerMissingIds.push(id);
  }

  const graceMs = Math.max(0, input.graceMs ?? 2_000);
  const completions = runs.map(async (run) => {
    await run.completion.catch(() => undefined);
    return run.subagentId;
  });
  const settledIds = new Set<string>();
  if (completions.length > 0 && graceMs > 0) {
    await Promise.race([
      Promise.all(completions.map(async (completion) => {
        const id = await completion;
        settledIds.add(id);
      })),
      new Promise<void>((resolve) => setTimeout(resolve, graceMs)),
    ]);
  }

  let releasedCount = 0;
  for (const run of runs) {
    const ownership = {
      sessionEpoch: normalizeSubagentSessionEpoch(run.sessionEpoch),
      generation: String(run.generation || "").trim(),
    };
    if (releaseCoordinatedRun(
      coordinationKey(run.threadId, ownership.sessionEpoch, run.parentTurnId, run.subagentId),
      ownership,
    )) {
      releasedCount += 1;
    }
  }
  return {
    requestedIds,
    canceledIds,
    controllerMissingIds,
    settledIds: [...settledIds],
    timedOutIds: requestedIds.filter((id) => !settledIds.has(id)),
    releasedCount,
  };
}

function makeAbortError(): Error {
  const error = new Error("Subagent execution was canceled.");
  error.name = "AbortError";
  return error;
}

function effectiveLaneLimit(policy: SubagentCapacityPolicy): number {
  const degradedUntil = degradedUntilByLane.get(policy.laneKey) || 0;
  if (degradedUntil > Date.now()) return 1;
  if (degradedUntil > 0) degradedUntilByLane.delete(policy.laneKey);
  if (
    policy.profile === "local" &&
    policy.maxBurstActiveRequests > policy.maxActiveRequests &&
    getModelLaneBurstAdmission(policy.laneKey).allowed
  ) {
    return policy.maxBurstActiveRequests;
  }
  return policy.maxActiveRequests;
}

export function recordSubagentRuntimeSample(input: {
  laneKey: string;
  startupMs: number;
  capacityWaitMs: number;
  successful: boolean;
  recordedAt?: number;
}): void {
  const recordedAt = input.recordedAt || Date.now();
  const samples = runtimeSamplesByLane.get(input.laneKey) || [];
  runtimeSamplesByLane.set(input.laneKey, [
    ...samples.filter((sample) =>
      recordedAt - sample.recordedAt <= SUBAGENT_RUNTIME_HEALTH_TTL_MS
    ),
    {
      recordedAt,
      startupMs: Math.max(0, Math.floor(input.startupMs)),
      capacityWaitMs: Math.max(0, Math.floor(input.capacityWaitMs)),
      successful: input.successful,
    },
  ].slice(-8));
}

/**
 * A read-only snapshot used by Auto delegation. Missing runtime observations
 * stay unknown; policy limits are not fabricated into proof that a local
 * model has enough memory or that child startup is inexpensive.
 */
export function getSubagentAdmissionHealth(
  policy: SubagentCapacityPolicy,
  now = Date.now(),
): DelegationRuntimeHealth {
  const lane = capacityLanes.get(policy.laneKey);
  const capacityLimit = effectiveLaneLimit(policy);
  const activeChildren = lane?.active || 0;
  const queuedChildren = lane?.queue.length || 0;
  const degraded = (degradedUntilByLane.get(policy.laneKey) || 0) > now;
  const recentSamples = (runtimeSamplesByLane.get(policy.laneKey) || [])
    .filter((sample) => now - sample.recordedAt <= SUBAGENT_RUNTIME_HEALTH_TTL_MS);
  const successfulSamples = recentSamples.filter((sample) => sample.successful);
  const latestSuccessfulSample = successfulSamples[successfulSamples.length - 1] || null;
  const burstAdmission = getModelLaneBurstAdmission(policy.laneKey);
  const memorySafety: DelegationRuntimeHealth["memorySafety"] = policy.profile === "cloud"
    ? "not_applicable"
    : burstAdmission.allowed
      ? "safe"
      : burstAdmission.reason === "degraded" || burstAdmission.reason === "memory_probe_unavailable"
        ? "unsafe"
        : "unknown";
  const state: DelegationRuntimeHealth["state"] = degraded || memorySafety === "unsafe"
    ? "degraded"
    : queuedChildren > 0 || activeChildren >= capacityLimit
      ? "busy"
      : latestSuccessfulSample || memorySafety === "safe"
        ? "ready"
        : "unknown";
  return {
    laneKey: policy.laneKey,
    profile: policy.profile,
    state,
    activeChildren,
    queuedChildren,
    capacityLimit,
    memorySafety,
    recentSuccessfulRuns: successfulSamples.length,
    latestStartupMs: latestSuccessfulSample?.startupMs ?? null,
    latestCapacityWaitMs: latestSuccessfulSample?.capacityWaitMs ?? null,
  };
}

export function getSubagentBurstAdmission(policy: SubagentCapacityPolicy) {
  const degradedUntil = degradedUntilByLane.get(policy.laneKey) || 0;
  if (degradedUntil > Date.now()) {
    return {
      allowed: false,
      reason: "capacity_degraded",
      safeOverlapSamples: 0,
      lastSafeOverlapAt: null,
      activeRequests: 0,
    };
  }
  return getModelLaneBurstAdmission(policy.laneKey);
}

function scheduleCapacityReevaluation(state: CapacityLaneState): void {
  if (state.reevaluationTimer || state.queue.length === 0) return;
  state.reevaluationTimer = setTimeout(() => {
    state.reevaluationTimer = null;
    state.limit = effectiveLaneLimit(state.policy);
    drainCapacityLane(state);
  }, 1_000);
}

function drainCapacityLane(state: CapacityLaneState): void {
  state.limit = effectiveLaneLimit(state.policy);
  while (state.active < state.limit && state.queue.length > 0) {
    const waiter = state.queue.shift()!;
    if (waiter.signal?.aborted) {
      waiter.reject(makeAbortError());
      continue;
    }
    if (waiter.onAbort) waiter.signal?.removeEventListener("abort", waiter.onAbort);
    state.active += 1;
    waiter.resolve();
  }
  if (state.queue.length > 0) scheduleCapacityReevaluation(state);
  else if (state.reevaluationTimer) {
    clearTimeout(state.reevaluationTimer);
    state.reevaluationTimer = null;
  }
}

async function acquireSubagentCapacity(
  policy: SubagentCapacityPolicy,
  signal?: AbortSignal,
): Promise<{ queued: boolean; release: () => void }> {
  if (signal?.aborted) throw makeAbortError();
  const limit = effectiveLaneLimit(policy);
  const state = capacityLanes.get(policy.laneKey) || {
    active: 0,
    limit,
    queue: [],
    policy,
    reevaluationTimer: null,
  };
  state.policy = policy;
  state.limit = limit;
  capacityLanes.set(policy.laneKey, state);

  let queued = false;
  if (state.active < state.limit) {
    state.active += 1;
  } else {
    queued = true;
    await new Promise<void>((resolve, reject) => {
      const waiter: CapacityWaiter = { signal, resolve, reject };
      if (signal) {
        waiter.onAbort = () => {
          const index = state.queue.indexOf(waiter);
          if (index >= 0) state.queue.splice(index, 1);
          reject(makeAbortError());
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      state.queue.push(waiter);
      scheduleCapacityReevaluation(state);
    });
  }

  let released = false;
  return {
    queued,
    release: () => {
      if (released) return;
      released = true;
      state.active = Math.max(0, state.active - 1);
      drainCapacityLane(state);
    },
  };
}

export async function withSubagentCapacity<T>(input: {
  policy: SubagentCapacityPolicy;
  signal?: AbortSignal;
  onQueued?: () => void;
  task: () => Promise<T>;
}): Promise<T> {
  const existingLane = capacityLanes.get(input.policy.laneKey);
  if (existingLane && existingLane.active >= effectiveLaneLimit(input.policy)) {
    input.onQueued?.();
  }
  const acquisitionPromise = acquireSubagentCapacity(input.policy, input.signal);
  const acquisition = await acquisitionPromise;
  try {
    return await input.task();
  } finally {
    acquisition.release();
  }
}

export function reportSubagentCapacityFailure(
  policy: SubagentCapacityPolicy,
  error: unknown,
): boolean {
  const message = error instanceof Error ? error.message : String(error || "");
  const shouldDegrade = /SUBAGENT_MEMORY_PRESSURE_DEGRADED|\b(?:oom|out of memory|memory allocation|429|524)\b|connection reset|socket hang up|gateway timeout|no visible progress|stream.*timeout/i.test(message);
  if (!shouldDegrade) return false;
  degradedUntilByLane.set(policy.laneKey, Date.now() + 5 * 60_000);
  const lane = capacityLanes.get(policy.laneKey);
  if (lane) {
    lane.limit = 1;
    drainCapacityLane(lane);
  }
  return true;
}

function abortControllerOwnershipKey(input: {
  subagentId: string;
  threadId: string;
  sessionEpoch: string;
  parentTurnId: string;
  generation: string;
}): string {
  return [
    input.threadId,
    input.sessionEpoch,
    input.parentTurnId,
    input.subagentId,
    input.generation,
  ].join("::");
}

export function registerSubagentAbortController(
  id: string,
  controller: AbortController,
  expected?: SubagentScopeOwnershipExpectation,
): void {
  const existingScope = [...scopeReservations.values(), ...scopeLeases.values()]
    .find((lease) => lease.subagentId === id);
  const ownership = expected || (existingScope
    ? {
        threadId: existingScope.threadId,
        sessionEpoch: normalizeSubagentSessionEpoch(existingScope.sessionEpoch),
        parentTurnId: existingScope.parentTurnId,
        generation: String(existingScope.generation || "").trim(),
      }
    : {
        threadId: "legacy-thread",
        sessionEpoch: LEGACY_SUBAGENT_SESSION_EPOCH,
        parentTurnId: "legacy-parent-turn",
        generation: `legacy-generation:${id}`,
      });
  const entry: OwnedSubagentAbortController = {
    subagentId: id,
    threadId: ownership.threadId,
    parentTurnId: ownership.parentTurnId,
    sessionEpoch: ownership.sessionEpoch,
    generation: ownership.generation,
    controller,
  };
  childAbortControllers.set(abortControllerOwnershipKey({
    subagentId: id,
    ...ownership,
  }), entry);
}

function matchingAbortControllerEntries(
  id: string,
  expected?: SubagentScopeOwnershipExpectation,
): Array<[string, OwnedSubagentAbortController]> {
  return [...childAbortControllers.entries()].filter(([, entry]) =>
    entry.subagentId === id &&
    (!expected || (
      entry.threadId === expected.threadId &&
      entry.parentTurnId === expected.parentTurnId &&
      entry.sessionEpoch === expected.sessionEpoch &&
      entry.generation === expected.generation
    ))
  );
}

export function unregisterSubagentAbortController(
  id: string,
  expected?: SubagentScopeOwnershipExpectation,
): void {
  for (const [key] of matchingAbortControllerEntries(id, expected)) {
    childAbortControllers.delete(key);
  }
}

export function cancelSubagentRun(
  id: string,
  expected?: SubagentScopeOwnershipExpectation,
): boolean {
  const entries = matchingAbortControllerEntries(id, expected);
  for (const [, entry] of entries) entry.controller.abort();
  return entries.length > 0;
}

export function hasLiveSubagentController(
  id: string,
  expected?: SubagentScopeOwnershipExpectation,
): boolean {
  return matchingAbortControllerEntries(id, expected).length > 0;
}

export function reconcileOrphanedSubagentEvents(
  events: readonly MainThreadEvent[],
  now = Date.now(),
): MainThreadEvent[] {
  let reconciled = [...events];
  for (const run of projectSubagentRuns(events)) {
    if (!isSubagentActiveStatus(run.status) || hasLiveSubagentController(run.id)) continue;
    releaseSubagentScopeLease(run.id);
    const error = "SUBAGENT_ORPHANED_AFTER_RESTART: the persisted run has no live runtime controller and was closed during session restore.";
    reconciled = appendRuntimeEvent(reconciled, withEventSchema({
      type: "subagent.updated",
      threadId: run.threadId,
      turnId: run.parentTurnId,
      timestampMs: now,
      subagentId: run.id,
      patch: {
        status: "canceled",
        updatedAt: now,
        completedAt: now,
        error,
        progress: {
          phase: "done",
          title: "Runtime record reconciled after restart",
          completedToolCalls: run.progress?.completedToolCalls || 0,
        },
      },
      activity: {
        id: `${run.id}-orphan-${now}`,
        timestampMs: now,
        status: "canceled",
        title: "Orphaned runtime record closed during restore",
        detail: error,
      },
    }));
    reconciled = appendRuntimeEvent(reconciled, withEventSchema({
      type: "subagent.closed",
      threadId: run.threadId,
      turnId: run.parentTurnId,
      timestampMs: now,
      subagentId: run.id,
      closedAt: now,
      reason: "orphaned_after_restart",
    }));
  }
  return reconciled;
}

export function resetSubagentRuntimeForTests(): void {
  for (const lane of capacityLanes.values()) {
    if (lane.reevaluationTimer) clearTimeout(lane.reevaluationTimer);
  }
  capacityLanes.clear();
  degradedUntilByLane.clear();
  childAbortControllers.clear();
  runtimeSamplesByLane.clear();
  coordinatedRuns.clear();
  scopeLeases.clear();
  scopeReservations.clear();
  coordinationGenerationSequence = 0;
}
