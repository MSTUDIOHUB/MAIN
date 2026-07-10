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

export type GameStudioOnboardingCopy = {
  title: string;
  intro: string;
  dismissLabel: string;
  prepareWorkspaceStepLabel: string;
  workspaceTitle: string;
  workspaceDescription: string;
  continueSetupStepLabel: string;
  setupEngineTitle: string;
  setupEngineDescription: string;
  startWorkflowStepLabel: string;
  startTitle: string;
  startDescription: string;
  brainstormTitle: string;
  brainstormDescription: string;
  initializeLabel: string;
  reinitializeLabel: string;
  removeLabel: string;
  removeConfirmation: string;
  workspaceNote: string;
};

export function getGameStudioOnboardingCopy(
  language: "zh" | "en",
): GameStudioOnboardingCopy {
  if (language === "en") {
    return {
      title: "MAIN GAME STUDIO",
      intro: "Use MAIN for one-off coding tasks. Use Game Studio when a game project needs lifecycle workflows, stage gates, persistent specialist roles, and production continuity.",
      dismissLabel: "Dismiss",
      prepareWorkspaceStepLabel: "1. Prepare Workspace",
      workspaceTitle: "Workspace Assets",
      workspaceDescription: "Initialization writes the Studio protocol, hooks, rules, and templates into this workspace under `.MAIN/...` and `.protocols/game-studio/...`.",
      continueSetupStepLabel: "2. Continue Setup",
      setupEngineTitle: "Set Up Engine",
      setupEngineDescription: "Draft `/setup-engine`, then confirm the engine, language, and version before sending.",
      startWorkflowStepLabel: "3. Start Workflow",
      startTitle: "Start /start",
      startDescription: "Draft `/start` to identify the current production stage and choose the next workflow.",
      brainstormTitle: "Brainstorm Game",
      brainstormDescription: "Draft `/brainstorm` to develop the concept, pillars, audience, and initial scope.",
      initializeLabel: "Initialize Game Studio",
      reinitializeLabel: "Reinitialize Game Studio",
      removeLabel: "Remove MAIN GAME STUDIO",
      removeConfirmation: "Remove MAIN GAME STUDIO from this workspace? This will delete the Game Studio hidden folders and merged hooks for the current project.",
      workspaceNote: "Initialization is workspace-local. Next, run `/setup-engine`; use `/start` for lifecycle guidance or `/` to browse commands and specialists.",
    };
  }

  return {
    title: "MAIN GAME STUDIO",
    intro: "单次代码修改或普通开发任务直接使用 MAIN；当游戏项目需要生命周期工作流、阶段门、持续专家角色和长期制作衔接时使用 Game Studio。",
    dismissLabel: "关闭",
    prepareWorkspaceStepLabel: "1. 准备工作区",
    workspaceTitle: "工作区写入说明",
    workspaceDescription: "初始化会把 Studio 协议、hooks、规则和模板写入当前工作区的 `.MAIN/...` 与 `.protocols/game-studio/...`。",
    continueSetupStepLabel: "2. 继续设置",
    setupEngineTitle: "设置引擎",
    setupEngineDescription: "先草拟 `/setup-engine`，补充并确认引擎、语言与版本后再发送。",
    startWorkflowStepLabel: "3. 开始工作流",
    startTitle: "开始 /start 引导",
    startDescription: "先草拟 `/start`，识别当前制作阶段并选择下一条工作流。",
    brainstormTitle: "头脑风暴新游戏",
    brainstormDescription: "先草拟 `/brainstorm`，梳理游戏概念、支柱体验、目标受众和初始范围。",
    initializeLabel: "初始化 Game Studio",
    reinitializeLabel: "重新初始化 Game Studio",
    removeLabel: "移除 MAIN GAME STUDIO",
    removeConfirmation: "要从当前工作区移除 MAIN GAME STUDIO 吗？这会删除该项目中的 Game Studio 隐藏文件夹和已合并的 hooks。",
    workspaceNote: "初始化按工作区独立保存。下一步先运行 `/setup-engine`；需要生命周期引导时使用 `/start`，输入 `/` 可浏览全部命令与专家。",
  };
}

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
