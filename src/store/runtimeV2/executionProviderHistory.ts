import type { AgentMessage, ContentPart } from "../../lib/agentMessages";
import { serializeDurableTurnContextForModel } from "../../lib/durableTurnContext";
import { sanitizeAssistantDisplayContent } from "../../lib/sanitize";
import type { RuntimeV2NormalizedProviderResult } from "../../lib/runtime-v2";
import { boundRuntimeMessagesToContext } from "../../lib/runtimeContextBudget";
import { boundedToolContent } from "./executionText";
import { contextAnchorIndices } from "./executionProviderContext";
import type {
  RuntimeV2ExecutionPortsInput,
  RuntimeV2LiveExecutionState,
  RuntimeV2ModelContextEntry,
} from "./executionTypes";

const MAX_CONTEXT_ENTRY_CHARS = 5_000;
const MAX_CONTEXT_DIGEST_CHARS = 18_000;
const MAX_CORRECTIVE_CONTEXT_DIGEST_CHARS = 14_000;
const CONTEXT_SOURCES = [
  "workspace",
  "tool",
  "subagent",
  "provider",
  "plan",
] as const;

export interface RuntimeV2ProviderHistoryFocus {
  readonly kind: "corrective_mutation";
  readonly target: string;
  readonly evidenceId: string;
}

/**
 * Preserve the standard assistant side of a tool exchange. Plan, child, and
 * the former v1 loop already use this protocol pair; main execution must do
 * the same so the next request continues from the real tool result.
 */
export function appendRuntimeV2AssistantToolCallHistory(
  live: RuntimeV2LiveExecutionState,
  result: RuntimeV2NormalizedProviderResult,
): void {
  if (result.toolCalls.length === 0) return;
  live.messages.push({
    role: "assistant",
    content: result.visibleText || "",
    tool_calls: result.toolCalls.map((call) => ({
      id: call.id,
      type: "function",
      function: {
        name: call.name,
        arguments: JSON.stringify(call.arguments),
      },
    })),
  });
}

export function appendRuntimeV2ToolResultHistory(
  live: RuntimeV2LiveExecutionState,
  toolCallId: string,
  content: string,
): void {
  if (!toolCallId) return;
  const hasParent = live.messages.some((message) =>
    message.role === "assistant" &&
    message.tool_calls?.some((call) => call.id === toolCallId)
  );
  if (!hasParent) return;
  const existing = live.messages.find((message) =>
    message.role === "tool" &&
    message.tool_call_id === toolCallId
  );
  if (existing) {
    existing.content = content;
    return;
  }
  live.messages.push({
    role: "tool",
    tool_call_id: toolCallId,
    content,
  });
}

/**
 * A provider protocol miss is still part of the conversation. Preserve the
 * assistant response and the runtime-owned correction so a fallback transport
 * or later command cannot resend an identical prompt with no knowledge of the
 * failed attempt. Exact duplicate pairs are coalesced to keep a stubborn
 * provider from growing context without adding information.
 */
export function appendRuntimeV2ProtocolDriftHistory(
  live: RuntimeV2LiveExecutionState,
  input: {
    readonly visibleText: string;
    readonly code: string;
    readonly feedback: string;
  },
): void {
  const visibleText = sanitizeAssistantDisplayContent(
    input.visibleText || "",
  ).trim();
  const code = String(input.code || "protocol_drift").trim();
  const feedback = String(input.feedback || "").trim();
  const correction = [
    `[runtime-v2 protocol feedback: ${code}]`,
    feedback,
  ].filter(Boolean).join("\n");
  if (!correction) return;
  const previousAssistantMessage =
    live.messages[live.messages.length - 2];
  const previousCorrectionMessage =
    live.messages[live.messages.length - 1];
  const previousAssistant =
    previousAssistantMessage?.role === "assistant"
      ? previousAssistantMessage
      : null;
  const previousCorrection =
    previousCorrectionMessage?.role === "system"
      ? previousCorrectionMessage
      : null;
  if (
    previousAssistant &&
    previousAssistant.content === visibleText &&
    previousCorrection?.content === correction
  ) {
    return;
  }
  if (visibleText) {
    live.messages.push({
      role: "assistant",
      content: visibleText,
    });
  }
  live.messages.push({
    role: "system",
    content: correction,
  });
}

/**
 * Apply the shared complete-tool-pair compactor with limits derived from the
 * actual model input budget. This preserves every pair while a large model
 * has capacity and drops oldest complete groups under pressure; it does not
 * impose a fixed number of rounds or messages.
 */
export function boundRuntimeV2ProviderConversation(
  messages: readonly AgentMessage[],
  options: {
    readonly contextLimit: number;
    readonly reservedOutputTokens: number;
  },
): AgentMessage[] {
  return boundRuntimeMessagesToContext(messages, options);
}

function systemInstruction(input: RuntimeV2ExecutionPortsInput): string {
  const workspace = input.context.runWorkspace || "未绑定工作区";
  const language = input.context.phaseLanguage === "en"
    ? "English"
    : "简体中文";
  const readOnlyWorkspaceTurn = !!input.context.runWorkspace &&
    (
      input.context.runtimeRunIntent === "respond" ||
      input.context.runtimeRunIntent === "discuss" ||
      input.context.runtimeRunIntent === "analyze" ||
      input.context.runtimeRunIntent === "summarize" ||
      input.context.runtimeRunIntent === "report"
    );
  return [
    "[MAIN RUNTIME V2]",
    `Workspace: ${workspace}`,
    `Respond in: ${language}`,
    "Use structured tools for every read, modification, command, and verification. With a native tool call, you may include one brief public progress sentence in normal response content; MAIN routes it only to Capsule and never uses it as control state. Do not expose private reasoning or repeat that sentence in the final answer.",
    readOnlyWorkspaceTurn
      ? "This is a workspace task with read-only authority. Inspect only the minimum relevant workspace evidence. Never request or claim a file mutation, shell command, browser action, or validation effect."
      : "Before a final answer, use evidence from actual tool results. For a repair, make the smallest justified change and run an appropriate finite validation after a modification.",
    readOnlyWorkspaceTurn
      ? "Return one complete evidence-backed Markdown answer and state any remaining uncertainty. Do not describe this workspace task as Chat."
      : "A final answer must state confirmed cause, files changed, validation performed, and any remaining limit. Never claim success merely because a tool call was issued.",
  ].join("\n");
}

function conversationText(value: unknown): string {
  return String(value || "").trim();
}

function conversationContent(
  content: AgentMessage["content"],
): AgentMessage["content"] {
  if (typeof content === "string") return conversationText(content);
  let images = 0;
  return content.flatMap((part): ContentPart[] => {
    if (part.type === "text") {
      const text = conversationText(part.text);
      return text ? [{ type: "text", text }] : [];
    }
    if (part.type === "image_url" && images < 4) {
      images += 1;
      return [part];
    }
    return [];
  });
}

function currentTurnUserMessage(
  state: any,
  turnId: string,
  fallback: string,
): AgentMessage {
  const agentMessages = Array.isArray(state?.agentMessages)
    ? state.agentMessages as AgentMessage[]
    : [];
  const exact = [...agentMessages].reverse().find(
    (message) =>
      message.role === "user" &&
      String(message.runtimeTurnId || "").trim() === turnId,
  );
  // Restored transcripts intentionally discard process-local runtimeTurnId.
  // The current submission is still the latest user message at admission.
  const latestUser = [...agentMessages].reverse().find(
    (message) => message.role === "user",
  );
  const selected = exact || latestUser;
  if (!selected) {
    return {
      role: "user",
      content: conversationText(fallback) || "请处理当前任务。",
    };
  }
  return {
    role: "user",
    content: conversationContent(selected.content),
    ...(exact?.runtimeTurnId ? { runtimeTurnId: exact.runtimeTurnId } : {}),
  };
}

function baseProviderHistory(
  live: RuntimeV2LiveExecutionState,
  input: RuntimeV2ExecutionPortsInput,
): AgentMessage[] {
  if (live.messages.length > 0) return live.messages;
  const state = input.get();
  const turns = Array.isArray(state?.conversationTurns)
    ? state.conversationTurns
    : [];
  const turnIndex = turns.findIndex(
    (candidate: any) => candidate.id === input.context.turnId,
  );
  const turn = turnIndex >= 0 ? turns[turnIndex] : null;
  const history: AgentMessage[] = [];
  const priorTurns = (turnIndex >= 0 ? turns.slice(0, turnIndex) : turns)
    .filter((candidate: any) => candidate?.uiVisibility !== "internal");
  for (const prior of priorTurns) {
    const user = conversationText(prior?.userPrompt);
    const assistant = conversationText(
      prior?.durableContext?.finalAssistantAnswer || prior?.summary,
    );
    const durableExecution = conversationText(
      serializeDurableTurnContextForModel(prior?.durableContext),
    );
    const pair: AgentMessage[] = [
      ...(user ? [{ role: "user" as const, content: user }] : []),
      ...(assistant
        ? [{ role: "assistant" as const, content: assistant }]
        : []),
      ...(durableExecution
        ? [{ role: "system" as const, content: durableExecution }]
        : []),
    ];
    history.push(...pair);
  }
  live.messages.push(
    { role: "system", content: systemInstruction(input) },
    ...history,
    currentTurnUserMessage(
      state,
      input.context.turnId,
      String(turn?.userPrompt || ""),
    ),
  );
  return live.messages;
}

function latestIndex(
  entries: readonly RuntimeV2ModelContextEntry[],
  predicate: (entry: RuntimeV2ModelContextEntry) => boolean,
): number {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (predicate(entries[index]!)) return index;
  }
  return -1;
}

function normalizedContextTarget(value: string): string {
  return value.trim().replace(/\\/g, "/").replace(/^\.\//, "");
}

function sameContextTarget(left: string, right: string): boolean {
  const normalizedLeft = normalizedContextTarget(left);
  const normalizedRight = normalizedContextTarget(right);
  if (!normalizedLeft || !normalizedRight) return false;
  return normalizedLeft === normalizedRight ||
    normalizedLeft.endsWith(`/${normalizedRight}`) ||
    normalizedRight.endsWith(`/${normalizedLeft}`);
}

function correctiveContextIndices(
  entries: readonly RuntimeV2ModelContextEntry[],
  focus: RuntimeV2ProviderHistoryFocus,
): number[] {
  const failureIndex = latestIndex(
    entries,
    (entry) => entry.id === focus.evidenceId,
  );
  const sourceIndex = latestIndex(
    entries,
    (entry) =>
      entry.source === "tool" &&
      entry.status === "succeeded" &&
      /(?:^|_)(?:read|open)(?:_|$)/i.test(entry.label) &&
      sameContextTarget(entry.target, focus.target),
  );
  const planIndex = latestIndex(
    entries,
    (entry) => entry.source === "plan",
  );
  const protocolFailureIndex = latestIndex(
    entries,
    (entry) => entry.source === "provider" && entry.status === "failed",
  );
  return [failureIndex, sourceIndex, planIndex, protocolFailureIndex].filter(
    (index, position, all) => index >= 0 && all.indexOf(index) === position,
  );
}

function renderContextEntry(entry: RuntimeV2ModelContextEntry): string {
  const contentLimit = entry.status !== "succeeded"
    ? 4_500
    : entry.source === "plan"
      ? 5_000
      : entry.source === "subagent"
        ? 2_200
        : entry.source === "workspace"
          ? 1_800
          : entry.source === "provider"
            ? 2_000
            : MAX_CONTEXT_ENTRY_CHARS;
  return [
    `\n[${entry.id}] ${entry.source}:${entry.label}`,
    `Target: ${(entry.target || "workspace").slice(0, 240)}`,
    `Status: ${entry.status}`,
    boundedToolContent(entry.content, contentLimit),
  ].join("\n");
}

function buildModelContextDigest(
  live: RuntimeV2LiveExecutionState,
  focus: RuntimeV2ProviderHistoryFocus | null,
): {
  readonly message: AgentMessage | null;
  readonly retained: number;
  readonly dropped: number;
  readonly chars: number;
  readonly retainedSources: Record<string, number>;
} {
  // Ordinary tool outputs already travel in their standard assistant/tool
  // pairs. Repeating them here was both lossy and the main source of context
  // growth. Corrective packets may still pin one indexed tool result beside
  // its failure authority.
  const entries = focus
    ? live.modelContext
    : live.modelContext.filter((entry) => entry.source !== "tool");
  if (entries.length === 0) {
    return {
      message: null,
      retained: 0,
      dropped: live.modelContext.length,
      chars: 0,
      retainedSources: {},
    };
  }
  const targetIndex = [...new Set(entries
    .map((entry) => entry.target)
    .filter(Boolean)
    .map((target) => target.slice(0, 120)))]
    .slice(-8);
  const header = focus
    ? [
        "[runtime-v2 corrective evidence packet]",
        `Correction target: ${focus.target}`,
        `Acceptance authority: ${focus.evidenceId}`,
        "The failed acceptance result and the latest exact source snapshot below are the only repair authority for this action.",
        "Older observations, rejected mutations, and provider prose are intentionally omitted. Fix the first concrete reported gap with one minimal replacement and preserve unrelated code, markup, APIs, and behavior.",
      ].join("\n")
    : [
        "[runtime-v2 structured evidence digest]",
        "Recent tool results are carried by the standard assistant/tool transcript. This digest adds only workspace, approved-plan, provider-diagnostic, and joined-child anchors.",
        targetIndex.length > 0 ? `Known targets: ${targetIndex.join(", ")}` : "",
      ].filter(Boolean).join("\n");
  const retainedIndices = new Set<number>();
  let chars = header.length;
  const limit = focus
    ? MAX_CORRECTIVE_CONTEXT_DIGEST_CHARS
    : MAX_CONTEXT_DIGEST_CHARS;
  const priority = focus
    ? correctiveContextIndices(entries, focus)
    : [
        ...contextAnchorIndices(entries),
        ...entries.map((_entry, index) => index).reverse(),
      ];
  for (const index of priority) {
    if (retainedIndices.has(index)) continue;
    const entry = entries[index]!;
    const section = renderContextEntry(entry);
    if (chars + section.length > limit) continue;
    retainedIndices.add(index);
    chars += section.length;
    if (chars >= limit) break;
  }
  const retained = entries.filter(
    (_entry, index) => retainedIndices.has(index),
  );
  const body = retained.map(renderContextEntry).join("\n");
  const content = `${header}${body}`.slice(0, limit);
  return {
    message: { role: "user", content },
    retained: retained.length,
    dropped: Math.max(0, live.modelContext.length - retained.length),
    chars: content.length,
    retainedSources: Object.fromEntries(CONTEXT_SOURCES.map((source) => [
      source,
      retained.filter((entry) => entry.source === source).length,
    ])),
  };
}

export function providerHistory(
  live: RuntimeV2LiveExecutionState,
  input: RuntimeV2ExecutionPortsInput,
  focus: RuntimeV2ProviderHistoryFocus | null = null,
): {
  readonly messages: AgentMessage[];
  readonly retained: number;
  readonly dropped: number;
  readonly chars: number;
  readonly retainedSources: Record<string, number>;
  readonly focus: RuntimeV2ProviderHistoryFocus | null;
  readonly historyMessages: number;
  readonly priorTurns: number;
} {
  const base = baseProviderHistory(live, input);
  const digest = buildModelContextDigest(live, focus);
  const userMessages = base.filter((message) => message.role === "user").length;
  return {
    messages: digest.message ? [...base, digest.message] : [...base],
    retained: digest.retained,
    dropped: digest.dropped,
    retainedSources: digest.retainedSources,
    focus,
    historyMessages: base.length,
    priorTurns: Math.max(0, userMessages - 1),
    chars: base.reduce(
      (total, message) => total + String(message.content || "").length,
      0,
    ) + digest.chars,
  };
}
