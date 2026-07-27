import type {
  PlanAuthoringContract,
  PlanGoalFacetContract,
} from "./planAuthoringContract";
import type { PlanEvidenceBundle } from "./planEvidence";
import {
  projectPlanTaskValidationPrimitives,
  type PlanTask,
  type PlanTaskEvidence,
} from "./workflowModels";
import {
  analyzeValidationCommand,
  isAcceptanceCapableValidationSpec,
  isWellFormedAdvisoryAssertionSpec,
  type AssertionValidationSpec,
  type ServiceReadinessSpec,
  type ValidationPrimitiveSpec,
} from "./validationContract";
import { sha256Hex } from "./sha256";
import {
  validatePlanCoverageClosure,
  type PlanCoverageObligation,
} from "./planCoverageContract";
import { formatPlanStructuredEvidenceFacts } from "./planStructuredEvidence";
import {
  normalizePlanSourceObservations,
  type PlanSourceObservation,
} from "./planSourceObservation";
import { workspacePathsReferToSameFile } from "./workspacePaths";
import {
  createPlanEvidenceReceipt,
  validateCandidateAgainstPlanEvidenceReceipt,
  type PlanEvidenceReceipt,
} from "./planEvidenceReceipt";
import {
  validatePlanValidationSurfaces,
  type PlannedValidationHarness,
} from "./planValidationSurface";
import {
  validatePlanGoalEvidenceBases,
  type PlanGoalEvidenceBasis,
} from "./planEvidenceComponents";

export const PLAN_CANDIDATE_SCHEMA_VERSION = 5 as const;

export interface PlanCandidateEvidence {
  id: string;
  target: string;
  sourceTool: string;
  statement: string;
  sourceHash: string;
  /** Immutable, runtime-owned exact source windows backing this evidence. */
  sourceObservations?: PlanSourceObservation[];
  certainty: "observed" | "hypothesis";
}

export interface PlanCandidateDiagnosis {
  id: string;
  text: string;
  certainty: "observed" | "inferred" | "hypothesis";
  evidenceRefs: string[];
  goalRefs: string[];
  /** Ordered evidence edges used to justify an inference or causal chain. */
  chainRefs: string[];
}

export interface PlanCandidateChange {
  id: string;
  text: string;
  targetRef: string;
  /** Existing evidence owner used when operation=create targets a new path. */
  targetOwnerRef?: string;
  evidenceRefs: string[];
  diagnosisRefs: string[];
  goalRefs: string[];
  operation: "modify" | "create" | "delete" | "preserve";
  expectedOutcome: string;
  relationships: string[];
  executionEvidence: PlanTaskEvidence[];
  plannedValidationHarness?: PlannedValidationHarness;
}

export interface PlanCandidateDecision {
  id: string;
  goalRefs: string[];
  evidenceRefs: string[];
  /** Required Q -> R -> D edge for diagnostic preserve decisions. */
  diagnosisRefs: string[];
  text: string;
  disposition: "change" | "preserve";
}

export interface PlanCandidateValidation {
  id: string;
  goalRefs: string[];
  changeRefs: string[];
  primitive: ValidationPrimitiveSpec;
  expectedOutcome: string;
  blocking: boolean;
  harnessChangeRef?: string;
}

export interface PlanCandidateProjection {
  format: "markdown";
  content: string;
  contentHash: string;
}

/**
 * The typed, provider-neutral approval contract. Markdown is retained only as
 * its review projection; execution consumes changes and validations below.
 */
export interface PlanCandidateV5 {
  schemaVersion: typeof PLAN_CANDIDATE_SCHEMA_VERSION;
  state: "draft" | "sealed";
  /**
   * Explicit migration boundary. New model proposals are typed_runtime;
   * Markdown inference is retained only for cold/legacy compatibility imports.
   */
  ingress?: "typed_runtime" | "legacy_markdown_import" | "runtime_synthesized";
  contractId: string;
  authoringContractId: string;
  bundleHash: string;
  objective: string;
  goals: PlanGoalFacetContract[];
  diagnosisRequired: boolean;
  evidence: PlanCandidateEvidence[];
  /** Model-authored semantic assignment to runtime-owned evidence components. */
  goalEvidenceBases?: PlanGoalEvidenceBasis[];
  /** Runtime-authored relationships that must survive E/R/C/D/V closure. */
  coverageObligations?: PlanCoverageObligation[];
  /** Runtime evidence authority persisted independently of model-authored edges. */
  evidenceReceipt: PlanEvidenceReceipt;
  summary: string[];
  diagnoses: PlanCandidateDiagnosis[];
  /** Legacy review projection retained while Markdown adapters are migrated. */
  findings: string[];
  changes: PlanCandidateChange[];
  decisions: PlanCandidateDecision[];
  interfaces: string[];
  /** Legacy review projection retained for diagnostics; runtime uses validations. */
  tests: string[];
  validations: PlanCandidateValidation[];
  assumptions: string[];
  blockingChoices: string[];
  projection: PlanCandidateProjection;
}

/** Compatibility aliases; their runtime payload is schema 5 and requires a receipt. */
export type PlanCandidateV4 = PlanCandidateV5;
export type PlanCandidateV3 = PlanCandidateV5;
export type PlanCandidateV2 = PlanCandidateV5;

function stableHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalValue(entry)]),
  );
}

export function hashPlanProjection(content: string): string {
  return `plan-projection-sha256-${sha256Hex(String(content || "").replace(/\r\n?/g, "\n").trim())}`;
}

export function hashPlanCandidate(candidate: PlanCandidateV3): string {
  return `plan-candidate-sha256-${sha256Hex(JSON.stringify(canonicalValue(candidate)))}`;
}

export function projectPlanCandidateEvidenceStatement(
  fact: PlanEvidenceBundle["facts"][number],
): string {
  const summary = String(fact.summary || "").trim();
  const structured = formatPlanStructuredEvidenceFacts(fact.structuredFacts)
    .filter((item) => !summary.includes(item));
  const sourceProvenance = normalizePlanSourceObservations(fact.sourceObservations)
    .map((item) =>
      `source_observation(${item.path}:L${item.startLine}-L${item.endLine},${item.excerptHash},version=${item.versionToken})`
    );
  return [summary, ...structured, ...sourceProvenance].filter(Boolean).join(" ");
}

function clonePlanSourceObservations(values: unknown): PlanSourceObservation[] {
  return normalizePlanSourceObservations(values).map((item) => ({ ...item }));
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => String(value || "").trim()).filter(Boolean)));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isScalar(value: unknown): value is string | number | boolean | null {
  return value === null || ["string", "number", "boolean"].includes(typeof value);
}

function validationSegmentsMatch(
  actual: unknown,
  expected: Array<{
    command: string;
    connector: string;
    role: string;
    capability?: string;
  }>,
): boolean {
  if (!Array.isArray(actual) || actual.length !== expected.length) return false;
  return actual.every((entry, index) => {
    if (!entry || typeof entry !== "object") return false;
    const expectedEntry = expected[index];
    const segment = entry as Record<string, unknown>;
    return !!expectedEntry &&
      segment.command === expectedEntry.command &&
      segment.connector === expectedEntry.connector &&
      segment.role === expectedEntry.role &&
      segment.capability === expectedEntry.capability;
  });
}

const ASSERTION_MATCHERS = new Set([
  "equals",
  "not_equals",
  "contains",
  "matches",
  "exists",
  "not_exists",
  "runtime_result",
]);

/**
 * Revalidate persisted/provider-supplied primitives against the structured
 * runtime contract. Candidate prose is deliberately not consulted here.
 */
function isStructuredValidationPrimitive(value: unknown): value is ValidationPrimitiveSpec {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const primitive = value as Record<string, unknown>;
  if (
    (primitive.id !== undefined && !isNonEmptyString(primitive.id)) ||
    (primitive.description !== undefined && typeof primitive.description !== "string")
  ) return false;

  try {
    if (primitive.kind === "finite_command") {
      if (
        primitive.acceptance !== "required" ||
        !isNonEmptyString(primitive.command) ||
        (primitive.cwd !== undefined && !isNonEmptyString(primitive.cwd)) ||
        (primitive.timeoutMs !== undefined &&
          (typeof primitive.timeoutMs !== "number" || !Number.isFinite(primitive.timeoutMs)))
      ) return false;
      const analyzed = analyzeValidationCommand(primitive.command, {
        ...(typeof primitive.cwd === "string" ? { cwd: primitive.cwd } : {}),
        ...(typeof primitive.timeoutMs === "number" ? { timeoutMs: primitive.timeoutMs } : {}),
      });
      return analyzed.spec?.kind === "finite_command" &&
        primitive.capability === analyzed.spec.capability &&
        validationSegmentsMatch(primitive.segments, analyzed.spec.segments) &&
        isAcceptanceCapableValidationSpec(value as ValidationPrimitiveSpec);
    }

    if (primitive.kind === "service_observation") {
      const readiness = primitive.readiness;
      if (
        primitive.acceptance !== "advisory" ||
        !isNonEmptyString(primitive.launchCommand) ||
        !isNonEmptyString(primitive.ownerKey) ||
        (primitive.cwd !== undefined && !isNonEmptyString(primitive.cwd)) ||
        !readiness || typeof readiness !== "object" || Array.isArray(readiness)
      ) return false;
      const readinessRecord = readiness as Record<string, unknown>;
      if (
        !["process_status", "output_pattern", "port", "custom"].includes(String(readinessRecord.kind || "")) ||
        !isScalar(readinessRecord.expected) ||
        (readinessRecord.target !== undefined && !isNonEmptyString(readinessRecord.target))
      ) return false;
      const analyzed = analyzeValidationCommand(primitive.launchCommand, {
        ...(typeof primitive.cwd === "string" ? { cwd: primitive.cwd } : {}),
        ownerKey: primitive.ownerKey,
        readiness: readiness as ServiceReadinessSpec,
      });
      return analyzed.spec?.kind === "service_observation" &&
        validationSegmentsMatch(primitive.segments, analyzed.spec.segments);
    }

    if (primitive.kind === "browser_interaction" || primitive.kind === "desktop_interaction") {
      if (
        (primitive.acceptance !== "required" && primitive.acceptance !== "advisory") ||
        !Array.isArray(primitive.actions) ||
        !Array.isArray(primitive.assertions) ||
        (primitive.requireCausalAssertion !== undefined &&
          typeof primitive.requireCausalAssertion !== "boolean")
      ) return false;
      const actions = primitive.actions as unknown[];
      const assertions = primitive.assertions as unknown[];
      if (actions.some((entry) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) return true;
        const action = entry as Record<string, unknown>;
        return !isNonEmptyString(action.kind) ||
          !isNonEmptyString(action.target) ||
          (action.id !== undefined && !isNonEmptyString(action.id));
      })) return false;
      if (assertions.some((entry) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) return true;
        const assertion = entry as Record<string, unknown>;
        return !isNonEmptyString(assertion.kind) ||
          !isNonEmptyString(assertion.target) ||
          (assertion.afterActionId !== undefined && !isNonEmptyString(assertion.afterActionId)) ||
          (assertion.expected !== undefined && !isScalar(assertion.expected));
      })) return false;
      return isAcceptanceCapableValidationSpec({
        ...primitive,
        acceptance: "required",
      } as ValidationPrimitiveSpec);
    }

    if (primitive.kind === "assertion") {
      if (
        primitive.acceptance !== "advisory" ||
        !isNonEmptyString(primitive.target) ||
        !ASSERTION_MATCHERS.has(String(primitive.matcher || "")) ||
        (primitive.expected !== undefined && !isScalar(primitive.expected))
      ) return false;
      return isWellFormedAdvisoryAssertionSpec(value as AssertionValidationSpec);
    }

    if (primitive.kind === "advisory") {
      return primitive.acceptance === "advisory" &&
        isNonEmptyString(primitive.note) &&
        (primitive.owner === undefined || ["user", "external", "runtime"].includes(String(primitive.owner)));
    }
  } catch {
    return false;
  }
  return false;
}

function appendNodeIdFailures(
  failures: string[],
  nodes: Array<{ id: string }>,
  kind: "evidence" | "diagnosis" | "change" | "decision" | "validation",
  prefix: "E" | "R" | "C" | "D" | "V",
): void {
  const seen = new Set<string>();
  nodes.forEach((node, index) => {
    const id = node?.id;
    if (typeof id !== "string" || !new RegExp(`^${prefix}\\d+$`).test(id)) {
      failures.push(`candidate_${kind}_id_invalid:${isNonEmptyString(id) ? id : index + 1}`);
      return;
    }
    if (seen.has(id)) failures.push(`candidate_${kind}_id_duplicate:${id}`);
    seen.add(id);
  });
}

function validateCandidateEvidenceSourceObservations(
  evidence: PlanCandidateEvidence,
): string[] {
  if (evidence.sourceObservations === undefined) return [];
  if (!Array.isArray(evidence.sourceObservations)) {
    return [`candidate_evidence_source_observation_invalid:${evidence.id}`];
  }
  const normalized = normalizePlanSourceObservations(evidence.sourceObservations);
  const canonical = normalized.length === evidence.sourceObservations.length &&
    evidence.sourceObservations.every((raw, index) => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
      const item = raw as PlanSourceObservation;
      const expected = normalized[index];
      return !!expected &&
        item.path === expected.path &&
        item.startLine === expected.startLine &&
        item.endLine === expected.endLine &&
        item.excerpt === expected.excerpt &&
        item.excerptHash === expected.excerptHash &&
        item.versionToken === expected.versionToken &&
        item.requestSignature === expected.requestSignature;
    });
  if (!canonical) {
    return [`candidate_evidence_source_observation_invalid:${evidence.id}`];
  }
  if (normalized.some((item) =>
    !workspacePathsReferToSameFile(item.path, evidence.target)
  )) {
    return [`candidate_evidence_source_observation_target_mismatch:${evidence.id}`];
  }
  return [];
}

function escaped(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function referencesNearToken(content: string, token: string, prefix: "G" | "C" | "R"): string[] {
  const tokenPattern = new RegExp(`(?:^|[^A-Za-z0-9_])${escaped(token)}(?:[^A-Za-z0-9_]|$)`, "i");
  const referencePattern = new RegExp(`\\b${prefix}\\d+\\b`, "gi");
  return unique(String(content || "")
    .split(/\r?\n/)
    .filter((line) => tokenPattern.test(line))
    .flatMap((line) => line.match(referencePattern) || [])
    .map((reference) => reference.toUpperCase())
    .filter((reference) => reference !== token.toUpperCase()));
}

function resolveGoalRefs(content: string, token: string, goals: PlanGoalFacetContract[]): string[] {
  const allowed = new Set(goals.map((goal) => goal.id));
  const explicit = referencesNearToken(content, token, "G").filter((reference) => allowed.has(reference));
  if (explicit.length > 0) return explicit;
  return goals.length === 1 ? [goals[0]!.id] : goals.map((goal) => goal.id);
}

function operationForText(text: string): PlanCandidateChange["operation"] {
  if (/(?:不修改|保持不变|无需改动|preserve|keep\b.{0,40}\bunchanged|no[- ]change)/i.test(text)) return "preserve";
  if (/(?:删除|移除|delete|remove)/i.test(text)) return "delete";
  if (/(?:新增|创建|添加|create|add)/i.test(text)) return "create";
  return "modify";
}

function normalizedGoals(input: {
  authoringContract?: PlanAuthoringContract;
  objective: string;
  goals?: PlanGoalFacetContract[];
}): PlanGoalFacetContract[] {
  const source = input.authoringContract?.facets?.length
    ? input.authoringContract.facets
    : input.goals?.length
      ? input.goals
      : [{ id: "G1", index: 1, text: input.objective }];
  return source.map((goal, index) => ({
    id: String(goal.id || `G${index + 1}`).toUpperCase(),
    index: Number(goal.index) || index + 1,
    text: String(goal.text || input.objective).trim(),
  }));
}

export function createDraftPlanCandidate(input: {
  content: string;
  bundle: PlanEvidenceBundle;
  authoringContract?: PlanAuthoringContract;
  goals?: PlanGoalFacetContract[];
  summary: string[];
  findings: string[];
  diagnoses?: Array<{
    text: string;
    certainty: PlanCandidateDiagnosis["certainty"];
    evidenceRefs: string[];
    chainRefs?: string[];
  }>;
  changes: Array<{
    text: string;
    targetRef: string;
    evidenceRefs: string[];
    diagnosisRefs?: string[];
  }>;
  decisions?: Array<{
    text: string;
    evidenceRefs?: string[];
    diagnosisRefs?: string[];
    disposition?: "change" | "preserve";
  }>;
  interfaces: string[];
  tests: string[];
  assumptions: string[];
  blockingChoices: string[];
}): PlanCandidateV3 {
  const objective = input.authoringContract?.objective || input.bundle.objective;
  const goals = normalizedGoals({
    authoringContract: input.authoringContract,
    objective,
    goals: input.goals,
  });
  const allowedEvidenceRefs = new Set(input.bundle.facts.map((fact) => fact.id));
  const diagnosisInputs = input.diagnoses !== undefined
    ? input.diagnoses
    : input.findings.map((text) => ({
        text,
        certainty: "inferred" as const,
        evidenceRefs: input.bundle.facts.map((fact) => fact.id),
        chainRefs: input.bundle.facts.map((fact) => fact.id),
      }));
  const diagnoses = diagnosisInputs.map((diagnosis, index): PlanCandidateDiagnosis => {
    const evidenceRefs = unique(diagnosis.evidenceRefs)
      .filter((reference) => allowedEvidenceRefs.has(reference));
    const chainRefs = unique(diagnosis.chainRefs || evidenceRefs)
      .filter((reference) => evidenceRefs.includes(reference));
    return {
      id: `R${index + 1}`,
      text: diagnosis.text,
      certainty: diagnosis.certainty,
      evidenceRefs,
      goalRefs: resolveGoalRefs(input.content, `R${index + 1}`, goals),
      chainRefs,
    };
  });
  const changes = input.changes.map((change, index): PlanCandidateChange => {
    const explicitId = change.text.match(/(?:^|\s)(C\d+)\b/i)?.[1]?.toUpperCase();
    const id = explicitId || `C${index + 1}`;
    const explicitDiagnosisRefs = referencesNearToken(input.content, id, "R")
      .filter((reference) => diagnoses.some((diagnosis) => diagnosis.id === reference));
    const requestedDiagnosisRefs = change.diagnosisRefs?.length
      ? change.diagnosisRefs
      : explicitDiagnosisRefs.length > 0
        ? explicitDiagnosisRefs
        : diagnoses
            .filter((diagnosis) => diagnosis.evidenceRefs.some((reference) =>
              change.evidenceRefs.includes(reference)
            ))
            .map((diagnosis) => diagnosis.id);
    const diagnosisRefs = unique(requestedDiagnosisRefs);
    return {
      id,
      text: change.text,
      targetRef: change.targetRef,
      evidenceRefs: unique(change.evidenceRefs),
      diagnosisRefs,
      goalRefs: resolveGoalRefs(input.content, id, goals),
      operation: operationForText(change.text),
      expectedOutcome: change.text,
      relationships: [],
      executionEvidence: [],
    };
  });
  const decisions = (input.decisions || []).map((decision, index): PlanCandidateDecision => {
    const explicitId = decision.text.match(/(?:^|\s)(D\d+)\b/i)?.[1]?.toUpperCase();
    const id = explicitId || `D${index + 1}`;
    return {
      id,
      text: decision.text,
      goalRefs: resolveGoalRefs(input.content, id, goals),
      evidenceRefs: unique(decision.evidenceRefs || []),
      diagnosisRefs: unique(decision.diagnosisRefs || diagnoses
        .filter((diagnosis) => diagnosis.evidenceRefs.some((reference) =>
          (decision.evidenceRefs || []).includes(reference)
        ))
        .map((diagnosis) => diagnosis.id)),
      disposition: decision.disposition || "preserve",
    };
  });
  const authoringContractId = input.authoringContract?.contractId || `legacy-${stableHash(JSON.stringify({
    objective,
    goals,
  }))}`;
  const projectionContent = String(input.content || "").replace(/\r\n?/g, "\n").trim();
  return {
    schemaVersion: PLAN_CANDIDATE_SCHEMA_VERSION,
    state: "draft",
    ingress: "legacy_markdown_import",
    contractId: `${authoringContractId}:${input.bundle.hash}`,
    authoringContractId,
    bundleHash: input.bundle.hash,
    objective,
    goals,
    diagnosisRequired: input.authoringContract?.diagnosisRequired === true,
    evidence: input.bundle.facts.map((fact) => ({
      id: fact.id,
      target: fact.target,
      sourceTool: fact.tool,
      statement: projectPlanCandidateEvidenceStatement(fact),
      sourceHash: fact.hash,
      sourceObservations: clonePlanSourceObservations(fact.sourceObservations),
      certainty: "observed",
    })),
    coverageObligations: (input.bundle.coverageObligations || []).map((item) => ({
      ...item,
      evidenceRefs: [...item.evidenceRefs],
      targetRefs: [...item.targetRefs],
    })),
    evidenceReceipt: createPlanEvidenceReceipt(input.bundle),
    summary: [...input.summary],
    diagnoses,
    findings: [...input.findings],
    changes,
    decisions,
    interfaces: [...input.interfaces],
    tests: [...input.tests],
    validations: [],
    assumptions: [...input.assumptions],
    blockingChoices: [...input.blockingChoices],
    projection: {
      format: "markdown",
      content: projectionContent,
      contentHash: hashPlanProjection(projectionContent),
    },
  };
}

function validationEvidenceForPrimitive(primitive: ValidationPrimitiveSpec): PlanTaskEvidence[] {
  switch (primitive.kind) {
    case "finite_command":
      return [{ kind: "cmd", value: primitive.command }];
    case "service_observation":
      return [{ kind: "dev_server_url", value: primitive.ownerKey }];
    case "browser_interaction":
      return primitive.assertions.map((assertion) => ({
        kind: "browser_dom" as const,
        value: assertion.target,
        requiresInteraction: primitive.actions.length > 0,
      }));
    case "desktop_interaction":
      return [{ kind: "tauri_required", value: primitive.assertions.map((item) => item.target).join(", ") }];
    case "assertion":
      return [{ kind: "text", value: primitive.target }];
    case "advisory":
      return [{ kind: "manual_user_validation", value: primitive.note }];
  }
}

export function sealPlanCandidate(input: {
  candidate: PlanCandidateV3;
  content: string;
  runtimeTasks: PlanTask[];
}): PlanCandidateV3 {
  const content = String(input.content || "").replace(/\r\n?/g, "\n").trim();
  // A typed-runtime proposal already owns the validation graph. Re-projecting
  // it from Markdown/task prose would reintroduce language-sensitive authority.
  // Legacy imports have no typed validation graph and keep the compatibility
  // projection until their persisted artifact is migrated.
  const validations: PlanCandidateValidation[] = input.candidate.ingress === "typed_runtime"
    ? input.candidate.validations.map((validation) => ({
        ...validation,
        goalRefs: [...validation.goalRefs],
        changeRefs: [...validation.changeRefs],
        primitive: { ...validation.primitive },
        blocking: isAcceptanceCapableValidationSpec(validation.primitive),
      }))
    : [];
  const changes = input.candidate.changes.map((change) => {
    const normalizedTarget = change.targetRef.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
    const matchingTask = input.runtimeTasks.find((task) =>
      task.executionKind !== "validation" &&
      (task.evidence || []).some((evidence) =>
        evidence.kind === "file" &&
        evidence.value.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase() === normalizedTarget
      )
    );
    return matchingTask?.evidence?.length
      ? { ...change, executionEvidence: matchingTask.evidence.map((evidence) => ({ ...evidence })) }
      : change;
  });
  if (input.candidate.ingress !== "typed_runtime") {
    let validationIndex = 0;
    for (const task of input.runtimeTasks) {
      const primitives = projectPlanTaskValidationPrimitives(task);
      for (const primitive of primitives) {
        validationIndex += 1;
        const id = `V${validationIndex}`;
        const taskGoalRefs = unique([
          ...(task.goalRefs || []),
          ...(task.requirementRef ? task.requirementRef.match(/\bG\d+\b/gi) || [] : []),
        ].map((reference) => reference.toUpperCase()));
        validations.push({
          id,
          goalRefs: taskGoalRefs.length > 0
            ? taskGoalRefs
            : resolveGoalRefs(content, id, input.candidate.goals),
          changeRefs: referencesNearToken(content, id, "C")
            .filter((reference) => input.candidate.changes.some((change) => change.id === reference)),
          primitive: { ...primitive, id, description: primitive.description || task.text },
          expectedOutcome: task.text,
          blocking: isAcceptanceCapableValidationSpec(primitive),
        });
      }
    }
  }
  return {
    ...input.candidate,
    state: "sealed",
    changes,
    validations,
    projection: {
      format: "markdown",
      content,
      contentHash: hashPlanProjection(content),
    },
  };
}

export function renderPlanCandidateMarkdown(candidate: PlanCandidateV3): string {
  return candidate.projection.content;
}

export function derivePlanTasksFromCandidate(candidate: PlanCandidateV3): PlanTask[] {
  const mutationTasks = candidate.changes
    .filter((change) => change.operation !== "preserve")
    .map((change): PlanTask => ({
      id: `plan-contract:${change.id.toLowerCase()}`,
      text: change.text,
      status: "pending",
      claimedStatus: "pending",
      executionKind: change.operation === "create" ? "deliverable" : "mutation",
      requirementRef: change.goalRefs.join(","),
      goalRefs: [...change.goalRefs],
      changeRef: change.id,
      evidence: change.executionEvidence.length > 0
        ? change.executionEvidence.map((evidence) => ({ ...evidence }))
        : change.targetRef
          ? [{ kind: "file", value: change.targetRef }]
          : [],
      evidenceStatus: "missing",
    }));
  const validationTasks = candidate.validations.map((validation): PlanTask => {
    const blocking = isAcceptanceCapableValidationSpec(validation.primitive);
    const commands = validation.primitive.kind === "finite_command"
      ? [validation.primitive.command]
      : validation.primitive.kind === "service_observation"
        ? [validation.primitive.launchCommand]
        : [];
    return {
      id: `plan-contract:${validation.id.toLowerCase()}`,
      text: validation.expectedOutcome,
      status: "pending",
      claimedStatus: "pending",
      executionKind: "validation",
      requirementRef: validation.goalRefs.join(","),
      goalRefs: [...validation.goalRefs],
      validationRef: validation.id,
      commands,
      evidence: validationEvidenceForPrimitive(validation.primitive),
      validation: [validation.primitive],
      evidenceStatus: blocking ? "missing" : "requires_user_confirmation",
    };
  });
  return [...mutationTasks, ...validationTasks];
}

function validateSealedPlanCandidateUnsafe(input: {
  candidate: PlanCandidateV3;
  expectedContent?: string;
  expectedBundleHash?: string;
}): string[] {
  const failures: string[] = [];
  const candidate = input.candidate;
  if (candidate.schemaVersion !== PLAN_CANDIDATE_SCHEMA_VERSION) failures.push("candidate_schema_mismatch");
  if (candidate.state !== "sealed") failures.push("candidate_not_sealed");
  if (!candidate.authoringContractId || !candidate.bundleHash || !candidate.contractId) {
    failures.push("candidate_identity_missing");
  } else if (candidate.contractId !== `${candidate.authoringContractId}:${candidate.bundleHash}`) {
    failures.push("candidate_contract_binding_mismatch");
  }
  if (input.expectedBundleHash && candidate.bundleHash !== input.expectedBundleHash) failures.push("evidence_bundle_hash_mismatch");
  if (candidate.goals.length === 0) failures.push("candidate_goal_missing");
  if (candidate.changes.length === 0 && candidate.decisions.length === 0) {
    failures.push("candidate_action_missing");
  }
  appendNodeIdFailures(failures, candidate.evidence, "evidence", "E");
  appendNodeIdFailures(failures, candidate.diagnoses, "diagnosis", "R");
  appendNodeIdFailures(failures, candidate.changes, "change", "C");
  appendNodeIdFailures(failures, candidate.decisions, "decision", "D");
  appendNodeIdFailures(failures, candidate.validations, "validation", "V");
  for (const evidence of candidate.evidence) {
    failures.push(...validateCandidateEvidenceSourceObservations(evidence));
  }
  failures.push(...validateCandidateAgainstPlanEvidenceReceipt(candidate));
  failures.push(...validatePlanValidationSurfaces({
    changes: candidate.changes,
    validations: candidate.validations,
    evidenceFacts: Array.isArray(candidate.evidenceReceipt?.facts)
      ? candidate.evidenceReceipt.facts.map((fact) => ({
          id: fact.id,
          target: fact.target,
          structuredFacts: Array.isArray(fact.structuredFactBindings)
            ? fact.structuredFactBindings.map((binding) => binding.fact)
            : [],
        }))
      : [],
  }));

  const evidenceIds = new Set((candidate.evidence || []).map((evidence) => evidence.id));
  const diagnoses = Array.isArray(candidate.diagnoses) ? candidate.diagnoses : [];
  if (!Array.isArray(candidate.diagnoses)) failures.push("candidate_diagnoses_missing");
  if (typeof candidate.diagnosisRequired !== "boolean") failures.push("candidate_diagnosis_requirement_missing");
  const goalIds = new Set((candidate.goals || []).map((goal) => goal.id));
  const diagnosisIds = new Set(diagnoses.map((diagnosis) => diagnosis.id));
  const changeIds = new Set(candidate.changes.map((change) => change.id));
  for (const diagnosis of diagnoses) {
    if (!["observed", "inferred", "hypothesis"].includes(diagnosis.certainty)) {
      failures.push(`candidate_diagnosis_certainty_invalid:${diagnosis.id}`);
    }
    if (
      (diagnosis.certainty === "observed" || diagnosis.certainty === "inferred") &&
      diagnosis.evidenceRefs.length === 0
    ) failures.push(`candidate_diagnosis_evidence_missing:${diagnosis.id}`);
    if (diagnosis.certainty === "inferred" && diagnosis.chainRefs.length === 0) {
      failures.push(`candidate_diagnosis_chain_missing:${diagnosis.id}`);
    }
    if (diagnosis.evidenceRefs.some((reference) => !evidenceIds.has(reference))) {
      failures.push(`candidate_diagnosis_evidence_invalid:${diagnosis.id}`);
    }
    if (diagnosis.chainRefs.some((reference) =>
      !evidenceIds.has(reference) || !diagnosis.evidenceRefs.includes(reference)
    )) {
      failures.push(`candidate_diagnosis_chain_invalid:${diagnosis.id}`);
    }
    if (!Array.isArray(diagnosis.goalRefs) || diagnosis.goalRefs.length === 0) {
      failures.push(`candidate_diagnosis_goal_missing:${diagnosis.id}`);
    } else if (diagnosis.goalRefs.some((reference) => !goalIds.has(reference))) {
      failures.push(`candidate_diagnosis_goal_invalid:${diagnosis.id}`);
    }
  }
  if (candidate.ingress === "typed_runtime" || candidate.ingress === "runtime_synthesized") {
    failures.push(...validatePlanGoalEvidenceBases({
      facets: candidate.goals,
      components: candidate.evidenceReceipt?.evidenceComponents || [],
      mappings: candidate.goalEvidenceBases || [],
      diagnoses,
      diagnosisRequired: candidate.diagnosisRequired,
    }));
  }
  for (const change of candidate.changes) {
    if (change.evidenceRefs.some((reference) => !evidenceIds.has(reference))) {
      failures.push(`candidate_change_evidence_invalid:${change.id}`);
    }
    const diagnosisRefs = Array.isArray(change.diagnosisRefs) ? change.diagnosisRefs : [];
    if (!Array.isArray(change.diagnosisRefs)) {
      failures.push(`candidate_change_diagnoses_missing:${change.id}`);
    }
    if (diagnosisRefs.some((reference) => !diagnosisIds.has(reference))) {
      failures.push(`candidate_change_diagnosis_invalid:${change.id}`);
    }
    const linkedDiagnoses = diagnosisRefs
      .map((reference) => diagnoses.find((diagnosis) => diagnosis.id === reference))
      .filter((diagnosis): diagnosis is PlanCandidateDiagnosis => !!diagnosis);
    if (
      linkedDiagnoses.length > 0 &&
      linkedDiagnoses.every((diagnosis) => diagnosis.certainty === "hypothesis") &&
      change.evidenceRefs.length === 0
    ) failures.push(`candidate_change_hypothesis_only:${change.id}`);
    if (!Array.isArray(change.goalRefs) || change.goalRefs.length === 0) {
      failures.push(`candidate_change_goal_missing:${change.id}`);
    } else if (change.goalRefs.some((reference) => !goalIds.has(reference))) {
      failures.push(`candidate_change_goal_invalid:${change.id}`);
    }
  }
  for (const decision of candidate.decisions) {
    if (decision.evidenceRefs.some((reference) => !evidenceIds.has(reference))) {
      failures.push(`candidate_decision_evidence_invalid:${decision.id}`);
    }
    if (!Array.isArray(decision.goalRefs) || decision.goalRefs.length === 0) {
      failures.push(`candidate_decision_goal_missing:${decision.id}`);
    } else if (decision.goalRefs.some((reference) => !goalIds.has(reference))) {
      failures.push(`candidate_decision_goal_invalid:${decision.id}`);
    }
    if (!Array.isArray(decision.diagnosisRefs)) {
      failures.push(`candidate_decision_diagnoses_missing:${decision.id}`);
    } else if (decision.diagnosisRefs.some((reference) => !diagnosisIds.has(reference))) {
      failures.push(`candidate_decision_diagnosis_invalid:${decision.id}`);
    }
  }
  const acceptanceValidations: PlanCandidateValidation[] = [];
  for (const validation of candidate.validations) {
    const primitiveIsValid = isStructuredValidationPrimitive(validation.primitive);
    if (!primitiveIsValid) failures.push(`candidate_validation_primitive_invalid:${validation.id}`);
    const computedBlocking = primitiveIsValid && isAcceptanceCapableValidationSpec(validation.primitive);
    if (validation.blocking !== computedBlocking) {
      failures.push(`candidate_validation_blocking_mismatch:${validation.id}`);
    }
    if (primitiveIsValid && computedBlocking) acceptanceValidations.push(validation);
    if (!Array.isArray(validation.goalRefs) || validation.goalRefs.length === 0) {
      failures.push(`candidate_validation_goal_missing:${validation.id}`);
    } else if (validation.goalRefs.some((reference) => !goalIds.has(reference))) {
      failures.push(`candidate_validation_goal_invalid:${validation.id}`);
    }
    if (!Array.isArray(validation.changeRefs)) {
      failures.push(`candidate_validation_changes_missing:${validation.id}`);
    } else if (validation.changeRefs.some((reference) => !changeIds.has(reference))) {
      failures.push(`candidate_validation_change_invalid:${validation.id}`);
    }
  }
  if (acceptanceValidations.length === 0) failures.push("candidate_blocking_validation_missing");
  for (const goal of candidate.goals) {
    const actionCovered = candidate.changes.some((change) => change.goalRefs.includes(goal.id)) ||
      candidate.decisions.some((decision) => decision.goalRefs.includes(goal.id));
    const validationCovered = acceptanceValidations.some((validation) =>
      validation.goalRefs.includes(goal.id)
    );
    if (!actionCovered) failures.push(`candidate_goal_action_missing:${goal.id}`);
    if (!validationCovered) failures.push(`candidate_goal_validation_missing:${goal.id}`);
    if (
      candidate.diagnosisRequired === true &&
      !diagnoses.some((diagnosis) =>
        (diagnosis.certainty === "observed" || diagnosis.certainty === "inferred") &&
        diagnosis.goalRefs.includes(goal.id) &&
        diagnosis.evidenceRefs.length > 0 &&
        diagnosis.evidenceRefs.every((reference) => evidenceIds.has(reference)) &&
        (diagnosis.certainty !== "inferred" || (
          diagnosis.chainRefs.length > 0 &&
          diagnosis.chainRefs.every((reference) =>
            evidenceIds.has(reference) && diagnosis.evidenceRefs.includes(reference)
          )
        ))
      )
    ) failures.push(`candidate_goal_diagnosis_missing:${goal.id}`);
  }
  failures.push(...validatePlanCoverageClosure(candidate));
  const rendered = renderPlanCandidateMarkdown(candidate);
  if (candidate.projection.format !== "markdown") failures.push("candidate_projection_format_mismatch");
  if (candidate.projection.contentHash !== hashPlanProjection(rendered)) failures.push("candidate_projection_hash_mismatch");
  if (
    input.expectedContent !== undefined &&
    rendered.replace(/\r\n?/g, "\n").trim() !== String(input.expectedContent).replace(/\r\n?/g, "\n").trim()
  ) failures.push("candidate_projection_content_mismatch");
  return unique(failures);
}

/**
 * Total validation boundary for persisted/provider-supplied candidate data.
 * Invalid runtime shapes are rejected as data and never escape as exceptions
 * into a Store commit, restore, or approval transition.
 */
export function validateSealedPlanCandidate(input: {
  candidate: PlanCandidateV3;
  expectedContent?: string;
  expectedBundleHash?: string;
}): string[] {
  try {
    return validateSealedPlanCandidateUnsafe(input);
  } catch {
    return ["candidate_payload_malformed"];
  }
}
