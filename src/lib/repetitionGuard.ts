export interface RecentToolCall {
  name: string;
  argsKey: string;
}

export interface RecentTargetToolCall {
  name: string;
  targetKey: string;
  family: "edit" | "verify" | "other";
  outcome?: TargetProgressOutcome;
  reason?: string;
}

export type TargetProgressOutcome =
  | "succeeded"
  | "failed"
  | "blocked"
  | "no_change"
  | "declined"
  | "unknown";

export interface TargetProgressEvent {
  name: string;
  target: string;
  outcome?: TargetProgressOutcome;
  reason?: string;
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
// Keep sed admission intentionally narrow: only the common line-range print
// form is inspection. Broader sed scripts may write through `w` or `-i` and
// therefore remain outside the read-only recovery path.
const READ_ONLY_SHELL_COMMAND_RE = /^(?:pwd|ls(?:\s|$)|find\s+|cat\s+|grep\b|rg\b|head\b|tail\b|wc\b|cut\b|uniq\b|diff\b|stat\b|file\b|strings\b|sed\s+-n\s+['"]?\d+(?:,\d+)?p['"]?(?:\s|$)|git\s+status\b)/i;
const UNSAFE_SHELL_INSPECTION_RE = /(?:^|\s)(?:sudo|rm|mv|cp|chmod|chown|touch|mkdir|rmdir|git\s+(?:add|commit|checkout|switch|reset|clean|push|pull|merge|rebase)|npm|pnpm|yarn|bun|cargo|python|python3|node|sh|bash|zsh)\b/i;
const MUTATING_INSPECTION_ARGUMENT_RE = /(?:^|\s)(?:-(?:delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)\b|--(?:output|ext-diff)(?:\s|=|$))/i;

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
      !MUTATING_INSPECTION_ARGUMENT_RE.test(segment) &&
      READ_ONLY_SHELL_COMMAND_RE.test(segment)
    );
}

export function registerToolCallForRepeatGuard(
  history: RecentToolCall[],
  name: string,
  args: Record<string, unknown>,
  readOnly: boolean,
): RepeatLoopCheck {
  const isShellInspection = isReadOnlyShellInspectionToolCall(name, args);
  const threshold = isShellInspection ? 3 : readOnly ? 4 : 3;
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

function getToolProgressFamily(name: string, target?: string): RecentTargetToolCall["family"] {
  if (String(target || "").startsWith("shell-write:")) return "edit";
  if (
    name === "write_file" ||
    name === "replace_in_file" ||
    name === "apply_patch" ||
    name === "script_apply_edits" ||
    name === "apply_text_edits" ||
    name === "manage_script" ||
    name === "create_script" ||
    name === "delete_script"
  ) return "edit";
  if (
    name === "run_command" ||
    name === "execute_command" ||
    name === "read_pty_buffer" ||
    name === "read_pty_tail" ||
    name === "read_pty_since" ||
    name === "get_pty_status"
  ) {
    return "verify";
  }
  return "other";
}

function normalizeShellMutationPath(path: string): string {
  return String(path || "")
    .trim()
    .replace(/^['"]|['"]$/g, "")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "");
}

export function getShellMutationTargetForLoopGuard(
  name: string,
  args: Record<string, unknown>,
): string | null {
  if (name !== "run_command" && name !== "execute_command") return null;
  const command = getShellCommandArgument(args);
  if (!command) return null;

  const redirection = command.match(/(?:^|\s)(?:>{1,2})\s*(['"]?)([^'"\s;&|]+)\1/);
  const redirectionPath = normalizeShellMutationPath(redirection?.[2] || "");
  if (redirectionPath && redirectionPath !== "/dev/null") {
    return `shell-write:${redirectionPath}`;
  }

  const touchPath = command.match(/(?:^|\s)touch\s+(?:-[A-Za-z]+\s+)*(['"]?)([^'"\s;&|]+)\1/i);
  const touchTarget = normalizeShellMutationPath(touchPath?.[2] || "");
  if (touchTarget) return `shell-write:${touchTarget}`;

  const openPath = command.match(/\bopen\(\s*(['"])([^'"]+)\1\s*,\s*(['"])[wa]/i);
  const openTarget = normalizeShellMutationPath(openPath?.[2] || "");
  if (openTarget) return `shell-write:${openTarget}`;

  const pathlibPath = command.match(/\bPath\(\s*(['"])([^'"]+)\1\s*\)\s*\.\s*write_(?:text|bytes)\s*\(/i);
  const pathlibTarget = normalizeShellMutationPath(pathlibPath?.[2] || "");
  if (pathlibTarget) return `shell-write:${pathlibTarget}`;

  const nodeWritePath = command.match(/\b(?:writeFileSync|appendFileSync)\(\s*(['"])([^'"]+)\1/i);
  const nodeWriteTarget = normalizeShellMutationPath(nodeWritePath?.[2] || "");
  if (nodeWriteTarget) return `shell-write:${nodeWriteTarget}`;

  const inPlaceEditPath = command.match(/(?:^|\s)(?:sed\s+-i(?:\.[^\s]+)?|perl\s+-pi(?:e)?)\b[^\n;&|]*\s(['"]?)([^'"\s;&|]+)\1/i);
  const inPlaceEditTarget = normalizeShellMutationPath(inPlaceEditPath?.[2] || "");
  if (inPlaceEditTarget) return `shell-write:${inPlaceEditTarget}`;
  return null;
}

function normalizeTargetKey(target: string): string {
  return String(target || "")
    .replace(/\\/g, "/")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function isInternalPlanProgressTarget(targetKey: string): boolean {
  const normalized = targetKey.startsWith("shell-write:")
    ? targetKey.slice("shell-write:".length)
    : targetKey;
  return normalized === ".main/plans/requirements.md" ||
    normalized.endsWith("/.main/plans/requirements.md") ||
    normalized === ".main/plans/plan.md" ||
    normalized.endsWith("/.main/plans/plan.md") ||
    normalized === ".main/plans/tasks.md" ||
    normalized.endsWith("/.main/plans/tasks.md");
}

export function registerTargetProgressForLoopGuard(
  history: RecentTargetToolCall[],
  name: string,
  target: string,
): TargetProgressLoopCheck {
  return registerTargetProgressEventForLoopGuard(history, {
    name,
    target,
    outcome: "failed",
  });
}

export function registerTargetProgressEventForLoopGuard(
  history: RecentTargetToolCall[],
  event: TargetProgressEvent,
): TargetProgressLoopCheck {
  const name = event.name;
  const target = event.target;
  const family = getToolProgressFamily(name, target);
  const targetKey = normalizeTargetKey(target);
  const threshold = targetKey.startsWith("shell-write:") ? 3 : family === "edit" ? 4 : 5;
  const signature = `${family}::${targetKey}`;

  if (!targetKey || family === "other" || isInternalPlanProgressTarget(targetKey)) {
    return { repeated: false, threshold, targetKey, signature, family };
  }

  const outcome: TargetProgressOutcome = event.outcome || "unknown";
  if (outcome === "succeeded") {
    for (let index = history.length - 1; index >= 0; index -= 1) {
      const call = history[index];
      if (call.family === family && call.targetKey === targetKey) {
        history.splice(index, 1);
      }
    }
    return { repeated: false, threshold, targetKey, signature, family };
  }

  history.push({
    name,
    targetKey,
    family,
    outcome,
    reason: event.reason,
  });
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
  const displayTarget = target.startsWith("shell-write:") ? target.slice("shell-write:".length) : target;
  const shellWriteHint = target.startsWith("shell-write:")
    ? " This shell-write target has already failed to make progress; inspect the current file state and switch to a file tool or an existing asset helper instead of trying another shell writer."
    : "";
  return `Progress guard: ${label} tools have targeted "${displayTarget}" ${threshold}+ times without a successful write, real diff, or verification result. Reconcile the latest result already in context, inspect current workspace state if needed, then patch/verify the smallest necessary target or state the exact blocker.${shellWriteHint}`;
}

export function formatRepeatLoopRecoveryMessage(
  name: string,
  target: string,
  threshold: number,
  availableToolNames?: Iterable<string> | null,
): string {
  const suffix = target ? ` (target: "${target}")` : "";
  const isShell = name === "run_command" || name === "execute_command";
  if (isShell) {
    return `REPEATED_COMMAND_BLOCKED: Shell command "${target || name}" was called with identical arguments ${threshold}+ times. Output is already present in context above. Do not re-run this command. Reuse existing output to patch files, execute a different validation, or state your final conclusion.`;
  }
  const available = availableToolNames ? new Set(Array.from(availableToolNames)) : null;
  const candidates = ["grep_search", "get_file_outline", "get_project_skeleton", "glob_search", "read_file"];
  const suggestions = candidates.filter((toolName) => !available || available.has(toolName));
  const suggestionText = suggestions.length > 0
    ? suggestions.join(", ")
    : "cached context, patch/validation tools, or a final blocker";
  return `Repeat guard: read-only tool "${name}" was called with identical arguments ${threshold}+ times${suffix}. Reuse the latest result already in context; do not retry the same read or use shell file reads as a workaround. Switch to an available alternative (${suggestionText}), or proceed directly to patch, validation, finish, or state the exact blocker.`;
}

export function formatRepeatLoopFatalMessage(
  name: string,
  target: string,
  threshold: number,
): string {
  const suffix = target ? ` (target: "${target}")` : "";
  return `Detected a repetition loop: tool "${name}" called with identical arguments ${threshold}+ times${suffix}. This is a repeated-call safety guard, not a write engine failure. Reuse successful results already in context, then continue with a different or next target.`;
}
