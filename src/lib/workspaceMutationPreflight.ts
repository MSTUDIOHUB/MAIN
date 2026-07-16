import { previewApplyPatch, summarizeApplyPatchTarget } from "./applyPatchTool";
import {
  buildExecutePatchMismatchFingerprint,
  normalizeRecoveryReadRange,
  type PatchRecoveryMismatchEvidence,
  type RecoveryReadLease,
} from "./executeRecoveryTools";

export type WorkspaceMutationPreflightReason =
  | "not_applicable"
  | "missing_content"
  | "read_failed"
  | "search_text_mismatch"
  | "empty_change"
  | "identical_content"
  | "invalid_patch";

export interface WorkspaceMutationPreflightResult {
  ok: boolean;
  reason?: WorkspaceMutationPreflightReason;
  message?: string;
  /** Best available workspace target for recovery and progress correlation. */
  path?: string;
  patchRecoveryMismatch?: PatchRecoveryMismatchEvidence;
}

export interface WorkspaceMutationPreflightInput {
  toolName: string;
  args: Record<string, unknown>;
  language?: "zh" | "en";
  readFile: (path: string) => Promise<string>;
  readFileMetadata?: (
    path: string,
  ) => Promise<{ sizeBytes: number; modifiedMs: number } | null>;
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
  readFileMetadata?: WorkspaceMutationPreflightInput["readFileMetadata"];
}): Promise<PatchRecoveryMismatchEvidence> {
  const metadata = input.readFileMetadata
    ? await input.readFileMetadata(input.target).catch(() => null)
    : null;
  return {
    mismatchFingerprint: buildExecutePatchMismatchFingerprint({
      reason: input.reason,
      target: input.target,
    }),
    target: input.target,
    ...(input.requestedRange ? { requestedRange: input.requestedRange } : {}),
    observedVersion: metadata
      ? `${Number(metadata.sizeBytes) || 0}:${Number(metadata.modifiedMs) || 0}`
      : null,
  };
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
        return `MUTATION_PREFLIGHT_BLOCKED: search_text was not found in ${input.path}. Do not ask for approval; read the current file once, then retry with an exact patch or explain the blocker.`;
      case "empty_change":
        return `MUTATION_PREFLIGHT_BLOCKED: ${input.toolName} would not change ${input.path}. Do not ask for approval; provide a real edit, run validation, or explain the blocker.`;
      case "identical_content":
        return `MUTATION_PREFLIGHT_BLOCKED: write_file content is identical to ${input.path}. Do not ask for approval; choose a real edit, validation, or a blocker report.`;
      case "invalid_patch":
        return `MUTATION_PREFLIGHT_BLOCKED: apply_patch is invalid or would not apply (${input.detail || "invalid patch"}). Do not ask for approval; read the exact target once if needed, then retry with a valid patch.`;
    }
  }

  switch (input.reason) {
    case "missing_content":
      return `MUTATION_PREFLIGHT_BLOCKED: ${input.toolName} 写入 ${input.path} 缺少 content。不要请求用户审批；请在必要时先读取目标，再用完整参数重试。`;
    case "read_failed":
      return `MUTATION_PREFLIGHT_BLOCKED: patch 前无法读取 ${input.path}（${input.detail || "读取失败"}）。不要请求用户审批；请读取正确目标或明确阻塞。`;
    case "search_text_mismatch":
      return `MUTATION_PREFLIGHT_BLOCKED: search_text 在 ${input.path} 中不存在。不要请求用户审批；允许先定向 read_file 一次，然后必须用精确 patch 重试、验证或说明阻塞。`;
    case "empty_change":
      return `MUTATION_PREFLIGHT_BLOCKED: ${input.toolName} 不会改变 ${input.path}。不要请求用户审批；请给出真实改动、执行验证或说明阻塞。`;
    case "identical_content":
      return `MUTATION_PREFLIGHT_BLOCKED: write_file 内容与 ${input.path} 完全相同。不要请求用户审批；请改为真实改动、验证或阻塞说明。`;
    case "invalid_patch":
      return `MUTATION_PREFLIGHT_BLOCKED: apply_patch 无效或无法应用（${input.detail || "无效 patch"}）。不要请求用户审批；必要时只定向读取一次目标，然后用有效 patch 重试。`;
  }
}

function blocked(input: {
  reason: Exclude<WorkspaceMutationPreflightReason, "not_applicable">;
  toolName: string;
  path: string;
  language: "zh" | "en";
  detail?: string;
  patchRecoveryMismatch?: PatchRecoveryMismatchEvidence;
}): WorkspaceMutationPreflightResult {
  return {
    ok: false,
    reason: input.reason,
    message: buildMessage(input),
    path: input.path,
    ...(input.patchRecoveryMismatch
      ? { patchRecoveryMismatch: input.patchRecoveryMismatch }
      : {}),
  };
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
    const patchTarget = summarizeApplyPatchTarget(patch) ||
      patch.match(/^\*\*\*\s+(?:Update|Add|Delete)\s+File:\s*(.+)$/m)?.[1]?.trim() ||
      "patch";
    const preview = await previewApplyPatch(patch, input.readFile);
    if (!preview.ok) {
      const recoveryTarget = preview.changes[0]?.path || patchTarget;
      const patchRecoveryMismatch = await buildPatchRecoveryMismatchEvidence({
        reason: "invalid_patch",
        target: recoveryTarget,
        requestedRange: extractApplyPatchRequestedRange(patch, recoveryTarget),
        readFileMetadata: input.readFileMetadata,
      });
      return blocked({
        reason: "invalid_patch",
        toolName,
        path: recoveryTarget,
        language,
        detail: preview.error,
        patchRecoveryMismatch,
      });
    }
    return { ok: true };
  }

  if (toolName === "write_file") {
    const content = input.args.content;
    if (typeof content !== "string") {
      return blocked({ reason: "missing_content", toolName, path: path || "(missing path)", language });
    }
    if (!path) return { ok: true };
    try {
      const current = await input.readFile(path);
      if (current === content) {
        return blocked({ reason: "identical_content", toolName, path, language });
      }
    } catch {
      return { ok: true };
    }
    return { ok: true };
  }

  const searchText = asText(input.args.search_text);
  const replaceText = asText(input.args.replace_text);
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
    });
  }

  if (!current.includes(searchText)) {
    const patchRecoveryMismatch = await buildPatchRecoveryMismatchEvidence({
      reason: "search_text_mismatch",
      target: path,
      requestedRange: normalizeRecoveryReadRange(input.args),
      readFileMetadata: input.readFileMetadata,
    });
    return blocked({
      reason: "search_text_mismatch",
      toolName,
      path,
      language,
      patchRecoveryMismatch,
    });
  }
  const updated = current.replace(searchText, replaceText);
  if (updated === current) {
    return blocked({ reason: "empty_change", toolName, path, language });
  }

  return { ok: true };
}
