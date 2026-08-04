export type RuntimeV2AcceptanceEvidenceRequirement =
  | "static"
  | "behavioral"
  | "interaction";

/** Direct Execute promises that the requested change works, not merely that
 * it parses. Structured Goal criteria may explicitly choose a static floor;
 * every unclassified or partially classified criterion defaults to behavioral
 * evidence so a build-only contract cannot silently claim user-visible work. */
export function runtimeV2ExecuteAcceptanceEvidenceRequirements(
  criteria?: readonly {
    readonly evidenceRequirement?: RuntimeV2AcceptanceEvidenceRequirement;
  }[],
): RuntimeV2AcceptanceEvidenceRequirement[] {
  if (!criteria?.length) return ["behavioral"];
  return criteria.map((criterion) =>
    criterion.evidenceRequirement || "behavioral"
  );
}
