import type { AgentMessage, ContentPart } from "../../lib/agentMessages";
import { deriveBudgetedStreamSettings } from "../../lib/providerLaneSettings";
import {
  boundRuntimeMessagesToContext,
  type RuntimeContextBudget,
} from "../../lib/runtimeContextBudget";
import {
  abortedAgentLoopOutcome,
  completedAgentLoopOutcome,
} from "../../lib/runOutcome";
import type { RuntimeRunSettlement } from "../../lib/runtimeRunSettlement";
import { isRuntimeV2GlobalChatTurn } from "../../lib/runtimeEngineSelection";
import {
  normalizeProviderResponseV1,
  type ProviderPort,
  type RuntimeV2RunIdentity,
  type RuntimeV2TurnIdentity,
} from "../../lib/runtime-v2";
import {
  runRuntimeV2ChatLoop,
  type RuntimeV2ChatLoopResult,
} from "../../lib/runtime-v2/chat";
import { sanitizeAssistantDisplayContent } from "../../lib/sanitize";
import { streamChatCompletion } from "../../lib/streaming";
import type { ConversationTurn } from "../../lib/workflowModels";
import { getRuntimeV2Checkpoint, createRuntimeV2CheckpointPort } from "./checkpointPort";
import { createRuntimeV2ProjectionPort } from "./projectionPort";
import type { RuntimeV2SubmissionContext } from "./submissionContext";

type StoreGet = () => any;
type StoreSet = (patchOrUpdater: any) => void;

export interface RuntimeV2ChatProviderRequest {
  readonly messages: readonly AgentMessage[];
  readonly config: unknown;
  readonly signal: AbortSignal;
  readonly runtimeContextBudget?: RuntimeContextBudget | null;
}

export type RuntimeV2ChatProviderRequester = (
  input: RuntimeV2ChatProviderRequest,
) => Promise<{
  readonly visibleText: string;
  readonly toolCalls?: readonly {
    readonly id: string;
    readonly name: string;
    readonly arguments: string | Readonly<Record<string, unknown>>;
  }[];
  readonly usage?: Readonly<Record<string, number>>;
  readonly protocolViolation?: string | null;
}>;

export interface RuntimeV2ChatRunnerInput {
  readonly get: StoreGet;
  readonly set: StoreSet;
  readonly context: RuntimeV2SubmissionContext;
  readonly getSessionRevisionToken: () => unknown;
  readonly sanitizeTaskBlocksForPersist: (blocks: any[]) => any[];
  readonly buildSessionRuntimeSnapshot: (state: any) => unknown;
  readonly publishOwnerScopedRuntimeProjection: (input: {
    projectedState: any;
    durableState?: any;
    scopeKey: string;
    sessionId: number | string | null | undefined;
    expectedRevisionToken: unknown;
  }) => { published: boolean; disposition: string };
  readonly persistSessionRecord: (scopeKey: string, session: unknown) => Promise<unknown>;
  readonly logStoreEvent: (event: string, data?: Record<string, unknown>) => void;
  readonly requestProvider?: RuntimeV2ChatProviderRequester;
  readonly now?: () => number;
  readonly deadlineMs?: number;
}

const CHAT_DEADLINE_MS = 4 * 60_000;

function normalizedText(value: unknown, max?: number): string {
  const text = String(value || "").trim();
  return max === undefined || text.length <= max
    ? text
    : `${text.slice(0, Math.max(0, max - 42))}\n[Runtime v2 truncated older context.]`;
}

function retainedContent(content: AgentMessage["content"]): AgentMessage["content"] {
  if (typeof content === "string") return normalizedText(content);
  let imageCount = 0;
  return content.flatMap((part): ContentPart[] => {
    if (part.type === "text") {
      const text = normalizedText(part.text);
      return text ? [{ type: "text", text }] : [];
    }
    if (part.type === "image_url" && imageCount < 4) {
      imageCount += 1;
      return [part];
    }
    return [];
  });
}

function contentChars(content: AgentMessage["content"]): number {
  if (typeof content === "string") return content.length;
  return content.reduce((total, part) =>
    total + (part.type === "text" ? part.text.length : 128), 0);
}

function contentText(content: AgentMessage["content"]): string {
  return typeof content === "string"
    ? content.trim()
    : content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n")
      .trim();
}

export function buildRuntimeV2ChatMessages(input: {
  readonly history: readonly AgentMessage[];
  readonly objective: string;
  readonly workspace: string | undefined;
  readonly language: "zh" | "en";
}): AgentMessage[] {
  const candidates = input.history
    .filter((message) =>
      (message.role === "user" || message.role === "assistant") &&
      !message.tool_calls?.length
    )
    .map((message): AgentMessage => ({
      role: message.role,
      content: retainedContent(message.content),
      ...(message.runtimeTurnId ? { runtimeTurnId: message.runtimeTurnId } : {}),
    }))
    .filter((message) => contentChars(message.content) > 0);

  const objective = normalizedText(input.objective);
  const lastUser = [...candidates].reverse().find((message) => message.role === "user");
  const lastUserText = lastUser ? contentText(lastUser.content) : "";
  if (lastUserText !== objective) {
    candidates.push({ role: "user", content: objective });
  }

  return [{
    role: "system",
    content: [
      "[MAIN RUNTIME V2 CHAT]",
      `Workspace label: ${normalizedText(input.workspace || "global", 2_000)}`,
      `Respond in: ${input.language === "en" ? "English" : "简体中文"}`,
      "This is a conversation-only Turn. No tools, shell, browser, validation, child agents, file reads, or workspace mutations are available.",
      "Answer from the supplied conversation context. Do not claim that you inspected, changed, ran, or verified external state.",
      "Return one complete user-facing Markdown reply. Do not emit private reasoning or tool-call envelopes.",
    ].join("\n"),
  }, ...candidates];
}

function parseArguments(value: unknown): Readonly<Record<string, unknown>> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Readonly<Record<string, unknown>>;
  }
  try {
    const parsed = JSON.parse(String(value || ""));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Readonly<Record<string, unknown>>
      : {};
  } catch {
    return {};
  }
}

async function defaultProviderRequest(
  input: RuntimeV2ChatProviderRequest,
): Promise<Awaited<ReturnType<RuntimeV2ChatProviderRequester>>> {
  let streamedText = "";
  const settings = deriveBudgetedStreamSettings(
    input.config as Parameters<typeof deriveBudgetedStreamSettings>[0],
    input.runtimeContextBudget,
  );
  const maxOutputTokens = input.runtimeContextBudget?.outputBudget;
  const result = await streamChatCompletion(
    [...input.messages],
    settings,
    {
      onToken: (token) => { streamedText += token; },
      onDone: () => undefined,
      onError: () => undefined,
    },
    input.signal,
    [],
    maxOutputTokens,
    { toolChoice: "none" },
  );
  return {
    visibleText: result.content || streamedText,
    toolCalls: result.toolCalls,
    usage: result.usage,
    protocolViolation: result.protocolViolation || null,
  };
}

function createDeadlineSignal(
  parent: AbortSignal,
  deadlineAt: number,
  now: () => number,
): { readonly signal: AbortSignal; readonly dispose: () => void } {
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(parent.reason);
  if (parent.aborted) forwardAbort();
  else parent.addEventListener("abort", forwardAbort, { once: true });
  const remaining = Math.max(0, deadlineAt - now());
  const timer = setTimeout(() => {
    controller.abort(new Error("RUNTIME_V2_CHAT_DEADLINE_EXCEEDED"));
  }, remaining);
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      parent.removeEventListener("abort", forwardAbort);
    },
  };
}

export function createRuntimeV2ChatProviderPort(input: {
  readonly get: StoreGet;
  readonly context: RuntimeV2SubmissionContext;
  readonly objective: string;
  readonly requestProvider: RuntimeV2ChatProviderRequester;
  readonly deadlineAt: number;
  readonly now: () => number;
  readonly logStoreEvent: RuntimeV2ChatRunnerInput["logStoreEvent"];
}): ProviderPort {
  const frozenState = input.get();
  const frozenConfig = frozenState.config;
  const frozenMessages = buildRuntimeV2ChatMessages({
    history: Array.isArray(frozenState.agentMessages) ? frozenState.agentMessages : [],
    objective: input.objective,
    workspace: input.context.runWorkspace,
    language: input.context.phaseLanguage,
  });
  const requestMessages = input.context.runtimeContextBudget
    ? boundRuntimeMessagesToContext(frozenMessages, {
        contextLimit: input.context.runtimeContextBudget.contextLimit,
        reservedOutputTokens:
          input.context.runtimeContextBudget.outputBudget,
      })
    : frozenMessages;
  return {
    async request({ command, signal }) {
      const deadline = createDeadlineSignal(signal, input.deadlineAt, input.now);
      try {
        input.logStoreEvent("runtime_v2_chat_provider_request_opened", {
          turnId: command.run.turnId,
          runId: command.run.runId,
          historyMessages: requestMessages.length - 1,
          unboundedHistoryMessages: frozenMessages.length - 1,
          contextLimit:
            input.context.runtimeContextBudget?.contextLimit ?? null,
          offeredToolCount: 0,
        });
        const result = await input.requestProvider({
          messages: requestMessages,
          config: frozenConfig,
          signal: deadline.signal,
          runtimeContextBudget: input.context.runtimeContextBudget,
        });
        if (deadline.signal.aborted && !signal.aborted) {
          throw new Error("RUNTIME_V2_CHAT_DEADLINE_EXCEEDED");
        }
        const normalized = normalizeProviderResponseV1({
          visibleText: sanitizeAssistantDisplayContent(result.visibleText || "")
            .trim(),
          toolCalls: (result.toolCalls || []).map((call) => ({
            id: call.id,
            name: call.name,
            arguments: parseArguments(call.arguments),
          })),
          usage: result.usage,
          diagnostics: result.protocolViolation
            ? [{
                code: result.protocolViolation,
                message: "Conversation-only provider protocol mismatch.",
                retryable: false,
              }]
            : [],
        });
        input.logStoreEvent("runtime_v2_chat_provider_result", {
          turnId: command.run.turnId,
          runId: command.run.runId,
          visibleChars: normalized.visibleText?.length || 0,
          returnedToolCalls: normalized.toolCalls.length,
          diagnosticCount: normalized.diagnostics.length,
        });
        return normalized;
      } finally {
        deadline.dispose();
      }
    },
  };
}

function currentTurn(state: any, turnId: string): ConversationTurn | null {
  return state?.conversationTurns?.find((turn: ConversationTurn) => turn.id === turnId) || null;
}

export function buildRuntimeV2ChatIdentities(
  state: any,
  context: RuntimeV2SubmissionContext,
  turn: ConversationTurn,
): { readonly turn: RuntimeV2TurnIdentity; readonly run: RuntimeV2RunIdentity } {
  const lifecycle = state?.planLifecycle;
  const sessionEpoch = lifecycle?.sessionKey === context.runSessionKey &&
    String(lifecycle.sessionEpoch || "").trim()
    ? String(lifecycle.sessionEpoch).trim()
    : `runtime-v2:${String(turn.clientSubmissionId || turn.id).trim()}`;
  return {
    turn: {
      workspaceKey: String(context.runScopeKey).trim(),
      sessionKey: context.runSessionKey,
      sessionEpoch,
      clientSubmissionId: String(turn.clientSubmissionId || turn.id).trim(),
      turnId: context.turnId,
    },
    run: {
      sessionKey: context.runSessionKey,
      sessionEpoch,
      turnId: context.turnId,
      runId: context.harnessRunId,
      parentRunId: null,
      attemptId: context.harnessRunId,
    },
  };
}

function settlement(
  context: RuntimeV2SubmissionContext,
  result: RuntimeV2ChatLoopResult,
): RuntimeRunSettlement {
  const outcome = result.resultKind === "canceled"
    ? abortedAgentLoopOutcome(result.reason)
    : completedAgentLoopOutcome(result.reason, result.resultKind);
  return {
    disposition: "projected",
    reason: outcome.reason,
    identity: {
      sessionKey: context.runSessionKey,
      turnId: context.turnId,
      runId: context.harnessRunId,
      parentRunId: null,
      outerRunId: context.harnessRunId,
    },
    outcome,
  };
}

/** Production Store adapter for workspace-free conversation intents only. */
export async function runSubmitRuntimeV2Chat(
  input: RuntimeV2ChatRunnerInput,
): Promise<RuntimeRunSettlement> {
  if (!isRuntimeV2GlobalChatTurn(
    input.context.runtimeRunIntent,
    input.context.runWorkspace,
  )) {
    throw new Error("RUNTIME_V2_CHAT_REJECTS_WORKSPACE_SESSION");
  }
  const now = input.now || Date.now;
  const deadlineMs = Math.max(1, input.deadlineMs ?? CHAT_DEADLINE_MS);
  const initialState = input.get();
  const turn = currentTurn(initialState, input.context.turnId);
  if (!turn) throw new Error(`RUNTIME_V2_CHAT_TURN_MISSING:${input.context.turnId}`);
  const identity = buildRuntimeV2ChatIdentities(initialState, input.context, turn);
  const existing = getRuntimeV2Checkpoint(initialState, identity.turn);
  if (existing && existing.aggregate.run?.identity.runId !== identity.run.runId) {
    input.logStoreEvent("runtime_v2_chat_stale_checkpoint_quarantined", {
      turnId: identity.turn.turnId,
      requestedRunId: identity.run.runId,
      checkpointRunId: existing.aggregate.run?.identity.runId || null,
      revision: existing.revision,
    });
    throw new Error("RUNTIME_V2_CHAT_STALE_RUN_CHECKPOINT");
  }
  const checkpoint = createRuntimeV2CheckpointPort({
    get: input.get,
    set: input.set,
    scopeKey: input.context.runScopeKey,
    sessionId: input.context.runSessionId,
    getSessionRevisionToken: input.getSessionRevisionToken,
    sanitizeTaskBlocksForPersist: input.sanitizeTaskBlocksForPersist,
    buildSessionRuntimeSnapshot: input.buildSessionRuntimeSnapshot,
    persistSessionRecord: input.persistSessionRecord,
    publishOwnerScopedRuntimeProjection: input.publishOwnerScopedRuntimeProjection,
    logStoreEvent: input.logStoreEvent,
  });
  const admittedAt = existing?.aggregate.events.find((event) =>
    event.type === "run.started"
  )?.at ?? now();
  const provider = createRuntimeV2ChatProviderPort({
    get: input.get,
    context: input.context,
    objective: turn.userPrompt,
    requestProvider: input.requestProvider || defaultProviderRequest,
    deadlineAt: admittedAt + deadlineMs,
    now,
    logStoreEvent: input.logStoreEvent,
  });
  const deniedEffect = async () => {
    throw new Error("RUNTIME_V2_CHAT_EFFECT_SURFACE_DENIED");
  };
  let ordinal = 0;
  const nextId = (scope: string) => `${scope}:${now().toString(36)}:${++ordinal}`;

  input.logStoreEvent(existing ? "runtime_v2_chat_resumed" : "runtime_v2_chat_admitted", {
    turnId: identity.turn.turnId,
    runId: identity.run.runId,
    strategy: "chat",
    offeredToolCount: 0,
  });

  try {
    const result = await runRuntimeV2ChatLoop({
      ports: {
        checkpoint,
        provider,
        tool: { execute: deniedEffect },
        scheduler: { execute: deniedEffect },
        projection: createRuntimeV2ProjectionPort({
          get: input.get,
          set: input.set,
          nextTaskId: () => input.get()._nextTaskId(),
          language: input.context.phaseLanguage,
          logStoreEvent: input.logStoreEvent,
        }),
        clockId: {
          now,
          nextId,
          nextIdempotencyKey: ({ run, kind }) =>
            `${run.runId}:${kind}:${nextId("idempotency")}`,
        },
      },
      turn: identity.turn,
      run: identity.run,
      objective: turn.userPrompt,
      signal: input.context.abortCtrl.signal,
      ...(existing
        ? { initial: { aggregate: existing.aggregate, revision: existing.revision } }
        : {}),
      now,
      deadlineMs,
    });
    input.logStoreEvent("runtime_v2_chat_terminal", {
      turnId: identity.turn.turnId,
      runId: identity.run.runId,
      resultKind: result.resultKind,
      reason: result.reason,
      providerResponses: result.aggregate.events.filter((event) =>
        event.type === "provider.responded"
      ).length,
      toolCommands: result.aggregate.events.filter((event) =>
        event.type === "command.scheduled" &&
        (event.command.kind === "execute_tool" ||
          event.command.kind === "execute_validation" ||
          event.command.kind === "schedule_subagents" ||
          event.command.kind === "join_subagents")
      ).length,
    });
    return settlement(input.context, result);
  } finally {
    clearInterval(input.context.timerInterval as ReturnType<typeof setInterval>);
  }
}
