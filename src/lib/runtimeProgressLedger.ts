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

export interface RuntimeProgressProjection {
  latest: RuntimeProgressLedgerItem | null;
  recent: RuntimeProgressLedgerItem[];
  summary: string;
  activityText: string;
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
  if (/^(?:read_file|read_document|get_file_outline|analyze_tabular_document|query_tabular_document|knowledge_get_excerpt)$/i.test(tool)) {
    return "read";
  }
  if (/^(?:list_directory|get_project_skeleton|glob_search|grep_search|repo_map_status|repo_map_search|repo_map_context|repo_map_files|repo_map_impact|index_workspace_documents|knowledge_search)$/i.test(tool)) {
    return "search";
  }
  if (/^(?:write_file|replace_in_file|apply_patch|delete_workspace_path)$/i.test(tool)) return "edit";
  if (/^(?:run_command|execute_command|send_pty_input|read_pty_|get_pty_status|clear_pty_buffer)/i.test(tool)) return "command";
  if (/browser/i.test(tool)) return "browser";
  return tool || "progress";
}

function isCachedText(value: unknown): boolean {
  return /FILE_UNCHANGED_STUB|Repeated read-only tool call skipped/i.test(String(value || ""));
}

function compactPauseSummary(value: unknown, language: RuntimeProgressLanguage): string {
  const lines = String(value || "")
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  if (lines.length === 0) return "";

  const lead = lines.find((line) => /暂停|paused/i.test(line)) || lines[0];
  const recovery = lines.find((line) =>
    language === "zh"
      ? /建议恢复动作|下一步|可使用 Resume Execution|可从.*恢复执行/.test(line)
      : /suggested recovery|next|resume execution|continue from/i.test(line)
  );
  const summary = recovery && recovery !== lead
    ? `${lead} ${recovery}`
    : lead;
  return compactLine(summary, 220);
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
  const incomingIsAtLeastAsFresh = item.lastSeenAt >= existing.lastSeenAt;
  if (incomingIsAtLeastAsFresh) {
    existing.status = item.status;
    existing.title = item.title || existing.title;
    existing.summary = item.summary || existing.summary;
    existing.target = item.target || existing.target;
    existing.tool = item.tool || existing.tool;
    existing.phase = item.phase || existing.phase;
  } else {
    existing.title = existing.title || item.title;
    existing.summary = existing.summary || item.summary;
    existing.target = existing.target || item.target;
    existing.tool = existing.tool || item.tool;
    existing.phase = existing.phase || item.phase;
  }
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
  const status = normalizeStatus(progress.status);
  const title = compactLine(progress.title || titleForTool(tool, target, status, language), 160);
  if (!title && !target && !tool) return null;
  const rawSummary = progress.summary || progress.evidence || progress.action || progress.next || "";
  const summary = status === "paused"
    ? compactPauseSummary(rawSummary || progress.next || title, language)
    : compactLine(rawSummary, 220);
  return {
    key: keyForProgress({ phase: progress.phase, title, target, tool, dedupeKey: progress.dedupeKey }),
    phase: String(progress.phase || ""),
    title,
    status,
    summary,
    target,
    tool,
    firstSeenAt: timestampMs,
    lastSeenAt: timestampMs,
    repeatCount: Math.max(1, Number(progress.repeatCount) || 1),
    cacheHits: isCachedText(summary) ? 1 : 0,
  };
}

function itemFromHarnessTelemetry(
  event: MainThreadEvent,
  language: RuntimeProgressLanguage,
): Omit<RuntimeProgressLedgerItem, "repeatCount" | "cacheHits"> & { repeatCount?: number; cacheHits?: number } | null {
  if (event.type !== "harness.telemetry") return null;
  const name = String(event.telemetry?.name || "");
  if (name !== "no_chunk_progress_warning" && name !== "stream_error" && name !== "stream_cancelled") {
    return null;
  }
  const details = event.telemetry?.details || {};
  const streamId = compactLine(details.activeStreamId || "", 96);
  const elapsedMs = Math.max(0, Number(details.streamElapsedMs) || 0);
  const seconds = elapsedMs > 0 ? Math.round(elapsedMs / 1000) : null;
  const error = compactLine(details.lastStreamError || "", 180);
  const status: RuntimeProgressStatus =
    name === "stream_error" ? "failed" :
    name === "stream_cancelled" ? "paused" :
    "running";
  const title = language === "en"
    ? name === "stream_error"
      ? "Model stream error"
      : name === "stream_cancelled"
      ? "Model stream cancelled"
      : "Waiting for model output"
    : name === "stream_error"
    ? "模型流错误"
    : name === "stream_cancelled"
    ? "模型流已取消"
    : "等待模型继续输出";
  const summary = language === "en"
    ? name === "stream_error"
      ? `The model stream ended with an error${error ? `: ${error}` : "."}`
      : name === "stream_cancelled"
      ? "The current model stream was cancelled."
      : `Received the first stream chunk, but no newer chunk has arrived${seconds ? ` for ${seconds}s` : ""}. MAIN is waiting and will pause if the stream stays idle.`
    : name === "stream_error"
    ? `模型流以错误结束${error ? `：${error}` : "。"}`
    : name === "stream_cancelled"
    ? "当前模型流已取消。"
    : `已收到首个流式 chunk，但${seconds ? ` ${seconds} 秒内` : ""}没有新的输出；MAIN 正在等待，持续空闲会暂停本轮。`;
  return {
    key: `model-stream:${streamId || String((event as any).turnId || "") || name}`,
    phase: "blocked",
    title,
    status,
    summary: compactLine(summary, 260),
    target: "",
    tool: "",
    firstSeenAt: event.timestampMs,
    lastSeenAt: event.timestampMs,
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
    const summary = compactPauseSummary(block.content, language);
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
    } else if (event.type === "harness.telemetry") {
      const item = itemFromHarnessTelemetry(event, language);
      if (item) addItem(byKey, item);
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
  const effectiveItems = items.filter((item) => item.status !== "paused");
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
    if (latest.status === "paused" && effectiveItems.length === 0) {
      return latestText ? `paused: ${latestText}` : "paused";
    }
    return [
      `${effectiveItems.length} effective progress item${effectiveItems.length === 1 ? "" : "s"}`,
      repeated.length ? `repeated: ${repeated.join(", ")}` : "",
      latestText ? `${latest.status === "paused" ? "paused" : "latest"}: ${latestText}` : "",
    ].filter(Boolean).join("; ");
  }
  if (latest.status === "paused" && effectiveItems.length === 0) {
    return latestText ? `已暂停：${latestText}` : "已暂停";
  }
  return [
    `${effectiveItems.length} 条有效进展`,
    repeated.length ? `重复目标：${repeated.join("、")}` : "",
    latestText ? `${latest.status === "paused" ? "已暂停" : "最新"}：${latestText}` : "",
  ].filter(Boolean).join("；");
}

export function buildRuntimeProgressProjection(
  items: RuntimeProgressLedgerItem[],
  language: RuntimeProgressLanguage = "zh",
  maxRecent = 4,
): RuntimeProgressProjection {
  const normalizedLanguage = normalizeLanguage(language);
  const ordered = [...items].sort((a, b) => {
    const lastDiff = a.lastSeenAt - b.lastSeenAt;
    return lastDiff !== 0 ? lastDiff : a.firstSeenAt - b.firstSeenAt;
  });
  const latest = ordered[ordered.length - 1] || null;
  const recent = ordered.slice(-Math.max(1, maxRecent));
  const summary = summarizeRuntimeProgressLedger(items, normalizedLanguage);
  if (!latest) {
    return { latest: null, recent: [], summary: "", activityText: "" };
  }
  const repeatedText = latest.repeatCount > 1
    ? normalizedLanguage === "zh"
      ? `（重复 ${latest.repeatCount} 次${latest.cacheHits ? `，缓存复用 ${latest.cacheHits} 次` : ""}）`
      : ` (${latest.repeatCount}x${latest.cacheHits ? `, ${latest.cacheHits} cached` : ""})`
    : latest.cacheHits > 0
    ? normalizedLanguage === "zh"
      ? `（缓存复用 ${latest.cacheHits} 次）`
      : ` (${latest.cacheHits} cached)`
    : "";
  const detail = latest.summary && latest.summary !== latest.title ? latest.summary : "";
  const activityText = detail
    ? `${latest.title}${repeatedText} · ${detail}`
    : `${latest.title}${repeatedText}`;
  return {
    latest,
    recent,
    summary,
    activityText,
  };
}
