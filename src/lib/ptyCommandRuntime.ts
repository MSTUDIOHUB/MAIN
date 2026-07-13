export interface PtyCommandRuntimeStatus {
  active: boolean;
  running: boolean;
  pid?: number | null;
  foregroundPid?: number | null;
  shellAvailable?: boolean;
}

export interface PtyCommandAdmission {
  allowed: boolean;
  reason?: string;
}

export function resolvePtyCommandAdmission(
  status: PtyCommandRuntimeStatus,
): PtyCommandAdmission {
  if (!status.active || !status.running || status.shellAvailable !== false) {
    return { allowed: true };
  }

  const shellPid = status.pid ?? "unknown";
  const foregroundPid = status.foregroundPid ?? "unknown";
  return {
    allowed: false,
    reason:
      `PTY_BUSY: integrated terminal shell pid=${shellPid} is occupied by foreground process group pid=${foregroundPid}. ` +
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
