import type { TurnAggregateV1 } from "./runtime-v2/aggregate";

export interface CapsulePromptProgress {
  readonly processedTokens?: number;
  readonly totalTokens?: number;
  readonly cachedTokens?: number;
  readonly percent?: number;
}

export interface CapsuleModelActivityContext {
  readonly detailZh: string;
  readonly detailEn: string;
  readonly estimatedInputTokens?: number;
}

const INTERNAL_OBSERVATION_IDS = new Set([
  "rules-source-snapshot",
  "plan-draft-source",
]);

function basenameOfTarget(target: string): string {
  const cleaned = String(target || "").trim().replace(/[\\/]+$/, "");
  if (!cleaned) return "";
  const parts = cleaned.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || cleaned;
}

function uniqueConciseTargets(targets: readonly string[], maxCount = 2): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of targets) {
    const label = basenameOfTarget(raw);
    if (!label || seen.has(label)) continue;
    seen.add(label);
    out.push(label);
    if (out.length >= maxCount) break;
  }
  return out;
}

function summarizeObjectiveSnippet(text: string | undefined, maxChars = 22): string {
  const stripped = String(text || "")
    .replace(/^\s*\/(?:计划|plan|grill-me|grill|追问|深度追问|访谈|规则|rules|init|mdebug)(?=$|\s)\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!stripped) return "";
  return stripped.length <= maxChars ? stripped : `${stripped.slice(0, maxChars - 1)}…`;
}

export function formatApproximateTokenCount(
  tokens: number | undefined,
  language: "zh" | "en",
): string {
  if (typeof tokens !== "number" || !Number.isFinite(tokens) || tokens < 1000) {
    return "";
  }
  const roundedK = tokens >= 100_000
    ? `${Math.round(tokens / 1000)}k`
    : `${Math.round(tokens / 100) / 10}k`;
  return language === "zh" ? `约 ${roundedK} tok` : `~${roundedK} tok`;
}

function formatCompactTokens(tokens: number): string {
  if (tokens < 1000) return String(Math.round(tokens));
  return tokens >= 100_000
    ? `${Math.round(tokens / 1000)}k`
    : `${Math.round(tokens / 100) / 10}k`;
}

export function formatPromptProgressSuffix(
  progress: CapsulePromptProgress | undefined,
  estimatedInputTokens: number | undefined,
  language: "zh" | "en",
): string {
  const processed = typeof progress?.processedTokens === "number" && Number.isFinite(progress.processedTokens) && progress.processedTokens >= 0
    ? progress.processedTokens
    : undefined;
  const total = typeof progress?.totalTokens === "number" && Number.isFinite(progress.totalTokens) && progress.totalTokens > 0
    ? progress.totalTokens
    : estimatedInputTokens;
  const rawPct = typeof progress?.percent === "number" && Number.isFinite(progress.percent)
    ? progress.percent
    : (processed !== undefined && total && total > 0 ? (processed / total) * 100 : undefined);
  const pct = rawPct !== undefined ? Math.max(0, Math.min(100, Math.round(rawPct))) : undefined;
  if (processed !== undefined && total && total > 0) {
    const ratio = `${formatCompactTokens(processed)} / ${formatCompactTokens(total)} tok`;
    return language === "zh"
      ? pct !== undefined ? `已处理 ${ratio} · ${pct}%` : `已处理 ${ratio}`
      : pct !== undefined ? `${ratio} · ${pct}%` : ratio;
  }
  if (pct !== undefined && processed === undefined && progress?.percent !== undefined) {
    const fallbackTok = formatApproximateTokenCount(total, language);
    return language === "zh"
      ? fallbackTok ? `预处理 ${pct}% · ${fallbackTok}` : `预处理 ${pct}%`
      : fallbackTok ? `prefill ${pct}% · ${fallbackTok}` : `prefill ${pct}%`;
  }
  return formatApproximateTokenCount(estimatedInputTokens, language);
}

export function formatCapsuleModelDetailWithProgress(
  context: CapsuleModelActivityContext | undefined,
  progress: CapsulePromptProgress | undefined,
  language: "zh" | "en",
): string | undefined {
  if (!context) return undefined;
  const base = (language === "zh" ? context.detailZh : context.detailEn).replace(/(?:（[^）]*tok）|\s*\([^)]*tok\))$/, "").trim();
  const suffix = formatPromptProgressSuffix(progress, context.estimatedInputTokens, language);
  return suffix
    ? language === "zh" ? `${base}（${suffix}）` : `${base} (${suffix})`
    : base;
}

function appendTokenSuffix(
  detailZh: string,
  detailEn: string,
  estimatedInputTokens: number | undefined,
): CapsuleModelActivityContext {
  const tokZh = formatApproximateTokenCount(estimatedInputTokens, "zh");
  const tokEn = formatApproximateTokenCount(estimatedInputTokens, "en");
  return {
    detailZh: tokZh ? `${detailZh}（${tokZh}）` : detailZh,
    detailEn: tokEn ? `${detailEn} (${tokEn})` : detailEn,
    ...(typeof estimatedInputTokens === "number" && Number.isFinite(estimatedInputTokens)
      ? { estimatedInputTokens }
      : {}),
  };
}

interface RetainedRequestInventory {
  readonly hasMessages: boolean;
  readonly retainedToolCallIds: ReadonlySet<string>;
  readonly retainedEvidenceIds: ReadonlySet<string>;
  readonly retainedChildAnchorText: string;
}

function buildRetainedRequestInventory(
  messages: readonly {
    readonly role?: string;
    readonly content?: unknown;
    readonly tool_call_id?: string;
  }[] | undefined,
): RetainedRequestInventory {
  if (!messages) {
    return {
      hasMessages: false,
      retainedToolCallIds: new Set(),
      retainedEvidenceIds: new Set(),
      retainedChildAnchorText: "",
    };
  }
  const retainedToolCallIds = new Set<string>();
  const retainedEvidenceIds = new Set<string>();
  const anchorChunks: string[] = [];
  for (const message of messages) {
    if (typeof message?.tool_call_id === "string" && message.tool_call_id.trim()) {
      retainedToolCallIds.add(message.tool_call_id.trim());
    }
    const content = typeof message?.content === "string"
      ? message.content
      : Array.isArray(message?.content)
        ? message.content.map((part: any) => typeof part?.text === "string" ? part.text : "").join("\n")
        : "";
    if (!content) continue;
    for (const match of content.matchAll(/\[(E\d+|draft-E\d+)\]/g)) {
      if (match[1]) retainedEvidenceIds.add(match[1]);
    }
    if (
      message?.role === "tool" ||
      content.includes("child:") ||
      content.includes("runtime-v2 subagent") ||
      content.includes("[runtime-v2 context:")
    ) {
      anchorChunks.push(content);
    }
  }
  return {
    hasMessages: true,
    retainedToolCallIds,
    retainedEvidenceIds,
    retainedChildAnchorText: anchorChunks.join("\n"),
  };
}

function isRetainedEvidenceOrCall(
  inventory: RetainedRequestInventory,
  toolCallId: string | undefined,
  evidenceIds: readonly string[],
): boolean {
  if (!inventory.hasMessages) return true;
  if (toolCallId && inventory.retainedToolCallIds.has(toolCallId)) return true;
  return evidenceIds.some((id) => inventory.retainedEvidenceIds.has(id));
}

/**
 * Derive a concise, deterministic presentation summary describing what prompt
 * evidence or synthesis stage the active provider request is digesting.
 * When `messages` (the bounded outbound transcript) is supplied, evidence items
 * evicted during trimming are excluded so the summary only reflects what the
 * current request actually carries.
 */
export function buildCapsuleModelActivityContext(input: {
  readonly aggregate?: TurnAggregateV1 | null;
  readonly messages?: readonly {
    readonly role?: string;
    readonly content?: unknown;
    readonly tool_call_id?: string;
  }[];
  readonly mode?: string;
  readonly estimatedInputTokens?: number;
  readonly objectiveText?: string;
}): CapsuleModelActivityContext | undefined {
  const aggregate = input.aggregate ?? null;
  const mode = String(input.mode || "").trim();
  const tokens = typeof input.estimatedInputTokens === "number" && Number.isFinite(input.estimatedInputTokens)
    ? input.estimatedInputTokens
    : undefined;
  const events = aggregate?.events || [];
  const inventory = buildRetainedRequestInventory(input.messages);

  let lastProviderIdx = -1;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (events[i]?.type === "provider.responded") {
      lastProviderIdx = i;
      break;
    }
  }
  const recentEvents = lastProviderIdx >= 0 ? events.slice(lastProviderIdx + 1) : events;

  const recentCompletedSubagents = recentEvents
    .filter((event): event is Extract<typeof event, { type: "subagent.completed" }> =>
      event.type === "subagent.completed" && event.status === "completed")
    .filter((event) => {
      if (!inventory.hasMessages) return true;
      const job = aggregate?.subagents.find((candidate) => candidate.id === event.jobId);
      const jobEvidenceIds = event.evidence?.map((e) => e.id).filter(Boolean) || [];
      return (
        inventory.retainedChildAnchorText.includes(`child:${event.jobId}`) ||
        inventory.retainedChildAnchorText.includes(event.jobId) ||
        (job?.scopeKey ? inventory.retainedChildAnchorText.includes(job.scopeKey) : false) ||
        jobEvidenceIds.some((id) => inventory.retainedEvidenceIds.has(id))
      );
    })
    .map((event) => {
      const job = aggregate?.subagents.find((candidate) => candidate.id === event.jobId);
      return job?.scopeKey || event.jobId;
    })
    .filter(Boolean);

  if (recentCompletedSubagents.length > 0) {
    const names = uniqueConciseTargets(recentCompletedSubagents, 2);
    const count = recentCompletedSubagents.length;
    const zh = count > names.length
      ? `正在综合 ${names.join("、")} 等 ${count} 份子任务报告`
      : `正在综合 ${names.join("、")} 子任务报告`;
    const en = count > names.length
      ? `Synthesizing ${count} subagent reports (${names.join(", ")}, …)`
      : `Synthesizing subagent report${count > 1 ? "s" : ""} (${names.join(", ")})`;
    return appendTokenSuffix(zh, en, tokens);
  }

  const commandMap = new Map<string, Extract<TurnAggregateV1["events"][number], { type: "command.scheduled" }>["command"]>();
  for (const event of events) {
    if (event.type === "command.scheduled") {
      commandMap.set(event.command.idempotencyKey, event.command);
    }
  }

  const recentReadTargets: string[] = [];
  for (const event of recentEvents) {
    if (event.type === "tool.completed" && event.status === "succeeded") {
      const cmd = commandMap.get(event.idempotencyKey);
      const toolName = String(event.presentation?.toolName || cmd?.payload.toolName || "");
      if (toolName === "save_plan_document" || toolName === "submit_runtime_v2_work_plan") continue;
      const toolCallId = typeof cmd?.payload.toolCallId === "string"
        ? cmd.payload.toolCallId
        : event.idempotencyKey;
      const evIds = event.evidence?.map((e) => e.id).filter(Boolean) || [];
      if (!isRetainedEvidenceOrCall(inventory, toolCallId, evIds)) continue;
      const target = String(
        event.presentation?.target ||
        event.evidence?.[0]?.target ||
        cmd?.payload.target ||
        (cmd?.payload.arguments as Record<string, unknown> | undefined)?.path ||
        "",
      ).trim();
      if (target) recentReadTargets.push(target);
    } else if (
      event.type === "observation.recorded" &&
      !INTERNAL_OBSERVATION_IDS.has(event.evidence.id) &&
      event.evidence.target &&
      isRetainedEvidenceOrCall(inventory, undefined, [event.evidence.id])
    ) {
      recentReadTargets.push(event.evidence.target);
    }
  }

  if (recentReadTargets.length > 0 && lastProviderIdx >= 0) {
    const names = uniqueConciseTargets(recentReadTargets, 2);
    const totalCount = recentReadTargets.length;
    if (names.length > 0) {
      const zh = totalCount > names.length
        ? `正在分析 ${names.join("、")} 等 ${totalCount} 项代码证据`
        : `正在分析 ${names.join("、")}`;
      const en = totalCount > names.length
        ? `Analyzing ${names.join(", ")} +${totalCount - names.length} more`
        : `Analyzing ${names.join(", ")}`;
      return appendTokenSuffix(zh, en, tokens);
    }
  }

  const evidenceCount = inventory.hasMessages
    ? inventory.retainedEvidenceIds.size
    : (aggregate?.evidence?.length || 0);
  if (mode === "synthesis") {
    const zh = evidenceCount > 0
      ? `正在综合 ${evidenceCount} 项证据生成方案`
      : "正在综合调查结果生成方案";
    const en = evidenceCount > 0
      ? `Synthesizing plan from ${evidenceCount} evidence items`
      : "Synthesizing plan from findings";
    return appendTokenSuffix(zh, en, tokens);
  }
  if (mode === "validation_repair" || mode === "submission_repair") {
    return appendTokenSuffix(
      "正在根据校验反馈修正方案",
      "Refining plan from validation feedback",
      tokens,
    );
  }
  if (mode === "conclude") {
    return appendTokenSuffix(
      "正在整理验证结果与最终结论",
      "Summarizing verification results and conclusion",
      tokens,
    );
  }

  const snippet = summarizeObjectiveSnippet(input.objectiveText || aggregate?.objective?.text);
  if (snippet && (tokens === undefined || tokens >= 1000 || lastProviderIdx >= 0)) {
    return appendTokenSuffix(
      `正在结合上下文分析「${snippet}」`,
      `Analyzing "${snippet}" with context`,
      tokens,
    );
  }
  if (tokens !== undefined && tokens >= 1500) {
    return appendTokenSuffix(
      "正在分析上下文提示词",
      "Analyzing prompt context",
      tokens,
    );
  }
  return undefined;
}
