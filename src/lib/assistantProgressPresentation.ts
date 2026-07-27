import { shouldRetainStageSummary } from "./modelFeedbackDedupe";
import { stripLeakedReasoning } from "./normalizedTurn";
import { sanitizeAssistantDisplayContent } from "./sanitize";
import type { CapsuleStatusKind } from "./turnPresentation";

export type AssistantProgressLanguage = "zh" | "en";

const MAX_CHECKPOINT_CHARS = 680;
const MAX_GUIDANCE_CHARS = 220;
const RAW_TOOL_NAME_RE = /\b(?:apply_patch|replace_in_file|write_file|read_file|grep_search|glob_search|run_command|execute_command|browser_evaluate|computer_use)\b/i;

interface ProgressUnit {
  index: number;
  text: string;
}

function sanitizePublicProgress(value: unknown): string {
  return stripLeakedReasoning(
    sanitizeAssistantDisplayContent(String(value || "")),
  )
    .replace(/```[\s\S]*?```/g, "\n")
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function isCodeLikeLine(line: string): boolean {
  const value = line.trim();
  if (!value) return false;
  if (/^(?:import|export|const|let|var|function|class|interface|type|return|if|else|for|while|switch|case|try|catch)\b/.test(value)) {
    return true;
  }
  if (/^[{}()[\];,]+$/.test(value) || /=>|;\s*$/.test(value)) return true;
  const symbolCount = (value.match(/[{}()[\];=<>]/g) || []).length;
  return symbolCount >= 6 && symbolCount / Math.max(1, value.length) > 0.12;
}

function splitLineIntoUnits(line: string): string[] {
  const normalized = line
    .replace(/^\s{0,3}(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+)/, "")
    .replace(/^>\s*/, "")
    .trim();
  if (!normalized || isCodeLikeLine(normalized)) return [];

  const sentenceUnits = normalized.match(/[^。！？!?]+[。！？!?]?/g) || [normalized];
  return sentenceUnits
    .flatMap((unit) => unit.length > 320 ? unit.split(/[；;]/) : [unit])
    .map((unit) => unit.replace(/\s+/g, " ").trim())
    .filter((unit) => unit.length >= 6 && unit.length <= 360 && !isCodeLikeLine(unit));
}

function extractProgressUnits(value: unknown): ProgressUnit[] {
  const units: ProgressUnit[] = [];
  let index = 0;
  for (const line of sanitizePublicProgress(value).split("\n")) {
    for (const text of splitLineIntoUnits(line)) {
      units.push({ index, text });
      index += 1;
    }
  }
  return units;
}

function normalizeUnitForDedupe(value: string): string {
  return value
    .toLowerCase()
    .replace(/[`*_#~]/g, "")
    .replace(/[\s，。！？；：,.!?;:'“”‘’"()[\]{}<>/\\-]+/g, "")
    .trim();
}

function isProcessOnlyUnit(text: string): boolean {
  return /(?:让我|接下来|下一步|现在(?:我)?(?:会|将|要|先|继续|正在|需要|有了(?:足够|充分)?(?:的)?(?:信息|上下文|证据))|我(?:会|将|要|先|继续|准备|正在|需要)).{0,100}(?:读取|查看|检查|搜索|分析|调查|执行|运行|写入|修改|修复|替换|验证|整理|继续)/.test(text) ||
    /\b(?:let me|next|i(?:'|’)ll|i will|i(?:'|’)m|i am|i need to|i want to).{0,140}\b(?:read|inspect|check|search|trace|analy[sz]e|investigate|run|execute|write|edit|modify|fix|patch|replace|validate|verify|summari[sz]e|continue)\b/i.test(text);
}

function checkpointScore(text: string): number {
  let score = 0;
  if (/(?:阶段(?:结论|总结)|关键(?:发现|结论|证据)|根因|根本原因|结论|验证结果)/.test(text)) score += 5;
  if (/问题\s*\d+/.test(text)) score += 1;
  if (/(?:已经|已)(?:确认|发现|定位|验证|证明|排除)|(?:确认|发现|定位)(?:到|了)/.test(text)) score += 4;
  if (/(?:原因|根因).{0,40}(?:是|在于|来自)|(?:因为|因此|所以|导致|表明|说明|不一致|失败|错误)/.test(text)) score += 4;
  if (/\b(?:stage summary|key (?:finding|conclusion|evidence)|root cause|conclusion|validation result)\b/i.test(text)) score += 5;
  if (/\bproblem\s*\d+\b/i.test(text)) score += 1;
  if (/\b(?:confirmed|found|located|verified|proved|ruled out|failed|mismatch|error)\b/i.test(text)) score += 4;
  if (/\b(?:cause|root cause)\b.{0,70}\b(?:is|was|comes from)\b|\b(?:because|therefore|so|causes?|indicates?|shows?)\b/i.test(text)) score += 4;
  if (isProcessOnlyUnit(text)) score -= 6;
  if (RAW_TOOL_NAME_RE.test(text)) score -= 4;
  return score;
}

/**
 * Project provider-visible progress into a durable ChatArea checkpoint. The
 * projection is extractive: it keeps complete finding/cause sentences while
 * dropping code blocks, tool narration, and future-only process chatter.
 */
export function buildAssistantStageCheckpoint(
  value: unknown,
  _language: AssistantProgressLanguage = "zh",
): string {
  const publicText = sanitizePublicProgress(value);
  if (!publicText || !shouldRetainStageSummary(publicText)) return "";

  const scored = extractProgressUnits(publicText)
    .map((unit) => ({ ...unit, score: checkpointScore(unit.text) }))
    .filter((unit) => unit.score > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index);

  const selected: Array<ProgressUnit & { score: number }> = [];
  const seen = new Set<string>();
  for (const unit of scored) {
    const normalized = normalizeUnitForDedupe(unit.text);
    if (!normalized || [...seen].some((prior) => prior.includes(normalized) || normalized.includes(prior))) {
      continue;
    }
    selected.push(unit);
    seen.add(normalized);
    if (selected.length >= 2) break;
  }

  if (selected.length === 0) {
    const fallback = extractProgressUnits(publicText).find((unit) =>
      !isProcessOnlyUnit(unit.text) && !RAW_TOOL_NAME_RE.test(unit.text)
    );
    if (fallback) selected.push({ ...fallback, score: 1 });
  }
  if (selected.length === 0) return "";

  selected.sort((left, right) => left.index - right.index);
  const lines: string[] = [];
  let usedChars = 0;
  for (const unit of selected) {
    const line = `- ${unit.text}`;
    if (usedChars + line.length + 1 > MAX_CHECKPOINT_CHARS) continue;
    lines.push(line);
    usedChars += line.length + 1;
  }
  return lines.join("\n");
}

function guidanceClause(text: string): string {
  const markers = [
    /让我/,
    /接下来(?:我)?/,
    /下一步(?:我)?/,
    /现在(?:我)?(?:会|将|要|先|继续|正在)/,
    /现在(?:我)?有了(?:足够|充分)?(?:的)?(?:信息|上下文|证据)/,
    /我(?:现在)?(?:会|将|要|先|继续|准备|正在)/,
    /\blet me\b/i,
    /\bnext(?:,)?(?:\s+i)?\b/i,
    /\bi(?:'|’)ll\b/i,
    /\bi will\b/i,
    /\bi(?:'|’)m\s+(?:now\s+)?(?:reading|checking|inspecting|searching|analy[sz]ing|investigating|editing|validating|verifying|preparing)\b/i,
    /\bi am\s+(?:now\s+)?(?:reading|checking|inspecting|searching|analy[sz]ing|investigating|editing|validating|verifying|preparing)\b/i,
  ];
  let start = -1;
  for (const marker of markers) {
    const match = marker.exec(text);
    if (match && (start < 0 || match.index < start)) start = match.index;
  }
  return start >= 0 ? text.slice(start).trim() : "";
}

/**
 * Select one transient, provider-visible current-focus sentence for Capsule.
 * Findings deliberately return empty so Capsule cannot repeat the durable
 * checkpoint in ChatArea. Raw tool-name preambles also defer to structured
 * runtime guidance, where file/action evidence is clearer.
 */
export function buildCapsuleLiveGuidance(
  value: unknown,
  _language: AssistantProgressLanguage = "zh",
): string {
  const candidates = extractProgressUnits(value)
    .map((unit) => guidanceClause(unit.text))
    .filter((text) =>
      text &&
      text.length <= MAX_GUIDANCE_CHARS &&
      isProcessOnlyUnit(text) &&
      !RAW_TOOL_NAME_RE.test(text)
    );
  return candidates[candidates.length - 1] || "";
}

/**
 * Keep an active Capsule conversational while no model-visible or structured
 * action is available yet. These are public phase descriptions, not hidden
 * chain-of-thought, and are replaced as soon as a concrete action arrives.
 */
export function buildCapsulePhaseGuidance(
  kind: CapsuleStatusKind,
  language: AssistantProgressLanguage = "zh",
): string {
  const copy: Partial<Record<CapsuleStatusKind, { zh: string; en: string }>> = {
    analyzing: {
      zh: "我正在梳理当前问题，先确认相关代码入口和可验证证据。",
      en: "I’m framing the current issue and confirming the relevant code paths and verifiable evidence.",
    },
    planning: {
      zh: "我正在把已确认的证据整理成可执行计划，并检查每一步的验证方式。",
      en: "I’m turning the confirmed evidence into an executable plan and checking how each step will be verified.",
    },
    executing: {
      zh: "我正在推进当前任务；下一项可验证的读取、修改或检查会在这里实时更新。",
      en: "I’m advancing the current task; the next verifiable read, edit, or check will appear here.",
    },
    validating: {
      zh: "我正在核对最新修改，确认真实行为和回归检查都符合预期。",
      en: "I’m checking the latest changes against real behavior and regression evidence.",
    },
    recovering: {
      zh: "我正在从最近的可靠证据继续推进，并重新确认当前修复目标。",
      en: "I’m continuing from the latest reliable evidence and reconfirming the current repair target.",
    },
  };
  return copy[kind]?.[language === "en" ? "en" : "zh"] || "";
}
