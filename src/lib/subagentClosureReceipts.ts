import type { PlanToolActivitySummary } from "./planExecutionRecovery";
import {
  isPreferredDelegationEvidenceTargetWithinScope,
  normalizePreferredDelegationScopeContract,
  type PreferredDelegationScopeContract,
} from "./preferredDelegationScopes";
import { sha256Hex } from "./sha256";
import { normalizeWorkspacePathIdentity } from "./workspacePaths";

export const SUBAGENT_CLOSURE_RECEIPT_SCHEMA_VERSION =
  "subagent-closure-receipt.v1" as const;
export const SUBAGENT_CLOSURE_RECEIPT_LEDGER_SCHEMA_VERSION =
  "subagent-closure-receipt-ledger.v1" as const;
export const MAX_DURABLE_SUBAGENT_CLOSURE_RECEIPTS = 48;
export const MAX_DURABLE_SUBAGENT_CLOSURE_EVIDENCE_PER_RECEIPT = 24;

const MAX_DURABLE_SUBAGENT_CLOSURE_LEDGER_CHARS = 1_048_576;
const MAX_DURABLE_SUBAGENT_CLOSURE_RECEIPT_CHARS = 262_144;
const MAX_DURABLE_SUBAGENT_CLOSURE_STRING_CHARS = 8_192;
const TOOL_ACTIVITY_STATUSES = new Set(["succeeded", "failed", "blocked", "running"]);

export interface SubagentClosureReceiptLedgerOwner {
  workspaceKey: string;
  sessionKey: string;
  sessionEpoch: string;
}

export interface SubagentClosureReceiptOwner extends SubagentClosureReceiptLedgerOwner {
  parentTurnId: string;
  parentRunId: string;
}

export interface CanonicalSubagentClosureEvidence {
  evidenceId: string;
  activityDigest: string;
  contentHash: string;
  activity: PlanToolActivitySummary;
}

export interface CanonicalSubagentClosureReceipt {
  schemaVersion: typeof SUBAGENT_CLOSURE_RECEIPT_SCHEMA_VERSION;
  receiptId: string;
  digest: string;
  owner: SubagentClosureReceiptOwner;
  subagentId: string;
  scopeKey: string;
  allowedPaths: string[];
  closureState: "satisfied";
  acceptedEvidence: CanonicalSubagentClosureEvidence[];
  issuedAt: number;
}

export interface SubagentClosureReceiptLedger {
  schemaVersion: typeof SUBAGENT_CLOSURE_RECEIPT_LEDGER_SCHEMA_VERSION;
  revision: number;
  owner: SubagentClosureReceiptLedgerOwner;
  receipts: CanonicalSubagentClosureReceipt[];
  updatedAt: number;
}

export interface SubagentClosureReceiptExpectedOwner {
  workspaceKey?: string | null;
  sessionKey?: string | null;
  sessionEpoch?: string | null;
}

function requiredString(value: unknown): string | null {
  return typeof value === "string" &&
      value.length > 0 &&
      value.length <= MAX_DURABLE_SUBAGENT_CLOSURE_STRING_CHARS &&
      value === value.trim()
    ? value
    : null;
}

function finiteTimestamp(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function safePositiveInteger(value: unknown): number | null {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 1 ? number : null;
}

function isBoundedJsonValue(value: unknown, maxChars: number): boolean {
  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === "string" && serialized.length <= maxChars;
  } catch {
    return false;
  }
}

function canonicalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalizeJson(entry)]),
  );
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalizeJson(value));
}

function sameJson(left: unknown, right: unknown): boolean {
  try {
    return canonicalJson(left) === canonicalJson(right);
  } catch {
    return false;
  }
}

function jsonSafeObject<T>(value: unknown, maxChars = 65_536): T | undefined {
  if (value === undefined) return undefined;
  try {
    const serialized = JSON.stringify(value);
    if (!serialized || serialized.length > maxChars) return undefined;
    const parsed = JSON.parse(serialized);
    return parsed && typeof parsed === "object" ? parsed as T : undefined;
  } catch {
    return undefined;
  }
}

function normalizeOwner(value: unknown): SubagentClosureReceiptLedgerOwner | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const workspaceKey = requiredString(record.workspaceKey);
  const sessionKey = requiredString(record.sessionKey);
  const sessionEpoch = requiredString(record.sessionEpoch);
  return workspaceKey && sessionKey && sessionEpoch
    ? { workspaceKey, sessionKey, sessionEpoch }
    : null;
}

function normalizeReceiptOwner(value: unknown): SubagentClosureReceiptOwner | null {
  const base = normalizeOwner(value);
  if (!base || !value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const parentTurnId = requiredString(record.parentTurnId);
  const parentRunId = requiredString(record.parentRunId);
  return parentTurnId && parentRunId ? { ...base, parentTurnId, parentRunId } : null;
}

function canonicalAllowedPaths(values: Iterable<unknown>): string[] {
  return [...new Set([...values]
    .map((value) => normalizeWorkspacePathIdentity(String(value || "")))
    .filter((value) => value && value !== "."))]
    .sort((left, right) => left.localeCompare(right));
}

/**
 * Normalize the exact runtime-owned child observation that may be sealed in a
 * closure receipt. Child summary prose and unresolved/partial observations are
 * deliberately excluded from this durable trust boundary.
 */
export function normalizeCanonicalSubagentClosureActivity(
  value: unknown,
): PlanToolActivitySummary | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const name = requiredString(record.name);
  const target = requiredString(record.target);
  const status = requiredString(record.status);
  const delegated = record.delegatedObservation &&
      typeof record.delegatedObservation === "object" &&
      !Array.isArray(record.delegatedObservation)
    ? record.delegatedObservation as Record<string, unknown>
    : null;
  const owner = delegated?.owner && typeof delegated.owner === "object" &&
      !Array.isArray(delegated.owner)
    ? delegated.owner as Record<string, unknown>
    : null;
  const subagentId = requiredString(owner?.subagentId);
  const sourceToolCallId = requiredString(delegated?.sourceToolCallId);
  const sourceObservationKey = requiredString(delegated?.sourceObservationKey);
  if (
    !name ||
    !target ||
    !status ||
    !TOOL_ACTIVITY_STATUSES.has(status) ||
    status !== "succeeded" ||
    owner?.agentKind !== "subagent" ||
    !subagentId ||
    (!sourceToolCallId && !sourceObservationKey) ||
    delegated?.planningEvidenceState !== "reusable" ||
    delegated?.joinState !== "consumed" ||
    delegated?.closureState !== "satisfied" ||
    (delegated?.parentContextState !== "reference_only" &&
      delegated?.parentContextState !== "version_verified")
  ) return null;
  const sourceContentChars = delegated.sourceContentChars === undefined
    ? undefined
    : Number(delegated.sourceContentChars);
  if (
    sourceContentChars !== undefined &&
    (!Number.isFinite(sourceContentChars) || sourceContentChars < 0)
  ) return null;
  const structuredFacts = jsonSafeObject<NonNullable<PlanToolActivitySummary["structuredFacts"]>>(
    record.structuredFacts,
  );
  const discoveryObservation = jsonSafeObject<NonNullable<PlanToolActivitySummary["discoveryObservation"]>>(
    record.discoveryObservation,
  );
  const evidenceObligation = jsonSafeObject<NonNullable<PlanToolActivitySummary["evidenceObligation"]>>(
    record.evidenceObligation,
  );
  const obligationClosure = jsonSafeObject<NonNullable<PlanToolActivitySummary["obligationClosure"]>>(
    record.obligationClosure,
  );
  const readFileObservation = jsonSafeObject<NonNullable<PlanToolActivitySummary["readFileObservation"]>>(
    record.readFileObservation,
  );
  const astObservation = jsonSafeObject<NonNullable<PlanToolActivitySummary["astObservation"]>>(
    record.astObservation,
  );
  const sourceRange = jsonSafeObject<NonNullable<PlanToolActivitySummary["delegatedObservation"]>["sourceRange"]>(
    delegated.sourceRange,
    4_096,
  );
  return {
    name,
    target,
    status: status as PlanToolActivitySummary["status"],
    ...(typeof record.detail === "string" && record.detail.trim()
      ? { detail: record.detail.trim().slice(0, 440) }
      : {}),
    ...(record.mutationObserved === true ? { mutationObserved: true } : {}),
    ...(Array.isArray(record.facts)
      ? {
          facts: record.facts.slice(0, 64)
            .map((fact) => String(fact || "").trim())
            .filter(Boolean)
            .map((fact) => fact.slice(0, 600)),
        }
      : {}),
    ...(structuredFacts ? { structuredFacts } : {}),
    ...(discoveryObservation ? { discoveryObservation } : {}),
    ...(evidenceObligation ? { evidenceObligation } : {}),
    ...(obligationClosure ? { obligationClosure } : {}),
    ...(readFileObservation ? { readFileObservation } : {}),
    ...(astObservation ? { astObservation } : {}),
    delegatedObservation: {
      owner: {
        agentKind: "subagent",
        subagentId,
        ...(requiredString(owner.parentTurnId)
          ? { parentTurnId: requiredString(owner.parentTurnId)! }
          : {}),
        ...(requiredString(owner.runId) ? { runId: requiredString(owner.runId)! } : {}),
      },
      ...(sourceToolCallId ? { sourceToolCallId } : {}),
      ...(sourceObservationKey ? { sourceObservationKey } : {}),
      ...(requiredString(delegated.sourceVersion)
        ? { sourceVersion: requiredString(delegated.sourceVersion)! }
        : {}),
      ...(requiredString(delegated.sourceContentHash)
        ? { sourceContentHash: requiredString(delegated.sourceContentHash)! }
        : {}),
      ...(sourceContentChars !== undefined ? { sourceContentChars } : {}),
      ...(sourceRange ? { sourceRange } : {}),
      planningEvidenceState: "reusable",
      joinState: "consumed",
      closureState: "satisfied",
      parentContextState: delegated.parentContextState,
      requiresParentReread: delegated.requiresParentReread === true,
    },
  };
}

function activityDigest(activity: PlanToolActivitySummary): string {
  return sha256Hex(canonicalJson(activity));
}

function evidenceIdentity(input: {
  subagentId: string;
  activity: PlanToolActivitySummary;
  activityDigest: string;
}): string {
  const delegated = input.activity.delegatedObservation!;
  return sha256Hex(canonicalJson({
    subagentId: input.subagentId,
    sourceToolCallId: delegated.sourceToolCallId || null,
    sourceObservationKey: delegated.sourceObservationKey || null,
    name: input.activity.name,
    target: normalizeWorkspacePathIdentity(input.activity.target),
    activityDigest: input.activityDigest,
  }));
}

function buildCanonicalEvidence(
  activity: PlanToolActivitySummary,
  subagentId: string,
): CanonicalSubagentClosureEvidence {
  const digest = activityDigest(activity);
  return {
    evidenceId: evidenceIdentity({ subagentId, activity, activityDigest: digest }),
    activityDigest: digest,
    contentHash: activity.delegatedObservation?.sourceContentHash || digest,
    activity,
  };
}

function receiptBody(receipt: Omit<CanonicalSubagentClosureReceipt, "receiptId" | "digest">) {
  return receipt;
}

function sealReceipt(
  body: Omit<CanonicalSubagentClosureReceipt, "receiptId" | "digest">,
): CanonicalSubagentClosureReceipt {
  const digest = sha256Hex(canonicalJson(receiptBody(body)));
  return {
    ...body,
    receiptId: `subagent-closure:${digest}`,
    digest,
  };
}

function normalizeEvidence(
  value: unknown,
  subagentId: string,
  allowedPaths: string[],
): CanonicalSubagentClosureEvidence | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const activity = normalizeCanonicalSubagentClosureActivity(record.activity);
  if (
    !activity ||
    activity.delegatedObservation?.owner.subagentId !== subagentId ||
    !isPreferredDelegationEvidenceTargetWithinScope(allowedPaths, activity.target)
  ) return null;
  const canonical = buildCanonicalEvidence(activity, subagentId);
  return record.evidenceId === canonical.evidenceId &&
      record.activityDigest === canonical.activityDigest &&
      record.contentHash === canonical.contentHash
    ? canonical
    : null;
}

function normalizeReceipt(
  value: unknown,
  ledgerOwner: SubagentClosureReceiptLedgerOwner,
): CanonicalSubagentClosureReceipt | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (!isBoundedJsonValue(value, MAX_DURABLE_SUBAGENT_CLOSURE_RECEIPT_CHARS)) return null;
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== SUBAGENT_CLOSURE_RECEIPT_SCHEMA_VERSION) return null;
  const receiptId = requiredString(record.receiptId);
  const digest = requiredString(record.digest);
  const owner = normalizeReceiptOwner(record.owner);
  const subagentId = requiredString(record.subagentId);
  const scopeKey = requiredString(record.scopeKey);
  const issuedAt = finiteTimestamp(record.issuedAt);
  const allowedPaths = Array.isArray(record.allowedPaths)
    ? canonicalAllowedPaths(record.allowedPaths)
    : [];
  if (
    !receiptId ||
    !digest ||
    !owner ||
    !sameJson(
      {
        workspaceKey: owner.workspaceKey,
        sessionKey: owner.sessionKey,
        sessionEpoch: owner.sessionEpoch,
      },
      ledgerOwner,
    ) ||
    !subagentId ||
    !scopeKey ||
    issuedAt === null ||
    allowedPaths.length === 0 ||
    record.closureState !== "satisfied" ||
    !Array.isArray(record.acceptedEvidence) ||
    record.acceptedEvidence.length === 0 ||
    record.acceptedEvidence.length > MAX_DURABLE_SUBAGENT_CLOSURE_EVIDENCE_PER_RECEIPT
  ) return null;
  const acceptedEvidence = record.acceptedEvidence.map((evidence) =>
    normalizeEvidence(evidence, subagentId, allowedPaths)
  );
  if (acceptedEvidence.some((evidence) => !evidence)) return null;
  const uniqueEvidence = acceptedEvidence as CanonicalSubagentClosureEvidence[];
  if (new Set(uniqueEvidence.map((evidence) => evidence.evidenceId)).size !== uniqueEvidence.length) {
    return null;
  }
  const body = {
    schemaVersion: SUBAGENT_CLOSURE_RECEIPT_SCHEMA_VERSION,
    owner,
    subagentId,
    scopeKey,
    allowedPaths,
    closureState: "satisfied" as const,
    acceptedEvidence: uniqueEvidence,
    issuedAt,
  };
  const sealed = sealReceipt(body);
  return receiptId === sealed.receiptId && digest === sealed.digest ? sealed : null;
}

export function isSubagentClosureReceiptLedgerOwnerMatch(
  ledger: Pick<SubagentClosureReceiptLedger, "owner">,
  expected: SubagentClosureReceiptExpectedOwner,
): boolean {
  return (!expected.workspaceKey || ledger.owner.workspaceKey === expected.workspaceKey) &&
    (!expected.sessionKey || ledger.owner.sessionKey === expected.sessionKey) &&
    (!expected.sessionEpoch || ledger.owner.sessionEpoch === expected.sessionEpoch);
}

export function normalizeSubagentClosureReceiptLedger(
  value: unknown,
  options?: { expectedOwner?: SubagentClosureReceiptExpectedOwner },
): SubagentClosureReceiptLedger | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (!isBoundedJsonValue(value, MAX_DURABLE_SUBAGENT_CLOSURE_LEDGER_CHARS)) return null;
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== SUBAGENT_CLOSURE_RECEIPT_LEDGER_SCHEMA_VERSION) return null;
  const revision = safePositiveInteger(record.revision);
  const owner = normalizeOwner(record.owner);
  const updatedAt = finiteTimestamp(record.updatedAt);
  if (!revision || !owner || updatedAt === null || !Array.isArray(record.receipts)) return null;
  if (record.receipts.length > MAX_DURABLE_SUBAGENT_CLOSURE_RECEIPTS) return null;
  if (options?.expectedOwner && !isSubagentClosureReceiptLedgerOwnerMatch(
    { owner },
    options.expectedOwner,
  )) return null;
  const receipts = record.receipts.map((receipt) => normalizeReceipt(receipt, owner));
  if (receipts.some((receipt) => !receipt)) return null;
  const canonicalReceipts = receipts as CanonicalSubagentClosureReceipt[];
  if (new Set(canonicalReceipts.map((receipt) => receipt.receiptId)).size !== canonicalReceipts.length) {
    return null;
  }
  const ownerKeys = new Set<string>();
  for (const receipt of canonicalReceipts) {
    const key = [
      receipt.owner.parentTurnId,
      receipt.owner.parentRunId,
      receipt.subagentId,
      receipt.scopeKey,
    ].join("\u001f");
    if (ownerKeys.has(key)) return null;
    ownerKeys.add(key);
  }
  return {
    schemaVersion: SUBAGENT_CLOSURE_RECEIPT_LEDGER_SCHEMA_VERSION,
    revision,
    owner,
    receipts: canonicalReceipts,
    updatedAt,
  };
}

export function createSubagentClosureReceiptLedger(input: {
  owner: SubagentClosureReceiptLedgerOwner;
  now?: number;
}): SubagentClosureReceiptLedger {
  const ledger = normalizeSubagentClosureReceiptLedger({
    schemaVersion: SUBAGENT_CLOSURE_RECEIPT_LEDGER_SCHEMA_VERSION,
    revision: 1,
    owner: input.owner,
    receipts: [],
    updatedAt: input.now ?? Date.now(),
  });
  if (!ledger) throw new Error("Invalid subagent closure receipt ledger owner");
  return ledger;
}

function sameReceiptEvidence(
  receipt: CanonicalSubagentClosureReceipt,
  evidence: CanonicalSubagentClosureEvidence[],
): boolean {
  return sameJson(
    receipt.acceptedEvidence.map((entry) => entry.evidenceId),
    evidence.map((entry) => entry.evidenceId),
  );
}

export function issueSubagentClosureReceipts(input: {
  ledger: SubagentClosureReceiptLedger | null | undefined;
  owner: SubagentClosureReceiptOwner;
  contract: PreferredDelegationScopeContract | null;
  activities: PlanToolActivitySummary[];
  issuedAt?: number;
}): {
  ledger: SubagentClosureReceiptLedger;
  receiptRefs: string[];
  missingConsumedScopeKeys: string[];
} {
  const ledgerOwner = {
    workspaceKey: input.owner.workspaceKey,
    sessionKey: input.owner.sessionKey,
    sessionEpoch: input.owner.sessionEpoch,
  };
  const current = input.ledger
    ? normalizeSubagentClosureReceiptLedger(input.ledger, { expectedOwner: ledgerOwner })
    : createSubagentClosureReceiptLedger({ owner: ledgerOwner, now: input.issuedAt });
  if (!current) throw new Error("SUBAGENT_CLOSURE_LEDGER_OWNER_MISMATCH");
  const contract = normalizePreferredDelegationScopeContract(input.contract);
  if (!contract) {
    return { ledger: current, receiptRefs: [], missingConsumedScopeKeys: [] };
  }
  const issuedAt = finiteTimestamp(input.issuedAt) ?? Date.now();
  const normalizedActivities = input.activities
    .map(normalizeCanonicalSubagentClosureActivity)
    .filter((activity): activity is PlanToolActivitySummary => !!activity);
  let receipts = [...current.receipts];
  const receiptRefs: string[] = [];
  const missingConsumedScopeKeys: string[] = [];
  let changed = false;
  for (const registration of contract.registrations) {
    if (registration.state !== "consumed") continue;
    const allowedPaths = canonicalAllowedPaths(registration.allowedPaths);
    const activities = normalizedActivities.filter((activity) => {
      const delegated = activity.delegatedObservation;
      return delegated?.owner.subagentId === registration.subagentId &&
        (!delegated.owner.parentTurnId || delegated.owner.parentTurnId === input.owner.parentTurnId) &&
        isPreferredDelegationEvidenceTargetWithinScope(allowedPaths, activity.target);
    }).slice(-MAX_DURABLE_SUBAGENT_CLOSURE_EVIDENCE_PER_RECEIPT);
    const acceptedEvidence = activities.map((activity) =>
      buildCanonicalEvidence(activity, registration.subagentId)
    );
    if (acceptedEvidence.length === 0) {
      missingConsumedScopeKeys.push(registration.requiredScopeKey);
      continue;
    }
    const existing = receipts.find((receipt) =>
      receipt.owner.parentTurnId === input.owner.parentTurnId &&
      receipt.owner.parentRunId === input.owner.parentRunId &&
      receipt.subagentId === registration.subagentId &&
      receipt.scopeKey === registration.requiredScopeKey &&
      sameJson(receipt.allowedPaths, allowedPaths) &&
      sameReceiptEvidence(receipt, acceptedEvidence)
    );
    if (existing) {
      receiptRefs.push(existing.receiptId);
      continue;
    }
    const nextReceipt = sealReceipt({
      schemaVersion: SUBAGENT_CLOSURE_RECEIPT_SCHEMA_VERSION,
      owner: { ...input.owner },
      subagentId: registration.subagentId,
      scopeKey: registration.requiredScopeKey,
      allowedPaths,
      closureState: "satisfied",
      acceptedEvidence,
      issuedAt,
    });
    receipts = receipts.filter((receipt) => !(
      receipt.owner.parentTurnId === input.owner.parentTurnId &&
      receipt.owner.parentRunId === input.owner.parentRunId &&
      receipt.subagentId === registration.subagentId &&
      receipt.scopeKey === registration.requiredScopeKey
    ));
    receipts.push(nextReceipt);
    receiptRefs.push(nextReceipt.receiptId);
    changed = true;
  }
  receipts = receipts
    .sort((left, right) => left.issuedAt - right.issuedAt)
    .slice(-MAX_DURABLE_SUBAGENT_CLOSURE_RECEIPTS);
  let candidate: SubagentClosureReceiptLedger = {
    schemaVersion: SUBAGENT_CLOSURE_RECEIPT_LEDGER_SCHEMA_VERSION,
    revision: changed ? current.revision + 1 : current.revision,
    owner: current.owner,
    receipts,
    updatedAt: changed ? Math.max(current.updatedAt, issuedAt) : current.updatedAt,
  };
  while (
    candidate.receipts.length > 0 &&
    !isBoundedJsonValue(candidate, MAX_DURABLE_SUBAGENT_CLOSURE_LEDGER_CHARS)
  ) {
    candidate = { ...candidate, receipts: candidate.receipts.slice(1) };
  }
  const normalized = normalizeSubagentClosureReceiptLedger(candidate, {
    expectedOwner: ledgerOwner,
  });
  if (!normalized) throw new Error("SUBAGENT_CLOSURE_LEDGER_SIZE_LIMIT");
  const retainedIds = new Set(normalized.receipts.map((receipt) => receipt.receiptId));
  return {
    ledger: normalized,
    receiptRefs: receiptRefs.filter((receiptId) => retainedIds.has(receiptId)),
    missingConsumedScopeKeys,
  };
}

export function findSubagentClosureReceipt(
  ledger: SubagentClosureReceiptLedger | null | undefined,
  receiptId: string,
): CanonicalSubagentClosureReceipt | null {
  const normalized = normalizeSubagentClosureReceiptLedger(ledger);
  if (!normalized) return null;
  return normalized.receipts.find((receipt) => receipt.receiptId === receiptId) || null;
}

/**
 * Resolve checkpoint references against the independent runtime-issued ledger.
 * This is an identity/scope join, not a signature check: the Session store is
 * trusted as an opaque CAS container, while model output and checkpoint-local
 * collaboration fields are treated as untrusted.
 */
export function resolveSubagentClosureReceiptReferences(input: {
  ledger: SubagentClosureReceiptLedger | null | undefined;
  receiptRefs: string[];
  expectedOwner: SubagentClosureReceiptLedgerOwner & {
    parentTurnId: string;
    parentRunId?: string;
    allowedParentRunIds?: string[];
  };
  contract: PreferredDelegationScopeContract | null;
}): {
  receipts: CanonicalSubagentClosureReceipt[];
  acceptedEvidence: CanonicalSubagentClosureEvidence[];
  resolvedReceiptRefs: string[];
  rejectedReceiptRefs: string[];
  consumedScopeKeys: string[];
} {
  const ledger = normalizeSubagentClosureReceiptLedger(input.ledger, {
    expectedOwner: input.expectedOwner,
  });
  const contract = normalizePreferredDelegationScopeContract(input.contract);
  const rejectedReceiptRefs: string[] = [];
  if (!ledger || !contract) {
    return {
      receipts: [],
      acceptedEvidence: [],
      resolvedReceiptRefs: [],
      rejectedReceiptRefs: [...input.receiptRefs],
      consumedScopeKeys: [],
    };
  }
  const allowedParentRunIds = new Set([
    ...(input.expectedOwner.parentRunId ? [input.expectedOwner.parentRunId] : []),
    ...(input.expectedOwner.allowedParentRunIds || []),
  ].filter(Boolean));
  const receiptsById = new Map(ledger.receipts.map((receipt) => [receipt.receiptId, receipt]));
  const receipts: CanonicalSubagentClosureReceipt[] = [];
  const consumedScopeKeys: string[] = [];
  const usedRegistrationKeys = new Set<string>();
  for (const receiptRef of input.receiptRefs) {
    const receipt = receiptsById.get(receiptRef);
    const registration = receipt
      ? contract.registrations.find((candidate) =>
          candidate.state === "consumed" &&
          candidate.subagentId === receipt.subagentId &&
          candidate.requiredScopeKey === receipt.scopeKey
        )
      : null;
    const registrationKey = registration
      ? `${registration.subagentId}\u001f${registration.requiredScopeKey}`
      : "";
    const ownerMatch = !!receipt &&
      receipt.owner.workspaceKey === input.expectedOwner.workspaceKey &&
      receipt.owner.sessionKey === input.expectedOwner.sessionKey &&
      receipt.owner.sessionEpoch === input.expectedOwner.sessionEpoch &&
      receipt.owner.parentTurnId === input.expectedOwner.parentTurnId &&
      allowedParentRunIds.has(receipt.owner.parentRunId);
    const scopeMatch = !!receipt && !!registration &&
      sameJson(receipt.allowedPaths, canonicalAllowedPaths(registration.allowedPaths)) &&
      receipt.acceptedEvidence.length > 0 &&
      receipt.acceptedEvidence.every((evidence) =>
        evidence.activity.delegatedObservation?.owner.subagentId === registration.subagentId &&
        isPreferredDelegationEvidenceTargetWithinScope(
          registration.allowedPaths,
          evidence.activity.target,
        )
      );
    if (
      !receipt ||
      !registration ||
      !ownerMatch ||
      !scopeMatch ||
      usedRegistrationKeys.has(registrationKey)
    ) {
      rejectedReceiptRefs.push(receiptRef);
      continue;
    }
    usedRegistrationKeys.add(registrationKey);
    receipts.push(receipt);
    consumedScopeKeys.push(registration.requiredScopeKey);
  }
  return {
    receipts,
    acceptedEvidence: receipts.flatMap((receipt) => receipt.acceptedEvidence),
    resolvedReceiptRefs: receipts.map((receipt) => receipt.receiptId),
    rejectedReceiptRefs,
    consumedScopeKeys,
  };
}
