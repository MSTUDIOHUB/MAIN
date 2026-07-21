const NUMERIC_ARGUMENT_NAMES = new Set([
  "depth",
  "start_line",
  "end_line",
  "max_lines",
  "maxBytes",
  "max_bytes",
  "max_chars",
  "offset",
  "timeout_ms",
  "timeoutMs",
  "wait_ms",
]);

const BOOLEAN_ARGUMENT_NAMES = new Set([
  "append_newline",
  "__raw",
  "screenshot",
  "fail_on_console_error",
  "failOnConsoleError",
]);

const PATH_ARGUMENT_NAMES = new Set([
  "path",
]);

const SHELL_EXECUTION_TOOL_NAMES = new Set([
  "run_command",
  "execute_command",
]);

function unwrapScalarString(value: string): string {
  let next = value
    .replace(/<\/?parameter[^>\n]*>/gi, "")
    .replace(/<\/?(?:tool|tool_use|tool_call|function_call|name)[^>\n]*>/gi, "")
    .trim();

  if (
    (next.startsWith("\"") && next.endsWith("\"")) ||
    (next.startsWith("'") && next.endsWith("'")) ||
    (next.startsWith("`") && next.endsWith("`"))
  ) {
    next = next.slice(1, -1).trim();
  }

  return next;
}

function normalizePathValue(value: string, workspace?: string | null): string {
  const clean = unwrapScalarString(value);
  if (!workspace) return clean;

  const normalizedWorkspace = workspace.replace(/\\/g, "/").replace(/\/+$/g, "");
  const normalizedPath = clean.replace(/\\/g, "/");
  if (normalizedWorkspace && normalizedPath.startsWith(`${normalizedWorkspace}/`)) {
    return normalizedPath.slice(normalizedWorkspace.length + 1);
  }
  if (normalizedPath === normalizedWorkspace) return ".";
  return clean;
}

function normalizeScalarArgument(key: string, value: unknown, workspace?: string | null): unknown {
  if (typeof value !== "string") return value;

  const clean = unwrapScalarString(value);
  if (PATH_ARGUMENT_NAMES.has(key)) return normalizePathValue(clean, workspace);

  if (NUMERIC_ARGUMENT_NAMES.has(key) && /^-?\d+(?:\.\d+)?$/.test(clean)) {
    return Number(clean);
  }

  if (BOOLEAN_ARGUMENT_NAMES.has(key) && /^(?:true|false)$/i.test(clean)) {
    return clean.toLowerCase() === "true";
  }

  return clean;
}

function normalizeSlashPath(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/{2,}/g, "/").replace(/\/$/, "");
}

/**
 * The trusted executor owns the working directory and intentionally rejects
 * shell-level `cd`. Local models nevertheless commonly prefix commands with
 * an exact workspace path. Convert only one literal, leading `cd … &&` into
 * the structured cwd field; anything dynamic, escaping, or outside the
 * workspace remains untouched and reaches the Rust safety check unchanged.
 */
function normalizeLeadingWorkspaceCd(
  command: unknown,
  cwd: unknown,
  workspace?: string | null,
): { command: string; cwd: string } | null {
  if (typeof command !== "string" || !workspace) return null;
  const match = command.match(
    /^\s*cd\s+(?:--\s+)?(?:"([^"\\]*)"|'([^']*)'|([^\s;&|]+))\s*&&\s*([\s\S]+?)\s*$/,
  );
  if (!match) return null;

  const requestedDirectory = String(match[1] ?? match[2] ?? match[3] ?? "").trim();
  const remainingCommand = String(match[4] || "").trim();
  if (!requestedDirectory || !remainingCommand || /[$`~]/.test(requestedDirectory)) return null;

  const normalizedWorkspace = normalizeSlashPath(workspace.trim());
  const currentCwd = normalizeSlashPath(typeof cwd === "string" && cwd.trim() ? cwd.trim() : ".") || ".";
  if (!normalizedWorkspace || currentCwd.startsWith("/") || currentCwd.split("/").includes("..")) return null;

  let relativeDirectory = "";
  const normalizedRequested = normalizeSlashPath(requestedDirectory);
  if (normalizedRequested.startsWith("/")) {
    if (normalizedRequested === normalizedWorkspace) {
      relativeDirectory = ".";
    } else if (normalizedRequested.startsWith(`${normalizedWorkspace}/`)) {
      relativeDirectory = normalizedRequested.slice(normalizedWorkspace.length + 1);
    } else {
      return null;
    }
  } else {
    const requestedParts = normalizedRequested.split("/").filter((part) => part && part !== ".");
    if (requestedParts.includes("..")) return null;
    relativeDirectory = [currentCwd === "." ? "" : currentCwd, ...requestedParts]
      .filter(Boolean)
      .join("/") || ".";
  }

  if (relativeDirectory.split("/").includes("..")) return null;
  return { command: remainingCommand, cwd: relativeDirectory };
}

export function normalizeToolCallForExecution(
  toolName: string,
  args: Record<string, unknown>,
  workspace?: string | null,
): Record<string, unknown> {
  const normalized: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(args || {})) {
    if (value === undefined || value === null) continue;
    normalized[key] = normalizeScalarArgument(key, value, workspace);
  }

  if (toolName === "read_file" && typeof normalized.max_lines === "string") {
    const value = normalized.max_lines.trim();
    if (/^\d+$/.test(value)) normalized.max_lines = Number(value);
  }

  if (SHELL_EXECUTION_TOOL_NAMES.has(toolName)) {
    const normalizedShell = normalizeLeadingWorkspaceCd(
      normalized.command,
      normalized.cwd ?? normalized.workdir,
      workspace,
    );
    if (normalizedShell) {
      normalized.command = normalizedShell.command;
      normalized.cwd = normalizedShell.cwd;
    }
  }

  return normalized;
}
