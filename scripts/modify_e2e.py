#!/usr/bin/env python3
"""Modify src/lib/e2e.ts to add SIDEBAR_REMOVE_LAST_WORKSPACE_SCENARIO."""

import os

filepath = '/Users/michael/Documents/GitHub/MAIN/src/lib/e2e.ts'

with open(filepath, 'r') as f:
    lines = f.readlines()

# 1. Add scenario constant after TOP_ISLAND line
new_lines = []
for line in lines:
    new_lines.append(line)
    if 'TOP_ISLAND_EXECUTION_PROGRESS_SCENARIO' in line and line.strip().startswith('const'):
        new_lines.append('const SIDEBAR_REMOVE_LAST_WORKSPACE_SCENARIO = "sidebar-remove-last-workspace";\n')

# 2. Add the seed function before initializeE2EScenarios
seed_func = '''
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

'''

final_lines = []
for line in new_lines:
    if 'export function initializeE2EScenarios' in line:
        final_lines.append(seed_func)
    final_lines.append(line)

# 3. Wire into initializeE2EScenarios - add the if block before the final bridge.initialized = false
final_lines2 = []
for i in range(len(final_lines) - 1, -1, -1):
    if 'bridge.initialized = false;' in final_lines[i] and i > 2700:
        final_lines2.append('\n')
        final_lines2.append('  if (scenario === SIDEBAR_REMOVE_LAST_WORKSPACE_SCENARIO) {\n')
        final_lines2.append('    return seedSidebarRemoveLastWorkspaceScenario();\n')
        final_lines2.append('  }\n')
        final_lines2.append('\n')
        # Skip this line since we already processed it
        continue
    final_lines2.append(final_lines[i])

# Write back
with open(filepath, 'w') as f:
    f.writelines(final_lines2)

print("e2e.ts modified successfully")
