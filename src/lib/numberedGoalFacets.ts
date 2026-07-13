export interface NumberedUserGoalFacet {
  index: number;
  text: string;
}

const NUMBERED_GOAL_LINE_RE = /^\s*(\d{1,2})\s*[、.)．]\s*(.+?)\s*$/;

export function extractNumberedUserGoalFacets(value: string): NumberedUserGoalFacet[] {
  return String(value || "")
    .split(/\r?\n/)
    .map((line) => line.match(NUMBERED_GOAL_LINE_RE))
    .filter((match): match is RegExpMatchArray => !!match)
    .map((match) => ({ index: Number(match[1]), text: match[2].trim() }))
    .filter((facet) => facet.text.length >= 4);
}

export function preserveNumberedUserGoalLines(value: string, maxChars = 1200): string | null {
  const lines = String(value || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (extractNumberedUserGoalFacets(lines.join("\n")).length < 2) return null;
  return lines.join("\n").slice(0, Math.max(1, maxChars)).trim();
}
