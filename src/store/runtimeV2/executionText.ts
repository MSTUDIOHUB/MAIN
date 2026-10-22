import type { RuntimeContextBudget } from "../../lib/runtimeContextBudget";
import { skillCatalogContextCharBudget } from "../../lib/agentSkills";

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
 * Command results share the Run's output window; other diagnostic tool
 * classes retain their own bounded limit. */
export function boundedRuntimeV2ToolContent(
  toolName: string,
  value: unknown,
  budget?: RuntimeContextBudget | null,
  options: { readonly parallelReadCount?: number } = {},
): string {
  if (toolName === "read_file" || toolName === "load_skill") return runtimeV2SourceToolContent(value);
  if (toolName !== "run_command") return boundedToolContent(value);
  const admitted = Math.floor(Number(budget?.readWindowChars));
  const count = Math.max(1, Math.floor(Number(options.parallelReadCount) || 1));
  const maxChars = Math.max(1, Math.floor((Number.isFinite(admitted) && admitted > 0 ? admitted : 12_000) / count));
  const text = runtimeV2SourceToolContent(value);
  if (text.length <= maxChars) return text;
  const envelope = (end: number) => JSON.stringify({
    type: "tool.result_window",
    truncated: true,
    contentFormat: "partial_text",
    totalChars: text.length,
    returnedChars: end,
    returnedRange: { startChar: 0, endChar: end },
    content: text.slice(0, end),
    continuationAvailable: false,
  });
  if (envelope(0).length > maxChars) {
    // Pathologically small batch shares may not fit even the empty JSON
    // envelope. Never exceed that share or label the fragment complete.
    return `PARTIAL_TEXT UTF16[0,0)/${text.length}`.slice(0, maxChars);
  }
  // Charge the serialized envelope, including JSON escaping, to the same
  // window. Coordinates describe the original UTF-16 text, not its escapes.
  let low = 0;
  let high = Math.min(text.length, maxChars);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (envelope(middle).length <= maxChars) low = middle;
    else high = middle - 1;
  }
  if (low > 0 && /[\uD800-\uDBFF]/.test(text[low - 1]!) && /[\uDC00-\uDFFF]/.test(text[low] || "")) low -= 1;
  return envelope(low);
}

export function runtimeV2ContextBoundToolArguments(
  toolName: string,
  args: Record<string, unknown>,
  budget?: RuntimeContextBudget | null,
  options: {
    readonly parallelReadCount?: number;
  } = {},
): Record<string, unknown> {
  if (toolName === "load_skill" && args.operation !== "list") {
    const parallelReadCount = Math.max(1, Math.floor(Number(options.parallelReadCount) || 1));
    const defaultWindow = skillCatalogContextCharBudget(budget?.contextLimit);
    const sharedWindow = budget
      ? Math.max(1, Math.floor(budget.readWindowChars / parallelReadCount))
      : defaultWindow;
    const requested = Number(args.max_chars);
    return {
      ...args,
      max_chars: Number.isFinite(requested) && requested > 0
        ? Math.min(Math.floor(requested), sharedWindow)
        : Math.min(defaultWindow, sharedWindow),
    };
  }
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
    calls.filter((call) => call.name === "read_file" || call.name === "load_skill" || call.name === "run_command").length,
  );
}
