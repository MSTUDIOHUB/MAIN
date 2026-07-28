import type { RuntimeV2EvidenceReference } from "./contracts";

export const RUNTIME_V2_SUBAGENT_REPORT_SCHEMA_VERSION =
  "runtime-v2-subagent-report.v1" as const;

export interface RuntimeV2SubagentFindingV1 {
  readonly statement: string;
  readonly evidenceIds: readonly string[];
}

export interface RuntimeV2SubagentReportV1 {
  readonly schemaVersion:
    typeof RUNTIME_V2_SUBAGENT_REPORT_SCHEMA_VERSION;
  readonly summary: string;
  readonly findings: readonly RuntimeV2SubagentFindingV1[];
  readonly unresolved: readonly string[];
}

function text(value: unknown, max: number): string {
  return typeof value === "string"
    ? value.replace(/\r\n?/g, "\n").trim().slice(0, max)
    : "";
}

function strings(value: unknown, max: number, itemMax: number): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(
    value.map((entry) => text(entry, itemMax)).filter(Boolean),
  )].slice(0, max);
}

/** Compile a child-authored report only when every cited id belongs to an
 * actual successful child observation. Prose and path mentions cannot invent
 * evidence or upgrade a failed child to completed. */
export function compileRuntimeV2SubagentReport(input: {
  readonly draft: unknown;
  readonly evidence: readonly RuntimeV2EvidenceReference[];
}): RuntimeV2SubagentReportV1 {
  const draft =
    input.draft && typeof input.draft === "object" &&
      !Array.isArray(input.draft)
      ? input.draft as Record<string, unknown>
      : {};
  const summary = text(draft.summary, 4_000);
  if (!summary) {
    throw new Error("RUNTIME_V2_SUBAGENT_REPORT_INVALID:summary_missing");
  }
  if (!Array.isArray(draft.findings) || draft.findings.length === 0) {
    throw new Error("RUNTIME_V2_SUBAGENT_REPORT_INVALID:findings_missing");
  }
  const realEvidenceIds = new Set(
    input.evidence.map((evidence) => evidence.id),
  );
  const findings = draft.findings.slice(0, 32).map((value, index) => {
    const finding =
      value && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {};
    const statement = text(finding.statement, 2_000);
    const evidenceIds = strings(
      finding.evidence_ids ?? finding.evidenceIds,
      24,
      256,
    );
    if (!statement || evidenceIds.length === 0) {
      throw new Error(
        `RUNTIME_V2_SUBAGENT_REPORT_INVALID:finding_incomplete:${index}`,
      );
    }
    if (evidenceIds.some((id) => !realEvidenceIds.has(id))) {
      throw new Error(
        `RUNTIME_V2_SUBAGENT_REPORT_INVALID:evidence_unknown:${index}`,
      );
    }
    return { statement, evidenceIds };
  });
  if (!Array.isArray(draft.unresolved)) {
    throw new Error(
      "RUNTIME_V2_SUBAGENT_REPORT_INVALID:unresolved_missing",
    );
  }
  return {
    schemaVersion: RUNTIME_V2_SUBAGENT_REPORT_SCHEMA_VERSION,
    summary,
    findings,
    unresolved: strings(draft.unresolved, 32, 1_000),
  };
}

export function validateRuntimeV2SubagentReport(input: {
  readonly report: RuntimeV2SubagentReportV1 | null | undefined;
  readonly evidence: readonly RuntimeV2EvidenceReference[];
}): boolean {
  if (
    !input.report ||
    input.report.schemaVersion !==
      RUNTIME_V2_SUBAGENT_REPORT_SCHEMA_VERSION
  ) {
    return false;
  }
  try {
    const rebuilt = compileRuntimeV2SubagentReport({
      draft: {
        summary: input.report.summary,
        findings: input.report.findings.map((finding) => ({
          statement: finding.statement,
          evidence_ids: finding.evidenceIds,
        })),
        unresolved: input.report.unresolved,
      },
      evidence: input.evidence,
    });
    return JSON.stringify(rebuilt) === JSON.stringify(input.report);
  } catch {
    return false;
  }
}
