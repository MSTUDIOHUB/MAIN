import { canonicalJson } from "./canonicalJson";
import { normalizePlanDocumentRef, type PlanDocumentRef } from "./planDocuments";
import { sha256Hex } from "./sha256";

/** Runtime assessment data. A saved draft is never execution authority. */
export interface PlanSubmissionDiagnostic {
  readonly code: string;
  readonly fieldPath: string;
  readonly criterionIds: readonly string[];
  readonly message: string;
  readonly rawKind?: string;
  readonly compiledKind?: string;
  readonly normalizationReason?: string;
  readonly commandRejectionReason?: string;
  readonly commandSegmentIndex?: number;
}

export interface PlanDraftRecord {
  readonly schemaVersion: 1;
  readonly documentRef: PlanDocumentRef;
  readonly source: {
    readonly turnId: string;
    readonly runId: string;
    readonly providerSequence: number;
    readonly toolCallId: string;
    readonly candidateHash: string;
  };
  readonly diagnostics: readonly PlanSubmissionDiagnostic[];
  readonly derivedFrom?: PlanDocumentRef;
}

export type PlanDraftSaveMetadata = Omit<PlanDraftRecord, "documentRef">;

/** Bind the exact candidate values independently of native JSON key order. */
export function hashPlanDraftCandidate(candidate: Readonly<Record<string, unknown>>): string {
  return sha256Hex(canonicalJson(candidate));
}

export function normalizePlanDraftRecord(value: unknown): PlanDraftRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as PlanDraftRecord;
  const documentRef = normalizePlanDocumentRef(record.documentRef);
  const source = record.source;
  if (record.schemaVersion !== 1 || !documentRef || !source || source.turnId !== documentRef.owner.turnId ||
    typeof source.runId !== "string" || !source.runId.trim() || typeof source.toolCallId !== "string" || !source.toolCallId.trim() ||
    !Number.isSafeInteger(source.providerSequence) || source.providerSequence < 0 || !/^[a-f0-9]{64}$/.test(source.candidateHash) ||
    !Array.isArray(record.diagnostics) || !record.diagnostics.length) return null;
  const diagnostics: PlanSubmissionDiagnostic[] = [];
  for (const item of record.diagnostics) {
    if (!item || typeof item.code !== "string" || !item.code.trim() || typeof item.fieldPath !== "string" ||
      typeof item.message !== "string" || !item.message.trim() || !Array.isArray(item.criterionIds) ||
      item.criterionIds.some((id: unknown) => typeof id !== "string" || !id.trim()) ||
      [item.rawKind, item.compiledKind, item.normalizationReason, item.commandRejectionReason].some(field => field !== undefined && typeof field !== "string") ||
      (item.commandSegmentIndex !== undefined && (!Number.isSafeInteger(item.commandSegmentIndex) || item.commandSegmentIndex < 0))) return null;
    diagnostics.push({ code: item.code, fieldPath: item.fieldPath, criterionIds: [...item.criterionIds], message: item.message,
      ...(item.rawKind !== undefined ? { rawKind: item.rawKind } : {}), ...(item.compiledKind !== undefined ? { compiledKind: item.compiledKind } : {}),
      ...(item.normalizationReason !== undefined ? { normalizationReason: item.normalizationReason } : {}),
      ...(item.commandRejectionReason !== undefined ? { commandRejectionReason: item.commandRejectionReason } : {}),
      ...(item.commandSegmentIndex !== undefined ? { commandSegmentIndex: item.commandSegmentIndex } : {}) });
  }
  const derivedFrom = record.derivedFrom === undefined ? undefined : normalizePlanDocumentRef(record.derivedFrom);
  if (record.derivedFrom !== undefined && (!derivedFrom || derivedFrom.owner.sessionKey !== documentRef.owner.sessionKey ||
    derivedFrom.owner.sessionEpoch !== documentRef.owner.sessionEpoch || derivedFrom.owner.workspace !== documentRef.owner.workspace ||
    derivedFrom.owner.turnId === documentRef.owner.turnId)) return null;
  return { schemaVersion: 1, documentRef, source: { turnId: source.turnId, runId: source.runId, providerSequence: source.providerSequence,
    toolCallId: source.toolCallId, candidateHash: source.candidateHash }, diagnostics, ...(derivedFrom ? { derivedFrom } : {}) };
}

/** User-facing copy is derived from structured state. Backend messages and
 * criterion IDs remain diagnostics, never document or UI prose. */
export function formatPlanSubmissionDiagnostic(diagnostic: PlanSubmissionDiagnostic, language: "zh" | "en"): string {
  const zh = language === "zh";
  const validationIndex = diagnostic.fieldPath.match(/^validations\[(\d+)\]/)?.[1];
  const prefix = validationIndex === undefined ? "" : zh ? `验证 ${Number(validationIndex) + 1}：` : `Validation ${Number(validationIndex) + 1}: `;
  return prefix + planSubmissionDiagnosticMessage(diagnostic, language);
}

export function formatPlanSubmissionDiagnostics(diagnostics: readonly PlanSubmissionDiagnostic[], language: "zh" | "en"): string[] {
  return [...new Set(diagnostics.map(diagnostic => planSubmissionDiagnosticMessage(diagnostic, language)))];
}

/** Display older saved drafts with one explanation per gap. Match only the
 * generated appendix, keeping the stored revision and authored plan intact. */
export function formatSavedPlanDraftForDisplay(markdown: string, draft: PlanDraftRecord): string {
  for (const language of ["zh", "en"] as const) {
    const prefix = language === "zh"
      ? "\n\n## 待补全的执行验证\n\n此文档为可审核草稿，尚未形成可批准执行的计划。\n\n"
      : "\n\n## Execution validation to complete\n\nThis reviewable draft is not ready for execution approval.\n\n";
    const oldBullets = [...new Set(draft.diagnostics.map(item => formatPlanSubmissionDiagnostic(item, language)))];
    const oldAppendix = `${prefix}${oldBullets.map(item => `- ${item}`).join("\n")}\n`;
    const oldReason = language === "zh" ? "计划草稿已保存，验证待补全；尚未开放批准执行。"
      : "Plan draft saved. Validation needs completion before execution can be approved.";
    const suffix = markdown.endsWith(`${oldAppendix}\n\n${oldReason}`) ? `\n\n${oldReason}` : "";
    if (!markdown.endsWith(oldAppendix + suffix)) continue;
    const bullets = formatPlanSubmissionDiagnostics(draft.diagnostics, language).map(item => `- ${item}`).join("\n");
    return `${markdown.slice(0, -(oldAppendix.length + suffix.length))}${prefix}${bullets}\n${suffix}`;
  }
  return markdown;
}

function planSubmissionDiagnosticMessage(diagnostic: PlanSubmissionDiagnostic, language: "zh" | "en"): string {
  const zh = language === "zh";
  let message: string;
  if (diagnostic.normalizationReason === "non_finite_command_downgraded_to_advisory") {
    message = zh ? "该命令无法作为有限结束的验收命令，需要补充可判定检查。" : "This command is not a finite acceptance check. Provide a check with a decidable result.";
  } else {
    switch (diagnostic.code) {
      case "plan_validation_not_required":
        message = zh ? "需要可执行的验收方式；建议性检查不能替代必要验收。" : "Provide an executable acceptance check; advisory checks cannot supply required acceptance."; break;
      case "plan_validation_missing":
        message = zh ? "部分验收条件仍缺少对应的可执行检查方式。" : "Some acceptance criteria still need corresponding executable checks."; break;
      case "plan_validation_evidence_mismatch":
        message = zh ? "需要能实际验证目标行为的测试或交互检查。编译和静态检查只能作为补充。" : "Add a runnable test or interaction that checks the required behavior. Build and static checks can supplement it."; break;
      case "plan_change_criterion_missing":
        message = zh ? "需要补全满足验收条件的具体改动步骤。" : "Complete the changes that satisfy the acceptance criteria."; break;
      case "plan_collaboration_incomplete":
        message = zh ? "需要完成所要求的协作，并说明如何采用协作结果。" : "Complete the required collaboration and assess how its findings are used."; break;
      default:
        message = zh ? "计划结构仍需补全，完成后才能批准执行。" : "Complete the plan structure before it can be approved for execution.";
    }
  }
  return message;
}
