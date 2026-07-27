import { mapMainModeToLegacyNexusMode, type MainModeKey } from "../lib/mainModes";
import {
  normalizeStudioAgentKey,
  type PendingSlashCommand,
  type ParsedSetupEngineArgs,
  type StudioAgentKey,
  type StudioConfig,
} from "../lib/gameStudio/catalog";

export interface GameStudioTurnRuntimeService {
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

  if (params.currentMainModeKey === "game_studio") {
    try {
      gameStudioConfigForTurn = await runtimeService.loadConfig();
    } catch (error) {
      warnGameStudioPreparation(
        params,
        "game_studio_config_snapshot_failed",
        error,
      );
      gameStudioConfigForTurn = null;
    }
    if (gameStudioConfigForTurn) {
      activeStudioAgentKey = normalizeStudioAgentKey(
        gameStudioConfigForTurn.activeStudioAgent,
      );
      gameStudioInitialized = true;
    }
  }

  const shouldUseGameStudioEnvelope =
    params.currentMainModeKey === "game_studio" &&
    (
      params.parsedStudioCommand?.type === "workflow" ||
      activeStudioAgentKey !== "studio_auto" ||
      gameStudioInitialized
    );

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
    shouldInvalidateWorkspaceTree: false,
    shouldBumpWorkspaceContentVersion: false,
    runtimePatch: null,
  };
}
