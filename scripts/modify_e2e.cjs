const fs = require('fs');
const path = '/Users/michael/Documents/GitHub/MAIN/src/lib/e2e.ts';
let content = fs.readFileSync(path, 'utf8');

// 1. Add scenario constant after TOP_ISLAND line
content = content.replace(
  /(const TOP_ISLAND_EXECUTION_PROGRESS_SCENARIO = "top-island-execution-progress";\n)/,
  '$1const SIDEBAR_REMOVE_LAST_WORKSPACE_SCENARIO = "sidebar-remove-last-workspace";\n'
);

// 2. Add the seed function before initializeE2EScenarios
const seedFunc = `
function seedSidebarRemoveLastWorkspaceScenario() {
  const bridge = getBridge();
  if (!bridge) return undefined;

  bridge.events = [{ type: "boot" }];
  bridge.savedDocuments = [];
  bridge.completed = false;

  const workspace = "/tmp/e2e-sidebar-remove-last";
  const sessionId = 999601;
  const now = Date.now();
  const userBlockId = useAppStore.getState()._nextTaskId();
  const agentBlockId = useAppStore.getState()._nextTaskId();

  useAppStore.setState((state) => ({
    ...state,
    config: {
      ...state.config,
      language: "zh",
      workflowMode: "chat",
      sessionRecordingEnabled: true,
    },
    currentWorkspace: workspace,
    selectedWorkspace: workspace,
    workspaces: [
      { path: workspace, title: "E2E Sidebar Remove Last" },
    ],
    activeSessionByWorkspace: {
      [workspace]: sessionId,
    },
    sessionsByWorkspace: {
      [workspace]: [
        {
          id: sessionId,
          title: "E2E Sidebar Remove Last Session",
          date: new Date(now).toISOString(),
          active: true,
          messages: [],
        },
      ],
      [GLOBAL_CHAT_KEY]: [],
    },
    currentSessionId: sessionId,
    taskFlow: [
      { id: userBlockId, turnId: "e2e-sidebar-turn", type: "user", content: "请帮我分析当前项目架构。" },
      {
        id: agentBlockId,
        turnId: "e2e-sidebar-turn",
        type: "agent",
        content: "当前项目是一个桌面 AI 编程助手，基于 Tauri + React 技术栈。",
        streaming: false,
      },
    ],
    conversationTurns: [
      {
        id: "e2e-sidebar-turn",
        userPrompt: "请帮我分析当前项目架构。",
        title: "E2E Sidebar Remove Last",
        mode: "chat",
        status: "done",
        summary: "已完成项目架构分析。",
        blockIds: [userBlockId, agentBlockId],
        collapsed: false,
        createdAt: now,
      },
    ],
    currentTurnId: "e2e-sidebar-turn",
    agentMessages: [],
    selectedMainModeKey: "main_mode",
    selectedNexusModeKey: "nexus_general",
    activeStudioAgentKey: null,
    gameStudioInitialized: false,
    pendingSlashCommand: null,
    planArtifacts: [],
    planTasks: [],
    planExecutionEvidenceLedger: [],
    planExecutionEvidenceCount: 0,
    planStage: "idle",
    isPlanApproved: false,
    planApprovalChoice: null,
    showPlanPanel: false,
    showDiff: false,
    showTerminal: false,
    showFilePanel: false,
    rightPanelTab: "plan",
    selectedDiffTaskId: null,
    agentStatus: "idle",
    isGenerating: false,
    abortController: null,
    pendingReviewResolve: null,
    pendingReviewTaskId: null,
    pendingToolCall: null,
    input: "",
    attachedFiles: [],
    contextMentions: [],
    readOnlyAutoApproveForSession: false,
  }));

  bindBridgeSnapshot(SIDEBAR_REMOVE_LAST_WORKSPACE_SCENARIO);

  const cleanup = () => {
    bridge.initialized = false;
  };

  bridge.cleanup = cleanup;
  return cleanup;
}

`;

content = content.replace(
  /(export function initializeE2EScenarios\(\):)/,
  seedFunc + '$1'
);

// 3. Wire into initializeE2EScenarios - add the if block before the last "bridge.initialized = false;"
// Find the last occurrence of "bridge.initialized = false;" near the end of initializeE2EScenarios
const lastInitFalseIdx = content.lastIndexOf('bridge.initialized = false;');
if (lastInitFalseIdx !== -1) {
  const insertPoint = lastInitFalseIdx;
  const newCheck = `
  if (scenario === SIDEBAR_REMOVE_LAST_WORKSPACE_SCENARIO) {
    return seedSidebarRemoveLastWorkspaceScenario();
  }

`;
  content = content.slice(0, insertPoint) + newCheck + content.slice(insertPoint);
}

fs.writeFileSync(path, content, 'utf8');
console.log('e2e.ts modified successfully');
