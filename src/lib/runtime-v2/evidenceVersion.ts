import { sha256Hex } from "../sha256";

function canonicalEvidencePayload(value: unknown): string {
  if (typeof value === "string") {
    return value.replace(/\r\n?/g, "\n");
  }
  try {
    return JSON.stringify(value ?? null);
  } catch {
    return String(value ?? "");
  }
}

/**
 * A deterministic, presentation-independent version for one observed tool
 * result. Display truncation must never change the approval authority.
 */
export function runtimeV2EvidenceVersion(value: unknown): string {
  return `sha256-${sha256Hex(canonicalEvidencePayload(value))}`;
}
