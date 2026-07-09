import type { StudioAgentKey, StudioConfig } from "../lib/gameStudioCatalog";
import {
  prepareGameStudioTurn,
  type GameStudioTurnPreparationInput,
  type GameStudioTurnPreparationResult,
} from "./gameStudioTurnPreparation";

type SubmitGameStudioSet = (patchOrUpdater: any) => void;

export interface SubmitGameStudioPreparationState {
  taskFlow: any[];
  conversationTurns: Array<{
    id: string;
    status?: string;
    blockIds: number[];
  }>;
  bumpWorkspaceContentVersion?: () => void;
  agentStatus?: string;
  isGenerating?: boolean;
  abortController?: AbortController | null;
  pendingSlashCommand?: unknown;
}

export interface SubmitGameStudioPreparationApplication {
  ok: boolean;
  userContent: string;
  activeStudioAgentKey: StudioAgentKey;
  gameStudioInitialized: boolean;
  gameStudioConfigForTurn: StudioConfig | null;
}

export interface ApplySubmitGameStudioPreparationInput<TState extends SubmitGameStudioPreparationState> {
  preparation: GameStudioTurnPreparationResult;
  turnId: string;
  nextTaskId: () => number;
  sessionGet: () => TState;
  sessionSet: SubmitGameStudioSet;
  disposeElapsedTimer: () => void;
  invalidateWorkspaceTreeCache: () => void;
}

export interface RunSubmitGameStudioPreparationInput<TState extends SubmitGameStudioPreparationState>
  extends Omit<GameStudioTurnPreparationInput, "logWarning"> {
  turnId: string;
  nextTaskId: () => number;
  sessionGet: () => TState;
  sessionSet: SubmitGameStudioSet;
  disposeElapsedTimer: () => void;
  invalidateWorkspaceTreeCache: () => void;
  logWarning: (event: string, data: Record<string, unknown>) => void;
}

export function applySubmitGameStudioPreparationResult<TState extends SubmitGameStudioPreparationState>(
  input: ApplySubmitGameStudioPreparationInput<TState>,
): SubmitGameStudioPreparationApplication {
  const { preparation } = input;
  const application: SubmitGameStudioPreparationApplication = {
    ok: preparation.ok,
    userContent: preparation.userContent,
    activeStudioAgentKey: preparation.activeStudioAgentKey,
    gameStudioInitialized: preparation.gameStudioInitialized,
    gameStudioConfigForTurn: preparation.gameStudioConfigForTurn,
  };

  if (!preparation.ok) {
    input.disposeElapsedTimer();
    const failureId = input.nextTaskId();
    input.sessionSet((state: TState) => ({
      taskFlow: [
        ...state.taskFlow,
        {
          id: failureId,
          turnId: input.turnId,
          type: "system",
          content: preparation.errorMessage,
        },
      ],
      conversationTurns: state.conversationTurns.map((turn: TState["conversationTurns"][number]) =>
        turn.id === input.turnId
          ? {
              ...turn,
              status: "error",
              blockIds: turn.blockIds.includes(failureId) ? turn.blockIds : [...turn.blockIds, failureId],
            }
          : turn,
      ),
      agentStatus: "error",
      isGenerating: false,
      abortController: null,
      pendingSlashCommand: null,
    } as Partial<TState>));
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
    turnId: input.turnId,
    nextTaskId: input.nextTaskId,
    sessionGet: input.sessionGet,
    sessionSet: input.sessionSet,
    disposeElapsedTimer: input.disposeElapsedTimer,
    invalidateWorkspaceTreeCache: input.invalidateWorkspaceTreeCache,
  });
}
