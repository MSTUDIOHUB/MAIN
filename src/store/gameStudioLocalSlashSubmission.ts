import type { MainThreadEventInput } from "../lib/turnEvents";
import type { GameStudioSlashResolution } from "../lib/gameStudio";
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
    options?: { systemVariant?: "game_studio_local_markdown" },
  ) => Promise<void>;
  emitRuntimeEvent: (event: MainThreadEventInput) => void;
  logStoreEvent: (event: string, data: Record<string, unknown>) => void;
  nowMs?: () => number;
}

export interface GameStudioLocalSlashSubmissionResult {
  handled: boolean;
  completion: Promise<void> | null;
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

export function startGameStudioLocalSlashSubmission(
  input: GameStudioLocalSlashSubmissionInput,
): GameStudioLocalSlashSubmissionResult {
  const spec = getGameStudioSlashCommandSpec(input.command);
  if (!spec) return { handled: false, completion: null };

  const resolution = input.runtimeService.resolveSlashCommand({
    command: input.command,
    language: input.preferredLanguage,
    onLocaleFallback: ({ slug, language }) => {
      input.logStoreEvent("game_studio_help_locale_fallback", { slug, language });
    },
  });
  if (!resolution || resolution.kind === "workflow") {
    return { handled: false, completion: null };
  }
  if (resolution.kind === "local_markdown" && spec.executionMode !== "local_fast") {
    return { handled: false, completion: null };
  }

  const now = input.nowMs || Date.now;
  input.emitRuntimeEvent({
    type: "slash.command.started",
    threadId: input.runSessionKey,
    turnId: input.turnId,
    timestampMs: now(),
    command: spec.canonicalCommand,
    executionMode: spec.executionMode,
  });

  const completion = (async () => {
    try {
      if (resolution.kind === "agent") {
        const agent = normalizeStudioAgentKey(resolution.slug);
        await input.setActiveStudioAgentKey(agent, {
          persistToWorkspace: input.getGameStudioInitialized(),
        });
        await input.appendLocalStudioTurn(buildAgentSwitchMessage(agent, input.preferredLanguage));
      } else if (resolution.kind === "auto") {
        await input.setActiveStudioAgentKey("studio_auto", {
          persistToWorkspace: input.getGameStudioInitialized(),
        });
        await input.appendLocalStudioTurn(buildAutoSwitchMessage(input.preferredLanguage));
      } else {
        await input.appendLocalStudioTurn(resolution.content, {
          systemVariant: resolution.systemVariant,
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
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error || "Unknown slash command error");
      await input.appendLocalStudioTurn(buildSlashFailureMessage(message, input.preferredLanguage));
      input.emitRuntimeEvent({
        type: "slash.command.failed",
        threadId: input.runSessionKey,
        turnId: input.turnId,
        timestampMs: now(),
        command: spec.canonicalCommand,
        executionMode: spec.executionMode,
        error: { message },
      });
    }
  })();

  return { handled: true, completion };
}
