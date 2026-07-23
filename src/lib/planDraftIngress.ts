import type { PlanAuthoringContract } from "./planAuthoringContract";
import {
  hashPlanProjection,
  PLAN_CANDIDATE_SCHEMA_VERSION,
  projectPlanCandidateEvidenceStatement,
  type PlanCandidateChange,
  type PlanCandidateDecision,
  type PlanCandidateDiagnosis,
  type PlanCandidateV3,
  type PlanCandidateValidation,
} from "./planContract";
import type { PlanEvidenceBundle } from "./planEvidence";
import {
  analyzeValidationCommand,
  isAcceptanceCapableValidationSpec,
  isWellFormedAdvisoryAssertionSpec,
  SUPPORTED_BROWSER_INTERACTION_ACTION_KINDS,
  SUPPORTED_DESKTOP_INTERACTION_ACTION_KINDS,
  SUPPORTED_INTERACTION_ASSERTION_KINDS,
  type AssertionMatcher,
  type AssertionResultProducer,
  type ServiceReadinessSpec,
  type ValidationInteractionActionSpec,
  type ValidationInteractionAssertionSpec,
  type ValidationPrimitiveSpec,
} from "./validationContract";
import { workspacePathsReferToSameFile } from "./workspacePaths";
import { validatePlanCoverageClosure } from "./planCoverageContract";
import { normalizePlanSourceObservations } from "./planSourceObservation";
import {
  createPlanEvidenceReceipt,
  validatePlanEvidenceReceipt,
} from "./planEvidenceReceipt";
import {
  normalizePlannedValidationHarness,
  validatePlanValidationSurfaces,
} from "./planValidationSurface";
import {
  validatePlanGoalEvidenceBases,
  type PlanGoalEvidenceBasis,
} from "./planEvidenceComponents";

export const TYPED_PLAN_DRAFT_SCHEMA_VERSION = 2 as const;

export interface TypedPlanDraftDiagnosis {
  id: string;
  text: string;
  certainty: PlanCandidateDiagnosis["certainty"];
  evidenceRefs: string[];
  goalRefs: string[];
  chainRefs: string[];
}

export interface TypedPlanDraftChange {
  id: string;
  text: string;
  targetRef: string;
  /** Required for create: an existing evidence-backed file/directory owner. */
  targetOwnerRef?: string;
  operation: PlanCandidateChange["operation"];
  evidenceRefs: string[];
  diagnosisRefs: string[];
  goalRefs: string[];
  expectedOutcome: string;
  relationships?: string[];
  plannedValidationHarness?: unknown;
}

export interface TypedPlanDraftDecision {
  id: string;
  text: string;
  disposition: PlanCandidateDecision["disposition"];
  evidenceRefs: string[];
  diagnosisRefs: string[];
  goalRefs: string[];
}

/**
 * Provider-neutral model proposal.  Every semantic edge is an explicit ID
 * reference; prose is display text and is never parsed to recover authority.
 */
export interface TypedPlanDraftV1 {
  schemaVersion: typeof TYPED_PLAN_DRAFT_SCHEMA_VERSION;
  evidenceRefs: string[];
  goalEvidenceBases: PlanGoalEvidenceBasis[];
  summary: string[];
  diagnoses: TypedPlanDraftDiagnosis[];
  changes: TypedPlanDraftChange[];
  decisions: TypedPlanDraftDecision[];
  interfaces: string[];
  validations: Array<{
    id: string;
    goalRefs: string[];
    changeRefs: string[];
    primitive: unknown;
    expectedOutcome: string;
    harnessChangeRef?: string;
  }>;
  assumptions: string[];
  blockingChoices: string[];
}

export type TypedPlanDraftEnvelopeResult =
  | { status: "absent" }
  | { status: "invalid"; failures: string[] }
  | { status: "parsed"; draft: TypedPlanDraftV1 };

export type TypedPlanCandidateIngressResult =
  | { ok: true; candidate: PlanCandidateV3 }
  | { ok: false; failures: string[] };

const TYPED_PLAN_DRAFT_BLOCK_RE =
  /<plan_candidate(?:\s+version=["']?2["']?)?\s*>([\s\S]*?)<\/plan_candidate>/i;

function collectTypedPlanDraftProtocolBlocks(text: string): Array<{ protocol: string; payload: string }> {
  const pattern = new RegExp(TYPED_PLAN_DRAFT_BLOCK_RE.source, "gi");
  return Array.from(String(text || "").matchAll(pattern)).map((match) => ({
    protocol: String(match[0] || "").trim(),
    payload: String(match[1] || "").trim(),
  }));
}

/**
 * Return only complete typed protocol envelopes. Callers may forward the
 * result to typed ingress, which rejects multiplicity explicitly; surrounding
 * reasoning or prose is never promoted into Plan authority.
 */
export function extractTypedPlanDraftProtocolBlock(text: string): string | null {
  const blocks = collectTypedPlanDraftProtocolBlocks(text);
  return blocks.length > 0 ? blocks.map((block) => block.protocol).join("\n") : null;
}

const ASSERTION_MATCHERS = new Set<AssertionMatcher>([
  "equals",
  "not_equals",
  "contains",
  "matches",
  "exists",
  "not_exists",
  "runtime_result",
]);

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function compactString(value: unknown, maxChars = 1_600): string {
  return typeof value === "string"
    ? value.replace(/\r\n?/g, "\n").replace(/[ \t]+/g, " ").trim().slice(0, maxChars)
    : "";
}

function stringList(value: unknown, maxItems = 64, maxChars = 1_600): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value
    .map((item) => compactString(item, maxChars))
    .filter(Boolean)))
    .slice(0, maxItems);
}

function referenceList(value: unknown, prefix: "E" | "G" | "R" | "C" | "B" | "Q"): string[] {
  return stringList(value, 64, 32)
    .map((item) => item.toUpperCase())
    .filter((item) => new RegExp(`^${prefix}\\d+$`).test(item));
}

type ParsedValidationItems<T> =
  | { items: T[] }
  | { items: null; failure: string };

function hasOwn(input: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(input, key);
}

function isValidationScalar(value: unknown): value is string | number | boolean | null {
  return value === null || ["string", "number", "boolean"].includes(typeof value);
}

function validationValueType(value: unknown): string {
  if (value === undefined) return "missing";
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function parseInteractionActions(value: unknown): ParsedValidationItems<ValidationInteractionActionSpec> {
  if (value === undefined) return { items: null, failure: "actions_missing" };
  if (!Array.isArray(value)) return { items: null, failure: "actions_not_array" };
  const actions: ValidationInteractionActionSpec[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const raw = value[index];
    const item = record(raw);
    if (!item) return { items: null, failure: `action_not_object:${index + 1}` };
    const kind = compactString(item?.kind, 80);
    const target = compactString(item?.target, 500);
    if (!kind) return { items: null, failure: `action_kind_missing:${index + 1}` };
    if (!target) return { items: null, failure: `action_target_missing:${index + 1}` };
    const id = compactString(item.id, 80);
    actions.push({ ...(id ? { id } : {}), kind, target });
  }
  return { items: actions };
}

function parseInteractionAssertions(value: unknown): ParsedValidationItems<ValidationInteractionAssertionSpec> {
  if (value === undefined) return { items: null, failure: "assertions_missing" };
  if (!Array.isArray(value)) return { items: null, failure: "assertions_not_array" };
  const assertions: ValidationInteractionAssertionSpec[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const raw = value[index];
    const item = record(raw);
    if (!item) return { items: null, failure: `assertion_not_object:${index + 1}` };
    const kind = compactString(item?.kind, 80);
    const target = compactString(item?.target, 500);
    if (!kind) return { items: null, failure: `assertion_kind_missing:${index + 1}` };
    if (!target) return { items: null, failure: `assertion_target_missing:${index + 1}` };
    const afterActionId = compactString(item.afterActionId, 80);
    const expected = item.expected;
    if (hasOwn(item, "expected") && !isValidationScalar(expected)) {
      return {
        items: null,
        failure: `assertion_expected_type_invalid:${index + 1}:${validationValueType(expected)}`,
      };
    }
    assertions.push({
      kind,
      target,
      ...(afterActionId ? { afterActionId } : {}),
      ...(hasOwn(item, "expected")
        ? { expected: expected as string | number | boolean | null }
        : {}),
    });
  }
  return { items: assertions };
}

function normalizeValidationPrimitive(
  value: unknown,
): { primitive: ValidationPrimitiveSpec | null; failure?: string } {
  const input = record(value);
  if (!input) return { primitive: null, failure: "primitive_not_object" };
  const kind = compactString(input.kind, 80);
  const description = compactString(input.description, 800);
  if (!kind) return { primitive: null, failure: "primitive_kind_missing" };

  if (kind === "finite_command" || kind === "service_observation") {
    const command = compactString(
      kind === "finite_command" ? input.command : input.launchCommand,
      2_000,
    );
    if (!command) {
      return {
        primitive: null,
        failure: kind === "finite_command"
          ? "finite_command_command_missing"
          : "service_observation_launch_command_missing",
      };
    }
    if (hasOwn(input, "cwd") && typeof input.cwd !== "string") {
      return { primitive: null, failure: `${kind}_cwd_type_invalid:${validationValueType(input.cwd)}` };
    }
    const cwd = compactString(input.cwd, 400);
    if (kind === "service_observation" && hasOwn(input, "ownerKey") && typeof input.ownerKey !== "string") {
      return {
        primitive: null,
        failure: `service_observation_owner_key_type_invalid:${validationValueType(input.ownerKey)}`,
      };
    }
    let readiness: ServiceReadinessSpec | undefined;
    if (kind === "service_observation" && hasOwn(input, "readiness")) {
      const readinessInput = record(input.readiness);
      if (!readinessInput) {
        return { primitive: null, failure: "service_observation_readiness_not_object" };
      }
      const readinessKind = compactString(readinessInput.kind, 80);
      if (!readinessKind) {
        return { primitive: null, failure: "service_observation_readiness_kind_missing" };
      }
      if (!["process_status", "output_pattern", "port", "custom"].includes(readinessKind)) {
        return {
          primitive: null,
          failure: `service_observation_readiness_kind_unsupported:${readinessKind}`,
        };
      }
      if (!hasOwn(readinessInput, "expected")) {
        return { primitive: null, failure: "service_observation_readiness_expected_missing" };
      }
      if (
        readinessInput.expected === null ||
        !["string", "number", "boolean"].includes(typeof readinessInput.expected)
      ) {
        return {
          primitive: null,
          failure: `service_observation_readiness_expected_type_invalid:${validationValueType(readinessInput.expected)}`,
        };
      }
      if (hasOwn(readinessInput, "target") && typeof readinessInput.target !== "string") {
        return {
          primitive: null,
          failure: `service_observation_readiness_target_type_invalid:${validationValueType(readinessInput.target)}`,
        };
      }
      readiness = {
        kind: readinessKind as ServiceReadinessSpec["kind"],
        expected: readinessInput.expected as string | number | boolean,
        ...(compactString(readinessInput.target, 500)
          ? { target: compactString(readinessInput.target, 500) }
          : {}),
      };
    }
    const analyzed = analyzeValidationCommand(command, {
      ...(cwd ? { cwd } : {}),
      ...(kind === "service_observation"
        ? {
            ownerKey: compactString(input.ownerKey, 300) || undefined,
            readiness,
          }
        : {}),
    });
    if (!analyzed.spec || analyzed.spec.kind !== kind) {
      return {
        primitive: null,
        failure: `${kind}_invalid:${analyzed.rejectionReason || "kind_mismatch"}`,
      };
    }
    return {
      primitive: {
        ...analyzed.spec,
        ...(description ? { description } : {}),
      },
    };
  }

  if (kind === "browser_interaction" || kind === "desktop_interaction") {
    const parsedActions = parseInteractionActions(input.actions);
    if (!parsedActions.items) {
      return { primitive: null, failure: `${kind}_${parsedActions.failure}` };
    }
    const parsedAssertions = parseInteractionAssertions(input.assertions);
    if (!parsedAssertions.items) {
      return { primitive: null, failure: `${kind}_${parsedAssertions.failure}` };
    }
    const actions = parsedActions.items;
    const assertions = parsedAssertions.items;
    if (assertions.length === 0) {
      return { primitive: null, failure: `${kind}_assertions_empty` };
    }
    const supportedActions = new Set<string>(
      kind === "browser_interaction"
        ? SUPPORTED_BROWSER_INTERACTION_ACTION_KINDS
        : SUPPORTED_DESKTOP_INTERACTION_ACTION_KINDS,
    );
    const unsupportedAction = actions.find((action) =>
      !supportedActions.has(action.kind.trim().toLowerCase())
    );
    if (unsupportedAction) {
      return {
        primitive: null,
        failure: `${kind}_action_kind_unsupported:${unsupportedAction.kind}`,
      };
    }
    const supportedAssertions = new Set<string>(SUPPORTED_INTERACTION_ASSERTION_KINDS);
    const unsupportedAssertion = assertions.find((assertion) =>
      !supportedAssertions.has(assertion.kind.trim().toLowerCase())
    );
    if (unsupportedAssertion) {
      return {
        primitive: null,
        failure: `${kind}_assertion_kind_unsupported:${unsupportedAssertion.kind}`,
      };
    }
    if (actions.length > 0) {
      const missingActionId = actions.findIndex((action) => !action.id);
      if (missingActionId >= 0) {
        return {
          primitive: null,
          failure: `${kind}_causal_contract_invalid:action_id_missing:${missingActionId + 1}`,
        };
      }
      const actionIds = new Set(actions.map((action) => action.id || "").filter(Boolean));
      if (actionIds.size !== actions.length) {
        return { primitive: null, failure: `${kind}_causal_contract_invalid:action_id_duplicate` };
      }
      const missingCausalRef = assertions.findIndex((assertion) => !assertion.afterActionId);
      if (missingCausalRef >= 0) {
        return {
          primitive: null,
          failure: `${kind}_causal_contract_invalid:assertion_after_action_id_missing:${missingCausalRef + 1}`,
        };
      }
      const unknownCausalRef = assertions.findIndex((assertion) =>
        !actionIds.has(assertion.afterActionId || "")
      );
      if (unknownCausalRef >= 0) {
        return {
          primitive: null,
          failure: `${kind}_causal_contract_invalid:assertion_after_action_id_unknown:${unknownCausalRef + 1}`,
        };
      }
    }
    if (hasOwn(input, "requireCausalAssertion") && typeof input.requireCausalAssertion !== "boolean") {
      return {
        primitive: null,
        failure: `${kind}_require_causal_assertion_type_invalid:${validationValueType(input.requireCausalAssertion)}`,
      };
    }
    const primitive: ValidationPrimitiveSpec = {
      kind,
      acceptance: "required",
      actions,
      assertions,
      requireCausalAssertion: actions.length > 0 || input.requireCausalAssertion !== false,
      ...(description ? { description } : {}),
    };
    return isAcceptanceCapableValidationSpec(primitive)
      ? { primitive }
      : { primitive: null, failure: `${kind}_invalid` };
  }

  if (kind === "assertion") {
    if (hasOwn(input, "acceptance") && input.acceptance !== "advisory") {
      return {
        primitive: null,
        failure: `assertion_acceptance_unsupported:${compactString(input.acceptance, 80) || validationValueType(input.acceptance)}`,
      };
    }
    const target = compactString(input.target, 800);
    if (!target) return { primitive: null, failure: "assertion_target_missing" };
    const rawMatcher = compactString(input.matcher, 80);
    if (!rawMatcher) return { primitive: null, failure: "assertion_matcher_missing" };
    if (!ASSERTION_MATCHERS.has(rawMatcher as AssertionMatcher)) {
      return { primitive: null, failure: `assertion_matcher_unsupported:${rawMatcher}` };
    }
    const matcher = rawMatcher as AssertionMatcher;
    const expected = input.expected;
    const matcherNeedsExpected = ["equals", "not_equals", "contains", "matches"].includes(matcher);
    if (matcherNeedsExpected && !hasOwn(input, "expected")) {
      return { primitive: null, failure: "assertion_expected_missing" };
    }
    if (hasOwn(input, "expected") && !isValidationScalar(expected)) {
      return {
        primitive: null,
        failure: `assertion_expected_type_invalid:${validationValueType(expected)}`,
      };
    }
    const rawProducer = compactString(input.producer, 80);
    if (!rawProducer) return { primitive: null, failure: "assertion_producer_missing" };
    const producer = input.producer === "runtime_evidence_ledger" ||
      input.producer === "workspace_file_state" ||
      input.producer === "artifact_store"
      ? input.producer as AssertionResultProducer
      : undefined;
    if (!producer) {
      return { primitive: null, failure: `assertion_producer_unsupported:${rawProducer}` };
    }
    const primitive: ValidationPrimitiveSpec = {
      kind: "assertion",
      acceptance: "advisory",
      target,
      matcher,
      producer,
      ...(hasOwn(input, "expected")
        ? { expected: expected as string | number | boolean | null }
        : {}),
      ...(description ? { description } : {}),
    };
    if (!isWellFormedAdvisoryAssertionSpec(primitive)) {
      return { primitive: null, failure: "assertion_target_producer_contract_invalid" };
    }
    return {
      primitive,
    };
  }

  if (kind === "advisory") {
    const note = compactString(input.note, 800);
    if (!note) return { primitive: null, failure: "advisory_note_missing" };
    if (hasOwn(input, "owner") && !["user", "external", "runtime"].includes(String(input.owner))) {
      return {
        primitive: null,
        failure: `advisory_owner_unsupported:${compactString(input.owner, 80) || validationValueType(input.owner)}`,
      };
    }
    const owner = input.owner === "user" || input.owner === "external" || input.owner === "runtime"
      ? input.owner
      : undefined;
    return {
      primitive: {
        kind: "advisory",
        acceptance: "advisory",
        note,
        ...(owner ? { owner } : {}),
        ...(description ? { description } : {}),
      },
    };
  }

  return { primitive: null, failure: `primitive_kind_unknown:${kind}` };
}

function idsAreUnique(values: Array<{ id: string }>): boolean {
  return new Set(values.map((value) => value.id)).size === values.length;
}

function normalizeWorkspacePath(value: string): string {
  return String(value || "")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/{2,}/g, "/")
    .replace(/\/$/, "") || ".";
}

function parentPath(value: string): string {
  const normalized = normalizeWorkspacePath(value);
  const separator = normalized.lastIndexOf("/");
  return separator < 0 ? "." : normalized.slice(0, separator) || ".";
}

function createTargetBelongsToOwner(targetRef: string, ownerRef: string): boolean {
  const target = normalizeWorkspacePath(targetRef);
  const owner = normalizeWorkspacePath(ownerRef);
  if (!target || target === "." || target.startsWith("../") || target.startsWith("/")) return false;
  // An owner ending in a file-like basename contributes its containing module;
  // a directory/skeleton owner contributes itself. This is a path boundary,
  // never a natural-language or model-specific inference.
  const ownerBase = owner.split("/").pop() || "";
  const boundary = owner === "." || !ownerBase.includes(".") ? owner : parentPath(owner);
  return boundary === "." || parentPath(target) === boundary || parentPath(target).startsWith(`${boundary}/`);
}

function typedDraftFromUnknown(value: unknown): TypedPlanDraftEnvelopeResult {
  const input = record(value);
  if (!input) return { status: "invalid", failures: ["typed_plan_draft_not_object"] };
  if (input.schemaVersion !== TYPED_PLAN_DRAFT_SCHEMA_VERSION) {
    return { status: "invalid", failures: ["typed_plan_draft_schema_mismatch"] };
  }
  const requiredArrays = [
    "evidenceRefs",
    "goalEvidenceBases",
    "diagnoses",
    "changes",
    "decisions",
    "validations",
  ];
  const defaultableArrays = ["summary", "interfaces", "assumptions", "blockingChoices"];
  const missing = [
    ...requiredArrays.filter((key) => !Array.isArray(input[key])),
    ...defaultableArrays.filter((key) => hasOwn(input, key) && !Array.isArray(input[key])),
  ];
  if (missing.length > 0) {
    return { status: "invalid", failures: missing.map((key) => `typed_plan_draft_field_missing:${key}`) };
  }
  return {
    status: "parsed",
    draft: {
      ...input,
      ...Object.fromEntries(defaultableArrays.map((key) => [
        key,
        Array.isArray(input[key]) ? input[key] : [],
      ])),
    } as unknown as TypedPlanDraftV1,
  };
}

export function extractTypedPlanDraftEnvelope(text: string): TypedPlanDraftEnvelopeResult {
  const blocks = collectTypedPlanDraftProtocolBlocks(text);
  if (blocks.length === 0) return { status: "absent" };
  if (blocks.length > 1) {
    return { status: "invalid", failures: ["typed_plan_draft_ambiguous_multiple"] };
  }
  let payload = blocks[0]?.payload || "";
  const fenced = payload.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i);
  if (fenced) payload = String(fenced[1] || "").trim();
  if (!payload || /^```/.test(payload)) {
    return { status: "invalid", failures: ["typed_plan_draft_json_missing"] };
  }
  try {
    return typedDraftFromUnknown(JSON.parse(payload));
  } catch {
    return { status: "invalid", failures: ["typed_plan_draft_json_invalid"] };
  }
}

export function hasTypedPlanDraftEnvelope(text: string): boolean {
  return extractTypedPlanDraftEnvelope(text).status !== "absent";
}

function candidateValidationLine(
  validation: PlanCandidateValidation,
  language: "zh" | "en",
): string {
  const prefix = `[${validation.id}]`;
  switch (validation.primitive.kind) {
    case "finite_command":
      return language === "zh"
        ? `${prefix}${validation.harnessChangeRef ? ` harness=${validation.harnessChangeRef}` : ""} 运行 \`${validation.primitive.command}\`，以有限退出码判定：${validation.expectedOutcome}`
        : `${prefix}${validation.harnessChangeRef ? ` harness=${validation.harnessChangeRef}` : ""} Run \`${validation.primitive.command}\` and require a finite exit result: ${validation.expectedOutcome}`;
    case "service_observation":
      return language === "zh"
        ? `${prefix} 启动并观察长驻服务 \`${validation.primitive.launchCommand}\`（仅作前置观察）：${validation.expectedOutcome}`
        : `${prefix} Launch and observe \`${validation.primitive.launchCommand}\` as an advisory prerequisite: ${validation.expectedOutcome}`;
    case "browser_interaction":
    case "desktop_interaction": {
      const surface = validation.primitive.kind === "browser_interaction"
        ? language === "zh" ? "浏览器" : "browser"
        : language === "zh" ? "桌面" : "desktop";
      const actions = validation.primitive.actions.map((item) => `${item.kind}:${item.target}`).join("; ") || "none";
      const assertions = validation.primitive.assertions.map((item) => `${item.kind}:${item.target}`).join("; ");
      return language === "zh"
        ? `${prefix} 在${surface}执行动作 ${actions}，并断言 ${assertions}：${validation.expectedOutcome}`
        : `${prefix} On the ${surface}, perform ${actions} and assert ${assertions}: ${validation.expectedOutcome}`;
    }
    case "assertion":
      return language === "zh"
        ? `${prefix} 非阻塞观察断言 ${validation.primitive.target} ${validation.primitive.matcher} ${String(validation.primitive.expected ?? "")}：${validation.expectedOutcome}`
        : `${prefix} Advisory assertion ${validation.primitive.target} ${validation.primitive.matcher} ${String(validation.primitive.expected ?? "")}: ${validation.expectedOutcome}`;
    case "advisory":
      return language === "zh"
        ? `${prefix} 非阻塞建议：${validation.primitive.note}`
        : `${prefix} Non-blocking advisory: ${validation.primitive.note}`;
  }
}

function listSection(title: string, lines: string[]): string {
  return [`## ${title}`, ...(lines.length > 0 ? lines.map((line) => `- ${line}`) : ["- None."])].join("\n");
}

/** Render-only projection. No consumer may parse it back into new runtime truth. */
export function renderTypedPlanCandidateMarkdown(
  candidate: PlanCandidateV3,
  language: "zh" | "en",
): string {
  const zh = language === "zh";
  const diagnosisLines = candidate.diagnoses.map((item) =>
    `[${item.id} ${item.certainty}; goals=${item.goalRefs.join(",")}; evidence=${item.evidenceRefs.join(",")}; chain=${item.chainRefs.join("->") || "none"}] ${item.text}`
  );
  const coverageLines = (candidate.coverageObligations || []).map((item) => {
    const diagnoses = candidate.diagnoses
      .filter((diagnosis) => item.evidenceRefs.every((reference) =>
        diagnosis.evidenceRefs.includes(reference)
      ))
      .map((diagnosis) => diagnosis.id);
    const actions = [
      ...candidate.changes
        .filter((change) => change.evidenceRefs.some((reference) =>
          item.evidenceRefs.includes(reference)
        ))
        .map((change) => change.id),
      ...candidate.decisions
        .filter((decision) => decision.evidenceRefs.some((reference) =>
          item.evidenceRefs.includes(reference)
        ))
        .map((decision) => decision.id),
    ];
    const validations = candidate.validations
      .filter((validation) => validation.changeRefs.some((reference) =>
        candidate.changes.some((change) =>
          change.id === reference && actions.includes(change.id)
        )
      ))
      .map((validation) => validation.id);
    return `[${item.id} ${item.kind}; evidence=${item.evidenceRefs.join("+")}; owners=${item.targetRefs.join(",")}] ${item.relationKey} -> ${diagnoses.join("+") || "-"} -> ${actions.join("+") || "-"} -> ${validations.join("+") || "-"}`;
  });
  const changeLines = candidate.changes.flatMap((item) => [
    `[${item.id}; operation=${item.operation}; target=${item.targetRef}${item.targetOwnerRef ? `; owner=${item.targetOwnerRef}` : ""}; goals=${item.goalRefs.join(",")}; evidence=${item.evidenceRefs.join(",")}; diagnoses=${item.diagnosisRefs.join(",") || "none"}${item.plannedValidationHarness ? `; plannedHarness=${item.plannedValidationHarness.surface}:${item.plannedValidationHarness.binding.kind}` : ""}] ${item.text}`,
    `${zh ? "预期结果" : "Expected outcome"}: ${item.expectedOutcome}`,
    ...(item.relationships.length > 0
      ? [`${zh ? "关系" : "Relationships"}: ${item.relationships.join("; ")}`]
      : []),
  ]);
  const decisionLines = candidate.decisions.map((item) =>
    `[${item.id}; disposition=${item.disposition}; goals=${item.goalRefs.join(",")}; evidence=${item.evidenceRefs.join(",") || "none"}; diagnoses=${item.diagnosisRefs.join(",") || "none"}] ${item.text}`
  );
  const traceLines = candidate.goals.map((goal) => {
    const evidence = candidate.evidence.filter((item) =>
      candidate.diagnoses.some((diagnosis) =>
        diagnosis.goalRefs.includes(goal.id) && diagnosis.evidenceRefs.includes(item.id)
      ) || candidate.changes.some((change) =>
        change.goalRefs.includes(goal.id) && change.evidenceRefs.includes(item.id)
      ) || candidate.decisions.some((decision) =>
        decision.goalRefs.includes(goal.id) && decision.evidenceRefs.includes(item.id)
      )
    ).map((item) => item.id);
    const diagnoses = candidate.diagnoses.filter((item) => item.goalRefs.includes(goal.id)).map((item) => item.id);
    const actions = [
      ...candidate.changes.filter((item) => item.goalRefs.includes(goal.id)).map((item) => item.id),
      ...candidate.decisions.filter((item) => item.goalRefs.includes(goal.id)).map((item) => item.id),
    ];
    const validations = candidate.validations.filter((item) => item.goalRefs.includes(goal.id)).map((item) => item.id);
    return `${goal.id} -> ${evidence.join("+") || "-"}${diagnoses.length ? ` -> ${diagnoses.join("+")}` : ""} -> ${actions.join("+") || "-"} -> ${validations.join("+") || "-"}`;
  });
  return [
    `# ${zh ? "计划" : "Plan"}`,
    listSection(zh ? "摘要" : "Summary", candidate.summary),
    listSection(zh ? "冻结目标" : "Frozen Goals", candidate.goals.map((item) => `[${item.id}] ${item.text}`)),
    ...((candidate.goalEvidenceBases || []).length > 0
      ? [listSection(
          zh ? "目标证据基础" : "Goal Evidence Basis",
          (candidate.goalEvidenceBases || []).map((item) =>
            `[${item.goalRef} -> ${item.componentRef}; evidence=${item.evidenceRefs.join("+")}; owners=${item.ownerRefs.join(",")}; relations=${item.relationRefs.join("+") || "none"}; diagnoses=${item.diagnosisRefs.join("+") || "none"}]`
          ),
        )]
      : []),
    listSection(zh ? "已确认证据" : "Confirmed Evidence", candidate.evidence.map((item) =>
      `[${item.id}] ${item.target} (${item.sourceTool}): ${item.statement}`
    )),
    ...(coverageLines.length > 0
      ? [listSection(zh ? "证据闭环" : "Evidence Closure", coverageLines)]
      : []),
    ...(candidate.diagnosisRequired || diagnosisLines.length > 0
      ? [listSection(zh ? "诊断 / 推断" : "Diagnosis / Inference", diagnosisLines)]
      : []),
    listSection(zh ? "关键改动" : "Key Changes", changeLines),
    ...(decisionLines.length > 0 ? [listSection(zh ? "决策" : "Decisions", decisionLines)] : []),
    listSection(zh ? "公共 API / 接口 / 类型" : "Public APIs / Interfaces / Types", candidate.interfaces),
    listSection(zh ? "测试方案" : "Test Plan", candidate.validations.map((item) =>
      candidateValidationLine(item, language)
    )),
    listSection(zh ? "目标追踪" : "Goal Traceability", traceLines),
    listSection(zh ? "假设与默认值" : "Assumptions / Defaults", candidate.assumptions),
  ].join("\n\n").trim();
}

function normalizeTypedValidation(
  raw: TypedPlanDraftV1["validations"][number],
  index: number,
): { validation: PlanCandidateValidation | null; failures: string[] } {
  const item = record(raw);
  const id = compactString(item?.id, 32).toUpperCase();
  const failures: string[] = [];
  if (!/^V\d+$/.test(id)) failures.push(`typed_validation_id_invalid:${index + 1}`);
  const primitiveResult = normalizeValidationPrimitive(item?.primitive);
  if (!primitiveResult.primitive) failures.push(`typed_validation_${id || index + 1}_${primitiveResult.failure || "invalid"}`);
  const expectedOutcome = compactString(item?.expectedOutcome, 1_200);
  const rawHarnessChangeRef = compactString(item?.harnessChangeRef, 32).toUpperCase();
  const harnessChangeRef = /^C\d+$/.test(rawHarnessChangeRef) ? rawHarnessChangeRef : "";
  if (item && hasOwn(item, "harnessChangeRef") && !harnessChangeRef) {
    failures.push(`typed_validation_harness_change_ref_invalid:${id || index + 1}`);
  }
  if (!expectedOutcome) failures.push(`typed_validation_outcome_missing:${id || index + 1}`);
  if (failures.length > 0 || !primitiveResult.primitive) return { validation: null, failures };
  return {
    validation: {
      id,
      goalRefs: referenceList(item?.goalRefs, "G"),
      changeRefs: referenceList(item?.changeRefs, "C"),
      ...(harnessChangeRef ? { harnessChangeRef } : {}),
      primitive: { ...primitiveResult.primitive, id },
      expectedOutcome,
      blocking: isAcceptanceCapableValidationSpec(primitiveResult.primitive),
    },
    failures: [],
  };
}

export function createTypedRuntimePlanCandidate(input: {
  draft: TypedPlanDraftV1;
  bundle: PlanEvidenceBundle;
  authoringContract: PlanAuthoringContract;
  language: "zh" | "en";
}): TypedPlanCandidateIngressResult {
  const { draft, bundle, authoringContract } = input;
  const failures: string[] = [];
  const goalIds = new Set(authoringContract.facets.map((goal) => goal.id));
  const factById = new Map(bundle.facts.map((fact) => [fact.id.toUpperCase(), fact]));
  const selectedEvidenceRefs = referenceList(draft.evidenceRefs, "E");
  const draftRequiresEvidence = draft.changes.length > 0 ||
    draft.diagnoses.some((item) => item.certainty !== "hypothesis") ||
    draft.decisions.some((item) => Array.isArray(item.evidenceRefs) && item.evidenceRefs.length > 0);
  if (draftRequiresEvidence && selectedEvidenceRefs.length === 0) {
    failures.push("typed_evidence_refs_missing");
  }
  for (const reference of selectedEvidenceRefs) {
    if (!factById.has(reference)) failures.push(`typed_evidence_ref_invalid:${reference}`);
  }

  const diagnoses: PlanCandidateDiagnosis[] = (Array.isArray(draft.diagnoses) ? draft.diagnoses : []).map((raw, index) => {
    const item = record(raw);
    const id = compactString(item?.id, 32).toUpperCase();
    const certainty = item?.certainty === "observed" || item?.certainty === "inferred" || item?.certainty === "hypothesis"
      ? item.certainty
      : "hypothesis";
    const diagnosis: PlanCandidateDiagnosis = {
      id,
      text: compactString(item?.text, 1_600),
      certainty,
      evidenceRefs: referenceList(item?.evidenceRefs, "E"),
      goalRefs: referenceList(item?.goalRefs, "G"),
      chainRefs: referenceList(item?.chainRefs, "E"),
    };
    if (!/^R\d+$/.test(id)) failures.push(`typed_diagnosis_id_invalid:${index + 1}`);
    if (!diagnosis.text) failures.push(`typed_diagnosis_text_missing:${id || index + 1}`);
    if (diagnosis.goalRefs.length === 0) failures.push(`typed_diagnosis_goal_missing:${id || index + 1}`);
    if (diagnosis.goalRefs.some((reference) => !goalIds.has(reference))) failures.push(`typed_diagnosis_goal_invalid:${id || index + 1}`);
    if (diagnosis.evidenceRefs.some((reference) => !selectedEvidenceRefs.includes(reference))) failures.push(`typed_diagnosis_evidence_invalid:${id || index + 1}`);
    if (certainty !== "hypothesis" && diagnosis.evidenceRefs.length === 0) failures.push(`typed_diagnosis_evidence_missing:${id || index + 1}`);
    if (certainty === "inferred" && diagnosis.chainRefs.length === 0) failures.push(`typed_diagnosis_chain_missing:${id || index + 1}`);
    if (diagnosis.chainRefs.some((reference) => !diagnosis.evidenceRefs.includes(reference))) failures.push(`typed_diagnosis_chain_invalid:${id || index + 1}`);
    return diagnosis;
  });
  if (!idsAreUnique(diagnoses)) failures.push("typed_diagnosis_ids_duplicate");
  const diagnosisIds = new Set(diagnoses.map((item) => item.id));

  const goalEvidenceBases: PlanGoalEvidenceBasis[] = (
    Array.isArray(draft.goalEvidenceBases) ? draft.goalEvidenceBases : []
  ).map((raw) => {
    const item = record(raw);
    return {
      goalRef: compactString(item?.goalRef, 32).toUpperCase(),
      componentRef: compactString(item?.componentRef, 32).toUpperCase(),
      evidenceRefs: referenceList(item?.evidenceRefs, "E"),
      ownerRefs: stringList(item?.ownerRefs, 64, 500),
      relationRefs: referenceList(item?.relationRefs, "Q"),
      diagnosisRefs: referenceList(item?.diagnosisRefs, "R"),
    };
  });
  if (goalEvidenceBases.some((mapping) =>
    mapping.evidenceRefs.some((reference) => !selectedEvidenceRefs.includes(reference))
  )) failures.push("typed_goal_evidence_not_selected");
  failures.push(...validatePlanGoalEvidenceBases({
    facets: authoringContract.facets,
    components: bundle.evidenceComponents || [],
    mappings: goalEvidenceBases,
    diagnoses,
    diagnosisRequired: authoringContract.diagnosisRequired,
  }));

  const changes: PlanCandidateChange[] = (Array.isArray(draft.changes) ? draft.changes : []).map((raw, index) => {
    const item = record(raw);
    const id = compactString(item?.id, 32).toUpperCase();
    const operation = item?.operation === "create" || item?.operation === "delete" || item?.operation === "preserve"
      ? item.operation
      : item?.operation === "modify" ? "modify" : "modify";
    const plannedValidationHarness = normalizePlannedValidationHarness(item?.plannedValidationHarness);
    const change: PlanCandidateChange = {
      id,
      text: compactString(item?.text, 1_600),
      targetRef: compactString(item?.targetRef, 500),
      ...(compactString(item?.targetOwnerRef, 500)
        ? { targetOwnerRef: compactString(item?.targetOwnerRef, 500) }
        : {}),
      operation,
      evidenceRefs: referenceList(item?.evidenceRefs, "E"),
      diagnosisRefs: referenceList(item?.diagnosisRefs, "R"),
      goalRefs: referenceList(item?.goalRefs, "G"),
      expectedOutcome: compactString(item?.expectedOutcome, 1_600),
      relationships: stringList(item?.relationships, 24, 800),
      executionEvidence: [],
      ...(plannedValidationHarness ? { plannedValidationHarness } : {}),
    };
    if (!/^C\d+$/.test(id)) failures.push(`typed_change_id_invalid:${index + 1}`);
    if (!change.text) failures.push(`typed_change_text_missing:${id || index + 1}`);
    if (!change.targetRef) failures.push(`typed_change_target_missing:${id || index + 1}`);
    if (!change.expectedOutcome) failures.push(`typed_change_outcome_missing:${id || index + 1}`);
    if (!item || !["modify", "create", "delete", "preserve"].includes(String(item.operation || ""))) failures.push(`typed_change_operation_invalid:${id || index + 1}`);
    if (item && hasOwn(item, "plannedValidationHarness") && !plannedValidationHarness) {
      failures.push(`typed_planned_harness_invalid:${id || index + 1}`);
    }
    if (change.goalRefs.length === 0 || change.goalRefs.some((reference) => !goalIds.has(reference))) failures.push(`typed_change_goal_invalid:${id || index + 1}`);
    if (change.evidenceRefs.length === 0 || change.evidenceRefs.some((reference) => !selectedEvidenceRefs.includes(reference))) failures.push(`typed_change_evidence_invalid:${id || index + 1}`);
    if (change.diagnosisRefs.some((reference) => !diagnosisIds.has(reference))) failures.push(`typed_change_diagnosis_invalid:${id || index + 1}`);
    const groundedFacts = change.evidenceRefs.map((reference) => factById.get(reference)).filter(Boolean);
    if (change.operation === "create") {
      if (!change.targetOwnerRef) {
        failures.push(`typed_change_owner_missing:${id || index + 1}`);
      } else {
        const ownerGrounded = groundedFacts.some((fact) =>
          workspacePathsReferToSameFile(fact!.target, change.targetOwnerRef!)
        );
        if (!ownerGrounded || !createTargetBelongsToOwner(change.targetRef, change.targetOwnerRef)) {
          failures.push(`typed_change_owner_ungrounded:${id || index + 1}`);
        }
      }
    } else if (!groundedFacts.some((fact) => workspacePathsReferToSameFile(fact!.target, change.targetRef))) {
      failures.push(`typed_change_target_ungrounded:${id || index + 1}`);
    }
    return change;
  });
  if (!idsAreUnique(changes)) failures.push("typed_change_ids_duplicate");
  const changeIds = new Set(changes.map((item) => item.id));

  const decisions: PlanCandidateDecision[] = (Array.isArray(draft.decisions) ? draft.decisions : []).map((raw, index) => {
    const item = record(raw);
    const id = compactString(item?.id, 32).toUpperCase();
    const decision: PlanCandidateDecision = {
      id,
      text: compactString(item?.text, 1_600),
      disposition: item?.disposition === "change" ? "change" : "preserve",
      evidenceRefs: referenceList(item?.evidenceRefs, "E"),
      diagnosisRefs: referenceList(item?.diagnosisRefs, "R"),
      goalRefs: referenceList(item?.goalRefs, "G"),
    };
    if (!/^D\d+$/.test(id)) failures.push(`typed_decision_id_invalid:${index + 1}`);
    if (!decision.text) failures.push(`typed_decision_text_missing:${id || index + 1}`);
    if (!item || !["change", "preserve"].includes(String(item.disposition || ""))) failures.push(`typed_decision_disposition_invalid:${id || index + 1}`);
    if (decision.goalRefs.length === 0 || decision.goalRefs.some((reference) => !goalIds.has(reference))) failures.push(`typed_decision_goal_invalid:${id || index + 1}`);
    if (decision.evidenceRefs.some((reference) => !selectedEvidenceRefs.includes(reference))) failures.push(`typed_decision_evidence_invalid:${id || index + 1}`);
    if (decision.diagnosisRefs.some((reference) => !diagnosisIds.has(reference))) failures.push(`typed_decision_diagnosis_invalid:${id || index + 1}`);
    return decision;
  });
  if (!idsAreUnique(decisions)) failures.push("typed_decision_ids_duplicate");

  const normalizedValidations = (Array.isArray(draft.validations) ? draft.validations : [])
    .map(normalizeTypedValidation);
  normalizedValidations.forEach((item) => failures.push(...item.failures));
  const validations = normalizedValidations
    .map((item) => item.validation)
    .filter((item): item is PlanCandidateValidation => !!item);
  if (!idsAreUnique(validations)) failures.push("typed_validation_ids_duplicate");
  for (const validation of validations) {
    if (validation.goalRefs.length === 0 || validation.goalRefs.some((reference) => !goalIds.has(reference))) failures.push(`typed_validation_goal_invalid:${validation.id}`);
    if (validation.changeRefs.some((reference) => !changeIds.has(reference))) failures.push(`typed_validation_change_invalid:${validation.id}`);
  }
  failures.push(...validatePlanValidationSurfaces({
    changes,
    validations,
    evidenceFacts: bundle.facts,
  }));

  if (changes.length === 0 && decisions.length === 0) failures.push("typed_plan_action_missing");
  if (stringList(draft.blockingChoices).length > 0) failures.push("typed_plan_blocking_choice_present");
  for (const goal of authoringContract.facets) {
    const actionCovered = changes.some((item) => item.goalRefs.includes(goal.id)) ||
      decisions.some((item) => item.goalRefs.includes(goal.id));
    const validationCovered = validations.some((item) =>
      item.goalRefs.includes(goal.id) && isAcceptanceCapableValidationSpec(item.primitive)
    );
    if (!actionCovered) failures.push(`typed_goal_action_missing:${goal.id}`);
    if (!validationCovered) failures.push(`typed_goal_validation_missing:${goal.id}`);
    if (
      authoringContract.diagnosisRequired &&
      !diagnoses.some((item) => item.goalRefs.includes(goal.id) && item.certainty !== "hypothesis")
    ) failures.push(`typed_goal_diagnosis_missing:${goal.id}`);
  }
  if (failures.length > 0) return { ok: false, failures: Array.from(new Set(failures)) };

  const candidateBase: PlanCandidateV3 = {
    schemaVersion: PLAN_CANDIDATE_SCHEMA_VERSION,
    state: "draft",
    ingress: "typed_runtime",
    contractId: `${authoringContract.contractId}:${bundle.hash}`,
    authoringContractId: authoringContract.contractId,
    bundleHash: bundle.hash,
    objective: authoringContract.objective,
    goals: authoringContract.facets.map((goal) => ({ ...goal })),
    diagnosisRequired: authoringContract.diagnosisRequired,
    goalEvidenceBases: goalEvidenceBases.map((mapping) => ({
      ...mapping,
      evidenceRefs: [...mapping.evidenceRefs],
      ownerRefs: [...mapping.ownerRefs],
      relationRefs: [...mapping.relationRefs],
      diagnosisRefs: [...mapping.diagnosisRefs],
    })),
    evidence: selectedEvidenceRefs.map((reference) => factById.get(reference)!).map((fact) => ({
      id: fact.id,
      target: fact.target,
      sourceTool: fact.tool,
      statement: projectPlanCandidateEvidenceStatement(fact),
      sourceHash: fact.hash,
      sourceObservations: normalizePlanSourceObservations(fact.sourceObservations)
        .map((item) => ({ ...item })),
      certainty: "observed" as const,
    })),
    coverageObligations: (bundle.coverageObligations || []).map((item) => ({
      ...item,
      evidenceRefs: [...item.evidenceRefs],
      targetRefs: [...item.targetRefs],
    })),
    evidenceReceipt: createPlanEvidenceReceipt(bundle),
    summary: stringList(draft.summary, 24, 1_200),
    diagnoses,
    findings: selectedEvidenceRefs.map((reference) => factById.get(reference)!.summary),
    changes,
    decisions,
    interfaces: stringList(draft.interfaces, 24, 1_200),
    tests: validations.map((item) => item.expectedOutcome),
    validations,
    assumptions: stringList(draft.assumptions, 24, 1_200),
    blockingChoices: [],
    projection: { format: "markdown", content: "", contentHash: hashPlanProjection("") },
  };
  const receiptFailures = validatePlanEvidenceReceipt(candidateBase.evidenceReceipt);
  if (receiptFailures.length > 0) {
    return { ok: false, failures: receiptFailures };
  }
  const coverageFailures = validatePlanCoverageClosure(candidateBase);
  if (coverageFailures.length > 0) {
    return { ok: false, failures: coverageFailures };
  }
  const content = renderTypedPlanCandidateMarkdown(candidateBase, input.language);
  return {
    ok: true,
    candidate: {
      ...candidateBase,
      projection: {
        format: "markdown",
        content,
        contentHash: hashPlanProjection(content),
      },
    },
  };
}

/**
 * Runtime-owned fallback constructor. It creates the same typed graph as a
 * model proposal directly from frozen evidence and trusted finite commands;
 * model-authored Markdown never participates in this authority path.
 */
export function createRuntimeSynthesizedPlanCandidate(input: {
  bundle: PlanEvidenceBundle;
  authoringContract: PlanAuthoringContract;
  language: "zh" | "en";
  validationCommands: string[];
  diagnosisText?: string;
}): TypedPlanCandidateIngressResult {
  const evidenceRefs = input.bundle.facts.map((fact) => fact.id);
  const finiteCommands = input.validationCommands.filter((command) =>
    analyzeValidationCommand(command).spec?.kind === "finite_command"
  );
  if (finiteCommands.length === 0) {
    return { ok: false, failures: ["typed_plan_executable_validation_missing"] };
  }
  if (input.authoringContract.facets.length !== 1) {
    return { ok: false, failures: ["typed_goal_evidence_semantic_mapping_required"] };
  }
  const goalRefs = input.authoringContract.facets.map((goal) => goal.id);
  const diagnosisText = compactString(input.diagnosisText, 1_600) ||
    input.bundle.facts.map((fact) => fact.summary).join("; ");
  const relationshipDiagnosisRequired = (input.bundle.coverageObligations || [])
    .some((obligation) => obligation.kind !== "confirmed_change_rationale");
  const diagnoses: TypedPlanDraftV1["diagnoses"] = (
    input.authoringContract.diagnosisRequired || relationshipDiagnosisRequired
  )
    ? input.authoringContract.facets.map((goal, index) => ({
        id: `R${index + 1}`,
        text: diagnosisText,
        certainty: "observed",
        evidenceRefs,
        goalRefs: [goal.id],
        chainRefs: evidenceRefs,
      }))
    : [];
  const changes: TypedPlanDraftV1["changes"] = input.bundle.changeTargets.map((target, index) => ({
    id: `C${index + 1}`,
    text: `${input.language === "zh" ? "更新" : "Update"} ${target} ${input.language === "zh" ? "以满足冻结目标" : "to satisfy the frozen goals"}.`,
    targetRef: target,
    operation: "modify",
    evidenceRefs: input.bundle.facts
      .filter((fact) => workspacePathsReferToSameFile(fact.target, target))
      .map((fact) => fact.id),
    diagnosisRefs: diagnoses.map((diagnosis) => diagnosis.id),
    goalRefs,
    expectedOutcome: input.authoringContract.facets.map((goal) => goal.text).join("; "),
    relationships: [],
  }));
  const changedTargets = new Set(changes.map((change) => normalizeWorkspacePath(change.targetRef).toLowerCase()));
  const coverageEvidenceRefs = new Set((input.bundle.coverageObligations || [])
    .flatMap((obligation) => obligation.evidenceRefs));
  const preservedOwners = new Map<string, { target: string; evidenceRefs: string[] }>();
  for (const fact of input.bundle.facts) {
    if (!coverageEvidenceRefs.has(fact.id)) continue;
    const key = normalizeWorkspacePath(fact.target).toLowerCase();
    if (changedTargets.has(key)) continue;
    const entry = preservedOwners.get(key) || { target: fact.target, evidenceRefs: [] };
    if (!entry.evidenceRefs.includes(fact.id)) entry.evidenceRefs.push(fact.id);
    preservedOwners.set(key, entry);
  }
  const decisions: TypedPlanDraftV1["decisions"] = [...preservedOwners.values()]
    .map((owner, index) => ({
      id: `D${index + 1}`,
      text: input.language === "zh"
        ? `保持 ${owner.target} 的已确认契约不变；该 owner 仅作为跨边界证据与验收依据。`
        : `Preserve the confirmed contract in ${owner.target}; this owner remains cross-boundary evidence and an acceptance reference.`,
      disposition: "preserve",
      evidenceRefs: owner.evidenceRefs,
      diagnosisRefs: diagnoses
        .filter((diagnosis) => diagnosis.evidenceRefs.some((reference) =>
          owner.evidenceRefs.includes(reference)
        ))
        .map((diagnosis) => diagnosis.id),
      goalRefs,
    }));
  const draft: TypedPlanDraftV1 = {
    schemaVersion: TYPED_PLAN_DRAFT_SCHEMA_VERSION,
    evidenceRefs,
    goalEvidenceBases: (input.bundle.evidenceComponents || [])
      .filter((component) => component.requiredForClosure)
      .map((component) => ({
        goalRef: goalRefs[0]!,
        componentRef: component.id,
        evidenceRefs: [...component.evidenceRefs],
        ownerRefs: [...component.ownerRefs],
        relationRefs: [...component.relationRefs],
        diagnosisRefs: diagnoses
          .filter((diagnosis) => component.evidenceRefs.every((reference) =>
            diagnosis.evidenceRefs.includes(reference)
          ))
          .map((diagnosis) => diagnosis.id),
      })),
    summary: [input.language === "zh"
      ? "基于冻结证据生成 runtime-owned typed 计划。"
      : "Runtime-owned typed Plan generated from the frozen evidence bundle."],
    diagnoses,
    changes,
    decisions,
    interfaces: [],
    validations: finiteCommands.map((command, index) => ({
      id: `V${index + 1}`,
      goalRefs,
      changeRefs: changes.map((change) => change.id),
      primitive: { kind: "finite_command", command },
      expectedOutcome: input.language === "zh"
        ? `命令 ${command} 有限结束且退出码为 0。`
        : `${command} terminates with exit status 0.`,
    })),
    assumptions: [],
    blockingChoices: [],
  };
  const result = createTypedRuntimePlanCandidate({
    draft,
    bundle: input.bundle,
    authoringContract: input.authoringContract,
    language: input.language,
  });
  return result.ok
    ? { ok: true, candidate: { ...result.candidate, ingress: "runtime_synthesized" } }
    : result;
}
