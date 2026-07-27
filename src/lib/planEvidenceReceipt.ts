import type { PlanCandidateV3 } from "./planContract";
import type { PlanEvidenceBundle } from "./planEvidence";
import type { PlanCoverageObligation } from "./planCoverageContract";
import {
  authoritativePlanStructuredEvidenceFacts,
  formatPlanStructuredEvidenceFact,
  formatPlanStructuredEvidenceFacts,
  normalizePlanStructuredEvidenceFact,
  type PlanStructuredEvidenceFact,
} from "./planStructuredEvidence";
import {
  normalizePlanSourceObservations,
  type PlanSourceObservation,
} from "./planSourceObservation";
import { sha256Hex } from "./sha256";
import { workspacePathsReferToSameFile } from "./workspacePaths";
import type { PlanEvidenceComponent } from "./planEvidenceComponents";

export const PLAN_EVIDENCE_RECEIPT_VERSION = 1 as const;

export interface PlanEvidenceReceiptObservation {
  observationRef: string;
  path: string;
  startLine: number;
  endLine: number;
  excerptHash: string;
  versionToken: string;
  requestSignature: string;
}

export interface PlanEvidenceReceiptFact {
  id: string;
  target: string;
  sourceTool: string;
  sourceHash: string;
  statement: string;
  sourceObservations: PlanEvidenceReceiptObservation[];
  structuredFactBindings: Array<{
    fact: PlanStructuredEvidenceFact;
    signature: string;
    sourceObservationRefs: string[];
  }>;
}

/**
 * Runtime-authored evidence snapshot persisted with a typed Plan. It is not a
 * model schema: candidate E/Q nodes must match this receipt during sealing,
 * commit and cold restore.
 */
export interface PlanEvidenceReceipt {
  schemaVersion: typeof PLAN_EVIDENCE_RECEIPT_VERSION;
  bundleId: string;
  bundleHash: string;
  turnId: string;
  facts: PlanEvidenceReceiptFact[];
  coverageObligations: PlanCoverageObligation[];
  evidenceComponents?: PlanEvidenceComponent[];
  digest: string;
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => [key, canonicalValue(entry)]));
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}

function receiptObservation(item: PlanSourceObservation): PlanEvidenceReceiptObservation {
  return {
    observationRef: item.observationRef,
    path: item.path,
    startLine: item.startLine,
    endLine: item.endLine,
    excerptHash: item.excerptHash,
    versionToken: item.versionToken,
    requestSignature: item.requestSignature,
  };
}

function evidenceStatement(fact: PlanEvidenceBundle["facts"][number]): string {
  const summary = String(fact.summary || "").trim();
  const structured = formatPlanStructuredEvidenceFacts(fact.structuredFacts)
    .filter((item) => !summary.includes(item));
  const provenance = normalizePlanSourceObservations(fact.sourceObservations).map((item) =>
    `source_observation(${item.path}:L${item.startLine}-L${item.endLine},${item.excerptHash},version=${item.versionToken})`
  );
  return [summary, ...structured, ...provenance].filter(Boolean).join(" ");
}

function receiptPayload(receipt: Omit<PlanEvidenceReceipt, "digest">): string {
  return JSON.stringify(canonicalValue(receipt));
}

export function hashPlanEvidenceReceipt(
  receipt: Omit<PlanEvidenceReceipt, "digest">,
): string {
  return `plan-evidence-receipt-sha256-${sha256Hex(receiptPayload(receipt))}`;
}

export function createPlanEvidenceReceipt(bundle: PlanEvidenceBundle): PlanEvidenceReceipt {
  const facts = bundle.facts.map((fact): PlanEvidenceReceiptFact => {
    const observations = normalizePlanSourceObservations(fact.sourceObservations);
    return {
      id: fact.id,
      target: fact.target,
      sourceTool: fact.tool,
      sourceHash: fact.hash,
      statement: evidenceStatement(fact),
      sourceObservations: observations.map(receiptObservation),
      structuredFactBindings: authoritativePlanStructuredEvidenceFacts(fact.structuredFacts)
        .map((item) => ({
          fact: item,
          signature: formatPlanStructuredEvidenceFact(item),
          sourceObservationRefs: unique(item.sourceObservationRefs || []).sort(),
        }))
        .sort((left, right) => left.signature.localeCompare(right.signature)),
    };
  });
  const base: Omit<PlanEvidenceReceipt, "digest"> = {
    schemaVersion: PLAN_EVIDENCE_RECEIPT_VERSION,
    bundleId: bundle.bundleId,
    bundleHash: bundle.hash,
    turnId: bundle.turnId,
    facts,
    coverageObligations: (bundle.coverageObligations || []).map((item) => ({
      ...item,
      evidenceRefs: [...item.evidenceRefs],
      targetRefs: [...item.targetRefs],
    })),
    evidenceComponents: (bundle.evidenceComponents || []).map((item) => ({
      ...item,
      evidenceRefs: [...item.evidenceRefs],
      ownerRefs: [...item.ownerRefs],
      relationRefs: [...item.relationRefs],
    })),
  };
  return { ...base, digest: hashPlanEvidenceReceipt(base) };
}

export function validatePlanEvidenceReceipt(receipt: PlanEvidenceReceipt): string[] {
  const failures: string[] = [];
  if (!receipt || typeof receipt !== "object") return ["evidence_receipt_missing"];
  if (receipt.schemaVersion !== PLAN_EVIDENCE_RECEIPT_VERSION) {
    failures.push("evidence_receipt_schema_mismatch");
  }
  if (!receipt.bundleId || !receipt.bundleHash || !receipt.turnId) {
    failures.push("evidence_receipt_identity_missing");
  }
  const { digest: _digest, ...base } = receipt;
  if (receipt.digest !== hashPlanEvidenceReceipt(base)) failures.push("evidence_receipt_digest_mismatch");
  const evidenceIds = new Set<string>();
  for (const fact of Array.isArray(receipt.facts) ? receipt.facts : []) {
    if (!/^E\d+$/.test(fact.id) || evidenceIds.has(fact.id)) {
      failures.push(`evidence_receipt_fact_id_invalid:${fact.id || "missing"}`);
    }
    evidenceIds.add(fact.id);
    if (!fact.target || !fact.sourceTool || !fact.sourceHash || !fact.statement) {
      failures.push(`evidence_receipt_fact_identity_missing:${fact.id}`);
    }
    const observationRefs = new Set<string>();
    for (const observation of fact.sourceObservations || []) {
      if (
        !/^source-observation-sha256-[a-f0-9]{64}$/.test(observation.observationRef) ||
        !observation.path || observation.startLine <= 0 || observation.endLine < observation.startLine ||
        !/^source-sha256-[a-f0-9]{64}$/.test(observation.excerptHash) ||
        !observation.versionToken || !observation.requestSignature
      ) failures.push(`evidence_receipt_source_observation_invalid:${fact.id}`);
      observationRefs.add(observation.observationRef);
    }
    for (const binding of fact.structuredFactBindings || []) {
      const normalizedFact = normalizePlanStructuredEvidenceFact(binding.fact);
      if (
        !normalizedFact ||
        normalizedFact.authority !== "runtime_observation" ||
        binding.signature !== formatPlanStructuredEvidenceFact(normalizedFact) ||
        binding.sourceObservationRefs.length === 0 ||
        !equalCanonical(
          unique(normalizedFact.sourceObservationRefs || []).sort(),
          unique(binding.sourceObservationRefs || []).sort(),
        )
      ) {
        failures.push(`evidence_receipt_structured_fact_unbound:${fact.id}`);
        continue;
      }
      if (binding.sourceObservationRefs.some((reference) => !observationRefs.has(reference))) {
        failures.push(`evidence_receipt_structured_fact_source_invalid:${fact.id}`);
      }
    }
  }
  for (const obligation of receipt.coverageObligations || []) {
    if (obligation.evidenceRefs.some((reference) => !evidenceIds.has(reference))) {
      failures.push(`evidence_receipt_coverage_evidence_invalid:${obligation.id}`);
    }
  }
  const obligationIds = new Set((receipt.coverageObligations || []).map((item) => item.id));
  const componentIds = new Set<string>();
  for (const component of receipt.evidenceComponents || []) {
    if (!/^B\d+$/.test(component.id) || componentIds.has(component.id)) {
      failures.push(`evidence_receipt_component_id_invalid:${component.id || "missing"}`);
    }
    componentIds.add(component.id);
    if (
      component.evidenceRefs.length === 0 ||
      component.ownerRefs.length === 0 ||
      component.evidenceRefs.some((reference) => !evidenceIds.has(reference)) ||
      component.relationRefs.some((reference) => !obligationIds.has(reference)) ||
      (component.requiredForClosure && component.relationRefs.length === 0)
    ) failures.push(`evidence_receipt_component_invalid:${component.id}`);
  }
  return unique(failures);
}

function equalCanonical(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonicalValue(left)) === JSON.stringify(canonicalValue(right));
}

export function validateCandidateAgainstPlanEvidenceReceipt(
  candidate: PlanCandidateV3,
): string[] {
  const receipt = candidate.evidenceReceipt;
  const failures = validatePlanEvidenceReceipt(receipt);
  if (failures.length > 0) return failures;
  if (candidate.bundleHash !== receipt.bundleHash) failures.push("candidate_evidence_receipt_bundle_mismatch");
  const factById = new Map(receipt.facts.map((fact) => [fact.id, fact]));
  for (const evidence of candidate.evidence || []) {
    const fact = factById.get(evidence.id);
    if (!fact) {
      failures.push(`candidate_evidence_receipt_fact_missing:${evidence.id}`);
      continue;
    }
    if (
      !workspacePathsReferToSameFile(evidence.target, fact.target) ||
      evidence.sourceTool !== fact.sourceTool ||
      evidence.sourceHash !== fact.sourceHash ||
      evidence.statement !== fact.statement
    ) failures.push(`candidate_evidence_receipt_fact_mismatch:${evidence.id}`);
    const observations = normalizePlanSourceObservations(evidence.sourceObservations)
      .map(receiptObservation);
    if (!equalCanonical(observations, fact.sourceObservations)) {
      failures.push(`candidate_evidence_receipt_source_mismatch:${evidence.id}`);
    }
  }
  if (!equalCanonical(candidate.coverageObligations || [], receipt.coverageObligations)) {
    failures.push("candidate_evidence_receipt_coverage_mismatch");
  }
  return unique(failures);
}
