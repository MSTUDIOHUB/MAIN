import {
  deriveThoughtDisplay,
  normalizeThoughtSummaryForCompare,
} from "./thoughtDisplay";

const MAX_VISIBLE_THOUGHT_CHARS = 36_000;

function normalizeThoughtTextForCompare(text: string): string {
  return normalizeThoughtSummaryForCompare(text);
}

function thoughtSimilarity(a: string, b: string): number {
  const left = new Set(normalizeThoughtTextForCompare(a).split(/\s+/).filter((token) => token.length > 1));
  const right = new Set(normalizeThoughtTextForCompare(b).split(/\s+/).filter((token) => token.length > 1));
  if (left.size === 0 || right.size === 0) {
    const compactLeft = normalizeThoughtTextForCompare(a).replace(/\s+/g, "");
    const compactRight = normalizeThoughtTextForCompare(b).replace(/\s+/g, "");
    if (compactLeft.length < 8 || compactRight.length < 8) return 0;
    const grams = (value: string) => {
      const set = new Set<string>();
      for (let index = 0; index < value.length - 1; index++) set.add(value.slice(index, index + 2));
      return set;
    };
    const leftGrams = grams(compactLeft);
    const rightGrams = grams(compactRight);
    let shared = 0;
    for (const gram of leftGrams) {
      if (rightGrams.has(gram)) shared++;
    }
    return shared / Math.max(leftGrams.size, rightGrams.size);
  }
  let shared = 0;
  for (const token of left) {
    if (right.has(token)) shared++;
  }
  return shared / Math.max(left.size, right.size);
}

function collapseNearDuplicateThoughtLines(text: string): string {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (lines.length < 2) return text;
  const kept: string[] = [];
  for (const line of lines) {
    const normalized = normalizeThoughtTextForCompare(line);
    if (!normalized) continue;
    if (kept.some((existing) => {
      const existingNormalized = normalizeThoughtTextForCompare(existing);
      return existingNormalized === normalized ||
        (normalized.length > 24 && existingNormalized.length > 24 && (normalized.includes(existingNormalized) || existingNormalized.includes(normalized))) ||
        thoughtSimilarity(line, existing) >= 0.72;
    })) {
      continue;
    }
    kept.push(line);
  }
  return kept.join("\n");
}

function sameThoughtParagraphSequence(paragraphs: string[], a: number, b: number, length: number): boolean {
  for (let offset = 0; offset < length; offset++) {
    if (normalizeThoughtTextForCompare(paragraphs[a + offset] || "") !== normalizeThoughtTextForCompare(paragraphs[b + offset] || "")) {
      return false;
    }
  }
  return true;
}

function collapseRepeatedThoughtParagraphs(text: string): string {
  const paragraphs = String(text || "")
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean);

  if (paragraphs.length < 4) return text;

  const collapsed: string[] = [];
  let index = 0;
  const maxWindow = 8;

  while (index < paragraphs.length) {
    let matched = false;
    const remaining = paragraphs.length - index;
    const largestWindow = Math.min(maxWindow, Math.floor(remaining / 2));

    for (let windowSize = largestWindow; windowSize >= 1; windowSize--) {
      let repeats = 1;
      while (
        index + (repeats + 1) * windowSize <= paragraphs.length &&
        sameThoughtParagraphSequence(paragraphs, index, index + repeats * windowSize, windowSize)
      ) {
        repeats++;
      }

      if (repeats >= 2) {
        collapsed.push(...paragraphs.slice(index, index + windowSize));
        index += repeats * windowSize;
        matched = true;
        break;
      }
    }

    if (!matched) {
      collapsed.push(paragraphs[index]);
      index++;
    }
  }

  return collapsed.join("\n\n");
}

function collapseRepeatedThoughtLines(text: string): string {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((part) => part.trim())
    .filter(Boolean);

  if (lines.length < 6) return text;

  const collapsed: string[] = [];
  let index = 0;
  const maxWindow = 12;

  while (index < lines.length) {
    let matched = false;
    const remaining = lines.length - index;
    const largestWindow = Math.min(maxWindow, Math.floor(remaining / 2));

    for (let windowSize = largestWindow; windowSize >= 1; windowSize--) {
      let repeats = 1;
      while (
        index + (repeats + 1) * windowSize <= lines.length &&
        sameThoughtParagraphSequence(lines, index, index + repeats * windowSize, windowSize)
      ) {
        repeats++;
      }

      if (repeats >= 2) {
        collapsed.push(...lines.slice(index, index + windowSize));
        index += repeats * windowSize;
        matched = true;
        break;
      }
    }

    if (!matched) {
      collapsed.push(lines[index]);
      index++;
    }
  }

  return collapsed.join("\n");
}

function compactThoughtNoise(text: string): string {
  return String(text || "")
    .replace(/(?:[，,。.\-_]\s*){32,}/g, " ... ")
    .replace(/([，,。.!！？?;；:：])(?:\s*\1){6,}/g, "$1...")
    .replace(/(?:\*\s*){16,}/g, "**")
    .replace(/[^\S\r\n]{3,}/g, " ");
}

function findSuffixPrefixOverlap(existing: string, incoming: string): number {
  const max = Math.min(existing.length, incoming.length, 4000);
  for (let length = max; length > 20; length--) {
    if (existing.endsWith(incoming.slice(0, length))) return length;
  }
  return 0;
}

function limitThoughtContent(text: string): string {
  const content = String(text || "");
  if (content.length <= MAX_VISIBLE_THOUGHT_CHARS) return content;
  const head = content.slice(0, Math.floor(MAX_VISIBLE_THOUGHT_CHARS * 0.72)).trimEnd();
  const tail = content.slice(-Math.floor(MAX_VISIBLE_THOUGHT_CHARS * 0.18)).trimStart();
  const hidden = content.length - head.length - tail.length;
  return `${head}\n\n[后台思考内容过长，已折叠中间 ${hidden.toLocaleString()} 个字符，避免界面卡死。]\n\n${tail}`;
}

export function compactThoughtContent(text: string): string {
  const collapsedParagraphs = collapseRepeatedThoughtParagraphs(String(text || ""));
  const collapsedLines = collapseRepeatedThoughtLines(collapsedParagraphs);
  const collapsedNearDuplicates = collapseNearDuplicateThoughtLines(collapsedLines);
  return limitThoughtContent(compactThoughtNoise(collapsedNearDuplicates));
}

export function compactThoughtContentForPersist(text: string): string {
  const compacted = compactThoughtContent(text);
  const summarized = deriveThoughtDisplay(compacted, {
    maxSummaryLines: 12,
    mode: "latest",
    density: "adaptive",
  }).summaryText;
  if (summarized) return summarized;
  return compacted.length > 2400 ? compacted.slice(0, 2400).trimEnd() : compacted;
}

function compactProcessAssistantText(text: string, language: "zh" | "en"): string {
  const display = deriveThoughtDisplay(String(text || ""), {
    language,
    mode: "latest",
    density: "adaptive",
    maxSummaryLines: 6,
  });
  return display.summaryText || compactThoughtContentForPersist(String(text || ""));
}

export function pickProcessAssistantText(
  visibleText: string,
  hiddenThought: string | undefined,
  language: "zh" | "en",
): string {
  const visible = String(visibleText || "").trim();
  const hidden = String(hiddenThought || "").trim();
  const hiddenSummary = hidden ? compactProcessAssistantText(hidden, language) : "";
  if (hiddenSummary) return hiddenSummary;
  return compactProcessAssistantText(visible, language);
}

export function appendThoughtDelta(existing: string, incoming: string): string {
  const current = String(existing || "");
  const delta = String(incoming || "");
  if (!delta) return compactThoughtContent(current);
  if (!current) return compactThoughtContent(delta);

  const normalizedCurrent = normalizeThoughtTextForCompare(current);
  const normalizedDelta = normalizeThoughtTextForCompare(delta);
  if (normalizedDelta && normalizedCurrent.includes(normalizedDelta)) {
    return compactThoughtContent(current);
  }

  if (normalizedCurrent && normalizedDelta.startsWith(normalizedCurrent)) {
    return compactThoughtContent(delta);
  }

  if (delta.startsWith(current)) {
    return compactThoughtContent(delta);
  }

  const overlap = findSuffixPrefixOverlap(current, delta);
  return compactThoughtContent(current + (overlap > 0 ? delta.slice(overlap) : delta));
}
