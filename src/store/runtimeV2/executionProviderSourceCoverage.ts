import type { AgentMessage } from "../../lib/agentMessages";
import { normalizeRuntimeV2WorkspacePath } from "./executionProviderContext";
import type { RuntimeV2ProviderEffectFacts } from "./executionProviderEffectFacts";
import { minimumSourceWindowCover } from "./executionProviderSourceCover";
import {
  collectTranscriptToolGroups,
  sourceTargetsOverlap,
  transcriptSourceWindow,
} from "./executionProviderSourceTranscript";
import type {
  RuntimeV2MaterializedSourceCoverage,
} from "./executionTypes";

function completeSourceCoverage(
  totalLines: number,
  windows: readonly {
    readonly startLine: number;
    readonly endLine: number;
  }[],
): boolean {
  if (totalLines === 0) {
    return windows.some((window) =>
      window.startLine === 0 && window.endLine === 0
    );
  }
  const ordered = [...windows]
    .filter((window) =>
      window.startLine > 0 && window.endLine >= window.startLine
    )
    .sort((left, right) =>
      left.startLine - right.startLine || left.endLine - right.endLine
    );
  let coveredThrough = 0;
  for (const window of ordered) {
    if (window.startLine > coveredThrough + 1) return false;
    coveredThrough = Math.max(coveredThrough, window.endLine);
    if (coveredThrough >= totalLines) return true;
  }
  return false;
}

/**
 * Derive write authority from the exact standard source pairs that survived
 * the final outbound request projection. Metadata-only digests and compacted
 * excerpts are deliberately ignored.
 */
export function materializedRuntimeV2SourceCoverage(
  messages: readonly AgentMessage[],
  workspace: string,
  effects?: RuntimeV2ProviderEffectFacts,
): RuntimeV2MaterializedSourceCoverage[] {
  const byTarget = new Map<string, {
    version: string;
    totalLines: number;
    windows: Array<{
      startLine: number;
      endLine: number;
      content: string;
    }>;
  }>();
  const ambiguousTargets = new Set<string>();
  const groups = collectTranscriptToolGroups(messages);
  const committedMutationBoundaries = effects
    ? groups.flatMap((group) =>
        group.calls.flatMap((call) =>
          (effects.committedMutationTargetsByToolCallId.get(call.id) || [])
            .map((target) => ({ target, order: group.order }))
        )
      )
    : [];
  // `messages` is the already projected (and, for provider requests, already
  // context-bounded) decision view. Re-running semantic source selection here
  // can undo an explicit replay-recovery bundle after the replay receipts
  // themselves were compacted out of that view. Every exact source pair that
  // survived projection is therefore materialized directly; effect facts
  // below still prevent replayed or pre-mutation receipts from minting write
  // authority.
  const projectedSources = minimumSourceWindowCover(
    groups.flatMap((group) =>
      group.calls.flatMap((call) => {
        const source = transcriptSourceWindow(group, call, effects);
        return source ? [source] : [];
      })
    ),
  );
  for (const source of projectedSources) {
    // Cached or historical source may remain visible for reasoning, but a
    // write lease is created only by a real versioned read newer than the
    // latest committed mutation of the same target. Exact built-in editors
    // report every changed target, so an unrelated file edit does not make a
    // still-materialized receipt stale. Replayed receipts never mint
    // authority, and the executor still requires exact replace/patch source.
    const latestTargetMutationOrder = Math.max(
      -1,
      ...committedMutationBoundaries
        .filter((boundary) =>
          sourceTargetsOverlap(boundary.target, source.path)
        )
        .map((boundary) => boundary.order),
    );
    if (
      effects &&
      (
        source.replayed ||
        source.order <= latestTargetMutationOrder ||
        !effects.sourceReadVersionsByToolCallId.has(source.callId)
      )
    ) {
      continue;
    }
    const target = normalizeRuntimeV2WorkspacePath(
      source.path,
      workspace,
    );
    const version = source.version;
    if (
      !target ||
      !version ||
      target.startsWith("/") ||
      target.startsWith("../") ||
      target.split("/").includes("..")
    ) {
      continue;
    }
    const existing = byTarget.get(target);
    if (existing && existing.version !== version) {
      byTarget.delete(target);
      ambiguousTargets.add(target);
      continue;
    }
    if (ambiguousTargets.has(target)) continue;
    const coverage = existing || {
      version,
      totalLines: source.totalLines,
      windows: [],
    };
    if (coverage.totalLines !== source.totalLines) {
      byTarget.delete(target);
      ambiguousTargets.add(target);
      continue;
    }
    coverage.windows.push({
      startLine: source.startLine,
      endLine: source.endLine,
      content: source.content,
    });
    byTarget.set(target, coverage);
  }
  return [...byTarget.entries()].map(([target, coverage]) => ({
    target,
    version: coverage.version,
    totalLines: coverage.totalLines,
    windows: coverage.windows,
    complete: completeSourceCoverage(
      coverage.totalLines,
      coverage.windows,
    ),
  }));
}
