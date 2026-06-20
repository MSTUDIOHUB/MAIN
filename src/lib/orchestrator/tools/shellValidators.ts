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
    return true;
  }
  return false;
}

function isShellFileReadSegment(segment: string): boolean {
  const normalized = normalizeShellReadSegment(segment);
  if (!normalized || isDirectoryOnlyShellSegment(normalized)) return false;
  const [command = "", ...args] = shellSegmentWords(normalized);
  if (/^(?:cat|head|tail)$/i.test(command)) {
    return catHeadTailSegmentHasFileOperand(command, args);
  }
  if (/^sed$/i.test(command)) {
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
      ? `SHELL_READ_FORBIDDEN: 禁止通过终端命令 (${command}) 直接读取文件内容以防止上下文过载。read_file 可用时请使用 read_file + start_line/max_lines；恢复模式未开放 read_file 时，请使用 grep_search/get_file_outline 或基于已有缓存直接 patch/验证/最终说明，不要改用 cat/sed/head/tail 绕行。`
      : `SHELL_READ_FORBIDDEN: Reading files via terminal commands (${command}) is disabled to prevent context overload. Use read_file with start_line/max_lines when available; if recovery mode has not exposed read_file, use grep_search/get_file_outline or proceed from cached context to patching, validation, or the final answer instead of cat/sed/head/tail.`;
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
