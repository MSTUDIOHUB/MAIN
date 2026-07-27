import type { PlanStructuredEvidenceFact } from "./planStructuredEvidence";
import { normalizeWorkspacePathIdentity, workspacePathsReferToSameFile } from "./workspacePaths";

export type PlanEvidenceObligationSource =
  | "user_target"
  | "project_structure"
  | "symbol_reference"
  | "contract_counterpart"
  | "call_chain"
  | "subagent_unresolved";

export interface PlanEvidenceOccurrenceRange {
  /** Exact syntax occurrence returned by the trusted discovery executor. */
  anchorLine: number;
  startLine: number;
  endLine: number;
  role?: string;
  syntaxKind?: string;
}

export interface PlanEvidenceDiscoveryOccurrence extends PlanEvidenceOccurrenceRange {
  targetRef: string;
}

export interface PlanEvidenceObligation {
  kind: "read_target" | "find_symbol_references";
  source: PlanEvidenceObligationSource;
  targetRef?: string;
  symbol?: string;
  /** A path alone is insufficient when discovery identified an exact occurrence. */
  occurrence?: PlanEvidenceOccurrenceRange;
}

export interface PlanEvidenceDiscoveryObservation {
  kind: "project_structure" | "symbol_references";
  queryRef?: string;
  targetRefs: string[];
  occurrences?: PlanEvidenceDiscoveryOccurrence[];
}

export interface PlanEvidenceObligationActivity {
  name?: string;
  target?: string;
  status?: string;
  structuredFacts?: PlanStructuredEvidenceFact[];
  discoveryObservation?: PlanEvidenceDiscoveryObservation;
  evidenceObligation?: PlanEvidenceObligation;
  /**
   * Runtime-owned identity for a result produced by the single exact action
   * contract in needs_evidence. Such a result may satisfy this obligation,
   * but it is a terminal observation in the current evidence transaction: its
   * returned snippets, symbols, and paths must not recursively expand the
   * hard-obligation graph.
   */
  obligationClosure?: {
    role: "obligation_closure";
    obligation: PlanEvidenceObligation;
  };
  readFileObservation?: {
    key?: string;
    path?: string;
    requestSignature?: string;
    versionToken?: string;
    source?: string;
    window?: {
      startLine: number;
      endLine: number;
      totalLines: number;
      truncated: boolean;
    };
  };
  delegatedObservation?: {
    planningEvidenceState?: "reusable" | "unresolved";
    joinState?: "consumed";
    closureState?: "satisfied" | "partial" | "unverified";
    requiresParentReread?: boolean;
  };
}

export type PlanEvidenceObligationToolName = "read_file" | "find_symbol_references";

// Objective text is an untrusted hint, so its extractor remains conservative,
// but it is extension-agnostic and includes conventional extensionless build
// owners. Trusted discovery records below accept any safe workspace identity.
const OBJECTIVE_WORKSPACE_REFERENCE_RE = /(?:\.{1,2}\/)?(?:[A-Za-z0-9_.@+-]+\/)+[A-Za-z0-9_.@+-]+|[A-Za-z0-9_.@+-]+\.[A-Za-z0-9][A-Za-z0-9.+-]{0,31}|(?:Makefile|GNUmakefile|CMakeLists\.txt|Dockerfile|Rakefile|Gemfile)/gi;
const MAX_DISCOVERY_TARGET_REFS = 80;
const MAX_DISCOVERY_OCCURRENCES = 40;
const MAX_OWNER_OCCURRENCES_PER_DISCOVERY = 4;
const MAX_OPEN_OBLIGATIONS = 8;
const OCCURRENCE_CONTEXT_BEFORE_LINES = 12;
const OCCURRENCE_CONTEXT_AFTER_LINES = 36;
const OCCURRENCE_READ_MAX_CHARS = 30_000;

function normalizeTrustedWorkspaceTargetRef(
  value: unknown,
  options: { allowAbsolute?: boolean } = {},
): string | null {
  const target = String(value || "")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .trim();
  const isAbsolute = target.startsWith("/") || /^[A-Za-z]:\//.test(target);
  const pathSegments = isAbsolute
    ? target.replace(/^(?:[A-Za-z]:)?\/+/, "").split("/")
    : target.split("/");
  if (
    !target ||
    target.length > 2_000 ||
    /[\u0000-\u001f<>]/.test(target) ||
    (isAbsolute && options.allowAbsolute === false) ||
    (!isAbsolute && /^(?:[A-Za-z][A-Za-z0-9+.-]*:|\.\.?(?:\/|$))/.test(target)) ||
    pathSegments.some((segment) => !segment || segment === "." || segment === "..")
  ) return null;
  return normalizeWorkspacePathIdentity(target) ? target : null;
}

function uniqueTargetRefs(
  values: Iterable<unknown>,
  limit = MAX_DISCOVERY_TARGET_REFS,
  options: { allowAbsolute?: boolean } = {},
): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const raw of values) {
    const value = normalizeTrustedWorkspaceTargetRef(raw, options);
    if (!value) continue;
    const identity = normalizeWorkspacePathIdentity(value);
    if (!identity || seen.has(identity)) continue;
    seen.add(identity);
    result.push(value);
    if (result.length >= limit) break;
  }
  return result;
}

/** Parse only the runtime-owned JSON returned by find_symbol_references. */
export function extractSymbolReferenceTargetRefs(value: unknown): string[] {
  let payload: unknown = value;
  if (typeof value === "string") {
    try {
      payload = JSON.parse(value);
    } catch {
      return [];
    }
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return [];
  const occurrences = (payload as { occurrences?: unknown }).occurrences;
  if (!Array.isArray(occurrences)) return [];
  return uniqueTargetRefs(occurrences.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const path = (entry as { path?: unknown }).path;
    return typeof path === "string" ? [path] : [];
  }));
}

function positiveLine(value: unknown): number | undefined {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return undefined;
  const line = Math.floor(parsed);
  return line > 0 ? line : undefined;
}

function normalizeOccurrenceRole(value: unknown): string | undefined {
  const role = String(value || "").trim().toLowerCase();
  return role && /^[a-z][a-z0-9_-]{0,40}$/.test(role) ? role : undefined;
}

function normalizeOccurrenceSyntaxKind(value: unknown): string | undefined {
  const syntaxKind = String(value || "").trim();
  return syntaxKind && /^[A-Za-z][A-Za-z0-9_-]{0,80}$/.test(syntaxKind)
    ? syntaxKind
    : undefined;
}

function occurrenceOwnerPriority(occurrence: PlanEvidenceDiscoveryOccurrence): number {
  if (occurrence.role === "definition" || occurrence.role === "declaration" || occurrence.role === "implementation") return 0;
  if (occurrence.role === "call") return 1;
  if (occurrence.role === "reference") return 2;
  if (occurrence.role === "import") return 3;
  return 2;
}

/**
 * Preserve exact symbol locations from the trusted JSON result. Definition
 * occurrences sort before registration/call sites, independent of provider
 * wording or source language.
 */
export function extractSymbolReferenceOccurrences(
  value: unknown,
): PlanEvidenceDiscoveryOccurrence[] {
  let payload: unknown = value;
  if (typeof value === "string") {
    try {
      payload = JSON.parse(value);
    } catch {
      return [];
    }
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return [];
  const rawOccurrences = (payload as { occurrences?: unknown }).occurrences;
  if (!Array.isArray(rawOccurrences)) return [];
  const occurrences: Array<PlanEvidenceDiscoveryOccurrence & { sourceIndex: number }> = [];
  const seen = new Set<string>();
  rawOccurrences.forEach((entry, sourceIndex) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return;
    const record = entry as Record<string, unknown>;
    const targetRef = uniqueTargetRefs([record.path], 1)[0];
    if (!targetRef) return;
    const rangeRecord = record.range && typeof record.range === "object" && !Array.isArray(record.range)
      ? record.range as Record<string, unknown>
      : undefined;
    const anchorLine = positiveLine(record.line) ||
      positiveLine(record.anchorLine) ||
      positiveLine(record.startLine) ||
      positiveLine(rangeRecord?.startLine);
    if (!anchorLine) return;
    const rawStartLine = positiveLine(record.startLine) || positiveLine(rangeRecord?.startLine) || anchorLine;
    const rawEndLine = positiveLine(record.endLine) || positiveLine(rangeRecord?.endLine) || anchorLine;
    const startLine = Math.min(rawStartLine, anchorLine);
    const endLine = Math.max(startLine, rawEndLine, anchorLine);
    const role = normalizeOccurrenceRole(record.role);
    const syntaxKind = normalizeOccurrenceSyntaxKind(record.syntaxKind ?? record.syntax_kind);
    const identity = [
      normalizeWorkspacePathIdentity(targetRef),
      anchorLine,
      startLine,
      endLine,
      role || "",
      syntaxKind || "",
    ].join(":");
    if (seen.has(identity)) return;
    seen.add(identity);
    occurrences.push({
      targetRef,
      anchorLine,
      startLine,
      endLine,
      ...(role ? { role } : {}),
      ...(syntaxKind ? { syntaxKind } : {}),
      sourceIndex,
    });
  });
  return occurrences
    .sort((left, right) =>
      occurrenceOwnerPriority(left) - occurrenceOwnerPriority(right) ||
      normalizeWorkspacePathIdentity(left.targetRef).localeCompare(normalizeWorkspacePathIdentity(right.targetRef)) ||
      left.startLine - right.startLine ||
      left.endLine - right.endLine ||
      left.sourceIndex - right.sourceIndex
    )
    .slice(0, MAX_DISCOVERY_OCCURRENCES)
    .map(({ sourceIndex: _sourceIndex, ...occurrence }) => occurrence);
}

/**
 * Convert the runtime-owned project tree into exact file refs. Indentation and
 * slash-terminated directory nodes are the contract; prose summaries are not
 * inspected.
 */
export function extractProjectSkeletonTargetRefs(value: unknown): string[] {
  const text = String(value || "");
  const directories: string[] = [];
  const refs: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const raw = line.replace(/\t/g, "  ");
    const trimmed = raw.trim();
    if (!trimmed || /^\[\.\.\./.test(trimmed)) continue;
    const depth = Math.max(0, Math.floor((raw.match(/^ */)?.[0].length || 0) / 2));
    if (trimmed.endsWith("/")) {
      const directory = trimmed.slice(0, -1).trim();
      if (!directory || directory === ".") continue;
      directories.splice(depth);
      directories[depth] = directory;
      continue;
    }
    if (/^\[[.]{3}/.test(trimmed)) continue;
    const targetRef = [...directories.slice(0, depth), trimmed].filter(Boolean).join("/");
    if (!normalizeTrustedWorkspaceTargetRef(targetRef)) continue;
    refs.push(targetRef);
  }
  return uniqueTargetRefs(refs);
}

export function extractRuntimePlanEvidenceDiscovery(input: {
  tool: string;
  content: unknown;
  args?: Record<string, unknown>;
}): PlanEvidenceDiscoveryObservation | undefined {
  if (input.tool === "get_project_skeleton") {
    const targetRefs = extractProjectSkeletonTargetRefs(input.content);
    return targetRefs.length > 0 ? { kind: "project_structure", targetRefs } : undefined;
  }
  if (input.tool === "find_symbol_references") {
    const targetRefs = extractSymbolReferenceTargetRefs(input.content);
    const occurrences = extractSymbolReferenceOccurrences(input.content);
    const queryRef = String(input.args?.symbol || "").trim();
    return {
      kind: "symbol_references",
      ...(queryRef ? { queryRef } : {}),
      targetRefs,
      ...(occurrences.length > 0 ? { occurrences } : {}),
    };
  }
  return undefined;
}

export function getPlanEvidenceObligationKey(obligation: PlanEvidenceObligation): string {
  const occurrence = obligation.occurrence;
  const baseKey = [
    obligation.kind,
    normalizeWorkspacePathIdentity(obligation.targetRef || ""),
    String(obligation.symbol || "").toLowerCase(),
  ].join(":");
  return occurrence
    ? `${baseKey}:occurrence=${occurrence.anchorLine}:${occurrence.startLine}-${occurrence.endLine}`
    : baseKey;
}

function objectiveTargetRefs(objective: string): string[] {
  return uniqueTargetRefs(
    (String(objective || "").match(OBJECTIVE_WORKSPACE_REFERENCE_RE) || [])
      .map((target) => target.replace(/[.,;:!?，。；：！？]+$/g, "")),
    MAX_DISCOVERY_TARGET_REFS,
    { allowAbsolute: false },
  );
}

/**
 * Generic call expressions are too broad to become mandatory exploration on
 * their own. Preserve hard call-chain lookup only when the stable identifier
 * is explicitly rooted in the task objective. This is identifier matching,
 * not natural-language interpretation, so it is provider and locale neutral.
 */
function objectiveExplicitlyReferencesSymbol(objective: string, symbol: string): boolean {
  const candidate = String(symbol || "").trim();
  if (!candidate) return false;
  const escaped = candidate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[^A-Za-z0-9_$])${escaped}(?=$|[^A-Za-z0-9_$])`, "i")
    .test(String(objective || ""));
}

export function planEvidenceActivitySatisfiesReadTarget(
  activity: PlanEvidenceObligationActivity,
  targetRef: string,
  occurrence?: PlanEvidenceOccurrenceRange,
): boolean {
  if (activity.delegatedObservation) {
    if (
      activity.delegatedObservation.requiresParentReread === true ||
      activity.delegatedObservation.joinState !== "consumed" ||
      activity.delegatedObservation.closureState !== "satisfied"
    ) return false;
  }
  const baseMatch = String(activity.status || "").toLowerCase() === "succeeded" &&
    /^(?:read_file|read_file_window|read_document|code_ast_query)$/i.test(String(activity.name || "")) &&
    workspacePathsReferToSameFile(String(activity.target || ""), targetRef);
  if (!baseMatch || !occurrence) return baseMatch;
  // Occurrence-scoped obligations may only close from a versioned read_file
  // observation whose actual returned range covers the trusted anchor/range.
  // A different slice of the same file is not interchangeable evidence.
  if (!/^(?:read_file|read_file_window)$/i.test(String(activity.name || ""))) return false;
  const observation = activity.readFileObservation;
  const window = observation?.window;
  return !!observation &&
    !!String(observation.key || "").trim() &&
    !!String(observation.requestSignature || "").trim() &&
    !!String(observation.versionToken || "").trim() &&
    workspacePathsReferToSameFile(String(observation.path || ""), targetRef) &&
    !!window &&
    Number.isFinite(window.startLine) &&
    Number.isFinite(window.endLine) &&
    window.startLine <= occurrence.startLine &&
    window.endLine >= occurrence.endLine &&
    window.startLine <= occurrence.anchorLine &&
    window.endLine >= occurrence.anchorLine;
}

/**
 * Validate the runtime transaction marker against the observed result. The
 * marker is carried out-of-band from tool-surface planning; result prose can
 * neither create it nor redirect it to another path/symbol.
 */
export function planEvidenceActivityClosesObligation(
  activity: PlanEvidenceObligationActivity,
): boolean {
  const obligation = activity.obligationClosure?.role === "obligation_closure"
    ? activity.obligationClosure.obligation
    : undefined;
  if (!obligation || String(activity.status || "").toLowerCase() !== "succeeded") return false;
  if (obligation.kind === "read_target") {
    return !!obligation.targetRef && planEvidenceActivitySatisfiesReadTarget(
      activity,
      obligation.targetRef,
      obligation.occurrence,
    );
  }
  if (String(activity.name || "").toLowerCase() !== "find_symbol_references") return false;
  const expectedSymbol = String(obligation.symbol || "").trim().toLowerCase();
  const observedSymbol = String(
    activity.discoveryObservation?.queryRef || activity.target || "",
  ).trim().toLowerCase();
  return !!expectedSymbol && observedSymbol === expectedSymbol;
}

function authoritativeDiscoveryFacts(
  activities: PlanEvidenceObligationActivity[],
): PlanStructuredEvidenceFact[] {
  return activities.flatMap((activity) => {
    if (String(activity.status || "").toLowerCase() !== "succeeded") return [];
    const runtimeFacts = (activity.structuredFacts || []).filter((fact) =>
      fact.authority === "runtime_observation"
    );
    if (!planEvidenceActivityClosesObligation(activity)) return runtimeFacts;
    // A targeted owner read may establish the strong command/event counterpart
    // and its arguments. Ordinary listener_calls discovered inside that
    // closure remain terminal context and cannot restart recursive discovery.
    return runtimeFacts.filter((fact) =>
      fact.kind === "command_contract" || fact.kind === "event_contract"
    );
  });
}

function sourceTargetWasRead(
  obligation: PlanEvidenceObligation,
  activities: PlanEvidenceObligationActivity[],
): boolean {
  const targetRef = obligation.targetRef || "";
  return activities.some((activity) =>
    planEvidenceActivitySatisfiesReadTarget(activity, targetRef, obligation.occurrence)
  );
}

/**
 * Build the next exact read/search obligations from runtime-owned state only.
 * Child summaries, assistant prose, and localized phrases never participate.
 */
export function derivePlanEvidenceObligations(input: {
  objective?: string;
  activities?: PlanEvidenceObligationActivity[];
}): PlanEvidenceObligation[] {
  const activities = Array.isArray(input.activities) ? input.activities : [];
  const obligations: PlanEvidenceObligation[] = [];
  const seen = new Set<string>();
  const add = (obligation: PlanEvidenceObligation) => {
    const key = getPlanEvidenceObligationKey(obligation);
    if (seen.has(key) || obligations.length >= MAX_OPEN_OBLIGATIONS) return;
    if (obligation.kind === "read_target" && (!obligation.targetRef || sourceTargetWasRead(obligation, activities))) return;
    seen.add(key);
    obligations.push(obligation);
  };

  // Exact unresolved child scope is the strongest handoff. It is authored by
  // closureAudit.required/failed/uncovered paths, never by the child summary.
  for (const activity of activities) {
    const explicit = activity.evidenceObligation;
    if (
      explicit?.kind === "read_target" &&
      explicit.source === "subagent_unresolved" &&
      activity.delegatedObservation?.planningEvidenceState === "unresolved"
    ) add(explicit);
  }

  const successfulDiscoveryActivities = activities.filter((activity) =>
    String(activity.status || "").toLowerCase() === "succeeded" &&
    !!activity.discoveryObservation
  );
  // Discovery is a rooted graph, not an unbounded crawl. A symbol lookup may
  // expose its exact owning files as the bounded read continuation of the
  // current transaction. Once that read is admitted as an obligation closure,
  // strong command/event counterpart facts remain usable, while ordinary
  // listener-call topology cannot become another recursive discovery root.
  const rootDiscoveries = successfulDiscoveryActivities.flatMap((activity) =>
    !planEvidenceActivityClosesObligation(activity)
      ? activity.discoveryObservation || []
      : []
  );
  const symbolReferenceDiscoveries = successfulDiscoveryActivities.flatMap((activity) =>
    activity.discoveryObservation?.kind === "symbol_references"
      ? [activity.discoveryObservation]
      : []
  );
  const projectRefs = uniqueTargetRefs(rootDiscoveries
    .filter((entry) => entry.kind === "project_structure")
    .flatMap((entry) => entry.targetRefs));
  const referenceRefs = uniqueTargetRefs(symbolReferenceDiscoveries
    .flatMap((entry) => entry.targetRefs));
  const observedActivityRefs = uniqueTargetRefs(activities.flatMap((activity) => {
    if (
      String(activity.status || "").toLowerCase() !== "succeeded" ||
      !/^(?:read_file|read_file_window|read_document|code_ast_query)$/i.test(String(activity.name || ""))
    ) return [];
    return activity.target ? [activity.target] : [];
  }));

  for (const targetRef of objectiveTargetRefs(input.objective || "")) {
    const actualWorkspaceMatch = observedActivityRefs.find((candidate) =>
      workspacePathsReferToSameFile(candidate, targetRef)
    ) || projectRefs.find((candidate) => workspacePathsReferToSameFile(candidate, targetRef));
    add({ kind: "read_target", source: "user_target", targetRef: actualWorkspaceMatch || targetRef });
  }
  const discoveriesWithOccurrences = symbolReferenceDiscoveries.filter((entry) =>
    (entry.occurrences || []).length > 0
  );
  for (const discovery of discoveriesWithOccurrences) {
    const occurrences = discovery.occurrences || [];
    const definitions = occurrences.filter((occurrence) =>
      occurrenceOwnerPriority(occurrence) === 0
    );
    // When a real definition exists, registration/call sites are supporting
    // topology rather than the owner. Otherwise retain a small deterministic
    // set of best available occurrences.
    const selected = (definitions.length > 0 ? definitions : occurrences)
      .slice(0, MAX_OWNER_OCCURRENCES_PER_DISCOVERY);
    for (const occurrence of selected) {
      const { targetRef, ...range } = occurrence;
      add({
        kind: "read_target",
        source: "symbol_reference",
        targetRef,
        ...(discovery.queryRef ? { symbol: discovery.queryRef } : {}),
        occurrence: range,
      });
    }
  }
  const occurrenceDiscoveryPaths = new Set(discoveriesWithOccurrences.flatMap((entry) =>
    (entry.occurrences || []).map((occurrence) => normalizeWorkspacePathIdentity(occurrence.targetRef))
  ));
  for (const targetRef of referenceRefs) {
    if (occurrenceDiscoveryPaths.has(normalizeWorkspacePathIdentity(targetRef))) continue;
    add({ kind: "read_target", source: "symbol_reference", targetRef });
  }

  const facts = authoritativeDiscoveryFacts(activities);
  const searchedSymbols = new Set(symbolReferenceDiscoveries
    .map((entry) => String(entry.queryRef || "").trim().toLowerCase())
    .filter(Boolean));
  for (const activity of activities) {
    if (
      planEvidenceActivityClosesObligation(activity) &&
      activity.obligationClosure?.obligation.kind === "find_symbol_references"
    ) {
      const symbol = String(activity.obligationClosure.obligation.symbol || "").trim().toLowerCase();
      if (symbol) searchedSymbols.add(symbol);
    }
  }
  const handlerCommands = new Set(facts.flatMap((fact) =>
    fact.kind === "command_contract" && fact.relation === "handler" && fact.command
      ? [fact.command.toLowerCase()]
      : []
  ));
  const listenerEvents = new Set(facts.flatMap((fact) =>
    fact.kind === "event_contract" && (fact.relation === "dom_listener" || fact.relation === "tauri_listener")
      ? [fact.event.toLowerCase()]
      : []
  ));
  const searchSymbol = (symbol: string, source: PlanEvidenceObligationSource) => {
    const normalized = String(symbol || "").trim();
    if (!normalized || searchedSymbols.has(normalized.toLowerCase())) return;
    add({ kind: "find_symbol_references", source, symbol: normalized });
  };

  for (const fact of facts) {
    if (
      fact.kind === "command_contract" &&
      (fact.relation === "invoke" || fact.relation === "transport") &&
      fact.command &&
      !handlerCommands.has(fact.command.toLowerCase())
    ) searchSymbol(fact.command, "contract_counterpart");
    if (
      fact.kind === "event_contract" &&
      (fact.relation === "emit" || fact.relation === "dom_dispatch") &&
      !listenerEvents.has(fact.event.toLowerCase())
    ) searchSymbol(fact.event, "contract_counterpart");
    if (fact.kind === "symbol_relation" && fact.relation === "listener_calls") {
      for (const symbol of fact.symbols) {
        if (objectiveExplicitlyReferencesSymbol(input.objective || "", symbol)) {
          searchSymbol(symbol, "call_chain");
        }
      }
    }
  }

  return obligations;
}

export function formatPlanEvidenceObligation(obligation: PlanEvidenceObligation): string {
  if (obligation.kind === "read_target") {
    const occurrence = obligation.occurrence;
    const range = occurrence
      ? `@L${occurrence.startLine}${occurrence.endLine !== occurrence.startLine ? `-${occurrence.endLine}` : ""}`
      : "";
    return `read_file:${obligation.targetRef || ""}${range}`;
  }
  return `find_symbol_references:${obligation.symbol || ""}`;
}

export function resolvePlanEvidenceOccurrenceReadWindow(
  occurrence: PlanEvidenceOccurrenceRange,
): { start_line: number; end_line: number; max_lines: number; max_chars: number } {
  const startLine = Math.max(1, Math.floor(occurrence.startLine));
  const endLine = Math.max(startLine, Math.floor(occurrence.endLine));
  const windowStart = Math.max(1, startLine - OCCURRENCE_CONTEXT_BEFORE_LINES);
  const windowEnd = Math.max(endLine, endLine + OCCURRENCE_CONTEXT_AFTER_LINES);
  return {
    start_line: windowStart,
    end_line: windowEnd,
    max_lines: windowEnd - windowStart + 1,
    max_chars: OCCURRENCE_READ_MAX_CHARS,
  };
}

/**
 * Resolve the single runtime primitive that can close an evidence obligation.
 * Keeping this mapping next to obligation derivation prevents prompts, tool
 * schemas, and execution admission from inventing different interpretations.
 */
export function getPlanEvidenceObligationToolName(
  obligation: PlanEvidenceObligation,
): PlanEvidenceObligationToolName {
  return obligation.kind === "read_target" ? "read_file" : "find_symbol_references";
}

/**
 * Runtime-owned canonical arguments for one evidence transaction. The model
 * may choose to satisfy the exposed contract, but it cannot redirect the
 * transaction to a different path/symbol. A symbol lookup is workspace-wide;
 * an untrusted model-authored path must not silently narrow it.
 */
export function canonicalizePlanEvidenceObligationArgs(
  obligation: PlanEvidenceObligation,
  args: Record<string, unknown>,
): Record<string, unknown> {
  if (obligation.kind === "read_target") {
    const occurrenceWindow = obligation.occurrence
      ? resolvePlanEvidenceOccurrenceReadWindow(obligation.occurrence)
      : undefined;
    return {
      ...args,
      path: String(obligation.targetRef || "").trim(),
      ...(occurrenceWindow || {}),
    };
  }
  const { path: _untrustedPath, ...rest } = args;
  return {
    ...rest,
    symbol: String(obligation.symbol || "").trim(),
  };
}

/**
 * This card is injected on every needs_evidence iteration, not only when the
 * transaction first opens. It is structured runtime state; natural-language
 * child summaries and assistant prose never participate.
 */
export function buildPlanEvidenceObligationContractCard(
  obligation: PlanEvidenceObligation,
): string {
  const tool = getPlanEvidenceObligationToolName(obligation);
  const args = obligation.kind === "read_target"
    ? {
        path: String(obligation.targetRef || "").trim(),
        ...(obligation.occurrence
          ? resolvePlanEvidenceOccurrenceReadWindow(obligation.occurrence)
          : {}),
      }
    : { symbol: String(obligation.symbol || "").trim() };
  return [
    "[PLAN_EVIDENCE_ACTION_CONTRACT]",
    `obligation=${formatPlanEvidenceObligation(obligation)}`,
    `availableTools=${tool}`,
    `requiredArguments=${JSON.stringify(args)}`,
    "Call exactly the available tool for this obligation. MAIN canonicalizes its runtime-owned path/symbol/range and reassesses the ledger after the result.",
    "Do not substitute a different read, search, inferred path, plan draft, or source mutation while this obligation is open.",
  ].join("\n");
}
