export interface RecentToolCall {
  name: string;
  argsKey: string;
}

export interface RecentTargetToolCall {
  name: string;
  targetKey: string;
  family: "edit" | "verify" | "other";
}

export interface RepeatLoopCheck {
  repeated: boolean;
  threshold: number;
  argsKey: string;
  signature: string;
}

export interface TargetProgressLoopCheck {
  repeated: boolean;
  threshold: number;
  targetKey: string;
  signature: string;
  family: "edit" | "verify" | "other";
}

export function buildRepeatLoopArgsKey(args: Record<string, unknown>): string {
  return JSON.stringify(
    Object.entries(args)
      .filter(([_, value]) => value !== undefined && value !== null)
      .sort(([a], [b]) => a.localeCompare(b)),
  );
}

export function buildRepeatLoopSignature(name: string, argsKey: string): string {
  return `${name}::${argsKey}`;
}

const READ_ONLY_SHELL_TOOL_NAMES = new Set(["run_command", "execute_command"]);
const READ_ONLY_SHELL_COMMAND_RE = /^(?:pwd|ls(?:\s|$)|cat\s+|sed\s+-n\b|grep\b|rg\b|head\b|tail\b|wc\b|git\s+(?:status|diff|show|log|branch)\b)/i;
const UNSAFE_SHELL_INSPECTION_RE = /(?:^|\s)(?:sudo|rm|mv|cp|chmod|chown|touch|mkdir|rmdir|git\s+(?:add|commit|checkout|switch|reset|clean|push|pull|merge|rebase)|npm|pnpm|yarn|bun|cargo|python|python3|node|sh|bash|zsh)\b/i;

function getShellCommandArgument(args: Record<string, unknown>): string {
  const command = args.command ?? args.cmd ?? args.input;
  return typeof command === "string" ? command.trim() : "";
}

function normalizeShellInspectionSegment(segment: string): string {
  return segment
    .trim()
    .replace(/^\(\s*/, "")
    .replace(/\s*\)$/, "")
    .replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S+)\s+)+/, "")
    .trim();
}

export function isReadOnlyShellInspectionToolCall(
  name: string,
  args: Record<string, unknown>,
): boolean {
  if (!READ_ONLY_SHELL_TOOL_NAMES.has(name)) return false;
  const command = getShellCommandArgument(args);
  if (!command || /[\r\n`$<>]/.test(command)) return false;

  const executableSegments = command
    .split(/\s*(?:&&|\|\||;|\|)\s*/g)
    .map(normalizeShellInspectionSegment)
    .filter(Boolean)
    .filter((segment) => !/^(?:cd|pushd|popd)\b/i.test(segment));

  return executableSegments.length > 0 &&
    executableSegments.every((segment) =>
      !UNSAFE_SHELL_INSPECTION_RE.test(segment) &&
      READ_ONLY_SHELL_COMMAND_RE.test(segment)
    );
}

export function registerToolCallForRepeatGuard(
  history: RecentToolCall[],
  name: string,
  args: Record<string, unknown>,
  readOnly: boolean,
): RepeatLoopCheck {
  const threshold = readOnly ? 6 : 3;
  const argsKey = buildRepeatLoopArgsKey(args);

  history.push({ name, argsKey });
  if (history.length > threshold + 2) history.shift();

  if (history.length >= threshold) {
    const lastN = history.slice(-threshold);
    const repeated = lastN.every(
      (call) => call.name === lastN[0].name && call.argsKey === lastN[0].argsKey,
    );
    if (repeated) {
      return {
        repeated: true,
        threshold,
        argsKey,
        signature: buildRepeatLoopSignature(name, argsKey),
      };
    }
  }

  return {
    repeated: false,
    threshold,
    argsKey,
    signature: buildRepeatLoopSignature(name, argsKey),
  };
}

function getToolProgressFamily(name: string): RecentTargetToolCall["family"] {
  if (name === "write_file" || name === "replace_in_file") return "edit";
  if (
    name === "run_command" ||
    name === "execute_command" ||
    name === "send_pty_input" ||
    name === "read_pty_buffer" ||
    name === "read_pty_tail" ||
    name === "read_pty_since" ||
    name === "get_pty_status"
  ) {
    return "verify";
  }
  return "other";
}

function normalizeTargetKey(target: string): string {
  return String(target || "")
    .replace(/\\/g, "/")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function registerTargetProgressForLoopGuard(
  history: RecentTargetToolCall[],
  name: string,
  target: string,
): TargetProgressLoopCheck {
  const family = getToolProgressFamily(name);
  const targetKey = normalizeTargetKey(target);
  const threshold = family === "edit" ? 4 : 5;
  const signature = `${family}::${targetKey}`;

  if (!targetKey || family === "other") {
    return { repeated: false, threshold, targetKey, signature, family };
  }

  history.push({ name, targetKey, family });
  if (history.length > threshold + 3) history.shift();

  if (history.length >= threshold) {
    const lastN = history.slice(-threshold);
    const repeated = lastN.every(
      (call) => call.family === family && call.targetKey === targetKey,
    );
    if (repeated) {
      return { repeated: true, threshold, targetKey, signature, family };
    }
  }

  return { repeated: false, threshold, targetKey, signature, family };
}

export function formatTargetProgressLoopRecoveryMessage(
  family: TargetProgressLoopCheck["family"],
  target: string,
  threshold: number,
): string {
  const label = family === "edit" ? "edit" : family === "verify" ? "verification" : "tool";
  return `Progress guard: ${label} tools have targeted "${target}" ${threshold}+ times without an intervening different target. Reconcile the latest result already in context, decide whether the task is complete, and only call a different smallest-necessary next tool if real evidence is still missing.`;
}

export function formatRepeatLoopRecoveryMessage(
  name: string,
  target: string,
  threshold: number,
): string {
  const suffix = target ? ` (target: "${target}")` : "";
  return `Repeat guard: read-only tool "${name}" was called with identical arguments ${threshold}+ times${suffix}. Reuse the latest result already in context and switch to a more specific tool such as get_project_skeleton, glob_search, grep_search, get_file_outline, or read_file.`;
}

export function formatRepeatLoopFatalMessage(
  name: string,
  target: string,
  threshold: number,
): string {
  const suffix = target ? ` (target: "${target}")` : "";
  return `Detected a repetition loop: tool "${name}" called with identical arguments ${threshold}+ times${suffix}. This usually means the model lost context. Reuse earlier tool results or increase the context limit and retry.`;
}
