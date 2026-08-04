import { parseApplyPatch } from "../../lib/applyPatchTool";
import {
  isWorkspaceMutationToolName,
  resolveWorkspaceMutationCreationTargets,
  resolveWorkspaceMutationTargets,
} from "../../lib/workspaceMutationTools";
import { workspacePathsReferToSameFile } from "../../lib/workspacePaths";
import { normalizeRuntimeV2WorkspacePath } from "./executionProviderContext";
import { aggregateForCurrentTurn } from "./executionAggregate";
import type {
  RuntimeV2ExecutionPortsInput,
  RuntimeV2MaterializedSourceCoverage,
} from "./executionTypes";

export interface RuntimeV2MutationLease {
  readonly target: string;
  readonly authority: "materialized_provider_source";
  readonly evidenceId: string;
  readonly version: string;
  readonly complete: boolean;
  readonly windows: readonly {
    readonly startLine: number;
    readonly endLine: number;
    readonly content: string;
  }[];
}

export interface RuntimeV2MutationRecoveryExcerpt {
  readonly target: string;
  readonly version: string;
  readonly startLine: number;
  readonly endLine: number;
  /** Exact current-source bytes only. Provider-authored replacement content
   * is deliberately never copied into this recovery receipt. */
  readonly content: string;
}

/**
 * A mutation lease belongs to the exact provider response that proposed the
 * mutation. Historical model context, acceptance digests, and source that was
 * removed by final token bounding cannot manufacture write authority.
 */
export function runtimeV2MutationLeases(
  input: RuntimeV2ExecutionPortsInput,
  toolCallId: string,
): RuntimeV2MutationLease[] {
  if (aggregateForCurrentTurn(input)?.strategy === "plan") return [];
  const coverage =
    input.live.mutationSourceCoverageByToolCallId.get(toolCallId) || [];
  return coverage.map((source) => ({
    target: source.target,
    authority: "materialized_provider_source" as const,
    evidenceId:
      `provider-request-source:${toolCallId}:${source.target}:${source.version}`,
    version: source.version,
    complete: source.complete,
    windows: source.windows,
  }));
}

export function runtimeV2MutationLease(
  input: RuntimeV2ExecutionPortsInput,
  toolCallId: string,
): RuntimeV2MutationLease | null {
  const leases = runtimeV2MutationLeases(input, toolCallId);
  return leases[leases.length - 1] || null;
}

/** Attribute a structurally invalid editor call to its active lease only for
 * recovery bookkeeping. The original empty/malformed arguments still reach
 * authorization unchanged and therefore cannot acquire write authority. */
export function runtimeV2MutationFailureContextTarget(input: {
  readonly ports: RuntimeV2ExecutionPortsInput;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly requestedTarget: string;
}): string {
  if (input.requestedTarget) return input.requestedTarget;
  if (!isWorkspaceMutationToolName(input.toolName)) return "";
  return runtimeV2MutationLease(input.ports, input.toolCallId)?.target || "";
}

function joinedVisibleSourceWindows(
  lease: RuntimeV2MutationLease,
): Array<{
  readonly startLine: number;
  readonly endLine: number;
  readonly content: string;
}> {
  const ordered = [...lease.windows].sort((left, right) =>
    left.startLine - right.startLine || left.endLine - right.endLine
  );
  const groups: Array<{
    startLine: number;
    endLine: number;
    content: string;
  }> = [];
  for (const window of ordered) {
    const previous = groups[groups.length - 1];
    if (previous && window.startLine === previous.endLine + 1) {
      previous.content += `${
        previous.content.endsWith("\n") ? "" : "\n"
      }${window.content}`;
      previous.endLine = window.endLine;
    } else {
      groups.push({
        startLine: window.startLine,
        endLine: window.endLine,
        content: window.content,
      });
    }
  }
  return groups;
}

function visibleSourceContains(
  lease: RuntimeV2MutationLease,
  value: string,
): boolean {
  if (!value) return false;
  const alternatives = value.endsWith("\n")
    ? [value, value.slice(0, -1)]
    : [value];
  return joinedVisibleSourceWindows(lease).some((source) =>
    alternatives.some((candidate) =>
      !!candidate && source.content.includes(candidate)
    )
  );
}

function matchingTextAt(
  source: string,
  searchText: string,
  sourceStart: number,
  searchStart = 0,
): number {
  const available = Math.min(
    searchText.length - searchStart,
    source.length - sourceStart,
  );
  let matched = 0;
  while (
    matched < available &&
    source.charCodeAt(sourceStart + matched) ===
      searchText.charCodeAt(searchStart + matched)
  ) {
    matched += 1;
  }
  return matched;
}

function bestSearchPrefixAlignment(
  source: string,
  searchText: string,
): {
  readonly sourceStart: number;
  readonly matched: number;
  readonly focusIndex: number;
} | null {
  if (!source || !searchText) return null;
  const seedLengths = [128, 64, 32, 16, 8]
    .map((length) => Math.min(length, searchText.length))
    .filter((length, index, lengths) =>
      length > 0 && lengths.indexOf(length) === index
    );
  let best: {
    sourceStart: number;
    matched: number;
    focusIndex: number;
  } | null = null;
  for (const seedLength of seedLengths) {
    const seed = searchText.slice(0, seedLength);
    let fromIndex = 0;
    let occurrenceCount = 0;
    while (fromIndex <= source.length && occurrenceCount < 64) {
      const sourceStart = source.indexOf(seed, fromIndex);
      if (sourceStart < 0) break;
      occurrenceCount += 1;
      const matched = matchingTextAt(
        source,
        searchText,
        sourceStart,
      );
      if (!best || matched > best.matched) {
        best = {
          sourceStart,
          matched,
          focusIndex: sourceStart + matched,
        };
      }
      fromIndex = sourceStart + Math.max(1, seed.length);
    }
    if (best?.matched === searchText.length) return best;
  }

  // A reconstructed prefix can align with the wrong copy of a duplicated
  // declaration. Probe exact later lines as resynchronization anchors and
  // score the entire continuous suffix from each anchor, rather than choosing
  // the first or longest single line. This keeps mutation matching exact but
  // centers recovery on the real discontinuity (for example a damaged token
  // followed by several verbatim current-source lines).
  let searchOffset = 0;
  let alignmentCandidates = 0;
  for (const line of searchText.split("\n")) {
    if (line.trim().length >= 8) {
      let fromIndex = 0;
      while (fromIndex <= source.length && alignmentCandidates < 512) {
        const occurrence = source.indexOf(line, fromIndex);
        if (occurrence < 0) break;
        alignmentCandidates += 1;
        const matched = matchingTextAt(
          source,
          searchText,
          occurrence,
          searchOffset,
        );
        if (!best || matched > best.matched) {
          best = {
            sourceStart: Math.max(0, occurrence - searchOffset),
            matched,
            // For a later resynchronization anchor, show where the exact
            // provider text rejoins current source. For a true prefix match,
            // show the first mismatching byte instead.
            focusIndex: searchOffset > 0
              ? occurrence
              : occurrence + matched,
          };
        }
        fromIndex = occurrence + Math.max(1, line.length);
      }
    }
    searchOffset += line.length + 1;
  }
  return best;
}

function buildReplaceMismatchRecoveryExcerpt(
  lease: RuntimeV2MutationLease,
  searchText: string,
): RuntimeV2MutationRecoveryExcerpt | null {
  let best: {
    readonly source: ReturnType<typeof joinedVisibleSourceWindows>[number];
    readonly sourceStart: number;
    readonly matched: number;
    readonly focusIndex: number;
  } | null = null;
  for (const source of joinedVisibleSourceWindows(lease)) {
    const alignment = bestSearchPrefixAlignment(
      source.content,
      searchText,
    );
    if (
      alignment &&
      (!best || alignment.matched > best.matched)
    ) {
      best = { source, ...alignment };
    }
  }
  if (!best) return null;

  const sourceLines = best.source.content.split("\n");
  const mismatchIndex = Math.min(
    best.source.content.length,
    best.focusIndex,
  );
  const centerLineOffset = best.source.content
    .slice(0, mismatchIndex)
    .split("\n").length - 1;
  let startOffset = Math.max(0, centerLineOffset - 8);
  let endOffset = Math.min(
    sourceLines.length - 1,
    centerLineOffset + 12,
  );
  let content = sourceLines.slice(startOffset, endOffset + 1).join("\n");
  while (
    content.length > 6_000 &&
    (startOffset < centerLineOffset || endOffset > centerLineOffset)
  ) {
    if (
      centerLineOffset - startOffset >=
      endOffset - centerLineOffset
    ) {
      startOffset += 1;
    } else {
      endOffset -= 1;
    }
    content = sourceLines.slice(startOffset, endOffset + 1).join("\n");
  }
  if (!content) return null;
  return {
    target: lease.target,
    version: lease.version,
    startLine: best.source.startLine + startOffset,
    endLine: best.source.startLine + endOffset,
    content: content.slice(0, 6_000),
  };
}

function leaseCoversMutation(
  toolName: string,
  args: Record<string, unknown>,
  target: string,
  lease: RuntimeV2MutationLease,
  workspace: string,
): boolean {
  if (toolName === "replace_in_file") {
    // The mutation preflight and executor both require search_text to be
    // unique in the complete current file. The lease therefore needs to prove
    // only that the exact proposed block was visible to the model; it does not
    // force an unrelated prefix read for a focused large-file correction.
    const searchText = String(
      args.search_text ?? args.old_text ?? "",
    );
    if (!searchText) return false;
    return visibleSourceContains(lease, searchText);
  }
  if (toolName === "apply_patch") {
    const parsed = parseApplyPatch(String(args.patch || ""));
    if (!parsed.ok) return false;
    const operations = parsed.operations.filter((operation) =>
      normalizeRuntimeV2WorkspacePath(operation.path, workspace) === target
    );
    if (operations.length === 0) return false;
    return operations.every((operation) => {
      if (operation.kind === "add") return true;
      if (operation.kind === "delete") return lease.complete;
      return operation.hunks.length > 0 &&
        operation.hunks.every((hunk) =>
          visibleSourceContains(lease, hunk.oldText)
        );
    });
  }
  return lease.complete;
}

/**
 * Decide whether the exact source that survived the latest provider request
 * covers the current-source side of a previously rejected mutation. A same-
 * file prefix is not enough for a focused patch elsewhere in a large file.
 * This helper never publishes the rejected patch; it only keeps the
 * target-locked read window open until the required old block is genuinely
 * visible.
 */
export function runtimeV2MaterializedSourceCoversMutation(input: {
  readonly toolName: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly target?: string;
  readonly sourceCoverage: readonly RuntimeV2MaterializedSourceCoverage[];
  readonly workspace?: string;
}): boolean {
  const workspace = String(input.workspace || "");
  const args = input.args as Record<string, unknown>;
  const requestedTargets = resolveWorkspaceMutationTargets(
    input.toolName,
    args,
    String(input.target || ""),
  ).map((target) => normalizeRuntimeV2WorkspacePath(target, workspace));
  if (requestedTargets.length === 0) return false;

  return requestedTargets.every((target) => {
    const coverage = input.sourceCoverage.find((candidate) =>
      workspacePathsReferToSameFile(candidate.target, target)
    );
    if (!coverage) return false;
    const lease: RuntimeV2MutationLease = {
      target,
      authority: "materialized_provider_source",
      evidenceId: `provider-request-source:corrective:${target}:${coverage.version}`,
      version: coverage.version,
      complete: coverage.complete,
      windows: coverage.windows,
    };
    return leaseCoversMutation(
      input.toolName,
      args,
      target,
      lease,
      workspace,
    );
  });
}

export function validateRuntimeV2MutationLease(input: {
  readonly ports: RuntimeV2ExecutionPortsInput;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly args: Record<string, unknown>;
  readonly target: string;
}): {
  readonly allowed: boolean;
  readonly lease: RuntimeV2MutationLease | null;
  readonly leases: readonly RuntimeV2MutationLease[];
  readonly unexpectedTargets: readonly string[];
  readonly recoveryExcerpt: RuntimeV2MutationRecoveryExcerpt | null;
  readonly reasonCode:
    | "mutation_source_lease_missing"
    | "mutation_source_text_mismatch"
    | "mutation_target_lease_mismatch";
} | null {
  const leases = runtimeV2MutationLeases(
    input.ports,
    input.toolCallId,
  );
  const aggregate = aggregateForCurrentTurn(input.ports);
  if (aggregate?.strategy === "plan") return null;
  const workspace = input.ports.context.runWorkspace || "";
  const requestedTargets = resolveWorkspaceMutationTargets(
    input.toolName,
    input.args,
    input.target,
  ).map((target) =>
    normalizeRuntimeV2WorkspacePath(
      target,
      input.ports.context.runWorkspace || "",
    )
  );
  const creationTargets = new Set(
    resolveWorkspaceMutationCreationTargets(
      input.toolName,
      input.args,
      input.target,
    ).map((target) =>
      normalizeRuntimeV2WorkspacePath(target, workspace)
    ),
  );
  if (input.toolName === "write_file") {
    requestedTargets.forEach((target) => creationTargets.add(target));
  }
  const leasesByTarget = new Map(
    leases.map((lease) => [lease.target, lease]),
  );
  const requiresLeasedRecoveryMutation =
    input.ports.live.latestProviderActionWindow !== null;
  const unexpectedTargets = requestedTargets.filter(
    (target) => {
      if (
        creationTargets.has(target) &&
        !leasesByTarget.has(target) &&
        !requiresLeasedRecoveryMutation
      ) {
        return false;
      }
      const lease = leasesByTarget.get(target);
      return !lease || !leaseCoversMutation(
        input.toolName,
        input.args,
        target,
        lease,
        workspace,
      );
    },
  );
  if (
    leases.length === 0 &&
    unexpectedTargets.length > 0 &&
    !aggregate
  ) {
    return null;
  }
  const searchText = input.toolName === "replace_in_file"
    ? String(input.args.search_text ?? input.args.old_text ?? "")
    : "";
  const sourceTextMismatch = !!searchText &&
    input.toolName === "replace_in_file" &&
    unexpectedTargets.length > 0 &&
    unexpectedTargets.every((target) => leasesByTarget.has(target));
  const mismatchLease = sourceTextMismatch
    ? unexpectedTargets
        .map((target) => leasesByTarget.get(target))
        .find(Boolean) || null
    : null;
  return {
    lease: requestedTargets
      .map((target) => leasesByTarget.get(target))
      .find(Boolean) || leases[leases.length - 1] || null,
    leases,
    unexpectedTargets,
    recoveryExcerpt: mismatchLease
      ? buildReplaceMismatchRecoveryExcerpt(
          mismatchLease,
          searchText,
        )
      : null,
    allowed: requestedTargets.length > 0 &&
      unexpectedTargets.length === 0,
    reasonCode: leases.length === 0
      ? "mutation_source_lease_missing"
      : sourceTextMismatch
        ? "mutation_source_text_mismatch"
        : "mutation_target_lease_mismatch",
  };
}
