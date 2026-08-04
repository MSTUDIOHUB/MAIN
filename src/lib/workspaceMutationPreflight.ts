import {
  parseApplyPatch,
  previewApplyPatch,
  summarizeApplyPatchTarget,
  type ApplyPatchPathAvailability,
} from "./applyPatchTool";
import {
  buildExecutePatchMismatchFingerprint,
  normalizeRecoveryReadRange,
  type PatchRecoveryMismatchEvidence,
  type RecoveryReadLease,
} from "./executeRecoveryTools";
import { workspacePathsReferToSameFile } from "./workspacePaths";

export type WorkspaceMutationPreflightReason =
  | "not_applicable"
  | "missing_content"
  | "read_failed"
  | "search_text_mismatch"
  | "search_text_ambiguous"
  | "empty_change"
  | "identical_content"
  | "existing_file_requires_patch"
  | "oversized_change"
  | "outside_workspace"
  | "invalid_patch"
  | "public_contract_break"
  | "syntax_error";

export interface WorkspaceMutationPreflightResult {
  ok: boolean;
  reason?: WorkspaceMutationPreflightReason;
  message?: string;
  /** Best available workspace target for recovery and progress correlation. */
  path?: string;
  /** Machine-readable recovery route. This prevents the Runtime from parsing
   * localized diagnostics to decide whether to reread one versioned window or
   * reopen bounded workspace orientation. */
  recoveryKind?: "source_mismatch" | "target_invalid" | "mutation_rejected";
  patchRecoveryMismatch?: PatchRecoveryMismatchEvidence;
}

export interface WorkspaceMutationPreflightInput {
  toolName: string;
  args: Record<string, unknown>;
  language?: "zh" | "en";
  /** Lexical authority boundary used to reject external targets before any
   * preview read or write is attempted. The executor still performs its
   * canonical filesystem authorization afterward. */
  workspaceRoot?: string;
  readFile: (path: string) => Promise<string>;
  readFileMetadata?: (
    path: string,
  ) => Promise<{ sizeBytes: number; modifiedMs: number } | null>;
  probeFileAvailability?: (path: string) => Promise<ApplyPatchPathAvailability>;
  checkSyntax?: (
    path: string,
    content: string,
  ) => Promise<{
    applicable: boolean;
    hasErrors: boolean;
    errorCount: number;
    firstErrorLine?: number | null;
    firstErrorColumn?: number | null;
    errors?: Array<{
      line: number;
      column: number;
      kind: string;
      symbol?: string;
    }>;
    errorsTruncated?: boolean;
    moduleExports?: string[];
  }>;
  findReferences?: (
    symbol: string,
  ) => Promise<{
    occurrences: Array<{
      path: string;
      role: string;
      line: number;
    }>;
  }>;
  /** Optional stage-owned safety ceiling. Corrective loops can require a
   * smaller diff than an initial implementation without changing tool
   * semantics or branching on model/provider identity. */
  maxTouchedLines?: number;
}

type WorkspaceSyntaxCheck = Awaited<ReturnType<
  NonNullable<WorkspaceMutationPreflightInput["checkSyntax"]>
>>;

function syntaxErrorSignature(error: {
  kind: string;
  symbol?: string;
}): string {
  return [
    String(error.kind || "").trim(),
    String(error.symbol || "").trim(),
  ].join("\u0000");
}

function completeSyntaxErrorSignatures(
  result: WorkspaceSyntaxCheck,
): string[] | null {
  if (
    result.errorsTruncated ||
    !Array.isArray(result.errors) ||
    result.errors.length !== result.errorCount
  ) {
    return null;
  }
  return result.errors.map(syntaxErrorSignature);
}

/**
 * A file that is already parser-broken must remain repairable in focused
 * steps. Admit only a strict diagnostic subset: the total count decreases,
 * both reports are complete, and no new kind/symbol multiplicity appears.
 * Locations are deliberately excluded because deleting an earlier broken
 * fragment can shift every remaining line without changing the error.
 */
function isStrictlyMonotonicSyntaxRepair(
  previous: WorkspaceSyntaxCheck | null,
  proposed: WorkspaceSyntaxCheck,
): boolean {
  if (
    !previous?.applicable ||
    !previous.hasErrors ||
    proposed.errorCount >= previous.errorCount
  ) {
    return false;
  }
  const previousSignatures = completeSyntaxErrorSignatures(previous);
  const proposedSignatures = completeSyntaxErrorSignatures(proposed);
  if (!previousSignatures || !proposedSignatures) return false;
  const remaining = new Map<string, number>();
  for (const signature of previousSignatures) {
    remaining.set(signature, (remaining.get(signature) || 0) + 1);
  }
  for (const signature of proposedSignatures) {
    const available = remaining.get(signature) || 0;
    if (available <= 0) return false;
    remaining.set(signature, available - 1);
  }
  return true;
}

function asText(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "");
}

function extractApplyPatchRequestedRange(
  patch: string,
  target: string,
): RecoveryReadLease["requestedRange"] {
  const normalizedTarget = String(target || "").trim().replace(/\\/g, "/").replace(/^\.\//, "");
  const lines = String(patch || "").replace(/\r\n/g, "\n").split("\n");
  let inTargetSection = !normalizedTarget;
  for (const line of lines) {
    const fileHeader = line.match(/^\*\*\*\s+(?:Update|Delete)\s+File:\s*(.+)$/);
    if (fileHeader) {
      const headerTarget = fileHeader[1].trim().replace(/\\/g, "/").replace(/^\.\//, "");
      inTargetSection = !normalizedTarget || headerTarget === normalizedTarget;
      continue;
    }
    if (!inTargetSection) continue;
    const hunk = line.match(/^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/);
    if (!hunk) continue;
    const startLine = Math.max(1, Number(hunk[1]) || 1);
    const maxLines = Math.max(1, Number(hunk[2]) || 1);
    return {
      startLine,
      endLine: startLine + maxLines - 1,
      maxLines,
    };
  }
  return null;
}

async function buildPatchRecoveryMismatchEvidence(input: {
  reason: "invalid_patch" | "search_text_mismatch";
  target: string;
  requestedRange?: RecoveryReadLease["requestedRange"];
  failureIdentity?: string | null;
  readFileMetadata?: WorkspaceMutationPreflightInput["readFileMetadata"];
}): Promise<PatchRecoveryMismatchEvidence> {
  const metadata = input.readFileMetadata
    ? await input.readFileMetadata(input.target).catch(() => null)
    : null;
  return {
    mismatchFingerprint: buildExecutePatchMismatchFingerprint({
      reason: input.reason,
      target: input.target,
      failureIdentity: input.failureIdentity,
    }),
    target: input.target,
    ...(input.requestedRange ? { requestedRange: input.requestedRange } : {}),
    observedVersion: metadata
      ? `${Number(metadata.sizeBytes) || 0}:${Number(metadata.modifiedMs) || 0}`
      : null,
  };
}

function inferReplaceMismatchRecoveryRange(
  current: string,
  searchText: string,
): RecoveryReadLease["requestedRange"] {
  const lines = String(current || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const searchLines = String(searchText || "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length >= 4);
  const identifiers = [...new Set(
    String(searchText || "").match(/[A-Za-z_$][\w$-]{3,}/g) || [],
  )]
    .filter((identifier) =>
      !/^(?:function|return|const|class|import|export|async|await|content|value|path|file|true|false|null|undefined|error|string|object|array|event)$/i.test(
        identifier,
      )
    )
    .slice(0, 32);
  const identifierLineCounts = new Map(identifiers.map((identifier) => [
    identifier,
    lines.reduce((count, line) => count + (line.includes(identifier) ? 1 : 0), 0),
  ]));
  let anchorIndex = -1;
  let anchorScore = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    let score = 0;
    for (const identifier of identifiers) {
      const lineCount = identifierLineCounts.get(identifier) || 0;
      if (line.includes(identifier)) {
        score += 18 / Math.max(1, lineCount) + Math.min(8, identifier.length / 3);
      }
      const nearbyStart = Math.max(0, index - 10);
      const nearbyEnd = Math.min(lines.length, index + 11);
      if (
        lineCount > 0 &&
        lines.slice(nearbyStart, nearbyEnd).some((candidate) =>
          candidate.includes(identifier)
        )
      ) {
        score += 4 / Math.max(1, lineCount);
      }
    }
    for (const candidate of searchLines) {
      if (candidate.length >= 12 && line.includes(candidate)) {
        score += 30 + Math.min(30, candidate.length / 4);
      }
    }
    if (score > anchorScore) {
      anchorScore = score;
      anchorIndex = index;
    }
  }
  if (anchorIndex < 0) return null;
  const startLine = Math.max(1, anchorIndex + 1 - 30);
  const endLine = Math.min(Math.max(lines.length, 1), anchorIndex + 1 + 49);
  return {
    startLine,
    endLine,
    maxLines: Math.max(1, endLine - startLine + 1),
  };
}

function buildReplaceMismatchFailureIdentity(searchText: string): string {
  const identifiers = [...new Set(String(searchText || "").match(/[A-Za-z_$][\w$]{2,}/g) || [])]
    .slice(0, 4)
    .join("-");
  return `search-${identifiers || "text"}-${String(searchText || "").length}`;
}

function buildMessage(input: {
  reason: Exclude<WorkspaceMutationPreflightReason, "not_applicable">;
  toolName: string;
  path: string;
  language: "zh" | "en";
  detail?: string;
}): string {
  if (input.language === "en") {
    switch (input.reason) {
      case "missing_content":
        return `MUTATION_PREFLIGHT_BLOCKED: ${input.toolName} for ${input.path} is missing content. Do not ask for approval; retry with complete arguments after reading the target when needed.`;
      case "read_failed":
        return `MUTATION_PREFLIGHT_BLOCKED: Could not read ${input.path} before patching (${input.detail || "read failed"}). Do not ask for approval; read the correct target or report the blocker.`;
      case "search_text_mismatch":
        return `MUTATION_PREFLIGHT_BLOCKED: search_text was not found in ${input.path}. Reuse the active versioned source observation and correct the edit; reread only when the file version changed or the exact required range is missing.`;
      case "search_text_ambiguous":
        return `MUTATION_PREFLIGHT_BLOCKED: search_text occurs more than once in ${input.path}. Expand it to one unique exact block from the visible source before retrying.`;
      case "empty_change":
        return `MUTATION_PREFLIGHT_BLOCKED: ${input.toolName} would not change ${input.path}. Do not ask for approval; provide a real edit, run validation, or explain the blocker.`;
      case "identical_content":
        return `MUTATION_PREFLIGHT_BLOCKED: write_file content is identical to ${input.path}. Do not ask for approval; choose a real edit, validation, or a blocker report.`;
      case "existing_file_requires_patch":
        return `MUTATION_PREFLIGHT_BLOCKED: write_file cannot overwrite the existing file ${input.path}. Use replace_in_file or apply_patch so the existing implementation and a bounded diff remain authoritative.`;
      case "oversized_change":
        return `MUTATION_PREFLIGHT_BLOCKED: The proposed edit to ${input.path} is too large for one mutation (${input.detail || "oversized change"}). Preserve the existing architecture and split the repair into focused, evidence-backed edits.`;
      case "outside_workspace":
        return `MUTATION_PREFLIGHT_BLOCKED: ${input.path} is outside the active workspace. Choose a workspace-relative target; external temporary files are not mutation authority for this task.`;
      case "invalid_patch":
        return `MUTATION_PREFLIGHT_BLOCKED: apply_patch is invalid or would not apply (${input.detail || "invalid patch"}). Correct the patch from the active source observation; reread only for a changed version or a genuinely missing range.`;
      case "public_contract_break":
        return `MUTATION_PREFLIGHT_BLOCKED: The proposed change removes a module export that still has a workspace import (${input.detail || "public contract would be broken"}). No file was changed; preserve the export or update its callers in the same coherent repair.`;
      case "syntax_error":
        return `MUTATION_PREFLIGHT_BLOCKED: The proposed content for ${input.path} has a parser-confirmed syntax error (${input.detail || "invalid syntax"}). No file was changed; correct the edit from the active source observation.`;
    }
  }

  switch (input.reason) {
    case "missing_content":
      return `MUTATION_PREFLIGHT_BLOCKED: ${input.toolName} 写入 ${input.path} 缺少 content。不要请求用户审批；请在必要时先读取目标，再用完整参数重试。`;
    case "read_failed":
      return `MUTATION_PREFLIGHT_BLOCKED: patch 前无法读取 ${input.path}（${input.detail || "读取失败"}）。不要请求用户审批；请读取正确目标或明确阻塞。`;
    case "search_text_mismatch":
      return `MUTATION_PREFLIGHT_BLOCKED: search_text 在 ${input.path} 中不存在。请复用当前版本化源码观察并修正编辑；只有文件版本变化或确实缺少精确范围时才重新读取。`;
    case "search_text_ambiguous":
      return `MUTATION_PREFLIGHT_BLOCKED: search_text 在 ${input.path} 中出现多次。请依据已显示源码将其扩展为唯一的精确文本块后重试。`;
    case "empty_change":
      return `MUTATION_PREFLIGHT_BLOCKED: ${input.toolName} 不会改变 ${input.path}。不要请求用户审批；请给出真实改动、执行验证或说明阻塞。`;
    case "identical_content":
      return `MUTATION_PREFLIGHT_BLOCKED: write_file 内容与 ${input.path} 完全相同。不要请求用户审批；请改为真实改动、验证或阻塞说明。`;
    case "existing_file_requires_patch":
      return `MUTATION_PREFLIGHT_BLOCKED: write_file 不能覆盖已有文件 ${input.path}。请使用 replace_in_file 或 apply_patch，让现有实现保持权威并保留有限 diff。`;
    case "oversized_change":
      return `MUTATION_PREFLIGHT_BLOCKED: 对 ${input.path} 的单次修改过大（${input.detail || "改动范围过大"}）。请保留现有架构，并把修复拆成基于证据的精确修改。`;
    case "outside_workspace":
      return `MUTATION_PREFLIGHT_BLOCKED: ${input.path} 位于当前工作区之外。请选择工作区内的相对目标；外部临时文件不是本任务的修改权威。`;
    case "invalid_patch":
      return `MUTATION_PREFLIGHT_BLOCKED: apply_patch 无效或无法应用（${input.detail || "无效 patch"}）。请依据当前源码观察修正 patch；只有版本变化或确实缺少范围时才重新读取。`;
    case "public_contract_break":
      return `MUTATION_PREFLIGHT_BLOCKED: 拟议修改删除了仍被工作区导入的模块导出（${input.detail || "会破坏公共契约"}）。文件尚未修改；请保留该导出，或在同一完整修复中同步更新调用方。`;
    case "syntax_error":
      return `MUTATION_PREFLIGHT_BLOCKED: ${input.path} 的拟写入内容存在解析器确认的语法错误（${input.detail || "语法无效"}）。文件尚未修改；请依据当前源码观察修正编辑。`;
  }
}

const MAX_SINGLE_MUTATION_LINES = 400;
const LARGE_FILE_LINES = 200;
const MAX_EXISTING_FILE_REPLACEMENT_RATIO = 0.5;

function isLexicallyInsideWorkspace(
  requestedPath: string,
  workspaceRoot?: string,
): boolean {
  const requested = requestedPath.trim().replace(/\\/g, "/");
  const root = String(workspaceRoot || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/\/+$/, "");
  if (!requested || !root) return true;
  if (requested.split("/").includes("..")) return false;
  const absolute = requested.startsWith("/") ||
    /^[A-Za-z]:\//.test(requested);
  if (!absolute) return true;
  const normalized = requested.replace(/\/+/g, "/").replace(/\/+$/, "");
  return normalized === root || normalized.startsWith(`${root}/`);
}

function applyPatchTargets(patch: string): string[] {
  return [...patch.matchAll(
    /^\*\*\*\s+(?:(?:Update|Add|Delete)\s+File:|Move to:)\s*(.+)$/gm,
  )]
    .map((match) => String(match[1] || "").trim())
    .filter(Boolean);
}

function lineCount(value: string): number {
  if (!value) return 0;
  return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n").length;
}

function oversizedChangeCountsDetail(input: {
  current: string;
  removedLines: number;
  addedLines: number;
  maxTouchedLines?: number;
}): string | null {
  const currentLines = Math.max(1, lineCount(input.current));
  const touchedLines = Math.max(input.removedLines, input.addedLines);
  const maxTouchedLines = Math.max(
    1,
    Math.min(
      MAX_SINGLE_MUTATION_LINES,
      Math.floor(Number(input.maxTouchedLines) || MAX_SINGLE_MUTATION_LINES),
    ),
  );
  if (
    touchedLines <= maxTouchedLines &&
    (
      currentLines < LARGE_FILE_LINES ||
      Math.max(input.removedLines, input.addedLines) / currentLines <
        MAX_EXISTING_FILE_REPLACEMENT_RATIO
    )
  ) {
    return null;
  }
  return `${touchedLines} touched lines across a ${currentLines}-line existing file (limit ${maxTouchedLines})`;
}

function oversizedChangeDetail(input: {
  current: string;
  removed: string;
  added: string;
  maxTouchedLines?: number;
}): string | null {
  return oversizedChangeCountsDetail({
    current: input.current,
    removedLines: lineCount(input.removed),
    addedLines: lineCount(input.added),
    maxTouchedLines: input.maxTouchedLines,
  });
}

function blocked(input: {
  reason: Exclude<WorkspaceMutationPreflightReason, "not_applicable">;
  toolName: string;
  path: string;
  language: "zh" | "en";
  detail?: string;
  recoveryKind?: WorkspaceMutationPreflightResult["recoveryKind"];
  patchRecoveryMismatch?: PatchRecoveryMismatchEvidence;
}): WorkspaceMutationPreflightResult {
  return {
    ok: false,
    reason: input.reason,
    message: buildMessage(input),
    path: input.path,
    ...(input.recoveryKind ? { recoveryKind: input.recoveryKind } : {}),
    ...(input.patchRecoveryMismatch
      ? { patchRecoveryMismatch: input.patchRecoveryMismatch }
      : {}),
  };
}

async function blockedSyntaxResult(
  input: WorkspaceMutationPreflightInput,
  path: string,
  content: string,
  language: "zh" | "en",
  previousContent?: string,
): Promise<WorkspaceMutationPreflightResult | null> {
  if (!input.checkSyntax) return null;
  const checked = await input.checkSyntax(path, content);
  if (!checked.applicable || !checked.hasErrors) return null;
  const previous = previousContent === undefined
    ? null
    : await input.checkSyntax(path, previousContent);
  if (isStrictlyMonotonicSyntaxRepair(previous, checked)) return null;
  const reportedErrors = (checked.errors || [])
    .filter((error) =>
      Number(error?.line) > 0 && Number(error?.column) > 0
    )
    .slice(0, 8);
  const location = reportedErrors.length > 0
    ? reportedErrors.map((error) =>
        `${path}:${Math.floor(error.line)}:${Math.floor(error.column)}${
          String(error.kind || "").trim()
            ? ` ${String(error.kind).trim().slice(0, 80)}${
                String(error.symbol || "").trim()
                  ? `(${String(error.symbol).trim().slice(0, 120)})`
                  : ""
              }`
            : ""
        }`
      ).join(", ")
    : checked.firstErrorLine
      ? `${path}:${checked.firstErrorLine}:${checked.firstErrorColumn || 1}`
      : path;
  const progress = previous?.applicable && previous.hasErrors
    ? `; pre-existing ${previous.errorCount} -> proposed ${checked.errorCount}`
    : "";
  const duplicateExportSymbols = [...new Set(
    reportedErrors
      .filter((error) => error.kind === "duplicate_export")
      .map((error) => String(error.symbol || "").trim())
      .filter(Boolean),
  )];
  const duplicateExportRecovery = duplicateExportSymbols.length > 0
    ? language === "en"
      ? `; duplicate export means the proposed post-image already has another declaration for ${duplicateExportSymbols.join(", ")}. Keep the existing valid declaration and remove only the corrupted or obsolete fragment instead of adding a second export`
      : `；重复导出表示拟写入结果中已经存在 ${duplicateExportSymbols.join("、")} 的另一处声明。请保留现有有效声明，只删除损坏或过期片段，不要再新增同名 export`
    : "";
  return blocked({
    reason: "syntax_error",
    toolName: input.toolName,
    path,
    language,
    detail:
      `${location}${
        checked.errorsTruncated ? ", additional parser errors omitted" : ""
      }; ${Math.max(1, checked.errorCount)} parser error(s)${progress}${duplicateExportRecovery}`,
    recoveryKind: "mutation_rejected",
  });
}

interface WorkspaceMutationPostImage {
  readonly path: string;
  readonly oldContent: string;
  readonly newContent: string;
}

function containsIdentifierToken(content: string, symbol: string): boolean {
  if (!/^[A-Za-z_$][\w$]*$/.test(symbol)) return true;
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^A-Za-z0-9_$])${escaped}([^A-Za-z0-9_$]|$)`)
    .test(content);
}

async function blockedPublicContractResult(
  input: WorkspaceMutationPreflightInput,
  changes: readonly WorkspaceMutationPostImage[],
  language: "zh" | "en",
): Promise<WorkspaceMutationPreflightResult | null> {
  if (!input.checkSyntax || !input.findReferences) return null;
  for (const change of changes) {
    const [current, proposed] = await Promise.all([
      input.checkSyntax(change.path, change.oldContent),
      input.checkSyntax(change.path, change.newContent),
    ]);
    if (!current.applicable || !proposed.applicable) continue;
    const proposedExports = new Set(proposed.moduleExports || []);
    const removedExports = [...new Set(current.moduleExports || [])]
      .filter((symbol) => symbol !== "default" && !proposedExports.has(symbol))
      .slice(0, 24);
    for (const symbol of removedExports) {
      let references: Awaited<ReturnType<
        NonNullable<WorkspaceMutationPreflightInput["findReferences"]>
      >>;
      try {
        references = await input.findReferences(symbol);
      } catch (error) {
        return blocked({
          reason: "public_contract_break",
          toolName: input.toolName,
          path: change.path,
          language,
          detail: `${symbol}: reference scan failed (${
            error instanceof Error ? error.message : String(error)
          })`,
          recoveryKind: "mutation_rejected",
        });
      }
      const imports = (references.occurrences || []).filter((occurrence) => {
        if (occurrence.role !== "import") return false;
        if (workspacePathsReferToSameFile(occurrence.path, change.path)) {
          return false;
        }
        const changedCaller = changes.find((candidate) =>
          workspacePathsReferToSameFile(candidate.path, occurrence.path)
        );
        return !changedCaller ||
          containsIdentifierToken(changedCaller.newContent, symbol);
      });
      if (imports.length === 0) continue;
      return blocked({
        reason: "public_contract_break",
        toolName: input.toolName,
        path: change.path,
        language,
        detail: `${symbol} -> ${imports.slice(0, 6).map((occurrence) =>
          `${occurrence.path}:${Math.max(1, Math.floor(occurrence.line || 1))}`
        ).join(", ")}`,
        recoveryKind: "mutation_rejected",
      });
    }
  }
  return null;
}

export async function preflightWorkspaceMutation(
  input: WorkspaceMutationPreflightInput,
): Promise<WorkspaceMutationPreflightResult> {
  const language = input.language === "en" ? "en" : "zh";
  const toolName = String(input.toolName || "");
  const path = asText(input.args.path).trim();

  if (toolName !== "replace_in_file" && toolName !== "write_file" && toolName !== "apply_patch") {
    return { ok: true, reason: "not_applicable" };
  }

  if (toolName === "apply_patch") {
    const patch = input.args.patch;
    if (typeof patch !== "string" || !patch.trim()) {
      return blocked({ reason: "missing_content", toolName, path: "patch", language });
    }
    const externalTarget = applyPatchTargets(patch).find((target) =>
      !isLexicallyInsideWorkspace(target, input.workspaceRoot)
    );
    if (externalTarget) {
      return blocked({
        reason: "outside_workspace",
        toolName,
        path: externalTarget,
        language,
        recoveryKind: "target_invalid",
      });
    }
    const patchTarget = summarizeApplyPatchTarget(patch) ||
      patch.match(/^\*\*\*\s+(?:Update|Add|Delete)\s+File:\s*(.+)$/m)?.[1]?.trim() ||
      "patch";
    const preview = await previewApplyPatch(
      patch,
      input.readFile,
      input.probeFileAvailability,
    );
    if (!preview.ok) {
      const recoveryTarget = preview.changes[0]?.path || patchTarget;
      const recoveryKind = preview.failureKind === "source_mismatch"
        ? "source_mismatch"
        : preview.failureKind === "target_unavailable"
          ? "target_invalid"
          : "mutation_rejected";
      const patchRecoveryMismatch = recoveryKind === "source_mismatch"
        ? await buildPatchRecoveryMismatchEvidence({
            reason: "invalid_patch",
            target: recoveryTarget,
            requestedRange: extractApplyPatchRequestedRange(patch, recoveryTarget),
            readFileMetadata: input.readFileMetadata,
          })
        : undefined;
      return blocked({
        reason: "invalid_patch",
        toolName,
        path: recoveryTarget,
        language,
        detail: preview.error,
        recoveryKind,
        patchRecoveryMismatch,
      });
    }
    const parsedPatch = parseApplyPatch(patch);
    for (const change of preview.changes) {
      if (change.kind !== "update") continue;
      const operations = parsedPatch.ok
        ? parsedPatch.operations.filter((operation) =>
            operation.kind === "update" && operation.path === change.path
          )
        : [];
      const detail = oversizedChangeCountsDetail({
        current: change.oldContent,
        removedLines: operations.reduce(
          (total, operation) =>
            total + operation.hunks.reduce(
              (sum, hunk) => sum + lineCount(hunk.oldText),
              0,
            ),
          0,
        ),
        addedLines: operations.reduce(
          (total, operation) =>
            total + operation.hunks.reduce(
              (sum, hunk) => sum + lineCount(hunk.newText),
              0,
          ),
          0,
        ),
        maxTouchedLines: input.maxTouchedLines,
      });
      if (detail) {
        return blocked({
          reason: "oversized_change",
          toolName,
          path: change.path,
          language,
          detail,
          recoveryKind: "mutation_rejected",
        });
      }
    }
    for (const change of preview.changes) {
      if (change.kind === "delete") continue;
      const syntaxFailure = await blockedSyntaxResult(
        input,
        change.path,
        change.newContent,
        language,
        change.kind === "update" ? change.oldContent : undefined,
      );
      if (syntaxFailure) return syntaxFailure;
    }
    const publicContractFailure = await blockedPublicContractResult(
      input,
      preview.changes
        .filter((change) => change.kind !== "add")
        .map((change) => ({
          path: change.path,
          oldContent: change.oldContent,
          newContent: change.newContent,
        })),
      language,
    );
    if (publicContractFailure) return publicContractFailure;
    return { ok: true };
  }

  if (toolName === "write_file") {
    const content = input.args.content;
    if (typeof content !== "string") {
      return blocked({ reason: "missing_content", toolName, path: path || "(missing path)", language });
    }
    if (!path) return { ok: true };
    if (!isLexicallyInsideWorkspace(path, input.workspaceRoot)) {
      return blocked({
        reason: "outside_workspace",
        toolName,
        path,
        language,
        recoveryKind: "target_invalid",
      });
    }
    try {
      const current = await input.readFile(path);
      if (current === content) {
        return blocked({ reason: "identical_content", toolName, path, language });
      }
      return blocked({
        reason: "existing_file_requires_patch",
        toolName,
        path,
        language,
      });
    } catch {
      return (await blockedSyntaxResult(input, path, content, language)) ||
        { ok: true };
    }
  }

  const searchText = asText(input.args.search_text);
  const replaceText = asText(input.args.replace_text);
  if (!isLexicallyInsideWorkspace(path, input.workspaceRoot)) {
    return blocked({
      reason: "outside_workspace",
      toolName,
      path,
      language,
      recoveryKind: "target_invalid",
    });
  }
  if (!path || !searchText) return { ok: true };

  let current: string;
  try {
    current = await input.readFile(path);
  } catch (error) {
    return blocked({
      reason: "read_failed",
      toolName,
      path,
      language,
      detail: error instanceof Error ? error.message : String(error || ""),
      recoveryKind: "target_invalid",
    });
  }

  if (!current.includes(searchText)) {
    const patchRecoveryMismatch = await buildPatchRecoveryMismatchEvidence({
      reason: "search_text_mismatch",
      target: path,
      requestedRange:
        normalizeRecoveryReadRange(input.args) ||
        inferReplaceMismatchRecoveryRange(current, searchText),
      failureIdentity: buildReplaceMismatchFailureIdentity(searchText),
      readFileMetadata: input.readFileMetadata,
    });
    return blocked({
      reason: "search_text_mismatch",
      toolName,
      path,
      language,
      recoveryKind: "source_mismatch",
      patchRecoveryMismatch,
    });
  }
  const firstMatch = current.indexOf(searchText);
  if (current.indexOf(searchText, firstMatch + 1) >= 0) {
    return blocked({
      reason: "search_text_ambiguous",
      toolName,
      path,
      language,
      recoveryKind: "mutation_rejected",
    });
  }
  const updated = current.replace(searchText, replaceText);
  if (updated === current) {
    return blocked({ reason: "empty_change", toolName, path, language });
  }
  const oversizedDetail = oversizedChangeDetail({
    current,
    removed: searchText,
    added: replaceText,
    maxTouchedLines: input.maxTouchedLines,
  });
  if (oversizedDetail) {
    return blocked({
      reason: "oversized_change",
      toolName,
      path,
      language,
      detail: oversizedDetail,
      recoveryKind: "mutation_rejected",
    });
  }

  const syntaxFailure = await blockedSyntaxResult(
    input,
    path,
    updated,
    language,
    current,
  );
  if (syntaxFailure) return syntaxFailure;
  return (await blockedPublicContractResult(
    input,
    [{ path, oldContent: current, newContent: updated }],
    language,
  )) || { ok: true };
}
