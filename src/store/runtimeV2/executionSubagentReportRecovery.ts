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

/** Legacy adapter compatibility schema. The live child loop does not expose
 * a report-only repair phase: it accepts ordinary cited final text or returns
 * incomplete work to the parent. Callers of this compatibility surface still
 * select real ids; Runtime never promotes all available evidence for them. */
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
