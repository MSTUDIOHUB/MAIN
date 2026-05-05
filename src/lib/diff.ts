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
  if (oldLines.length === 0) return newLines.map((text) => ({ type: "added", text }));
  if (newLines.length === 0) return oldLines.map((text) => ({ type: "removed", text }));

  let prefixLen = 0;
  while (prefixLen < oldLines.length && prefixLen < newLines.length && oldLines[prefixLen] === newLines[prefixLen]) {
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

  const lines: DiffLine[] = [];
  for (let i = 0; i < prefixLen; i++) {
    lines.push({ type: "unchanged", text: oldLines[i] });
  }

  const removedLines = oldLines.slice(prefixLen, oldLines.length - suffixLen);
  const addedLines = newLines.slice(prefixLen, newLines.length - suffixLen);

  // Use an LCS diff for the changed middle hunk. This avoids showing a whole
  // block as deleted+rewritten when a few lines changed in the middle.
  if (removedLines.length > 0 && addedLines.length > 0 && removedLines.length * addedLines.length <= 2_000_000) {
    const width = addedLines.length + 1;
    const dp = new Uint32Array((removedLines.length + 1) * width);
    for (let i = removedLines.length - 1; i >= 0; i--) {
      for (let j = addedLines.length - 1; j >= 0; j--) {
        const idx = i * width + j;
        dp[idx] = removedLines[i] === addedLines[j]
          ? dp[(i + 1) * width + j + 1] + 1
          : Math.max(dp[(i + 1) * width + j], dp[i * width + j + 1]);
      }
    }

    let i = 0;
    let j = 0;
    while (i < removedLines.length && j < addedLines.length) {
      if (removedLines[i] === addedLines[j]) {
        lines.push({ type: "unchanged", text: removedLines[i] });
        i++;
        j++;
      } else if (dp[(i + 1) * width + j] >= dp[i * width + j + 1]) {
        lines.push({ type: "removed", text: removedLines[i++] });
      } else {
        lines.push({ type: "added", text: addedLines[j++] });
      }
    }
    for (; i < removedLines.length; i++) lines.push({ type: "removed", text: removedLines[i] });
    for (; j < addedLines.length; j++) lines.push({ type: "added", text: addedLines[j] });
  } else {
    for (const line of removedLines) lines.push({ type: "removed", text: line });
    for (const line of addedLines) lines.push({ type: "added", text: line });
  }

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
