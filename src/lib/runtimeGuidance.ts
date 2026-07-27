import type { ActiveGuidance } from "./sessionTypes";
import {
  isSameCanonicalRunIdentity,
  normalizeCanonicalRunIdentity,
  type CanonicalRunIdentity,
} from "./turnRuntimeContract";

export const ACTIVE_GUIDANCE_SCHEMA_VERSION = 1 as const;

function finiteTimestamp(value: unknown): number | null {
  const normalized = Number(value);
  return Number.isFinite(normalized) && normalized >= 0 ? normalized : null;
}

/**
 * Parse only the exact-run contract. Legacy turn-only guidance is deliberately
 * rejected: it cannot prove ownership after a restart or same-Turn child Run.
 */
export function normalizeActiveGuidance(value: unknown): ActiveGuidance | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== ACTIVE_GUIDANCE_SCHEMA_VERSION) return null;
  const id = typeof record.id === "string" ? record.id.trim() : "";
  const text = typeof record.text === "string" ? record.text.trim() : "";
  const target = normalizeCanonicalRunIdentity(record.target);
  const createdAt = finiteTimestamp(record.createdAt);
  const consumedAt = record.consumedAt == null
    ? null
    : finiteTimestamp(record.consumedAt);
  if (!id || !text || !target || createdAt === null || consumedAt === null && record.consumedAt != null) {
    return null;
  }
  return {
    schemaVersion: ACTIVE_GUIDANCE_SCHEMA_VERSION,
    id,
    text,
    target,
    createdAt,
    consumedAt,
  };
}

export function createActiveGuidance(input: {
  id: string;
  text: string;
  target: CanonicalRunIdentity;
  createdAt: number;
}): ActiveGuidance | null {
  return normalizeActiveGuidance({
    schemaVersion: ACTIVE_GUIDANCE_SCHEMA_VERSION,
    id: input.id,
    text: input.text,
    target: input.target,
    createdAt: input.createdAt,
    consumedAt: null,
  });
}

export function isActiveGuidanceOwnedByRun(
  guidance: ActiveGuidance | null | undefined,
  run: CanonicalRunIdentity,
): boolean {
  const normalized = normalizeActiveGuidance(guidance);
  return !!normalized && isSameCanonicalRunIdentity(normalized.target, run);
}
