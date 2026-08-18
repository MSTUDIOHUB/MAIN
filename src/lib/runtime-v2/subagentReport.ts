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

const EVIDENCE_ID_ATOM = /[A-Za-z0-9_]/;
const EVIDENCE_ID_CONNECTOR = /[.:/-]/;

function evidenceIdContinuesAt(
  value: string,
  index: number,
  direction: -1 | 1,
): boolean {
  if (index < 0 || index >= value.length) return false;
  if (EVIDENCE_ID_ATOM.test(value[index]!)) return true;
  if (!EVIDENCE_ID_CONNECTOR.test(value[index]!)) return false;
  let cursor = index;
  while (
    cursor >= 0 &&
    cursor < value.length &&
    EVIDENCE_ID_CONNECTOR.test(value[cursor]!)
  ) {
    cursor += direction;
  }
  return cursor >= 0 &&
    cursor < value.length &&
    EVIDENCE_ID_ATOM.test(value[cursor]!);
}

function explicitlyReferencesEvidenceId(
  value: string,
  evidenceId: string,
): boolean {
  if (!evidenceId) return false;
  let index = value.indexOf(evidenceId);
  while (index >= 0) {
    const before = index - 1;
    const after = index + evidenceId.length;
    if (
      !evidenceIdContinuesAt(value, before, -1) &&
      !evidenceIdContinuesAt(value, after, 1)
    ) {
      return true;
    }
    index = value.indexOf(evidenceId, index + evidenceId.length);
  }
  return false;
}

/** Compile a child-authored report only when every cited id belongs either to
 * an actual successful child observation or to versioned parent evidence that
 * was explicitly handed to a review child. Keeping the two collections
 * separate prevents inherited context from being counted as child output. */
export function compileRuntimeV2SubagentReport(input: {
  readonly draft: unknown;
  readonly evidence: readonly RuntimeV2EvidenceReference[];
  readonly inheritedEvidence?: readonly RuntimeV2EvidenceReference[];
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
    [...input.evidence, ...(input.inheritedEvidence || [])]
      .map((evidence) => evidence.id),
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

/** Convert ordinary child final text into the structured report boundary.
 * Runtime may only attach ids that the child actually named in that text; it
 * must never manufacture adoption by citing every item that happened to be
 * available in the context capsule. */
export function compileRuntimeV2SubagentTextReport(input: {
  readonly summary: string;
  readonly evidence: readonly RuntimeV2EvidenceReference[];
  readonly inheritedEvidence?: readonly RuntimeV2EvidenceReference[];
}): RuntimeV2SubagentReportV1 {
  const citedEvidence = [
    ...input.evidence,
    ...(input.inheritedEvidence || []),
  ].filter((evidence) =>
    explicitlyReferencesEvidenceId(input.summary, evidence.id)
  );
  return compileRuntimeV2SubagentReport({
    draft: {
      summary: input.summary,
      findings: [{
        statement: input.summary,
        evidence_ids: citedEvidence.map((evidence) => evidence.id),
      }],
      unresolved: [],
    },
    evidence: input.evidence,
    inheritedEvidence: input.inheritedEvidence,
  });
}

export function validateRuntimeV2SubagentReport(input: {
  readonly report: RuntimeV2SubagentReportV1 | null | undefined;
  readonly evidence: readonly RuntimeV2EvidenceReference[];
  readonly inheritedEvidence?: readonly RuntimeV2EvidenceReference[];
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
      inheritedEvidence: input.inheritedEvidence,
    });
    return JSON.stringify(rebuilt) === JSON.stringify(input.report);
  } catch {
    return false;
  }
}
