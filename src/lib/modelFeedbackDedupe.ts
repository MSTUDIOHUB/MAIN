export interface ModelFeedbackDedupeState {
  seenNormalized: Set<string>;
}

export interface ModelFeedbackDedupeResult {
  text: string;
  normalized: string;
  shouldSuppress: boolean;
  reason: "empty" | "duplicate" | "thin_duplicate" | "kept";
  substantive: boolean;
  thinToolNarration: boolean;
}

export function createModelFeedbackDedupeState(): ModelFeedbackDedupeState {
  return { seenNormalized: new Set<string>() };
}

export function normalizeModelFeedbackForDedupe(text: string): string {
  return String(text || "")
    .toLowerCase()
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`\n]+`/g, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[`*_#[\](){}<>]/g, " ")
    .replace(/[。！？；，、,.!?;:："'“”‘’]/g, " ")
    .replace(/\s+/g, "")
    .trim();
}

export function isSubstantiveModelFeedback(text: string): boolean {
  const raw = String(text || "");
  const normalized = raw.replace(/\s+/g, "");
  return (
    /(?:观察|看到|确认|證實|证实|包含|不包含|发现|發現|结果|結果|结论|結論|原因|根因|问题|問題|修复|修正|验证通过|验证失败|通过|失败|阻塞|风险|方案|计划|建议|默认|取舍)/.test(normalized) ||
    /\b(?:observed|confirmed|contains?|does not contain|found|result|conclusion|root cause|cause|issue|problem|fixed|verified|verification|passed|failed|blocked|risk|plan|proposal|recommend|default|trade-?off)\b/i.test(raw)
  );
}

export function shouldRetainStageSummary(text: string): boolean {
  const raw = String(text || "").trim();
  if (!raw) return false;

  const normalized = raw.replace(/\s+/g, "");
  const hasCompletedFinding =
    /(?:阶段性(?:结论|总结)|关键(?:发现|结论|证据)|审核(?:摘要|结果)|验证结果|(?:已经|已)(?:确认|发现|定位|验证|证明|排除)|(?:观察|看到|发现)(?:到|了)?|(?:结论|结果|根因|原因|取舍|决策|依据|证据)(?:是|为|在于|来自|显示|表明|：|:)|(?:测试|验证)(?:通过|失败))/.test(normalized) ||
    /\b(?:stage summary|key (?:finding|conclusion|evidence)|review (?:summary|result)|validation result|confirmed|found|observed|verified|passed|failed)\b|\b(?:decision|rationale|evidence)\s*(?:is|was|:|shows?|indicates?)\b/i.test(raw);
  if (isThinModelToolNarration(raw) && !hasCompletedFinding) return false;
  if (isSubstantiveModelFeedback(raw) || hasCompletedFinding) return true;

  const structuredItemCount = (raw.match(/(?:^|\n)\s*(?:\d+[.)]|[-*+])\s+\S/g) || []).length;
  if (structuredItemCount >= 2 && normalized.length >= 40) return true;

  const sentenceCount = raw
    .split(/[。！？.!?]+|\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean)
    .length;
  return normalized.length >= 240 && sentenceCount >= 3;
}

export function isThinModelToolNarration(text: string): boolean {
  const raw = String(text || "").trim();
  const normalized = raw.replace(/\s+/g, "");
  if (!normalized || normalized.length > 280) return false;
  const hasMaterialFindingOrDecision =
    /(?:(?:已经|已)(?:确认|发现|定位|验证|证明|排除).{0,48}(?:根因|原因|问题|行为|边界|状态|结果|约束|方案|取舍|决策)|(?:根因|原因|结论|结果|决策|取舍|约束)(?:是|为|在于|来自|显示|表明|：|:))/.test(normalized) ||
    /\b(?:(?:confirmed|found|located|verified|proved|ruled out).{0,80}(?:root cause|cause|issue|behavior|boundary|state|result|constraint|approach|decision)|(?:root cause|conclusion|result|decision|trade-?off|constraint)\s*(?:is|was|:|shows?|indicates?))\b/i.test(raw);
  if (hasMaterialFindingOrDecision) return false;
  const futureToolNarration =
    /(?:^|[。,，；;！!？?：:])(?:我(?:会|將|将|先|现在|正在|继续)|让我|接下来|现在|继续|正在).{0,56}(?:读取|查看|检查|搜索|调查|执行|运行|调用|写入|修改|修复|替换|打补丁|验证|整理|完成)/.test(normalized) ||
    /(?:continuingto|(?:letme|i(?:'|’)?ll|iwill|i(?:'|’)?mgoingto).{0,72}(?:read|inspect|check|search|run|execute|call|write|edit|modify|fix|patch|replace|validate)|iread|readcomplete|searchcomplete|runningcommand)/i.test(normalized);
  if (futureToolNarration) return true;
  if (isSubstantiveModelFeedback(raw)) return false;
  return /(?:已读取|已搜索|已执行|读取完成|搜索完成|命令完成|工具调用完成)/i.test(normalized);
}

export function dedupeModelFeedbackText(
  text: string,
  state: ModelFeedbackDedupeState = createModelFeedbackDedupeState(),
): ModelFeedbackDedupeResult {
  const value = String(text || "").trim();
  const normalized = normalizeModelFeedbackForDedupe(value);
  const thinToolNarration = isThinModelToolNarration(value);
  const substantive = thinToolNarration ? false : isSubstantiveModelFeedback(value);
  if (!normalized) {
    return {
      text: value,
      normalized,
      shouldSuppress: true,
      reason: "empty",
      substantive,
      thinToolNarration,
    };
  }

  const duplicate = state.seenNormalized.has(normalized) ||
    [...state.seenNormalized].some((seen) =>
      normalized.length >= 18 &&
      seen.length >= 18 &&
      (seen.includes(normalized) || normalized.includes(seen))
    );

  state.seenNormalized.add(normalized);

  if (duplicate && !substantive) {
    return {
      text: value,
      normalized,
      shouldSuppress: true,
      reason: thinToolNarration ? "thin_duplicate" : "duplicate",
      substantive,
      thinToolNarration,
    };
  }

  return {
    text: value,
    normalized,
    shouldSuppress: false,
    reason: "kept",
    substantive,
    thinToolNarration,
  };
}
