// src/lib/chat/StreamingThoughtSummarizer.ts
// Lightweight summarizer that converts long thinking streams into
// single-line summaries using heuristics (no LLM calls).
// ────────────────────────────────────────────────────────────────────

import { THINKING_TAG_NAMES } from "./StreamingThinkingInterceptor";

export interface ThoughtSummary {
  /** Compact one-line summary of the thinking. */
  summary: string;
  /** Files mentioned during thinking. */
  mentionedFiles: string[];
  /** Actions the model planned or took. */
  actions: string[];
  /** Decisions or conclusions reached. */
  decisions: string[];
  /** Original thinking character count. */
  originalLength: number;
}

/**
 * Extract file paths from text.
 */
function extractFilePaths(text: string): string[] {
  const paths: string[] = [];
  const pathRe = /([a-zA-Z0-9_./\-]+(?:\.(ts|tsx|js|jsx|py|rs|go|java|c|cpp|h|hpp|css|html|json|toml|yaml|yml|md|sh|bash|sql|vue|svelte|jsx|graphql)))\b/g;
  let m: RegExpExecArray | null;
  while ((m = pathRe.exec(text)) && paths.length < 5) {
    const p = m[1];
    if (!p.startsWith("<") && !p.endsWith(">") && p.length > 2 && p.length < 200) {
      paths.push(p);
    }
  }
  return paths;
}

/**
 * Extract action keywords from text.
 */
function extractActions(text: string): string[] {
  const actionPatterns = [
    /^(read|open|view|inspect)\b.*?(?:file|path|directory|code)/i,
    /^(write|edit|apply|create|modify|update|delete)\b/i,
    /^(run|execute|run_command|shell|terminal)\b/i,
    /^(search|grep|rg|find|explore)\b/i,
    /^(analyze|check|verify|test|validate|audit)\b/i,
    /^(decide|conclude|determine|judge)\b/i,
    /^(plan|outline|design|structure)\b/i,
  ];
  const lines = text.split(/\n/).map(l => l.trim()).filter(Boolean);
  const actions: string[] = [];
  for (const line of lines) {
    for (const pat of actionPatterns) {
      if (pat.test(line) && actions.length < 3) {
        actions.push(line.slice(0, 140));
        break;
      }
    }
  }
  return actions;
}

/**
 * Extract decision/conclusion statements.
 */
function extractDecisions(text: string): string[] {
  const decisionPatterns = [
    /(?:conclude|decide|determine|found|identified|observed|noted|confirmed|verified)\b.*$/i,
    /(?:should|must|need to|will)\s+(?:do|use|apply|read|write|execute|modify|run)\b.*$/i,
    /(?:because|therefore|so|thus|hence)\b.*$/i,
  ];
  const lines = text.split(/\n/).map(l => l.trim()).filter(Boolean);
  const decisions: string[] = [];
  for (const line of lines) {
    for (const pat of decisionPatterns) {
      if (pat.test(line) && decisions.length < 2) {
        decisions.push(line.slice(0, 140));
        break;
      }
    }
  }
  return decisions;
}

/**
 * Build a compact summary from raw thinking text.
 */
export function summarizeThought(thinking: string): ThoughtSummary {
  const originalLength = thinking.length;
  const trimmed = thinking.replace(/\s+/g, " ").trim();

  return {
    summary: buildSummaryString(trimmed),
    mentionedFiles: extractFilePaths(thinking),
    actions: extractActions(thinking),
    decisions: extractDecisions(thinking),
    originalLength,
  };
}

/**
 * Convert a ThoughtSummary into a single-line string for context injection.
 */
export function thoughtSummaryToString(summary: ThoughtSummary): string {
  const parts: string[] = [];
  if (summary.decisions.length > 0) {
    parts.push(`Decision: ${summary.decisions[0]}`);
  }
  if (summary.actions.length > 0) {
    parts.push(`Action: ${summary.actions[0]}`);
  }
  if (summary.mentionedFiles.length > 0) {
    parts.push(`Files: ${summary.mentionedFiles.slice(0, 3).join(", ")}`);
  }
  return parts.join(" | ") || `Processed ${summary.originalLength.toLocaleString()} chars of reasoning`;
}

/**
 * Build a plain-text summary string for the pruner placeholder.
 */
function buildSummaryString(trimmed: string): string {
  if (trimmed.length <= 200) return trimmed;

  const sentences = trimmed.split(/[.!?]+/).map(s => s.trim()).filter(Boolean);
  if (sentences.length <= 2) return trimmed.slice(0, 200);

  // Pick the first decision/conclusion and the first action
  let keySentence = sentences[0];
  for (const s of sentences) {
    if (/conclude|decide|determine|found|identify|observe|confirm/i.test(s)) {
      keySentence = s;
      break;
    }
  }
  if (keySentence.length > 200) keySentence = keySentence.slice(0, 200);
  return keySentence;
}

/**
 * Check if text is dominated by thinking content.
 */
export function isThoughtDominated(text: string): boolean {
  const lower = text.toLowerCase().trim();
  const thinkingMarkers = [...THINKING_TAG_NAMES].map(t => `<${t}`).concat([
    "thinking:",
    "reasoning:",
    "thought:",
    "思考",
    "internal",
  ]);
  const markerCount = thinkingMarkers.filter(m => lower.startsWith(m)).length;
  if (markerCount > 0) return true;

  // Count lines that look like reasoning
  const lines = text.split("\n").map(l => l.trim()).filter(Boolean);
  if (lines.length < 5) return false;

  const reasoningLines = lines.filter(l => {
    const ll = l.toLowerCase();
    return /^(thought|thinking|reasoning|analyze|consider|evaluate|examine|reflect)\b/.test(ll);
  });
  return reasoningLines.length / lines.length > 0.6;
}
