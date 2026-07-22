import type { AppConfig } from "./appTypes";
import type {
  AgentLoopOutcome,
  AgentMessage,
  OrchestratorCallbacks,
  ToolExecutionResult,
} from "./orchestrator/types";
import { normalizeAgentLoopOutcome } from "./runOutcome";
import {
  activateSubagentScopeLease,
  buildSubagentPolicyDeferral,
  findSubagentLeaseOverlap,
  getSubagentBurstAdmission,
  registerSubagentAbortController,
  registerCoordinatedSubagentRun,
  recordSubagentRuntimeSample,
  reportSubagentCapacityFailure,
  parseSubagentAllowedPaths,
  releaseSubagentScopeLease,
  reserveSubagentScope,
  resolveSubagentPathCoverage,
  resolveSubagentCapacityPolicy,
  unregisterSubagentAbortController,
  withSubagentCapacity,
  type SpawnSubagentRequest,
  type SpawnSubagentResult,
  type SubagentActivity,
  type SubagentPathCoverageAudit,
  type SubagentProgress,
  type SubagentRunPatch,
  type SubagentExecutionScope,
  type SubagentResultEnvelope,
  type SubagentRunSnapshot,
  type SubagentStatus,
} from "./subagents";
import { withEventSchema, type MainThreadEvent } from "./turnEvents";
import { generateId } from "./utils";
import { getFileMetadata } from "./ipc";
import {
  buildFileReadWindowIdentity,
  hashString,
} from "./orchestrator/fileReadCache";
import {
  extractPlanEvidenceFacts,
  mergePlanEvidenceFacts,
  summarizePlanEvidenceDetail,
} from "./planMaterialization";

const SUBAGENT_NAMES = ["Euler", "Mendel", "Herschel", "Noether", "Turing", "Curie"];
const SUBAGENT_EVIDENCE_TOOL_NAMES = new Set([
  "read_file",
  "read_file_window",
  "read_document",
  "get_file_outline",
  "grep_search",
  "code_ast_query",
  "find_symbol_references",
  "git_diff",
]);

type ExecuteAgentLoop = (
  callbacks: OrchestratorCallbacks,
  abortController: AbortController,
) => Promise<AgentLoopOutcome>;

function sanitizeName(value: unknown, fallbackIndex: number): string {
  const normalized = String(value || "")
    .replace(/[^A-Za-z0-9 _-]+/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 32);
  return normalized || SUBAGENT_NAMES[fallbackIndex % SUBAGENT_NAMES.length];
}

function compactText(value: unknown, maxChars: number): string {
  const text = String(value || "").trim();
  return text.length > maxChars ? `${text.slice(0, maxChars).trimEnd()}...` : text;
}

function normalizeDeclaredRemainingWorkValue(value: unknown): string {
  const normalized = String(value ?? "")
    .replace(/^[ \t]*(?:[-*_][ \t]*){3,}$/gm, "")
    .replace(/\*\*|__/g, "")
    .replace(/^[ \t]*(?:[-*]|\d+[.)、])?[ \t]*/gm, "")
    .replace(/[`~]/g, "")
    .trim();
  const contradictsNegation = /(?:但|不过|然而|可是|but|however|except).{0,80}(?:仍?需|需要|尚需|待处理|未完成|need|required|remain|pending|left)/i.test(normalized);
  const chineseNoRemainingStatement = /^(?:(?:无|没有|暂无)(?:任何)?(?:(?:剩余|后续|待办)(?:工作|任务|事项))?(?:[。.！!\s]*(?:[（(]\s*已(?:完成|检查|核实|覆盖)[^）)]*[）)]|已(?:完成|检查|核实|覆盖)[\s\S]*))?[。.！!\s]*|已(?:完成|检查|核实|覆盖)[^,，;；。\n]{0,80}[,，;；。\s]+(?:无|没有)(?:任何)?(?:剩余|后续|待办)(?:工作|任务|事项)[。.！!\s]*)$/i.test(normalized);
  const englishNoRemainingStatement = /^(?:no\s+(?:remaining|further|additional)\s+(?:work|tasks?|actions?|steps?)(?:\s+(?:is|are))?(?:\s+(?:required|needed|pending))?(?:\s+(?:within|in)\b[^.!]*)?|nothing\s+remains(?:\s+to\s+be\s+done)?)[.!\s]*$/i.test(normalized);
  const chineseLeadingNoWithCompletion =
    /^(?:无|没有|暂无)[。.！!]/.test(normalized) &&
    /(?:已[\s\S]{0,180}(?:完成|完毕|覆盖|达成)|(?:完成|覆盖)了)/.test(normalized);
  const noRemainingCompletionStatement =
    chineseNoRemainingStatement ||
    chineseLeadingNoWithCompletion ||
    englishNoRemainingStatement ||
    /^(?:无|没有|暂无)[。.！!]\s*(?:(?!但|不过|然而|可是|仍?需|需要|尚需|待处理|未完成)[\s\S]){0,240}(?:已(?:(?!未完成)[^,，;；。\n]){0,24}(?:完成|检查|核实|覆盖|达成|完毕)|目标已达成|范围已覆盖)[\s\S]*$/i.test(normalized) ||
    /^(?:none|nothing|n\/?a|not applicable)(?:(?:[.!;\s]+|\s*[—–-]\s*)(?:the\s+|all\s+)?(?:(?:requested|assigned|scoped)\s+)?(?:work|scope)?\s*(?:is\s+)?(?:complete(?:d)?|done)[\s\S]*)?[.!\s]*$/i.test(normalized);
  const explicitlyNegated = (
    /^(?:无需|不需要|no further\b|not required\b|nothing (?:else|further)\b)/i.test(normalized) ||
    noRemainingCompletionStatement
  ) && !contradictsNegation;
  if (
    !normalized ||
    explicitlyNegated ||
    /^(?:无|没有|暂无|none|nothing|n\/?a|not applicable)[。.!\s]*$/i.test(normalized)
  ) {
    return "";
  }
  return compactText(normalized, 1_000);
}

function collectRemainingWorkLeafValues(
  value: unknown,
  output: string[],
  depth: number,
): void {
  if (depth > 12 || output.length >= 32 || value === null || value === undefined) return;
  if (typeof value === "string") {
    const normalized = normalizeDeclaredRemainingWorkValue(value);
    if (normalized) output.push(normalized);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectRemainingWorkLeafValues(item, output, depth + 1);
    return;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const completionStatus = Object.entries(record).find(([key]) => (
      ["completionstatus", "state", "status"].includes(key.toLowerCase().replace(/[\s_-]+/g, ""))
    ))?.[1];
    if (/^(?:complete(?:d)?|done|finished|resolved|satisfied|closed|已完成|完成|已结束|已解决)$/i.test(
      String(completionStatus ?? "").trim(),
    )) {
      return;
    }
    const contentKeys = new Set([
      "action",
      "description",
      "item",
      "task",
      "text",
      "title",
      "work",
      "remainingwork",
      "remainingtasks",
      "remaininginscopework",
      "remainingscopedwork",
      "剩余工作",
      "剩余范围内工作",
      "剩余作用域内工作",
    ]);
    for (const [key, item] of Object.entries(record)) {
      const normalizedKey = key.toLowerCase().replace(/[\s_-]+/g, "");
      if (contentKeys.has(normalizedKey)) {
        collectRemainingWorkLeafValues(item, output, depth + 1);
      }
    }
  }
}

function collectStructuredRemainingWorkValues(
  value: unknown,
  output: string[],
  depth = 0,
  withinReport = false,
): void {
  if (depth > 12 || output.length >= 32 || value === null || value === undefined) return;
  if (Array.isArray(value)) {
    for (const item of value) {
      collectStructuredRemainingWorkValues(item, output, depth + 1, withinReport || depth === 0);
    }
    return;
  }
  if (typeof value !== "object") return;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const normalizedKey = key.toLowerCase().replace(/[\s_-]+/g, "");
    if ([
      "remainingwork",
      "remainingtasks",
      "remaininginscopework",
      "remainingscopedwork",
      "剩余工作",
      "剩余范围内工作",
      "剩余作用域内工作",
    ].includes(normalizedKey)) {
      collectRemainingWorkLeafValues(item, output, depth + 1);
      continue;
    }
    if ([
      "data",
      "evidence",
      "evidences",
      "example",
      "examples",
      "input",
      "inputs",
      "properties",
      "property",
      "raw",
      "rawdata",
      "schema",
      "schemas",
      "source",
      "sources",
      "toolresult",
      "toolresults",
    ].includes(normalizedKey)) {
      continue;
    }
    const isReportContainer = [
      "analysis",
      "conclusion",
      "conclusions",
      "finding",
      "findings",
      "output",
      "outputs",
      "report",
      "reports",
      "response",
      "result",
      "results",
      "section",
      "sections",
      "summaries",
      "summary",
      "tasks",
      "work",
    ].includes(normalizedKey);
    if (withinReport || isReportContainer) {
      collectStructuredRemainingWorkValues(item, output, depth + 1, true);
    }
  }
}

function parseStructuredSubagentSummary(summary: string): unknown {
  let candidate = String(summary || "").trim();
  const fenced = candidate.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i);
  if (fenced) {
    candidate = fenced[1].trim();
  } else if (!candidate.startsWith("{") && !candidate.startsWith("[")) {
    const jsonFences = [...candidate.matchAll(/```json\s*\n?([\s\S]*?)\n?```/gi)];
    if (jsonFences.length === 0) return null;
    candidate = jsonFences[jsonFences.length - 1][1].trim();
  }
  if (!candidate.startsWith("{") && !candidate.startsWith("[")) return null;
  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}

export function extractDeclaredSubagentRemainingWork(summary: string): string {
  const text = String(summary || "");
  const structured = parseStructuredSubagentSummary(text);
  if (structured !== null) {
    const values: string[] = [];
    collectStructuredRemainingWorkValues(structured, values);
    const uniqueValues = [...new Set(values)];
    if (uniqueValues.length > 0) return compactText(uniqueValues.join("\n"), 1_000);
  }

  const marker = /(?:^|\n)\s*(?:#{1,6}\s*)?(?:\*\*|__)?(?:剩余(?:范围内|作用域内)?工作|Remaining (?:In-Scope |Scoped )?Work)(?:\*\*|__)?\s*[:：]?[ \t]*/i.exec(text);
  if (!marker || marker.index === undefined) return "";
  const tail = text.slice(marker.index + marker[0].length);
  const section = tail.split(/\n\s*(?:#{1,6}\s+|(?:\*\*|__)[^*\n]{1,48}(?:\*\*|__)\s*[:：])/)[0] || "";
  return normalizeDeclaredRemainingWorkValue(section);
}

function hasDeclaredSubagentRemainingWorkSection(summary: string): boolean {
  const text = String(summary || "");
  if (/(?:^|\n)\s*(?:#{1,6}\s*)?(?:\*\*|__)?(?:剩余(?:范围内|作用域内)?工作|Remaining (?:In-Scope |Scoped )?Work)(?:\*\*|__)?\s*[:：]?[ \t]*/i.test(text)) {
    return true;
  }
  const structured = parseStructuredSubagentSummary(text);
  if (structured === null) return false;
  const visit = (value: unknown, depth = 0): boolean => {
    if (depth > 12 || value === null || value === undefined) return false;
    if (Array.isArray(value)) return value.some((item) => visit(item, depth + 1));
    if (typeof value !== "object") return false;
    return Object.entries(value as Record<string, unknown>).some(([key, item]) => {
      const normalizedKey = key.toLowerCase().replace(/[\s_-]+/g, "");
      if ([
        "remainingwork",
        "remainingtasks",
        "remaininginscopework",
        "remainingscopedwork",
        "剩余工作",
        "剩余范围内工作",
        "剩余作用域内工作",
      ].includes(normalizedKey)) return true;
      if (["data", "example", "examples", "input", "inputs", "properties", "schema", "schemas", "source", "sources", "toolresult", "toolresults"].includes(normalizedKey)) {
        return false;
      }
      return visit(item, depth + 1);
    });
  };
  return visit(structured);
}

export function extractDeclaredSubagentParentHandoff(summary: string): string {
  const text = String(summary || "");
  const structured = parseStructuredSubagentSummary(text);
  if (structured && typeof structured === "object") {
    const candidates: string[] = [];
    const visit = (value: unknown, depth = 0): void => {
      if (depth > 10 || value === null || value === undefined) return;
      if (Array.isArray(value)) {
        value.forEach((item) => visit(item, depth + 1));
        return;
      }
      if (typeof value !== "object") return;
      for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        const normalizedKey = key.toLowerCase().replace(/[\s_-]+/g, "");
        if (["parenthandoff", "parentdecisions", "parentfollowup", "父任务交接", "父任务确认", "父任务事项"].includes(normalizedKey)) {
          collectRemainingWorkLeafValues(item, candidates, depth + 1);
        } else {
          visit(item, depth + 1);
        }
      }
    };
    visit(structured);
    const uniqueCandidates = [...new Set(candidates)];
    if (uniqueCandidates.length > 0) return compactText(uniqueCandidates.join("\n"), 1_000);
  }

  const marker = /(?:^|\n)\s*(?:#{1,6}\s*)?(?:\*\*|__)?(?:父任务(?:交接|确认|事项)|Parent (?:Handoff|Decisions?|Follow-Up))(?:\*\*|__)?\s*[:：]?[ \t]*/i.exec(text);
  if (!marker || marker.index === undefined) return "";
  const tail = text.slice(marker.index + marker[0].length);
  const section = tail.split(/\n\s*(?:#{1,6}\s+|(?:\*\*|__)[^*\n]{1,48}(?:\*\*|__)\s*[:：])/)[0] || "";
  return normalizeDeclaredRemainingWorkValue(section);
}

const EMPTY_STRUCTURE_MESSAGE = /^\(?\s*no (?:symbols?|class|struct|type|func|function|interface|recognizable|public\/protected)[^\n]*(?:found)?\s*\)?[.!]?$/i;
const STRUCTURE_CONTAINER_KEYS = new Set([
  "children",
  "declarations",
  "items",
  "members",
  "nodes",
  "outline",
  "results",
  "symbols",
]);
const STRUCTURE_METADATA_KEYS = new Set([
  "count",
  "extension",
  "file",
  "filename",
  "language",
  "meta",
  "metadata",
  "path",
  "status",
  "success",
  "total",
]);
const STRUCTURE_DESCRIPTOR_KEYS = new Set([
  "declaration",
  "description",
  "kind",
  "label",
  "name",
  "signature",
  "text",
  "type",
]);

function isEmptyParsedStructureValue(value: unknown, nestedRecord = false): boolean {
  if (value === null || value === undefined || typeof value === "boolean" || typeof value === "number") {
    return true;
  }
  if (typeof value === "string") {
    const text = value.trim();
    return !text || /^(?:null|undefined|none|n\/?a)$/i.test(text) || EMPTY_STRUCTURE_MESSAGE.test(text);
  }
  if (Array.isArray(value)) {
    return value.length === 0 || value.every((item) => isEmptyParsedStructureValue(item, true));
  }

  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return true;
  const normalizedEntries = entries.map(([key, item]) => [
    key.toLowerCase().replace(/[\s_-]+/g, ""),
    item,
  ] as const);
  const structuralValues = normalizedEntries
    .filter(([key]) => STRUCTURE_CONTAINER_KEYS.has(key))
    .map(([, item]) => item);
  if (structuralValues.length > 0) {
    return structuralValues.every((item) => isEmptyParsedStructureValue(item, true));
  }
  if (nestedRecord && normalizedEntries.some(([key, item]) => (
    STRUCTURE_DESCRIPTOR_KEYS.has(key) && !isEmptyParsedStructureValue(item, true)
  ))) {
    return false;
  }
  const contentValues = normalizedEntries
    .filter(([key]) => !STRUCTURE_METADATA_KEYS.has(key))
    .map(([, item]) => item);
  return contentValues.length === 0 || contentValues.every((item) => (
    isEmptyParsedStructureValue(item, true)
  ));
}

export function isEmptySubagentStructureObservation(value: unknown): boolean {
  const text = String(value ?? "").trim();
  if (!text || /^(?:null|undefined|none|n\/?a|\[\]|\{\})$/i.test(text)) return true;
  if (EMPTY_STRUCTURE_MESSAGE.test(text)) return true;
  if (!text.startsWith("{") && !text.startsWith("[")) return false;
  try {
    return isEmptyParsedStructureValue(JSON.parse(text));
  } catch {
    return false;
  }
}

export function isSubagentEvidenceSubstantive(
  item: SubagentResultEnvelope["evidence"][number],
): boolean {
  if (item.provenance.source !== "tool_observation" || !String(item.target || "").trim()) return false;
  if (item.observation) return item.observation.substantive === true;
  const detail = String(item.detail || "").trim();
  if (item.tool === "get_file_outline") {
    return !isEmptySubagentStructureObservation(detail);
  }
  if ((item.provenance.sourceContentChars || 0) > 0 || (item.facts?.length || 0) > 0) return true;
  // A successful targeted search/diff with zero hits is still a meaningful
  // negative observation. It differs from an empty outline that reveals no
  // source content for the assigned investigation.
  if (["grep_search", "code_ast_query", "find_symbol_references", "git_diff"].includes(item.tool)) {
    return true;
  }
  return detail.length > 0;
}

const EXTENSIONLESS_FILE_NAMES = new Set([
  "dockerfile",
  "gemfile",
  "license",
  "makefile",
  "procfile",
  "readme",
]);

function looksLikeExactFilePath(path: string): boolean {
  const baseName = String(path || "").replace(/\\/g, "/").split("/").pop()?.toLowerCase() || "";
  return baseName.includes(".") || EXTENSIONLESS_FILE_NAMES.has(baseName);
}

export async function resolveSubagentExecutionScopePaths(input: {
  allowedPaths: string[];
  workspace: string;
}): Promise<Pick<SubagentExecutionScope,
  "allowedFilePaths" | "allowedDirectoryPaths" | "scopeKind"
>> {
  const fileChecks = await Promise.all(input.allowedPaths.map(async (path) => {
    try {
      await getFileMetadata(path, input.workspace);
      return true;
    } catch (error) {
      if (/(?:目标不是文件|not\s+(?:a\s+)?file)/iu.test(String(error || ""))) {
        return false;
      }
      // The desktop IPC distinguishes files from directories. Unit tests and
      // non-Tauri harnesses may not have that IPC, so retain a conservative
      // filename fallback without ever broadening an allowed path.
      return looksLikeExactFilePath(path);
    }
  }));
  const allowedFilePaths = input.allowedPaths.filter((_path, index) => fileChecks[index]);
  const allowedDirectoryPaths = input.allowedPaths.filter((_path, index) => !fileChecks[index]);
  return {
    allowedFilePaths,
    allowedDirectoryPaths,
    scopeKind: allowedFilePaths.length === input.allowedPaths.length
      ? "exact_files"
      : "directory_or_mixed",
  };
}

export function resolveReadOnlySubagentRole(_requestedRole: unknown): string {
  // Every child runtime is intentionally read/search-only. Keep the persisted
  // role aligned with its actual capability instead of displaying model-authored
  // labels such as "coder" that imply it can modify the workspace.
  return "investigator";
}

function compactEvidenceFragment(value: unknown, maxChars: number): string {
  const text = String(value || "").trim();
  if (text.length <= maxChars) return text;
  const separator = " … ";
  const headBudget = Math.max(0, Math.ceil((maxChars - separator.length) * 0.55));
  const tailBudget = Math.max(0, maxChars - separator.length - headBudget);
  return `${text.slice(0, headBudget).trimEnd()}${separator}${text.slice(-tailBudget).trimStart()}`;
}

function recordFailedScopedPathsFromContent(
  content: unknown,
  requiredPaths: string[],
  failedPaths: Set<string>,
): void {
  const text = String(content || "");
  if (!text) return;
  for (const requiredPath of requiredPaths) {
    const escapedPath = requiredPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const sectionFailure = new RegExp(`^===\\s*${escapedPath}\\s*===\\s*\\nError:`, "mi").test(text);
    const aggregateFailure = new RegExp(`^${escapedPath}\\s*:\\s*[^\\n]+`, "mi").test(text);
    if (sectionFailure || aggregateFailure) failedPaths.add(requiredPath);
  }
}

function buildCoverageRemainingWork(
  coverage: SubagentPathCoverageAudit,
): string {
  if (coverage.uncoveredPaths.length === 0) return "";
  const failed = coverage.failedPaths.length > 0
    ? ` Failed paths: ${coverage.failedPaths.join(", ")}.`
    : "";
  return `Collect successful observations for uncovered required paths: ${coverage.uncoveredPaths.join(", ")}.${failed}`;
}

function extractObservedReadFileWindowContent(modelContent: string): string | null {
  const startMarker = "---CONTENT START---\n";
  const endMarker = "\n---CONTENT END---";
  const start = modelContent.indexOf(startMarker);
  if (start < 0) return null;
  const contentStart = start + startMarker.length;
  const end = modelContent.lastIndexOf(endMarker);
  if (end < contentStart) return null;
  return modelContent.slice(contentStart, end);
}

function compactEvidence(
  evidence: SubagentResultEnvelope["evidence"],
): SubagentResultEnvelope["evidence"] {
  const compacted: SubagentResultEnvelope["evidence"] = [];
  const indexByKey = new Map<string, number>();
  for (const item of evidence) {
    const tool = compactText(item.tool, 80);
    const target = compactText(item.target, 300);
    if (!tool || !target) continue;
    const sourceObservationKey = String(item.provenance.sourceObservation?.key || "").trim();
    const sourceVersion = String(
      item.provenance.sourceVersion || item.provenance.sourceObservation?.versionToken || "",
    ).trim();
    const sourceRange = item.provenance.sourceRange;
    const sourceRangeKey = sourceRange
      ? `${sourceRange.startLine}-${sourceRange.endLine}/${sourceRange.totalLines}`
      : "";
    // A target can contribute several disjoint source windows. Keep each
    // observation as its own evidence item so facts never inherit the range of
    // whichever window happened to be observed last.
    const provenanceIdentity = sourceObservationKey ||
      [sourceVersion, sourceRangeKey].filter(Boolean).join("::") ||
      "unversioned";
    const key = `${tool}:${target}:${provenanceIdentity}`.toLowerCase();
    const detail = compactEvidenceFragment(item.detail, 400);
    const facts = mergePlanEvidenceFacts(item.facts, extractPlanEvidenceFacts(item.detail));
    const factReferences = (item.provenance.factReferences || []).slice(0, 24);
    const existingIndex = indexByKey.get(key);
    if (existingIndex !== undefined) {
      const existing = compacted[existingIndex];
      existing.facts = mergePlanEvidenceFacts(existing.facts, facts);
      if (item.observation) {
        const previousObservation = existing.observation;
        existing.observation = previousObservation
          ? {
              ...item.observation,
              contentChars: Math.max(previousObservation.contentChars, item.observation.contentChars),
              negative: previousObservation.negative && item.observation.negative,
              substantive: previousObservation.substantive || item.observation.substantive,
            }
          : { ...item.observation };
      }
      const existingReferences = existing.provenance.factReferences || [];
      const referenceKeys = new Set(existingReferences.map((reference) => [
        reference.fact,
        reference.sourceToolCallId || "",
        reference.sourceObservationKey || "",
      ].join("::")));
      existing.provenance = {
        ...item.provenance,
        factReferences: [
          ...existingReferences,
          ...factReferences.filter((reference) => {
            const referenceKey = [
              reference.fact,
              reference.sourceToolCallId || "",
              reference.sourceObservationKey || "",
            ].join("::");
            if (referenceKeys.has(referenceKey)) return false;
            referenceKeys.add(referenceKey);
            return true;
          }),
        ].slice(0, 24),
      };
      if (!detail || existing.detail === detail) continue;
      const previous = String(existing.detail || "").trim();
      const separator = previous ? " | " : "";
      const incomingBudget = Math.min(detail.length, 250);
      const previousBudget = Math.max(0, 400 - separator.length - incomingBudget);
      existing.detail = `${compactEvidenceFragment(previous, previousBudget)}${separator}${compactEvidenceFragment(detail, incomingBudget)}`;
      continue;
    }
    indexByKey.set(key, compacted.length);
    compacted.push({
      tool,
      target,
      detail,
      ...(facts.length > 0 ? { facts } : {}),
      ...(item.observation ? { observation: { ...item.observation } } : {}),
      provenance: {
        ...item.provenance,
        ...(factReferences.length > 0 ? { factReferences } : {}),
      },
    });
    if (compacted.length >= 10) break;
  }
  return compacted;
}

function buildChildPrompt(request: SpawnSubagentRequest, language: "zh" | "en"): string {
  const hints = compactText(request.contextHints, 1_600);
  const allowedPaths = compactText(request.allowedPaths, 2_000);
  const scope = compactText(request.scope, 500);
  const expectedOutput = compactText(request.expectedOutput, 500);
  if (language === "en") {
    return [
      "You are a bounded read-only subagent working for a parent task.",
      `Role: ${resolveReadOnlySubagentRole(request.role)} (read-only)`,
      `Objective: ${request.objective}`,
      scope ? `Owned scope: ${scope}` : "",
      hints ? `Context hints: ${hints}` : "",
      allowedPaths ? `Allowed paths: ${allowedPaths}` : "",
      expectedOutput ? `Expected output: ${expectedOutput}` : "",
      "Use only the read/search tools exposed to you. Do not modify files, run shell commands, request approval, or spawn another agent.",
      "Do not finish by proposing a tool call that is still available to you. A complete report needs at least one source-backed observation; if an outline or search is empty, read an exact allowed file before summarizing.",
      "Completion is measured only against your assigned read-only scope, not the parent task. Stay inside the allowed paths and return concise Findings, Uncertainty, Remaining In-Scope Work, and Parent Handoff sections.",
      "Remaining In-Scope Work lists only an allowed read/search action required by the objective or expected output that you did not complete. If all assigned investigation is complete, write 'none'. Put edits, implementation suggestions, user/parent decisions, and checks outside allowed paths under Parent Handoff; those do not make the child incomplete.",
      "Never offer approval choices or address the end user directly.",
    ].filter(Boolean).join("\n\n");
  }
  return [
    "你是主任务派生出的有界只读子智能体。",
    `角色：${resolveReadOnlySubagentRole(request.role)}（只读调查）`,
    `目标：${request.objective}`,
    scope ? `负责范围：${scope}` : "",
    hints ? `上下文提示：${hints}` : "",
    allowedPaths ? `允许路径：${allowedPaths}` : "",
    expectedOutput ? `预期产出：${expectedOutput}` : "",
    "只使用当前暴露的读取与搜索工具。不得修改文件、运行 Shell 命令、请求用户批准或继续创建子智能体。",
    "不要以“稍后再调用当前可用工具”结束任务。完整报告至少需要一条源码支撑的观察；若 outline 或搜索为空，应先读取一个允许的精确文件再总结。",
    "完成状态只按分配给你的只读范围判断，不按父任务是否全部完成判断。严格限制在允许路径内，并用“结论 / 不确定项 / 剩余范围内工作 / 父任务交接”四个部分返回简洁证据摘要。",
    "“剩余范围内工作”只能列出目标或预期产出要求、允许路径内且你尚未完成的读取/搜索动作；如果分配的调查已经完成，明确写“无”。文件修改、实施建议、用户或父任务决策、允许路径外的核对都放入“父任务交接”，它们不代表子任务未完成。",
    "不要提供批准选项，也不要直接面向最终用户说话。",
  ].filter(Boolean).join("\n\n");
}

function resolveChildConfig(config: AppConfig, maxIterations: number): AppConfig {
  const currentAgentLoop = (config as AppConfig & { agentLoop?: Record<string, unknown> }).agentLoop || {};
  const currentLimits = (currentAgentLoop.iterationLimits as Record<string, unknown> | undefined) || {};
  return {
    ...config,
    local: { ...config.local },
    cloud: { ...config.cloud },
    cloudServers: config.cloudServers.map((server) => ({ ...server })),
    agentLoop: {
      ...currentAgentLoop,
      iterationLimits: {
        ...currentLimits,
        chatRespond: maxIterations,
        default: maxIterations,
        subagent: maxIterations,
      },
    },
  } as AppConfig;
}

function resolveOutcomeStatus(outcome: AgentLoopOutcome, aborted: boolean): SubagentStatus {
  if (aborted || outcome.status === "aborted") return "canceled";
  if (outcome.status === "completed") {
    if (outcome.resultKind === "success") return "completed";
    if (outcome.resultKind === "partial") return "degraded";
    if (outcome.resultKind === "blocked") return "blocked";
    return "failed";
  }
  if (outcome.status === "paused") return "blocked";
  return "blocked";
}

interface PreparedSubagentRun {
  subagentId: string;
  name: string;
  role: string;
  objective: string;
  scopeKey: string;
  allowedPaths: string[];
}

export function scheduleControlledSubagent(input: {
  request: SpawnSubagentRequest;
  parentCallbacks: OrchestratorCallbacks;
  parentTurnId: string;
  parentSignal?: AbortSignal;
  existingRunCount: number;
  emitEvent: (event: MainThreadEvent) => void;
  executeAgentLoop: ExecuteAgentLoop;
}): SpawnSubagentResult {
  const parentConfig = input.parentCallbacks.getConfig();
  const policy = resolveSubagentCapacityPolicy(parentConfig);
  if (input.existingRunCount >= policy.maxCreatedPerTurn) {
    const deferred = buildSubagentPolicyDeferral({
      name: input.request.name,
      scopeKey: input.request.scopeKey || input.request.scope,
      reason: "turn_capacity_reached",
    });
    input.parentCallbacks.onDebugEvent?.("delegation_admission_decision", {
      decision: "deferred",
      reason: deferred.reason,
      existingRunCount: input.existingRunCount,
      maxCreatedPerTurn: policy.maxCreatedPerTurn,
      profile: policy.profile,
    });
    return deferred;
  }

  const subagentId = `subagent-${generateId()}`;
  const name = sanitizeName(input.request.name, input.existingRunCount);
  const requestedRole = compactText(input.request.role || "", 48);
  const role = resolveReadOnlySubagentRole(requestedRole);
  const rawObjective = String(input.request.objective || "").trim();
  if (rawObjective.length > 800) {
    throw new Error("SUBAGENT_SCOPE_TOO_BROAD: objective must be 800 characters or fewer.");
  }
  const objective = compactText(rawObjective, 800);
  if (!objective) throw new Error("Subagent objective is required.");
  const allowedPaths = parseSubagentAllowedPaths(input.request.allowedPaths, parentConfig.workspace);
  if (allowedPaths.length === 0) {
    throw new Error("SUBAGENT_SCOPE_REQUIRED: workspace subagents require allowed_paths.");
  }
  if (policy.profile === "local" && allowedPaths.length > 6) {
    throw new Error("SUBAGENT_SCOPE_TOO_BROAD: local subagents may own at most 6 paths.");
  }
  const scopeKey = compactText(input.request.scopeKey || input.request.scope || objective, 96);
  const leaseOverlap = findSubagentLeaseOverlap({
    threadId: input.parentCallbacks.getSessionKey(),
    workspace: parentConfig.workspace,
    allowedPaths,
  });
  if (leaseOverlap) {
    input.parentCallbacks.onDebugEvent?.("delegation_scope_decision", {
      decision: "deferred",
      reason: "overlapping_active_scope",
      conflictingSubagentId: leaseOverlap.subagentId,
      conflictingScopeKey: leaseOverlap.scopeKey,
      allowedPaths,
    });
    return buildSubagentPolicyDeferral({
      name,
      scopeKey,
      reason: "overlapping_active_scope",
      conflictingSubagentId: leaseOverlap.subagentId,
      conflictingScopeKey: leaseOverlap.scopeKey,
    });
  }
  const prepared: PreparedSubagentRun = {
    subagentId,
    name,
    role,
    objective,
    scopeKey,
    allowedPaths,
  };
  input.parentCallbacks.onDebugEvent?.("subagent_scheduled", {
    subagentId,
    name,
    role,
    requestedRole: requestedRole || null,
    scopeKey,
    profile: policy.profile,
    childCapacity: policy.maxActiveRequests,
    burstChildCapacity: policy.maxBurstActiveRequests,
    elasticCandidate: policy.profile === "local" && input.existingRunCount >= policy.maxActiveRequests,
    allowedPathCount: allowedPaths.length,
    delegationDecision: "admitted",
    delegationReason: "runtime_scope_admitted",
  });
  const completion = executeControlledSubagent({ ...input, prepared });
  registerCoordinatedSubagentRun({
    threadId: input.parentCallbacks.getSessionKey(),
    parentTurnId: input.parentTurnId,
    subagentId,
    name,
    scopeKey,
    completion,
  });
  return { subagentId, name, status: "queued", scopeKey };
}

export async function executeControlledSubagent(input: {
  request: SpawnSubagentRequest;
  parentCallbacks: OrchestratorCallbacks;
  parentTurnId: string;
  parentSignal?: AbortSignal;
  existingRunCount: number;
  emitEvent: (event: MainThreadEvent) => void;
  executeAgentLoop: ExecuteAgentLoop;
  prepared?: PreparedSubagentRun;
}): Promise<SubagentResultEnvelope> {
  const parentConfig = input.parentCallbacks.getConfig();
  const language = input.parentCallbacks.getPreferredLanguage();
  const policy = resolveSubagentCapacityPolicy(parentConfig);
  const prepared = input.prepared || (() => {
    const objective = compactText(input.request.objective, 800);
    return {
      subagentId: `subagent-${generateId()}`,
      name: sanitizeName(input.request.name, input.existingRunCount),
      role: resolveReadOnlySubagentRole(input.request.role),
      objective,
      scopeKey: compactText(input.request.scopeKey || input.request.scope || objective, 96),
      allowedPaths: parseSubagentAllowedPaths(input.request.allowedPaths, parentConfig.workspace),
    };
  })();
  const { subagentId, name, role, objective, scopeKey, allowedPaths } = prepared;
  const childRunId = `run-${subagentId}`;
  const parentRunId = input.parentCallbacks.getCurrentRunIdentity?.().runId || null;
  const emitChildDebug = (event: string, data: Record<string, unknown> = {}) => {
    input.parentCallbacks.onDebugEvent?.(event, {
      ...data,
      threadId: `${input.parentCallbacks.getSessionKey()}:${subagentId}`,
      turnId: subagentId,
      runId: childRunId,
      parentRunId,
      agentKind: "subagent",
      subagentId,
    });
  };

  const now = Date.now();
  const snapshot: SubagentRunSnapshot = {
    id: subagentId,
    parentTurnId: input.parentTurnId,
    threadId: input.parentCallbacks.getSessionKey(),
    name,
    role,
    objective,
    scopeKey,
    scope: compactText(input.request.scope, 500),
    allowedPaths,
    expectedOutput: compactText(input.request.expectedOutput, 500),
    status: "queued",
    profile: policy.profile,
    provider: policy.provider,
    model: policy.model,
    createdAt: now,
    updatedAt: now,
    progress: {
      phase: "queued",
      title: language === "zh" ? "等待可用模型通道" : "Waiting for an available model lane",
      completedToolCalls: 0,
    },
  };
  input.emitEvent(withEventSchema({
    type: "subagent.created",
    threadId: snapshot.threadId,
    turnId: input.parentTurnId,
    timestampMs: now,
    subagent: snapshot,
  }));
  emitChildDebug("subagent_queued", {
    scopeKey,
    profile: policy.profile,
    childCapacity: policy.maxActiveRequests,
    burstChildCapacity: policy.maxBurstActiveRequests,
    elasticCandidate: policy.profile === "local" && input.existingRunCount >= policy.maxActiveRequests,
    allowedPathCount: allowedPaths.length,
  });
  reserveSubagentScope({
    threadId: snapshot.threadId,
    parentTurnId: input.parentTurnId,
    subagentId,
    scopeKey,
    workspace: parentConfig.workspace,
    allowedPaths,
    createdAt: now,
  });
  emitChildDebug("subagent_scope_reserved", {
    scopeKey,
    allowedPathCount: allowedPaths.length,
    parentBlocking: true,
  });

  const childAbortController = new AbortController();
  registerSubagentAbortController(subagentId, childAbortController);
  const abortFromParent = () => childAbortController.abort();
  if (input.parentSignal?.aborted) {
    childAbortController.abort();
  } else {
    input.parentSignal?.addEventListener("abort", abortFromParent, { once: true });
  }

  let childMessages: AgentMessage[] = [{
    role: "user",
    content: buildChildPrompt(input.request, language),
  }];
  let childStatus: "idle" | "running" | "pending_review" | "error" = "idle";
  let streamText = "";
  let finalText = "";
  let turnSummary = "";
  let lastError = "";
  let completedToolCalls = 0;
  const evidence: SubagentResultEnvelope["evidence"] = [];
  // allowedPaths is an authorization ceiling, not an obligation to inspect
  // every permitted root. Required coverage is introduced only by a concrete
  // runtime fan-out (or a future explicit completion contract).
  const requiredObservationPaths = new Set<string>();
  const coveredObservationPaths = new Set<string>();
  const failedObservationPaths = new Set<string>();
  let activitySequence = 0;
  let lastProgressEmitAt = 0;
  let childForceXmlTools = false;
  let scopeLeaseActivated = false;
  const initializedHookSessions = new Set<string>();
  const initiallyFileLikePaths = allowedPaths.filter(looksLikeExactFilePath);
  const subagentExecutionScope: SubagentExecutionScope = {
    subagentId,
    parentSessionKey: snapshot.threadId,
    scopeKey,
    workspace: parentConfig.workspace,
    allowedPaths,
    allowedFilePaths: initiallyFileLikePaths,
    allowedDirectoryPaths: allowedPaths.filter((path) => !initiallyFileLikePaths.includes(path)),
    scopeKind: initiallyFileLikePaths.length === allowedPaths.length
      ? "exact_files"
      : "directory_or_mixed",
    blockedToolNames: [],
  };
  const resolvePathCoverage = (): SubagentPathCoverageAudit => resolveSubagentPathCoverage({
    requiredPaths: [...requiredObservationPaths],
    observedPaths: coveredObservationPaths,
    failedPaths: failedObservationPaths,
  });

  const emitUpdate = (patch: SubagentRunPatch, activity?: SubagentActivity) => {
    input.emitEvent(withEventSchema({
      type: "subagent.updated",
      threadId: snapshot.threadId,
      turnId: input.parentTurnId,
      timestampMs: Date.now(),
      subagentId,
      patch: { updatedAt: Date.now(), ...patch },
      ...(activity ? { activity } : {}),
    }));
  };
  const emitProgress = (progress: SubagentProgress) => {
    const current = Date.now();
    if (current - lastProgressEmitAt < 500 && progress.phase === "thinking") return;
    lastProgressEmitAt = current;
    emitUpdate({ status: "running", progress });
  };
  const makeActivity = (
    status: SubagentActivity["status"],
    title: string,
    tool?: string,
    target?: string,
    detail?: string,
  ): SubagentActivity => ({
    id: `${subagentId}-activity-${++activitySequence}`,
    timestampMs: Date.now(),
    status,
    title,
    ...(tool ? { tool } : {}),
    ...(target ? { target } : {}),
    ...(detail ? { detail: compactText(detail, 1_000) } : {}),
  });

  const childCallbacks: OrchestratorCallbacks = {
    // Keep child callbacks as an explicit allowlist. Spreading the parent
    // object makes every future parent state callback an accidental cross-run
    // write channel (for example recovery checkpoints or terminal tool state).
    getMessages: () => childMessages,
    getConfig: () => resolveChildConfig(parentConfig, policy.childMaxIterations),
    getPreferredLanguage: () => language,
    getSkills: () => input.parentCallbacks.getSkills(),
    getMainModeKey: () => input.parentCallbacks.getMainModeKey(),
    getActiveStudioAgentKey: () => input.parentCallbacks.getActiveStudioAgentKey(),
    getGameStudioInitialized: () => input.parentCallbacks.getGameStudioInitialized(),
    getPendingSlashCommand: () => null,
    getGameStudioConfig: () => input.parentCallbacks.getGameStudioConfig?.() || null,
    getWorkspaceTree: () => input.parentCallbacks.getWorkspaceTree(),
    getMcpServers: () => input.parentCallbacks.getMcpServers(),
    getMcpDiscoveredTools: () => input.parentCallbacks.getMcpDiscoveredTools(),
    getWebSearchEnabled: () => input.parentCallbacks.getWebSearchEnabled?.() === true,
    getWebSearchProvider: () => input.parentCallbacks.getWebSearchProvider?.() || "duckduckgo",
    getEnabledKnowledgeBaseIds: () => input.parentCallbacks.getEnabledKnowledgeBaseIds?.() || [],
    getAssociatedPaths: () => input.parentCallbacks.getAssociatedPaths(),
    getSessionKey: () => `${snapshot.threadId}:${subagentId}`,
    getCurrentTurnId: () => subagentId,
    getCurrentRunIntent: () => "analyze",
    getRuntimeRunIntent: () => "analyze",
    getGoalTurnContract: () => null,
    getExecutionConsentGranted: () => false,
    getForcedExecuteRecoveryMode: () => null,
    getForcedExecuteRecoveryState: () => null,
    getCommandDirective: () => null,
    getWorkflowMode: () => "chat",
    getIsPlanApproved: () => false,
    getPlanApprovalChoice: () => null,
    getReadOnlyAutoApproveForSession: () => true,
    getApprovedLocalFileReadPaths: () => input.parentCallbacks.getApprovedLocalFileReadPaths(),
    getAutoApproveToolScopes: () => [],
    getPlanStage: () => "idle",
    getPlanArtifacts: () => [],
    getPlanTasks: () => [],
    getPlanExecutionEvidenceLedger: () => [],
    getPlanAutoResumeCount: () => 0,
    getIsApprovedPlanExecutionTransitionPending: () => false,
    getStatus: () => childStatus,
    consumeActiveGuidance: () => null,
    startNewTurn: () => {},
    getContextMemoryState: () => null,
    getSubagentDepth: () => 1,
    getCurrentRunIdentity: () => ({
      runId: childRunId,
      parentRunId,
    }),
    getSubagentScope: () => subagentExecutionScope,
    getRuntimeTraceContext: () => ({
      threadId: `${snapshot.threadId}:${subagentId}`,
      turnId: subagentId,
      runId: childRunId,
      parentRunId,
      agentKind: "subagent",
      subagentId,
    }),
    hasSessionHookInitialized: (sessionKey) => initializedHookSessions.has(sessionKey),
    markSessionHookInitialized: (sessionKey) => {
      initializedHookSessions.add(sessionKey);
    },
    shouldForceXmlForProviderCompatibility: () => childForceXmlTools,
    onProviderCompatibilityFallback: (reason) => {
      childForceXmlTools = true;
      emitChildDebug("subagent_protocol_fallback", {
        reason,
        from: "native_tools",
        to: "xml_tools",
      });
    },
    onProviderNativeToolSuccess: () => {},
    // Child iterations resolve a deliberately narrower read-only surface.
    // Never project that surface into the parent's terminal capability audit.
    onToolSurfaceResolved: undefined,
    onModelUsage: (usage) => input.parentCallbacks.onModelUsage?.(usage),
    onExecuteRecoveryStateChange: undefined,
    evaluateGoalToolResultCheckpoint: undefined,
    getPendingSubagentIds: () => [],
    onDebugEvent: (event, data = {}) => {
      if (event === "memory_pressure_sample" && data.action === "hold") {
        emitProgress({
          phase: "waiting",
          title: language === "zh" ? "等待本地模型内存余量" : "Waiting for local model memory",
          completedToolCalls,
        });
      }
      emitChildDebug(event, data);
    },
    runSubagent: undefined,
    waitSubagents: undefined,
    onGoalProgressUpdate: undefined,
    onGoalRuntimeUpdate: undefined,
    onGoalIterationStart: undefined,
    onGoalIterationEnd: undefined,
    onGoalCheckpointSaved: undefined,
    onGoalUserConfirmNeeded: undefined,
    onGoalOutcome: undefined,
    onStreamToken: (token) => {
      streamText += token;
      emitProgress({
        phase: "thinking",
        title: language === "zh" ? "正在分析并整理证据" : "Analyzing and organizing evidence",
        completedToolCalls,
      });
    },
    onStreamDone: (text) => {
      if (String(text || "").trim()) streamText = String(text);
    },
    onThought: () => {
      emitProgress({
        phase: "thinking",
        title: language === "zh" ? "正在推理下一步" : "Reasoning about the next step",
        completedToolCalls,
      });
    },
    onAssistantFinalText: (text) => {
      if (String(text || "").trim()) finalText = String(text).trim();
    },
    onStatusChange: (status) => {
      childStatus = status;
    },
    onError: (error) => {
      childStatus = "error";
      lastError = String(error || "");
    },
    onNonActionableStop: (message, _reason, progress) => {
      lastError = progress?.recoveryReason === "empty_model_response"
        ? `SUBAGENT_EMPTY_MODEL_RESPONSE: the provider returned no semantic text or tool calls after the bounded ${childForceXmlTools ? "native-to-XML fallback" : "native tool"} attempts.`
        : String(message || "");
    },
    onPlanArtifactUpdated: () => {},
    onPlanStageChanged: () => {},
    onPlanTasksUpdated: () => {},
    onPlanExecutionProgress: undefined,
    onPlanMaxIterationsCheckpoint: undefined,
    onExecuteMaxIterationsCheckpoint: undefined,
    onTurnSummaryReady: (summary) => {
      turnSummary = String(summary || "").trim();
    },
    onExecutionDigestUpdate: undefined,
    onTurnRuntimePhaseChanged: (phase) => {
      emitProgress({
        phase: phase.kind === "validation" ? "summarizing" : "thinking",
        title: phase.title,
        completedToolCalls,
      });
    },
    onTurnEvent: undefined,
    onHarnessRunUpdate: undefined,
    onInstructionsResolved: () => {},
    onHooksLoaded: () => {},
    onHookStart: () => {},
    onHookResult: () => {},
    onHookBlocked: () => {},
    appendMessage: (message) => {
      childMessages = [...childMessages, message];
    },
    replaceMessages: (messages) => {
      childMessages = [...messages];
    },
    onContextMemoryBuilt: undefined,
    onContextCompress: () => {},
    onToolExecuting: (tool, target) => {
      if (!scopeLeaseActivated) {
        scopeLeaseActivated = activateSubagentScopeLease(subagentId);
        emitChildDebug("subagent_scope_lease_activated", {
          scopeKey,
          tool,
          target,
          activated: scopeLeaseActivated,
          waitBeforeActivationMs: Date.now() - lifecycleStartedAt,
        });
      }
      emitUpdate({
        status: "running",
        progress: {
          phase: "tool",
          title: language === "zh" ? `正在执行 ${tool}` : `Running ${tool}`,
          tool,
          target,
          completedToolCalls,
        },
      }, makeActivity("running", language === "zh" ? "开始工具调用" : "Tool call started", tool, target));
    },
    onToolDone: (tool, target, result) => {
      completedToolCalls += 1;
      emitUpdate({
        status: "running",
        progress: {
          phase: "tool",
          title: language === "zh" ? `已完成 ${tool}` : `Completed ${tool}`,
          tool,
          target,
          completedToolCalls,
        },
    }, makeActivity("completed", language === "zh" ? "工具调用完成" : "Tool call completed", tool, target, result));
    },
    onToolResultObserved: (result: ToolExecutionResult) => {
      const scopedReadCoverage = result.scopedReadCoverage;
      for (const path of scopedReadCoverage?.requiredPaths || []) requiredObservationPaths.add(path);
      for (const path of scopedReadCoverage?.failedPaths || []) failedObservationPaths.add(path);
      recordFailedScopedPathsFromContent(
        result.displayContent || result.content,
        [...requiredObservationPaths],
        failedObservationPaths,
      );
      if (
        result.internalFeedback ||
        !SUBAGENT_EVIDENCE_TOOL_NAMES.has(result.name) ||
        !String(result.target || "").trim() ||
        (result.isError && !result.scopedReadObservations?.length)
      ) return;
      // Evidence must come from model-facing tool payloads. A safely fanned-out
      // scoped search contributes one observation per runtime-owned source path
      // while retaining the original tool-call identity.
      const defaultContent = result.content || result.displayContent || "";
      const sourceObservations = result.scopedReadObservations?.length
        ? result.scopedReadObservations
        : [{
            sourcePath: result.target,
            content: defaultContent,
            negative: !defaultContent.trim() ||
              /(?:no matches?|0 matches?|not found|no references? found)/i.test(defaultContent),
          }];
      for (const scopedObservation of sourceObservations) {
        const sourcePath = String(scopedObservation.sourcePath || "").trim();
        if (!sourcePath) continue;
        const rawObservation = String(scopedObservation.content || "");
        const detail = summarizePlanEvidenceDetail({
          tool: result.name,
          target: sourcePath,
          content: rawObservation,
          maxChars: 400,
        }) || compactText(rawObservation, 1_000);
        const facts = mergePlanEvidenceFacts(
          extractPlanEvidenceFacts(rawObservation),
          extractPlanEvidenceFacts(detail),
        );
        const isSourceRead = ["read_file", "read_file_window", "read_document"].includes(result.name);
        const isStructureRead = result.name === "get_file_outline";
        const isDiffRead = result.name === "git_diff";
        const observationKind = isSourceRead
          ? "source"
          : isStructureRead
          ? "structure"
          : isDiffRead
          ? "diff"
          : "search";
        const envelopedSourceContent = isSourceRead
          ? extractObservedReadFileWindowContent(rawObservation)
          : null;
        const isCachedSourceStub = isSourceRead &&
          /FILE_UNCHANGED_STUB|CACHED_FILE_REPLAY|READ_FILE_REPEAT_LIMIT/i.test(rawObservation);
        const effectiveSourceContent = isSourceRead
          ? envelopedSourceContent !== null
            ? envelopedSourceContent
            : isCachedSourceStub ? null : rawObservation
          : null;
        const negative = scopedObservation.negative || (
          isStructureRead && (
            isEmptySubagentStructureObservation(rawObservation) ||
            isEmptySubagentStructureObservation(detail)
          )
        ) || (isSourceRead && effectiveSourceContent !== null && effectiveSourceContent.trim() === "");
        const sourceContentChars = effectiveSourceContent === null
          ? 0
          : [...effectiveSourceContent].length;
        const substantive = isSourceRead
          ? effectiveSourceContent !== null
          : isStructureRead
          ? !negative && detail.trim().length > 0
          // A successful targeted search or diff with zero hits is meaningful
          // negative evidence; it is not equivalent to an empty outline.
          : true;
        if (substantive) coveredObservationPaths.add(sourcePath);
        const sourceObservation = !result.scopedReadObservations?.length && result.readFileObservation
          ? { ...result.readFileObservation }
          : undefined;
        const sourceRange = isSourceRead && envelopedSourceContent !== null
          ? buildFileReadWindowIdentity(rawObservation)
          : undefined;
        const sourceContentHash = effectiveSourceContent !== null
          ? hashString(effectiveSourceContent)
          : "";
        const factReferences = facts.map((fact) => ({
          fact,
          sourceToolCallId: result.toolCallId,
          ...(sourceObservation?.key
            ? { sourceObservationKey: sourceObservation.key }
            : {}),
          ...(sourceObservation?.versionToken
            ? { sourceVersion: sourceObservation.versionToken }
            : {}),
          ...(sourceRange ? { sourceRange: { ...sourceRange } } : {}),
        }));
        evidence.push({
          tool: result.name,
          target: sourcePath,
          // The child-authored summary is deliberately kept outside evidence.
          detail,
          ...(facts.length > 0 ? { facts } : {}),
          observation: {
            kind: observationKind,
            sourcePath,
            contentChars: isSourceRead ? sourceContentChars : [...rawObservation].length,
            negative,
            substantive,
          },
          provenance: {
            source: "tool_observation",
            owner: {
              agentKind: "subagent",
              subagentId,
              parentTurnId: input.parentTurnId,
              runId: childRunId,
            },
            sourceToolCallId: result.toolCallId,
            ...(sourceObservation ? { sourceObservation } : {}),
            ...(sourceObservation?.versionToken
              ? { sourceVersion: sourceObservation.versionToken }
              : {}),
            ...(sourceContentHash ? { sourceContentHash } : {}),
            ...(isSourceRead ? { sourceContentChars } : {}),
            ...(sourceRange ? { sourceRange: { ...sourceRange } } : {}),
            ...(factReferences.length > 0 ? { factReferences } : {}),
          },
        });
      }
    },
    onToolError: (tool, target, error) => {
      if (SUBAGENT_EVIDENCE_TOOL_NAMES.has(tool)) {
        if (String(target || "").trim()) failedObservationPaths.add(target);
        recordFailedScopedPathsFromContent(
          error,
          [...requiredObservationPaths],
          failedObservationPaths,
        );
      }
      emitUpdate({
        status: "running",
        progress: {
          phase: "tool",
          title: language === "zh" ? `${tool} 执行失败` : `${tool} failed`,
          tool,
          target,
          completedToolCalls,
        },
      }, makeActivity("failed", language === "zh" ? "工具调用失败" : "Tool call failed", tool, target, error));
    },
    requestReview: async () => ({ action: "reject" }),
  };

  let finalStatus: SubagentStatus = "failed";
  let runtimeCompletedSuccessfully = false;
  let finalSummary = "";
  let wallClockTimedOut = false;
  const lifecycleStartedAt = Date.now();
  let capacityQueuedAt: number | null = null;
  let runtimeStartedAt: number | null = null;
  try {
    return await withSubagentCapacity({
      policy,
      signal: childAbortController.signal,
      onQueued: () => {
        capacityQueuedAt = Date.now();
        const burstAdmission = getSubagentBurstAdmission(policy);
        const elasticCandidate = policy.profile === "local" &&
          input.existingRunCount >= policy.maxActiveRequests;
        emitChildDebug("subagent_capacity_queued", {
          profile: policy.profile,
          childCapacity: policy.maxActiveRequests,
          burstChildCapacity: policy.maxBurstActiveRequests,
          elasticCandidate,
          burstAdmission,
        });
        if (elasticCandidate) {
          emitChildDebug("subagent_elastic_admission", {
            decision: "queued",
            burstAdmission,
          });
        }
        emitUpdate({
          status: "queued",
          progress: {
            phase: "queued",
            title: policy.profile === "local"
              ? language === "zh" ? "等待本地子智能体并发配额" : "Waiting for local subagent capacity"
              : language === "zh" ? "等待云端并发配额" : "Waiting for cloud concurrency capacity",
            completedToolCalls,
          },
        });
      },
      task: async () => {
        const startedAt = Date.now();
        runtimeStartedAt = startedAt;
        const burstAdmission = getSubagentBurstAdmission(policy);
        const elasticCandidate = policy.profile === "local" &&
          input.existingRunCount >= policy.maxActiveRequests;
        if (elasticCandidate) {
          emitChildDebug("subagent_elastic_admission", {
            decision: burstAdmission.allowed ? "admitted" : "started_after_base_slot_released",
            waitMs: capacityQueuedAt == null ? 0 : startedAt - capacityQueuedAt,
            burstAdmission,
          });
        }
        emitChildDebug("subagent_started", {
          profile: policy.profile,
          startupMs: Math.max(0, startedAt - lifecycleStartedAt),
          capacityWaitMs: capacityQueuedAt == null ? 0 : startedAt - capacityQueuedAt,
          childCapacity: policy.maxActiveRequests,
          burstChildCapacity: policy.maxBurstActiveRequests,
          elasticAdmissionGranted: elasticCandidate && burstAdmission.allowed,
          burstAdmission,
        });
        emitUpdate({
          status: "starting",
          startedAt,
          progress: {
            phase: "starting",
            title: language === "zh" ? "子智能体已启动" : "Subagent started",
            completedToolCalls,
          },
        }, makeActivity("running", language === "zh" ? "开始执行" : "Execution started"));

        const resolvedScopePaths = await resolveSubagentExecutionScopePaths({
          allowedPaths,
          workspace: parentConfig.workspace,
        });
        subagentExecutionScope.allowedFilePaths = resolvedScopePaths.allowedFilePaths;
        subagentExecutionScope.allowedDirectoryPaths = resolvedScopePaths.allowedDirectoryPaths;
        subagentExecutionScope.scopeKind = resolvedScopePaths.scopeKind;
        emitChildDebug("subagent_scope_paths_resolved", {
          scopeKey,
          scopeKind: resolvedScopePaths.scopeKind,
          allowedFilePaths: resolvedScopePaths.allowedFilePaths,
          allowedDirectoryPaths: resolvedScopePaths.allowedDirectoryPaths,
        });

        const wallClockTimer = setTimeout(() => {
          wallClockTimedOut = true;
          lastError = "SUBAGENT_WALL_CLOCK_TIMEOUT: execution exceeded 240 seconds.";
          childAbortController.abort();
        }, 240_000);
        const outcome = normalizeAgentLoopOutcome(
          await input.executeAgentLoop(childCallbacks, childAbortController)
            .finally(() => clearTimeout(wallClockTimer)),
        );
        finalStatus = resolveOutcomeStatus(outcome, childAbortController.signal.aborted);
        if (wallClockTimedOut) finalStatus = "blocked";
        const candidateSummary = compactText(
          finalText || turnSummary || streamText || childMessages
            .filter((message) => message.role === "assistant" && typeof message.content === "string")
            .map((message) => String(message.content))
            .filter(Boolean)
            .join("\n"),
          16_000,
        );
        finalSummary = candidateSummary;
        const compactedEvidence = compactEvidence(evidence);
        const declaredRemainingWork = extractDeclaredSubagentRemainingWork(candidateSummary);
        const declaredRemainingWorkSection = hasDeclaredSubagentRemainingWorkSection(candidateSummary);
        const parentHandoff = extractDeclaredSubagentParentHandoff(candidateSummary);
        const requiresEvidence = String(input.request.expectedOutput || "").trim().length > 0;
        const substantiveEvidence = compactedEvidence.filter(isSubagentEvidenceSubstantive);
        const hasSubstantiveEvidence = substantiveEvidence.length > 0;
        const pathCoverage = resolvePathCoverage();
        if (
          finalStatus !== "completed" &&
          outcome.status === "completed" &&
          outcome.reason === "subagent_max_iterations_partial_handoff" &&
          declaredRemainingWorkSection &&
          !declaredRemainingWork &&
          hasSubstantiveEvidence &&
          pathCoverage.uncoveredPaths.length === 0
        ) {
          finalStatus = "completed";
          lastError = "";
          emitChildDebug("subagent_bounded_handoff_closed", {
            reason: "explicit_scope_closure_with_evidence",
            observationCount: compactedEvidence.length,
            substantiveEvidenceCount: substantiveEvidence.length,
            coveredPaths: pathCoverage.coveredPaths,
          });
        }
        if (finalStatus === "completed" && declaredRemainingWork) {
          finalStatus = hasSubstantiveEvidence ? "degraded" : "blocked";
          lastError = "SUBAGENT_REMAINING_WORK_DECLARED: the child report explicitly identifies unfinished in-scope work.";
          emitChildDebug("subagent_completion_downgraded", {
            reason: "declared_remaining_work",
            observationCount: compactedEvidence.length,
            substantiveEvidenceCount: substantiveEvidence.length,
            remainingWork: declaredRemainingWork,
          });
        } else if (finalStatus === "completed" && requiresEvidence && !hasSubstantiveEvidence) {
          finalStatus = "blocked";
          lastError = "SUBAGENT_EVIDENCE_REQUIRED: the expected output requires source evidence, but no substantive tool observation was returned.";
          emitChildDebug("subagent_completion_downgraded", {
            reason: "missing_substantive_evidence",
            observationCount: compactedEvidence.length,
            substantiveEvidenceCount: 0,
          });
        }
        if (finalStatus === "completed" && pathCoverage.uncoveredPaths.length > 0) {
          finalStatus = hasSubstantiveEvidence ? "degraded" : "blocked";
          lastError = [
            "SUBAGENT_SCOPE_COVERAGE_INCOMPLETE: required path observations are incomplete.",
            `uncovered=[${pathCoverage.uncoveredPaths.join(", ")}]`,
            `failed=[${pathCoverage.failedPaths.join(", ")}]`,
          ].join(" ");
          emitChildDebug("subagent_completion_downgraded", {
            reason: "incomplete_required_path_coverage",
            requiredPaths: pathCoverage.requiredPaths,
            coveredPaths: pathCoverage.coveredPaths,
            failedPaths: pathCoverage.failedPaths,
            uncoveredPaths: pathCoverage.uncoveredPaths,
            observationCount: compactedEvidence.length,
            substantiveEvidenceCount: substantiveEvidence.length,
          });
        }
        if (
          finalStatus === "blocked" &&
          (
            (
              outcome.status === "completed" &&
              (outcome.resultKind === "partial" || outcome.resultKind === "blocked")
            ) ||
            (
              outcome.status === "paused" &&
              (outcome.pauseKind === "no_action" || outcome.pauseKind === "no_output")
            )
          ) &&
          (candidateSummary.length > 0 || evidence.length > 0)
        ) {
          finalStatus = hasSubstantiveEvidence ? "degraded" : "blocked";
          emitChildDebug("subagent_partial_result_preserved", {
            outcomeStatus: outcome.status,
            outcomePauseKind: outcome.status === "paused" ? outcome.pauseKind : null,
            outcomeResultKind: outcome.status === "completed" ? outcome.resultKind : null,
            outcomeReason: outcome.reason,
            summaryChars: candidateSummary.length,
            observationCount: compactedEvidence.length,
            substantiveEvidenceCount: substantiveEvidence.length,
          });
        }
        if (finalStatus === "failed" && reportSubagentCapacityFailure(policy, lastError || outcome.reason)) {
          finalStatus = hasSubstantiveEvidence ? "degraded" : "blocked";
        }
        if (!finalSummary) {
          finalSummary = finalStatus === "completed"
            ? language === "zh" ? "子智能体已完成，但没有返回可见摘要。" : "The subagent completed without a visible summary."
            : lastError || outcome.reason;
        }
        const completedAt = Date.now();
        const coverageRemainingWork = buildCoverageRemainingWork(pathCoverage);
        const remainingWork = finalStatus === "completed"
          ? ""
          : declaredRemainingWork || coverageRemainingWork || objective;
        const closureState: NonNullable<SubagentResultEnvelope["closureAudit"]>["state"] =
          finalStatus === "completed"
            ? "satisfied"
            : finalStatus === "degraded" && hasSubstantiveEvidence
            ? "partial"
            : "blocked";
        const closureReason = closureState === "satisfied"
          ? requiresEvidence
            ? "The expected output is backed by substantive tool observations and no remaining work was declared."
            : "The child runtime completed and declared no remaining work."
          : closureState === "partial"
          ? lastError || outcome.reason || "Substantive evidence was returned, but in-scope work remains."
          : lastError || outcome.reason || "The child did not produce sufficient evidence to close the objective.";
        const acceptedEvidenceToolCallIds = [...new Set(substantiveEvidence
          .map((item) => String(item.provenance.sourceToolCallId || "").trim())
          .filter(Boolean))];
        const closureAudit: NonNullable<SubagentResultEnvelope["closureAudit"]> = {
          state: closureState,
          observationCount: compactedEvidence.length,
          substantiveEvidenceCount: substantiveEvidence.length,
          acceptedEvidenceToolCallIds,
          requiredPaths: pathCoverage.requiredPaths,
          coveredPaths: pathCoverage.coveredPaths,
          failedPaths: pathCoverage.failedPaths,
          uncoveredPaths: pathCoverage.uncoveredPaths,
          reason: closureReason,
        };
        runtimeCompletedSuccessfully = finalStatus === "completed";
        emitUpdate({
          status: finalStatus,
          completedAt,
          summary: finalSummary,
          evidenceCount: substantiveEvidence.length,
          observationCount: compactedEvidence.length,
          substantiveEvidenceCount: substantiveEvidence.length,
          closureState,
          ...(remainingWork ? { remainingWork } : {}),
          ...(finalStatus === "completed" ? {} : { error: lastError || outcome.reason }),
          ...(parentHandoff ? { parentHandoff } : {}),
          progress: {
            phase: "done",
            title: finalStatus === "completed"
              ? language === "zh" ? "执行完成" : "Completed"
              : finalStatus === "blocked" || finalStatus === "degraded"
              ? language === "zh" ? "已返回可用的部分结果" : "Usable partial result returned"
              : finalStatus === "canceled"
              ? language === "zh" ? "已取消" : "Canceled"
              : language === "zh" ? "执行未完成" : "Execution did not complete",
            completedToolCalls,
          },
        }, makeActivity(
          finalStatus === "completed" || finalStatus === "blocked" || finalStatus === "degraded"
            ? "completed"
            : finalStatus === "canceled" ? "canceled" : "failed",
          finalStatus === "completed"
            ? language === "zh" ? "返回摘要" : "Summary returned"
            : finalStatus === "blocked" || finalStatus === "degraded"
            ? language === "zh" ? "返回部分摘要" : "Partial summary returned"
            : language === "zh" ? "执行结束" : "Execution ended",
        ));
        if (finalStatus === "degraded") {
          input.emitEvent(withEventSchema({
            type: "subagent.handed_back",
            threadId: snapshot.threadId,
            turnId: input.parentTurnId,
            timestampMs: completedAt,
            subagentId,
            reason: lastError || outcome.reason,
            evidenceCount: substantiveEvidence.length,
            remainingWork,
          }));
          emitChildDebug("subagent_handed_back", {
            subagentId,
            scopeKey,
            reason: lastError || outcome.reason,
            observationCount: compactedEvidence.length,
            substantiveEvidenceCount: substantiveEvidence.length,
            remainingWork,
          });
        }
        return {
          subagentId,
          name,
          scopeKey,
          status: finalStatus,
          summary: finalSummary,
          summaryTrust: "unverified_hypothesis",
          evidence: compactedEvidence,
          closureAudit,
          ...(parentHandoff ? { parentHandoff } : {}),
          ...(finalStatus === "completed" ? {} : { blocker: lastError || outcome.reason }),
          ...(finalStatus === "blocked" || finalStatus === "degraded"
            ? { remainingWork }
            : {}),
          ...(finalStatus === "completed" ? {} : { error: lastError || outcome.reason }),
        };
      },
    });
  } catch (error) {
    finalStatus = wallClockTimedOut
      ? "blocked"
      : childAbortController.signal.aborted ? "canceled" : "failed";
    finalSummary = compactText(finalText || turnSummary || streamText, 16_000);
    lastError = finalStatus === "canceled"
      ? language === "zh"
        ? "SUBAGENT_CANCELED_BY_USER：子智能体已停止；除非用户明确要求，否则不要重新创建相同任务。"
        : "SUBAGENT_CANCELED_BY_USER: the subagent was stopped; do not respawn the same task unless the user explicitly asks."
      : error instanceof Error ? error.message : String(error || "");
    const compactedEvidence = compactEvidence(evidence);
    const substantiveEvidence = compactedEvidence.filter(isSubagentEvidenceSubstantive);
    const pathCoverage = resolvePathCoverage();
    if (finalStatus === "failed" && reportSubagentCapacityFailure(policy, error)) {
      finalStatus = substantiveEvidence.length > 0 ? "degraded" : "blocked";
    }
    const remainingWork = extractDeclaredSubagentRemainingWork(finalSummary) ||
      buildCoverageRemainingWork(pathCoverage) ||
      objective;
    const closureState: NonNullable<SubagentResultEnvelope["closureAudit"]>["state"] =
      finalStatus === "degraded" && substantiveEvidence.length > 0 ? "partial" : "blocked";
    const closureAudit: NonNullable<SubagentResultEnvelope["closureAudit"]> = {
      state: closureState,
      observationCount: compactedEvidence.length,
      substantiveEvidenceCount: substantiveEvidence.length,
      acceptedEvidenceToolCallIds: [...new Set(substantiveEvidence
        .map((item) => String(item.provenance.sourceToolCallId || "").trim())
        .filter(Boolean))],
      requiredPaths: pathCoverage.requiredPaths,
      coveredPaths: pathCoverage.coveredPaths,
      failedPaths: pathCoverage.failedPaths,
      uncoveredPaths: pathCoverage.uncoveredPaths,
      reason: lastError || "The child runtime failed before the objective could be closed.",
    };
    emitUpdate({
      status: finalStatus,
      completedAt: Date.now(),
      summary: finalSummary,
      error: lastError,
      evidenceCount: substantiveEvidence.length,
      observationCount: compactedEvidence.length,
      substantiveEvidenceCount: substantiveEvidence.length,
      closureState,
      remainingWork,
      progress: {
        phase: "done",
        title: finalStatus === "canceled"
          ? language === "zh" ? "已取消" : "Canceled"
          : language === "zh" ? "执行失败" : "Execution failed",
        completedToolCalls,
      },
    }, makeActivity(
      finalStatus === "canceled" ? "canceled" : "failed",
      finalStatus === "canceled"
        ? language === "zh" ? "用户已停止子智能体" : "Subagent stopped by the user"
        : language === "zh" ? "子智能体执行失败" : "Subagent execution failed",
      undefined,
      undefined,
      lastError,
    ));
    return {
      subagentId,
      name,
      scopeKey,
      status: finalStatus,
      summary: finalSummary,
      summaryTrust: "unverified_hypothesis",
      evidence: compactedEvidence,
      closureAudit,
      blocker: lastError,
      ...(finalStatus === "blocked" || finalStatus === "degraded" ? { remainingWork } : {}),
      error: lastError,
    };
  } finally {
    const closedAt = Date.now();
    const finalEvidence = compactEvidence(evidence);
    const finalSubstantiveEvidence = finalEvidence.filter(isSubagentEvidenceSubstantive);
    const finalPathCoverage = resolvePathCoverage();
    if (runtimeStartedAt !== null) {
      recordSubagentRuntimeSample({
        laneKey: policy.laneKey,
        startupMs: runtimeStartedAt - lifecycleStartedAt,
        capacityWaitMs: capacityQueuedAt == null ? 0 : runtimeStartedAt - capacityQueuedAt,
        successful: runtimeCompletedSuccessfully,
        recordedAt: closedAt,
      });
    }
    emitChildDebug("subagent_finished", {
      status: finalStatus,
      durationMs: closedAt - lifecycleStartedAt,
      completedToolCalls,
      observationCount: finalEvidence.length,
      evidenceCount: finalSubstantiveEvidence.length,
      substantiveEvidenceCount: finalSubstantiveEvidence.length,
      trustedEvidenceCount: finalSubstantiveEvidence.filter((item) =>
        item.provenance.source === "tool_observation"
      ).length,
      requiredPaths: finalPathCoverage.requiredPaths,
      coveredPaths: finalPathCoverage.coveredPaths,
      failedPaths: finalPathCoverage.failedPaths,
      uncoveredPaths: finalPathCoverage.uncoveredPaths,
      summaryTrust: "unverified_hypothesis",
      blocker: compactText(lastError, 300) || null,
      scopeLeaseActivated,
    });
    input.emitEvent(withEventSchema({
      type: "subagent.closed",
      threadId: snapshot.threadId,
      turnId: input.parentTurnId,
      timestampMs: closedAt,
      subagentId,
      closedAt,
      reason: finalStatus,
    }));
    input.parentSignal?.removeEventListener("abort", abortFromParent);
    unregisterSubagentAbortController(subagentId);
    releaseSubagentScopeLease(subagentId);
  }
}
