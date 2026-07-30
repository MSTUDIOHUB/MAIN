import type { RuntimeContextBudget } from "../../lib/runtimeContextBudget";

export function stringValue(value: unknown, max = 24_000): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

export function boundedToolContent(value: unknown, max = 12_000): string {
  const raw = typeof value === "string"
    ? value
    : JSON.stringify(value, null, 2);
  const text = String(raw || "").trim();
  return text.length <= max
    ? text
    : `${text.slice(0, max - 80)}\n[Runtime v2 truncated this tool result for context safety.]`;
}

/**
 * Source text is not a command-result envelope. In particular, a JSON source
 * file may legitimately contain stdout/error/exitCode keys, and whitespace at
 * either boundary is part of the file. Keep the exact string returned by the
 * read_file window contract; that contract owns its own admission bound.
 */
export function runtimeV2SourceToolContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  return JSON.stringify(value, null, 2);
}

/** `read_file` already enforces the Run's admitted window before returning
 * its version/range envelope. Truncating that envelope a second time makes
 * its returnedLines metadata untrue and can trap the model in rereads.
 * Other tool classes retain their own bounded diagnostic limit. */
export function boundedRuntimeV2ToolContent(
  toolName: string,
  value: unknown,
  _budget?: RuntimeContextBudget | null,
): string {
  return toolName === "read_file"
    ? runtimeV2SourceToolContent(value)
    : boundedToolContent(value);
}

export function runtimeV2ContextBoundToolArguments(
  toolName: string,
  args: Record<string, unknown>,
  budget?: RuntimeContextBudget | null,
  options: {
    readonly parallelReadCount?: number;
  } = {},
): Record<string, unknown> {
  if (
    toolName !== "read_file" ||
    args.__raw === true ||
    !budget
  ) {
    return args;
  }
  const parallelReadCount = Math.max(
    1,
    Math.floor(Number(options.parallelReadCount) || 1),
  );
  const sharedReadWindowChars = Math.max(
    1,
    Math.floor(budget.readWindowChars / parallelReadCount),
  );
  const requested = Number(args.max_chars);
  const maxChars = Number.isFinite(requested) && requested > 0
    ? Math.min(Math.floor(requested), sharedReadWindowChars)
    : sharedReadWindowChars;
  return {
    ...args,
    max_chars: maxChars,
  };
}

export function runtimeV2ParallelReadCount(
  calls: readonly { readonly name: string }[],
): number {
  return Math.max(
    1,
    calls.filter((call) => call.name === "read_file").length,
  );
}
