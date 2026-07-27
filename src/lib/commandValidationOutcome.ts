export type FailedFiniteValidationOutcome =
  | "invocation_error"
  | "validation_failure";

interface StructuredCommandResult {
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}

function compactCommandOutputField(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const marker = `\n...[${value.length - maxChars} chars omitted]...\n`;
  const remaining = Math.max(0, maxChars - marker.length);
  const head = Math.ceil(remaining * 0.65);
  const tail = Math.max(0, remaining - head);
  return `${value.slice(0, head)}${marker}${tail > 0 ? value.slice(-tail) : ""}`;
}

function parseStructuredCommandResult(value: string): StructuredCommandResult | null {
  try {
    const parsed = JSON.parse(String(value || ""));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    const rawExitCode = record.exitCode ?? record.exit_code ?? record.code ?? record.status;
    return {
      exitCode: typeof rawExitCode === "number" ? rawExitCode : null,
      timedOut: record.timedOut === true || record.timed_out === true,
      stdout: typeof record.stdout === "string" ? record.stdout : "",
      stderr: typeof record.stderr === "string"
        ? record.stderr
        : typeof record.error === "string" ? record.error : "",
    };
  } catch {
    return null;
  }
}

/**
 * Preserve the meaning of a successful finite validation across model-context
 * compaction. The receipt favors the tail because test runners and acceptance
 * harnesses conventionally print their semantic conclusion last, while still
 * retaining a small prefix for command/tool context.
 */
export function summarizeSuccessfulValidationObservation(
  value: string,
  maxChars = 1_200,
): string {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const structured = parseStructuredCommandResult(raw);
  const observation = structured
    ? [structured.stdout, structured.stderr].map((entry) => entry.trim()).filter(Boolean).join("\n")
    : raw;
  const normalized = observation
    .replace(
      // eslint-disable-next-line no-control-regex
      /\u001b\[[0-?]*[ -/]*[@-~]/g,
      "",
    )
    .replace(/\u0000/g, "")
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/\s+/g, " "))
    .filter(Boolean)
    .join("\n")
    .trim();
  const budget = Math.max(160, Math.floor(Number(maxChars) || 1_200));
  if (normalized.length <= budget) return normalized;
  const marker = `\n...[${normalized.length - budget} chars omitted]...\n`;
  const remaining = Math.max(0, budget - marker.length);
  const head = Math.floor(remaining * 0.35);
  const tail = Math.max(0, remaining - head);
  return `${normalized.slice(0, head)}${marker}${normalized.slice(-tail)}`;
}

// These are shell/toolchain protocol markers, not model-authored prose. Keep
// the set deliberately narrow: ambiguous test/build/typecheck output defaults
// to a real validation failure so MAIN never escapes through a weaker check.
const INVOCATION_PROTOCOL_MARKER_RE = /\b(?:ENOENT|EACCES|EPERM|ERR_PNPM_NO_SCRIPT)\b|\bMissing script\s*:|\bCommand\s+["'][^"']+["']\s+not found\b|\bScript not found\b|\bCouldn't find a script named\b|\bUnknown command\b|\b(?:unknown|unrecognized|invalid) option\b/i;
const SHELL_INVOCATION_MARKER_RE =
  /(?:^|\n)\s*(?:(?:\/(?:usr\/)?bin\/)?(?:sh|bash|zsh|dash|fish|ksh|csh|tcsh|pwsh)|env):[^\n]*(?:command not found|(?::|\s)not found|no such file or directory)\s*(?=$|\n)/im;

function hasInvocationProtocolMarker(value: string): boolean {
  return INVOCATION_PROTOCOL_MARKER_RE.test(value) ||
    SHELL_INVOCATION_MARKER_RE.test(value);
}

/**
 * Split command-launch/configuration failures from failures produced by a
 * validation that actually ran. Only the former may switch to a different
 * finite command; every ambiguous non-zero result remains a validation
 * failure and must reopen the normal repair surface.
 */
export function classifyFailedFiniteValidationOutcome(input: {
  result: string;
  isToolError?: boolean;
  lifecycleState?: string;
}): FailedFiniteValidationOutcome {
  const structured = parseStructuredCommandResult(input.result);
  if (structured) {
    // A timeout proves that the command started. It may be a hung test/build,
    // so keep it on the real validation-failure path instead of escaping to a
    // different command.
    if (structured.timedOut) return "validation_failure";
    // POSIX 126/127 mean that the shell could not invoke the requested
    // command. Other exit codes are tool-owned and therefore ambiguous.
    if (structured.exitCode === 126 || structured.exitCode === 127) {
      return "invocation_error";
    }
    if (hasInvocationProtocolMarker(`${structured.stdout}\n${structured.stderr}`)) {
      return "invocation_error";
    }
    return "validation_failure";
  }

  if (
    input.isToolError ||
    input.lifecycleState === "blocked" ||
    input.lifecycleState === "declined"
  ) {
    return "invocation_error";
  }

  return hasInvocationProtocolMarker(String(input.result || ""))
    ? "invocation_error"
    : "validation_failure";
}

/**
 * Keep run_command's exit metadata parseable after context truncation. Raw
 * prefix truncation can cut JSON inside stdout and hide the trailing exitCode,
 * which would turn a real build/test failure into apparent success evidence.
 */
export function compactStructuredCommandResult(value: string, maxChars: number): string {
  const raw = String(value || "");
  if (raw.length <= maxChars) return raw;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return raw.slice(0, maxChars);
    }
    const record = parsed as Record<string, unknown>;
    if (
      typeof record.stdout !== "string" ||
      typeof record.stderr !== "string" ||
      typeof (record.exitCode ?? record.exit_code) !== "number"
    ) {
      return raw.slice(0, maxChars);
    }

    // JSON escaping can roughly double captured output. Reserve half of the
    // requested envelope for escaped stdout/stderr and keep both head + tail.
    const outputBudget = Math.max(400, Math.floor((maxChars - 800) / 2));
    const totalOutputChars = record.stdout.length + record.stderr.length;
    const stdoutBudget = totalOutputChars > 0
      ? Math.max(100, Math.floor(outputBudget * (record.stdout.length / totalOutputChars)))
      : 100;
    const stderrBudget = Math.max(100, outputBudget - stdoutBudget);
    let compacted = JSON.stringify({
      ...record,
      stdout: compactCommandOutputField(record.stdout, stdoutBudget),
      stderr: compactCommandOutputField(record.stderr, stderrBudget),
    });
    if (compacted.length > maxChars) {
      compacted = JSON.stringify({
        command: record.command,
        stdout: compactCommandOutputField(record.stdout, Math.max(80, Math.floor(maxChars / 6))),
        stderr: compactCommandOutputField(record.stderr, Math.max(80, Math.floor(maxChars / 6))),
        exitCode: record.exitCode ?? record.exit_code,
        timedOut: record.timedOut ?? record.timed_out,
        durationMs: record.durationMs ?? record.duration_ms,
        success: record.success,
        stdoutTruncated: true,
        stderrTruncated: true,
      });
    }
    if (compacted.length <= maxChars) return compacted;
    return JSON.stringify({
      command: record.command,
      stdout: "[output omitted; structured command envelope preserved]",
      stderr: "[output omitted; structured command envelope preserved]",
      exitCode: record.exitCode ?? record.exit_code,
      timedOut: record.timedOut ?? record.timed_out,
      durationMs: record.durationMs ?? record.duration_ms,
      success: record.success,
      stdoutTruncated: true,
      stderrTruncated: true,
    });
  } catch {
    return raw.slice(0, maxChars);
  }
}
