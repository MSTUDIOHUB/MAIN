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
    ? boundedToolContent(value, Number.MAX_SAFE_INTEGER)
    : boundedToolContent(value);
}

export function runtimeV2ContextBoundToolArguments(
  toolName: string,
  args: Record<string, unknown>,
  budget?: RuntimeContextBudget | null,
): Record<string, unknown> {
  if (
    toolName !== "read_file" ||
    args.__raw === true ||
    !budget
  ) {
    return args;
  }
  const requested = Number(args.max_chars);
  const maxChars = Number.isFinite(requested) && requested > 0
    ? Math.min(Math.floor(requested), budget.readWindowChars)
    : budget.readWindowChars;
  return {
    ...args,
    max_chars: maxChars,
  };
}
