export interface ThoughtDisplayOptions {
  language?: "zh" | "en";
  maxSummaryLines?: number;
  mode?: "first" | "latest";
  density?: "compact" | "adaptive";
}

export interface ThoughtDisplayResult {
  title: string;
  summaryLines: string[];
  summaryText: string;
}

const DEFAULT_SUMMARY_LINES = 1;
const ADAPTIVE_SUMMARY_LINES = 12;
const ADAPTIVE_SUMMARY_CHAR_BUDGET = 1800;
const SYNTHETIC_VISIBLE_CONCLUSION_ZH = "后台思考已折叠，模型尚未生成可见回复或可执行动作。";
const SYNTHETIC_VISIBLE_CONCLUSION_RE = /后台思考已折叠[，,]\s*模型尚未生成可见回复或可执行动作。?/;

function normalizeForCompare(text: string): string {
  return String(text || "")
    .trim()
    .toLowerCase()
    .replace(/[，。！？；：,.!?;:、"'“”‘’`*_~\-\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeThoughtSummaryForCompare(text: string): string {
  return normalizeForCompare(text)
    .replace(/\bthought display\b/g, "思考显示")
    .replace(/(?:我)?(?:已经|已|刚刚)(?:完成|确认|处理|检查|读取|修改|更新|实现|验证)/g, "")
    .replace(/(?:接下来|下一步|然后|现在)(?:我)?(?:会|将|要|需要|继续|准备)?/g, "")
    .replace(/(?:下一步|会把|把|接入)/g, "")
    .replace(/我(?:需要|准备|会|将|先|正在|已经|要)?/g, "")
    .replace(/(?:需要|准备|正在|已经|先)/g, "")
    .replace(/(?:检查|查看|读取|读|搜索|确认)/g, "看")
    .replace(/(?:内容|上下文|具体实现|具体内容)/g, "")
    .replace(/(?:尝试|试着|换一种方式)/g, "")
    .replace(/的/g, "")
    .replace(/\bthe same\b/g, "same")
    .replace(/\bsame\b/g, "")
    .replace(/\bme\b/g, "")
    .replace(/\bi\b/g, "")
    .replace(/\bthe\b/g, "")
    .replace(/\ba\b/g, "")
    .replace(/\ban\b/g, "")
    .replace(/\btry\b/g, "read")
    .replace(/\breading\b/g, "read")
    .replace(/\breturning\b/g, "return")
    .replace(/\bkeeps\b/g, "keep")
    .replace(/\bneed\b/g, "")
    .replace(/\bcontent\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function isSyntheticThoughtPlaceholder(text: string): boolean {
  const normalized = String(text || "").replace(/\s+/g, "").trim();
  return (
    normalized === SYNTHETIC_VISIBLE_CONCLUSION_ZH.replace(/\s+/g, "") ||
    SYNTHETIC_VISIBLE_CONCLUSION_RE.test(String(text || ""))
  );
}

function sameSequence(items: string[], a: number, b: number, length: number): boolean {
  for (let offset = 0; offset < length; offset += 1) {
    if (normalizeForCompare(items[a + offset] || "") !== normalizeForCompare(items[b + offset] || "")) {
      return false;
    }
  }
  return true;
}

function collapseRepeatedItems(items: string[], maxWindow: number): string[] {
  if (items.length < 4) return items;

  const collapsed: string[] = [];
  let index = 0;

  while (index < items.length) {
    let matched = false;
    const remaining = items.length - index;
    const largestWindow = Math.min(maxWindow, Math.floor(remaining / 2));

    for (let windowSize = largestWindow; windowSize >= 1; windowSize -= 1) {
      let repeats = 1;
      while (
        index + (repeats + 1) * windowSize <= items.length &&
        sameSequence(items, index, index + repeats * windowSize, windowSize)
      ) {
        repeats += 1;
      }

      if (repeats >= 2) {
        collapsed.push(...items.slice(index, index + windowSize));
        index += repeats * windowSize;
        matched = true;
        break;
      }
    }

    if (!matched) {
      collapsed.push(items[index]);
      index += 1;
    }
  }

  return collapsed;
}

function collapseRepeatedParagraphs(text: string): string {
  const paragraphs = String(text || "")
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean);
  return collapseRepeatedItems(paragraphs, 8).join("\n\n");
}

function collapseRepeatedLines(text: string): string {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((part) => part.trim())
    .filter(Boolean);
  return collapseRepeatedItems(lines, 12).join("\n");
}

function hasMeaningfulText(text: string): boolean {
  return /[A-Za-z0-9\u4e00-\u9fff]/.test(text);
}

function isMostlyPunctuation(line: string): boolean {
  const compact = line.replace(/\s+/g, "");
  return compact.length > 0 && !hasMeaningfulText(compact);
}

function hasDensePunctuationNoise(line: string): boolean {
  const compact = line.replace(/\s+/g, "");
  if (compact.length < 24) return false;
  const meaningfulCount = (compact.match(/[A-Za-z0-9\u4e00-\u9fff]/g) || []).length;
  const punctuationCount = (compact.match(/[，,。.!！？?;；:：、'"“”‘’`*_~()[\]{}<>/\\|]/g) || []).length;
  const meaningfulRatio = meaningfulCount / compact.length;
  const punctuationRatio = punctuationCount / compact.length;
  return meaningfulRatio < 0.34 || (punctuationRatio > 0.42 && meaningfulRatio < 0.52);
}

function hasLongMixedPunctuationRun(line: string): boolean {
  return /(?:[，,。.!！？?;；:：、]\s*){8,}/.test(line);
}

function jaccardSimilarity(a: string, b: string): number {
  const left = new Set(normalizeThoughtSummaryForCompare(a).split(/\s+/).filter((token) => token.length > 1));
  const right = new Set(normalizeThoughtSummaryForCompare(b).split(/\s+/).filter((token) => token.length > 1));
  if (left.size === 0 || right.size === 0) return 0;
  let intersection = 0;
  for (const token of left) {
    if (right.has(token)) intersection += 1;
  }
  return intersection / Math.max(left.size, right.size);
}

function charBigramSimilarity(a: string, b: string): number {
  const toBigrams = (value: string) => {
    const compact = normalizeThoughtSummaryForCompare(value).replace(/\s+/g, "");
    const bigrams = new Set<string>();
    for (let index = 0; index < compact.length - 1; index += 1) {
      bigrams.add(compact.slice(index, index + 2));
    }
    return bigrams;
  };
  const left = toBigrams(a);
  const right = toBigrams(b);
  if (left.size === 0 || right.size === 0) return 0;
  let intersection = 0;
  for (const token of left) {
    if (right.has(token)) intersection += 1;
  }
  return intersection / Math.max(left.size, right.size);
}

function isNearDuplicateSummary(candidate: string, existing: string): boolean {
  const left = normalizeThoughtSummaryForCompare(candidate);
  const right = normalizeThoughtSummaryForCompare(existing);
  if (!left || !right) return false;
  if (left === right) return true;
  if (left.length > 24 && right.length > 24 && (left.includes(right) || right.includes(left))) return true;
  if (/[\u4e00-\u9fff]/.test(left + right) && charBigramSimilarity(candidate, existing) >= 0.68) return true;
  return jaccardSimilarity(candidate, existing) >= 0.72;
}

function isMarkdownStructureLine(line: string): boolean {
  return /^```/.test(line.trim()) ||
    /^#{1,6}\s+\S/.test(line) ||
    /^(?:[-*+]\s+|\d+\.\s+|>\s+)/.test(line);
}

function isLikelyJsonLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  if (/^data:\s*[\[{]/i.test(trimmed)) return true;
  if (!((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]")))) {
    return false;
  }
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
}

function isLikelyToolLogLine(line: string): boolean {
  return /^(?:tool|tool_call|function_call|call_|stdout|stderr|exit(?:code)?|status|args?|arguments|target|result)\b/i.test(line) ||
    /^\[?(?:read_file|write_file|replace_in_file|execute_command|run_command|browser_evaluate|computer_use|grep_search|glob_search|list_directory|send_pty_input)\b/i.test(line) ||
    /^<*\/?(?:tool_use|tool_call|function_call|tool|parameter|tool_response)\b/i.test(line) ||
    /\b(?:truncatedPreview|ANGEDUB|get_outline)\b/i.test(line);
}

function isModeComplaintLine(line: string): boolean {
  return /(?:当前|目前).{0,20}(?:discuss|讨论).{0,24}(?:不(?:可|能)|不能|不可用).{0,20}(?:write_file|replace_in_file|execute_command|run_command)|(?:需要|请先|必须).{0,20}(?:切换|进入).{0,12}(?:执行模式|execute mode)|(?:tool|工具).{0,16}(?:disabled|不可用).{0,20}(?:discuss|讨论)/i.test(line);
}

function isCodeLikeLine(line: string): boolean {
  const trimmed = line.trim();
  return /^(?:import|export|const|let|var|function|class|interface|type|return|if|else|for|while|switch|case|try|catch)\b/.test(trimmed) ||
    /^[{}()[\];,]+$/.test(trimmed) ||
    /=>|;\s*$|^\s*[}\])]/.test(line);
}

function foldLargeCodeBlocks(text: string, language: "zh" | "en"): string {
  const placeholder = language === "zh" ? "[大段代码片段已过滤]" : "[large code block filtered]";
  return String(text || "").replace(/```[\s\S]*?```/g, (block) => {
    const lineCount = block.split(/\r?\n/).length;
    return block.length > 800 || lineCount > 12 ? placeholder : block;
  });
}

function foldCodeLikeRuns(lines: string[], language: "zh" | "en"): string[] {
  const placeholder = language === "zh" ? "[代码片段已过滤]" : "[code snippet filtered]";
  const result: string[] = [];
  let run: string[] = [];

  const flushRun = () => {
    if (run.length === 0) return;
    const runChars = run.join("\n").length;
    if (run.length >= 4 || runChars > 500) {
      if (result[result.length - 1] !== placeholder) result.push(placeholder);
    } else {
      result.push(...run);
    }
    run = [];
  };

  for (const line of lines) {
    if (isCodeLikeLine(line)) {
      run.push(line);
      continue;
    }
    flushRun();
    result.push(line);
  }
  flushRun();

  return result;
}

function dedupeNearDuplicateThoughtLines(lines: string[]): string[] {
  const result: string[] = [];
  for (const line of lines) {
    if (isMarkdownStructureLine(line) || isCodeLikeLine(line)) {
      result.push(line);
      continue;
    }
    if (result.some((existing) =>
      !isMarkdownStructureLine(existing) &&
      !isCodeLikeLine(existing) &&
      isNearDuplicateSummary(line, existing)
    )) {
      continue;
    }
    result.push(line);
  }
  return result;
}

function normalizePunctuationNoise(line: string): string {
  return String(line || "")
    .replace(/\u2026/g, "...")
    .replace(/(?:\.\s*){4,}/g, " ")
    .replace(/(?:[，,。.!！？?;；:：、]\s*){4,}/g, " ")
    .replace(/([，,。.!！？?;；:：、])(?:\s*[，,。.!！？?;；:：、])+/g, "$1 ")
    .replace(/(?:^|\s)[，,。.!！？?;；:：、]+(?=\s|$)/g, " ")
    .replace(/[^\S\r\n]{2,}/g, " ")
    .trim();
}

function cleanThoughtText(raw: string, language: "zh" | "en"): string {
  const withoutTags = foldLargeCodeBlocks(String(raw || ""), language)
    .replace(/<\/?(?:analysis|thought|thinking|reasoning)(?:\s[^>]*)?>/gi, " ")
    .replace(/<\/?(?:tool_use|tool_call|function_call|tool|parameter|tool_response)(?:\s[^>]*)?>/gi, " ")
    .replace(/\r\n/g, "\n")
    .replace(/(?:[，,。.!！？?;；:：、.\-_]\s*){16,}/g, " ");

  const filteredLines = withoutTags
    .split("\n")
    .map((line) => ({ rawLine: line, cleanLine: normalizePunctuationNoise(line.replace(/[^\S\r\n]{3,}/g, " ")) }))
    .filter((line) => {
      if (!line.cleanLine) return false;
      if (isSyntheticThoughtPlaceholder(line.cleanLine)) return false;
      if (isMarkdownStructureLine(line.cleanLine)) return true;
      if (hasLongMixedPunctuationRun(line.rawLine)) return false;
      if (isMostlyPunctuation(line.cleanLine)) return false;
      if (hasDensePunctuationNoise(line.cleanLine)) return false;
      if (isLikelyJsonLine(line.cleanLine)) return false;
      if (isLikelyToolLogLine(line.cleanLine)) return false;
      if (isModeComplaintLine(line.cleanLine)) return false;
      return true;
    })
    .map((line) => line.cleanLine);

  const readableLines = dedupeNearDuplicateThoughtLines(foldCodeLikeRuns(filteredLines, language));
  return collapseRepeatedLines(collapseRepeatedParagraphs(readableLines.join("\n")))
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function splitSummaryCandidates(cleanText: string): string[] {
  const units = cleanText
    .split(/\n{2,}|\n/)
    .flatMap((part) => {
      const trimmed = part.trim();
      if (!trimmed) return [];
      if (trimmed.length <= 220) return [trimmed];
      return trimmed.match(/[^。！？.!?\n]+[。！？.!?]?/g) || [trimmed];
    })
    .map((part) => part.trim())
    .filter(Boolean);

  return units.filter((unit) =>
    !isSyntheticThoughtPlaceholder(unit) &&
    !/^\[.*(?:过滤|filtered).*\]$/i.test(unit) &&
    !isLikelyJsonLine(unit) &&
    !isCodeLikeLine(unit) &&
    hasMeaningfulText(unit)
  );
}

function isProcessUseful(text: string): boolean {
  return /(?:我(?:需要|准备|会|将|先|正在|已经|要)|(?:现在|当前|最后|已经|正在)(?:需要|会|确认|整理|准备|补充)|先(?:修改|验证|计划)|下一步|需要先|正在|修改|验证|计划|I need to|I will|I'll|I'm going to|next|plan|verify)/i.test(text);
}

function truncateSummaryLine(text: string, maxChars = 180): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars - 3).trim()}...`;
}

function isLowValueProcessSummaryLine(text: string): boolean {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  if (normalized.length > 90) return false;
  if (/^(?:我(?:会|将|要|需要)?\s*)?(?:继续|先|再)?\s*(?:按(?:照)?|根据)?(?:同一)?(?:方案|计划|策略)?\s*(?:修改|编辑|更新|调整|处理|应用|落地)(?:目标|相关|当前|这些|上述|对应|项目)?(?:文件|代码|样式|内容|改动)?[。.!！]*$/i.test(normalized)) return true;
  if (/^(?:I(?:'ll| will| need to)?\s*)?(?:continue|first|next)?\s*(?:apply|make|perform|do|edit|update|change|modify)(?:\s+the)?(?:\s+planned|\s+target|\s+related|\s+current)?(?:\s+file|\s+files|\s+change|\s+changes|\s+edit|\s+edits)?\.?$/i.test(normalized)) return true;
  return /^(?:让我|我(?:会|将|要|需要|继续|正在)|接下来|现在)?\s*(?:继续|再|先)?\s*(?:读取|检查|查看|分析|梳理|确认)(?:(?:剩余|更多|相关|关键|必要)\s*)*(?:的)?(?:文件|内容|上下文|实现|代码)?[。.!！]*$/i.test(normalized) ||
    /等待(?:可见回复|模型|下一步动作|工具结果)/i.test(normalized);
}

function isStaleSetupSummaryLine(text: string): boolean {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  return /(?:第一次指令|最初指令|初始指令|first instruction|initial prompt|original prompt)/i.test(normalized);
}

function isProgressEchoSummaryLine(text: string): boolean {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  if (normalized.length < 18) return false;
  return /(?:已(?:经)?|刚刚)(?:完成|确认|处理|读取|检查|修改|更新|实现|验证).{0,120}(?:接下来|下一步|继续|现在|然后)|(?:接下来|下一步).{0,120}(?:继续|处理|修复|检查|验证|实现|更新|修改)/i.test(normalized) ||
    /\b(?:completed|confirmed|handled|checked|updated|implemented|verified)\b.{0,120}\b(?:next|continue|then|now)\b/i.test(normalized);
}

function limitProgressEchoSummaryLines(lines: string[], mode: "first" | "latest", maxProgressLines = 2): string[] {
  const ordered = mode === "latest" ? [...lines].reverse() : lines;
  const kept: string[] = [];
  let progressCount = 0;
  for (const line of ordered) {
    if (isProgressEchoSummaryLine(line)) {
      progressCount += 1;
      if (progressCount > maxProgressLines) continue;
    }
    kept.push(line);
  }
  return mode === "latest" ? kept.reverse() : kept;
}

function takeWithinBudget(lines: string[], maxLines: number, charBudget: number, mode: "first" | "latest"): string[] {
  const result: string[] = [];
  const source = mode === "latest" ? [...lines].reverse() : lines;
  let chars = 0;
  for (const line of source) {
    const normalized = line.trim();
    if (!normalized) continue;
    const nextChars = chars + normalized.length + (result.length > 0 ? 2 : 0);
    if (result.length > 0 && (result.length >= maxLines || nextChars > charBudget)) break;
    result.push(normalized);
    chars = nextChars;
  }
  return mode === "latest" ? result.reverse() : result;
}

function pickAdaptiveSummaryLines(cleanText: string, maxLines: number, mode: "first" | "latest"): string[] {
  const lines = cleanText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) =>
      line &&
      hasMeaningfulText(line) &&
      !isSyntheticThoughtPlaceholder(line) &&
      !isLikelyJsonLine(line) &&
      !isCodeLikeLine(line)
    );
  if (lines.length === 0) return [];

  const richLines = lines.filter((line) => !isLowValueProcessSummaryLine(line));
  if (richLines.length === 0) return [];
  const usefulLines = richLines.filter((line) => !isStaleSetupSummaryLine(line));
  const source = limitProgressEchoSummaryLines(usefulLines.length >= 2 ? usefulLines : richLines, mode);
  return takeWithinBudget(source, Math.max(3, maxLines), ADAPTIVE_SUMMARY_CHAR_BUDGET, mode);
}

function pickSummaryLines(
  cleanText: string,
  maxLines: number,
  mode: "first" | "latest" = "first",
  density: "compact" | "adaptive" = "compact",
): string[] {
  if (density === "adaptive") {
    return pickAdaptiveSummaryLines(cleanText, maxLines, mode);
  }

  const candidates = splitSummaryCandidates(cleanText);
  const chosen: string[] = [];
  const seen = new Set<string>();
  const orderedCandidates = mode === "latest" ? [...candidates].reverse() : candidates;
  const maxLineChars = 180;
  const charBudget = Number.POSITIVE_INFINITY;

  if (maxLines === 1) {
    if (mode === "latest") {
      const latestCandidate = [
        ...orderedCandidates.filter(isProcessUseful),
        ...orderedCandidates,
      ].find((candidate, index, all) => {
        const normalized = normalizeForCompare(candidate);
        return normalized && all.findIndex((other) => normalizeForCompare(other) === normalized) === index;
      });
      return latestCandidate ? [truncateSummaryLine(latestCandidate, maxLineChars)] : [];
    }

    const merged: string[] = [];
    const mergedSeen = new Set<string>();
    const addMerged = (candidate: string) => {
      const normalized = normalizeForCompare(candidate);
      if (!normalized || mergedSeen.has(normalized)) return;
      if (merged.some((existing) => isNearDuplicateSummary(candidate, existing))) return;
      mergedSeen.add(normalized);
      merged.push(candidate);
    };
    const rankedCandidates = [
      ...orderedCandidates.filter(isProcessUseful),
      ...orderedCandidates,
    ];
    for (const candidate of rankedCandidates) {
      addMerged(candidate);
      if (merged.length >= 2) break;
    }
    if (merged.length >= 2) {
      return [truncateSummaryLine(merged.join("; "), maxLineChars)];
    }
  }

  const add = (candidate: string) => {
    const normalized = normalizeForCompare(candidate);
    if (!normalized || seen.has(normalized)) return;
    if (chosen.some((existing) => isNearDuplicateSummary(candidate, existing))) return;
    const nextLine = truncateSummaryLine(candidate, maxLineChars);
    const nextLength = chosen.join("\n\n").length + nextLine.length + (chosen.length > 0 ? 2 : 0);
    if (nextLength > charBudget && chosen.length > 0) return;
    seen.add(normalized);
    chosen.push(nextLine);
  };

  orderedCandidates.filter(isProcessUseful).forEach((candidate) => {
    if (chosen.length < maxLines) add(candidate);
  });

  orderedCandidates.forEach((candidate) => {
    if (chosen.length < maxLines) add(candidate);
  });

  return chosen;
}

export function deriveThoughtDisplay(
  content: string,
  options: ThoughtDisplayOptions = {},
): ThoughtDisplayResult {
  const language = options.language === "en" ? "en" : "zh";
  const density = options.density === "adaptive" ? "adaptive" : "compact";
  const clean = cleanThoughtText(String(content || ""), language);
  const summaryLines = pickSummaryLines(
    clean,
    Math.max(1, options.maxSummaryLines ?? (density === "adaptive" ? ADAPTIVE_SUMMARY_LINES : DEFAULT_SUMMARY_LINES)),
    options.mode === "latest" ? "latest" : "first",
    density,
  );

  return {
    title: language === "zh" ? "思考过程" : "Thinking Process",
    summaryLines,
    summaryText: summaryLines.join("\n\n"),
  };
}
