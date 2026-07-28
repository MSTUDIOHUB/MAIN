import {
  analyzeValidationCommand,
  isAcceptanceCapableValidationSpec,
  type BrowserInteractionValidationSpec,
  type DesktopInteractionValidationSpec,
  type ValidationInteractionActionSpec,
  type ValidationInteractionAssertionSpec,
  type ValidationPrimitiveSpec,
} from "../validationContract";
import { sha256Hex } from "../sha256";
import { workspacePathsReferToSameFile } from "../workspacePaths";
import type {
  RuntimeV2EvidenceReference,
  RuntimeV2ExecutionValidationAuthority,
  RuntimeV2Objective,
} from "./contracts";

export const RUNTIME_V2_EXECUTION_CONTRACT_SCHEMA_VERSION =
  "runtime-v2-execution-contract.v1" as const;

export type RuntimeV2ExecutionEvidenceRequirement =
  | "static"
  | "behavioral"
  | "interaction";

export type RuntimeV2ExecutionValidationKind =
  | "finite_command"
  | "browser"
  | "desktop";

export interface RuntimeV2ExecutionCriterion {
  readonly id: string;
  readonly text: string;
  readonly required: true;
  readonly evidenceRequirement: RuntimeV2ExecutionEvidenceRequirement;
}

export interface RuntimeV2ExecutionChange {
  readonly operation: "modify" | "create" | "delete";
  readonly target: string;
  readonly basisEvidenceIds: readonly string[];
}

export interface RuntimeV2ExecutionValidation {
  readonly id: string;
  readonly criterionIds: readonly string[];
  readonly targetPaths: readonly string[];
  readonly kind: RuntimeV2ExecutionValidationKind;
  readonly command?: string;
  readonly cwd?: string;
  readonly capability?:
    | "test"
    | "build"
    | "lint"
    | "typecheck"
    | "check"
    | "inline_assertion";
  readonly expectedOutcome: string;
  /** Runtime-normalized executable acceptance primitive. Provider prose and
   * the convenience fields above are never sufficient completion evidence. */
  readonly primitive: ValidationPrimitiveSpec;
  readonly required: true;
}

export interface RuntimeV2ExecutionContractV1 {
  readonly schemaVersion:
    typeof RUNTIME_V2_EXECUTION_CONTRACT_SCHEMA_VERSION;
  readonly id: string;
  readonly revision: number;
  readonly digest: string;
  readonly status: "active" | "invalidated";
  readonly objective: string;
  readonly criteria: readonly RuntimeV2ExecutionCriterion[];
  readonly changes: readonly RuntimeV2ExecutionChange[];
  readonly validations: readonly RuntimeV2ExecutionValidation[];
  readonly committedAt: number;
}

export interface RuntimeV2ExecutionContractDraft {
  readonly criteria: readonly {
    readonly id: string;
    readonly evidenceRequirement: RuntimeV2ExecutionEvidenceRequirement;
  }[];
  readonly changes: readonly {
    readonly operation: "modify" | "create" | "delete";
    readonly target: string;
    readonly basisEvidenceIds: readonly string[];
  }[];
  readonly validations: readonly {
    readonly id: string;
    readonly criterionIds: readonly string[];
    readonly targetPaths: readonly string[];
    readonly kind: RuntimeV2ExecutionValidationKind;
    readonly command?: string;
    readonly cwd?: string;
    readonly actions?: readonly ValidationInteractionActionSpec[];
    readonly assertions?: readonly ValidationInteractionAssertionSpec[];
    readonly requireCausalAssertion?: boolean;
    readonly expectedOutcome: string;
  }[];
}

export interface RuntimeV2ExecutionContractCoverage {
  readonly contractId: string;
  readonly contractRevision: number;
  readonly plannedMutationTargets: readonly string[];
  readonly committedMutationTargets: readonly string[];
  readonly missingMutationTargets: readonly string[];
  readonly requiredCriterionIds: readonly string[];
  readonly passedCriterionIds: readonly string[];
  readonly missingCriterionIds: readonly string[];
  readonly requiredValidationIds: readonly string[];
  readonly passedValidationIds: readonly string[];
  readonly missingValidationIds: readonly string[];
  readonly complete: boolean;
}

function text(value: unknown, max = 2_000): string {
  return typeof value === "string"
    ? value.replace(/\r\n?/g, "\n").trim().slice(0, max)
    : "";
}

function strings(
  value: unknown,
  max = 32,
  itemMax = 1_024,
): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(
    value.map((item) => text(item, itemMax)).filter(Boolean),
  )].slice(0, max);
}

function records(value: unknown, max = 32): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, max).flatMap((entry) =>
    entry && typeof entry === "object" && !Array.isArray(entry)
      ? [entry as Record<string, unknown>]
      : []
  );
}

function interactionActions(
  value: unknown,
): ValidationInteractionActionSpec[] {
  return records(value).map((entry) => ({
    ...(text(entry.id, 128) ? { id: text(entry.id, 128) } : {}),
    kind: text(entry.kind, 80),
    target: text(entry.target, 500),
  }));
}

function interactionAssertions(
  value: unknown,
): ValidationInteractionAssertionSpec[] {
  return records(value).map((entry) => ({
    kind: text(entry.kind, 80),
    target: text(entry.target, 500),
    ...(text(
      entry.after_action_id ?? entry.afterActionId,
      128,
    )
      ? {
          afterActionId: text(
            entry.after_action_id ?? entry.afterActionId,
            128,
          ),
        }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(entry, "expected") &&
      (
        entry.expected === null ||
        ["string", "number", "boolean"].includes(typeof entry.expected)
      )
      ? {
          expected: entry.expected as
            string | number | boolean | null,
        }
      : {}),
  }));
}

function safeTarget(value: unknown): string {
  const target = text(value, 1_024)
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/+/g, "/");
  if (
    !target ||
    target.startsWith("/") ||
    /^[A-Za-z]:\//.test(target) ||
    target.split("/").includes("..")
  ) {
    return "";
  }
  return target;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonical(entry)]),
  );
}

function contractDigest(
  value: Omit<RuntimeV2ExecutionContractV1, "digest">,
): string {
  return `runtime-v2-execution-contract-sha256-${sha256Hex(
    JSON.stringify(canonical(value)),
  )}`;
}

function contractSemanticDigest(
  value: Pick<
    RuntimeV2ExecutionContractV1,
    "objective" | "criteria" | "changes" | "validations"
  >,
): string {
  return sha256Hex(JSON.stringify(canonical({
    objective: value.objective,
    criteria: value.criteria,
    changes: value.changes,
    validations: value.validations,
  })));
}

function criterionIdsForObjective(
  objective: RuntimeV2Objective,
): readonly string[] {
  const supplied = objective.acceptanceCriterionIds || [];
  return objective.acceptanceCriteria.map((_, index) =>
    text(supplied[index], 256) || `criterion-${index + 1}`
  );
}

function normalizeDraft(value: unknown): RuntimeV2ExecutionContractDraft {
  const source =
    value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
  const criteria = Array.isArray(source.criteria)
    ? source.criteria.slice(0, 32).map((item) => {
        const entry =
          item && typeof item === "object" && !Array.isArray(item)
            ? item as Record<string, unknown>
            : {};
        return {
          id: text(entry.id, 256),
          evidenceRequirement: text(
            entry.evidence_requirement ?? entry.evidenceRequirement,
            32,
          ) as RuntimeV2ExecutionEvidenceRequirement,
        };
      })
    : [];
  const changes = Array.isArray(source.changes)
    ? source.changes.slice(0, 24).map((item) => {
        const entry =
          item && typeof item === "object" && !Array.isArray(item)
            ? item as Record<string, unknown>
            : {};
        return {
          operation: text(entry.operation, 32) as
            RuntimeV2ExecutionChange["operation"],
          target: safeTarget(entry.target),
          basisEvidenceIds: strings(
            entry.basis_evidence_ids ?? entry.basisEvidenceIds,
          ),
        };
      })
    : [];
  const validations = Array.isArray(source.validations)
    ? source.validations.slice(0, 32).map((item) => {
        const entry =
          item && typeof item === "object" && !Array.isArray(item)
            ? item as Record<string, unknown>
            : {};
        return {
          id: text(entry.id, 256),
          criterionIds: strings(
            entry.criterion_ids ?? entry.criterionIds,
          ),
          targetPaths: strings(
            entry.target_paths ?? entry.targetPaths,
          ).map(safeTarget).filter(Boolean),
          kind: text(entry.kind, 32) as RuntimeV2ExecutionValidationKind,
          command: text(entry.command, 2_000) || undefined,
          cwd: safeTarget(entry.cwd) || undefined,
          actions: interactionActions(entry.actions),
          assertions: interactionAssertions(entry.assertions),
          requireCausalAssertion:
            typeof (
              entry.require_causal_assertion ??
              entry.requireCausalAssertion
            ) === "boolean"
              ? Boolean(
                  entry.require_causal_assertion ??
                  entry.requireCausalAssertion,
                )
              : undefined,
          expectedOutcome: text(
            entry.expected_outcome ?? entry.expectedOutcome,
            2_000,
          ),
        };
      })
    : [];
  return { criteria, changes, validations };
}

function validationSupports(
  requirement: RuntimeV2ExecutionEvidenceRequirement,
  validation: RuntimeV2ExecutionValidation,
): boolean {
  if (requirement === "static") return true;
  if (
    validation.primitive.kind === "browser_interaction" ||
    validation.primitive.kind === "desktop_interaction"
  ) {
    return requirement === "behavioral" ||
      (
        validation.primitive.actions.length > 0 &&
        validation.primitive.requireCausalAssertion !== false
      );
  }
  if (requirement === "interaction") return false;
  return validation.capability === "test" ||
    validation.capability === "inline_assertion";
}

function evidenceRequirementRank(
  requirement: RuntimeV2ExecutionEvidenceRequirement,
): number {
  if (requirement === "interaction") return 2;
  if (requirement === "behavioral") return 1;
  return 0;
}

function assertContract(
  condition: unknown,
  code: string,
): asserts condition {
  if (!condition) {
    const guidance = code.startsWith("finite_validation_invalid:")
      ? "Use a real bounded test or an executable assertion that exits nonzero on failure. echo, grep, sed, cat, head, tail, and wc only inspect text. For user-visible UI behavior, prefer a browser or desktop validation with a supported action and a causally linked assertion."
      : code.startsWith("criterion_not_acceptance_covered:")
        ? "A static build, lint, typecheck, or check cannot cover behavioral or interaction acceptance. Use a real test, executable assertion, browser interaction, or desktop interaction."
        : code.startsWith("interaction_validation_invalid:")
          ? "Browser or desktop validation needs at least one supported assertion; use a supported action plus an assertion linked by after_action_id when the result must be causal."
          : "";
    throw new Error([
      `RUNTIME_V2_EXECUTION_CONTRACT_INVALID:${code}`,
      guidance,
    ].filter(Boolean).join(". "));
  }
}

/**
 * Compile one provider-authored draft against runtime-owned objective and
 * evidence. The model may choose scope and validators, but it cannot replace
 * criteria, manufacture source versions, or use a static build to prove a
 * behavioral/interaction outcome.
 */
export function compileRuntimeV2ExecutionContract(input: {
  readonly objective: RuntimeV2Objective;
  readonly evidence: readonly RuntimeV2EvidenceReference[];
  readonly draft: unknown;
  readonly previous?: RuntimeV2ExecutionContractV1 | null;
  readonly committedAt: number;
  readonly contractId: string;
}): RuntimeV2ExecutionContractV1 {
  const objectiveText = text(input.objective.text, 12_000);
  const acceptanceTexts = input.objective.acceptanceCriteria
    .map((criterion) => text(criterion, 2_000))
    .filter(Boolean);
  assertContract(objectiveText, "objective_missing");
  assertContract(acceptanceTexts.length > 0, "acceptance_criteria_missing");
  const acceptanceIds = criterionIdsForObjective(input.objective);
  assertContract(
    acceptanceIds.length === acceptanceTexts.length &&
      new Set(acceptanceIds).size === acceptanceIds.length,
    "acceptance_identity_invalid",
  );
  const runtimeRequirements =
    input.objective.acceptanceEvidenceRequirements;
  assertContract(
    !runtimeRequirements ||
      (
        runtimeRequirements.length === acceptanceTexts.length &&
        runtimeRequirements.every((requirement) =>
          requirement === "static" ||
          requirement === "behavioral" ||
          requirement === "interaction"
        )
      ),
    "acceptance_evidence_requirements_invalid",
  );

  const draft = normalizeDraft(input.draft);
  const requirementById = new Map(
    draft.criteria.map((criterion) => [
      criterion.id,
      criterion.evidenceRequirement,
    ]),
  );
  const soleProviderRequirement =
    acceptanceIds.length === 1
      ? draft.criteria
          .map((criterion) => criterion.evidenceRequirement)
          .filter(
            (
              requirement,
            ): requirement is RuntimeV2ExecutionEvidenceRequirement =>
              requirement === "static" ||
              requirement === "behavioral" ||
              requirement === "interaction",
          )
          .reduce<RuntimeV2ExecutionEvidenceRequirement | undefined>(
            (strongest, requirement) =>
              !strongest ||
                evidenceRequirementRank(requirement) >
                  evidenceRequirementRank(strongest)
                ? requirement
                : strongest,
            undefined,
          )
      : undefined;
  const criteria = acceptanceTexts.map(
    (criterionText, index): RuntimeV2ExecutionCriterion => {
      const id = acceptanceIds[index]!;
      const runtimeRequirement =
        runtimeRequirements?.[index] || "behavioral";
      // A sole criterion has no mapping ambiguity. Runtime owns its identity,
      // so a provider alias cannot strand contract creation or downgrade the
      // acceptance class. Multi-criterion objectives still require exact ids.
      const providerRequirement =
        requirementById.get(id) || soleProviderRequirement;
      const providerRequirementValid =
        providerRequirement === "static" ||
        providerRequirement === "behavioral" ||
        providerRequirement === "interaction";
      if (acceptanceIds.length > 1) {
        assertContract(
          providerRequirementValid,
          `criterion_requirement_missing:${id}`,
        );
      }
      const evidenceRequirement =
        providerRequirementValid &&
          evidenceRequirementRank(providerRequirement) >=
          evidenceRequirementRank(runtimeRequirement)
          ? providerRequirement
          : runtimeRequirement;
      return {
        id,
        text: criterionText,
        required: true,
        evidenceRequirement,
      };
    },
  );
  if (criteria.length > 1) {
    assertContract(
      draft.criteria.length === criteria.length &&
        draft.criteria.every((criterion) =>
          criteria.some((candidate) => candidate.id === criterion.id)
        ),
      "criteria_must_match_runtime_objective",
    );
  }

  assertContract(draft.changes.length > 0, "changes_missing");
  const evidenceById = new Map(
    input.evidence.map((evidence) => [evidence.id, evidence]),
  );
  const changes = draft.changes.map(
    (change): RuntimeV2ExecutionChange => {
      assertContract(
        change.operation === "modify" ||
          change.operation === "create" ||
          change.operation === "delete",
        `change_operation_invalid:${change.target || "unknown"}`,
      );
      assertContract(change.target, "change_target_invalid");
      const validProvidedBasis = change.basisEvidenceIds.filter((id) =>
        evidenceById.get(id)?.kind === "source" &&
        !!evidenceById.get(id)?.version
      );
      const matchingVersionedBasis = input.evidence.filter((evidence) =>
        evidence.kind === "source" &&
        !!evidence.version &&
        workspacePathsReferToSameFile(evidence.target, change.target)
      );
      if (change.operation === "modify" || change.operation === "delete") {
        assertContract(
          matchingVersionedBasis.length > 0,
          `versioned_basis_missing:${change.target}`,
        );
      }
      // The runtime, not provider-authored evidence ids, owns the mutation
      // authority binding. A provider may omit an id or select a valid source
      // receipt for a different file; neither should create a retry loop or
      // grant authority. Bind modify/delete to the newest real receipt for the
      // declared target and retain only valid hints for create operations.
      const basisEvidenceIds =
        change.operation === "modify" || change.operation === "delete"
          ? [matchingVersionedBasis[matchingVersionedBasis.length - 1]!.id]
          : [...new Set(validProvidedBasis)];
      return {
        ...change,
        basisEvidenceIds,
      };
    },
  );
  assertContract(
    new Set(changes.map((change) => change.target)).size === changes.length,
    "duplicate_change_target",
  );
  const criteriaById = new Map(criteria.map((criterion) => [
    criterion.id,
    criterion,
  ]));
  const validations = draft.validations.map(
    (validation): RuntimeV2ExecutionValidation => {
      assertContract(validation.id, "validation_id_missing");
      const criterionIds =
        criteria.length === 1
          ? [criteria[0]!.id]
          : validation.criterionIds;
      assertContract(
        validation.kind === "finite_command" ||
          validation.kind === "browser" ||
          validation.kind === "desktop",
        `validation_kind_invalid:${validation.id}`,
      );
      assertContract(
        criterionIds.length > 0 &&
          criterionIds.every((id) => criteriaById.has(id)),
        `validation_criteria_invalid:${validation.id}`,
      );
      assertContract(
        validation.targetPaths.length > 0 &&
          validation.targetPaths.every((target) =>
            changes.some((change) =>
              workspacePathsReferToSameFile(change.target, target)
            )
          ),
        `validation_targets_invalid:${validation.id}`,
      );
      assertContract(
        validation.expectedOutcome,
        `validation_expected_outcome_missing:${validation.id}`,
      );
      if (validation.kind === "finite_command") {
        const analysis = analyzeValidationCommand(
          validation.command || "",
          { cwd: validation.cwd },
        );
        assertContract(
          analysis.spec?.kind === "finite_command",
          `finite_validation_invalid:${validation.id}`,
        );
        return {
          id: validation.id,
          criterionIds,
          targetPaths: validation.targetPaths,
          kind: validation.kind,
          command: analysis.spec.command,
          ...(analysis.spec.cwd ? { cwd: analysis.spec.cwd } : {}),
          capability: analysis.spec.capability,
          expectedOutcome: validation.expectedOutcome,
          primitive: {
            ...analysis.spec,
            id: validation.id,
            description: validation.expectedOutcome,
          },
          required: true,
        };
      }
      const primitive:
        | BrowserInteractionValidationSpec
        | DesktopInteractionValidationSpec = {
        id: validation.id,
        kind: validation.kind === "browser"
          ? "browser_interaction"
          : "desktop_interaction",
        acceptance: "required",
        description: validation.expectedOutcome,
        actions: [...(validation.actions || [])],
        assertions: [...(validation.assertions || [])],
        requireCausalAssertion:
          validation.requireCausalAssertion ??
          (validation.actions?.length || 0) > 0,
      };
      assertContract(
        isAcceptanceCapableValidationSpec(primitive),
        `interaction_validation_invalid:${validation.id}`,
      );
      if (primitive.actions.length > 0) {
        const actionIds = primitive.actions.map((action) =>
          text(action.id, 128)
        );
        assertContract(
          actionIds.every(Boolean) &&
            new Set(actionIds).size === actionIds.length,
          `interaction_action_identity_invalid:${validation.id}`,
        );
        assertContract(
          primitive.assertions.every((assertion) =>
            !!assertion.afterActionId &&
            actionIds.includes(assertion.afterActionId)
          ),
          `interaction_causal_link_invalid:${validation.id}`,
        );
      }
      return {
        id: validation.id,
        criterionIds,
        targetPaths: validation.targetPaths,
        kind: validation.kind,
        expectedOutcome: validation.expectedOutcome,
        primitive,
        required: true,
      };
    },
  );
  assertContract(validations.length > 0, "validations_missing");
  assertContract(
    new Set(validations.map((validation) => validation.id)).size ===
      validations.length,
    "duplicate_validation_id",
  );
  assertContract(
    validations.filter((validation) => validation.kind === "browser")
      .length <= 1 &&
      validations.filter((validation) => validation.kind === "desktop")
        .length <= 1,
    "interaction_validation_kind_ambiguous",
  );
  for (const criterion of criteria) {
    assertContract(
      validations.some((validation) =>
        validation.criterionIds.includes(criterion.id) &&
        validationSupports(criterion.evidenceRequirement, validation)
      ),
      `criterion_not_acceptance_covered:${criterion.id}`,
    );
  }
  for (const change of changes) {
    assertContract(
      validations.some((validation) =>
        validation.targetPaths.some((target) =>
          workspacePathsReferToSameFile(target, change.target)
        )
      ),
      `change_not_validation_covered:${change.target}`,
    );
  }

  const revision = (input.previous?.revision || 0) + 1;
  const withoutDigest: Omit<RuntimeV2ExecutionContractV1, "digest"> = {
    schemaVersion: RUNTIME_V2_EXECUTION_CONTRACT_SCHEMA_VERSION,
    id: text(input.previous?.id || input.contractId, 512),
    revision,
    status: "active",
    objective: objectiveText,
    criteria,
    changes,
    validations,
    committedAt: Math.max(0, Number(input.committedAt) || 0),
  };
  assertContract(withoutDigest.id, "contract_id_missing");
  if (input.previous) {
    assertContract(
      contractSemanticDigest(withoutDigest) !==
        contractSemanticDigest(input.previous),
      "contract_revision_no_change",
    );
  }
  return {
    ...withoutDigest,
    digest: contractDigest(withoutDigest),
  };
}

export function validateRuntimeV2ExecutionContract(input: {
  readonly contract: RuntimeV2ExecutionContractV1;
  readonly objective: RuntimeV2Objective;
  readonly evidence: readonly RuntimeV2EvidenceReference[];
  readonly previous?: RuntimeV2ExecutionContractV1 | null;
}): boolean {
  try {
    const rebuilt = compileRuntimeV2ExecutionContract({
      objective: input.objective,
      evidence: input.evidence,
      draft: {
        criteria: input.contract.criteria.map((criterion) => ({
          id: criterion.id,
          evidence_requirement: criterion.evidenceRequirement,
        })),
        changes: input.contract.changes.map((change) => ({
          operation: change.operation,
          target: change.target,
          basis_evidence_ids: change.basisEvidenceIds,
        })),
        validations: input.contract.validations.map((validation) => ({
          id: validation.id,
          criterion_ids: validation.criterionIds,
          target_paths: validation.targetPaths,
          kind: validation.kind,
          command: validation.command,
          cwd: validation.cwd,
          actions:
            validation.primitive.kind === "browser_interaction" ||
            validation.primitive.kind === "desktop_interaction"
              ? validation.primitive.actions
              : undefined,
          assertions:
            validation.primitive.kind === "browser_interaction" ||
            validation.primitive.kind === "desktop_interaction"
              ? validation.primitive.assertions
              : undefined,
          require_causal_assertion:
            validation.primitive.kind === "browser_interaction" ||
            validation.primitive.kind === "desktop_interaction"
              ? validation.primitive.requireCausalAssertion
              : undefined,
          expected_outcome: validation.expectedOutcome,
        })),
      },
      previous: input.previous || null,
      committedAt: input.contract.committedAt,
      contractId: input.contract.id,
    });
    return rebuilt.id === input.contract.id &&
      rebuilt.revision === input.contract.revision &&
      rebuilt.digest === input.contract.digest;
  } catch {
    return false;
  }
}

function normalizedCommand(value: unknown): string {
  return text(value, 2_000).replace(/\s+/g, " ");
}

function normalizedCwd(value: unknown): string {
  return safeTarget(value) || ".";
}

export function resolveRuntimeV2ExecutionContractValidation(input: {
  readonly contract: RuntimeV2ExecutionContractV1;
  readonly toolName: string;
  readonly args: Readonly<Record<string, unknown>>;
}): RuntimeV2ExecutionValidation | null {
  return input.contract.validations.find((validation) => {
    if (validation.kind === "finite_command") {
      return input.toolName === "run_command" &&
        normalizedCommand(input.args.command ?? input.args.cmd) ===
          normalizedCommand(validation.command) &&
        normalizedCwd(input.args.cwd ?? input.args.workdir) ===
          normalizedCwd(validation.cwd);
    }
    if (validation.kind === "browser") {
      return input.toolName === "browser_evaluate";
    }
    return input.toolName === "computer_use";
  }) || null;
}

export function runtimeV2ExecutionValidationAuthority(input: {
  readonly contract: RuntimeV2ExecutionContractV1;
  readonly validation: RuntimeV2ExecutionValidation;
}): RuntimeV2ExecutionValidationAuthority {
  return {
    kind: "execution_contract",
    id: input.contract.id,
    revision: input.contract.revision,
    digest: input.contract.digest,
    validationId: input.validation.id,
    criterionIds: input.validation.criterionIds,
    targetPaths: input.validation.targetPaths,
  };
}
