import { detectGameDevelopmentIntent } from "../lib/gameDevelopmentIntent";
import { mapMainModeToLegacyNexusMode, type MainModeKey } from "../lib/mainModes";
import {
  getDefaultStudioAgentForEngine,
  normalizeStudioAgentKey,
  type PendingSlashCommand,
  type ParsedSetupEngineArgs,
  type StudioAgentKey,
  type StudioConfig,
} from "../lib/gameStudioCatalog";

export interface GameStudioTurnRuntimeService {
  ensureInitialized(activeStudioAgent?: StudioAgentKey): Promise<StudioConfig>;
  configureEngine(params: {
    engine: Exclude<ParsedSetupEngineArgs["engine"], null>;
    version?: string;
    activeStudioAgent?: StudioAgentKey;
  }): Promise<StudioConfig>;
  loadConfig(): Promise<StudioConfig | null>;
  buildTurnEnvelope(params: {
    originalText: string;
    nexusMode: ReturnType<typeof mapMainModeToLegacyNexusMode>;
    activeStudioAgent: StudioAgentKey;
    command: PendingSlashCommand | null;
    studioConfig?: StudioConfig | null;
    responseLanguage?: "zh" | "en";
  }): string;
}

export interface GameStudioTurnPreparationInput {
  currentMainModeKey: MainModeKey;
  text: string;
  userContent: string;
  parsedSetupEngineCommand?: ParsedSetupEngineArgs | null;
  parsedStudioCommand?: PendingSlashCommand | null;
  activeStudioAgentKey: StudioAgentKey;
  gameStudioInitialized: boolean;
  cachedWorkspaceTreeForGameDetection: string;
  preferredLanguage: "zh" | "en";
  runtimeService: GameStudioTurnRuntimeService;
  logWarning?: (event: string, data: Record<string, unknown>) => void;
}

export interface GameStudioTurnPreparationSuccess {
  ok: true;
  userContent: string;
  activeStudioAgentKey: StudioAgentKey;
  gameStudioInitialized: boolean;
  gameStudioConfigForTurn: StudioConfig | null;
  shouldInvalidateWorkspaceTree: boolean;
  shouldBumpWorkspaceContentVersion: boolean;
  runtimePatch: {
    gameStudioInitialized: true;
    activeStudioAgentKey: StudioAgentKey;
  } | null;
}

export interface GameStudioTurnPreparationFailure {
  ok: false;
  userContent: string;
  activeStudioAgentKey: StudioAgentKey;
  gameStudioInitialized: boolean;
  gameStudioConfigForTurn: StudioConfig | null;
  errorMessage: string;
}

export type GameStudioTurnPreparationResult =
  | GameStudioTurnPreparationSuccess
  | GameStudioTurnPreparationFailure;

function formatGameStudioInitError(error: unknown): string {
  return `Game Studio 初始化失败：${error instanceof Error ? error.message : String(error)}`;
}

function warnGameStudioPreparation(
  params: GameStudioTurnPreparationInput,
  event: string,
  error: unknown,
) {
  params.logWarning?.(event, {
    error: error instanceof Error ? error.message : String(error),
  });
}

export async function prepareGameStudioTurn(
  params: GameStudioTurnPreparationInput,
): Promise<GameStudioTurnPreparationResult> {
  const runtimeService = params.runtimeService;
  let userContent = params.userContent;
  let activeStudioAgentKey = params.activeStudioAgentKey;
  let gameStudioInitialized = params.gameStudioInitialized;
  let gameStudioConfigForTurn: StudioConfig | null = null;
  let shouldInvalidateWorkspaceTree = false;
  let shouldBumpWorkspaceContentVersion = false;
  let runtimePatch: GameStudioTurnPreparationSuccess["runtimePatch"] = null;

  const markStudioInitialized = (config: StudioConfig) => {
    activeStudioAgentKey = normalizeStudioAgentKey(config.activeStudioAgent);
    gameStudioInitialized = true;
    shouldInvalidateWorkspaceTree = true;
    shouldBumpWorkspaceContentVersion = true;
    runtimePatch = {
      gameStudioInitialized: true,
      activeStudioAgentKey,
    };
  };

  if (params.currentMainModeKey === "game_studio") {
    if (params.parsedSetupEngineCommand?.mode === "configure" && params.parsedSetupEngineCommand.engine) {
      try {
        const engineAgent = getDefaultStudioAgentForEngine(params.parsedSetupEngineCommand.engine);
        await runtimeService.ensureInitialized(engineAgent);
        gameStudioConfigForTurn = await runtimeService.configureEngine({
          engine: params.parsedSetupEngineCommand.engine,
          version: params.parsedSetupEngineCommand.version,
          activeStudioAgent: engineAgent,
        });
        markStudioInitialized(gameStudioConfigForTurn);
      } catch (error) {
        warnGameStudioPreparation(params, "game_studio_setup_engine_failed", error);
      }
    } else {
      const engineSignal = detectGameDevelopmentIntent(params.text, {
        workspaceTree: params.cachedWorkspaceTreeForGameDetection,
      });
      if (engineSignal.engineStatus === "explicit" && engineSignal.engine) {
        const currentConfig = await runtimeService.loadConfig();
        if (!currentConfig || currentConfig.engine === "unconfigured" || currentConfig.engine !== engineSignal.engine) {
          try {
            const engineAgent = getDefaultStudioAgentForEngine(engineSignal.engine);
            await runtimeService.ensureInitialized(engineAgent);
            gameStudioConfigForTurn = await runtimeService.configureEngine({
              engine: engineSignal.engine,
              activeStudioAgent: engineAgent,
            });
            markStudioInitialized(gameStudioConfigForTurn);
          } catch (error) {
            warnGameStudioPreparation(params, "game_studio_auto_engine_config_failed", error);
          }
        } else {
          gameStudioConfigForTurn = currentConfig;
        }
      }
    }

    if (!gameStudioConfigForTurn) {
      gameStudioConfigForTurn = await runtimeService.loadConfig();
    }
  }

  const shouldUseGameStudioEnvelope =
    params.currentMainModeKey === "game_studio" &&
    (
      params.parsedStudioCommand?.type === "workflow" ||
      activeStudioAgentKey !== "studio_auto" ||
      gameStudioInitialized
    );

  if (
    params.currentMainModeKey === "game_studio" &&
    !gameStudioInitialized &&
    (params.parsedStudioCommand?.type === "workflow" || activeStudioAgentKey !== "studio_auto")
  ) {
    try {
      const studioConfig = await runtimeService.ensureInitialized(activeStudioAgentKey);
      gameStudioConfigForTurn = studioConfig;
      markStudioInitialized(studioConfig);
    } catch (error) {
      return {
        ok: false,
        userContent,
        activeStudioAgentKey,
        gameStudioInitialized,
        gameStudioConfigForTurn,
        errorMessage: formatGameStudioInitError(error),
      };
    }
  }

  if (shouldUseGameStudioEnvelope) {
    userContent = runtimeService.buildTurnEnvelope({
      originalText: userContent,
      nexusMode: mapMainModeToLegacyNexusMode(params.currentMainModeKey),
      activeStudioAgent: activeStudioAgentKey,
      command: params.parsedStudioCommand?.type === "workflow" ? params.parsedStudioCommand : null,
      studioConfig: gameStudioConfigForTurn,
      responseLanguage: params.preferredLanguage,
    });
  }

  return {
    ok: true,
    userContent,
    activeStudioAgentKey,
    gameStudioInitialized,
    gameStudioConfigForTurn,
    shouldInvalidateWorkspaceTree,
    shouldBumpWorkspaceContentVersion,
    runtimePatch,
  };
}
