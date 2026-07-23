import { sha256Hex } from "./sha256";
import type { TypedPlanDraftV1 } from "./planDraftIngress";
import {
  SUBMIT_PLAN_CANDIDATE_TOOL_NAME,
  type ToolDefinition,
} from "./toolSchemas";

export const PLAN_CANDIDATE_REPAIR_CONTRACT_VERSION = 1 as const;
export const MAX_TYPED_PLAN_INITIAL_OUTPUT_CHARS = 48_000;
export const MAX_TYPED_PLAN_REPAIR_OUTPUT_CHARS = 12_000;
export const MAX_TYPED_PLAN_REPAIR_ATTEMPTS = 2;
export const MAX_TYPED_PLAN_REPAIR_CUMULATIVE_CHARS =
  MAX_TYPED_PLAN_INITIAL_OUTPUT_CHARS +
  MAX_TYPED_PLAN_REPAIR_ATTEMPTS * MAX_TYPED_PLAN_REPAIR_OUTPUT_CHARS;
export const MAX_TYPED_PLAN_REPAIR_OPERATIONS = 12;
export const MAX_TYPED_PLAN_REPAIR_PROMPT_CHARS = 24_000;

export type PlanCandidateRepairNodeKind =
  | "goal_basis"
  | "diagnosis"
  | "change"
  | "decision"
  | "validation";

export interface PlanCandidateRepairTarget {
  kind: PlanCandidateRepairNodeKind;
  /** Stable typed node identity when the submitted node supplied a valid ID. */
  id?: string;
  /** One-based source-array position for malformed or duplicate identities. */
  index?: number;
}

export interface PlanCandidateRepairCheckpoint {
  version: typeof PLAN_CANDIDATE_REPAIR_CONTRACT_VERSION;
  baseDraft: TypedPlanDraftV1;
  baseDraftHash: string;
  evidenceBundleHash: string;
  /** Hash of the runtime-issued receipt; never model-editable. */
  evidenceReceiptHash: string;
  failures: string[];
  invalidTargets: PlanCandidateRepairTarget[];
  addableKinds: PlanCandidateRepairNodeKind[];
  attempts: number;
  cumulativeOutputChars: number;
  exhausted: boolean;
  terminalReason?: string;
}

export interface PlanCandidateRepairOperation {
  kind: PlanCandidateRepairNodeKind;
  operation: "replace" | "add" | "remove";
  targetId?: string;
  targetIndex?: number;
  node?: unknown;
}

export interface PlanCandidateRepairPatch {
  schemaVersion: 2;
  repair: {
    contractVersion: typeof PLAN_CANDIDATE_REPAIR_CONTRACT_VERSION;
    baseDraftHash: string;
    operations: PlanCandidateRepairOperation[];
  };
}

export type PlanCandidateRepairSubmissionTransport =
  | "active_transport"
  | "native_tool"
  | "text_envelope";

export type PlanCandidateRepairEnvelopeResult =
  | { status: "absent" }
  | { status: "invalid"; failures: string[] }
  | { status: "parsed"; patch: PlanCandidateRepairPatch };

export type PlanCandidateRepairApplicationResult =
  | { ok: true; draft: TypedPlanDraftV1 }
  | { ok: false; failures: string[] };

const PLAN_CANDIDATE_BLOCK_RE =
  /<plan_candidate(?:\s+version=["']?2["']?)?\s*>([\s\S]*?)<\/plan_candidate>/gi;

const COLLECTIONS: Record<PlanCandidateRepairNodeKind, keyof Pick<
  TypedPlanDraftV1,
  "goalEvidenceBases" | "diagnoses" | "changes" | "decisions" | "validations"
>> = {
  goal_basis: "goalEvidenceBases",
  diagnosis: "diagnoses",
  change: "changes",
  decision: "decisions",
  validation: "validations",
};

const ID_PREFIXES: Record<PlanCandidateRepairNodeKind, string> = {
  goal_basis: "B",
  diagnosis: "R",
  change: "C",
  decision: "D",
  validation: "V",
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(",")}}`;
}

function boundedUnique(values: string[], maxItems = 32): string[] {
  return [...new Set(values
    .map((value) => String(value || "").trim().slice(0, 800))
    .filter(Boolean))]
    .slice(0, maxItems);
}

function nodeId(value: unknown, kind?: PlanCandidateRepairNodeKind): string {
  const item = record(value);
  return String(kind === "goal_basis" ? item?.componentRef : item?.id || "")
    .trim()
    .toUpperCase();
}

function targetKey(target: PlanCandidateRepairTarget): string {
  return `${target.kind}:${target.id || ""}:${target.index || 0}`;
}

function uniqueTargets(targets: PlanCandidateRepairTarget[]): PlanCandidateRepairTarget[] {
  const seen = new Set<string>();
  return targets.filter((target) => {
    const key = targetKey(target);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, MAX_TYPED_PLAN_REPAIR_OPERATIONS);
}

function kindForNodeId(id: string): PlanCandidateRepairNodeKind | null {
  if (/^B\d+$/.test(id)) return "goal_basis";
  if (/^R\d+$/.test(id)) return "diagnosis";
  if (/^C\d+$/.test(id)) return "change";
  if (/^D\d+$/.test(id)) return "decision";
  if (/^V\d+$/.test(id)) return "validation";
  return null;
}

function nodesForKind(
  draft: TypedPlanDraftV1,
  kind: PlanCandidateRepairNodeKind,
): unknown[] {
  const collection = COLLECTIONS[kind];
  return Array.isArray(draft[collection]) ? draft[collection] as unknown[] : [];
}

function appendTargetById(
  draft: TypedPlanDraftV1,
  targets: PlanCandidateRepairTarget[],
  id: string,
  forcedKind?: PlanCandidateRepairNodeKind,
): void {
  const normalizedId = id.toUpperCase();
  const kind = forcedKind || kindForNodeId(normalizedId);
  if (!kind) return;
  const nodes = nodesForKind(draft, kind);
  const matchingIndexes = nodes
    .map((node, index) => nodeId(node, kind) === normalizedId ? index : -1)
    .filter((index) => index >= 0);
  if (matchingIndexes.length === 1) {
    targets.push({ kind, id: normalizedId, index: matchingIndexes[0]! + 1 });
  } else if (matchingIndexes.length > 1) {
    matchingIndexes.forEach((index) => targets.push({ kind, id: normalizedId, index: index + 1 }));
  }
}

function appendMalformedIndexTarget(
  draft: TypedPlanDraftV1,
  targets: PlanCandidateRepairTarget[],
  failure: string,
  kind: PlanCandidateRepairNodeKind,
): void {
  const match = failure.match(/(?:^|_)id_invalid:(\d+)$/);
  if (!match) return;
  const index = Number(match[1]);
  if (Number.isInteger(index) && index > 0 && index <= nodesForKind(draft, kind).length) {
    targets.push({ kind, index });
  }
}

/**
 * Convert runtime failure codes into a minimal, typed repair surface. This
 * classifier operates only on protocol identifiers, never provider wording,
 * project paths, or natural-language phrases.
 */
export function derivePlanCandidateRepairScope(input: {
  draft: TypedPlanDraftV1;
  failures: string[];
}): {
  invalidTargets: PlanCandidateRepairTarget[];
  addableKinds: PlanCandidateRepairNodeKind[];
} {
  const targets: PlanCandidateRepairTarget[] = [];
  const addable = new Set<PlanCandidateRepairNodeKind>();

  for (const rawFailure of boundedUnique(input.failures, 64)) {
    const failure = rawFailure.toLowerCase();
    if (/typed_goal_evidence_(?:basis_missing|component_unmapped)/.test(failure)) {
      addable.add("goal_basis");
    }
    if (/typed_goal_evidence_diagnosis_missing/.test(failure)) {
      addable.add("diagnosis");
    }
    if (/typed_goal_evidence_(?:goal_invalid|component_invalid|component_reused|component_duplicate|refs_mismatch|owners_mismatch|relations_mismatch|diagnosis_invalid|diagnosis_goal_mismatch|diagnosis_evidence_mismatch|diagnosis_missing)/.test(failure)) {
      const componentId = rawFailure.toUpperCase().match(/:B\d+(?=:|$)/)?.[0]?.slice(1);
      if (componentId) appendTargetById(input.draft, targets, componentId, "goal_basis");
    }
    if (failure === "typed_goal_evidence_not_selected") {
      const selected = new Set(input.draft.evidenceRefs.map((reference) => String(reference || "").toUpperCase()));
      nodesForKind(input.draft, "goal_basis").forEach((node, index) => {
        const item = record(node);
        const refs = Array.isArray(item?.evidenceRefs)
          ? item!.evidenceRefs.map((reference) => String(reference || "").toUpperCase())
          : [];
        if (refs.some((reference) => !selected.has(reference))) {
          targets.push({
            kind: "goal_basis",
            ...(nodeId(node, "goal_basis") ? { id: nodeId(node, "goal_basis") } : {}),
            index: index + 1,
          });
        }
      });
    }
    if (
      /(?:goal|coverage)_diagnosis_missing/.test(failure)
    ) addable.add("diagnosis");
    if (
      /(?:goal_action_missing|plan_action_missing|coverage_(?:disposition|change)_missing)/.test(failure)
    ) {
      addable.add("change");
      if (!/coverage_change_missing/.test(failure)) addable.add("decision");
    }
    if (
      /(?:goal_validation_missing|blocking_validation_missing|coverage_validation_missing|change_validation_surface_ungrounded|executable_validation_missing)/.test(failure)
    ) addable.add("validation");
    if (/typed_planned_harness_validation_missing/.test(failure)) {
      addable.add("validation");
      continue;
    }

    // A missing validation for an otherwise valid change is repaired by
    // adding or replacing V, not by rewriting that valid C merely because its
    // ID appears in the failure code. Existing validations bound to that C are
    // part of the invalid surface and must not survive unexamined.
    if (/change_validation_surface_ungrounded/.test(failure)) {
      const changeId = rawFailure.toUpperCase().match(/:C\d+(?=:|$)/)?.[0]?.slice(1);
      if (changeId) {
        nodesForKind(input.draft, "validation").forEach((node, index) => {
          const item = record(node);
          const changeRefs = Array.isArray(item?.changeRefs)
            ? item!.changeRefs.map((reference) => String(reference || "").trim().toUpperCase())
            : [];
          if (changeRefs.includes(changeId)) {
            targets.push({
              kind: "validation",
              ...(nodeId(node, "validation") ? { id: nodeId(node, "validation") } : {}),
              index: index + 1,
            });
          }
        });
      }
      continue;
    }
    if (/coverage_(?:diagnosis|disposition|change|validation)_missing/.test(failure)) continue;
    if (/(?:goal|plan)_.*_missing/.test(failure)) continue;

    const typeMatch = failure.match(/(?:^|_)(diagnosis|change|decision|validation)(?:_|:)/);
    const inferredKind = typeMatch?.[1] as PlanCandidateRepairNodeKind | undefined;
    const idMatches = [...rawFailure.toUpperCase().matchAll(/(?:^|[:_])([RCDV]\d+)(?=[:_]|$)/g)]
      .map((match) => match[1]!);
    if (inferredKind) {
      const matchingIds = idMatches.filter((id) => kindForNodeId(id) === inferredKind);
      matchingIds.forEach((id) => appendTargetById(input.draft, targets, id, inferredKind));
      appendMalformedIndexTarget(input.draft, targets, failure, inferredKind);
    } else {
      idMatches.forEach((id) => appendTargetById(input.draft, targets, id));
    }
  }

  // Duplicate IDs are position-addressed so one repair cannot accidentally
  // replace every node sharing the same malformed identity.
  for (const kind of Object.keys(COLLECTIONS) as PlanCandidateRepairNodeKind[]) {
    const seen = new Map<string, number[]>();
    nodesForKind(input.draft, kind).forEach((node, index) => {
      const id = nodeId(node, kind);
      if (!id) return;
      seen.set(id, [...(seen.get(id) || []), index + 1]);
    });
    for (const [id, indexes] of seen) {
      if (indexes.length < 2) continue;
      indexes.forEach((index) => targets.push({ kind, id, index }));
    }
  }

  return {
    invalidTargets: uniqueTargets(targets),
    addableKinds: [...addable],
  };
}

export function hashTypedPlanDraft(draft: TypedPlanDraftV1): string {
  return sha256Hex(canonicalJson(draft));
}

export function createPlanCandidateRepairCheckpoint(input: {
  draft: TypedPlanDraftV1;
  evidenceBundleHash: string;
  evidenceReceiptHash: string;
  failures: string[];
  outputChars: number;
  attempts?: number;
  terminalReason?: string;
}): PlanCandidateRepairCheckpoint {
  const attempts = Math.max(0, Math.floor(input.attempts || 0));
  const cumulativeOutputChars = Math.max(0, Math.floor(input.outputChars || 0));
  const scope = derivePlanCandidateRepairScope({ draft: input.draft, failures: input.failures });
  const noLocalRepair = scope.invalidTargets.length === 0 && scope.addableKinds.length === 0;
  const terminalReason = input.terminalReason || (
    attempts === 0 && cumulativeOutputChars > MAX_TYPED_PLAN_INITIAL_OUTPUT_CHARS
      ? "typed_plan_candidate_initial_output_budget_exceeded"
      : noLocalRepair
        ? "typed_plan_candidate_no_local_repair_surface"
        : attempts >= MAX_TYPED_PLAN_REPAIR_ATTEMPTS
          ? "typed_plan_candidate_repair_attempts_exhausted"
          : cumulativeOutputChars > MAX_TYPED_PLAN_REPAIR_CUMULATIVE_CHARS
            ? "typed_plan_candidate_repair_cumulative_budget_exceeded"
            : ""
  );
  return {
    version: PLAN_CANDIDATE_REPAIR_CONTRACT_VERSION,
    baseDraft: input.draft,
    baseDraftHash: hashTypedPlanDraft(input.draft),
    evidenceBundleHash: input.evidenceBundleHash,
    evidenceReceiptHash: input.evidenceReceiptHash,
    failures: boundedUnique(input.failures, 32),
    invalidTargets: scope.invalidTargets,
    addableKinds: scope.addableKinds,
    attempts,
    cumulativeOutputChars,
    exhausted: !!terminalReason,
    ...(terminalReason ? { terminalReason } : {}),
  };
}

export function advancePlanCandidateRepairCheckpoint(input: {
  checkpoint: PlanCandidateRepairCheckpoint;
  outputChars: number;
  draft?: TypedPlanDraftV1;
  failures: string[];
  terminalReason?: string;
  /** Protocol/patch failures leave the retained semantic repair scope intact. */
  preserveScope?: boolean;
}): PlanCandidateRepairCheckpoint {
  const outputChars = Math.max(0, Math.floor(input.outputChars || 0));
  const attempts = input.checkpoint.attempts + 1;
  const cumulativeOutputChars = input.checkpoint.cumulativeOutputChars + outputChars;
  const terminalReason = input.terminalReason ||
    (outputChars > MAX_TYPED_PLAN_REPAIR_OUTPUT_CHARS
      ? "typed_plan_candidate_repair_output_budget_exceeded"
      : attempts >= MAX_TYPED_PLAN_REPAIR_ATTEMPTS
        ? "typed_plan_candidate_repair_attempts_exhausted"
        : cumulativeOutputChars > MAX_TYPED_PLAN_REPAIR_CUMULATIVE_CHARS
          ? "typed_plan_candidate_repair_cumulative_budget_exceeded"
          : undefined);
  if (input.preserveScope) {
    const draft = input.draft || input.checkpoint.baseDraft;
    return {
      ...input.checkpoint,
      baseDraft: draft,
      baseDraftHash: hashTypedPlanDraft(draft),
      failures: boundedUnique(input.failures, 32),
      attempts,
      cumulativeOutputChars,
      exhausted: !!terminalReason,
      ...(terminalReason ? { terminalReason } : { terminalReason: undefined }),
    };
  }
  return createPlanCandidateRepairCheckpoint({
    draft: input.draft || input.checkpoint.baseDraft,
    evidenceBundleHash: input.checkpoint.evidenceBundleHash,
    evidenceReceiptHash: input.checkpoint.evidenceReceiptHash,
    failures: input.failures,
    outputChars: cumulativeOutputChars,
    attempts,
    terminalReason,
  });
}

function parseRepairOperation(value: unknown): PlanCandidateRepairOperation | null {
  const input = record(value);
  if (!input) return null;
  const kind = String(input.kind || "") as PlanCandidateRepairNodeKind;
  const operation = String(input.operation || "") as PlanCandidateRepairOperation["operation"];
  if (!Object.prototype.hasOwnProperty.call(COLLECTIONS, kind)) return null;
  if (!(["replace", "add", "remove"] as string[]).includes(operation)) return null;
  const targetId = String(input.targetId || "").trim().toUpperCase();
  const targetIndex = Number(input.targetIndex);
  return {
    kind,
    operation,
    ...(targetId ? { targetId } : {}),
    ...(Number.isInteger(targetIndex) && targetIndex > 0 ? { targetIndex } : {}),
    ...(Object.prototype.hasOwnProperty.call(input, "node") ? { node: input.node } : {}),
  };
}

export function extractPlanCandidateRepairEnvelope(
  text: string,
): PlanCandidateRepairEnvelopeResult {
  const blocks = [...String(text || "").matchAll(PLAN_CANDIDATE_BLOCK_RE)];
  if (blocks.length === 0) return { status: "absent" };
  if (blocks.length > 1) {
    return { status: "invalid", failures: ["typed_plan_repair_ambiguous_multiple"] };
  }
  let payload = String(blocks[0]?.[1] || "").trim();
  const fenced = payload.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i);
  if (fenced) payload = String(fenced[1] || "").trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return { status: "absent" };
  }
  const root = record(parsed);
  if (!root || !Object.prototype.hasOwnProperty.call(root, "repair")) return { status: "absent" };
  if (root.schemaVersion !== 2) {
    return { status: "invalid", failures: ["typed_plan_repair_schema_mismatch"] };
  }
  const unexpectedRootKeys = Object.keys(root).filter((key) => !["schemaVersion", "repair"].includes(key));
  if (unexpectedRootKeys.length > 0) {
    return { status: "invalid", failures: ["typed_plan_repair_full_candidate_forbidden"] };
  }
  const repair = record(root.repair);
  if (!repair || repair.contractVersion !== PLAN_CANDIDATE_REPAIR_CONTRACT_VERSION) {
    return { status: "invalid", failures: ["typed_plan_repair_contract_mismatch"] };
  }
  const baseDraftHash = String(repair.baseDraftHash || "").trim();
  if (!/^[a-f0-9]{64}$/.test(baseDraftHash)) {
    return { status: "invalid", failures: ["typed_plan_repair_base_hash_invalid"] };
  }
  if (!Array.isArray(repair.operations) || repair.operations.length === 0) {
    return { status: "invalid", failures: ["typed_plan_repair_operations_missing"] };
  }
  if (repair.operations.length > MAX_TYPED_PLAN_REPAIR_OPERATIONS) {
    return { status: "invalid", failures: ["typed_plan_repair_operations_exceeded"] };
  }
  const operations = repair.operations.map(parseRepairOperation);
  if (operations.some((operation) => !operation)) {
    return { status: "invalid", failures: ["typed_plan_repair_operation_invalid"] };
  }
  return {
    status: "parsed",
    patch: {
      schemaVersion: 2,
      repair: {
        contractVersion: PLAN_CANDIDATE_REPAIR_CONTRACT_VERSION,
        baseDraftHash,
        operations: operations as PlanCandidateRepairOperation[],
      },
    },
  };
}

function operationTargetIndex(input: {
  operation: PlanCandidateRepairOperation;
  nodes: unknown[];
  allowed: PlanCandidateRepairTarget[];
}): number | null {
  const { operation, nodes, allowed } = input;
  const indexFromPosition = operation.targetIndex ? operation.targetIndex - 1 : null;
  if (indexFromPosition != null) {
    const target = allowed.find((candidate) =>
      candidate.index === operation.targetIndex &&
      (!operation.targetId || candidate.id === operation.targetId)
    );
    return target && indexFromPosition >= 0 && indexFromPosition < nodes.length
      ? indexFromPosition
      : null;
  }
  if (!operation.targetId) return null;
  const allowedById = allowed.filter((candidate) => candidate.id === operation.targetId);
  const indexes = nodes
    .map((node, index) => nodeId(node, operation.kind) === operation.targetId ? index : -1)
    .filter((index) => index >= 0);
  return allowedById.length === 1 && indexes.length === 1 ? indexes[0]! : null;
}

function validateRepairNode(
  kind: PlanCandidateRepairNodeKind,
  node: unknown,
): string | null {
  const id = nodeId(node, kind);
  if (!new RegExp(`^${ID_PREFIXES[kind]}\\d+$`).test(id)) {
    return `typed_plan_repair_node_id_invalid:${kind}`;
  }
  if (kind === "goal_basis" && !/^G\d+$/.test(String(record(node)?.goalRef || "").trim().toUpperCase())) {
    return "typed_plan_repair_goal_basis_goal_invalid";
  }
  return null;
}

export function applyPlanCandidateRepairPatch(input: {
  checkpoint: PlanCandidateRepairCheckpoint;
  patch: PlanCandidateRepairPatch;
}): PlanCandidateRepairApplicationResult {
  const { checkpoint, patch } = input;
  if (checkpoint.exhausted) {
    return { ok: false, failures: ["typed_plan_repair_checkpoint_exhausted"] };
  }
  if (patch.repair.baseDraftHash !== checkpoint.baseDraftHash) {
    return { ok: false, failures: ["typed_plan_repair_base_hash_mismatch"] };
  }
  const replacements = new Map<string, Map<number, unknown>>();
  const removals = new Map<string, Set<number>>();
  const additions = new Map<string, unknown[]>();
  const claimedTargets = new Set<string>();
  const existingIds = new Set(
    (Object.keys(COLLECTIONS) as PlanCandidateRepairNodeKind[])
      .flatMap((kind) => nodesForKind(checkpoint.baseDraft, kind).map((node) => nodeId(node, kind)))
      .filter(Boolean),
  );
  const failures: string[] = [];

  for (const operation of patch.repair.operations) {
    const nodes = nodesForKind(checkpoint.baseDraft, operation.kind);
    const allowed = checkpoint.invalidTargets.filter((target) => target.kind === operation.kind);
    if (operation.operation === "add") {
      if (!checkpoint.addableKinds.includes(operation.kind)) {
        failures.push(`typed_plan_repair_add_forbidden:${operation.kind}`);
        continue;
      }
      const invalidNode = validateRepairNode(operation.kind, operation.node);
      if (invalidNode) {
        failures.push(invalidNode);
        continue;
      }
      const id = nodeId(operation.node, operation.kind);
      if (existingIds.has(id)) {
        failures.push(`typed_plan_repair_add_id_conflict:${id}`);
        continue;
      }
      existingIds.add(id);
      additions.set(operation.kind, [...(additions.get(operation.kind) || []), operation.node]);
      continue;
    }

    const index = operationTargetIndex({ operation, nodes, allowed });
    if (index == null) {
      failures.push(`typed_plan_repair_target_forbidden:${operation.kind}:${operation.targetId || operation.targetIndex || "missing"}`);
      continue;
    }
    const claim = `${operation.kind}:${index}`;
    if (claimedTargets.has(claim)) {
      failures.push(`typed_plan_repair_target_duplicate:${claim}`);
      continue;
    }
    claimedTargets.add(claim);
    if (operation.operation === "remove") {
      removals.set(operation.kind, new Set([...(removals.get(operation.kind) || []), index]));
      continue;
    }
    const invalidNode = validateRepairNode(operation.kind, operation.node);
    if (invalidNode) {
      failures.push(invalidNode);
      continue;
    }
    const priorId = nodeId(nodes[index], operation.kind);
    const nextId = nodeId(operation.node, operation.kind);
    if (priorId && kindForNodeId(priorId) === operation.kind && priorId !== nextId) {
      failures.push(`typed_plan_repair_identity_changed:${priorId}`);
      continue;
    }
    const byIndex = replacements.get(operation.kind) || new Map<number, unknown>();
    byIndex.set(index, operation.node);
    replacements.set(operation.kind, byIndex);
  }

  if (failures.length > 0) return { ok: false, failures: boundedUnique(failures) };

  const draft: TypedPlanDraftV1 = { ...checkpoint.baseDraft };
  for (const kind of Object.keys(COLLECTIONS) as PlanCandidateRepairNodeKind[]) {
    const collection = COLLECTIONS[kind];
    const byIndex = replacements.get(kind) || new Map<number, unknown>();
    const removed = removals.get(kind) || new Set<number>();
    const retained = nodesForKind(checkpoint.baseDraft, kind)
      .flatMap((node, index) => removed.has(index) ? [] : [byIndex.get(index) ?? node]);
    (draft as unknown as Record<string, unknown>)[collection] = [
      ...retained,
      ...(additions.get(kind) || []),
    ];
  }
  // The patch grammar has no writable top-level evidence field. Assert the
  // invariant anyway so future protocol edits cannot silently alter receipt
  // authority.
  if (canonicalJson(draft.evidenceRefs) !== canonicalJson(checkpoint.baseDraft.evidenceRefs)) {
    return { ok: false, failures: ["typed_plan_repair_evidence_refs_changed"] };
  }
  return { ok: true, draft };
}

function boundedNodeJson(value: unknown, maxChars = 600): string {
  const serialized = canonicalJson(value);
  return serialized.length <= maxChars
    ? serialized
    : `${serialized.slice(0, maxChars)}…`;
}

/**
 * Phase-scoped replacement for the ordinary full-draft tool definition. The
 * public tool name stays stable, while the active transaction exposes only a
 * patch schema bound to its exact base hash.
 */
export function createPlanCandidateRepairToolDefinition(
  checkpoint: PlanCandidateRepairCheckpoint,
): ToolDefinition {
  const allowedKinds = [...new Set([
    ...checkpoint.invalidTargets.map((target) => target.kind),
    ...checkpoint.addableKinds,
  ])];
  return ({
    type: "function",
    function: {
      name: SUBMIT_PLAN_CANDIDATE_TOOL_NAME,
      description: "Submit only the bounded local patch for the active typed Plan candidate. The runtime preserves accepted nodes and evidence authority; a complete Plan draft is invalid in this phase.",
      parameters: {
        type: "object",
        properties: {
          schemaVersion: {
            type: "number",
            enum: [2],
            description: "Typed Plan patch transport version.",
          },
          repair: {
            type: "object",
            properties: {
              contractVersion: {
                type: "number",
                enum: [PLAN_CANDIDATE_REPAIR_CONTRACT_VERSION],
              },
              baseDraftHash: {
                type: "string",
                enum: [checkpoint.baseDraftHash],
                description: "Exact retained candidate hash. Do not change it.",
              },
              operations: {
                type: "array",
                minItems: 1,
                maxItems: MAX_TYPED_PLAN_REPAIR_OPERATIONS,
                items: {
                  type: "object",
                  properties: {
                    kind: { type: "string", enum: allowedKinds },
                    operation: { type: "string", enum: ["replace", "add", "remove"] },
                    targetId: { type: "string" },
                    targetIndex: { type: "number" },
                    node: {
                      type: "object",
                      description: "Complete corrected node for add/replace; omit only for remove.",
                    },
                  },
                  required: ["kind", "operation"],
                },
              },
            },
            required: ["contractVersion", "baseDraftHash", "operations"],
          },
        },
        required: ["schemaVersion", "repair"],
      },
    },
  } as unknown) as ToolDefinition;
}

export function replacePlanCandidateSubmissionToolForRepair(
  tools: ToolDefinition[],
  checkpoint: PlanCandidateRepairCheckpoint,
): ToolDefinition[] {
  return tools.map((tool) =>
    tool.function.name === SUBMIT_PLAN_CANDIDATE_TOOL_NAME
      ? createPlanCandidateRepairToolDefinition(checkpoint)
      : tool
  );
}

export function buildPlanCandidateRepairPrompt(
  checkpoint: PlanCandidateRepairCheckpoint,
  options: {
    submissionTransport?: PlanCandidateRepairSubmissionTransport;
    contractCard?: boolean;
  } = {},
): string {
  const invalidNodes = checkpoint.invalidTargets.slice(0, MAX_TYPED_PLAN_REPAIR_OPERATIONS).map((target) => {
    const nodes = nodesForKind(checkpoint.baseDraft, target.kind);
    const index = target.index
      ? target.index - 1
      : nodes.findIndex((node) => nodeId(node, target.kind) === target.id);
    return {
      ...target,
      node: index >= 0 ? boundedNodeJson(nodes[index]) : "missing",
    };
  });
  const acceptedIds = (Object.keys(COLLECTIONS) as PlanCandidateRepairNodeKind[]).reduce<Record<string, string[]>>(
    (accumulator, kind) => {
      const invalidIndexes = new Set(checkpoint.invalidTargets
        .filter((target) => target.kind === kind && target.index)
        .map((target) => target.index! - 1));
      const invalidIds = new Set(checkpoint.invalidTargets
        .filter((target) => target.kind === kind && target.id)
        .map((target) => target.id!));
      accumulator[kind] = nodesForKind(checkpoint.baseDraft, kind)
        .filter((node, index) => !invalidIndexes.has(index) && !invalidIds.has(nodeId(node, kind)))
        .map((node) => nodeId(node, kind).slice(0, 64))
        .filter(Boolean)
        .slice(0, 8);
      return accumulator;
    },
    {},
  );
  const remainingAttempts = Math.max(0, MAX_TYPED_PLAN_REPAIR_ATTEMPTS - checkpoint.attempts);
  const submissionTransport = options.submissionTransport || "active_transport";
  const firstTarget = checkpoint.invalidTargets[0];
  const exampleOperation = firstTarget
    ? {
        kind: firstTarget.kind,
        operation: "replace",
        ...(firstTarget.id ? { targetId: firstTarget.id } : {}),
        ...(firstTarget.index && !firstTarget.id ? { targetIndex: firstTarget.index } : {}),
        node: `<complete corrected ${firstTarget.kind} node>`,
      }
    : {
        kind: checkpoint.addableKinds[0] || "validation",
        operation: "add",
        node: `<complete new ${checkpoint.addableKinds[0] || "validation"} node>`,
      };
  const patchShape = {
    schemaVersion: 2,
    repair: {
      contractVersion: PLAN_CANDIDATE_REPAIR_CONTRACT_VERSION,
      baseDraftHash: checkpoint.baseDraftHash,
      operations: [exampleOperation],
    },
  };
  const transportInstruction = submissionTransport === "native_tool"
    ? `Call ${SUBMIT_PLAN_CANDIDATE_TOOL_NAME} exactly once with the patch object as its complete arguments. Do not emit a <plan_candidate> envelope.`
    : submissionTransport === "text_envelope"
      ? "Emit exactly one <plan_candidate> containing the patch object and no surrounding prose."
      : `Use the active ${SUBMIT_PLAN_CANDIDATE_TOOL_NAME} transport: call the tool with the patch object when it is exposed; otherwise emit exactly one <plan_candidate> containing that same object.`;
  const lines = [
    ...(options.contractCard ? ["[PLAN AUTHORING CONTRACT]"] : []),
    "PLAN_CANDIDATE_LOCAL_REPAIR_V1",
    "This active local-repair contract supersedes and suspends every earlier instruction to submit or resubmit a complete draft or full typed graph until this checkpoint closes.",
    "The runtime retained the valid typed nodes and the frozen evidence receipt. Do not resend the complete candidate.",
    transportInstruction,
    `baseDraftHash=${checkpoint.baseDraftHash}`,
    `evidenceBundleHash=${checkpoint.evidenceBundleHash}`,
    `failures=${JSON.stringify(checkpoint.failures.slice(0, 8).map((failure) => failure.slice(0, 160)))}`,
    `invalidNodes=${JSON.stringify(invalidNodes)}`,
    `acceptedNodeIds=${JSON.stringify(acceptedIds)}`,
    `addableKinds=${JSON.stringify(checkpoint.addableKinds)}`,
    `remainingAttempts=${remainingAttempts}`,
    `maximumPatchCharacters=${MAX_TYPED_PLAN_REPAIR_OUTPUT_CHARS}`,
    "Submit only this JSON patch shape:",
    submissionTransport === "text_envelope"
      ? `<plan_candidate>${JSON.stringify(patchShape)}</plan_candidate>`
      : JSON.stringify(patchShape),
    "Allowed operations: replace/remove only an invalidNodes target; add only an addableKinds node. Preserve IDs when replacing validly identified nodes.",
    "Do not include summary, evidenceRefs, accepted nodes, prose, markdown, user options, or any other top-level field.",
    ...(options.contractCard ? ["[/PLAN AUTHORING CONTRACT]"] : []),
  ];
  const prompt = lines.join("\n");
  if (prompt.length <= MAX_TYPED_PLAN_REPAIR_PROMPT_CHARS) return prompt;

  // Keep the protocol syntactically complete under adversarially large node
  // text. The runtime owns the retained draft, so a retry only needs invalid
  // identities, failure codes, the exact base hash, and the patch grammar.
  return [
    ...(options.contractCard ? ["[PLAN AUTHORING CONTRACT]"] : []),
    "PLAN_CANDIDATE_LOCAL_REPAIR_V1",
    "This active local-repair contract supersedes and suspends every earlier instruction to submit or resubmit a complete draft or full typed graph until this checkpoint closes.",
    transportInstruction,
    `baseDraftHash=${checkpoint.baseDraftHash}`,
    `evidenceBundleHash=${checkpoint.evidenceBundleHash}`,
    `failures=${JSON.stringify(checkpoint.failures.slice(0, 8).map((failure) => failure.slice(0, 160)))}`,
    `invalidTargets=${JSON.stringify(checkpoint.invalidTargets.slice(0, MAX_TYPED_PLAN_REPAIR_OPERATIONS).map((target) => ({
      kind: target.kind,
      ...(target.id ? { id: target.id.slice(0, 64) } : {}),
      ...(target.index ? { index: target.index } : {}),
    })))}`,
    `addableKinds=${JSON.stringify(checkpoint.addableKinds)}`,
    `remainingAttempts=${remainingAttempts}`,
    `maximumPatchCharacters=${MAX_TYPED_PLAN_REPAIR_OUTPUT_CHARS}`,
    submissionTransport === "text_envelope"
      ? `<plan_candidate>${JSON.stringify(patchShape)}</plan_candidate>`
      : JSON.stringify(patchShape),
    "Only replace/remove an invalid target or add an addable kind. Do not include accepted nodes, evidenceRefs, prose, markdown, or user options.",
    ...(options.contractCard ? ["[/PLAN AUTHORING CONTRACT]"] : []),
  ].join("\n");
}

export function buildPlanCandidateRepairIterationProtocol(input: {
  checkpoint: PlanCandidateRepairCheckpoint;
  submissionTransport: "native_tool" | "text_envelope";
}): {
  primaryCard: string;
  providerCompatibilityCard?: string;
} {
  return {
    primaryCard: buildPlanCandidateRepairPrompt(input.checkpoint, {
      submissionTransport: input.submissionTransport,
      contractCard: true,
    }),
    ...(input.submissionTransport === "native_tool"
      ? {
          providerCompatibilityCard: buildPlanCandidateRepairPrompt(input.checkpoint, {
            submissionTransport: "text_envelope",
            contractCard: true,
          }),
        }
      : {}),
  };
}
