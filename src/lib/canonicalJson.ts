/** Stable property order with the same optional-field semantics as durable
 * JSON: omit undefined object values, and encode absent array items as null. */
export function canonicalJson(value: unknown): string {
  return canonicalJsonWithEncodedObjects(value);
}

export function canonicalJsonWithEncodedObjects(value: unknown, encoded?: WeakMap<object, string>): string {
  if (!value || typeof value !== "object") return JSON.stringify(value);
  const prior = encoded?.get(value);
  if (prior !== undefined) return prior;
  if (Array.isArray(value)) return `[${Array.from(value, entry => canonicalJsonWithEncodedObjects(entry, encoded) ?? "null").join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJsonWithEncodedObjects(entry, encoded)}`)
    .join(",")}}`;
}
