import { sha256Hex } from "../sha256";
import type { PlanCandidateV5 } from "../planContract";
import { analyzeValidationCommand } from "../validationContract";
import { workspacePathsReferToSameFile } from "../workspacePaths";

export const WORK_PLAN_V1_SCHEMA_VERSION = "work-plan.v1" as const;

export type WorkPlanOperation = "modify" | "create" | "delete" | "preserve";
export type WorkPlanValidationKind =
  | "finite_command"
  | "browser"
  | "desktop"
  | "assertion"
  | "advisory";

/**
 * The only plan shape a model is allowed to submit in Runtime v2. Evidence
 * IDs are issued by the runtime; the model may reference them but cannot
 * manufacture a source-version claim.
 */
export interface WorkPlanDraftV1 {
  readonly schemaVersion: typeof WORK_PLAN_V1_SCHEMA_VERSION;
  readonly objective: string;
  readonly summary: string;
  readonly findings: readonly {
    readonly statement: string;
    readonly basis: readonly string[];
  }[];
  readonly steps: readonly {
    readonly title: string;
    readonly operation: WorkPlanOperation;
    readonly targets: readonly string[];
    readonly basis: readonly string[];
    readonly change: string;
    readonly expectedOutcome: string;
    readonly dependsOn: readonly number[];
  }[];
  readonly validations: readonly {
    readonly stepIndexes: readonly number[];
    readonly kind: WorkPlanValidationKind;
    readonly command?: string;
    readonly cwd?: string;
    readonly expectedOutcome: string;
    readonly required: boolean;
  }[];
  readonly risks: readonly string[];
  readonly assumptions: readonly string[];
  readonly blockingQuestions: readonly string[];
}

export interface WorkPlanRuntimeEvidence {
  readonly id: string;
  readonly target: string;
  readonly version: string | null;
  readonly statement: string;
}

export interface SealedWorkPlanV1 {
  readonly schemaVersion: typeof WORK_PLAN_V1_SCHEMA_VERSION;
  readonly id: string;
  readonly revision: number;
  readonly status: "sealed" | "pending_review" | "approved" | "invalidated";
  readonly createdAt: number;
  readonly draft: WorkPlanDraftV1;
  readonly evidence: readonly WorkPlanRuntimeEvidence[];
  readonly digest: string;
  readonly projectionHash: string;
  readonly markdown: string;
  readonly legacy?: {
    readonly schemaVersion: number;
    readonly digest: string;
    readonly lossless: boolean;
  };
}

export const RUNTIME_V2_PLAN_ARTIFACT_PATH = ".MAIN/plans/plan.md" as const;
export const RUNTIME_V2_PLAN_REVIEW_COMMIT_SCHEMA_VERSION =
  "runtime-v2-plan-review-commit.v1" as const;

export interface RuntimeV2PlanAuthority {
  readonly id: string;
  readonly revision: number;
  readonly digest: string;
  readonly projectionHash: string;
}

export interface RuntimeV2PlanPanelProjection {
  readonly audience: "plan_panel";
  readonly status: "pending_review";
  readonly authority: RuntimeV2PlanAuthority;
  readonly title: string;
  readonly markdown: string;
  readonly steps: readonly {
    readonly id: string;
    readonly title: string;
    readonly operation: WorkPlanOperation;
    readonly targets: readonly string[];
    readonly expectedOutcome: string;
  }[];
  readonly validationCount: number;
}

export interface RuntimeV2PlanChatProjection {
  readonly audience: "chat_milestone";
  readonly authority: RuntimeV2PlanAuthority;
  readonly markdown: string;
  readonly dedupeKey: string;
}

export interface RuntimeV2PlanArtifactProjection {
  readonly path: typeof RUNTIME_V2_PLAN_ARTIFACT_PATH;
  readonly content: string;
  readonly projectionHash: string;
}

export interface RuntimeV2PlanReviewBinding {
  readonly requestId: string;
  readonly sessionKey: string;
  readonly sessionEpoch: string;
  readonly turnId: string;
  readonly runId: string;
  readonly parentRunId: string | null;
  readonly authority: RuntimeV2PlanAuthority;
  readonly createdAt: number;
}

/**
 * This immutable value is both the durable approval authority and the only
 * source from which the artifact, PlanPanel and Chat projections are
 * published. Markdown is never parsed back into a plan.
 */
export interface RuntimeV2PlanReviewCommit {
  readonly schemaVersion: typeof RUNTIME_V2_PLAN_REVIEW_COMMIT_SCHEMA_VERSION;
  readonly authority: RuntimeV2PlanAuthority;
  readonly artifact: RuntimeV2PlanArtifactProjection;
  readonly panel: RuntimeV2PlanPanelProjection;
  readonly chat: RuntimeV2PlanChatProjection;
  readonly review: RuntimeV2PlanReviewBinding;
}

export interface WorkPlanValidationIssue {
  readonly path: string;
  readonly message: string;
}

export interface WorkPlanMigrationResult {
  readonly disposition: "migrated" | "requires_review";
  readonly draft: WorkPlanDraftV1;
  readonly legacyDigest: string;
  readonly lossless: boolean;
  readonly reasons: readonly string[];
}

function normalizeText(value: unknown, max = 4_000): string {
  return typeof value === "string"
    ? value.replace(/\r\n?/g, "\n").trim().slice(0, max)
    : "";
}

function uniqueStrings(values: readonly unknown[], max = 64, itemMax = 512): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const text = normalizeText(value, itemMax);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    result.push(text);
    if (result.length >= max) break;
  }
  return result;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalize(entry)]),
  );
}

function hash(prefix: string, value: unknown): string {
  return `${prefix}-${sha256Hex(JSON.stringify(canonicalize(value)))}`;
}

function markdownList(values: readonly string[]): string {
  return values.length > 0 ? values.map((value) => `- ${value}`).join("\n") : "- 无";
}

function markdownCodeList(values: readonly string[]): string {
  return values.length > 0
    ? values.map((value) => `- \`${value.replace(/`/g, "")}\``).join("\n")
    : "- 未指定";
}

function stepId(index: number): string {
  return `S${index + 1}`;
}

function validationId(index: number): string {
  return `V${index + 1}`;
}

export function validateWorkPlanDraftV1(
  draft: WorkPlanDraftV1,
  knownEvidenceIds: readonly string[] = [],
  knownEvidence: readonly WorkPlanRuntimeEvidence[] = [],
): WorkPlanValidationIssue[] {
  const issues: WorkPlanValidationIssue[] = [];
  const evidenceIds = new Set(uniqueStrings(knownEvidenceIds));
  if (draft?.schemaVersion !== WORK_PLAN_V1_SCHEMA_VERSION) {
    issues.push({ path: "schemaVersion", message: "Expected work-plan.v1." });
    return issues;
  }
  if (JSON.stringify(draft).length > 14_000) {
    issues.push({
      path: "$",
      message: "A WorkPlan must fit the bounded 14,000-character execution contract.",
    });
  }
  if (!normalizeText(draft.objective, 1_024)) {
    issues.push({ path: "objective", message: "Objective is required." });
  }
  if (!normalizeText(draft.summary, 2_000)) {
    issues.push({ path: "summary", message: "Summary is required." });
  }
  if (/<\/?tool_call\b|<function=|<parameter=/i.test(String(draft.summary || ""))) {
    issues.push({
      path: "summary",
      message: "Plan Markdown contains provider tool-protocol markup.",
    });
  }
  if (!Array.isArray(draft.steps) || draft.steps.length === 0) {
    issues.push({ path: "steps", message: "At least one executable or preserve step is required." });
  }
  if ((draft.steps || []).length > 32) {
    issues.push({ path: "steps", message: "A WorkPlan may contain at most 32 steps." });
  }
  for (const [index, finding] of (draft.findings || []).entries()) {
    if (!normalizeText(finding?.statement, 2_000)) {
      issues.push({ path: `findings[${index}].statement`, message: "Finding statement is required." });
    }
    for (const basisId of finding?.basis || []) {
      if (!evidenceIds.has(basisId)) {
        issues.push({ path: `findings[${index}].basis`, message: `Unknown evidence id: ${basisId}.` });
      }
    }
  }
  for (const [index, step] of (draft.steps || []).entries()) {
    if (!normalizeText(step?.title, 512)) {
      issues.push({ path: `steps[${index}].title`, message: "Step title is required." });
    }
    if (!(["modify", "create", "delete", "preserve"] as string[]).includes(step?.operation)) {
      issues.push({ path: `steps[${index}].operation`, message: "Invalid step operation." });
    }
    const targets = uniqueStrings(step?.targets || [], 16, 1_024);
    if (targets.length === 0) {
      issues.push({ path: `steps[${index}].targets`, message: "A step needs at least one target." });
    }
    if (!normalizeText(step?.change, 4_000)) {
      issues.push({ path: `steps[${index}].change`, message: "Step change is required." });
    }
    if (!normalizeText(step?.expectedOutcome, 2_000)) {
      issues.push({ path: `steps[${index}].expectedOutcome`, message: "Expected outcome is required." });
    }
    for (const basisId of step?.basis || []) {
      if (!evidenceIds.has(basisId)) {
        issues.push({ path: `steps[${index}].basis`, message: `Unknown evidence id: ${basisId}.` });
      }
    }
    if (step?.operation === "modify" || step?.operation === "delete") {
      for (const target of targets) {
        const hasVersionedTargetBasis = (step.basis || []).some((basisId) =>
          knownEvidence.some((evidence) =>
            evidence.id === basisId &&
            !!evidence.version &&
            workspacePathsReferToSameFile(evidence.target, target)
          )
        );
        if (!hasVersionedTargetBasis) {
          issues.push({
            path: `steps[${index}].basis`,
            message: `Target ${target} needs a versioned source evidence basis before approval.`,
          });
        }
      }
    }
    for (const dependency of step?.dependsOn || []) {
      if (!Number.isInteger(dependency) || dependency < 0 || dependency >= index) {
        issues.push({ path: `steps[${index}].dependsOn`, message: "Dependencies must refer to earlier steps." });
      }
    }
  }
  for (const [index, validation] of (draft.validations || []).entries()) {
    if (!(["finite_command", "browser", "desktop", "assertion", "advisory"] as string[]).includes(validation?.kind)) {
      issues.push({ path: `validations[${index}].kind`, message: "Invalid validation kind." });
    }
    if (!normalizeText(validation?.expectedOutcome, 2_000)) {
      issues.push({ path: `validations[${index}].expectedOutcome`, message: "Expected outcome is required." });
    }
    if (validation?.kind === "finite_command" && !normalizeText(validation.command, 2_000)) {
      issues.push({ path: `validations[${index}].command`, message: "Finite command validation needs a command." });
    } else if (
      validation?.kind === "finite_command" &&
      analyzeValidationCommand(String(validation.command || ""), {
        cwd: validation.cwd,
      }).spec?.kind !== "finite_command"
    ) {
      issues.push({
        path: `validations[${index}].command`,
        message: "Finite command validation must be a bounded fail-fast build, test, lint, typecheck, check, or inline assertion.",
      });
    }
    if (
      validation?.required === true &&
      (validation?.kind === "assertion" || validation?.kind === "advisory")
    ) {
      issues.push({
        path: `validations[${index}].required`,
        message: "Standalone assertions and advisory notes cannot own required acceptance.",
      });
    }
    for (const stepIndex of validation?.stepIndexes || []) {
      if (!Number.isInteger(stepIndex) || stepIndex < 0 || stepIndex >= (draft.steps || []).length) {
        issues.push({ path: `validations[${index}].stepIndexes`, message: "Validation references an unknown step." });
      }
    }
  }
  const executableStepIndexes = (draft.steps || [])
    .map((step, index) => step?.operation !== "preserve" ? index : -1)
    .filter((index) => index >= 0);
  if (executableStepIndexes.length > 0) {
    const requiredValidations = (draft.validations || []).filter(
      (validation) => validation?.required === true,
    );
    if (requiredValidations.length === 0) {
      issues.push({
        path: "validations",
        message: "An executable WorkPlan needs at least one required validation.",
      });
    }
    for (const stepIndex of executableStepIndexes) {
      if (!requiredValidations.some((validation) =>
        (validation.stepIndexes || []).includes(stepIndex)
      )) {
        issues.push({
          path: `steps[${stepIndex}]`,
          message: "Every executable step must be covered by a required validation.",
        });
      }
    }
  }
  if ((draft.blockingQuestions || []).length > 0) {
    issues.push({
      path: "blockingQuestions",
      message: "An executable WorkPlan cannot be approved while user decisions remain unresolved.",
    });
  }
  return issues;
}

export function projectWorkPlanMarkdown(plan: Pick<SealedWorkPlanV1, "draft" | "id" | "revision" | "digest">): string {
  const draft = plan.draft;
  const narrative = normalizeText(draft.summary, 8_000);
  const lines: string[] = /^\s*#\s+\S/.test(narrative)
    ? [narrative, ""]
    : ["# 计划", "", narrative, ""];
  if (draft.findings.length > 0) {
    lines.push("## 已确认事实", "");
    for (const finding of draft.findings) {
      const basis = finding.basis.length > 0 ? `（依据：${finding.basis.join("、")}）` : "";
      lines.push(`- ${finding.statement}${basis}`);
    }
    lines.push("");
  }
  lines.push("## 修改", "");
  for (const [index, step] of draft.steps.entries()) {
    lines.push(`### ${stepId(index)} · ${step.title}`, "");
    lines.push(`- 操作：${step.operation}`);
    lines.push("- 目标：", markdownCodeList(step.targets));
    if (step.basis.length > 0) lines.push(`- 依据：${step.basis.join("、")}`);
    if (step.dependsOn.length > 0) lines.push(`- 依赖：${step.dependsOn.map(stepId).join("、")}`);
    lines.push(`- 改动：${step.change}`);
    lines.push(`- 预期结果：${step.expectedOutcome}`, "");
  }
  lines.push("## 验证", "");
  if (draft.validations.length === 0) {
    lines.push("- 未定义自动验证。", "");
  } else {
    for (const [index, validation] of draft.validations.entries()) {
      lines.push(`### ${validationId(index)} · ${validation.kind}`, "");
      lines.push(`- 覆盖步骤：${validation.stepIndexes.map(stepId).join("、") || "未指定"}`);
      if (validation.command) lines.push(`- 命令：\`${validation.command.replace(/`/g, "")}\``);
      if (validation.cwd) lines.push(`- 工作目录：\`${validation.cwd.replace(/`/g, "")}\``);
      lines.push(`- 要求：${validation.required ? "必须通过" : "建议执行"}`);
      lines.push(`- 预期结果：${validation.expectedOutcome}`, "");
    }
  }
  if (draft.risks.length > 0) lines.push("## 风险", "", markdownList(draft.risks), "");
  if (draft.assumptions.length > 0) lines.push("## 假设", "", markdownList(draft.assumptions), "");
  if (draft.blockingQuestions.length > 0) lines.push("## 需要用户决定", "", markdownList(draft.blockingQuestions), "");
  lines.push("---", `计划 ID：${plan.id} · 修订：${plan.revision} · 摘要：${plan.digest}`);
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function sealWorkPlanV1(input: {
  readonly draft: WorkPlanDraftV1;
  readonly evidence: readonly WorkPlanRuntimeEvidence[];
  readonly revision?: number;
  readonly id?: string;
  readonly createdAt: number;
  readonly legacy?: SealedWorkPlanV1["legacy"];
}): SealedWorkPlanV1 {
  const evidence = input.evidence.map((item) => ({
    id: normalizeText(item.id, 128),
    target: normalizeText(item.target, 1_024),
    version: item.version === null ? null : normalizeText(item.version, 512) || null,
    statement: normalizeText(item.statement, 4_000),
  })).filter((item) => item.id && item.target && item.statement);
  const issues = validateWorkPlanDraftV1(
    input.draft,
    evidence.map((item) => item.id),
    evidence,
  );
  if (issues.length > 0) {
    throw new Error(`WorkPlanDraftV1 rejected: ${issues.map((issue) => `${issue.path}: ${issue.message}`).join(" ")}`);
  }
  const revision = Math.max(1, Math.floor(Number(input.revision) || 1));
  const digest = hash("work-plan-sha256", { draft: input.draft, evidence });
  const id = normalizeText(input.id, 128) || `WP-${digest.slice(-12)}`;
  const provisional = {
    schemaVersion: WORK_PLAN_V1_SCHEMA_VERSION,
    id,
    revision,
    status: "pending_review" as const,
    createdAt: Math.max(0, Math.floor(input.createdAt)),
    draft: input.draft,
    evidence,
    digest,
  };
  const markdown = projectWorkPlanMarkdown(provisional);
  return {
    ...provisional,
    projectionHash: hash("work-plan-projection-sha256", markdown),
    markdown,
    ...(input.legacy ? { legacy: input.legacy } : {}),
  };
}

function validationFromLegacy(candidate: PlanCandidateV5["validations"][number]): WorkPlanDraftV1["validations"][number] {
  const primitive = candidate.primitive as unknown as Record<string, unknown>;
  const kind = primitive?.kind === "finite_command"
    ? "finite_command"
    : primitive?.kind === "browser_dom" || primitive?.kind === "browser_interaction"
      ? "browser"
      : primitive?.kind === "desktop"
        ? "desktop"
        : primitive?.kind === "assertion"
          ? "assertion"
          : "advisory";
  return {
    stepIndexes: [],
    kind,
    ...(typeof primitive?.command === "string" ? { command: primitive.command } : {}),
    ...(typeof primitive?.cwd === "string" ? { cwd: primitive.cwd } : {}),
    expectedOutcome: normalizeText(candidate.expectedOutcome, 2_000) || "验证计划中的预期行为。",
    required: candidate.blocking === true,
  };
}

/**
 * Read-only bridge for persisted V5 plans. It deliberately refuses to call a
 * lossy mapping ready for approval: those plans remain visible, but require a
 * fresh review before a v2 execution Run can use them.
 */
export function migratePlanCandidateV5ToWorkPlanV1(candidate: PlanCandidateV5): WorkPlanMigrationResult {
  const reasons: string[] = [];
  const knownEvidence = new Set((candidate.evidence || []).map((entry) => entry.id));
  const changes = candidate.changes || [];
  const changeIndexById = new Map(changes.map((change, index) => [change.id, index]));
  const steps = changes.map((change) => {
    const target = normalizeText(change.targetRef, 1_024);
    if (!target) reasons.push(`change ${change.id || "unknown"} has no target`);
    const basis = uniqueStrings(change.evidenceRefs || []);
    if (basis.some((id) => !knownEvidence.has(id))) reasons.push(`change ${change.id || "unknown"} references unknown evidence`);
    const dependsOn = uniqueStrings(change.relationships || [])
      .map((relationship) => changeIndexById.get(relationship))
      .filter((index): index is number => typeof index === "number");
    return {
      title: normalizeText(change.text, 512) || `修改 ${target || "目标"}`,
      operation: change.operation,
      targets: target ? [target] : ["<未映射目标>"],
      basis,
      change: normalizeText(change.text, 4_000) || "需要重新确认具体修改。",
      expectedOutcome: normalizeText(change.expectedOutcome, 2_000) || "需要重新确认预期结果。",
      dependsOn,
    };
  });
  const draft: WorkPlanDraftV1 = {
    schemaVersion: WORK_PLAN_V1_SCHEMA_VERSION,
    objective: normalizeText(candidate.objective, 1_024) || "迁移的历史计划",
    summary: uniqueStrings(candidate.summary || [], 16, 1_000).join("\n") || "从历史 PlanCandidateV5 迁移。",
    findings: [
      ...(candidate.findings || []).map((statement) => ({ statement: normalizeText(statement, 2_000), basis: [] })),
      ...(candidate.diagnoses || []).map((diagnosis) => ({
        statement: normalizeText(diagnosis.text, 2_000),
        basis: uniqueStrings(diagnosis.evidenceRefs || []),
      })),
    ].filter((finding) => finding.statement),
    steps,
    validations: (candidate.validations || []).map(validationFromLegacy).map((validation, index) => ({
      ...validation,
      stepIndexes: (candidate.validations[index]?.changeRefs || [])
        .map((id) => changeIndexById.get(id))
        .filter((value): value is number => typeof value === "number"),
    })),
    risks: [],
    assumptions: uniqueStrings(candidate.assumptions || []),
    blockingQuestions: uniqueStrings(candidate.blockingChoices || []),
  };
  if (steps.length === 0) reasons.push("legacy plan has no executable changes");
  if ((candidate.validations || []).some((validation) =>
    validation.changeRefs.some((id) => !changeIndexById.has(id))
  )) reasons.push("legacy validation references an unmapped change");
  const legacyDigest = hash("legacy-plan-v5-sha256", candidate);
  const lossless = reasons.length === 0;
  return {
    disposition: lossless ? "migrated" : "requires_review",
    draft,
    legacyDigest,
    lossless,
    reasons,
  };
}
