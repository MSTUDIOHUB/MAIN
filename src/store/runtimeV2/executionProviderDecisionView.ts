import type { AgentMessage } from "../../lib/agentMessages";
import { boundRuntimeMessagesToContext } from "../../lib/runtimeContextBudget";
import { normalizeRuntimeV2WorkspacePath } from "./executionProviderContext";
import type { RuntimeV2ProviderEffectFacts } from "./executionProviderEffectFacts";
import type {
  RuntimeV2MaterializedSourceCoverage,
} from "./executionTypes";
import {
  RUNTIME_V2_CONTEXT_ANCHOR_PREFIX,
} from "./executionProviderAnchors";
import {
  collectTranscriptToolGroups,
  sourceTargetsOverlap,
  transcriptSourceWindow,
  type RuntimeV2TranscriptSourceWindow,
  type RuntimeV2TranscriptToolGroup,
} from "./executionProviderSourceTranscript";

const RUNTIME_V2_PROVIDER_FEEDBACK_PREFIX =
  "[runtime-v2 provider feedback:";

function messageText(message: AgentMessage): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}


function sourceWindowsExtendContinuousCoverage(
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

function deduplicatedSourceWindows(
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

/**
 * Exact source remains complete, but overlapping receipts are not separate
 * facts. Select the smallest interval cover for each path/version so a model
 * can page through a large file without carrying duplicate source bytes into
 * every later decision.
 */
function minimumSourceWindowCover(
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

function semanticSourceTokens(source: string): Set<string> {
  const tokens = new Set<string>();
  const admit = (raw: string) => {
    const token = raw.trim();
    if (
      token.length < 2 ||
      token.length > 80 ||
      !(
        /[_$@/.-]/.test(token) ||
        /[a-z][A-Z]/.test(token) ||
        /[^\x00-\x7f]/.test(token) ||
        token.length >= 10
      )
    ) {
      return;
    }
    tokens.add(token.toLowerCase());
  };
  for (
    const token of
      source.match(/[A-Za-z_$][A-Za-z0-9_$-]{3,}/g) || []
  ) {
    admit(token);
  }
  const quoted = /(["'`])([^"'`\n]{2,80})\1/g;
  for (const match of source.matchAll(quoted)) {
    const token = String(match[2] || "").trim();
    if (/^[\p{L}\p{N}_@./:-]+$/u.test(token)) admit(token);
  }
  return tokens;
}

function sharedSemanticSourceTokens(
  leftTokens: ReadonlySet<string>,
  rightTokens: ReadonlySet<string>,
): Set<string> {
  const smaller = leftTokens.size <= rightTokens.size
    ? leftTokens
    : rightTokens;
  const larger = smaller === leftTokens ? rightTokens : leftTokens;
  return new Set([...smaller].filter((token) => larger.has(token)));
}

/**
 * Keep the exact source needed for the current provider decision, not a
 * second copy of the Turn archive. Every source selected in the latest read
 * batch remains visible. Prior exact windows remain only when they form a
 * connected caller/callee workset with that batch, or extend the same
 * versioned file continuously. An unrelated batch or a narrower same-file
 * focus replaces old source. The canonical transcript still retains every
 * receipt for exact cache replay.
 */
function activeSourceWindows(
  groups: readonly RuntimeV2TranscriptToolGroup[],
  effects?: RuntimeV2ProviderEffectFacts,
): RuntimeV2TranscriptSourceWindow[] {
  let active: RuntimeV2TranscriptSourceWindow[] = [];
  let realSourcesSinceMutation:
    RuntimeV2TranscriptSourceWindow[] = [];
  let latestMutationOrder = -1;
  const tokensBySource =
    new Map<RuntimeV2TranscriptSourceWindow, Set<string>>();
  const tokensFor = (source: RuntimeV2TranscriptSourceWindow) => {
    const existing = tokensBySource.get(source);
    if (existing) return existing;
    const tokens = semanticSourceTokens(source.content);
    tokensBySource.set(source, tokens);
    return tokens;
  };
  for (const group of groups) {
    let groupCommittedMutation = false;
    for (const call of group.calls) {
      const mutationTargets =
        effects?.committedMutationTargetsByToolCallId.get(call.id) || [];
      if (mutationTargets.length > 0) {
        groupCommittedMutation = true;
        latestMutationOrder = group.order;
        realSourcesSinceMutation = [];
        active = active.filter((source) =>
          !mutationTargets.some((target) =>
            sourceTargetsOverlap(source.path, target)
          )
        );
      }
    }
    const batch = group.calls.flatMap((call) => {
      const source = transcriptSourceWindow(group, call, effects);
      return source?.path && source.version ? [source] : [];
    });
    if (batch.length === 0) continue;

    const next = deduplicatedSourceWindows(batch);
    const currentPaths = new Set(batch.map((source) => source.path));
    // Keep every adjacent window needed to preserve complete same-file
    // coverage. Cross-file continuity is only the nearest decision edge:
    // retaining its transitive ancestors makes every later prompt grow even
    // though the canonical transcript can replay any older exact source.
    const priorCandidates = deduplicatedSourceWindows([
      ...active,
      ...(batch.some((source) => source.replayed)
        ? realSourcesSinceMutation
        : []),
    ]);
    let added = true;
    while (added) {
      added = false;
      for (const previous of priorCandidates) {
        if (next.includes(previous)) continue;
        if (!currentPaths.has(previous.path)) continue;
        const extendsCurrentPath = next.some((current) => {
          if (current.path !== previous.path) return false;
          const continuous =
            sourceWindowsExtendContinuousCoverage(previous, current);
          if (!current.replayed) return continuous;
          return previous.order > latestMutationOrder &&
            current.version === previous.version &&
            (
              continuous ||
              (
                previous.startLine <= current.endLine &&
                previous.endLine >= current.startLine
              )
            );
        });
        if (!extendsCurrentPath) continue;
        next.push(previous);
        added = true;
      }
    }
    const crossPathPredecessors = active.filter(
      (previous) => !currentPaths.has(previous.path),
    );
    // Keep the newest predecessor for every distinct semantic bridge, then
    // walk older predecessors when they introduce another bridge into that
    // workset. This preserves caller -> controller -> view chains without
    // allowing one ubiquitous symbol to pull an unbounded project archive
    // into every later request.
    const admittedBridgeTokens = new Set<string>();
    for (const previous of [...crossPathPredecessors].reverse()) {
      if (next.includes(previous)) continue;
      const sharedTokens = new Set<string>();
      for (const current of next) {
        for (
          const token of sharedSemanticSourceTokens(
            tokensFor(previous),
            tokensFor(current),
          )
        ) {
          sharedTokens.add(token);
        }
      }
      if (
        sharedTokens.size === 0 ||
        ![...sharedTokens].some((token) =>
          !admittedBridgeTokens.has(token)
        )
      ) {
        continue;
      }
      // A semantic bridge selects a versioned source path, not one arbitrary
      // page from that path. Keep its current same-version window set
      // together so reading a related file cannot turn complete large-file
      // coverage back into an incomplete prefix.
      for (const sibling of crossPathPredecessors) {
        if (
          sibling.path === previous.path &&
          sibling.version === previous.version &&
          !next.includes(sibling)
        ) {
          next.push(sibling);
        }
      }
      for (const token of sharedTokens) admittedBridgeTokens.add(token);
    }
    active = deduplicatedSourceWindows(next);
    if (!groupCommittedMutation) {
      realSourcesSinceMutation = deduplicatedSourceWindows([
        ...realSourcesSinceMutation,
        ...batch.filter((source) => !source.replayed),
      ]);
    }
  }
  return minimumSourceWindowCover(active);
}

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
  const latestMutationOrder = effects
    ? Math.max(
        -1,
        ...groups.flatMap((group) =>
          group.calls.some((call) =>
              effects.committedMutationTargetsByToolCallId.has(call.id)
            )
            ? [group.order]
            : []
        ),
      )
    : -1;
  for (const source of activeSourceWindows(groups, effects)) {
      // Cached or historical source may remain visible for reasoning, but a
      // write lease is created only by a real versioned read after the latest
      // global mutation boundary. Replayed receipts never mint authority.
      if (
        effects &&
        (
          source.replayed ||
          source.order <= latestMutationOrder ||
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

function transcriptToolGroupMessages(
  group: RuntimeV2TranscriptToolGroup,
  callIds: ReadonlySet<string> = new Set(
    group.calls.map((call) => call.id),
  ),
  compactSourceByCallId: ReadonlyMap<
  string,
    RuntimeV2TranscriptSourceWindow
  > = new Map(),
  preserveProviderReasoning = false,
): AgentMessage[] {
  const calls = group.calls.filter((call) => callIds.has(call.id));
  if (calls.length === 0) return [];
  const assistant: AgentMessage = { ...group.assistant };
  if (!preserveProviderReasoning) {
    delete assistant.reasoning_content;
    delete assistant.reasoning;
  }
  return [{
    ...assistant,
    tool_calls: calls,
  }, ...calls.flatMap((call) => {
    const result = group.resultsByCallId.get(call.id);
    if (!result) return [];
    const compactSource = compactSourceByCallId.get(call.id);
    if (!compactSource) return [result];
    return [{
      ...result,
      content: [
        "SOURCE_ALREADY_MATERIALIZED",
        `path: ${compactSource.path}`,
        `contentVersion: ${compactSource.version}`,
        `returnedLines: ${compactSource.startLine}-${compactSource.endLine}`,
        "The same-version source covering this range is already present in an earlier standard read_file result in this request.",
        "This acknowledgment is causal continuity only; it is not source content or mutation authority.",
      ].join("\n"),
    }];
  })];
}

function runtimeDecisionAnchorIndices(
  messages: readonly AgentMessage[],
): Set<number> {
  const selected = new Set<number>();
  const runtimeSystemIndex = messages.findIndex((message) =>
    message.role === "system" &&
    messageText(message).includes("[MAIN RUNTIME V2]")
  );
  if (runtimeSystemIndex >= 0) selected.add(runtimeSystemIndex);

  let currentUserIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (
      message.role === "user" &&
      message.runtimeTurnId
    ) {
      currentUserIndex = index;
      break;
    }
  }
  if (currentUserIndex < 0) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index]!;
      if (message.role === "user") {
        currentUserIndex = index;
        break;
      }
    }
  }
  if (currentUserIndex >= 0) {
    selected.add(currentUserIndex);
    let priorAssistantIndex = -1;
    for (let index = currentUserIndex - 1; index >= 0; index -= 1) {
      const message = messages[index]!;
      if (
        message.role === "assistant" &&
        (!message.tool_calls || message.tool_calls.length === 0)
      ) {
        priorAssistantIndex = index;
        selected.add(index);
        break;
      }
    }
    if (priorAssistantIndex >= 0) {
      for (let index = priorAssistantIndex - 1; index >= 0; index -= 1) {
        const message = messages[index]!;
        if (message.role === "user") {
          selected.add(index);
          break;
        }
      }
    }
    for (let index = currentUserIndex - 1; index >= 0; index -= 1) {
      const message = messages[index]!;
      if (
        message.role === "system" &&
        messageText(message).startsWith("[durable_turn_context]")
      ) {
        selected.add(index);
        break;
      }
    }
  }
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (
      message.role === "system" &&
      messageText(message).startsWith(
        RUNTIME_V2_PROVIDER_FEEDBACK_PREFIX,
      )
    ) {
      selected.add(index);
      break;
    }
  }
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!;
    if (
      message.role === "system" &&
      messageText(message).startsWith(RUNTIME_V2_CONTEXT_ANCHOR_PREFIX)
    ) {
      selected.add(index);
    }
  }
  return selected;
}

/**
 * Project the live protocol transcript into a causal decision workset.
 *
 * The active prompt is not a history archive. It contains the deduplicated
 * exact source workset for the current mutation boundary, the latest committed
 * mutation for each target, and the latest result of each distinct action
 * after that boundary. A redundant frontier read remains as a compact causal
 * acknowledgment beside the earlier exact source that already covers it.
 */
export function buildRuntimeV2DecisionView(
  messages: readonly AgentMessage[],
  effects?: RuntimeV2ProviderEffectFacts,
): AgentMessage[] {
  const groups = collectTranscriptToolGroups(messages);
  const frontier = groups[groups.length - 1] || null;
  const frontierIds = new Set(
    frontier?.calls.map((call) => call.id) || [],
  );
  const sourceWindows = groups.flatMap((group) =>
    group.calls.flatMap((call) => {
      const source = transcriptSourceWindow(group, call, effects);
      return source ? [source] : [];
    })
  );
  const activeSources = activeSourceWindows(groups, effects);
  const activeSourceCallIds = new Set(
    activeSources.map((source) => source.callId),
  );
  const latestCommittedCallIdByTarget = new Map<string, {
    readonly callId: string;
    readonly order: number;
  }>();
  for (const group of groups) {
    for (const call of group.calls) {
      for (
        const target of
          effects?.committedMutationTargetsByToolCallId.get(call.id) || []
      ) {
        latestCommittedCallIdByTarget.set(target, {
          callId: call.id,
          order: group.order,
        });
      }
    }
  }
  const latestMutationOrder = Math.max(
    -1,
    ...[...latestCommittedCallIdByTarget.values()]
      .map((entry) => entry.order),
  );
  let latestFailedValidation: {
    readonly callId: string;
    readonly order: number;
  } | null = null;
  for (const group of groups) {
    if (group.order < latestMutationOrder) continue;
    for (const call of group.calls) {
      if (effects?.failedValidationToolCallIds?.has(call.id)) {
        latestFailedValidation = {
          callId: call.id,
          order: group.order,
        };
      }
    }
  }
  const selectedCallIds = new Set([
    ...activeSourceCallIds,
    ...[...latestCommittedCallIdByTarget.values()]
      .map((entry) => entry.callId),
    ...(latestFailedValidation
      ? [latestFailedValidation.callId]
      : []),
    ...[...frontierIds].filter((callId) =>
      !effects?.replayedToolCallIds.has(callId) ||
      activeSourceCallIds.has(callId)
    ),
  ]);
  const compactSourceByCallId = new Map(
    sourceWindows
      .filter((source) =>
        selectedCallIds.has(source.callId) &&
        !activeSourceCallIds.has(source.callId)
      )
      .map((source) => [source.callId, source]),
  );
  const anchors = runtimeDecisionAnchorIndices(messages);
  const orderedParts: Array<{
    readonly order: number;
    readonly messages: AgentMessage[];
  }> = [...anchors].map((index) => ({
    order: index,
    messages: [messages[index]!],
  }));
  for (const group of groups) {
    const groupSelectedIds = new Set(
      group.calls
        .map((call) => call.id)
        .filter((callId) => selectedCallIds.has(callId)),
    );
    if (groupSelectedIds.size === 0) continue;
    orderedParts.push({
      order: group.order,
      messages: transcriptToolGroupMessages(
        group,
        groupSelectedIds,
        compactSourceByCallId,
        group === frontier,
      ),
    });
  }
  orderedParts.sort((left, right) => left.order - right.order);
  return orderedParts.flatMap((part) => part.messages);
}

/**
 * Build the semantic decision view first. The shared token budget is only a
 * final hard-cap guard for genuinely large current facts, never the target
 * size of the model's working set.
 */
export function boundRuntimeV2ProviderConversation(
  messages: readonly AgentMessage[],
  options: {
    readonly contextLimit: number;
    readonly reservedOutputTokens: number;
  },
  effects?: RuntimeV2ProviderEffectFacts,
): AgentMessage[] {
  return boundRuntimeMessagesToContext(
    buildRuntimeV2DecisionView(messages, effects),
    options,
  );
}
