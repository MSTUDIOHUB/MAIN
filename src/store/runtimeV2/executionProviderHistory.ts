import type { AgentMessage } from "../../lib/agentMessages";
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

function baseProviderHistory(
  live: RuntimeV2LiveExecutionState,
  input: RuntimeV2ExecutionPortsInput,
): AgentMessage[] {
  if (live.messages.length > 0) return live.messages;
  const turn = input.get().conversationTurns?.find(
    (candidate: any) => candidate.id === input.context.turnId,
  );
  live.messages.push(
    { role: "system", content: systemInstruction(input) },
    {
      role: "user",
      content: String(turn?.userPrompt || "").trim().slice(0, 12_000) ||
        "请处理当前任务。",
    },
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
  if (live.modelContext.length === 0) {
    return {
      message: null,
      retained: 0,
      dropped: 0,
      chars: 0,
      retainedSources: {},
    };
  }
  const targetIndex = [...new Set(live.modelContext
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
        "The approved WorkPlan is execution authority. Actual tool results and joined read-only child reports are evidence. Provider synthesis is labeled separately, remains untrusted, and cannot change lifecycle state.",
        "Re-read a target if exact bytes are no longer retained.",
        targetIndex.length > 0 ? `Known targets: ${targetIndex.join(", ")}` : "",
      ].filter(Boolean).join("\n");
  const retainedIndices = new Set<number>();
  let chars = header.length;
  const limit = focus
    ? MAX_CORRECTIVE_CONTEXT_DIGEST_CHARS
    : MAX_CONTEXT_DIGEST_CHARS;
  const priority = focus
    ? correctiveContextIndices(live.modelContext, focus)
    : [
        ...contextAnchorIndices(live.modelContext),
        ...live.modelContext.map((_entry, index) => index).reverse(),
      ];
  for (const index of priority) {
    if (retainedIndices.has(index)) continue;
    const entry = live.modelContext[index]!;
    const section = renderContextEntry(entry);
    if (chars + section.length > limit) continue;
    retainedIndices.add(index);
    chars += section.length;
    if (chars >= limit) break;
  }
  const retained = live.modelContext.filter(
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
} {
  const base = baseProviderHistory(live, input);
  const digest = buildModelContextDigest(live, focus);
  return {
    messages: digest.message ? [...base, digest.message] : [...base],
    retained: digest.retained,
    dropped: digest.dropped,
    retainedSources: digest.retainedSources,
    focus,
    chars: base.reduce(
      (total, message) => total + String(message.content || "").length,
      0,
    ) + digest.chars,
  };
}
