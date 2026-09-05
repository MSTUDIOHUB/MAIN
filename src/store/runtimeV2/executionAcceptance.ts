import type {
  RuntimeV2AcceptanceEvidenceRequirement,
  RuntimeV2AcceptanceEvidenceRequirementSlot,
} from "../../lib/runtime-v2/contracts";

/** Preserve explicit upstream evidence classes without inventing one for a raw
 * Direct Execute request. `null` survives checkpoint JSON and is interpreted
 * by the core acceptance gate like an absent requirement: any real finite
 * validator may cover that criterion. */
export function runtimeV2ExecuteAcceptanceEvidenceRequirements(
  criteria?: readonly {
    readonly evidenceRequirement?: RuntimeV2AcceptanceEvidenceRequirement;
  }[],
): RuntimeV2AcceptanceEvidenceRequirementSlot[] {
  if (!criteria?.length) return [];
  return criteria.map((criterion) =>
    criterion.evidenceRequirement || null
  );
}
