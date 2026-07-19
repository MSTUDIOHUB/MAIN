import type { MainThreadEvent, MainThreadProgressUpdate } from "./turnEvents";
import { toPlanExecutionRuntimeProgressUpdate } from "./planExecutionRecovery";
import type { PlanExecutionProgressSnapshot } from "./workflowModels";
import {
  isInternalRuntimeProgressBlock,
  isInternalRuntimeProgressUpdate,
} from "./runtimeProgressVisibility";

export type RuntimeProgressLanguage = "zh" | "en";
export type RuntimeProgressStatus = "running" | "done" | "failed" | "paused" | "completed";

export interface RuntimeProgressLedgerItem {
  key: string;
  runId: string;
  phase: string;
  title: string;
  status: RuntimeProgressStatus;
  summary: string;
  target: string;
  tool: string;
  sourceToolCallIds: string[];
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

export interface RunStatusHealthSignal {
  key: string;
  kind: "failure" | "pause" | "waiting" | "repetition";
  status: RuntimeProgressStatus;
  title: string;
  summary: string;
  lastSeenAt: number;
}

export interface RunStatusProjection {
  currentActivity: RuntimeProgressLedgerItem | null;
  milestones: RuntimeProgressLedgerItem[];
  healthSignals: RunStatusHealthSignal[];
  activityText: string;
}

type RuntimeProgressAggregation = "snapshot" | "occurrence";

type RuntimeProgressLedgerCandidate = Omit<
  RuntimeProgressLedgerItem,
  "repeatCount" | "cacheHits" | "sourceToolCallIds"
> & {
  repeatCount?: number;
  cacheHits?: number;
  sourceToolCallIds?: string[];
  aggregation?: RuntimeProgressAggregation;
};

type RuntimeProgressLedgerAccumulator = RuntimeProgressLedgerItem & {
  occurrenceCount: number;
  explicitRepeatCount: number;
  seenSourceToolCallIds: Set<string>;
  cachedSourceToolCallIds: Set<string>;
  legacyCacheHits: number;
  aggregation: RuntimeProgressAggregation;
};

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
  const normalized = String(value || "").trim().replace(/\\/g, "/");
  if (!normalized) return "";
  const scheme = normalized.match(/^([a-z][a-z0-9+.-]*:\/\/)(.*)$/i);
  if (scheme) return `${scheme[1]}${scheme[2].replace(/\/{2,}/g, "/").replace(/\/$/, "")}`;
  return normalized.replace(/\/{2,}/g, "/").replace(/\/$/, "");
}

function normalizeSourceToolCallIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(
    value.map((id) => String(id || "").trim()).filter(Boolean),
  )).slice(0, 12);
}

function compactTarget(value: unknown): string {
  const target = normalizeTarget(value);
  if (!target) return "";
  const parts = target.split("/").filter(Boolean);
  return compactLine(parts[parts.length - 1] || target, 72);
}

function toolFamily(tool: string): string {
  if (/^(?:read_file|read_document|get_file_outline|code_ast_query|git_status|git_diff|analyze_tabular_document|query_tabular_document|knowledge_get_excerpt)$/i.test(tool)) {
    return "read";
  }
  if (/^(?:list_directory|get_project_skeleton|glob_search|grep_search|find_symbol_references|repo_map_status|repo_map_search|repo_map_context|repo_map_files|repo_map_impact|index_workspace_documents|knowledge_search)$/i.test(tool)) {
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
  runId?: string;
  phase?: string;
  title?: string;
  target?: string;
  tool?: string;
  dedupeKey?: string;
}): string {
  const runId = compactLine(input.runId || "", 96).toLowerCase();
  const runPrefix = runId ? `run:${runId}:` : "legacy:";
  const tool = String(input.tool || "").trim();
  const target = normalizeTarget(input.target || "");
  if (tool || target) return `${runPrefix}${toolFamily(tool)}:${tool}:${target}`.toLowerCase();
  const explicit = compactLine(input.dedupeKey || "", 180);
  if (explicit) return `${runPrefix}${explicit}`;
  return `${runPrefix}progress:${String(input.phase || "").toLowerCase()}:${compactLine(input.title || "", 120).toLowerCase()}`;
}

function addItem(
  map: Map<string, RuntimeProgressLedgerAccumulator>,
  item: RuntimeProgressLedgerCandidate,
): void {
  const aggregation = item.aggregation === "occurrence" ? "occurrence" : "snapshot";
  const sourceToolCallIds = normalizeSourceToolCallIds(item.sourceToolCallIds);
  const explicitRepeatCount = Number.isFinite(Number(item.repeatCount))
    ? Math.max(0, Number(item.repeatCount) || 0)
    : 0;
  const occurrenceIncrement = sourceToolCallIds.length > 0
    ? sourceToolCallIds.length
    : aggregation === "occurrence"
    ? Math.max(1, explicitRepeatCount || 1)
    : 0;
  const existing = map.get(item.key);
  if (!existing) {
    const occurrenceCount = occurrenceIncrement;
    const cachedSourceToolCallIds = new Set(
      item.cacheHits ? sourceToolCallIds.slice(0, Math.max(1, item.cacheHits)) : [],
    );
    const legacyCacheHits = sourceToolCallIds.length > 0 ? 0 : Math.max(0, item.cacheHits || 0);
    map.set(item.key, {
      ...item,
      aggregation,
      sourceToolCallIds,
      repeatCount: Math.max(1, occurrenceCount, explicitRepeatCount),
      cacheHits: cachedSourceToolCallIds.size + legacyCacheHits,
      occurrenceCount,
      explicitRepeatCount,
      seenSourceToolCallIds: new Set(sourceToolCallIds),
      cachedSourceToolCallIds,
      legacyCacheHits,
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
  if (sourceToolCallIds.length > 0) {
    for (const sourceToolCallId of sourceToolCallIds) {
      if (!existing.seenSourceToolCallIds.has(sourceToolCallId)) {
        existing.seenSourceToolCallIds.add(sourceToolCallId);
        existing.occurrenceCount += 1;
      }
      if (item.cacheHits) existing.cachedSourceToolCallIds.add(sourceToolCallId);
    }
    existing.sourceToolCallIds = [...existing.seenSourceToolCallIds].slice(-12);
  } else {
    existing.occurrenceCount += occurrenceIncrement;
    existing.legacyCacheHits = aggregation === "occurrence"
      ? existing.legacyCacheHits + Math.max(0, item.cacheHits || 0)
      : Math.max(existing.legacyCacheHits, Math.max(0, item.cacheHits || 0));
  }
  existing.explicitRepeatCount = Math.max(existing.explicitRepeatCount, explicitRepeatCount);
  existing.repeatCount = Math.max(1, existing.occurrenceCount, existing.explicitRepeatCount);
  existing.cacheHits = existing.cachedSourceToolCallIds.size + existing.legacyCacheHits;
  existing.lastSeenAt = Math.max(existing.lastSeenAt, item.lastSeenAt);
}

function itemFromProgressEvent(
  progress: MainThreadProgressUpdate,
  timestampMs: number,
  language: RuntimeProgressLanguage,
  runId = "",
): RuntimeProgressLedgerCandidate | null {
  if (isInternalRuntimeProgressUpdate(progress)) return null;
  const target = normalizeTarget(progress.canonicalTarget || progress.target || "");
  const tool = String(progress.tool || "").trim();
  const sourceToolCallIds = normalizeSourceToolCallIds(progress.sourceToolCallIds);
  const status = normalizeStatus(progress.status);
  const title = compactLine(progress.title || titleForTool(tool, target, status, language), 160);
  if (!title && !target && !tool) return null;
  const rawSummary = progress.summary || progress.evidence || progress.action || progress.next || "";
  const summary = status === "paused"
    ? compactPauseSummary(rawSummary || progress.next || title, language)
    : compactLine(rawSummary, 220);
  return {
    key: keyForProgress({ runId, phase: progress.phase, title, target, tool, dedupeKey: progress.dedupeKey }),
    runId,
    phase: String(progress.phase || ""),
    title,
    status,
    summary,
    target,
    tool,
    sourceToolCallIds,
    firstSeenAt: timestampMs,
    lastSeenAt: timestampMs,
    ...(Number.isFinite(Number(progress.repeatCount)) && Number(progress.repeatCount) > 0
      ? { repeatCount: Number(progress.repeatCount) }
      : {}),
    cacheHits: isCachedText(summary) ? 1 : 0,
    aggregation: "snapshot",
  };
}

function itemFromHarnessTelemetry(
  event: MainThreadEvent,
  language: RuntimeProgressLanguage,
): RuntimeProgressLedgerCandidate | null {
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
  const runId = String((event as any).runId || "");
  return {
    key: `model-stream:${runId}:${streamId || String((event as any).turnId || "") || name}`,
    runId,
    phase: "blocked",
    title,
    status,
    summary: compactLine(summary, 260),
    target: "",
    tool: "",
    firstSeenAt: event.timestampMs,
    lastSeenAt: event.timestampMs,
    aggregation: "snapshot",
  };
}

function itemFromBlock(
  block: any,
  index: number,
  language: RuntimeProgressLanguage,
): RuntimeProgressLedgerCandidate | null {
  if (isInternalRuntimeProgressBlock(block)) return null;
  const timestamp = Number(block?.createdAt || block?.updatedAt || index + 1);
  const runId = String(block?.runId || "").trim();
  if (block?.type === "progress") {
    const target = normalizeTarget(block.canonicalTarget || block.target || block.targets?.[0] || "");
    const tool = String(block.tool || block.toolName || "").trim();
    const title = compactLine(block.title || titleForTool(tool, target, normalizeStatus(block.status), language), 160);
    const summary = compactLine(block.observedFact || block.evidence || block.action || block.next || block.why || "", 220);
    return {
      key: keyForProgress({ runId, phase: block.phase, title, target, tool, dedupeKey: block.dedupeKey }),
      runId,
      phase: String(block.phase || ""),
      title,
      status: normalizeStatus(block.status),
      summary,
      target,
      tool,
      sourceToolCallIds: normalizeSourceToolCallIds(block.sourceToolCallIds),
      firstSeenAt: timestamp,
      lastSeenAt: timestamp,
      cacheHits: isCachedText(summary) ? 1 : 0,
      aggregation: "snapshot",
    };
  }
  if (block?.type === "tool") {
    const tool = String(block.toolName || "").trim();
    const target = normalizeTarget(block.canonicalTarget || block.target || "");
    const status = normalizeStatus(block.toolStatus || block.status);
    const text = [block.observationSummary, block.evidence, block.message].map((value) => String(value || "")).find(Boolean) || "";
    return {
      key: keyForProgress({ runId, target, tool }),
      runId,
      phase: toolFamily(tool),
      title: titleForTool(tool, target, status, language),
      status,
      summary: compactLine(text, 220),
      target,
      tool,
      sourceToolCallIds: normalizeSourceToolCallIds([
        block.toolCallId || block.executionId || "",
      ]),
      firstSeenAt: timestamp,
      lastSeenAt: timestamp,
      cacheHits: isCachedText(text) ? 1 : 0,
      aggregation: "occurrence",
    };
  }
  if (block?.type === "system" && /暂停|paused|missing_tool_loop|no progress|重复/i.test(String(block.content || ""))) {
    const summary = compactPauseSummary(block.content, language);
    return {
      key: `pause:${runId}:${summary.slice(0, 80).toLowerCase()}`,
      runId,
      phase: "blocked",
      title: language === "zh" ? "运行已暂停" : "Run paused",
      status: "paused",
      summary,
      target: "",
      tool: "",
      firstSeenAt: timestamp,
      lastSeenAt: timestamp,
      aggregation: "snapshot",
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
  /** Restrict current effective progress to the active run when known. */
  activeRunId?: string | null;
  /** A live plan checkpoint bridges the approval-to-child-run handoff. */
  planExecutionSnapshot?: PlanExecutionProgressSnapshot | null;
}): RuntimeProgressLedgerItem[] {
  const language = normalizeLanguage(input.language);
  const byKey = new Map<string, RuntimeProgressLedgerAccumulator>();
  const turnId = String(input.turnId || "");
  const snapshotRunId = String(input.planExecutionSnapshot?.runId || "").trim();
  // During the approval handoff a paused parent marker is expected. The child
  // checkpoint is then the only current-run identity available to the UI.
  const activeRunId = String(input.activeRunId || snapshotRunId || "").trim();
  const hasLivePlanExecution = !!input.planExecutionSnapshot &&
    (!turnId || input.planExecutionSnapshot.turnId === turnId) &&
    (!activeRunId || !snapshotRunId || snapshotRunId === activeRunId);
  (input.blocks || []).forEach((block, index) => {
    if (turnId && String(block?.turnId || "") && String(block.turnId) !== turnId) return;
    // Live progress has a canonical run-owned event. Older transcript blocks
    // remain useful history but must not impersonate the currently executing
    // child run, especially across plan-review handoffs.
    if (activeRunId && String(block?.runId || "") !== activeRunId) return;
    // The review-run pause belongs to audit history, never to an already
    // approved execution checkpoint rendered as current progress.
    if (
      hasLivePlanExecution &&
      block?.type === "system" &&
      /暂停|paused|waiting.*review|等待审核/i.test(String(block.content || ""))
    ) {
      return;
    }
    const item = itemFromBlock(block, index, language);
    if (item) addItem(byKey, item);
  });
  for (const event of input.events || []) {
    if (turnId && String((event as any).turnId || "") && String((event as any).turnId) !== turnId) continue;
    const eventRunId = String((event as any).runId || "").trim();
    const isRunOwnedEvent = event.type === "progress.updated" ||
      event.type === "run.paused" ||
      event.type === "run.completed" ||
      event.type === "run.aborted" ||
      event.type === "run.failed" ||
      event.type === "harness.telemetry";
    if (activeRunId && isRunOwnedEvent && eventRunId !== activeRunId) continue;
    if (hasLivePlanExecution && event.type === "run.paused" && event.reason === "plan_review") continue;
    if (event.type === "progress.updated") {
      const item = itemFromProgressEvent(event.progress, event.timestampMs, language, eventRunId);
      if (item) addItem(byKey, item);
    } else if (event.type === "run.paused") {
      const progressItem = event.progress
        ? itemFromProgressEvent(event.progress, event.timestampMs, language, eventRunId)
        : null;
      if (progressItem) {
        addItem(byKey, { ...progressItem, status: "paused" });
      } else {
        addItem(byKey, {
          key: `pause:${eventRunId}:${compactLine(event.reason || event.message, 100).toLowerCase()}`,
          runId: eventRunId,
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
    } else if (event.type === "run.completed") {
      const resultTitle = event.resultKind === "error"
        ? language === "zh" ? "运行已结束（错误结论）" : "Run concluded with an error"
        : event.resultKind === "blocked"
        ? language === "zh" ? "运行已结束（受阻结论）" : "Run concluded blocked"
        : event.resultKind === "partial"
        ? language === "zh" ? "运行已部分完成" : "Run partially completed"
        : language === "zh" ? "运行已完成" : "Run completed";
      addItem(byKey, {
        key: `run-completed:${eventRunId || event.turnId}`,
        runId: eventRunId,
        phase: "completed",
        title: resultTitle,
        status: "completed",
        summary: compactLine(event.summary || "", 260),
        target: "",
        tool: "",
        firstSeenAt: event.timestampMs,
        lastSeenAt: event.timestampMs,
      });
    } else if (event.type === "run.aborted") {
      addItem(byKey, {
        key: `run-aborted:${eventRunId || event.turnId}`,
        runId: eventRunId,
        phase: "completed",
        title: language === "zh" ? "运行已取消" : "Run canceled",
        status: "completed",
        summary: compactLine(event.message || event.reason, 260),
        target: "",
        tool: "",
        firstSeenAt: event.timestampMs,
        lastSeenAt: event.timestampMs,
      });
    } else if (event.type === "run.failed") {
      addItem(byKey, {
        key: `run-failed:${eventRunId || event.turnId}`,
        runId: eventRunId,
        phase: "blocked",
        title: language === "zh" ? "运行失败" : "Run failed",
        status: "failed",
        summary: compactLine(event.error?.message || "", 260),
        target: "",
        tool: "",
        firstSeenAt: event.timestampMs,
        lastSeenAt: event.timestampMs,
      });
    } else if (event.type === "harness.telemetry") {
      const item = itemFromHarnessTelemetry(event, language);
      if (item) addItem(byKey, item);
    }
  }
  if (hasLivePlanExecution && input.planExecutionSnapshot) {
    const snapshot = input.planExecutionSnapshot;
    const item = itemFromProgressEvent(
      toPlanExecutionRuntimeProgressUpdate({
        snapshot,
        language,
        dedupeKey: `plan-execution-progress:${snapshot.runId || activeRunId || snapshot.turnId}`,
      }),
      Math.max(0, Number(snapshot.updatedAt) || 0),
      language,
      snapshotRunId || activeRunId,
    );
    if (item) addItem(byKey, item);
  }
  const items = [...byKey.values()]
    .sort((a, b) => a.firstSeenAt - b.firstSeenAt)
    .map(({
      occurrenceCount: _occurrenceCount,
      explicitRepeatCount: _explicitRepeatCount,
      seenSourceToolCallIds: _seenSourceToolCallIds,
      cachedSourceToolCallIds: _cachedSourceToolCallIds,
      legacyCacheHits: _legacyCacheHits,
      aggregation: _aggregation,
      ...item
    }) => item);
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

/**
 * Project the raw ledger into the compact M popover contract. The full turn
 * timeline remains the audit surface; this projection only exposes what is
 * happening now, a few completed milestones, and actionable health signals.
 */
export function buildRunStatusProjection(
  items: RuntimeProgressLedgerItem[],
  language: RuntimeProgressLanguage = "zh",
  maxMilestones = 3,
): RunStatusProjection {
  const normalizedLanguage = normalizeLanguage(language);
  const ordered = [...items].sort((a, b) => {
    const lastDiff = a.lastSeenAt - b.lastSeenAt;
    return lastDiff !== 0 ? lastDiff : a.firstSeenAt - b.firstSeenAt;
  });
  const latest = ordered[ordered.length - 1] || null;
  const latestIsTerminal = latest?.status === "paused" ||
    latest?.status === "failed" ||
    latest?.status === "completed";
  const currentActivity = latestIsTerminal
    ? null
    : [...ordered].reverse().find((item) =>
        item.status === "running" && item.phase !== "blocked"
      ) || (latest &&
    (latest.status === "done" || latest.status === "completed") &&
    latest.cacheHits < latest.repeatCount
      ? latest
      : null);
  const milestones = ordered
    .filter((item) =>
      (item.status === "done" || item.status === "completed") &&
      item.cacheHits < item.repeatCount &&
      item.repeatCount === 1 &&
      item.key !== currentActivity?.key
    )
    .slice(-Math.max(1, Math.min(3, maxMilestones)));

  const healthSignals = ordered.flatMap<RunStatusHealthSignal>((item) => {
    if (item.status === "failed") {
      return [{
        key: `${item.key}:failure`,
        kind: "failure",
        status: item.status,
        title: item.title,
        summary: item.summary,
        lastSeenAt: item.lastSeenAt,
      }];
    }
    if (item.status === "paused") {
      return [{
        key: `${item.key}:pause`,
        kind: "pause",
        status: item.status,
        title: item.title,
        summary: item.summary,
        lastSeenAt: item.lastSeenAt,
      }];
    }
    if (item.phase === "blocked") {
      return [{
        key: `${item.key}:waiting`,
        kind: "waiting",
        status: item.status,
        title: item.title,
        summary: item.summary,
        lastSeenAt: item.lastSeenAt,
      }];
    }
    if ((item.repeatCount > 1 || item.cacheHits > 0) && item.key !== currentActivity?.key) {
      const family = toolFamily(item.tool);
      const target = compactTarget(item.target) || item.title;
      const read = family === "read";
      const title = normalizedLanguage === "zh"
        ? `${read ? "重复读取" : "重复操作"} ${target}`
        : `${read ? "Repeated reads" : "Repeated activity"}: ${target}`;
      const summary = normalizedLanguage === "zh"
        ? `同一目标共 ${item.repeatCount} 次${item.cacheHits ? `，其中 ${item.cacheHits} 次为缓存复用` : ""}。`
        : `${item.repeatCount} calls for the same target${item.cacheHits ? `, including ${item.cacheHits} cached` : ""}.`;
      return [{
        key: `${item.key}:repetition`,
        kind: "repetition",
        status: item.status,
        title,
        summary,
        lastSeenAt: item.lastSeenAt,
      }];
    }
    return [];
  }).slice(-3);

  const activitySource = currentActivity || latest;
  const activityText = activitySource
    ? buildRuntimeProgressProjection([activitySource], normalizedLanguage, 1).activityText
    : "";
  return {
    currentActivity,
    milestones,
    healthSignals,
    activityText,
  };
}
