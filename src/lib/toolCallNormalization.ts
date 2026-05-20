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

  return normalized;
}
