import type { AgentMessage } from "../../lib/agentMessages";
import { boundRuntimeMessagesToContext } from "../../lib/runtimeContextBudget";
import type { RuntimeV2ProviderEffectFacts } from "./executionProviderEffectFacts";
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
import {
  deduplicatedSourceWindows,
  minimumSourceWindowCover,
  sourceWindowsExtendContinuousCoverage,
} from "./executionProviderSourceCover";

const RUNTIME_V2_PROVIDER_FEEDBACK_PREFIX =
  "[runtime-v2 provider feedback:";

function messageText(message: AgentMessage): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

function parsedToolArguments(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function boundedCorrectiveFailureTarget(
  value: unknown,
): string | null {
  const target = String(value || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\//, "");
  if (
    !target ||
    target.length > 300 ||
    /[\u0000-\u001f\u007f]/.test(target) ||
    target.startsWith("/") ||
    target.startsWith("../") ||
    target.split("/").includes("..")
  ) {
    return null;
  }
  return target;
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
  const replayRecoveryVersionsByPath = new Map<string, string>();
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
        replayRecoveryVersionsByPath.clear();
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
    for (const source of batch) {
      if (source.replayed) {
        replayRecoveryVersionsByPath.set(source.path, source.version);
      }
    }
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
    // A cached replay means the model explicitly needed a source that the
    // semantic projection had evicted. Remember every such path until the
    // next mutation boundary and restore its original real receipt alongside
    // later replayed paths. This turns A -> B -> A -> B recovery into one
    // converged multi-file workset. Only explicitly replayed same-version
    // paths are admitted; ordinary unrelated reads still replace the active
    // batch, and the shared context budget remains the final byte cap.
    for (const source of realSourcesSinceMutation) {
      if (
        replayRecoveryVersionsByPath.get(source.path) === source.version &&
        !next.includes(source)
      ) {
        next.push(source);
      }
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

/**
 * A mutation can be rejected because its target source was evicted from the
 * final provider workset even though an exact receipt for that unchanged
 * target still exists in the canonical transcript. Re-materialize only the
 * target named by the durable corrective failure, and only from source newer
 * than the latest committed mutation that overlaps that target. The ordinary
 * context bound remains the final authority; if this source cannot survive
 * bounding, inspection stays open and no mutation lease is granted.
 */
function correctiveRecoverySourceWindows(
  groups: readonly RuntimeV2TranscriptToolGroup[],
  sourceWindows: readonly RuntimeV2TranscriptSourceWindow[],
  effects?: RuntimeV2ProviderEffectFacts,
): RuntimeV2TranscriptSourceWindow[] {
  if (!effects?.correctiveMutationFailureToolCallIds?.size) return [];
  const targets = [...new Set(
    [...effects.correctiveMutationFailureToolCallIds].flatMap((callId) =>
      effects.correctiveReplayTargetsByToolCallId?.get(callId) || []
    ),
  )];
  const selected: RuntimeV2TranscriptSourceWindow[] = [];
  for (const target of targets) {
    let latestTargetMutationOrder = -1;
    for (const group of groups) {
      const overlapsCommittedMutation = group.calls.some((call) =>
        (effects.committedMutationTargetsByToolCallId.get(call.id) || [])
          .some((mutationTarget) =>
            sourceTargetsOverlap(mutationTarget, target)
          )
      );
      if (overlapsCommittedMutation) {
        latestTargetMutationOrder = Math.max(
          latestTargetMutationOrder,
          group.order,
        );
      }
    }
    const eligible = sourceWindows.filter((source) =>
      source.order > latestTargetMutationOrder &&
      sourceTargetsOverlap(source.path, target)
    );
    const newest = eligible.reduce<RuntimeV2TranscriptSourceWindow | null>(
      (current, source) =>
        !current || source.order > current.order ? source : current,
      null,
    );
    if (!newest) continue;
    selected.push(...eligible.filter((source) =>
      source.path === newest.path && source.version === newest.version
    ));
  }
  return minimumSourceWindowCover(
    deduplicatedSourceWindows(selected),
  );
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
  compactCorrectiveFailureCallIds: ReadonlySet<string> = new Set(),
): AgentMessage[] {
  const calls = group.calls.filter((call) => callIds.has(call.id));
  if (calls.length === 0) return [];
  const historyCalls = calls.map((call) => {
    if (!compactCorrectiveFailureCallIds.has(call.id)) return call;
    const args = parsedToolArguments(call.function.arguments);
    const target = boundedCorrectiveFailureTarget(
      args.path ?? args.file_path ?? args.target,
    );
    return {
      ...call,
      function: {
        ...call.function,
        arguments: JSON.stringify({
          runtime_v2_corrective_failure: true,
          ...(target ? { path: target } : {}),
          effect: "none",
        }),
      },
    };
  });
  const assistant: AgentMessage = { ...group.assistant };
  if (!preserveProviderReasoning) {
    delete assistant.reasoning_content;
    delete assistant.reasoning;
  }
  return [{
    ...assistant,
    tool_calls: historyCalls,
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
  const activeSources = minimumSourceWindowCover(
    deduplicatedSourceWindows([
      ...activeSourceWindows(groups, effects),
      ...correctiveRecoverySourceWindows(
        groups,
        sourceWindows,
        effects,
      ),
    ]),
  );
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
  let latestCorrectiveMutationFailure: {
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
      if (
        effects?.correctiveMutationFailureToolCallIds?.has(call.id)
      ) {
        latestCorrectiveMutationFailure = {
          callId: call.id,
          order: group.order,
        };
      }
    }
  }
  const correctiveMutationFailureInstruction = (() => {
    if (!latestCorrectiveMutationFailure) return null;
    const owner = groups.find((group) =>
      group.calls.some((call) =>
        call.id === latestCorrectiveMutationFailure?.callId
      )
    );
    const call = owner?.calls.find((candidate) =>
      candidate.id === latestCorrectiveMutationFailure?.callId
    );
    const result = owner?.resultsByCallId.get(
      latestCorrectiveMutationFailure.callId,
    );
    const diagnostic = result ? messageText(result).trim() : "";
    if (!call || !diagnostic) return null;
    const args = parsedToolArguments(call.function.arguments);
    const target = boundedCorrectiveFailureTarget(
      args.path ?? args.file_path ?? args.target,
    );
    return {
      role: "system" as const,
      content: [
        "[runtime-v2 corrective mutation feedback]",
        "ACTION_NOT_EXECUTED: the latest workspace mutation was rejected and changed no files.",
        target ? `target: ${target}` : "",
        "effect: none",
        "Keep this exact diagnostic active across recovery reads. Derive a materially different, smaller mutation from the visible current source; do not reconstruct the rejected patch.",
        diagnostic.slice(0, 6_000),
      ].filter(Boolean).join("\n"),
    };
  })();
  const selectedCallIds = new Set([
    ...activeSourceCallIds,
    ...[...latestCommittedCallIdByTarget.values()]
      .map((entry) => entry.callId),
    ...(latestFailedValidation
      ? [latestFailedValidation.callId]
      : []),
    ...(latestCorrectiveMutationFailure
      ? [latestCorrectiveMutationFailure.callId]
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
        latestCorrectiveMutationFailure?.callId
          ? new Set([latestCorrectiveMutationFailure.callId])
          : new Set(),
      ),
    });
  }
  if (correctiveMutationFailureInstruction) {
    orderedParts.push({
      order: messages.length + 1,
      messages: [correctiveMutationFailureInstruction],
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
