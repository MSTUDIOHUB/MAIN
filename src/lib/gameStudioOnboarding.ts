export type GameStudioOnboardingAction =
  | "init"
  | "start"
  | "brainstorm"
  | "setup-engine";

export type GameStudioOnboardingResolution =
  | { kind: "initialize" }
  | { kind: "draft"; value: string };

export type GameStudioOnboardingVisibilityParams = {
  isGameStudioMode: boolean;
  hasWorkspace: boolean;
  gameStudioInitialized: boolean;
  nonPackFileCount: number;
  input: string;
  hasConversationHistory: boolean;
  showSlashMenu: boolean;
  dismissed: boolean;
  used: boolean;
  forceVisible: boolean;
};

export function isNearlyEmptyGameStudioWorkspace(nonPackFileCount: number): boolean {
  return nonPackFileCount <= 3;
}

export function shouldShowGameStudioOnboarding(
  params: GameStudioOnboardingVisibilityParams,
): boolean {
  return (
    params.isGameStudioMode &&
    params.hasWorkspace &&
    params.input.trim().length === 0 &&
    !params.showSlashMenu &&
    !params.dismissed &&
    (
      params.forceVisible ||
      (
        !params.gameStudioInitialized &&
        isNearlyEmptyGameStudioWorkspace(params.nonPackFileCount) &&
        !params.hasConversationHistory &&
        !params.used
      )
    )
  );
}

export function resolveGameStudioOnboardingAction(
  action: GameStudioOnboardingAction,
): GameStudioOnboardingResolution {
  switch (action) {
    case "init":
      return { kind: "initialize" };
    case "start":
      return { kind: "draft", value: "/start " };
    case "brainstorm":
      return { kind: "draft", value: "/brainstorm " };
    case "setup-engine":
      return { kind: "draft", value: "/setup-engine " };
    default: {
      const exhaustiveCheck: never = action;
      throw new Error(`Unknown Game Studio onboarding action: ${exhaustiveCheck}`);
    }
  }
}
