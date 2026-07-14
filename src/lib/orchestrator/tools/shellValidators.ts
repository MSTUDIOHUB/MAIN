import type { ToolCallToExecute, ToolExecutionResult, OrchestratorCallbacks } from "../../orchestrator";
import { getToolTarget, emitToolPreflightBlocked } from "../../orchestrator";

function normalizeShellReadSegment(segment: string): string {
  return String(segment || "")
    .trim()
    .replace(/^\(\s*/, "")
    .replace(/\s*\)$/, "")
    .replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S+)\s+)+/, "")
    .replace(/^(?:command|builtin)\s+/, "")
    .trim();
}

function isDirectoryOnlyShellSegment(segment: string): boolean {
  return /^(?:cd|pushd|popd)\b/i.test(segment);
}

function shellSegmentWords(segment: string): string[] {
  return String(segment || "").match(/"[^"]*"|'[^']*'|\S+/g)?.map((word) =>
    word.replace(/^(['"])(.*)\1$/, "$2")
  ) || [];
}

function isLogFileOperand(arg: string): boolean {
  const lower = String(arg || "").toLowerCase();
  return (
    lower.endsWith(".log") ||
    lower.endsWith(".out") ||
    lower.endsWith(".err") ||
    lower.includes("/logs/") ||
    lower.includes("/log/") ||
    lower.includes("editor.log") ||
    lower.includes("build.log") ||
    lower.includes("main-debug.log")
  );
}

function catHeadTailSegmentHasFileOperand(command: string, args: string[]): boolean {
  const normalizedCommand = command.toLowerCase();
  let skipNextOptionValue = false;
  for (const arg of args) {
    if (!arg) continue;
    if (skipNextOptionValue) {
      skipNextOptionValue = false;
      continue;
    }
    if (arg === "--") return args.indexOf(arg) < args.length - 1;
    if (normalizedCommand !== "cat" && /^(?:-n|-c|--lines|--bytes)$/.test(arg)) {
      skipNextOptionValue = true;
      continue;
    }
    if (normalizedCommand !== "cat" && /^(?:--lines=|--bytes=)/.test(arg)) continue;
    if (normalizedCommand !== "cat" && /^-\d+$/.test(arg)) continue;
    if (/^-/.test(arg)) continue;
    if (isLogFileOperand(arg)) continue;
    return true;
  }
  return false;
}

function sedSegmentHasFileOperand(args: string[]): boolean {
  let consumedScript = false;
  let skipNextScriptArg = false;
  for (const arg of args) {
    if (!arg) continue;
    if (skipNextScriptArg) {
      skipNextScriptArg = false;
      consumedScript = true;
      continue;
    }
    if (arg === "--") continue;
    if (/^(?:-e|-f)$/.test(arg)) {
      skipNextScriptArg = true;
      continue;
    }
    if (/^(?:-e|-f).+/.test(arg)) {
      consumedScript = true;
      continue;
    }
    if (/^-/.test(arg)) continue;
    if (!consumedScript) {
      consumedScript = true;
      continue;
    }
    if (isLogFileOperand(arg)) continue;
    return true;
  }
  return false;
}

function sedSegmentMutatesInPlace(args: string[]): boolean {
  return args.some((arg) =>
    arg === "-i" ||
    /^-i.+/.test(arg) ||
    /^-[A-Za-z]*i[A-Za-z]*$/.test(arg) ||
    arg === "--in-place" ||
    arg.startsWith("--in-place=")
  );
}

function isShellFileReadSegment(segment: string): boolean {
  const normalized = normalizeShellReadSegment(segment);
  if (!normalized || isDirectoryOnlyShellSegment(normalized)) return false;
  const [command = "", ...args] = shellSegmentWords(normalized);
  if (/^(?:cat|head|tail)$/i.test(command)) {
    return catHeadTailSegmentHasFileOperand(command, args);
  }
  if (/^sed$/i.test(command)) {
    if (sedSegmentMutatesInPlace(args)) return false;
    return sedSegmentHasFileOperand(args);
  }
  return false;
}

export function isShellFileReadCommand(command: string): boolean {
  const raw = String(command || "").trim();
  if (!raw) return false;
  return raw
    .split(/\s*(?:&&|\|\||;|\|)\s*/g)
    .map(normalizeShellReadSegment)
    .filter(Boolean)
    .some(isShellFileReadSegment);
}

export function buildShellReadValidationError(
  tc: ToolCallToExecute,
  args: Record<string, unknown>,
  callbacks: OrchestratorCallbacks,
): ToolExecutionResult | null {
  if (tc.name !== "run_command" && tc.name !== "execute_command") return null;
  const command = typeof args.command === "string" ? args.command.trim() : "";
  if (!command) return null;

  const isShellRead = isShellFileReadCommand(command);
  if (isShellRead) {
    const language = callbacks.getPreferredLanguage();
    const message = language === "zh"
      ? `SHELL_READ_FORBIDDEN: 禁止通过终端命令 (${command}) 绕过文件读取工具。原因不是终端本身占用上下文，而是 cat/sed/head/tail 的原始输出绕过 read_file 的分页、文件版本、读取范围缓存和修改后失效语义，可能把旧内容或相同窗口误当成新证据。read_file 可用时请使用 read_file + start_line/max_lines；恢复模式未开放 read_file 时，请使用 grep_search/get_file_outline，或基于已有证据继续 patch、验证或说明精确阻塞。`
      : `SHELL_READ_FORBIDDEN: Do not bypass the file-reading tools with terminal command (${command}). The issue is not terminal context use: raw cat/sed/head/tail output bypasses read_file paging, file-version checks, range caching, and post-mutation invalidation, so stale or duplicate content can be mistaken for fresh evidence. Use read_file with start_line/max_lines when available; if recovery mode has not exposed read_file, use grep_search/get_file_outline, continue from existing evidence, or state the exact blocker.`;
    const target = getToolTarget(tc.name, args);
    callbacks.onToolExecuting(tc.name, target, undefined, { toolCallId: tc.id });
    emitToolPreflightBlocked(callbacks, {
      reason: "shell_read_forbidden",
      tool: tc.name,
      target,
      message,
      toolCallId: tc.id,
      lifecycleState: "blocked",
    });
    callbacks.onToolError(tc.name, target, message, { toolCallId: tc.id });
    return {
      toolCallId: tc.id,
      name: tc.name,
      target,
      content: `Error: ${message}`,
      isError: true,
      lifecycleState: "blocked",
    };
  }
  return null;
}
