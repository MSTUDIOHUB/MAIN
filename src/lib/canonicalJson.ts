/** Stable property order with the same optional-field semantics as durable
 * JSON: omit undefined object values, and encode absent array items as null. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${Array.from(value, entry => canonicalJson(entry) ?? "null").join(",")}]`;
  if (!value || typeof value !== "object") return JSON.stringify(value);
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(",")}}`;
}
