import { workspacePathsReferToSameFile } from "./workspacePaths";

export type DirectEditTransactionPhase =
  | "inspect"
  | "mutate"
  | "validate"
  | "audit";

export interface DirectEditMutationReceipt {
  target: string;
  requirementRef?: string | null;
}

export interface DirectEditValidationReceipt {
  tool: string;
  target: string;
  revision: number;
  /**
   * Bounded runtime-owned observation from the successful validation. This is
   * carried into the closure audit so a compacted model context does not have
   * to reconstruct user-visible outcomes from a command label alone.
   */
  summary?: string;
}

/**
 * Parent-owned state for one read -> edit -> validate -> audit transaction.
 *
 * Presence means the objective is still open. Phase replaces the former
 * collection of objective* booleans and evidence mirrors.
 */
export interface DirectEditTransaction {
  obligationId: string;
  revision: number;
  kind: "root" | "requirement";
  phase: DirectEditTransactionPhase;
  expectedTargets: string[];
  mutations: DirectEditMutationReceipt[];
  validation: DirectEditValidationReceipt | null;
}

function normalizeTarget(value: unknown): string {
  return String(value || "").trim().replace(/\\/g, "/");
}

function normalizeValidationSummary(value: unknown): string {
  return String(value || "")
    .replace(/\u0000/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1_200);
}

function appendDistinctTargets(
  current: readonly string[],
  additions: readonly string[],
): string[] {
  return additions.reduce<string[]>((targets, value) => {
    const target = normalizeTarget(value);
    if (
      !target ||
      targets.some((entry) => workspacePathsReferToSameFile(entry, target))
    ) {
      return targets;
    }
    return [...targets, target].slice(-32);
  }, [...current]);
}

function appendMutationReceipts(
  current: readonly DirectEditMutationReceipt[],
  targets: readonly string[],
  requirementRef: string | null,
): DirectEditMutationReceipt[] {
  return targets.reduce<DirectEditMutationReceipt[]>((receipts, value) => {
    const target = normalizeTarget(value);
    if (!target) return receipts;
    const alreadyRecorded = receipts.some((entry) =>
      workspacePathsReferToSameFile(entry.target, target) &&
      String(entry.requirementRef || "").toLowerCase() ===
        String(requirementRef || "").toLowerCase()
    );
    return alreadyRecorded
      ? receipts
      : [
          ...receipts,
          { target, ...(requirementRef ? { requirementRef } : {}) },
        ].slice(-32);
  }, [...current]);
}

export function normalizeDirectEditTransactionSnapshot(
  value: unknown,
): DirectEditTransaction | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Partial<DirectEditTransaction>;
  const obligationId = String(candidate.obligationId || "").trim();
  const kind = candidate.kind === "requirement" ? "requirement" : "root";
  const phases = new Set<DirectEditTransactionPhase>([
    "inspect",
    "mutate",
    "validate",
    "audit",
  ]);
  const phase = candidate.phase && phases.has(candidate.phase)
    ? candidate.phase
    : "mutate";
  const expectedTargets = appendDistinctTargets(
    [],
    Array.isArray(candidate.expectedTargets) ? candidate.expectedTargets : [],
  );
  const mutations = Array.isArray(candidate.mutations)
    ? candidate.mutations.reduce<DirectEditMutationReceipt[]>((receipts, entry) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) return receipts;
        return appendMutationReceipts(
          receipts,
          [String(entry.target || "")],
          String(entry.requirementRef || "").trim() || null,
        );
      }, [])
    : [];
  const validationCandidate = candidate.validation;
  const validation = validationCandidate &&
    typeof validationCandidate === "object" &&
    !Array.isArray(validationCandidate)
      ? (() => {
          const tool = String(validationCandidate.tool || "").trim();
          const target = String(validationCandidate.target || "").trim();
          const revision = Math.max(
            1,
            Math.floor(Number(validationCandidate.revision) || 1),
          );
          const summary = normalizeValidationSummary(validationCandidate.summary);
          return tool && target
            ? { tool, target, revision, ...(summary ? { summary } : {}) }
            : null;
        })()
      : null;
  if (!obligationId && expectedTargets.length === 0 && mutations.length === 0) {
    return null;
  }
  return {
    obligationId: obligationId || (
      kind === "requirement" ? "requirement:direct-edit" : "root:direct-edit"
    ),
    revision: Math.max(1, Math.floor(Number(candidate.revision) || 1)),
    kind,
    phase,
    expectedTargets,
    mutations,
    validation,
  };
}

/**
 * One-way compatibility bridge for persisted checkpoints written before the
 * transaction object replaced the seven objective* fields.
 */
export function migrateLegacyDirectEditTransaction(
  value: Record<string, unknown>,
): DirectEditTransaction | null {
  const explicit = normalizeDirectEditTransactionSnapshot(value.directEditTransaction);
  if (explicit) return explicit;

  const legacyMutations = Array.isArray(value.objectiveMutationEvidence)
    ? value.objectiveMutationEvidence
    : [];
  const legacyTargets = Array.isArray(value.objectiveExpectedTargets)
    ? value.objectiveExpectedTargets
    : [];
  const hasLegacyState =
    value.objectiveClosurePending === true ||
    legacyMutations.length > 0 ||
    legacyTargets.length > 0 ||
    Boolean(String(value.objectiveObligationId || "").trim());
  if (!hasLegacyState) return null;

  const validation = value.objectiveValidationEvidence;
  const normalizedValidation = validation &&
    typeof validation === "object" &&
    !Array.isArray(validation)
      ? validation
      : null;
  return normalizeDirectEditTransactionSnapshot({
    obligationId:
      String(value.objectiveObligationId || "").trim() || "root:direct-edit",
    revision: value.objectiveRevision,
    kind: value.objectiveKind === "requirement" ? "requirement" : "root",
    phase: normalizedValidation
      ? value.objectiveKind === "requirement" ? "validate" : "audit"
      : legacyMutations.length > 0 ? "validate" : "mutate",
    expectedTargets: legacyTargets,
    mutations: legacyMutations,
    validation: normalizedValidation,
  });
}

export function resolveDirectEditTransaction(
  checkpoint: unknown,
): DirectEditTransaction | null {
  return checkpoint && typeof checkpoint === "object" && !Array.isArray(checkpoint)
    ? migrateLegacyDirectEditTransaction(checkpoint as Record<string, unknown>)
    : null;
}

export function setDirectEditTransactionPhase(
  transaction: DirectEditTransaction | null | undefined,
  phase: DirectEditTransactionPhase,
): DirectEditTransaction | null {
  return transaction ? { ...transaction, phase } : null;
}

export function expectDirectEditTargets(input: {
  transaction: DirectEditTransaction | null | undefined;
  targets: readonly string[];
  requirementRef?: string | null;
  planTaskId?: string | null;
  phase: "inspect" | "mutate";
}): DirectEditTransaction {
  const requirementRef = String(input.requirementRef || "").trim() || null;
  const planTaskId = String(input.planTaskId || "").trim() || null;
  const kind = requirementRef || planTaskId ? "requirement" : "root";
  const transaction = input.transaction || {
    obligationId: requirementRef
      ? `requirement:${requirementRef.toLowerCase()}`
      : planTaskId
        ? `task:${planTaskId.toLowerCase()}`
        : "root:direct-edit",
    revision: 1,
    kind,
    phase: input.phase,
    expectedTargets: [],
    mutations: [],
    validation: null,
  };
  return {
    ...transaction,
    kind,
    phase: input.phase,
    expectedTargets: appendDistinctTargets(transaction.expectedTargets, input.targets),
  };
}

export function recordDirectEditMutation(input: {
  transaction: DirectEditTransaction | null | undefined;
  expectedTargets: readonly string[];
  mutationTargets: readonly string[];
  requirementRef?: string | null;
  planTaskId?: string | null;
}): DirectEditTransaction {
  const expected = expectDirectEditTargets({
    transaction: input.transaction,
    targets: [...input.expectedTargets, ...input.mutationTargets],
    requirementRef: input.requirementRef,
    planTaskId: input.planTaskId,
    phase: "mutate",
  });
  const opensNewRevision = Boolean(
    expected.validation &&
    expected.validation.revision === expected.revision
  );
  const revision = opensNewRevision ? expected.revision + 1 : expected.revision;
  return {
    ...expected,
    revision,
    phase: "validate",
    mutations: appendMutationReceipts(
      expected.mutations,
      input.mutationTargets,
      String(input.requirementRef || "").trim() || null,
    ),
    validation: null,
  };
}

export function resolveDirectEditMutationCoverage(input: {
  transaction: DirectEditTransaction | null | undefined;
  fallbackTarget?: string | null;
}): {
  covered: boolean;
  missingTargets: string[];
  kind: "root" | "requirement";
} {
  const transaction = input.transaction;
  const kind = transaction?.kind || "root";
  const expectedTargets = transaction?.expectedTargets.length
    ? transaction.expectedTargets
    : input.fallbackTarget
      ? [input.fallbackTarget]
      : [];
  const requirementRef = transaction?.mutations
    .map((entry) => String(entry.requirementRef || "").trim().toLowerCase())
    .find(Boolean) || "";
  const mutations = transaction?.mutations || [];
  const missingTargets = expectedTargets.filter((target) => !mutations.some((entry) =>
    workspacePathsReferToSameFile(entry.target, target) &&
    (
      kind === "root" ||
      !requirementRef ||
      String(entry.requirementRef || "").trim().toLowerCase() === requirementRef
    )
  ));
  return {
    covered: expectedTargets.length > 0 && missingTargets.length === 0,
    missingTargets,
    kind,
  };
}

export function recordDirectEditValidation(input: {
  transaction: DirectEditTransaction;
  tool: string;
  target: string;
  summary?: string | null;
  fallbackTarget?: string | null;
}): {
  transaction: DirectEditTransaction;
  coverage: ReturnType<typeof resolveDirectEditMutationCoverage>;
} {
  const coverage = resolveDirectEditMutationCoverage({
    transaction: input.transaction,
    fallbackTarget: input.fallbackTarget,
  });
  return {
    coverage,
    transaction: {
      ...input.transaction,
      kind: coverage.kind,
      phase: coverage.covered && coverage.kind === "root" ? "audit" : "validate",
      validation: {
        tool: input.tool || "validation",
        target: input.target,
        revision: input.transaction.revision,
        ...(
          normalizeValidationSummary(input.summary)
            ? { summary: normalizeValidationSummary(input.summary) }
            : {}
        ),
      },
    },
  };
}

export function directEditTransactionHasCurrentClosureEvidence(
  transaction: DirectEditTransaction | null | undefined,
  fallbackTarget?: string | null,
): boolean {
  if (
    !transaction ||
    transaction.kind !== "root" ||
    transaction.phase !== "audit" ||
    transaction.validation?.revision !== transaction.revision
  ) {
    return false;
  }
  return resolveDirectEditMutationCoverage({
    transaction,
    fallbackTarget,
  }).covered;
}
