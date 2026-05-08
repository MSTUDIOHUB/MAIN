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

function buildToolCallLookup(messages: ContextMemoryMessage[]): Map<string, ToolCallSummary> {
  const lookup = new Map<string, ToolCallSummary>();
  for (const message of messages) {
    if (!Array.isArray(message.tool_calls)) continue;
    for (const toolCall of message.tool_calls) {
      const summary = extractToolCallSummary(toolCall);
      if (summary?.id) lookup.set(summary.id, summary);
    }
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
  return /(?:批准|确认|选择|决定|方案|执行|已完成|approved|confirmed|selected|decided|plan approved|execute|implemented|completed)/i.test(text);
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
  lookup: Map<string, ToolCallSummary>,
  updatedAt: number,
): { evidence?: ContextMemoryEntry; file?: ContextMemoryFileEntry; blocker?: ContextMemoryEntry; next?: ContextMemoryEntry } {
  if (message.role !== "tool") return {};
  const tool = message.tool_call_id ? lookup.get(message.tool_call_id) : undefined;
  const toolName = tool?.name || "tool";
  const args = tool?.args || {};
  const content = contextMemoryContentToText(message.content);
  const hash = stableContextHash(content).slice(0, 8);
  const path = readRecordString(args, ["path", "file", "target", "workspace", "cwd"]);
  const command = readRecordString(args, ["command", "cmd", "query", "pattern"]);
  const target = path || command;
  const baseSource = sourceFor(message, messageIndex, {
    toolName,
    ...(message.tool_call_id ? { toolCallId: message.tool_call_id } : {}),
    ...(path ? { path } : {}),
    hash,
  });
  const firstLines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 3)
    .join(" | ");
  const exitCode = content.match(/(?:exitCode|exit code|code)\D+(-?\d+)/i)?.[1];
  const status = /error|failed|rejected|timeout/i.test(content)
    ? "failed"
    : /no-op|no file change|matched the current file/i.test(content)
      ? "no-op"
      : /write_file|replace_in_file|delete_workspace_path/i.test(toolName)
        ? "changed"
        : "observed";
  const evidenceText = [
    `${toolName}${target ? ` ${compactLine(target, 120)}` : ""}`,
    `status=${status}`,
    exitCode ? `exit=${exitCode}` : "",
    `${content.length.toLocaleString()} chars`,
    `hash=${hash}`,
    firstLines ? `excerpt=${compactLine(firstLines, 180)}` : "",
  ].filter(Boolean).join("; ");

  const result: { evidence?: ContextMemoryEntry; file?: ContextMemoryFileEntry; blocker?: ContextMemoryEntry; next?: ContextMemoryEntry } = {
    evidence: entry(evidenceText, baseSource, updatedAt) || undefined,
  };
  if (path && /read_file|get_file_outline|write_file|replace_in_file|delete_workspace_path/i.test(toolName)) {
    const fileText = `${path} via ${toolName}; hash=${hash}; ${content.length.toLocaleString()} chars`;
    const fileEntry = entry(fileText, baseSource, updatedAt);
    if (fileEntry) result.file = { ...fileEntry, path, hash };
  }
  if (matchesBlocker(content)) {
    result.blocker = entry(`${toolName}${target ? ` ${target}` : ""}: ${compactLine(firstLines || content, 180)}`, baseSource, updatedAt) || undefined;
  }
  const suggestedNext = content.match(/suggestedNextTask:\s*([^\n]+)/i)?.[1]?.trim();
  if (suggestedNext) {
    result.next = entry(suggestedNext, baseSource, updatedAt) || undefined;
  }
  return result;
}

function extractCarryoverFromContextText(text: string, messageIndex: number, updatedAt: number): Partial<ContextMemoryState> {
  const source: ContextMemorySource = { role: "user", messageIndex };
  const carried: Partial<ContextMemoryState> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/^\s*[-*]\s*/, "").trim();
    if (!line || /^(\[?System:|ContextState|ContextMemoryState|Use this as compact)/i.test(line)) continue;
    const item = entry(line, source, updatedAt);
    if (!item) continue;
    if (/^Goal:/i.test(line)) carried.goals = [...(carried.goals || []), item];
    else if (/^Constraints?:/i.test(line)) carried.constraints = [...(carried.constraints || []), item];
    else if (/^Decisions?:/i.test(line)) carried.decisions = [...(carried.decisions || []), item];
    else if (/^Evidence:/i.test(line)) carried.evidence = [...(carried.evidence || []), item];
    else if (/^Files?:/i.test(line)) carried.files = [...(carried.files || []), { ...item, path: line }];
    else if (/^Recent failures|^Blockers?:/i.test(line)) carried.blockers = [...(carried.blockers || []), item];
    else if (/^Next:/i.test(line)) carried.nextSteps = [...(carried.nextSteps || []), item];
    else carried.progress = [...(carried.progress || []), item];
  }
  return carried;
}

function mergeEntries<T extends ContextMemoryEntry>(existing: T[] | undefined, incoming: T[] | undefined, limit: number): T[] {
  const byKey = new Map<string, T>();
  for (const item of [...(existing || []), ...(incoming || [])]) {
    const text = compactLine(item?.text);
    if (!text) continue;
    const key = normalizeLine(text);
    byKey.set(key, { ...item, text });
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

export function normalizeContextMemoryState(value: unknown): ContextMemoryState | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<ContextMemoryState>;
  if (candidate.version !== 1) return null;
  const now = Math.max(0, Number(candidate.updatedAt) || Date.now());
  const latest = candidate.latestUserRequest && typeof candidate.latestUserRequest === "object"
    ? normalizeEntryArray([candidate.latestUserRequest])[0]
    : undefined;
  return {
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
}

export function buildContextMemoryState(
  messages: ContextMemoryMessage[],
  options: BuildContextMemoryOptions = {},
): ContextMemoryState {
  const now = options.now ?? Date.now();
  const previous = normalizeContextMemoryState(options.previous);
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
      const request = entry(text, source, updatedAt);
      if (request) {
        collected.latestUserRequest = request;
        pushEntry(collected.goals, request);
      }
      for (const sentence of splitSentences(text)) {
        if (matchesConstraint(sentence)) pushEntry(collected.constraints, entry(sentence, source, updatedAt));
        if (matchesDecision(sentence)) pushEntry(collected.decisions, entry(sentence, source, updatedAt));
        if (matchesNextStep(sentence)) pushEntry(collected.nextSteps, entry(sentence, source, updatedAt));
        if (/\?$|？$/.test(sentence)) pushEntry(collected.openQuestions, entry(sentence, source, updatedAt));
      }
    } else if (message.role === "assistant") {
      if (!Array.isArray(message.tool_calls) || message.tool_calls.length === 0) {
        for (const sentence of splitSentences(text)) {
          if (matchesDecision(sentence)) pushEntry(collected.decisions, entry(sentence, source, updatedAt));
          if (matchesConstraint(sentence)) pushEntry(collected.constraints, entry(sentence, source, updatedAt));
          if (matchesNextStep(sentence)) pushEntry(collected.nextSteps, entry(sentence, source, updatedAt));
          if (matchesBlocker(sentence)) pushEntry(collected.blockers, entry(sentence, source, updatedAt));
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

  return {
    version: 1,
    id: previous?.id || `ctx-${now.toString(36)}-${stableContextHash(messages.map((message) => contextMemoryContentToText(message.content)).join("\n")).slice(0, 6)}`,
    updatedAt: now,
    ...(collected.latestUserRequest ? { latestUserRequest: collected.latestUserRequest } : {}),
    goals: mergeEntries(previous?.goals, collected.goals, limits.goals),
    constraints: mergeEntries(previous?.constraints, collected.constraints, limits.constraints),
    decisions: mergeEntries(previous?.decisions, collected.decisions, limits.decisions),
    progress: mergeEntries(previous?.progress, collected.progress, limits.progress),
    evidence: mergeEntries(previous?.evidence, collected.evidence, limits.evidence),
    files: mergeEntries(previous?.files, collected.files, limits.files),
    blockers: mergeEntries(previous?.blockers, collected.blockers, limits.blockers),
    nextSteps: mergeEntries(previous?.nextSteps, collected.nextSteps, limits.nextSteps),
    openQuestions: mergeEntries(previous?.openQuestions, collected.openQuestions, limits.openQuestions),
  };
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
