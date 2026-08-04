import type {
  AgentMessage,
  ContentPart,
} from "../../lib/agentMessages";
import { serializeDurableTurnContextForModel } from "../../lib/durableTurnContext";
import { sanitizeAssistantDisplayContent } from "../../lib/sanitize";
import { isWorkspaceMutationToolName } from "../../lib/workspaceMutationTools";
import {
  buildSubagentDelegationGuidance,
} from "../../lib/turnIntake";
import type {
  RuntimeV2NormalizedProviderResult,
  RuntimeV2NormalizedToolCall,
} from "../../lib/runtime-v2";
import type {
  RuntimeV2ExecutionPortsInput,
  RuntimeV2LiveExecutionState,
} from "./executionTypes";
export { upsertRuntimeV2ContextAnchor } from "./executionProviderAnchors";

export function appendRuntimeV2AssistantTextHistory(
  live: RuntimeV2LiveExecutionState,
  content: string,
): void {
  const normalized = sanitizeAssistantDisplayContent(content).trim();
  if (!normalized) return;
  const previous = live.messages[live.messages.length - 1];
  if (
    previous?.role === "assistant" &&
    !previous.tool_calls?.length &&
    previous.content === normalized
  ) {
    return;
  }
  live.messages.push({ role: "assistant", content: normalized });
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
  if (result.toolCalls.length === 0) {
    live.latestProviderAssistantReasoning = null;
    return;
  }
  live.messages.push({
    role: "assistant",
    content: result.visibleText || "",
    ...(live.latestProviderAssistantReasoning?.field === "reasoning_content"
      ? {
          reasoning_content:
            live.latestProviderAssistantReasoning.content,
        }
      : live.latestProviderAssistantReasoning?.field === "reasoning"
        ? { reasoning: live.latestProviderAssistantReasoning.content }
        : {}),
    tool_calls: result.toolCalls.map((call) => ({
      id: call.id,
      type: "function",
      function: {
        name: call.name,
        arguments: JSON.stringify(call.arguments),
      },
    })),
  });
  live.latestProviderAssistantReasoning = null;
}

export function rememberRuntimeV2ProviderResult(
  ports: RuntimeV2ExecutionPortsInput,
  result: RuntimeV2NormalizedProviderResult,
): void {
  ports.live.latestProviderResult = result;
  ports.live.latestVisibleText = result.toolCalls.length === 0
    ? sanitizeAssistantDisplayContent(result.visibleText || "")
      .trim()
      .slice(0, 24_000)
    : "";
  if (ports.live.latestVisibleText) {
    appendRuntimeV2AssistantTextHistory(
      ports.live,
      ports.live.latestVisibleText,
    );
  }
  if (result.toolCalls.length === 0) return;
  for (const call of result.toolCalls) {
    if (!isWorkspaceMutationToolName(call.name)) continue;
    ports.live.mutationSourceCoverageByToolCallId.set(
      call.id,
      ports.live.latestProviderRequestSourceCoverage,
    );
  }
  appendRuntimeV2AssistantToolCallHistory(ports.live, result);
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
 * Close a provider-selected action that the Runtime deliberately did not
 * execute using the same assistant/tool protocol pair as a real tool result.
 * Some local models deterministically replay an action when rejection is only
 * described by a later system message because their native tool state never
 * changed. Keep one pair per normalized action identity so that recovery is
 * causal without allowing a deterministic loop to grow its own transcript.
 *
 * Mutation bodies are omitted from the historical template. The bounded
 * feedback still names safe targets and the lack of effect, while preventing
 * a rejected patch from becoming an executable copy source.
 */
export function appendRuntimeV2RejectedToolCallHistory(
  live: RuntimeV2LiveExecutionState,
  input: {
    readonly call: RuntimeV2NormalizedToolCall;
    readonly actionIdentity: string;
    readonly feedback: string;
  },
): void {
  const actionIdentity = String(input.actionIdentity || "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, 256);
  const feedback = String(input.feedback || "").trim().slice(0, 4_000);
  if (!actionIdentity || !input.call.id || !feedback) return;
  const marker = `[runtime-v2 rejected action: ${actionIdentity}]`;
  const supersededToolCallIds = new Set<string>();
  for (let index = live.messages.length - 1; index >= 0; index -= 1) {
    const message = live.messages[index];
    if (
      message?.role === "tool" &&
      String(message.content || "").startsWith(marker)
    ) {
      supersededToolCallIds.add(String(message.tool_call_id || ""));
      live.messages.splice(index, 1);
    }
  }
  if (supersededToolCallIds.size > 0) {
    for (let index = live.messages.length - 1; index >= 0; index -= 1) {
      const message = live.messages[index];
      if (
        message?.role === "assistant" &&
        message.tool_calls?.length === 1 &&
        supersededToolCallIds.has(message.tool_calls[0]!.id)
      ) {
        live.messages.splice(index, 1);
      }
    }
  }
  const historyArguments = isWorkspaceMutationToolName(input.call.name)
    ? {
        runtime_v2_rejected_action: actionIdentity,
        effect: "none",
      }
    : input.call.arguments;
  live.messages.push({
    role: "assistant",
    content: "",
    tool_calls: [{
      id: input.call.id,
      type: "function",
      function: {
        name: input.call.name,
        arguments: JSON.stringify(historyArguments),
      },
    }],
  }, {
    role: "tool",
    tool_call_id: input.call.id,
    content: `${marker}\n${feedback}`,
  });
  live.latestProviderAssistantReasoning = null;
}

/**
 * Provider feedback is part of the next decision even when no executable
 * assistant/tool pair exists. Preserve bounded causal feedback without
 * reproducing rejected tool arguments; exact duplicates coalesce so a
 * deterministic provider cannot grow its own prompt.
 */
export function appendRuntimeV2ProviderFeedbackHistory(
  live: RuntimeV2LiveExecutionState,
  input: {
    readonly visibleText?: string;
    readonly code: string;
    readonly feedback: string;
  },
): void {
  const visibleText = sanitizeAssistantDisplayContent(
    input.visibleText || "",
  ).trim();
  const code = String(input.code || "protocol_drift").trim();
  const feedback = String(input.feedback || "").trim();
  live.latestProviderAssistantReasoning = null;
  const correction = [
    `[runtime-v2 provider feedback: ${code}]`,
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
  if (!visibleText) {
    for (let index = live.messages.length - 1; index >= 0; index -= 1) {
      const message = live.messages[index];
      if (message?.role === "system" && message.content === correction) {
        live.messages.splice(index, 1);
      }
    }
    live.messages.push({ role: "system", content: correction });
    return;
  }
  if (
    previousCorrection?.content === correction &&
    (
      !visibleText ||
      (
        previousAssistant &&
        previousAssistant.content === visibleText
      )
    )
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

export {
  boundRuntimeV2ProviderConversation,
  buildRuntimeV2DecisionView,
} from "./executionProviderDecisionView";
export { materializedRuntimeV2SourceCoverage } from "./executionProviderSourceCoverage";

function systemInstruction(input: RuntimeV2ExecutionPortsInput): string {
  const workspace = input.context.runWorkspace || "未绑定工作区";
  const language = input.context.phaseLanguage === "en"
    ? "English"
    : "简体中文";
  const readOnlyTurn =
    input.context.runtimeRunIntent === "respond" ||
    input.context.runtimeRunIntent === "discuss" ||
    input.context.runtimeRunIntent === "analyze" ||
    input.context.runtimeRunIntent === "summarize" ||
    input.context.runtimeRunIntent === "report";
  const workspaceInstructions = String(
    input.context.workspaceInstructionContext || "",
  ).trim();
  const collaborationGuidance = buildSubagentDelegationGuidance({
    preference:
      input.context.turnInputContextSignals?.subagentPreference ||
        "unspecified",
    language: input.context.phaseLanguage,
  });
  return [
    "[MAIN RUNTIME V2]",
    `Workspace: ${workspace}`,
    `Respond in: ${language}`,
    "Use structured tools for every read, modification, command, and verification. With a native tool call, you may include one brief public progress sentence in normal response content; MAIN routes it only to Capsule and never uses it as control state. Do not expose private reasoning or repeat that sentence in the final answer.",
    readOnlyTurn
      ? "This is a bounded task with read-only authority. Inspect only the minimum relevant admitted file context. Never request or claim a file mutation, shell command, browser action, or validation effect."
      : "Before a final answer, use evidence from actual tool results. For a repair, make the smallest justified change and run an appropriate finite validation after a modification.",
    readOnlyTurn
      ? "Return one complete evidence-backed Markdown answer and state any remaining uncertainty."
      : "A final answer must state confirmed cause, files changed, validation performed, and any remaining limit. Never claim success merely because a tool call was issued.",
    collaborationGuidance
      ? `[COLLABORATION METHOD]\n${collaborationGuidance}`
      : "",
    workspaceInstructions
      ? [
          "[LIVE WORKSPACE INSTRUCTIONS]",
          "These rules were read from their named project sources at this Turn's admission boundary. They are not conversation memory or a generated summary.",
          workspaceInstructions,
        ].join("\n")
      : "",
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
  if (live.messages.some((message) =>
    message.role === "system" &&
    typeof message.content === "string" &&
    message.content.startsWith("[MAIN RUNTIME V2]")
  )) {
    return live.messages;
  }
  // Observation and plan anchors may be materialized before the first model
  // request. They are additions to the canonical transcript, not proof that
  // its admission prefix (including the current user message) already exists.
  const preloadedContext = live.messages.splice(0);
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
    ...preloadedContext,
  );
  return live.messages;
}

export function providerHistory(
  live: RuntimeV2LiveExecutionState,
  input: RuntimeV2ExecutionPortsInput,
): {
  readonly messages: AgentMessage[];
  readonly chars: number;
  readonly historyMessages: number;
  readonly priorTurns: number;
} {
  const base = baseProviderHistory(live, input);
  const userMessages = base.filter((message) => message.role === "user").length;
  return {
    messages: [...base],
    historyMessages: base.length,
    priorTurns: Math.max(0, userMessages - 1),
    chars: base.reduce(
      (total, message) => total + String(message.content || "").length,
      0,
    ),
  };
}
