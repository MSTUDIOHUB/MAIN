import type { RuntimeV2EvidenceReference } from "../../lib/runtime-v2";
import type { ToolDefinition } from "../../lib/toolSchemas";

export const SUBMIT_RUNTIME_V2_SUBAGENT_REPORT_TOOL_NAME =
  "submit_runtime_v2_subagent_report";

function availableEvidenceIds(input: {
  readonly evidence: readonly RuntimeV2EvidenceReference[];
  readonly inheritedEvidence: readonly RuntimeV2EvidenceReference[];
}): string[] {
  return [...new Set([
    ...input.evidence,
    ...input.inheritedEvidence,
  ].map((entry) => entry.id))];
}

/** One effect-free report submission surface, created only after Runtime has
 * rejected an uncited ordinary final. The model still has to select real ids;
 * Runtime never promotes all available evidence on its behalf. */
export function runtimeV2ChildReportTool(input: {
  readonly evidence: readonly RuntimeV2EvidenceReference[];
  readonly inheritedEvidence: readonly RuntimeV2EvidenceReference[];
}): ToolDefinition | null {
  const evidenceIds = availableEvidenceIds(input);
  if (evidenceIds.length === 0) return null;
  return {
    type: "function",
    function: {
      name: SUBMIT_RUNTIME_V2_SUBAGENT_REPORT_TOOL_NAME,
      description:
        "Submit the final evidence-linked child report. This has no workspace effect. Select only exact evidence IDs actually supporting each finding.",
      parameters: {
        type: "object",
        properties: {
          summary: {
            type: "string",
            description: "One concise final summary of the bounded child task.",
          },
          findings: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              properties: {
                statement: { type: "string" },
                evidence_ids: {
                  type: "array",
                  minItems: 1,
                  items: { type: "string", enum: evidenceIds },
                },
              },
              required: ["statement", "evidence_ids"],
            },
          },
          unresolved: {
            type: "array",
            items: { type: "string" },
            description: "Remaining bounded unknowns, or an empty array.",
          },
        },
        required: ["summary", "findings", "unresolved"],
      },
    },
  };
}

/**
 * A child ordinary final is not a completed report until it explicitly cites
 * evidence that the child really observed (or inherited as a review child).
 * Runtime returns the exact finite citation surface but never manufactures a
 * citation or silently promotes prose into evidence.
 */
export function runtimeV2ChildReportRejectedFeedback(input: {
  readonly evidence: readonly RuntimeV2EvidenceReference[];
  readonly inheritedEvidence: readonly RuntimeV2EvidenceReference[];
}): string {
  const evidenceIds = availableEvidenceIds(input);
  return [
    "CHILD_REPORT_REJECTED: the ordinary final did not form a valid evidence-linked child report.",
    evidenceIds.length > 0
      ? `Available exact evidence IDs: ${evidenceIds.join(", ")}.`
      : "No evidence ID is available yet.",
    evidenceIds.length > 0
      ? `The next request exposes only ${SUBMIT_RUNTIME_V2_SUBAGENT_REPORT_TOOL_NAME}. Call it exactly once and select the relevant IDs in findings[].evidence_ids.`
      : "Make one genuinely new allowed observation before concluding.",
    "Runtime will not infer or add citations. An invalid report submission closes this child for parent takeover.",
  ].join(" ");
}
