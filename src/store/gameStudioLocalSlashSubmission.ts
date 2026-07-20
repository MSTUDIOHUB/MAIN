import type { MainThreadEventInput } from "../lib/turnEvents";
import type { GameStudioSlashResolution } from "../lib/gameStudio";
import type {
  GameStudioLocalSlashAppendOptions,
  GameStudioLocalSlashAppendResult,
  GameStudioLocalSlashConclusionResolution,
  GameStudioLocalSlashTerminalContext,
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
  /**
   * Linearization boundary for the local side effect. The callback must check
   * cancellation and commit synchronously before returning its Promise. Once
   * invoked successfully, a later abort cannot rewrite the committed action as
   * canceled.
   */
  commitActiveStudioAgentKey: (
    agent: StudioAgentKey,
    options: { persistToWorkspace: boolean },
  ) => Promise<void>;
  appendLocalStudioTurn: (
    systemContent: string,
    options?: GameStudioLocalSlashAppendOptions,
  ) => Promise<GameStudioLocalSlashAppendResult | void>;
  /**
   * Last-resort presentation repair when exact Turn adoption changed while a
   * local-fast command was awaiting asynchronous work. The runtime terminal
   * events are still authoritative; this callback guarantees their visible
   * assistant conclusion without rerunning the command.
   */
  ensureVisibleConclusion: (input: {
    content: string;
    terminal: GameStudioLocalSlashTerminalContext;
    rejectedAppend: Extract<GameStudioLocalSlashAppendResult, { disposition: "rejected" }> | null;
    slashFailure: {
      command: string;
      executionMode: "local_fast" | "model_workflow";
      error: { message: string };
    };
  }) => Promise<GameStudioLocalSlashConclusionResolution> | GameStudioLocalSlashConclusionResolution;
  emitRuntimeEvent: (event: MainThreadEventInput) => void;
  logStoreEvent: (event: string, data: Record<string, unknown>) => void;
  /** Optional exact run identity supplied by the workspace dispatcher. */
  runId?: string;
  parentRunId?: string | null;
  /** Local slash cancellation is terminal and still receives a visible conclusion. */
  abortSignal?: AbortSignal;
  nowMs?: () => number;
  /** Absolute wall-clock budget shared by side effect, projection, and repair. */
  executionTimeoutMs?: number;
}

export interface GameStudioLocalSlashCompletionResult {
  turnId: string;
  runId: string;
  resultKind: "success" | "partial" | "blocked" | "error" | "canceled";
  summary: string;
  conclusionAppended: boolean;
  conclusionOwner: (
    | GameStudioLocalSlashConclusionResolution
    | {
        disposition: "original_appended";
        turnId: string;
        runId: string;
        parentRunId: string | null;
        resultKind: "success" | "error" | "canceled";
        summary: string;
      }
  ) | null;
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

class LocalSlashExecutionTimeoutError extends Error {
  constructor(step: string, timeoutMs: number) {
    super(`Local slash execution timed out after ${timeoutMs}ms while awaiting ${step}`);
    this.name = "LocalSlashExecutionTimeoutError";
  }
}

const DEFAULT_LOCAL_SLASH_EXECUTION_TIMEOUT_MS = 8_000;

function awaitLocalSlashExecutionStep<T>(input: {
  promise: PromiseLike<T> | T;
  step: string;
  deadlineAt: number;
  timeoutMs: number;
  now: () => number;
}): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      callback();
    };
    const remainingMs = Math.max(0, input.deadlineAt - input.now());
    const timeoutId = setTimeout(
      () => finish(() => reject(
        new LocalSlashExecutionTimeoutError(input.step, input.timeoutMs),
      )),
      remainingMs,
    );
    Promise.resolve(input.promise).then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
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
  const executionTimeoutMs = Math.max(
    1,
    Number(input.executionTimeoutMs) || DEFAULT_LOCAL_SLASH_EXECUTION_TIMEOUT_MS,
  );
  const executionDeadlineAt = Date.now() + executionTimeoutMs;
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
    // Let the caller install the exact controller/claim lease before any local
    // side effect or terminal transaction can run.
    await Promise.resolve();
    let sideEffectCommitted = false;
    const appendConclusion = async (
      content: string,
      options: GameStudioLocalSlashAppendOptions,
    ): Promise<GameStudioLocalSlashAppendResult | null> => normalizeAppendResult(
      await awaitLocalSlashExecutionStep({
        promise: input.appendLocalStudioTurn(content, options),
        step: "the terminal projection",
        deadlineAt: executionDeadlineAt,
        timeoutMs: executionTimeoutMs,
        now: Date.now,
      }),
    );

    try {
      assertNotCanceled(input.abortSignal);
      let appendResult: GameStudioLocalSlashAppendResult | null;
      if (resolution.kind === "agent") {
        const agent = normalizeStudioAgentKey(resolution.slug);
        assertNotCanceled(input.abortSignal);
        const commit = input.commitActiveStudioAgentKey(agent, {
          persistToWorkspace: input.getGameStudioInitialized(),
        });
        sideEffectCommitted = true;
        await awaitLocalSlashExecutionStep({
          promise: commit,
          step: "the specialist switch persistence",
          deadlineAt: executionDeadlineAt,
          timeoutMs: executionTimeoutMs,
          now: Date.now,
        });
        const summary = buildAgentSwitchMessage(agent, input.preferredLanguage);
        appendResult = await appendConclusion(summary, {
          presentation: "assistant_final",
          lifecycle: {
            terminal: {
              runId,
              parentRunId,
              resultKind: "success",
              reason: "local_slash_completed",
            },
            slash: {
              command: spec.canonicalCommand,
              executionMode: spec.executionMode,
              outcome: "completed",
            },
          },
        });
      } else if (resolution.kind === "auto") {
        assertNotCanceled(input.abortSignal);
        const commit = input.commitActiveStudioAgentKey("studio_auto", {
          persistToWorkspace: input.getGameStudioInitialized(),
        });
        sideEffectCommitted = true;
        await awaitLocalSlashExecutionStep({
          promise: commit,
          step: "the auto-orchestration persistence",
          deadlineAt: executionDeadlineAt,
          timeoutMs: executionTimeoutMs,
          now: Date.now,
        });
        const summary = buildAutoSwitchMessage(input.preferredLanguage);
        appendResult = await appendConclusion(summary, {
          presentation: "assistant_final",
          lifecycle: {
            terminal: {
              runId,
              parentRunId,
              resultKind: "success",
              reason: "local_slash_completed",
            },
            slash: {
              command: spec.canonicalCommand,
              executionMode: spec.executionMode,
              outcome: "completed",
            },
          },
        });
      } else {
        assertNotCanceled(input.abortSignal);
        appendResult = await appendConclusion(resolution.content, {
          systemVariant: resolution.systemVariant,
          presentation: "assistant_final",
          lifecycle: {
            terminal: {
              runId,
              parentRunId,
              resultKind: "success",
              reason: "local_slash_completed",
            },
            slash: {
              command: spec.canonicalCommand,
              executionMode: spec.executionMode,
              outcome: "completed",
            },
          },
        });
      }

      const summary = resolution.kind === "local_markdown"
        ? resolution.content
        : resolution.kind === "agent"
          ? buildAgentSwitchMessage(normalizeStudioAgentKey(resolution.slug), input.preferredLanguage)
          : buildAutoSwitchMessage(input.preferredLanguage);
      return {
        turnId: input.turnId,
        runId,
        resultKind: "success" as const,
        summary,
        conclusionAppended: true,
        conclusionOwner: {
          disposition: "original_appended",
          turnId: input.turnId,
          runId,
          parentRunId,
          resultKind: "success",
          summary,
        },
        appendResult,
      };
    } catch (error) {
      const abortRequested = error instanceof LocalSlashCanceledError ||
        input.abortSignal?.aborted === true;
      const canceled = abortRequested && !sideEffectCommitted;
      const rawMessage = error instanceof Error
        ? error.message
        : String(error || "Unknown slash command error");
      const message = abortRequested && sideEffectCommitted
        ? "Local slash execution was interrupted after its local side effect committed"
        : rawMessage;
      const resultKind = canceled ? "canceled" as const : "error" as const;
      const summary = canceled
        ? buildSlashCanceledMessage(input.preferredLanguage)
        : buildSlashFailureMessage(message, input.preferredLanguage);
      let appendResult: GameStudioLocalSlashAppendResult | null = null;
      let conclusionAppended = false;
      let conclusionOwner: GameStudioLocalSlashCompletionResult["conclusionOwner"] = null;
      let conclusionError: string | null = null;
      try {
        appendResult = await appendConclusion(summary, {
          presentation: "assistant_final",
          lifecycle: {
            terminal: {
              runId,
              parentRunId,
              resultKind,
              reason: canceled ? "local_slash_canceled" : "local_slash_error",
            },
            slash: {
              command: spec.canonicalCommand,
              executionMode: spec.executionMode,
              outcome: "failed",
              error: { message },
            },
          },
        });
        conclusionAppended = true;
        conclusionOwner = {
          disposition: "original_appended",
          turnId: input.turnId,
          runId,
          parentRunId,
          resultKind,
          summary,
        };
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
      if (!conclusionAppended) {
        try {
          const conclusionResolution = await awaitLocalSlashExecutionStep({
            promise: input.ensureVisibleConclusion({
              content: summary,
              terminal: {
                runId,
                parentRunId,
                resultKind,
                reason: canceled ? "local_slash_canceled" : "local_slash_error",
                timestampMs: now(),
              },
              rejectedAppend: appendResult?.disposition === "rejected" ? appendResult : null,
              slashFailure: {
                command: spec.canonicalCommand,
                executionMode: spec.executionMode,
                error: { message },
              },
            }),
            step: "the visible conclusion repair",
            deadlineAt: executionDeadlineAt,
            timeoutMs: executionTimeoutMs,
            now: Date.now,
          });
          conclusionAppended = true;
          conclusionOwner = conclusionResolution;
        } catch (repairError) {
          const repairMessage = repairError instanceof Error
            ? repairError.message
            : String(repairError || "Unknown local slash conclusion repair error");
          conclusionError = conclusionError
            ? `${conclusionError}; ${repairMessage}`
            : repairMessage;
          input.logStoreEvent("game_studio_local_slash_conclusion_repair_failed", {
            turnId: input.turnId,
            runId,
            resultKind,
            message: repairMessage,
          });
        }
      }
      return {
        turnId: input.turnId,
        runId,
        resultKind: conclusionOwner?.resultKind || resultKind,
        summary: conclusionOwner?.summary || summary,
        conclusionAppended,
        conclusionOwner,
        appendResult,
        error: { message: conclusionError ? `${message}; ${conclusionError}` : message },
      };
    }
  })();

  return { handled: true, runId, completion };
}
