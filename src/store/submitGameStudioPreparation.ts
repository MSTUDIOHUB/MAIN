import type { StudioAgentKey, StudioConfig } from "../lib/gameStudio/catalog";
import {
  prepareGameStudioTurn,
  type GameStudioTurnPreparationInput,
  type GameStudioTurnPreparationResult,
} from "./gameStudioTurnPreparation";

type SubmitGameStudioSet = (patchOrUpdater: any) => void;

export interface SubmitGameStudioPreparationState {
  bumpWorkspaceContentVersion?: () => void;
}

export interface SubmitGameStudioPreparationApplication {
  ok: boolean;
  errorMessage?: string;
  userContent: string;
  activeStudioAgentKey: StudioAgentKey;
  gameStudioInitialized: boolean;
  gameStudioConfigForTurn: StudioConfig | null;
}

export interface ApplySubmitGameStudioPreparationInput<TState extends SubmitGameStudioPreparationState> {
  preparation: GameStudioTurnPreparationResult;
  sessionGet: () => TState;
  sessionSet: SubmitGameStudioSet;
  invalidateWorkspaceTreeCache: () => void;
}

export interface RunSubmitGameStudioPreparationInput<TState extends SubmitGameStudioPreparationState>
  extends Omit<GameStudioTurnPreparationInput, "logWarning"> {
  sessionGet: () => TState;
  sessionSet: SubmitGameStudioSet;
  invalidateWorkspaceTreeCache: () => void;
  logWarning: (event: string, data: Record<string, unknown>) => void;
}

export function applySubmitGameStudioPreparationResult<TState extends SubmitGameStudioPreparationState>(
  input: ApplySubmitGameStudioPreparationInput<TState>,
): SubmitGameStudioPreparationApplication {
  const { preparation } = input;
  const application: SubmitGameStudioPreparationApplication = {
    ok: preparation.ok,
    ...(preparation.ok ? {} : { errorMessage: preparation.errorMessage }),
    userContent: preparation.userContent,
    activeStudioAgentKey: preparation.activeStudioAgentKey,
    gameStudioInitialized: preparation.gameStudioInitialized,
    gameStudioConfigForTurn: preparation.gameStudioConfigForTurn,
  };

  if (!preparation.ok) {
    return application;
  }

  if (preparation.shouldInvalidateWorkspaceTree) {
    input.invalidateWorkspaceTreeCache();
  }
  if (preparation.runtimePatch) {
    input.sessionSet(preparation.runtimePatch as unknown as Partial<TState>);
  }
  if (preparation.shouldBumpWorkspaceContentVersion) {
    input.sessionGet().bumpWorkspaceContentVersion?.();
  }

  return application;
}

export async function runSubmitGameStudioPreparation<TState extends SubmitGameStudioPreparationState>(
  input: RunSubmitGameStudioPreparationInput<TState>,
): Promise<SubmitGameStudioPreparationApplication> {
  const preparation = await prepareGameStudioTurn({
    currentMainModeKey: input.currentMainModeKey,
    text: input.text,
    userContent: input.userContent,
    parsedSetupEngineCommand: input.parsedSetupEngineCommand,
    parsedStudioCommand: input.parsedStudioCommand,
    activeStudioAgentKey: input.activeStudioAgentKey,
    gameStudioInitialized: input.gameStudioInitialized,
    cachedWorkspaceTreeForGameDetection: input.cachedWorkspaceTreeForGameDetection,
    preferredLanguage: input.preferredLanguage,
    runtimeService: input.runtimeService,
    logWarning: input.logWarning,
  });
  return applySubmitGameStudioPreparationResult({
    preparation,
    sessionGet: input.sessionGet,
    sessionSet: input.sessionSet,
    invalidateWorkspaceTreeCache: input.invalidateWorkspaceTreeCache,
  });
}
