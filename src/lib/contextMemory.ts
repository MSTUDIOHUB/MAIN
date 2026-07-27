import { looksLikeSyntheticContinuationText } from "./syntheticContinuation";
import { parseToolFeedbackEnvelope } from "./toolFeedbackEnvelope";
import { extractPrimaryUserRequestText } from "./turnIntake";

export type ContextMemoryRole = "system" | "user" | "assistant" | "tool";

export interface ContextMemoryContentPart {
  type: string;
  text?: string;
  image_url?: { url?: string };
}

export interface ContextMemoryMessage {
  role: ContextMemoryRole;
  content: string | ContextMemoryContentPart[];
  tool_calls?: unknown[];
  tool_call_id?: string;
  reasoning_content?: string;
  reasoning?: string;
}

export interface ContextMemorySource {
  role?: ContextMemoryRole;
  turnId?: string;
  messageIndex?: number;
  toolName?: string;
  toolCallId?: string;
  path?: string;
  hash?: string;
}

export interface ContextMemoryEntry {
  text: string;
  source: ContextMemorySource;
  updatedAt: number;
}

export interface ContextMemoryFileEntry extends ContextMemoryEntry {
  path: string;
  hash?: string;
}

export interface ContextMemoryState {
  version: 1;
  id: string;
  updatedAt: number;
  latestUserRequest?: ContextMemoryEntry;
  goals: ContextMemoryEntry[];
  constraints: ContextMemoryEntry[];
  decisions: ContextMemoryEntry[];
  progress: ContextMemoryEntry[];
  evidence: ContextMemoryEntry[];
  files: ContextMemoryFileEntry[];
  blockers: ContextMemoryEntry[];
  nextSteps: ContextMemoryEntry[];
  openQuestions: ContextMemoryEntry[];
}

interface ToolCallSummary {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface BuildContextMemoryOptions {
  previous?: ContextMemoryState | null;
  turnId?: string | null;
  now?: number;
  maxEntriesPerBucket?: number;
}

const DEFAULT_BUCKET_LIMITS = {
  goals: 4,
  constraints: 8,
  decisions: 8,
  progress: 10,
  evidence: 14,
  files: 14,
  blockers: 6,
  nextSteps: 6,
  openQuestions: 6,
};

const CONTEXT_MEMORY_MAX_CHARS = 3600;

export function stableContextHash(input: string): string {
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function compactLine(value: unknown, maxChars = 220): string {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  return text.length <= maxChars ? text : `${text.slice(0, maxChars).trim()}...`;
}

function normalizeLine(value: unknown): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[，。！？；：,.!?;:、"'“”‘’`*_~\-\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function stripTrailingSourceTag(text: string): string {
  return String(text || "")
    .replace(/(?:\s+\[[^\]\n]{1,180}\]\s*)+$/g, "")
    .trim();
}

function stripContextMemoryLabel(text: string): string {
  return stripTrailingSourceTag(String(text || ""))
    .replace(
      /^(?:Goal|Goals|Hard constraints|Constraints|Decisions|Progress|Evidence|Verified evidence|Files|Relevant files|Recent failures|Blockers|Next|Next steps|Open questions)\s*:?\s*/i,
      "",
    )
    .trim();
}

function isBareContextMemorySection(text: string): boolean {
  const stripped = stripTrailingSourceTag(String(text || "")).trim();
  return /^(?:Goal|Goals|Hard constraints|Constraints|Decisions|Progress|Evidence|Verified evidence|Files|Relevant files|Recent failures|Blockers|Next|Next steps|Open questions)\s*:?\s*$/i.test(stripped);
}

function isSyntheticDurableEntryText(text: string): boolean {
  const compacted = stripTrailingSourceTag(String(text || ""));
  if (!compacted) return false;
  if (isBareContextMemorySection(compacted)) return true;
  const stripped = stripContextMemoryLabel(compacted);
  if (!stripped) return true;
  if (/\[\/?turn_intake\]|^workflowMode\s*:|^imageParts\s*:|^mentionedFiles\s*:|^attachedFiles\s*:|^priority\s*:/i.test(stripped)) {
    return true;
  }
  return looksLikeSyntheticContinuationText(stripped || compacted);
}

export function contextMemoryContentToText(content: ContextMemoryMessage["content"]): string {
  if (typeof content === "string") return content;
  return content
    .map((part) => part.type === "text" ? part.text || "" : "[image]")
    .filter(Boolean)
    .join("\n");
}

export function isContextMemoryText(text: unknown): boolean {
  const value = String(text ?? "").trim();
  return (
    value.startsWith("[System: ContextState") ||
    value.includes("ContextMemoryState v1") ||
    value.startsWith("[System: Earlier context has been summarized") ||
    value.startsWith("[System: 较早对话已压缩。")
  );
}

export function isContextMemoryMessage(message: Pick<ContextMemoryMessage, "role" | "content">): boolean {
  return message.role === "user" && isContextMemoryText(contextMemoryContentToText(message.content as ContextMemoryMessage["content"]));
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "string" || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function readRecordString(record: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function extractToolCallSummary(toolCall: unknown): ToolCallSummary | null {
  const candidate = toolCall as {
    id?: unknown;
    name?: unknown;
    arguments?: unknown;
    function?: { name?: unknown; arguments?: unknown };
  };
  const id = typeof candidate.id === "string" ? candidate.id : "";
  const name =
    typeof candidate.function?.name === "string"
      ? candidate.function.name
      : typeof candidate.name === "string"
        ? candidate.name
        : "";
  const rawArgs =
    typeof candidate.function?.arguments === "string"
      ? candidate.function.arguments
      : typeof candidate.arguments === "string"
        ? candidate.arguments
        : "";
  if (!id && !name) return null;
  return { id, name: name || "tool_call", args: parseJsonObject(rawArgs) };
}

function buildToolCallLookup(messages: ContextMemoryMessage[]): Map<number, ToolCallSummary> {
  const lookup = new Map<number, ToolCallSummary>();
  const pendingById = new Map<string, ToolCallSummary[]>();
  const latestById = new Map<string, ToolCallSummary>();

  for (let messageIndex = 0; messageIndex < messages.length; messageIndex += 1) {
    const message = messages[messageIndex];
    if (Array.isArray(message.tool_calls)) {
      for (const toolCall of message.tool_calls) {
        const summary = extractToolCallSummary(toolCall);
        if (!summary?.id) continue;
        const pending = pendingById.get(summary.id) || [];
        pending.push(summary);
        pendingById.set(summary.id, pending);
        latestById.set(summary.id, summary);
      }
    }

    if (message.role !== "tool" || !message.tool_call_id) continue;
    const pending = pendingById.get(message.tool_call_id) || [];
    const matched = pending.shift() || latestById.get(message.tool_call_id);
    if (pending.length > 0) pendingById.set(message.tool_call_id, pending);
    else pendingById.delete(message.tool_call_id);
    if (matched) lookup.set(messageIndex, matched);
  }
  return lookup;
}

function splitSentences(text: string): string[] {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return [];
  return (normalized.match(/[^。！？.!?\n]+[。！？.!?]?/g) || [normalized])
    .map((part) => compactLine(part, 220))
    .filter(Boolean);
}

function sourceFor(message: ContextMemoryMessage, messageIndex: number, extra: Partial<ContextMemorySource> = {}): ContextMemorySource {
  return {
    role: message.role,
    messageIndex,
    ...(message.tool_call_id ? { toolCallId: message.tool_call_id } : {}),
    ...extra,
  };
}

function entry(text: string, source: ContextMemorySource, updatedAt: number): ContextMemoryEntry | null {
  const compacted = compactLine(text);
  return compacted ? { text: compacted, source, updatedAt } : null;
}

function pushEntry(list: ContextMemoryEntry[], item: ContextMemoryEntry | null): void {
  if (!item) return;
  list.push(item);
}

function pushFileEntry(list: ContextMemoryFileEntry[], item: ContextMemoryFileEntry | null): void {
  if (!item) return;
  list.push(item);
}

function matchesConstraint(text: string): boolean {
  return /(?:必须|不要|不能|禁止|只(?:能|保存)|保留|避免|优先|假设|约束|must|never|do not|don't|only|preserve|avoid|assumption|constraint|requirement|should not)/i.test(text);
}

function matchesDecision(text: string): boolean {
  return /(?:批准|确认|选择|决定|已批准|已确认|approved|confirmed|selected|decided|plan approved)/i.test(text);
}

function matchesBlocker(text: string): boolean {
  return /(?:失败|错误|阻塞|无法|缺失|异常|failed|error|blocked|missing|exception|rejected|timeout)/i.test(text);
}

function matchesNextStep(text: string): boolean {
  return /(?:下一步|继续|随后|待办|需要|next|continue|todo|follow up|remaining)/i.test(text);
}

function extractCheckboxProgress(text: string, source: ContextMemorySource, updatedAt: number): ContextMemoryEntry[] {
  const matches = Array.from(text.matchAll(/^\s*[-*]\s+\[([ xX-])\]\s+(.+)$/gm));
  if (!matches.length) return [];
  const completed = matches.filter((match) => /x/i.test(match[1] || "")).length;
  const next = matches
    .filter((match) => !/x/i.test(match[1] || ""))
    .slice(0, 4)
    .map((match) => compactLine(match[2] || "", 120))
    .filter(Boolean);
  const summary = `Checklist progress ${completed}/${matches.length}${next.length ? `; next ${next.join(" | ")}` : ""}`;
  const item = entry(summary, source, updatedAt);
  return item ? [item] : [];
}

function extractToolEvidence(
  message: ContextMemoryMessage,
  messageIndex: number,
  lookup: Map<number, ToolCallSummary>,
  updatedAt: number,
): { evidence?: ContextMemoryEntry; file?: ContextMemoryFileEntry; blocker?: ContextMemoryEntry; next?: ContextMemoryEntry } {
  if (message.role !== "tool") return {};
  const tool = lookup.get(messageIndex);
  const content = contextMemoryContentToText(message.content);
  const parsedFeedback = parseToolFeedbackEnvelope(content);
  const feedback = parsedFeedback?.envelope;
  const body = parsedFeedback ? parsedFeedback.body : content;
  const toolName = feedback?.tool || tool?.name || "tool";
  const args = tool?.args || {};
  const contentForMemory = body || content;
  const hash = stableContextHash(contentForMemory).slice(0, 8);
  const feedbackTarget = String(feedback?.target || "").trim();
  const feedbackPath = feedbackTarget && /^(?:\.{0,2}\/|[A-Za-z0-9_.-]+\/|[A-Za-z0-9_.-]+\.[A-Za-z0-9]+$)/.test(feedbackTarget)
    ? feedbackTarget
    : "";
  const path = feedbackPath || readRecordString(args, ["path", "file", "target", "workspace", "cwd"]);
  const command = !path
    ? feedbackTarget || readRecordString(args, ["command", "cmd", "query", "pattern"])
    : "";
  const target = path || command;
  const baseSource = sourceFor(message, messageIndex, {
    toolName,
    ...(message.tool_call_id ? { toolCallId: message.tool_call_id } : {}),
    ...(path ? { path } : {}),
    hash,
  });
  const firstLines = contentForMemory
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 3)
    .join(" | ");
  const exitCode = contentForMemory.match(/(?:exitCode|exit code|code)\D+(-?\d+)/i)?.[1];
  const feedbackStatus = feedback?.status || "";
  const status = /failed|declined|blocked/i.test(feedbackStatus)
    ? "failed"
    : /no_effect_mutation|no_op|cached/i.test(feedbackStatus) || /no-op|no file change|matched the current file/i.test(contentForMemory)
      ? "no-op"
      : /error|failed|rejected|timeout/i.test(contentForMemory)
        ? "failed"
      : /write_file|replace_in_file|delete_workspace_path/i.test(toolName)
        ? "changed"
        : "observed";
  const resultSummary = compactLine(feedback?.summary || "", 180);
  const evidenceText = [
    `${toolName}${target ? ` ${compactLine(target, 120)}` : ""}`,
    `status=${status}`,
    exitCode ? `exit=${exitCode}` : "",
    `${contentForMemory.length.toLocaleString()} chars`,
    `hash=${hash}`,
    resultSummary ? `summary=${resultSummary}` : firstLines ? `excerpt=${compactLine(firstLines, 180)}` : "",
  ].filter(Boolean).join("; ");

  const result: { evidence?: ContextMemoryEntry; file?: ContextMemoryFileEntry; blocker?: ContextMemoryEntry; next?: ContextMemoryEntry } = {
    evidence: entry(evidenceText, baseSource, updatedAt) || undefined,
  };
  if (path && status !== "failed" && /read_file|get_file_outline|write_file|replace_in_file|delete_workspace_path/i.test(toolName)) {
    const fileText = `${path} via ${toolName}; hash=${hash}; ${contentForMemory.length.toLocaleString()} chars`;
    const fileEntry = entry(fileText, baseSource, updatedAt);
    if (fileEntry) result.file = { ...fileEntry, path, hash };
  }
  if (matchesBlocker(contentForMemory) || status === "failed") {
    result.blocker = entry(`${toolName}${target ? ` ${target}` : ""}: ${compactLine(resultSummary || firstLines || contentForMemory, 180)}`, baseSource, updatedAt) || undefined;
  }
  const suggestedNext = contentForMemory.match(/suggestedNextTask:\s*([^\n]+)/i)?.[1]?.trim();
  if (suggestedNext) {
    result.next = entry(suggestedNext, baseSource, updatedAt) || undefined;
  }
  return result;
}

type CarryoverBucket =
  | "goals"
  | "constraints"
  | "decisions"
  | "progress"
  | "evidence"
  | "files"
  | "blockers"
  | "nextSteps"
  | "openQuestions";

function carryoverBucketForLabel(label: string): CarryoverBucket | "latestUserRequest" | null {
  const normalized = label.replace(/\s+/g, " ").trim().toLowerCase();
  if (normalized === "latest user request") return "latestUserRequest";
  if (normalized === "goal" || normalized === "goals") return "goals";
  if (normalized === "hard constraints" || normalized === "constraint" || normalized === "constraints") return "constraints";
  if (normalized === "decision" || normalized === "decisions") return "decisions";
  if (normalized === "progress") return "progress";
  if (normalized === "evidence" || normalized === "verified evidence") return "evidence";
  if (normalized === "file" || normalized === "files" || normalized === "relevant files") return "files";
  if (normalized === "blocker" || normalized === "blockers" || normalized === "recent failures") return "blockers";
  if (normalized === "next" || normalized === "next step" || normalized === "next steps") return "nextSteps";
  if (normalized === "open question" || normalized === "open questions") return "openQuestions";
  return null;
}

function parseCarryoverLine(rawLine: string, currentBucket: CarryoverBucket | null): {
  bucket: CarryoverBucket | "latestUserRequest" | null;
  text: string;
  headerOnly: boolean;
} {
  const withoutBullet = String(rawLine || "").replace(/^\s*[-*]\s*/, "").trim();
  const line = stripTrailingSourceTag(withoutBullet);
  if (!line || /^(\[?System:|ContextState|ContextMemoryState|Use this as compact|Operational rule)/i.test(line)) {
    return { bucket: currentBucket, text: "", headerOnly: true };
  }
  const labeled = line.match(/^(Latest user request|Goal|Goals|Hard constraints|Constraints|Decisions|Progress|Verified evidence|Evidence|Relevant files|Files|Recent failures|Blockers|Next steps|Next|Open questions)\s*:?\s*(.*)$/i);
  if (labeled) {
    const bucket = carryoverBucketForLabel(labeled[1] || "");
    const text = stripTrailingSourceTag(labeled[2] || "").trim();
    return { bucket, text, headerOnly: !text };
  }
  return { bucket: currentBucket, text: line, headerOnly: false };
}

function extractCarryoverFromContextText(text: string, messageIndex: number, updatedAt: number): Partial<ContextMemoryState> {
  const source: ContextMemorySource = { role: "user", messageIndex };
  const carried: Partial<ContextMemoryState> = {};
  let currentBucket: CarryoverBucket | null = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const parsed = parseCarryoverLine(rawLine, currentBucket);
    if (parsed.bucket && parsed.bucket !== "latestUserRequest") currentBucket = parsed.bucket;
    if (parsed.headerOnly || !parsed.text) continue;
    const line = parsed.text;
    const item = entry(line, source, updatedAt);
    if (!item) continue;
    const bucket = parsed.bucket || "progress";
    if (bucket === "latestUserRequest") {
      if (!isSyntheticDurableEntryText(line)) carried.latestUserRequest = item;
    }
    else if (bucket === "goals") {
      if (!isSyntheticDurableEntryText(line)) carried.goals = [...(carried.goals || []), item];
    }
    else if (bucket === "constraints") {
      if (!isSyntheticDurableEntryText(line)) carried.constraints = [...(carried.constraints || []), item];
    }
    else if (bucket === "decisions") {
      if (!isSyntheticDurableEntryText(line)) carried.decisions = [...(carried.decisions || []), item];
    }
    else if (bucket === "evidence") carried.evidence = [...(carried.evidence || []), item];
    else if (bucket === "files") carried.files = [...(carried.files || []), { ...item, path: line }];
    else if (bucket === "blockers") carried.blockers = [...(carried.blockers || []), item];
    else if (bucket === "nextSteps") {
      if (!isSyntheticDurableEntryText(line)) carried.nextSteps = [...(carried.nextSteps || []), item];
    }
    else if (bucket === "openQuestions") {
      if (!isSyntheticDurableEntryText(line)) carried.openQuestions = [...(carried.openQuestions || []), item];
    }
    else if (!isSyntheticDurableEntryText(line)) {
      carried.progress = [...(carried.progress || []), item];
    }
  }
  return carried;
}

function mergeEntries<T extends ContextMemoryEntry>(existing: T[] | undefined, incoming: T[] | undefined, limit: number): T[] {
  const byKey = new Map<string, T>();
  for (const item of [...(existing || []), ...(incoming || [])]) {
    const text = compactLine(stripTrailingSourceTag(item?.text || ""));
    if (!text || isSyntheticDurableEntryText(text)) continue;
    const key = normalizeLine(text);
    byKey.set(key, { ...item, text });
  }
  return Array.from(byKey.values())
    .sort((a, b) => (a.updatedAt || 0) - (b.updatedAt || 0))
    .slice(-limit);
}

function evidenceMergeKey(item: ContextMemoryEntry): string {
  const toolName = String(item.source?.toolName || "").toLowerCase();
  const path = String(item.source?.path || "").trim();
  if (path && /^(?:read_file|get_file_outline|read_document|analyze_tabular_document|query_tabular_document)$/.test(toolName)) {
    return `${toolName}:${normalizeLine(path)}:observed`;
  }
  return normalizeLine(stripTrailingSourceTag(item.text));
}

function mergeEvidenceEntries(existing: ContextMemoryEntry[] | undefined, incoming: ContextMemoryEntry[] | undefined, limit: number): ContextMemoryEntry[] {
  const byKey = new Map<string, ContextMemoryEntry>();
  for (const item of [...(existing || []), ...(incoming || [])]) {
    const text = compactLine(stripTrailingSourceTag(item?.text || ""));
    if (!text) continue;
    byKey.set(evidenceMergeKey({ ...item, text }), { ...item, text });
  }
  return Array.from(byKey.values())
    .sort((a, b) => (a.updatedAt || 0) - (b.updatedAt || 0))
    .slice(-limit);
}

function mergeFileEntries(existing: ContextMemoryFileEntry[] | undefined, incoming: ContextMemoryFileEntry[] | undefined, limit: number): ContextMemoryFileEntry[] {
  const byKey = new Map<string, ContextMemoryFileEntry>();
  for (const item of [...(existing || []), ...(incoming || [])]) {
    const path = compactLine(stripTrailingSourceTag(item?.path || item?.source?.path || item?.text || ""));
    const text = compactLine(stripTrailingSourceTag(item?.text || path));
    if (!path || !text) continue;
    byKey.set(normalizeLine(path), { ...item, path, text });
  }
  return Array.from(byKey.values())
    .sort((a, b) => (a.updatedAt || 0) - (b.updatedAt || 0))
    .slice(-limit);
}

function normalizeEntryArray(value: unknown): ContextMemoryEntry[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const candidate = item as Partial<ContextMemoryEntry>;
      const text = compactLine(candidate.text);
      if (!text) return null;
      return {
        text,
        source: candidate.source && typeof candidate.source === "object" ? candidate.source : {},
        updatedAt: Math.max(0, Number(candidate.updatedAt) || Date.now()),
      } as ContextMemoryEntry;
    })
    .filter((item): item is ContextMemoryEntry => Boolean(item));
}

function normalizeFileArray(value: unknown): ContextMemoryFileEntry[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const candidate = item as Partial<ContextMemoryFileEntry>;
      const path = compactLine(candidate.path || candidate.source?.path || candidate.text, 220);
      const text = compactLine(candidate.text || path, 220);
      if (!path || !text) return null;
      return {
        text,
        path,
        ...(candidate.hash ? { hash: String(candidate.hash) } : {}),
        source: candidate.source && typeof candidate.source === "object" ? candidate.source : {},
        updatedAt: Math.max(0, Number(candidate.updatedAt) || Date.now()),
      } as ContextMemoryFileEntry;
    })
    .filter((item): item is ContextMemoryFileEntry => Boolean(item));
}

function sanitizeDurableEntries(entries: ContextMemoryEntry[] | undefined): ContextMemoryEntry[] {
  return (entries || [])
    .map((item) => ({ ...item, text: compactLine(stripTrailingSourceTag(item.text)) }))
    .filter((item) => item.text && !isSyntheticDurableEntryText(item.text));
}

function sanitizeContextMemoryState(state: ContextMemoryState | null): ContextMemoryState | null {
  if (!state) return null;
  const latestUserRequest =
    state.latestUserRequest && !isSyntheticDurableEntryText(state.latestUserRequest.text)
      ? state.latestUserRequest
      : undefined;
  return {
    ...state,
    ...(latestUserRequest ? { latestUserRequest } : { latestUserRequest: undefined }),
    goals: sanitizeDurableEntries(state.goals),
    constraints: sanitizeDurableEntries(state.constraints),
    decisions: sanitizeDurableEntries(state.decisions),
    nextSteps: sanitizeDurableEntries(state.nextSteps),
    openQuestions: sanitizeDurableEntries(state.openQuestions),
  };
}

export function normalizeContextMemoryState(value: unknown): ContextMemoryState | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<ContextMemoryState>;
  if (candidate.version !== 1) return null;
  const now = Math.max(0, Number(candidate.updatedAt) || Date.now());
  const latest = candidate.latestUserRequest && typeof candidate.latestUserRequest === "object"
    ? normalizeEntryArray([candidate.latestUserRequest])[0]
    : undefined;
  const normalized: ContextMemoryState = {
    version: 1,
    id: typeof candidate.id === "string" && candidate.id ? candidate.id : `ctx-${now.toString(36)}`,
    updatedAt: now,
    ...(latest ? { latestUserRequest: latest } : {}),
    goals: normalizeEntryArray(candidate.goals),
    constraints: normalizeEntryArray(candidate.constraints),
    decisions: normalizeEntryArray(candidate.decisions),
    progress: normalizeEntryArray(candidate.progress),
    evidence: normalizeEntryArray(candidate.evidence),
    files: normalizeFileArray(candidate.files),
    blockers: normalizeEntryArray(candidate.blockers),
    nextSteps: normalizeEntryArray(candidate.nextSteps),
    openQuestions: normalizeEntryArray(candidate.openQuestions),
  };
  return sanitizeContextMemoryState(normalized);
}

export function buildContextMemoryState(
  messages: ContextMemoryMessage[],
  options: BuildContextMemoryOptions = {},
): ContextMemoryState {
  const now = options.now ?? Date.now();
  const previous = sanitizeContextMemoryState(normalizeContextMemoryState(options.previous));
  const lookup = buildToolCallLookup(messages);
  const collected: Omit<ContextMemoryState, "version" | "id" | "updatedAt"> = {
    latestUserRequest: previous?.latestUserRequest,
    goals: [],
    constraints: [],
    decisions: [],
    progress: [],
    evidence: [],
    files: [],
    blockers: [],
    nextSteps: [],
    openQuestions: [],
  };

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    const text = contextMemoryContentToText(message.content);
    const updatedAt = now + index;
    if (!text.trim()) continue;

    if (isContextMemoryText(text)) {
      const carryover = extractCarryoverFromContextText(text, index, updatedAt);
      if (carryover.latestUserRequest) {
        collected.latestUserRequest = carryover.latestUserRequest;
      }
      collected.goals.push(...(carryover.goals || []));
      collected.constraints.push(...(carryover.constraints || []));
      collected.decisions.push(...(carryover.decisions || []));
      collected.progress.push(...(carryover.progress || []));
      collected.evidence.push(...(carryover.evidence || []));
      collected.files.push(...((carryover.files || []) as ContextMemoryFileEntry[]));
      collected.blockers.push(...(carryover.blockers || []));
      collected.nextSteps.push(...(carryover.nextSteps || []));
      continue;
    }

    const source = sourceFor(message, index, options.turnId ? { turnId: options.turnId } : {});
    if (message.role === "user") {
      const canonicalUserText = /\[turn_intake\]/i.test(text)
        ? extractPrimaryUserRequestText(text)
        : text;
      if (looksLikeSyntheticContinuationText(canonicalUserText)) continue;
      const request = entry(canonicalUserText, source, updatedAt);
      if (request) {
        collected.latestUserRequest = request;
        pushEntry(collected.goals, request);
      }
      for (const sentence of splitSentences(canonicalUserText)) {
        if (matchesConstraint(sentence)) pushEntry(collected.constraints, entry(sentence, source, updatedAt));
        if (matchesDecision(sentence)) pushEntry(collected.decisions, entry(sentence, source, updatedAt));
        if (matchesNextStep(sentence)) pushEntry(collected.nextSteps, entry(sentence, source, updatedAt));
        if (/\?$|？$/.test(sentence)) pushEntry(collected.openQuestions, entry(sentence, source, updatedAt));
      }
    } else if (message.role === "assistant") {
      if (!Array.isArray(message.tool_calls) || message.tool_calls.length === 0) {
        if (!looksLikeSyntheticContinuationText(text)) {
          for (const sentence of splitSentences(text)) {
            if (matchesNextStep(sentence)) pushEntry(collected.nextSteps, entry(sentence, source, updatedAt));
            if (matchesBlocker(sentence)) pushEntry(collected.blockers, entry(sentence, source, updatedAt));
          }
        }
        collected.progress.push(...extractCheckboxProgress(text, source, updatedAt));
      }
    } else if (message.role === "tool") {
      const extracted = extractToolEvidence(message, index, lookup, updatedAt);
      pushEntry(collected.evidence, extracted.evidence || null);
      pushFileEntry(collected.files, extracted.file || null);
      pushEntry(collected.blockers, extracted.blocker || null);
      pushEntry(collected.nextSteps, extracted.next || null);
    }
  }

  const explicitLimit = Number.isFinite(options.maxEntriesPerBucket)
    ? Math.max(2, Number(options.maxEntriesPerBucket))
    : 0;
  const limits = explicitLimit ? {
    goals: Math.min(DEFAULT_BUCKET_LIMITS.goals, explicitLimit),
    constraints: Math.min(DEFAULT_BUCKET_LIMITS.constraints, explicitLimit),
    decisions: Math.min(DEFAULT_BUCKET_LIMITS.decisions, explicitLimit),
    progress: Math.min(DEFAULT_BUCKET_LIMITS.progress, explicitLimit),
    evidence: Math.min(DEFAULT_BUCKET_LIMITS.evidence, explicitLimit),
    files: Math.min(DEFAULT_BUCKET_LIMITS.files, explicitLimit),
    blockers: Math.min(DEFAULT_BUCKET_LIMITS.blockers, explicitLimit),
    nextSteps: Math.min(DEFAULT_BUCKET_LIMITS.nextSteps, explicitLimit),
    openQuestions: Math.min(DEFAULT_BUCKET_LIMITS.openQuestions, explicitLimit),
  } : DEFAULT_BUCKET_LIMITS;

  const state: ContextMemoryState = {
    version: 1,
    id: previous?.id || `ctx-${now.toString(36)}-${stableContextHash(messages.map((message) => contextMemoryContentToText(message.content)).join("\n")).slice(0, 6)}`,
    updatedAt: now,
    ...(collected.latestUserRequest ? { latestUserRequest: collected.latestUserRequest } : {}),
    goals: mergeEntries(previous?.goals, collected.goals, limits.goals),
    constraints: mergeEntries(previous?.constraints, collected.constraints, limits.constraints),
    decisions: mergeEntries(previous?.decisions, collected.decisions, limits.decisions),
    progress: mergeEntries(previous?.progress, collected.progress, limits.progress),
    evidence: mergeEvidenceEntries(previous?.evidence, collected.evidence, limits.evidence),
    files: mergeFileEntries(previous?.files, collected.files, limits.files),
    blockers: mergeEntries(previous?.blockers, collected.blockers, limits.blockers),
    nextSteps: mergeEntries(previous?.nextSteps, collected.nextSteps, limits.nextSteps),
    openQuestions: mergeEntries(previous?.openQuestions, collected.openQuestions, limits.openQuestions),
  };
  return sanitizeContextMemoryState(state) || state;
}

function formatEntryList(label: string, entries: ContextMemoryEntry[], maxItems: number): string[] {
  const visible = entries.slice(-maxItems).map((item) => {
    const source = [
      item.source?.toolName,
      item.source?.path,
      item.source?.hash ? `hash=${item.source.hash}` : "",
      Number.isFinite(item.source?.messageIndex) ? `m${item.source.messageIndex}` : "",
    ].filter(Boolean).join(", ");
    return `- ${item.text}${source ? ` [${source}]` : ""}`;
  });
  return visible.length ? [label, ...visible] : [];
}

export function formatContextMemoryPacket(state: ContextMemoryState | null | undefined, maxChars = CONTEXT_MEMORY_MAX_CHARS): string {
  const memory = normalizeContextMemoryState(state);
  if (!memory) return "";
  const sections: string[] = [
    `[System: ContextState`,
    `ContextMemoryState v1 id=${memory.id} updatedAt=${memory.updatedAt}`,
  ];
  if (memory.latestUserRequest) sections.push(`Latest user request: ${memory.latestUserRequest.text}`);
  sections.push(...formatEntryList("Goals:", memory.goals, 3));
  sections.push(...formatEntryList("Hard constraints:", memory.constraints, 5));
  sections.push(...formatEntryList("Decisions:", memory.decisions, 4));
  sections.push(...formatEntryList("Progress:", memory.progress, 4));
  sections.push(...formatEntryList("Verified evidence:", memory.evidence, 6));
  sections.push(...formatEntryList("Relevant files:", memory.files, 6));
  sections.push(...formatEntryList("Blockers:", memory.blockers, 4));
  sections.push(...formatEntryList("Next steps:", memory.nextSteps, 4));
  sections.push(...formatEntryList("Open questions:", memory.openQuestions, 3));
  sections.push("Operational rule: this is compact task memory; re-read current files before editing when only hashes or excerpts are available.");
  sections.push("Use this as compact historical state only; prioritize the latest messages and current workspace evidence.]");
  const packet = sections.join("\n");
  if (packet.length <= maxChars) return packet;
  return `${packet.slice(0, maxChars).trim()}\n...[ContextMemory truncated to fit request budget]\n]`;
}

export function createContextMemoryMessage(state: ContextMemoryState | null | undefined): ContextMemoryMessage | null {
  const packet = formatContextMemoryPacket(state);
  return packet ? { role: "user", content: packet } : null;
}

export function stripContextMemoryMessages<T extends ContextMemoryMessage>(messages: T[]): T[] {
  return messages.filter((message) => !isContextMemoryMessage(message));
}

export function injectContextMemoryMessage<T extends ContextMemoryMessage>(
  messages: T[],
  state: ContextMemoryState | null | undefined,
): T[] {
  const memoryMessage = createContextMemoryMessage(state) as T | null;
  const withoutMemory = stripContextMemoryMessages(messages);
  if (!memoryMessage) return withoutMemory;
  const first = withoutMemory[0];
  if (first?.role === "system") {
    return [first, memoryMessage, ...withoutMemory.slice(1)];
  }
  return [memoryMessage, ...withoutMemory];
}

export function extractContextMemoryPacketFromMessages(messages: ContextMemoryMessage[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (isContextMemoryMessage(message)) return contextMemoryContentToText(message.content).trim();
  }
  return undefined;
}
