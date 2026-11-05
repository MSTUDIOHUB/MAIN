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

function text(value: unknown): string {
  return typeof value === "string"
    ? value.replace(/\r\n?/g, "\n").trim()
    : "";
}

function strings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(
    value.map((entry) => text(entry)).filter(Boolean),
  )];
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

export function explicitlyReferencesEvidenceId(
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

const SOURCE_PATH_REFERENCE_DELIMITER = /[\s`"'<>，。；：！？、\p{Ps}\p{Pe}\p{Pi}\p{Pf}]/u;
const SOURCE_PATH_SENTENCE_PUNCTUATION = /[.,;:!?]/u;

function sourcePathHasReferenceBoundary(
  value: string,
  index: number,
  direction: -1 | 1,
): boolean {
  let cursor = index;
  while (cursor >= 0 && cursor < value.length) {
    const character = value[cursor]!;
    if (SOURCE_PATH_REFERENCE_DELIMITER.test(character)) return true;
    if (!SOURCE_PATH_SENTENCE_PUNCTUATION.test(character)) return false;
    cursor += direction;
  }
  return true;
}

function explicitlyReferencesSourcePath(value: string, path: string): boolean {
  let index = value.indexOf(path);
  while (index >= 0) {
    if (
      sourcePathHasReferenceBoundary(value, index - 1, -1) &&
      sourcePathHasReferenceBoundary(value, index + path.length, 1)
    ) return true;
    index = value.indexOf(path, index + path.length);
  }
  return false;
}

/** A source-path citation is only an alias for an existing, versioned receipt.
 * The caller projects successful source reads; generic observations and parent
 * context cannot acquire source provenance merely by having a path-like target. */
function citedSourceEvidenceIds(input: {
  readonly summary: string;
  readonly evidence: readonly RuntimeV2EvidenceReference[];
  readonly sourceEvidence?: readonly RuntimeV2EvidenceReference[];
}): ReadonlySet<string> {
  const sources = new Map<string, RuntimeV2EvidenceReference[]>();
  for (const source of input.sourceEvidence || []) {
    if (!source.target || !input.evidence.some((item) =>
      item.id === source.id && item.kind === source.kind &&
      item.target === source.target && item.version === source.version
    )) continue;
    const receipts = sources.get(source.target) || [];
    receipts.push(source);
    sources.set(source.target, receipts);
  }
  const ids = new Set<string>();
  for (const [path, receipts] of sources) {
    if (
      receipts.every((item) => Boolean(item.version)) &&
      new Set(receipts.map((item) => item.version)).size === 1 &&
      explicitlyReferencesSourcePath(input.summary, path)
    ) ids.add(receipts[0]!.id);
  }
  return ids;
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
  const summary = text(draft.summary);
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
  const findings = draft.findings.map((value, index) => {
    const finding =
      value && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {};
    const statement = text(finding.statement);
    const evidenceIds = strings(
      finding.evidence_ids ?? finding.evidenceIds,
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
    unresolved: strings(draft.unresolved),
  };
}

/** Convert ordinary child final text into the structured report boundary.
 * An exact source path may identify an actual successful source-read receipt;
 * otherwise the child must name the exact id. Never attach every available
 * observation or turn inherited context into child-produced evidence. */
export function compileRuntimeV2SubagentTextReport(input: {
  readonly summary: string;
  readonly evidence: readonly RuntimeV2EvidenceReference[];
  readonly inheritedEvidence?: readonly RuntimeV2EvidenceReference[];
  readonly sourceEvidence?: readonly RuntimeV2EvidenceReference[];
}): RuntimeV2SubagentReportV1 {
  const sourceIds = citedSourceEvidenceIds(input);
  const citedEvidence = [
    ...input.evidence,
    ...(input.inheritedEvidence || []),
  ].filter((evidence) =>
    explicitlyReferencesEvidenceId(input.summary, evidence.id) ||
    sourceIds.has(evidence.id)
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

/** JSON persistence may reorder object keys. Compare their complete structure
 * while retaining array order and rejecting extra fields or normalized values. */
function sameReportValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (
    !left || !right || typeof left !== "object" || typeof right !== "object" ||
    Array.isArray(left) !== Array.isArray(right) ||
    (Array.isArray(left) && Array.isArray(right) && left.length !== right.length)
  ) return false;
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const keys = Object.keys(leftRecord);
  return keys.length === Object.keys(rightRecord).length && keys.every((key) =>
    Object.prototype.hasOwnProperty.call(rightRecord, key) &&
    sameReportValue(leftRecord[key], rightRecord[key])
  );
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
    return sameReportValue(rebuilt, input.report);
  } catch {
    return false;
  }
}
