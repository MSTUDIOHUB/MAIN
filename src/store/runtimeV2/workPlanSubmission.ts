import { analyzeValidationCommand } from "../../lib/validationContract";
import { workspacePathsReferToSameFile } from "../../lib/workspacePaths";
import {
  WORK_PLAN_V1_SCHEMA_VERSION,
  type WorkPlanDraftV1,
  type WorkPlanRuntimeEvidence,
} from "../../lib/runtime-v2";

/**
 * Parse only a complete JSON response (or one complete JSON fence). Unlike
 * safeJsonParse this never searches prose for braces, so commentary cannot be
 * promoted into a lifecycle action.
 */
export function decodeExactStructuredPlanResponse(
  value: unknown,
): Record<string, unknown> | null {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const fenced = raw.match(/^```(?:json)?\s*([\s\S]+?)\s*```$/i);
  const candidate = fenced ? fenced[1]!.trim() : raw;
  try {
    const parsed = JSON.parse(candidate);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

export function safeJsonParse(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    const stripped = trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
    try {
      return JSON.parse(stripped);
    } catch {
      const firstBrace = stripped.indexOf("{");
      const lastBrace = stripped.lastIndexOf("}");
      const firstBracket = stripped.indexOf("[");
      const lastBracket = stripped.lastIndexOf("]");
      const isObject = firstBrace >= 0 &&
        lastBrace > firstBrace &&
        (firstBracket < 0 || firstBrace < firstBracket);
      const isArray = firstBracket >= 0 &&
        lastBracket > firstBracket &&
        (firstBrace < 0 || firstBracket < firstBrace);
      try {
        if (isObject) return JSON.parse(stripped.slice(firstBrace, lastBrace + 1));
        if (isArray) return JSON.parse(stripped.slice(firstBracket, lastBracket + 1));
      } catch {
        return null;
      }
      return null;
    }
  }
}

export function decodeStructuredPlanArguments(
  value: unknown,
): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  const parsed = safeJsonParse(String(value || ""));
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : null;
}

function parseJsonArrayFields(
  record: Record<string, unknown>,
  fields: readonly string[],
  required = false,
  normalizationReasons?: string[],
): readonly unknown[] {
  const field = fields.find((candidate) => record[candidate] !== undefined);
  if (!field) {
    if (required) throw new Error(`${fields[0]} is required.`);
    return [];
  }
  const value = record[field];
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") {
    normalizationReasons?.push(`${field}:singleton_object_to_array`);
    return [value];
  }
  if (typeof value !== "string") {
    throw new Error(`${field} must be a JSON array string.`);
  }
  const parsed = safeJsonParse(value);
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === "object") {
    normalizationReasons?.push(`${field}:singleton_object_json_to_array`);
    return [parsed];
  }
  throw new Error(`${field} must decode to an array.`);
}

function parseArrayFields(
  record: Record<string, unknown>,
  directFields: readonly string[],
  legacyJsonFields: readonly string[],
  required = false,
  normalizationReasons?: string[],
): readonly unknown[] {
  const directField = directFields.find((candidate) => record[candidate] !== undefined);
  if (directField) {
    const value = record[directField];
    if (Array.isArray(value)) return value;
    if (value && typeof value === "object") {
      normalizationReasons?.push(`${directField}:singleton_object_to_array`);
      return [value];
    }
    if (typeof value === "string") {
      const parsed = safeJsonParse(value);
      if (Array.isArray(parsed)) return parsed;
      if (parsed && typeof parsed === "object") {
        normalizationReasons?.push(
          `${directField}:singleton_object_json_to_array`,
        );
        return [parsed];
      }
    }
    throw new Error(`${directField} must be an array or JSON array string.`);
  }
  return parseJsonArrayFields(
    record,
    legacyJsonFields,
    required,
    normalizationReasons,
  );
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((entry) => String(entry || "").trim()).filter(Boolean)
    : [];
}

function requiredIndexList(
  record: unknown,
  field: "dependsOn" | "stepIndexes",
  path: string,
): number[] {
  if (
    !record ||
    typeof record !== "object" ||
    Array.isArray(record) ||
    !Object.prototype.hasOwnProperty.call(record, field)
  ) {
    throw new Error(`${path}.${field} is required.`);
  }
  const value = (record as Record<string, unknown>)[field];
  if (!Array.isArray(value)) {
    throw new Error(`${path}.${field} must be an array.`);
  }
  // Keep authored values intact. The canonical WorkPlan validator owns
  // integer and zero-based range checks, so invalid edges remain visible as
  // rejection feedback instead of being coerced, dropped, or guessed.
  return [...value] as number[];
}

function admittedCriterionIds(
  record: unknown,
  path: string,
  knownCriterionIds: ReadonlySet<string>,
): string[] {
  if (knownCriterionIds.size === 0) {
    return record && typeof record === "object" && !Array.isArray(record)
      ? stringList((record as Record<string, unknown>).criterionIds)
      : [];
  }
  if (
    !record ||
    typeof record !== "object" ||
    Array.isArray(record) ||
    !Object.prototype.hasOwnProperty.call(record, "criterionIds")
  ) {
    throw new Error(`${path}.criterionIds is required.`);
  }
  const value = (record as Record<string, unknown>).criterionIds;
  if (!Array.isArray(value)) {
    throw new Error(`${path}.criterionIds must be an array.`);
  }
  const ids = value.map((entry) => String(entry || "").trim());
  if (ids.length === 0 || ids.some((id) => !id)) {
    throw new Error(`${path}.criterionIds must contain at least one ID.`);
  }
  const unknown = ids.filter((id) => !knownCriterionIds.has(id));
  if (unknown.length > 0) {
    throw new Error(`${path}.criterionIds references unknown IDs: ${unknown.join(", ")}.`);
  }
  return [...new Set(ids)];
}

function compileSteps(input: {
  readonly rawSteps: readonly Record<string, any>[];
  readonly evidence: readonly WorkPlanRuntimeEvidence[];
  readonly knownBasis: (value: unknown) => string[];
  readonly autoBasisEvidenceIds: ReadonlySet<string>;
  readonly knownCriterionIds: ReadonlySet<string>;
}): WorkPlanDraftV1["steps"] {
  return input.rawSteps.map((step, index) => {
    const targets = stringList(
      Array.isArray(step?.targets)
        ? step.targets
        : Array.isArray(step?.files)
          ? step.files
          : typeof step?.target === "string"
            ? [step.target]
            : [],
    );
    const targetEvidenceIds = input.evidence.filter((entry) =>
      input.autoBasisEvidenceIds.has(entry.id) &&
      entry.version &&
      targets.some((target) =>
        workspacePathsReferToSameFile(entry.target, target)
      )
    ).map((entry) => entry.id);
    if (!Object.prototype.hasOwnProperty.call(step, "operation")) {
      throw new Error(`changes[${index}].operation is required.`);
    }
    const requestedOperation = String(step?.operation || "").trim();
    const operation = (
      ["modify", "create", "delete", "preserve"] as const
    ).find((candidate) => candidate === requestedOperation);
    if (!operation) {
      throw new Error(
        `changes[${index}].operation must be modify, create, delete, or preserve.`,
      );
    }
    const change = String(
      step?.change ||
      step?.approach ||
      step?.description ||
      "",
    ).trim();
    const expectedOutcome = String(
      step?.expectedOutcome ||
      step?.outcome ||
      change,
    ).trim();
    const dependsOn = requiredIndexList(
      step,
      "dependsOn",
      `changes[${index}]`,
    );
    return {
      title: String(step?.title || change || targets[0] || `Step ${index + 1}`),
      operation,
      targets,
      basis: [...new Set([
        ...input.knownBasis(step?.basis),
        ...targetEvidenceIds,
      ])],
      change,
      expectedOutcome,
      dependsOn,
      criterionIds: admittedCriterionIds(
        step,
        `changes[${index}]`,
        input.knownCriterionIds,
      ),
    };
  }) as WorkPlanDraftV1["steps"];
}

function compileValidations(input: {
  readonly rawValidations: readonly Record<string, any>[];
  readonly normalizationReasons: string[];
  readonly knownCriterionIds: ReadonlySet<string>;
}): WorkPlanDraftV1["validations"] {
  return input.rawValidations.map((validation, index) => {
    const requestedCommand = typeof validation?.command === "string"
      ? validation.command.trim()
      : "";
    const requestedKind = String(validation?.kind || "").trim();
    const kind = (
      ["finite_command", "browser", "desktop", "assertion", "advisory"] as const
    ).find((candidate) => candidate === requestedKind) || (
      requestedCommand ? "finite_command" : "assertion"
    );
    const command = kind === "finite_command" ? requestedCommand : "";
    const stepIndexes = requiredIndexList(
      validation,
      "stepIndexes",
      `validations[${index}]`,
    );
    return {
      stepIndexes,
      kind,
      ...(command ? { command } : {}),
      ...(typeof validation?.cwd === "string" && validation.cwd.trim()
        ? { cwd: validation.cwd.trim() }
        : {}),
      expectedOutcome: String(
        validation?.expectedOutcome ||
        validation?.outcome ||
        command ||
        "修改后的行为符合计划中的预期结果。",
      ).trim(),
      required:
        validation?.required !== false &&
        kind !== "assertion" &&
        kind !== "advisory",
      criterionIds: admittedCriterionIds(
        validation,
        `validations[${index}]`,
        input.knownCriterionIds,
      ),
    };
  }).flatMap((validation, index) => {
    if (
      validation.kind === "finite_command" &&
      analyzeValidationCommand(validation.command || "", {
        cwd: validation.cwd,
      }).spec?.kind !== "finite_command"
    ) {
      input.normalizationReasons.push(
        `validations[${index}]:unsafe_finite_command_removed`,
      );
      return [];
    }
    return [validation];
  }) as Array<WorkPlanDraftV1["validations"][number]>;
}

export function workPlanDraftFromSubmission(
  candidate: Record<string, unknown>,
  evidence: readonly WorkPlanRuntimeEvidence[],
  objective: string,
  criterionIds: readonly string[] = [],
): {
  readonly draft: WorkPlanDraftV1;
  readonly normalized: boolean;
  readonly normalizationReasons: readonly string[];
} {
  const normalizationReasons: string[] = [];
  const raw = {
    schemaVersion: WORK_PLAN_V1_SCHEMA_VERSION,
    objective: String(objective || candidate.objective || ""),
    summary: String(
      candidate.planMarkdown ||
      candidate.plan ||
      candidate.summary ||
      objective ||
      "",
    ),
    findings: parseJsonArrayFields(
      candidate,
      ["findingsJson"],
      false,
      normalizationReasons,
    ) as WorkPlanDraftV1["findings"],
    steps: parseArrayFields(
      candidate,
      ["changes"],
      ["changesJson", "stepsJson"],
      true,
      normalizationReasons,
    ) as readonly Record<string, any>[],
    validations: parseArrayFields(
      candidate,
      ["validations"],
      ["validationJson", "validationsJson"],
      true,
      normalizationReasons,
    ) as readonly Record<string, any>[],
    risks: parseJsonArrayFields(
      candidate,
      ["risksJson"],
      false,
      normalizationReasons,
    ) as WorkPlanDraftV1["risks"],
    assumptions: parseJsonArrayFields(
      candidate,
      ["assumptionsJson"],
      false,
      normalizationReasons,
    ) as WorkPlanDraftV1["assumptions"],
    blockingQuestions: parseArrayFields(
      candidate,
      ["questions"],
      ["questionsJson", "blockingQuestionsJson"],
      false,
      normalizationReasons,
    ) as WorkPlanDraftV1["blockingQuestions"],
  };
  const knownEvidenceIds = new Set(evidence.map((entry) => entry.id));
  const knownCriterionIds = new Set(
    criterionIds.map((id) => String(id || "").trim()).filter(Boolean),
  );
  const autoBasisEvidenceIds = new Set(
    evidence
      .filter((entry) => !entry.id.startsWith("child:"))
      .map((entry) => entry.id),
  );
  const knownBasis = (value: unknown): string[] =>
    stringList(value).filter((id) => knownEvidenceIds.has(id));
  const steps = compileSteps({
    rawSteps: raw.steps,
    evidence,
    knownBasis,
    autoBasisEvidenceIds,
    knownCriterionIds,
  });
  const validations = compileValidations({
    rawValidations: raw.validations,
    normalizationReasons,
    knownCriterionIds,
  });
  const draft: WorkPlanDraftV1 = {
    schemaVersion: WORK_PLAN_V1_SCHEMA_VERSION,
    objective: raw.objective,
    summary: raw.summary,
    findings: (Array.isArray(raw.findings) ? raw.findings : []).map((finding) => ({
      statement: String(finding?.statement || ""),
      basis: knownBasis(finding?.basis),
    })),
    steps,
    validations,
    risks: stringList(raw.risks),
    assumptions: stringList(raw.assumptions),
    blockingQuestions: stringList(raw.blockingQuestions),
  };
  return {
    draft,
    normalized:
      normalizationReasons.length > 0 ||
      JSON.stringify(draft) !== JSON.stringify(raw),
    normalizationReasons,
  };
}
