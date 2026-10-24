/** A shared Editor retains Console history between independent task rounds.
 * Ignore only recorded history in the same Console epoch; current compiler
 * failure is always authoritative even if it predates the cursor. */
export function assessUnityConsole(result: any, baseline?: { session?: string; cursor?: number }) {
  const entries = result?.entries ?? result?.Entries ?? result?.logs;
  if (!Array.isArray(entries) || typeof result?.groundTruth?.compilationFailed !== "boolean") {
    throw new Error("Console entries or current compilation health could not be verified.");
  }
  const sameSession = !!baseline?.session && baseline.session === result.session;
  const cursor = Number.isFinite(baseline?.cursor) ? baseline!.cursor! : 0;
  const errors = entries.filter(entry => !sameSession || !Number.isFinite(entry.seq) || entry.seq > cursor);
  return { errors, compilationFailed: result.groundTruth.compilationFailed,
    retainedBaselineErrors: entries.length - errors.length, session: result.session };
}
