import type { RuntimeV2EvidenceReference } from "./contracts";

function normalizedEvidenceTarget(target: string): string {
  return String(target || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/\/+$/, "");
}

function evidenceFactKey(evidence: RuntimeV2EvidenceReference): string {
  const isVersionedSourceReplay =
    evidence.kind === "source" &&
    Boolean(evidence.version);
  const identity = isVersionedSourceReplay
    ? ""
    : evidence.id;
  return [
    evidence.kind,
    identity,
    normalizedEvidenceTarget(evidence.target),
    evidence.version || "",
  ].join("\u0000");
}

/**
 * Preserve every canonical ledger receipt while counting an exact replay of
 * the same versioned source once in user-facing diagnostics and summaries.
 * Tool, child, user, mutation, validation, and unversioned source receipts
 * keep their own identities because equal targets do not imply equal facts.
 */
export function distinctRuntimeV2EvidenceFacts(
  evidence: readonly RuntimeV2EvidenceReference[],
): readonly RuntimeV2EvidenceReference[] {
  const seen = new Set<string>();
  const distinct: RuntimeV2EvidenceReference[] = [];
  for (const item of evidence) {
    const key = evidenceFactKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    distinct.push(item);
  }
  return distinct;
}

export function countDistinctRuntimeV2EvidenceFacts(
  evidence: readonly RuntimeV2EvidenceReference[],
): number {
  return distinctRuntimeV2EvidenceFacts(evidence).length;
}
