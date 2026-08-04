import type {
  RuntimeV2TranscriptSourceWindow,
} from "./executionProviderSourceTranscript";

export function sourceWindowsExtendContinuousCoverage(
  left: RuntimeV2TranscriptSourceWindow,
  right: RuntimeV2TranscriptSourceWindow,
): boolean {
  return left.version === right.version &&
    (
      (
        right.startLine <= left.endLine + 1 &&
        right.endLine > left.endLine
      ) ||
      (
        right.endLine >= left.startLine - 1 &&
        right.startLine < left.startLine
      )
    );
}

export function deduplicatedSourceWindows(
  windows: readonly RuntimeV2TranscriptSourceWindow[],
): RuntimeV2TranscriptSourceWindow[] {
  const byExactWindow = new Map<string, RuntimeV2TranscriptSourceWindow>();
  for (const window of windows) {
    const key = [
      window.path,
      window.version,
      window.startLine,
      window.endLine,
    ].join(":");
    const existing = byExactWindow.get(key);
    if (
      !existing ||
      (existing.replayed && !window.replayed) ||
      existing.replayed === window.replayed
    ) {
      byExactWindow.set(key, window);
    }
  }
  return [...byExactWindow.values()]
    .sort((left, right) => left.order - right.order);
}

interface RuntimeV2SourceCover {
  readonly windows: readonly RuntimeV2TranscriptSourceWindow[];
  readonly coveredLineSpans: number;
  readonly windowCount: number;
  readonly contentChars: number;
  readonly recency: number;
}

function preferredSourceCover(
  left: RuntimeV2SourceCover | null,
  right: RuntimeV2SourceCover,
): RuntimeV2SourceCover {
  if (!left) return right;
  if (left.coveredLineSpans !== right.coveredLineSpans) {
    return left.coveredLineSpans < right.coveredLineSpans ? left : right;
  }
  if (left.windowCount !== right.windowCount) {
    return left.windowCount < right.windowCount ? left : right;
  }
  if (left.contentChars !== right.contentChars) {
    return left.contentChars < right.contentChars ? left : right;
  }
  return left.recency >= right.recency ? left : right;
}

function minimumSourceCoverForComponent(
  windows: readonly RuntimeV2TranscriptSourceWindow[],
  startLine: number,
  endLine: number,
): readonly RuntimeV2TranscriptSourceWindow[] {
  const memo = new Map<number, RuntimeV2SourceCover | null>();
  const solve = (nextLine: number): RuntimeV2SourceCover | null => {
    if (nextLine > endLine) {
      return {
        windows: [],
        coveredLineSpans: 0,
        windowCount: 0,
        contentChars: 0,
        recency: 0,
      };
    }
    if (memo.has(nextLine)) return memo.get(nextLine) || null;
    let best: RuntimeV2SourceCover | null = null;
    for (const window of windows) {
      if (
        window.startLine > nextLine ||
        window.endLine < nextLine
      ) {
        continue;
      }
      const tail = solve(window.endLine + 1);
      if (!tail) continue;
      best = preferredSourceCover(best, {
        windows: [window, ...tail.windows],
        coveredLineSpans:
          Math.max(0, window.endLine - window.startLine + 1) +
          tail.coveredLineSpans,
        windowCount: tail.windowCount + 1,
        contentChars: window.content.length + tail.contentChars,
        recency: window.order + tail.recency,
      });
    }
    memo.set(nextLine, best);
    return best;
  };
  return solve(startLine)?.windows || [];
}

/** Select the smallest exact interval cover for each path/version. */
export function minimumSourceWindowCover(
  windows: readonly RuntimeV2TranscriptSourceWindow[],
): RuntimeV2TranscriptSourceWindow[] {
  const selected: RuntimeV2TranscriptSourceWindow[] = [];
  const bySource = new Map<string, RuntimeV2TranscriptSourceWindow[]>();
  for (const window of deduplicatedSourceWindows(windows)) {
    const key = `${window.path}\u0000${window.version}`;
    const group = bySource.get(key) || [];
    group.push(window);
    bySource.set(key, group);
  }
  for (const group of bySource.values()) {
    const ordered = [...group].sort((left, right) =>
      left.startLine - right.startLine ||
      left.endLine - right.endLine ||
      left.order - right.order
    );
    if (
      ordered.length > 0 &&
      ordered.every((window) =>
        window.startLine === 0 && window.endLine === 0
      )
    ) {
      selected.push(ordered[ordered.length - 1]!);
      continue;
    }
    let componentStart = -1;
    let componentEnd = -1;
    let componentWindows: RuntimeV2TranscriptSourceWindow[] = [];
    const flush = () => {
      if (componentWindows.length === 0) return;
      selected.push(
        ...minimumSourceCoverForComponent(
          componentWindows,
          componentStart,
          componentEnd,
        ),
      );
      componentWindows = [];
    };
    for (const window of ordered) {
      if (window.startLine <= 0 || window.endLine < window.startLine) {
        continue;
      }
      if (
        componentWindows.length > 0 &&
        window.startLine > componentEnd + 1
      ) {
        flush();
        componentStart = window.startLine;
        componentEnd = window.endLine;
      } else if (componentWindows.length === 0) {
        componentStart = window.startLine;
        componentEnd = window.endLine;
      } else {
        componentEnd = Math.max(componentEnd, window.endLine);
      }
      componentWindows.push(window);
    }
    flush();
  }
  return selected.sort((left, right) => left.order - right.order);
}
