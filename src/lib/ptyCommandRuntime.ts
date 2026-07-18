export interface PtyCommandRuntimeStatus {
  active: boolean;
  running: boolean;
  pid?: number | null;
  foregroundPid?: number | null;
  shellAvailable?: boolean;
  foregroundState?: PtyForegroundState;
  foregroundGeneration?: number;
}

export interface PtyCommandAdmission {
  allowed: boolean;
  reason?: string;
}

export type PtyControlAction = "interrupt";
export type PtyForegroundState = "busy" | "idle" | "unknown" | "stopped";

export interface NormalizedPtyInput {
  value: string;
  displayValue: string;
  controlAction: PtyControlAction | null;
  normalizedAlias: boolean;
}

export interface PtyControlRuntimeStatus extends PtyCommandRuntimeStatus {
  exitCode?: number | null;
}

const INTERRUPT_INPUT_ALIASES = new Set([
  "\\u0003",
  "\\x03",
  "^c",
  "ctrl_c",
  "ctrl-c",
  "ctrl+c",
]);

/**
 * Normalize only explicit, whole-value control aliases. Generic unescaping is
 * intentionally forbidden because send_pty_input also carries ordinary raw
 * text for interactive programs.
 */
export function normalizePtyInput(
  input: string,
  requestedControl?: string,
): NormalizedPtyInput {
  const rawInput = String(input || "");
  const normalizedControl = String(requestedControl || "").trim().toLowerCase();
  if (normalizedControl && normalizedControl !== "interrupt") {
    throw new Error(`Unsupported PTY control action: ${requestedControl}`);
  }
  const alias = rawInput.trim().toLowerCase();
  const isInterrupt = normalizedControl === "interrupt" || rawInput === "\u0003" || INTERRUPT_INPUT_ALIASES.has(alias);
  if (isInterrupt) {
    return {
      value: "\u0003",
      displayValue: "CTRL_C",
      controlAction: "interrupt",
      normalizedAlias: rawInput !== "\u0003",
    };
  }
  return {
    value: rawInput,
    displayValue: rawInput,
    controlAction: null,
    normalizedAlias: false,
  };
}

/**
 * Planning and presentation paths must not throw on malformed model arguments;
 * the executor remains the single validation boundary that reports the error.
 */
export function isPtyControlInput(input: string, requestedControl?: string): boolean {
  try {
    return normalizePtyInput(input, requestedControl).controlAction !== null;
  } catch {
    return Boolean(String(requestedControl || "").trim());
  }
}

export function formatPtyInputTarget(input: string, requestedControl?: string): string {
  try {
    return normalizePtyInput(input, requestedControl).displayValue || "terminal input";
  } catch {
    const control = String(requestedControl || "").trim();
    return control ? `control:${control}` : String(input || "") || "terminal input";
  }
}

export function resolvePtyForegroundState(
  status: PtyControlRuntimeStatus | null | undefined,
): PtyForegroundState {
  if (!status?.active || !status.running) return "stopped";
  if (
    status.foregroundState === "busy" ||
    status.foregroundState === "idle" ||
    status.foregroundState === "unknown" ||
    status.foregroundState === "stopped"
  ) {
    return status.foregroundState;
  }
  if (typeof status.pid === "number" && typeof status.foregroundPid === "number") {
    return status.pid === status.foregroundPid ? "idle" : "busy";
  }
  // Legacy Windows backends reported shellAvailable=true while foreground PID
  // inspection was unsupported. Preserve that uncertainty instead of calling
  // a live dev server stopped.
  if (status.shellAvailable === false) return "busy";
  return "unknown";
}

export function hasActivePtyForeground(status: PtyControlRuntimeStatus | null | undefined): boolean {
  const state = resolvePtyForegroundState(status);
  if (state === "busy") return true;
  // On platforms without foreground process-group inspection, generation 0
  // is a fresh login shell. A later generation is an agent-dispatched
  // foreground workflow and may accept interaction/control input.
  return state === "unknown" && (status?.foregroundGeneration || 0) > 0;
}

export function buildPtyControlId(input: {
  sessionKey: string;
  action: PtyControlAction;
  status: PtyControlRuntimeStatus;
}): string {
  const foregroundIdentity = input.status.foregroundPid ?? "unknown";
  const shellIdentity = input.status.pid ?? "unknown";
  const generation = typeof input.status.foregroundGeneration === "number" &&
    Number.isFinite(input.status.foregroundGeneration)
    ? input.status.foregroundGeneration
    : 0;
  return `${input.sessionKey}::${shellIdentity}::${generation}::${foregroundIdentity}::${input.action}`;
}

export function describePtyControlEffect(input: {
  before: PtyControlRuntimeStatus;
  after: PtyControlRuntimeStatus;
}): "foreground_released" | "foreground_changed" | "foreground_still_running" | "status_unknown" {
  const afterState = resolvePtyForegroundState(input.after);
  if (afterState === "idle" || afterState === "stopped") return "foreground_released";
  if (
    afterState === "busy" &&
    input.before.foregroundPid != null &&
    input.after.foregroundPid != null &&
    input.before.foregroundPid !== input.after.foregroundPid
  ) {
    return "foreground_changed";
  }
  if (afterState === "busy") return "foreground_still_running";
  return "status_unknown";
}

export function resolvePtyCommandAdmission(
  status: PtyCommandRuntimeStatus,
): PtyCommandAdmission {
  const foregroundState = resolvePtyForegroundState(status);
  if (
    foregroundState === "idle" ||
    foregroundState === "stopped" ||
    (foregroundState === "unknown" && (status.foregroundGeneration || 0) === 0)
  ) {
    return { allowed: true };
  }

  const shellPid = status.pid ?? "unknown";
  const foregroundPid = status.foregroundPid ?? "unknown";
  return {
    allowed: false,
    reason:
      `${foregroundState === "unknown" ? "PTY_FOREGROUND_UNKNOWN" : "PTY_BUSY"}: integrated terminal shell pid=${shellPid} ` +
      `is occupied by foreground process group pid=${foregroundPid} (generation=${status.foregroundGeneration ?? "unknown"}). ` +
      "Do not resend a shell command. Inspect the existing process with read_pty_since/read_pty_tail/get_pty_status, " +
      "or use send_pty_input for intentional interactive input such as Ctrl+C.",
  };
}

function normalizeCommandLine(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

export function isOnlyPtyCommandEcho(output: string, command: string): boolean {
  const normalizedCommand = normalizeCommandLine(command);
  if (!normalizedCommand) return false;
  const lines = output
    .split(/\r?\n/)
    .map(normalizeCommandLine)
    .filter(Boolean);
  return lines.length > 0 && lines.every((line) => line === normalizedCommand);
}

export function buildUnconfirmedPtyCommandError(command: string, output: string): string | null {
  if (!output.trim()) {
    return (
      `PTY_COMMAND_UNCONFIRMED: command ${JSON.stringify(command)} produced no observable output. ` +
      "Do not report success or immediately resend it; inspect PTY status/output first."
    );
  }
  if (!isOnlyPtyCommandEcho(output, command)) return null;
  return (
    `PTY_COMMAND_ECHO_ONLY: command ${JSON.stringify(command)} was only echoed by the terminal and was not confirmed as shell execution. ` +
    "The PTY may be owned by a foreground process. Do not resend it; inspect the existing process or use send_pty_input intentionally."
  );
}

const PTY_SHELL_LAUNCH_FAILURE_RE = /(?:^|\n)\s*(?:(?:zsh|bash|sh|fish):[^\n]*|(?:cd|env):[^\n]*)(?:command not found|no such file or directory|not a directory|permission denied)[^\n]*/i;

/** Detect only shell-level launch failures, not compiler/application diagnostics. */
export function buildPtyShellLaunchError(output: string): string | null {
  const match = String(output || "").match(PTY_SHELL_LAUNCH_FAILURE_RE);
  if (!match) return null;
  const detail = match[0].trim().replace(/\s+/g, " ").slice(0, 800);
  return `PTY_COMMAND_LAUNCH_FAILED: ${detail}`;
}
