export type WorkspaceToolFailureCode =
  | "path_out_of_workspace"
  | "target_not_found"
  | "target_is_directory"
  | "target_inaccessible"
  | "read_failed"
  | "subagent_path_limit_exceeded"
  | "subagent_path_invalid"
  | "subagent_duplicate_or_overlap"
  | "subagent_optional_proposal_rejected"
  | "subagent_capacity_unavailable"
  | "subagent_insufficient_runway"
  | "subagent_write_unauthorized"
  | "subagent_wait_handle_not_found"
  | "subagent_schedule_failed";

export interface ClassifiedWorkspaceToolFailure {
  readonly code: WorkspaceToolFailureCode;
  readonly failureKind: "target_invalid" | "execution_failed" | "not_authorized";
}

export interface WorkspaceToolFailureCopy {
  readonly cardMessage: string;
  readonly modelHint: string;
}

/** Classify read-tool filesystem/path errors into durable failureReasonCode values.
 * Inspects explicit Rust/tool prefixes and inner WorkspacePathError messages BEFORE
 * looking at localized wrapper phrases so path escapes and permission errors never
 * masquerade as missing files. */
export function classifyWorkspaceReadFailure(rawError: unknown): ClassifiedWorkspaceToolFailure {
  const message = rawError instanceof Error ? rawError.message : String(rawError || "");
  if (
    /^READ_PATH_OUT_OF_WORKSPACE:/i.test(message) ||
    /(?:escapes canonical workspace|路径越界[：:]|禁止访问工作区之外)/i.test(message)
  ) {
    return { code: "path_out_of_workspace", failureKind: "target_invalid" };
  }
  if (
    /^FILE_READ_NOT_REGULAR:/i.test(message) ||
    /^(?:目标不是(?:普通)?文件|is a directory|EISDIR)/i.test(message) ||
    /(?:目标不是(?:普通)?文件|working directory is not a directory|not a file|is a directory)/i.test(message)
  ) {
    return { code: "target_is_directory", failureKind: "target_invalid" };
  }
  if (
    /^READ_PARENT_NOT_DIRECTORY:/i.test(message)
  ) {
    return { code: "target_not_found", failureKind: "target_invalid" };
  }
  if (
    /^READ_TARGET_NOT_FOUND:/i.test(message) ||
    /(?:workspace path is missing|no such file or directory|ENOENT|os error 2|(?:^|[:：\s])(?:目标)?路径不存在[：:])/i.test(message)
  ) {
    return { code: "target_not_found", failureKind: "target_invalid" };
  }
  if (
    /^READ_TARGET_INACCESSIBLE:/i.test(message) ||
    /(?:permission denied|operation not permitted|EACCES|EPERM|invalid workspace root|无法访问目标路径|路径越界、不存在或无法访问)/i.test(message)
  ) {
    return { code: "target_inaccessible", failureKind: "execution_failed" };
  }
  if (/(?:目标路径不存在|文件不存在|找不到指定的文件)/i.test(message)) {
    return { code: "target_not_found", failureKind: "target_invalid" };
  }
  return { code: "read_failed", failureKind: "execution_failed" };
}

export function attachFailureReasonCode<T extends Error>(
  error: T,
  code: WorkspaceToolFailureCode,
): T & { failureReasonCode: WorkspaceToolFailureCode } {
  return Object.assign(error, { failureReasonCode: code });
}

export function readFailureReasonCode(error: unknown): WorkspaceToolFailureCode | undefined {
  if (error && typeof error === "object" && "failureReasonCode" in error) {
    const code = (error as { failureReasonCode?: unknown }).failureReasonCode;
    return typeof code === "string" && code.trim() ? (code.trim() as WorkspaceToolFailureCode) : undefined;
  }
  return undefined;
}

export function describeWorkspaceToolFailure(
  code: string | undefined,
  language: "zh" | "en",
): WorkspaceToolFailureCopy | undefined {
  const normalized = String(code || "").trim();
  if (!normalized) return undefined;
  const zh = language === "zh";
  switch (normalized) {
    case "path_out_of_workspace":
      return {
        cardMessage: zh ? "路径越界，禁止访问当前工作区之外的路径。" : "Path escapes the workspace boundary and cannot be accessed.",
        modelHint: "Only use workspace-relative paths inside the project root.",
      };
    case "target_not_found":
      return {
        cardMessage: zh ? "目标路径不存在，需先通过目录列表确认真实文件名。" : "Target path does not exist; inspect the directory listing to confirm the filename.",
        modelHint: "Call list_directory or glob_search on the parent folder instead of guessing filenames.",
      };
    case "target_is_directory":
      return {
        cardMessage: zh ? "目标是目录而非普通文件，需改用目录或搜索工具查看。" : "Target is a directory or non-regular file; use list_directory instead.",
        modelHint: "Call list_directory on directories instead of read_file.",
      };
    case "target_inaccessible":
      return {
        cardMessage: zh ? "目标路径无法访问（权限受限或文件系统错误）。" : "Target path cannot be accessed due to permissions or an I/O error.",
        modelHint: "Check workspace permissions or choose another readable file.",
      };
    case "read_failed":
      return {
        cardMessage: zh ? "读取目标失败，原始错误已保留在调试详情中。" : "Reading the target failed; details are preserved in debug diagnostics.",
        modelHint: "Inspect the error message before retrying.",
      };
    case "subagent_path_limit_exceeded":
      return {
        cardMessage: zh ? "子智能体单次路径超出 6 个上限，需按模块拆分后派发。" : "Subagent path scope exceeded the 6-path limit; split across multiple subagents.",
        modelHint: "Split paths across multiple spawn_subagent calls with at most 6 relative paths each.",
      };
    case "subagent_path_invalid":
      return {
        cardMessage: zh ? "子智能体路径包含工作区根目录、越界或非法路径，需改为精确相对路径。" : "Subagent scope contains root, escaping, or invalid paths; use narrow relative paths.",
        modelHint: "Provide narrow workspace-relative paths (never '.', '/', or '..').",
      };
    case "subagent_duplicate_or_overlap":
      return {
        cardMessage: zh ? "子智能体任务与现有子任务重复或写入范围重叠。" : "Subagent duplicates an existing task or overlaps an active write scope.",
        modelHint: "Delegate a genuinely distinct task/scope or continue parent work.",
      };
    case "subagent_optional_proposal_rejected":
      return {
        cardMessage: zh ? "本次可选子任务未派发，主线程继续处理。" : "The optional child was skipped; parent work continues.",
        modelHint: "Continue in the parent, or propose a separate deliverable supported by current primary evidence.",
      };
    case "subagent_capacity_unavailable":
      return {
        cardMessage: zh ? "当前模型通道不支持并发派发子智能体，由主线程直接继续。" : "Current model lane has no child capacity; continue in the parent run.",
        modelHint: "Proceed directly in the parent thread without spawning subagents.",
      };
    case "subagent_insufficient_runway":
      return {
        cardMessage: zh ? "当前轮次剩余时间不足以安全启动新子智能体。" : "Insufficient remaining time to start a new subagent safely.",
        modelHint: "Complete the work directly in the parent thread.",
      };
    case "subagent_write_unauthorized":
      return {
        cardMessage: zh ? "子智能体写入范围未获当前执行契约或源码版本授权。" : "Subagent write scope is not authorized by the current contract or source versions.",
        modelHint: "Only delegate approved write targets with valid source coverage.",
      };
    case "subagent_wait_handle_not_found":
      return {
        cardMessage: zh ? "指定的子智能体句柄不存在或已结束，无需继续等待。" : "Requested subagent handle does not match an active child.",
        modelHint: "Check active handles or continue with results already in context.",
      };
    case "subagent_schedule_failed":
      return {
        cardMessage: zh ? "派发子智能体未能通过运行时校验，请调整范围或由主线程继续。" : "Subagent scheduling failed validation; adjust scope or continue in parent.",
        modelHint: "Adjust the task scope or continue directly in the parent.",
      };
    default:
      return undefined;
  }
}
