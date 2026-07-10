import type { PlanStage } from "../workflowModels";
import type { MainModeKey } from "../mainModes";
import type {
  PendingRunDecision,
  PendingRunDecisionChoice,
  ResolvedRunIntent,
} from "../runIntent";
import {
  looksLikePlanContinuationOrApprovalInput,
} from "../runIntent";
import type { GameDevelopmentIntentSignal } from "./detection";
import type {
  NexusModeKey,
  PendingSlashCommand,
  StudioAgentKey,
  StudioConfig,
  StudioEngineKey,
} from "./catalog";
import {
  buildGameStudioEnvelopeForTurn,
  ensureGameStudioWorkspaceInitialized,
  formatGameStudioCommandDocForDisplay,
  formatGameStudioMissingCommandDoc,
  hasBundledGameStudioLocalizedCommandMarkdown,
  loadGameStudioConfig,
  removeGameStudioWorkspaceAssets,
  resolveGameStudioHelpTarget,
  setGameStudioEngineConfig,
} from "./pack";

export {
  buildGameStudioEnvelopeForTurn,
  ensureGameStudioWorkspaceInitialized,
  loadGameStudioConfig,
  removeGameStudioWorkspaceAssets,
  setGameStudioEngineConfig,
};

export function isStudioEngineKey(value: string | null | undefined): value is StudioEngineKey {
  return value === "unity" || value === "godot" || value === "unreal";
}

export function resolveEngineFromModeSwitchChoice(
  choice: PendingRunDecisionChoice | "approve_once" | "approve_thread" | "cancel",
  pending: PendingRunDecision,
): StudioEngineKey | null {
  if (choice === "switch_game_studio_unity") return "unity";
  if (choice === "switch_game_studio_godot") return "godot";
  if (choice === "switch_game_studio_unreal") return "unreal";
  return isStudioEngineKey(pending.target) ? pending.target : null;
}

export function buildGameStudioSwitchReason(
  signal: GameDevelopmentIntentSignal,
  language: "zh" | "en",
): string {
  const evidence = [...signal.projectEvidence, ...signal.semanticEvidence].slice(0, 2).join("；");
  if (language === "en") {
    if (signal.engineStatus === "explicit" && signal.engine) {
      return evidence
        ? `Detected ${signal.engine} game-development context (${evidence}). Game Studio can route this through engine-aware workflows.`
        : `Detected ${signal.engine} game-development context. Game Studio can route this through engine-aware workflows.`;
    }
    return evidence
      ? `Detected game-development context (${evidence}), but the engine is not clear yet. Choose an engine before MAIN configures Game Studio.`
      : "Detected game-development context, but the engine is not clear yet. Choose an engine before MAIN configures Game Studio.";
  }

  if (signal.engineStatus === "explicit" && signal.engine) {
    return evidence
      ? `检测到 ${signal.engine} 游戏开发上下文（${evidence}）。切换后 MAIN 会初始化 Game Studio，并同步设置该引擎。`
      : `检测到 ${signal.engine} 游戏开发上下文。切换后 MAIN 会初始化 Game Studio，并同步设置该引擎。`;
  }
  return evidence
    ? `检测到游戏开发语义（${evidence}），但还不能确定具体引擎。请先选定引擎，再让 MAIN 配置 Game Studio。`
    : "检测到游戏开发语义，但还不能确定具体引擎。请先选定引擎，再让 MAIN 配置 Game Studio。";
}

export function createGameStudioModeSwitchDecision(params: {
  input: string;
  images?: string[];
  language: "zh" | "en";
  signal: GameDevelopmentIntentSignal;
}): PendingRunDecision {
  const { input, images, language, signal } = params;
  const isEnglish = language === "en";

  if (signal.engineStatus === "explicit" && signal.engine) {
    return {
      kind: "mode_switch",
      source: "pre_submit",
      originalInput: input,
      originalImages: images || [],
      suggestedIntent: "studio_workflow",
      reason: buildGameStudioSwitchReason(signal, language),
      title: isEnglish ? "Switch to Game Studio?" : "切换到游戏工作室？",
      target: signal.engine,
      options: [
        {
          id: "switch_game_studio",
          label: isEnglish ? "Switch to Game Studio" : "切换到游戏工作室",
          value: isEnglish
            ? "Switch to Game Studio and continue this game-development request."
            : "切换到游戏工作室，并继续处理这个游戏开发请求。",
        },
        {
          id: "stay_main",
          label: isEnglish ? "Continue in MAIN" : "继续在 MAIN 中处理",
          value: isEnglish
            ? "Keep handling this request in MAIN mode."
            : "继续在 MAIN 模式中处理这个请求。",
        },
      ],
    };
  }

  return {
    kind: "mode_switch",
    source: "pre_submit",
    originalInput: input,
    originalImages: images || [],
    suggestedIntent: "studio_workflow",
    reason: buildGameStudioSwitchReason(signal, language),
    title: isEnglish ? "Choose a game engine?" : "先选择游戏引擎？",
    target: "engine",
    options: [
      {
        id: "switch_game_studio_unity",
        label: isEnglish ? "Use Unity" : "使用 Unity",
        value: isEnglish
          ? "Switch to Game Studio, set the engine to Unity, and continue."
          : "切换到游戏工作室，设置引擎为 Unity，并继续处理。",
      },
      {
        id: "switch_game_studio_godot",
        label: isEnglish ? "Use Godot" : "使用 Godot",
        value: isEnglish
          ? "Switch to Game Studio, set the engine to Godot, and continue."
          : "切换到游戏工作室，设置引擎为 Godot，并继续处理。",
      },
      {
        id: "switch_game_studio_unreal",
        label: isEnglish ? "Use Unreal" : "使用 Unreal",
        value: isEnglish
          ? "Switch to Game Studio, set the engine to Unreal, and continue."
          : "切换到游戏工作室，设置引擎为 Unreal，并继续处理。",
      },
      {
        id: "switch_game_studio_choose_engine",
        label: isEnglish ? "Help Me Choose" : "先帮我选择",
        value: isEnglish
          ? "Switch to Game Studio and ask me the engine selection questions first."
          : "切换到游戏工作室，并先向我确认游戏引擎选择。",
      },
      {
        id: "stay_main",
        label: isEnglish ? "Continue in MAIN" : "继续在 MAIN 中处理",
        value: isEnglish
          ? "Keep handling this request in MAIN mode."
          : "继续在 MAIN 模式中处理这个请求。",
      },
    ],
  };
}

export function shouldConsiderGameStudioSuggestion(params: {
  isHidden: boolean;
  currentMainModeKey: MainModeKey;
  hasPendingRunDecision: boolean;
  hasMainDebugShortcut: boolean;
  hasMainIntentShortcut: boolean;
  hasLockedComposerIntent: boolean;
  skipIntentResolution?: boolean;
  resolvedIntent?: ResolvedRunIntent;
  shouldContinuePlanIntent: boolean;
  shouldContinuePreviousTurnIntent: boolean;
  shouldReuseExistingTurnIntent: boolean;
  suppressGameStudioSuggestion?: boolean;
  input: string;
  hasPlanArtifacts: boolean;
  planStage: PlanStage;
  isPlanApproved: boolean;
}): boolean {
  if (params.isHidden) return false;
  if (params.currentMainModeKey !== "main_mode") return false;
  if (params.hasPendingRunDecision) return false;
  if (params.hasMainDebugShortcut || params.hasMainIntentShortcut || params.hasLockedComposerIntent) return false;
  if (params.skipIntentResolution || params.resolvedIntent || params.suppressGameStudioSuggestion) return false;
  if (params.shouldContinuePlanIntent || params.shouldContinuePreviousTurnIntent || params.shouldReuseExistingTurnIntent) return false;
  if (looksLikePlanContinuationOrApprovalInput(params.input, {
    hasPlanArtifacts: params.hasPlanArtifacts,
    planStage: params.planStage,
    isPlanApproved: params.isPlanApproved,
  })) return false;
  return true;
}

export function buildGameStudioLocalHelpMessage(params: {
  language: "zh" | "en";
  requestedCommand?: string;
  onLocaleFallback?: (event: { slug: string; language: "zh" | "en" }) => void;
}): string {
  const language = params.language === "en" ? "en" : "zh";
  const resolution = resolveGameStudioHelpTarget(params.requestedCommand);
  if (!resolution.ok) {
    return formatGameStudioMissingCommandDoc(resolution, language);
  }

  if (language === "zh" && !hasBundledGameStudioLocalizedCommandMarkdown(resolution.slug, language)) {
    params.onLocaleFallback?.({ slug: resolution.slug, language });
  }

  return formatGameStudioCommandDocForDisplay(resolution.slug, language)
    ?? formatGameStudioMissingCommandDoc(
      {
        ok: false,
        requested: resolution.requested || `/${resolution.slug}`,
        suggestions: [],
      },
      language,
    );
}

export function buildGameStudioLocalWorkflowMessage(params: {
  language: "zh" | "en";
  command: PendingSlashCommand & { type: "workflow" };
  onLocaleFallback?: (event: { slug: string; language: "zh" | "en" }) => void;
}): string | null {
  if (params.command.slug === "help") {
    return buildGameStudioLocalHelpMessage({
      language: params.language,
      requestedCommand: params.command.args,
      onLocaleFallback: params.onLocaleFallback,
    });
  }
  return null;
}

export type GameStudioSlashResolution =
  | {
      kind: "agent";
      slug: string;
    }
  | {
      kind: "auto";
    }
  | {
      kind: "local_markdown";
      content: string;
      systemVariant?: "game_studio_local_markdown";
    }
  | {
      kind: "workflow";
    };

export class GameStudioRuntimeService {
  ensureInitialized(activeStudioAgent: StudioAgentKey = "studio_auto"): Promise<StudioConfig> {
    return ensureGameStudioWorkspaceInitialized(activeStudioAgent);
  }

  configureEngine(params: {
    engine: StudioEngineKey;
    version?: string;
    activeStudioAgent?: StudioAgentKey;
  }): Promise<StudioConfig> {
    return setGameStudioEngineConfig(params);
  }

  loadConfig(): Promise<StudioConfig | null> {
    return loadGameStudioConfig();
  }

  removeWorkspaceAssets(): Promise<void> {
    return removeGameStudioWorkspaceAssets();
  }

  resolveSlashCommand(params: {
    command: PendingSlashCommand | null;
    language: "zh" | "en";
    onLocaleFallback?: (event: { slug: string; language: "zh" | "en" }) => void;
  }): GameStudioSlashResolution | null {
    const { command, language, onLocaleFallback } = params;
    if (!command) return null;
    if (command.type === "agent") return { kind: "agent", slug: command.slug };
    if (command.type === "auto") return { kind: "auto" };
    if (command.type === "workflow") {
      const content = buildGameStudioLocalWorkflowMessage({
        language,
        command,
        onLocaleFallback,
      });
      if (content) {
        return {
          kind: "local_markdown",
          content,
          systemVariant: command.slug === "help" ? "game_studio_local_markdown" : undefined,
        };
      }
      return { kind: "workflow" };
    }
    return null;
  }

  buildTurnEnvelope(params: {
    originalText: string;
    nexusMode: NexusModeKey;
    activeStudioAgent: StudioAgentKey;
    command: PendingSlashCommand | null;
    studioConfig?: StudioConfig | null;
    responseLanguage?: "zh" | "en";
  }): string {
    return buildGameStudioEnvelopeForTurn(params);
  }

  resolveModeSwitchDecision(params: {
    input: string;
    images?: string[];
    language: "zh" | "en";
    signal: GameDevelopmentIntentSignal;
  }): PendingRunDecision {
    return createGameStudioModeSwitchDecision(params);
  }
}

export const gameStudioRuntimeService = new GameStudioRuntimeService();
