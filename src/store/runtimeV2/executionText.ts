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
