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

const PATH_LIST_ARGUMENT_NAMES = new Set([
  "allowed_paths",
  "required_paths",
]);

const SHELL_EXECUTION_TOOL_NAMES = new Set([
  "run_command",
  "execute_command",
]);

export interface ToolCallSchemaHint {
  readonly properties?: Record<string, { readonly type?: string }>;
  readonly required?: ReadonlySet<string> | readonly string[];
}

const FALLBACK_SPILLED_PARAMETER_KEYS = new Set([
  "planMarkdown",
  "changes",
  "validations",
  "questions",
  "title",
  "markdown",
  "path",
  "content",
  "search_text",
  "replace_text",
  "command",
]);

function escapeNormalizationRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripTrailingParameterMarkup(value: string, key: string): string {
  const escapedKey = escapeNormalizationRegExp(key);
  return value
    .replace(
      new RegExp(
        `(?:\\r?\\n|[ \\t])*(?:</${escapedKey}>|\\*/${escapedKey}\\*|</parameter>|</arg_value>)\\s*$`,
        "i",
      ),
      "",
    )
    .replace(/(?:\r?\n|[ \t])*(?:<\/parameter>|<\/arg_value>)\s*$/i, "")
    .trimEnd();
}

function parseSpilledParameterSegment(
  key: string,
  rawSegment: string,
  schema?: ToolCallSchemaHint,
): unknown {
  const cleaned = stripTrailingParameterMarkup(rawSegment, key).trim();
  const targetType = schema?.properties?.[key]?.type;
  if (targetType !== "string" && (cleaned.startsWith("[") || cleaned.startsWith("{"))) {
    try {
      return JSON.parse(cleaned);
    } catch {
      // Keep raw cleaned text so downstream schema/compiler errors surface intact.
    }
  }
  return cleaned;
}

function hasAssignedArgument(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

/**
 * Recovers tool parameters when a native/XML tool stream leaves closing-tag
 * drift or spills subsequent parameter segments into an earlier string field.
 */
export function recoverSpilledXmlToolArguments(
  toolName: string,
  args: Record<string, unknown>,
  schema?: ToolCallSchemaHint,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...(args || {}) };
  const schemaProperties = schema?.properties;
  const isKnownKey = (key: string) =>
    schemaProperties && Object.keys(schemaProperties).length > 0
      ? Object.prototype.hasOwnProperty.call(schemaProperties, key)
      : FALLBACK_SPILLED_PARAMETER_KEYS.has(key);

  const spilledTagPattern =
    /<(?:parameter=|parameter\s+name=["']|arg_key>)([A-Za-z_][A-Za-z0-9_]*)(?:["']\s*>|\s*>|<\/arg_key>\s*(?:<arg_value>)?)/gi;

  for (const [currentKey, rawValue] of Object.entries(next)) {
    if (typeof rawValue !== "string" || !rawValue) continue;
    spilledTagPattern.lastIndex = 0;
    const matches: Array<{ key: string; start: number; end: number }> = [];
    let match: RegExpExecArray | null;
    while ((match = spilledTagPattern.exec(rawValue)) !== null) {
      const candidateKey = String(match[1] || "").trim();
      if (!candidateKey || candidateKey === currentKey || !isKnownKey(candidateKey)) continue;
      matches.push({
        key: candidateKey,
        start: match.index,
        end: match.index + match[0].length,
      });
    }
    if (matches.length > 0) {
      next[currentKey] = stripTrailingParameterMarkup(
        rawValue.slice(0, matches[0]!.start),
        currentKey,
      );
      for (let i = 0; i < matches.length; i += 1) {
        const entry = matches[i]!;
        const segmentEnd = matches[i + 1]?.start ?? rawValue.length;
        if (!hasAssignedArgument(next[entry.key])) {
          next[entry.key] = parseSpilledParameterSegment(
            entry.key,
            rawValue.slice(entry.end, segmentEnd),
            schema,
          );
        }
      }
    }
  }

  const requiredKeys = schema?.required ? [...schema.required] : [];
  for (const [currentKey, rawValue] of Object.entries(next)) {
    if (typeof rawValue !== "string" || !rawValue) continue;
    const escapedKey = escapeNormalizationRegExp(currentKey);
    const tailJsonPattern = new RegExp(
      `(?:\\r?\\n|[ \\t])*(?:</${escapedKey}>|\\*/${escapedKey}\\*)\\s*(\\[[\\s\\S]*\\]|\\{[\\s\\S]*\\})\\s*$`,
      "i",
    );
    const tailMatch = rawValue.match(tailJsonPattern);
    if (tailMatch && tailMatch[1]) {
      try {
        const parsed = JSON.parse(tailMatch[1]);
        const expectedType = Array.isArray(parsed)
          ? "array"
          : parsed && typeof parsed === "object"
            ? "object"
            : null;
        if (expectedType) {
          const targetKey =
            requiredKeys.find((candidateKey) =>
              candidateKey !== currentKey &&
              !hasAssignedArgument(next[candidateKey]) &&
              schemaProperties?.[candidateKey]?.type === expectedType
            ) ||
            (toolName === "submit_runtime_v2_work_plan" &&
              expectedType === "array" &&
              !hasAssignedArgument(next.changes) &&
              !hasAssignedArgument(next.changesJson)
              ? "changes"
              : undefined);
          if (targetKey) {
            next[targetKey] = parsed;
            next[currentKey] = rawValue.slice(0, tailMatch.index).trimEnd();
            continue;
          }
        }
      } catch {
        // Ignore non-JSON tail segments.
      }
    }
    const stripped = stripTrailingParameterMarkup(rawValue, currentKey);
    if (stripped !== rawValue) {
      next[currentKey] = stripped;
    }
  }

  return next;
}

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

function relativizeWorkspacePrefixesInPathList(
  value: string,
  workspace?: string | null,
): string {
  const normalizedValue = value.replace(/\\/g, "/");
  const normalizedWorkspace = String(workspace || "")
    .replace(/\\/g, "/")
    .replace(/\/+$/g, "");
  if (!normalizedWorkspace) return normalizedValue;
  const escapedWorkspace = normalizedWorkspace.replace(
    /[.*+?^${}()|[\]\\]/g,
    "\\$&",
  );
  const workspaceEntry = new RegExp(
    `(^|[,\\n]\\s*|["']\\s*)${escapedWorkspace}(?:(\\/)|(?=\\s*(?:$|[,\\n"'])))`,
    "g",
  );
  return normalizedValue.replace(
    workspaceEntry,
    (_match, entryPrefix: string, trailingSlash: string | undefined) =>
      `${entryPrefix}${trailingSlash ? "" : "."}`,
  );
}

function normalizePathListValue(value: string, workspace?: string | null): string {
  const seen = new Set<string>();
  return relativizeWorkspacePrefixesInPathList(value, workspace)
    .split(/[\n,]/)
    .map((entry) =>
      normalizePathValue(entry.trim().replace(/\\/g, "/"), workspace)
        .replace(/^\.\//, "")
        .replace(/\/+$/g, "")
    )
    .filter((entry) => {
      if (!entry || seen.has(entry)) return false;
      seen.add(entry);
      return true;
    })
    .join(",");
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
  schema?: ToolCallSchemaHint,
): Record<string, unknown> {
  const executionArgs = recoverSpilledXmlToolArguments(
    toolName,
    args || {},
    schema,
  );
  if (toolName === "replace_in_file") {
    executionArgs.path ??=
      executionArgs.target ??
      executionArgs.file_path ??
      executionArgs.file;
    executionArgs.search_text ??=
      executionArgs.old_content ??
      executionArgs.old_text ??
      executionArgs.oldString ??
      executionArgs.search;
    executionArgs.replace_text ??=
      executionArgs.new_content ??
      executionArgs.new_text ??
      executionArgs.newString ??
      executionArgs.replace;
    for (const alias of [
      "target",
      "file_path",
      "file",
      "old_content",
      "old_text",
      "oldString",
      "search",
      "new_content",
      "new_text",
      "newString",
      "replace",
    ]) {
      delete executionArgs[alias];
    }
  }

  const normalized: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(executionArgs)) {
    if (value === undefined || value === null) continue;
    normalized[key] =
      toolName === "spawn_subagent" &&
        PATH_LIST_ARGUMENT_NAMES.has(key) &&
        typeof value === "string"
        ? normalizePathListValue(value, workspace)
        : normalizeScalarArgument(key, value, workspace);
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
