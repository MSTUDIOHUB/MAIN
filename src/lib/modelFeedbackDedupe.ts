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

export function isThinModelToolNarration(text: string): boolean {
  const raw = String(text || "").trim();
  const normalized = raw.replace(/\s+/g, "");
  if (!normalized || normalized.length > 280) return false;
  const futureToolNarration =
    /^(?:我(?:会|將|将|先|现在|正在|继续)|让我|接下来|现在|继续|正在).{0,56}(?:读取|查看|搜索|调查|执行|运行|调用|写入|修改|验证|整理|完成)/.test(normalized) ||
    /(?:continuingto|i(?:'|’)llread|iwillread|iread|readcomplete|searchcomplete|runningcommand)/i.test(normalized);
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
