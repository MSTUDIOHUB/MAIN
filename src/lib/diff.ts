export interface DiffLine {
  type: "unchanged" | "removed" | "added";
  text: string;
}

function splitLines(text: string): string[] {
  return text.length === 0 ? [] : text.split("\n");
}

export function buildLineDiff(oldText: string, newText: string): DiffLine[] {
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);
  const lines: DiffLine[] = [];

  let prefixLen = 0;
  while (prefixLen < oldLines.length && prefixLen < newLines.length && oldLines[prefixLen] === newLines[prefixLen]) {
    lines.push({ type: "unchanged", text: oldLines[prefixLen] });
    prefixLen++;
  }

  let suffixLen = 0;
  while (
    suffixLen < (oldLines.length - prefixLen) &&
    suffixLen < (newLines.length - prefixLen) &&
    oldLines[oldLines.length - 1 - suffixLen] === newLines[newLines.length - 1 - suffixLen]
  ) {
    suffixLen++;
  }

  const removedLines = oldLines.slice(prefixLen, oldLines.length - suffixLen);
  const addedLines = newLines.slice(prefixLen, newLines.length - suffixLen);

  for (const line of removedLines) lines.push({ type: "removed", text: line });
  for (const line of addedLines) lines.push({ type: "added", text: line });
  for (let i = 0; i < suffixLen; i++) {
    lines.push({ type: "unchanged", text: oldLines[oldLines.length - suffixLen + i] });
  }

  return lines;
}

export function getDiffStats(oldText: string, newText: string): { added: number; removed: number } {
  const lines = buildLineDiff(oldText, newText);
  let added = 0;
  let removed = 0;

  for (const line of lines) {
    if (line.type === "added") added++;
    if (line.type === "removed") removed++;
  }

  return { added, removed };
}
