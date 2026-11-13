import { analyzeValidationCommand, finiteValidationRepairHint, normalizeValidationWorkspaceCwd, type ValidationCommandRejectionReason } from "../../lib/validationContract";
import { workspacePathsReferToSameFile } from "../../lib/workspacePaths";
import {
  WORK_PLAN_V1_SCHEMA_VERSION,
  type WorkPlanDraftV1,
  type WorkPlanRuntimeEvidence,
} from "../../lib/runtime-v2";

/** Compiler provenance, separate from the executable validation contract. */
export interface WorkPlanValidationOrigin {
  readonly fieldPath: string;
  readonly rawKind?: string;
  readonly compiledKind: WorkPlanDraftV1["validations"][number]["kind"];
  readonly normalizationReason?: string;
  readonly commandRejectionReason?: ValidationCommandRejectionReason | "service_observation";
  readonly commandSegmentIndex?: number;
  readonly commandRepairHint?: string;
}

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

function normalizeDependsOnList(
  record: unknown,
): number[] {
  if (
    !record ||
    typeof record !== "object" ||
    Array.isArray(record) ||
    !Array.isArray((record as Record<string, unknown>).dependsOn)
  ) {
    return [];
  }
  const raw = (record as Record<string, unknown>).dependsOn as unknown[];
  // Optional edges may be omitted, but authored edges are not suggestions.
  // Keep invalid indexes visible to the typed WorkPlan validator instead of
  // silently changing the model's dependency graph before user review.
  return [...new Set(raw)] as number[];
}

function normalizeStepIndexesList(
  record: unknown,
  defaultStepIndexes: readonly number[],
): number[] {
  if (
    record &&
    typeof record === "object" &&
    !Array.isArray(record) &&
    Array.isArray((record as Record<string, unknown>).stepIndexes)
  ) {
    return [...new Set((record as Record<string, unknown>).stepIndexes as unknown[])] as number[];
  }
  return [...defaultStepIndexes];
}

function resolveCriterionIds(
  record: unknown,
  knownCriterionIds: ReadonlySet<string>,
): string[] {
  const fallback = [...knownCriterionIds];
  if (
    !record ||
    typeof record !== "object" ||
    Array.isArray(record) ||
    !Array.isArray((record as Record<string, unknown>).criterionIds)
  ) {
    return fallback;
  }
  const authored = stringList((record as Record<string, unknown>).criterionIds)
    .filter((id) => knownCriterionIds.size === 0 || knownCriterionIds.has(id));
  return authored.length > 0 ? [...new Set(authored)] : fallback;
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
            : typeof step?.path === "string"
              ? [step.path]
              : [],
    );
    const targetEvidenceIds = input.evidence.filter((entry) =>
      input.autoBasisEvidenceIds.has(entry.id) &&
      entry.version &&
      targets.some((target) =>
        workspacePathsReferToSameFile(entry.target, target)
      )
    ).map((entry) => entry.id);
    const requestedOperation = String(
      step?.operation || step?.action || "modify",
    ).trim().toLowerCase();
    const operation = (
      ["modify", "create", "delete", "preserve"] as const
    ).find((candidate) => candidate === requestedOperation) || "modify";
    const change = String(
      step?.change ||
      step?.approach ||
      step?.description ||
      step?.title ||
      "",
    ).trim();
    const expectedOutcome = String(
      step?.expectedOutcome ||
      step?.outcome ||
      change ||
      `完成对 ${targets.join(", ") || "目标文件"} 的修改`,
    ).trim();
    const dependsOn = normalizeDependsOnList(step);
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
      criterionIds: resolveCriterionIds(step, input.knownCriterionIds),
    };
  }) as WorkPlanDraftV1["steps"];
}

function compileValidations(input: {
  readonly rawValidations: readonly unknown[];
  readonly steps: WorkPlanDraftV1["steps"];
  readonly normalizationReasons: string[];
  readonly knownCriterionIds: ReadonlySet<string>;
  readonly workspace?: string;
}): { validations: WorkPlanDraftV1["validations"]; origins: readonly WorkPlanValidationOrigin[] } {
  const executableStepIndexes = input.steps
    .map((step, index) => (step.operation !== "preserve" ? index : -1))
    .filter((index) => index >= 0);
  const defaultStepIndexes = executableStepIndexes.length > 0
    ? executableStepIndexes
    : input.steps.map((_, index) => index);

  const normalizedRaw = input.rawValidations.map((entry) => {
    if (typeof entry === "string") {
      const trimmed = entry.trim();
      const isFiniteCmd =
        analyzeValidationCommand(trimmed).spec?.kind === "finite_command";
      return isFiniteCmd
        ? {
            kind: "finite_command",
            command: trimmed,
            expectedOutcome: `命令 ${trimmed} 执行成功且退出码为 0。`,
            required: true,
          }
        : {
            kind: "assertion",
            expectedOutcome: trimmed || "验证修改后的行为符合预期。",
            required: false,
          };
    }
    return (entry && typeof entry === "object" ? entry : {}) as Record<string, any>;
  });

  const origins: WorkPlanValidationOrigin[] = [];
  const compiled = normalizedRaw.map((validation, index) => {
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
    const rawCwd = typeof validation?.cwd === "string" ? validation.cwd.trim() : "";
    const cwd = rawCwd ? normalizeValidationWorkspaceCwd(rawCwd, input.workspace) : undefined;
    if (cwd === null) throw new Error(`validations[${index}].cwd: Use a directory inside the workspace (use . for the root).`);
    const stepIndexes = normalizeStepIndexesList(
      validation,
      defaultStepIndexes,
    );
    return {
      stepIndexes,
      kind,
      ...(command ? { command } : {}),
      ...(cwd ? { cwd } : {}),
      ...(validation?.expectedTestCases !== undefined ? { expectedTestCases: validation.expectedTestCases } : {}),
      ...(validation?.useProjectEditor === true ? { useProjectEditor: true as const } : {}),
      expectedOutcome: String(
        validation?.expectedOutcome ||
        validation?.outcome ||
        validation?.description ||
        command ||
        "修改后的行为符合计划中的预期结果。",
      ).trim(),
      required:
        validation?.required !== false &&
        kind !== "assertion" &&
        kind !== "advisory",
      criterionIds: resolveCriterionIds(validation, input.knownCriterionIds),
    };
  }).flatMap((validation, index) => {
    const raw = input.rawValidations[index];
    const rawKind = raw && typeof raw === "object" && "kind" in raw && typeof raw.kind === "string"
      ? raw.kind : undefined;
    const analysis = validation.kind === "finite_command"
      ? analyzeValidationCommand(validation.command || "", { cwd: validation.cwd })
      : undefined;
    if (analysis && analysis.spec?.kind !== "finite_command") {
      const commandRejectionReason = analysis.rejectionReason ??
        (analysis.spec?.kind === "service_observation" ? "service_observation" : undefined);
      const commandSegmentIndex = commandRejectionReason === "unbounded_command_segment"
        ? analysis.segments.findIndex(segment => segment.role === "unknown")
        : commandRejectionReason === "service_observation"
          ? analysis.segments.findIndex(segment => segment.role === "service")
          : -1;
      const commandRepairHint = finiteValidationRepairHint(analysis);
      input.normalizationReasons.push(
        `validations[${index}]:non_finite_command_downgraded_to_advisory`,
      );
      origins.push({ fieldPath: `validations[${index}]`, ...(rawKind !== undefined ? { rawKind } : {}),
        compiledKind: "advisory", normalizationReason: "non_finite_command_downgraded_to_advisory",
        ...(commandRejectionReason ? { commandRejectionReason } : {}),
        ...(commandRepairHint ? { commandRepairHint } : {}),
        ...(commandSegmentIndex >= 0 ? { commandSegmentIndex } : {}) });
      const { command: _nonFiniteCommand, ...advisory } = validation;
      return [{
        ...advisory,
        kind: "advisory" as const,
        required: false,
      }];
    }
    origins.push({ fieldPath: `validations[${index}]`, ...(rawKind !== undefined ? { rawKind } : {}), compiledKind: validation.kind });
    return [validation];
  });

  return { validations: compiled as Array<WorkPlanDraftV1["validations"][number]>, origins };
}

export function workPlanDraftFromSubmission(
  candidate: Record<string, unknown>,
  evidence: readonly WorkPlanRuntimeEvidence[],
  objective: string,
  criterionIds: readonly string[] = [],
  workspace?: string,
): {
  readonly draft: WorkPlanDraftV1;
  readonly normalized: boolean;
  readonly normalizationReasons: readonly string[];
  readonly validationOrigins: readonly WorkPlanValidationOrigin[];
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
      ["changes", "steps"],
      ["changesJson", "stepsJson"],
      true,
      normalizationReasons,
    ) as readonly Record<string, any>[],
    validations: parseArrayFields(
      candidate,
      ["validations"],
      ["validationJson", "validationsJson"],
      false,
      normalizationReasons,
    ) as readonly unknown[],
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
  const { validations, origins: validationOrigins } = compileValidations({
    rawValidations: raw.validations,
    steps,
    normalizationReasons,
    knownCriterionIds,
    workspace,
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
    validationOrigins,
  };
}
