import type { MainThreadEvent, MainThreadProgressUpdate } from "./turnEvents";

export type RuntimeProgressLanguage = "zh" | "en";
export type RuntimeProgressStatus = "running" | "done" | "failed" | "paused" | "completed";

export interface RuntimeProgressLedgerItem {
  key: string;
  phase: string;
  title: string;
  status: RuntimeProgressStatus;
  summary: string;
  target: string;
  tool: string;
  repeatCount: number;
  cacheHits: number;
  firstSeenAt: number;
  lastSeenAt: number;
}

function compactLine(value: unknown, maxChars = 220): string {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  return text.length <= maxChars ? text : `${text.slice(0, maxChars - 3).trim()}...`;
}

function normalizeLanguage(language?: RuntimeProgressLanguage): RuntimeProgressLanguage {
  return language === "en" ? "en" : "zh";
}

function normalizeStatus(value: unknown): RuntimeProgressStatus {
  const status = String(value || "").toLowerCase();
  if (status === "failed" || status === "error") return "failed";
  if (status === "paused" || status === "blocked") return "paused";
  if (status === "completed") return "completed";
  if (status === "done" || status === "executed") return "done";
  return "running";
}

function normalizeTarget(value: unknown): string {
  return String(value || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .replace(/\/$/, "");
}

function compactTarget(value: unknown): string {
  const target = normalizeTarget(value);
  if (!target) return "";
  const parts = target.split("/").filter(Boolean);
  return compactLine(parts[parts.length - 1] || target, 72);
}

function toolFamily(tool: string): string {
  if (/^(?:read_file|read_document|get_file_outline|analyze_tabular_document|query_tabular_document)$/i.test(tool)) {
    return "read";
  }
  if (/^(?:list_directory|get_project_skeleton|glob_search|grep_search|index_workspace_documents)$/i.test(tool)) {
    return "search";
  }
  if (/^(?:write_file|replace_in_file|delete_workspace_path)$/i.test(tool)) return "edit";
  if (/^(?:run_command|execute_command|send_pty_input|read_pty_|get_pty_status|clear_pty_buffer)/i.test(tool)) return "command";
  if (/browser/i.test(tool)) return "browser";
  return tool || "progress";
}

function isCachedText(value: unknown): boolean {
  return /FILE_UNCHANGED_STUB|Repeated read-only tool call skipped/i.test(String(value || ""));
}

function titleForTool(tool: string, target: string, status: RuntimeProgressStatus, language: RuntimeProgressLanguage): string {
  const family = toolFamily(tool);
  const name = compactTarget(target) || (language === "zh" ? "当前工作区" : "current workspace");
  const done = status === "done" || status === "completed";
  const failed = status === "failed" || status === "paused";
  if (language === "en") {
    if (family === "read") return `${done ? "Read" : failed ? "Read blocked" : "Reading"} ${name}`;
    if (family === "search") return `${done ? "Searched" : failed ? "Search blocked" : "Searching"} ${name}`;
    if (family === "edit") return `${done ? "Edited" : failed ? "Edit blocked" : "Editing"} ${name}`;
    if (family === "command") return `${done ? "Ran" : failed ? "Command blocked" : "Running"} ${name}`;
    if (family === "browser") return `${done ? "Validated" : failed ? "Browser validation blocked" : "Validating"} ${name}`;
    return `${done ? "Used" : failed ? "Blocked" : "Using"} ${tool || name}`;
  }
  if (family === "read") return `${done ? "已读取" : failed ? "读取受阻" : "正在读取"} ${name}`;
  if (family === "search") return `${done ? "已搜索" : failed ? "搜索受阻" : "正在搜索"} ${name}`;
  if (family === "edit") return `${done ? "已编辑" : failed ? "编辑受阻" : "正在编辑"} ${name}`;
  if (family === "command") return `${done ? "已运行" : failed ? "命令受阻" : "正在运行"} ${name}`;
  if (family === "browser") return `${done ? "已验证" : failed ? "浏览器验证受阻" : "正在验证"} ${name}`;
  return `${done ? "已调用" : failed ? "调用受阻" : "正在调用"} ${tool || name}`;
}

function keyForProgress(input: {
  phase?: string;
  title?: string;
  target?: string;
  tool?: string;
  dedupeKey?: string;
}): string {
  const tool = String(input.tool || "").trim();
  const target = normalizeTarget(input.target || "");
  if (tool || target) return `${toolFamily(tool)}:${tool}:${target}`.toLowerCase();
  const explicit = compactLine(input.dedupeKey || "", 180);
  if (explicit) return explicit;
  return `progress:${String(input.phase || "").toLowerCase()}:${compactLine(input.title || "", 120).toLowerCase()}`;
}

function mergeStatus(left: RuntimeProgressStatus, right: RuntimeProgressStatus): RuntimeProgressStatus {
  if (right === "failed" || left === "failed") return "failed";
  if (right === "paused" || left === "paused") return "paused";
  if (right === "running") return "running";
  if (right === "completed" || left === "completed") return "completed";
  return "done";
}

function addItem(
  map: Map<string, RuntimeProgressLedgerItem>,
  item: Omit<RuntimeProgressLedgerItem, "repeatCount" | "cacheHits"> & {
    repeatCount?: number;
    cacheHits?: number;
  },
): void {
  const existing = map.get(item.key);
  if (!existing) {
    map.set(item.key, {
      ...item,
      repeatCount: Math.max(1, item.repeatCount || 1),
      cacheHits: Math.max(0, item.cacheHits || 0),
    });
    return;
  }
  existing.status = mergeStatus(existing.status, item.status);
  existing.title = item.title || existing.title;
  existing.summary = item.summary || existing.summary;
  existing.target = item.target || existing.target;
  existing.tool = item.tool || existing.tool;
  existing.phase = item.phase || existing.phase;
  existing.repeatCount += Math.max(1, item.repeatCount || 1);
  existing.cacheHits += Math.max(0, item.cacheHits || 0);
  existing.lastSeenAt = Math.max(existing.lastSeenAt, item.lastSeenAt);
}

function itemFromProgressEvent(
  progress: MainThreadProgressUpdate,
  timestampMs: number,
  language: RuntimeProgressLanguage,
): Omit<RuntimeProgressLedgerItem, "repeatCount" | "cacheHits"> & { repeatCount?: number; cacheHits?: number } | null {
  const target = normalizeTarget(progress.target || "");
  const tool = String(progress.tool || "").trim();
  const title = compactLine(progress.title || titleForTool(tool, target, normalizeStatus(progress.status), language), 160);
  if (!title && !target && !tool) return null;
  const summary = compactLine(progress.summary || progress.evidence || progress.action || progress.next || "", 220);
  return {
    key: keyForProgress({ phase: progress.phase, title, target, tool, dedupeKey: progress.dedupeKey }),
    phase: String(progress.phase || ""),
    title,
    status: normalizeStatus(progress.status),
    summary,
    target,
    tool,
    firstSeenAt: timestampMs,
    lastSeenAt: timestampMs,
    repeatCount: Math.max(1, Number(progress.repeatCount) || 1),
    cacheHits: isCachedText(summary) ? 1 : 0,
  };
}

function itemFromBlock(
  block: any,
  index: number,
  language: RuntimeProgressLanguage,
): Omit<RuntimeProgressLedgerItem, "repeatCount" | "cacheHits"> & { repeatCount?: number; cacheHits?: number } | null {
  const timestamp = Number(block?.createdAt || block?.updatedAt || index + 1);
  if (block?.type === "progress") {
    const target = normalizeTarget(block.target || block.targets?.[0] || "");
    const tool = String(block.toolName || "").trim();
    const title = compactLine(block.title || titleForTool(tool, target, normalizeStatus(block.status), language), 160);
    const summary = compactLine(block.observedFact || block.evidence || block.action || block.next || block.why || "", 220);
    return {
      key: keyForProgress({ phase: block.phase, title, target, tool, dedupeKey: block.dedupeKey }),
      phase: String(block.phase || ""),
      title,
      status: normalizeStatus(block.status),
      summary,
      target,
      tool,
      firstSeenAt: timestamp,
      lastSeenAt: timestamp,
      cacheHits: isCachedText(summary) ? 1 : 0,
    };
  }
  if (block?.type === "tool") {
    const tool = String(block.toolName || "").trim();
    const target = normalizeTarget(block.target || "");
    const status = normalizeStatus(block.toolStatus || block.status);
    const text = [block.observationSummary, block.evidence, block.message].map((value) => String(value || "")).find(Boolean) || "";
    return {
      key: keyForProgress({ target, tool }),
      phase: toolFamily(tool),
      title: titleForTool(tool, target, status, language),
      status,
      summary: compactLine(text, 220),
      target,
      tool,
      firstSeenAt: timestamp,
      lastSeenAt: timestamp,
      cacheHits: isCachedText(text) ? 1 : 0,
    };
  }
  if (block?.type === "system" && /暂停|paused|missing_tool_loop|no progress|重复/i.test(String(block.content || ""))) {
    const summary = compactLine(block.content, 260);
    return {
      key: `pause:${summary.slice(0, 80).toLowerCase()}`,
      phase: "blocked",
      title: language === "zh" ? "运行已暂停" : "Run paused",
      status: "paused",
      summary,
      target: "",
      tool: "",
      firstSeenAt: timestamp,
      lastSeenAt: timestamp,
    };
  }
  return null;
}

export function buildRuntimeProgressLedger(input: {
  blocks?: any[];
  events?: MainThreadEvent[];
  turnId?: string;
  language?: RuntimeProgressLanguage;
  maxItems?: number;
}): RuntimeProgressLedgerItem[] {
  const language = normalizeLanguage(input.language);
  const byKey = new Map<string, RuntimeProgressLedgerItem>();
  const turnId = String(input.turnId || "");
  (input.blocks || []).forEach((block, index) => {
    if (turnId && String(block?.turnId || "") && String(block.turnId) !== turnId) return;
    const item = itemFromBlock(block, index, language);
    if (item) addItem(byKey, item);
  });
  for (const event of input.events || []) {
    if (turnId && String((event as any).turnId || "") && String((event as any).turnId) !== turnId) continue;
    if (event.type === "progress.updated") {
      const item = itemFromProgressEvent(event.progress, event.timestampMs, language);
      if (item) addItem(byKey, item);
    } else if (event.type === "run.paused") {
      const progressItem = event.progress
        ? itemFromProgressEvent(event.progress, event.timestampMs, language)
        : null;
      if (progressItem) {
        addItem(byKey, { ...progressItem, status: "paused" });
      } else {
        addItem(byKey, {
          key: `pause:${compactLine(event.reason || event.message, 100).toLowerCase()}`,
          phase: "blocked",
          title: language === "zh" ? "运行已暂停" : "Run paused",
          status: "paused",
          summary: compactLine(event.message, 260),
          target: "",
          tool: "",
          firstSeenAt: event.timestampMs,
          lastSeenAt: event.timestampMs,
        });
      }
    }
  }
  const items = [...byKey.values()]
    .sort((a, b) => a.firstSeenAt - b.firstSeenAt);
  const maxItems = Math.max(1, Number(input.maxItems) || 12);
  return items.length <= maxItems ? items : items.slice(items.length - maxItems);
}

export function summarizeRuntimeProgressLedger(
  items: RuntimeProgressLedgerItem[],
  language: RuntimeProgressLanguage = "zh",
): string {
  if (items.length === 0) return "";
  const normalizedLanguage = normalizeLanguage(language);
  const repeated = items
    .filter((item) => item.repeatCount > 1 || item.cacheHits > 0)
    .slice(-3)
    .map((item) => {
      const target = compactTarget(item.target) || item.title;
      if (normalizedLanguage === "en") {
        return `${target} x${item.repeatCount}${item.cacheHits ? ` (${item.cacheHits} cached)` : ""}`;
      }
      return `${target} ×${item.repeatCount}${item.cacheHits ? `（${item.cacheHits} 次缓存复用）` : ""}`;
    });
  const latest = items[items.length - 1];
  const latestText = latest.summary || latest.title;
  if (normalizedLanguage === "en") {
    return [
      `${items.length} effective progress item${items.length > 1 ? "s" : ""}`,
      repeated.length ? `repeated: ${repeated.join(", ")}` : "",
      latestText ? `latest: ${latestText}` : "",
    ].filter(Boolean).join("; ");
  }
  return [
    `${items.length} 条有效进展`,
    repeated.length ? `重复目标：${repeated.join("、")}` : "",
    latestText ? `最新：${latestText}` : "",
  ].filter(Boolean).join("；");
}
