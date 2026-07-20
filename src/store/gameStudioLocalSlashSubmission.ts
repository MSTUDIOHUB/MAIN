import type { MainThreadEventInput } from "../lib/turnEvents";
import type { GameStudioSlashResolution } from "../lib/gameStudio";
import type {
  GameStudioLocalSlashAppendOptions,
  GameStudioLocalSlashAppendResult,
} from "./gameStudioLocalSlashBridge";
import {
  getGameStudioSlashCommandSpec,
  normalizeStudioAgentKey,
  type PendingSlashCommand,
  type StudioAgentKey,
} from "../lib/gameStudio/catalog";

export interface GameStudioLocalSlashRuntimeService {
  resolveSlashCommand(params: {
    command: PendingSlashCommand | null;
    language: "zh" | "en";
    onLocaleFallback?: (event: { slug: string; language: "zh" | "en" }) => void;
  }): GameStudioSlashResolution | null;
}

export interface GameStudioLocalSlashSubmissionInput {
  command: PendingSlashCommand | null;
  preferredLanguage: "zh" | "en";
  runSessionKey: string;
  turnId: string;
  runtimeService: GameStudioLocalSlashRuntimeService;
  getGameStudioInitialized: () => boolean;
  setActiveStudioAgentKey: (
    agent: StudioAgentKey,
    options: { persistToWorkspace: boolean },
  ) => Promise<void>;
  appendLocalStudioTurn: (
    systemContent: string,
    options?: GameStudioLocalSlashAppendOptions,
  ) => Promise<GameStudioLocalSlashAppendResult | void>;
  emitRuntimeEvent: (event: MainThreadEventInput) => void;
  logStoreEvent: (event: string, data: Record<string, unknown>) => void;
  /** Optional exact run identity supplied by the workspace dispatcher. */
  runId?: string;
  parentRunId?: string | null;
  /** Local slash cancellation is terminal and still receives a visible conclusion. */
  abortSignal?: AbortSignal;
  nowMs?: () => number;
}

export interface GameStudioLocalSlashCompletionResult {
  turnId: string;
  runId: string;
  resultKind: "success" | "error" | "canceled";
  summary: string;
  conclusionAppended: boolean;
  appendResult: GameStudioLocalSlashAppendResult | null;
  error?: { message: string };
}

export interface GameStudioLocalSlashSubmissionResult {
  handled: boolean;
  runId: string | null;
  completion: Promise<GameStudioLocalSlashCompletionResult> | null;
}

function buildAgentSwitchMessage(agent: string, language: "zh" | "en"): string {
  return language === "en"
    ? `Game Studio specialist switched to \`${agent}\`. Future messages will follow this specialist until you send \`/auto\`.`
    : `Game Studio 当前专家已切换为 \`${agent}\`。后续普通消息会默认按该专家视角继续；发送 \`/auto\` 可恢复自动编排。`;
}

function buildAutoSwitchMessage(language: "zh" | "en"): string {
  return language === "en"
    ? "Game Studio has switched back to auto-orchestration."
    : "Game Studio 已恢复自动编排。后续消息将不再固定绑定某个专家。";
}

function buildSlashFailureMessage(message: string, language: "zh" | "en"): string {
  return language === "en"
    ? `Slash command failed: ${message}`
    : `斜杠命令执行失败：${message}`;
}

function buildSlashCanceledMessage(language: "zh" | "en"): string {
  return language === "en"
    ? "Slash command canceled. No further local action was performed."
    : "斜杠命令已取消，未继续执行后续本地操作。";
}

class LocalSlashAppendRejectedError extends Error {
  readonly appendResult: Extract<GameStudioLocalSlashAppendResult, { disposition: "rejected" }>;

  constructor(result: Extract<GameStudioLocalSlashAppendResult, { disposition: "rejected" }>) {
    super(`Local slash Turn adoption rejected: ${result.adoptionDecision.reason}`);
    this.name = "LocalSlashAppendRejectedError";
    this.appendResult = result;
  }
}

class LocalSlashCanceledError extends Error {
  constructor() {
    super("Local slash command canceled");
    this.name = "AbortError";
  }
}

function assertNotCanceled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new LocalSlashCanceledError();
}

function normalizeAppendResult(
  result: GameStudioLocalSlashAppendResult | void,
): GameStudioLocalSlashAppendResult | null {
  if (!result) return null;
  if (result.disposition === "rejected") throw new LocalSlashAppendRejectedError(result);
  return result;
}

export function startGameStudioLocalSlashSubmission(
  input: GameStudioLocalSlashSubmissionInput,
): GameStudioLocalSlashSubmissionResult {
  const spec = getGameStudioSlashCommandSpec(input.command);
  if (!spec) return { handled: false, runId: null, completion: null };

  const resolution = input.runtimeService.resolveSlashCommand({
    command: input.command,
    language: input.preferredLanguage,
    onLocaleFallback: ({ slug, language }) => {
      input.logStoreEvent("game_studio_help_locale_fallback", { slug, language });
    },
  });
  if (!resolution || resolution.kind === "workflow") {
    return { handled: false, runId: null, completion: null };
  }
  if (resolution.kind === "local_markdown" && spec.executionMode !== "local_fast") {
    return { handled: false, runId: null, completion: null };
  }

  const now = input.nowMs || Date.now;
  const runId = input.runId || `run-local-slash-${input.turnId}`;
  const parentRunId = input.parentRunId ?? null;
  input.emitRuntimeEvent({
    type: "run.started",
    threadId: input.runSessionKey,
    turnId: input.turnId,
    timestampMs: now(),
    runId,
    parentRunId,
  });
  input.emitRuntimeEvent({
    type: "slash.command.started",
    threadId: input.runSessionKey,
    turnId: input.turnId,
    timestampMs: now(),
    command: spec.canonicalCommand,
    executionMode: spec.executionMode,
  });

  const completion: Promise<GameStudioLocalSlashCompletionResult> = (async () => {
    let terminalEmitted = false;
    const emitTerminal = (
      resultKind: GameStudioLocalSlashCompletionResult["resultKind"],
      summary: string,
    ) => {
      if (terminalEmitted) return;
      terminalEmitted = true;
      const timestampMs = now();
      input.emitRuntimeEvent({
        type: "run.completed",
        threadId: input.runSessionKey,
        turnId: input.turnId,
        timestampMs,
        runId,
        parentRunId,
        resultKind,
        summary,
      });
      input.emitRuntimeEvent({
        type: "turn.completed",
        threadId: input.runSessionKey,
        turnId: input.turnId,
        timestampMs,
        resultKind,
      });
    };
    const appendConclusion = async (
      content: string,
      options: GameStudioLocalSlashAppendOptions,
    ): Promise<GameStudioLocalSlashAppendResult | null> => normalizeAppendResult(
      await input.appendLocalStudioTurn(content, options),
    );

    try {
      assertNotCanceled(input.abortSignal);
      let appendResult: GameStudioLocalSlashAppendResult | null;
      if (resolution.kind === "agent") {
        const agent = normalizeStudioAgentKey(resolution.slug);
        await input.setActiveStudioAgentKey(agent, {
          persistToWorkspace: input.getGameStudioInitialized(),
        });
        assertNotCanceled(input.abortSignal);
        const summary = buildAgentSwitchMessage(agent, input.preferredLanguage);
        appendResult = await appendConclusion(summary, {
          terminal: {
            runId,
            parentRunId,
            resultKind: "success",
            reason: "local_slash_completed",
          },
        });
      } else if (resolution.kind === "auto") {
        await input.setActiveStudioAgentKey("studio_auto", {
          persistToWorkspace: input.getGameStudioInitialized(),
        });
        assertNotCanceled(input.abortSignal);
        const summary = buildAutoSwitchMessage(input.preferredLanguage);
        appendResult = await appendConclusion(summary, {
          terminal: {
            runId,
            parentRunId,
            resultKind: "success",
            reason: "local_slash_completed",
          },
        });
      } else {
        appendResult = await appendConclusion(resolution.content, {
          systemVariant: resolution.systemVariant,
          terminal: {
            runId,
            parentRunId,
            resultKind: "success",
            reason: "local_slash_completed",
          },
        });
      }

      input.emitRuntimeEvent({
        type: "slash.command.completed",
        threadId: input.runSessionKey,
        turnId: input.turnId,
        timestampMs: now(),
        command: spec.canonicalCommand,
        executionMode: spec.executionMode,
      });
      const summary = resolution.kind === "local_markdown"
        ? resolution.content
        : resolution.kind === "agent"
          ? buildAgentSwitchMessage(normalizeStudioAgentKey(resolution.slug), input.preferredLanguage)
          : buildAutoSwitchMessage(input.preferredLanguage);
      emitTerminal("success", summary);
      return {
        turnId: input.turnId,
        runId,
        resultKind: "success" as const,
        summary,
        conclusionAppended: true,
        appendResult,
      };
    } catch (error) {
      const canceled = input.abortSignal?.aborted === true || error instanceof LocalSlashCanceledError;
      const message = error instanceof Error ? error.message : String(error || "Unknown slash command error");
      const resultKind = canceled ? "canceled" as const : "error" as const;
      const summary = canceled
        ? buildSlashCanceledMessage(input.preferredLanguage)
        : buildSlashFailureMessage(message, input.preferredLanguage);
      let appendResult: GameStudioLocalSlashAppendResult | null = null;
      let conclusionAppended = false;
      let conclusionError: string | null = null;
      try {
        appendResult = await appendConclusion(summary, {
          presentation: "assistant_final",
          terminal: {
            runId,
            parentRunId,
            resultKind,
            reason: canceled ? "local_slash_canceled" : "local_slash_error",
          },
        });
        conclusionAppended = true;
      } catch (appendError) {
        conclusionError = appendError instanceof Error
          ? appendError.message
          : String(appendError || "Unknown local slash conclusion error");
        if (appendError instanceof LocalSlashAppendRejectedError) {
          appendResult = appendError.appendResult;
        }
        input.logStoreEvent("game_studio_local_slash_conclusion_append_failed", {
          turnId: input.turnId,
          runId,
          resultKind,
          message: conclusionError,
        });
      }
      input.emitRuntimeEvent({
        type: "slash.command.failed",
        threadId: input.runSessionKey,
        turnId: input.turnId,
        timestampMs: now(),
        command: spec.canonicalCommand,
        executionMode: spec.executionMode,
        error: { message },
      });
      emitTerminal(resultKind, summary);
      return {
        turnId: input.turnId,
        runId,
        resultKind,
        summary,
        conclusionAppended,
        appendResult,
        error: { message: conclusionError ? `${message}; ${conclusionError}` : message },
      };
    }
  })();

  return { handled: true, runId, completion };
}
