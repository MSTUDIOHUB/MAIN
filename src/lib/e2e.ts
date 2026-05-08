import { GLOBAL_CHAT_KEY, finalizeStreamingTaskBlocks, useAppStore } from "../store/useAppStore";
import { syncPlanArtifactAfterToolSuccess } from "./planArtifactSync";
import { getPlanArtifactTitle } from "./workflowModels";
import type { NexusModeKey } from "./gameStudioCatalog";

const PLAN_FLOW_SCENARIO = "plan-flow";
const PLAN_QUICK_REPLY_APPROVAL_SCENARIO = "plan-quick-reply-approval";
const PLAN_RELOAD_RESUME_SCENARIO = "plan-reload-resume";
const DIFF_RELOAD_SUMMARY_SCENARIO = "diff-reload-summary";
const PLAN_REPLACE_REFRESH_SCENARIO = "plan-replace-refresh";
const AWAITING_CHOICE_SCENARIO = "awaiting-choice";
const FEISHU_REMOTE_ANALYSIS_SCENARIO = "feishu-remote-analysis";
const READ_CONTEXT_COLLAPSE_SCENARIO = "read-context-collapse";
const THOUGHT_DISPLAY_SCENARIO = "thought-display-mode";
const GAME_STUDIO_ONBOARDING_SCENARIO = "game-studio-onboarding";
const COMPOSER_MAIN_SHORTCUTS_SCENARIO = "composer-main-shortcuts";
const CLOUD_SETTINGS_MODEL_SELECT_SCENARIO = "cloud-settings-model-select";
const CLOUD_SETTINGS_EMPTY_SCENARIO = "cloud-settings-empty";
const CLOUD_STATUS_ACTIVE_SERVER_MODEL_SCENARIO = "cloud-status-active-server-model";
const STREAMING_TIMER_SCENARIO = "streaming-timer";
const STREAMING_RESPONSIVENESS_SCENARIO = "streaming-responsiveness";
const STREAM_ERROR_RECOVERY_SCENARIO = "stream-error-recovery";
const SESSION_AUTO_CREATE_SCENARIO = "session-auto-create";
const CLOUD_TOOL_FALLBACK_SCENARIO = "cloud-tool-fallback";
const REPLY_OPTIONS_TOOL_PAUSE_SCENARIO = "reply-options-tool-pause";
const PLAN_APPROVAL_EXECUTE_TOOLS_SCENARIO = "plan-approval-execute-tools";
const EXECUTE_QUICK_REPLY_RUNTIME_SCENARIO = "execute-quick-reply-runtime";
const GAME_STUDIO_EXECUTE_REPLY_SCENARIO = "game-studio-execute-reply-runtime";
const PSEUDO_TOOL_CALL_RECOVERY_SCENARIO = "pseudo-tool-call-recovery";
const EXISTING_PLAN_FOLDER_EXECUTE_SCENARIO = "existing-plan-folder-execute";
const EXECUTE_MAX_ITERATIONS_CHECKPOINT_SCENARIO = "execute-max-iterations-checkpoint";
const LOCAL_FILE_READ_APPROVAL_SCENARIO = "local-file-read-approval";
const TOP_ISLAND_EXECUTION_PROGRESS_SCENARIO = "top-island-execution-progress";
const TOP_ISLAND_PLAN_TASK_PROGRESS_SCENARIO = "top-island-plan-task-progress";
const SIDEBAR_REMOVE_LAST_WORKSPACE_SCENARIO = "sidebar-remove-last-workspace";
const E2E_SEED_COUNT_PREFIX = "__CODELY_E2E_SEED_COUNT__:";

function getScenarioName(): string | null {
  if (typeof window === "undefined") return null;
  return new URLSearchParams(window.location.search).get("e2eScenario");
}

function getBridge(): any {
  if (typeof window === "undefined") return null;
  const target = window as any;
  if (!target.__CODELY_E2E__) {
    target.__CODELY_E2E__ = {
      scenario: null,
      initialized: false,
      events: [],
      savedDocuments: [],
      completed: false,
    };
  }
  return target.__CODELY_E2E__;
}

function appendBridgeEvent(type: string, payload: Record<string, unknown> = {}) {
  const bridge = getBridge();
  if (!bridge) return;
  bridge.events = [...(bridge.events || []), { type, ...payload }];
}

function bindCloudServerBridgeControls() {
  const bridge = getBridge();
  if (!bridge || bridge.setCloudServers) return;
  bridge.setCloudServers = (servers: any[], activeCloudServerId?: string) => {
    const normalizedServers = Array.isArray(servers) ? servers : [];
    const activeId = activeCloudServerId || normalizedServers[0]?.id;
    const activeServer = normalizedServers.find((server) => server.id === activeId) || normalizedServers[0] || null;
    useAppStore.setState((state) => ({
      ...state,
      config: {
        ...state.config,
        activeProfile: "cloud",
        cloudServers: normalizedServers,
        activeCloudServerId: activeServer?.id || "",
        ...(activeServer ? { cloud: activeServer } : {}),
      },
    }));
  };
}

function getSeedCountKey(scenario: string): string {
  return `${E2E_SEED_COUNT_PREFIX}${scenario}`;
}

function readSeedCount(scenario: string): number {
  if (typeof window === "undefined") return 0;
  return Number(window.localStorage.getItem(getSeedCountKey(scenario)) || "0") || 0;
}

function incrementSeedCount(scenario: string): number {
  if (typeof window === "undefined") return 0;
  const next = readSeedCount(scenario) + 1;
  window.localStorage.setItem(getSeedCountKey(scenario), String(next));
  return next;
}

function bindBridgeSnapshot(scenario: string) {
  const bridge = getBridge();
  if (!bridge) return;
  bridge.getSnapshot = () => {
    const state = useAppStore.getState();
    const agentBlocks = state.taskFlow.filter((block) => block.type === "agent") as any[];
    const toolBlocks = state.taskFlow.filter((block) => block.type === "tool") as any[];
    const archivedOptionBlocks = agentBlocks.filter((block) => block.archivedAfterChoice);
    const scopeKey = state.currentWorkspace || GLOBAL_CHAT_KEY;
    const sessions = state.sessionsByWorkspace[scopeKey] || [];
    return {
      workspace: state.currentWorkspace || "",
      currentSessionId: state.currentSessionId,
      sessionCount: sessions.length,
      taskFlowBlocks: state.taskFlow.length,
      planStage: state.planStage,
      isPlanApproved: state.isPlanApproved,
      agentStatus: state.agentStatus,
      planTasks: state.planTasks,
      selectedDiffTaskId: state.selectedDiffTaskId,
      showDiff: state.showDiff,
      savedDocuments: bridge.savedDocuments || [],
      completed: Boolean(bridge.completed),
      currentTurnStatus: state.currentTurnId
        ? state.conversationTurns.find((turn) => turn.id === state.currentTurnId)?.status ?? null
        : null,
      currentTurnIntent: state.currentTurnId
        ? state.conversationTurns.find((turn) => turn.id === state.currentTurnId)?.intent ?? null
        : null,
      conversationTurns: state.conversationTurns.length,
      taskFlowUserCount: state.taskFlow.filter((block) => block.type === "user").length,
      agentTexts: agentBlocks.map((block) => block.content),
      toolNames: toolBlocks.map((block) => block.toolName),
      toolTargets: toolBlocks.map((block) => block.target),
      selectedOptions: archivedOptionBlocks.map((block) => block.selectedOption).filter(Boolean),
      themeMode: state.config.themeMode,
      thoughtDisplayMode: state.config.thoughtDisplayMode,
      seedCount: readSeedCount(scenario),
    };
  };
  bridge.setThoughtDisplayMode = (mode: "hidden" | "summary" | "detailed") => {
    useAppStore.getState().setConfig((prev) => ({
      ...prev,
      thoughtDisplayMode: mode,
    }));
  };
  bindCloudServerBridgeControls();
}

function finishPlanExecution(finalMessage: string, summary: string) {
  const bridge = getBridge();
  const state = useAppStore.getState();
  const turnId = state.currentTurnId || state.conversationTurns[state.conversationTurns.length - 1]?.id || "e2e-plan-turn";
  const finishBlockId = state._nextTaskId();

  useAppStore.setState((current) => ({
    ...current,
    taskFlow: [
      ...current.taskFlow,
      {
        id: finishBlockId,
        turnId,
        type: "agent",
        content: finalMessage,
        streaming: false,
      },
    ],
    conversationTurns: current.conversationTurns.map((turn) =>
      turn.id === turnId
        ? {
            ...turn,
            status: "done",
            summary,
            blockIds: turn.blockIds.includes(finishBlockId)
              ? turn.blockIds
              : [...turn.blockIds, finishBlockId],
          }
        : turn
    ),
    planStage: "completed",
    planTasks: current.planTasks.map((task) => ({
      ...task,
      status: "completed" as const,
      evidenceStatus: "satisfied" as const,
      blockedReason: undefined,
    })),
    agentStatus: "idle",
    isGenerating: false,
    showPlanPanel: true,
    showDiff: false,
    showTerminal: false,
    showFilePanel: false,
    rightPanelTab: "plan",
  }));

  if (bridge) {
    bridge.completed = true;
  }
}

function seedPlanFlowScenario() {
  const bridge = getBridge();
  if (!bridge) return undefined;

  bridge.events = [{ type: "boot" }];
  bridge.savedDocuments = [];
  bridge.completed = false;

  const turnId = "e2e-plan-flow-turn";
  const sessionId = 999001;
  const now = Date.now();
  const userBlockId = useAppStore.getState()._nextTaskId();
  const agentBlockId = useAppStore.getState()._nextTaskId();

  const artifacts = [
    {
      kind: "design" as const,
      path: ".MAIN/plans/design.md",
      title: "Design",
      updatedAt: now - 1_000,
      content: "# Design\n\n- 目标：支持生成计划、保存方案、批准执行与最终收尾。\n- 右侧 Plan Workspace 负责展示方案与审批入口。\n- 保存成功后应明确反馈已保存。\n- 验证：批准后生成 tasks.md 并进入执行进度。\n",
    },
  ];

  useAppStore.setState((state) => ({
    ...state,
    config: {
      ...state.config,
      language: "zh",
      workflowMode: "plan",
    },
    currentWorkspace: "/tmp/e2e-plan-flow",
    sessionsByWorkspace: {
      "/tmp/e2e-plan-flow": [
        {
          id: sessionId,
          title: "E2E Plan Flow",
          date: new Date(now).toISOString(),
          active: true,
          messages: [],
        },
      ],
    },
    currentSessionId: sessionId,
    taskFlow: [
      { id: userBlockId, turnId, type: "user", content: "请先生成方案，我确认后再执行。" },
      {
        id: agentBlockId,
        turnId,
        type: "agent",
        content: [
          "[PROPOSAL START]",
          "# Proposed Plan",
          "",
          "## 目标",
          "- 先生成可保存的 design 方案，再等待用户确认是否执行。",
          "",
          "## 执行策略",
          "1. 先补齐 `design.md`。",
          "2. 用户可先保存方案留档。",
          "3. 只有在用户批准后，才生成 `.MAIN/plans/tasks.md` 并进入执行。",
          "",
          "## 风险控制",
          "- 未批准前不生成执行任务，不改源码。",
          "- 保存方案后，即使不执行也能保留文档。",
          "",
          "<plan>",
          JSON.stringify([
            { id: "proposal-1", subject: "补齐 design 方案文档" },
            { id: "proposal-2", subject: "允许用户保存当前方案" },
            { id: "proposal-3", subject: "批准后生成 tasks 并完成收尾" },
          ]),
          "</plan>",
        ].join("\n"),
        streaming: false,
      },
    ],
    conversationTurns: [
      {
        id: turnId,
        userPrompt: "请先生成方案，我确认后再执行。",
        title: "计划审批回归流",
        mode: "plan",
        intent: "plan",
        status: "awaiting_approval",
        summary: "已生成方案，等待保存与执行审批。",
        blockIds: [userBlockId, agentBlockId],
        collapsed: false,
        createdAt: now,
      },
    ],
    currentTurnId: turnId,
    planArtifacts: artifacts,
    planTasks: [],
    planExecutionEvidenceLedger: [],
    planExecutionEvidenceCount: 0,
    planStage: "design",
    isPlanApproved: false,
    showPlanPanel: true,
    showDiff: false,
    showTerminal: false,
    showFilePanel: false,
    rightPanelTab: "plan",
    agentStatus: "pending_review",
    isGenerating: false,
    abortController: null,
    pendingReviewResolve: null,
    pendingReviewTaskId: null,
    pendingToolCall: null,
    selectedDiffTaskId: null,
    input: "",
    attachedFiles: [],
    contextMentions: [],
  }));

  bindBridgeSnapshot(PLAN_FLOW_SCENARIO);

  let rewriteTimer: number | null = null;
  let completionTimer: number | null = null;
  let finalized = false;

  const unsubscribe = useAppStore.subscribe((state, prevState) => {
    if (
      !finalized &&
      state.isPlanApproved &&
      state.planStage === "executing" &&
      (!prevState.isPlanApproved || prevState.planStage !== "executing")
    ) {
      finalized = true;
      appendBridgeEvent("approved");
      rewriteTimer = window.setTimeout(() => {
        const current = useAppStore.getState();
        useAppStore.setState((state) => ({
          planExecutionEvidenceLedger: [
            ...state.planExecutionEvidenceLedger,
            {
              id: "e2e-plan-flow-evidence-1",
              kind: "file",
              value: "plan-output.md",
              target: "plan-output.md",
              sourceTool: "write_file",
              createdAt: Date.now(),
            },
          ],
          planExecutionEvidenceCount: state.planExecutionEvidenceCount + 1,
        }));
        current.upsertPlanArtifact({
          kind: "tasks",
          path: ".MAIN/plans/tasks.md",
          title: "Tasks",
          updatedAt: Date.now(),
          content: [
            "# Tasks",
            "",
            "- [x] 补齐计划文档与需求说明 — 证据: file:plan-output.md",
            "- [ ] 保存方案供用户留档 — 证据: file:saved-plan.md",
            "- [ ] 批准执行并完成最终收尾 — 证据: file:final-summary.md",
          ].join("\n"),
        });

        const afterRewrite = useAppStore.getState();
        appendBridgeEvent("tasks-rewritten", {
          stage: afterRewrite.planStage,
          statuses: afterRewrite.planTasks.map((task) => task.status),
        });

        completionTimer = window.setTimeout(() => {
          finishPlanExecution("执行完成，已收尾。", "方案已保存，批准执行后已顺利完成收尾。");
          appendBridgeEvent("completed");
        }, 150);
      }, 50);
    }
  });

  const cleanup = () => {
    if (rewriteTimer != null) window.clearTimeout(rewriteTimer);
    if (completionTimer != null) window.clearTimeout(completionTimer);
    unsubscribe();
    bridge.initialized = false;
  };

  bridge.cleanup = cleanup;
  return cleanup;
}

function seedPlanQuickReplyApprovalScenario() {
  const bridge = getBridge();
  if (!bridge) return undefined;

  bridge.events = [{ type: "boot" }];
  bridge.savedDocuments = [];
  bridge.completed = false;

  const turnId = "e2e-plan-quick-reply-approval-turn";
  const now = Date.now();
  const userBlockId = useAppStore.getState()._nextTaskId();
  const agentBlockId = useAppStore.getState()._nextTaskId();

  useAppStore.setState((state) => ({
    ...state,
    config: {
      ...state.config,
      language: "zh",
      workflowMode: "plan",
    },
    currentWorkspace: "/tmp/e2e-plan-quick-reply-approval",
    taskFlow: [
      { id: userBlockId, turnId, type: "user", content: "请先规划字体修复流程，我确认后再执行。" },
      {
        id: agentBlockId,
        turnId,
        type: "agent",
        content: "诊断路径已经收敛，请选择下一步。",
        options: [
          {
            label: "批准执行：先运行诊断脚本，再根据结果修复字体加载",
            value: "批准执行：先运行诊断脚本，再根据结果修复字体加载",
          },
          {
            label: "继续讨论，不进入执行",
            value: "继续讨论，不进入执行",
          },
        ],
        streaming: false,
      },
    ],
    conversationTurns: [
      {
        id: turnId,
        userPrompt: "请先规划字体修复流程，我确认后再执行。",
        title: "计划 Quick Reply 审批",
        mode: "plan",
        intent: "plan",
        status: "awaiting_input",
        summary: "等待用户选择是否批准执行。",
        blockIds: [userBlockId, agentBlockId],
        collapsed: false,
        createdAt: now,
      },
    ],
    currentTurnId: turnId,
    planArtifacts: [
      {
        kind: "design" as const,
        path: ".MAIN/plans/design.md",
        title: "Design",
        updatedAt: now - 1_000,
        content: "# Design\n\n- 目标：修复字体加载诊断流程。\n- 方案：批准后先运行诊断，再根据结果修复字体加载。\n- 验证：根据 tasks.md 记录诊断命令和修复证据。\n",
      },
    ],
    planTasks: [],
    planExecutionEvidenceLedger: [],
    planExecutionEvidenceCount: 0,
    planStage: "design",
    isPlanApproved: false,
    planApprovalChoice: null,
    showPlanPanel: true,
    showDiff: false,
    showTerminal: false,
    showFilePanel: false,
    rightPanelTab: "plan",
    agentStatus: "idle",
    isGenerating: false,
    abortController: null,
    pendingReviewResolve: null,
    pendingReviewTaskId: null,
    pendingToolCall: null,
    selectedDiffTaskId: null,
    input: "",
    attachedFiles: [],
    contextMentions: [],
  }));

  bindBridgeSnapshot(PLAN_QUICK_REPLY_APPROVAL_SCENARIO);

  return () => {
    bridge.initialized = false;
  };
}

function hasReloadResumeState(workspace: string, sessionId: number): boolean {
  const state = useAppStore.getState();
  return (
    state.currentWorkspace === workspace &&
    state.currentSessionId === sessionId &&
    state.taskFlow.length > 0 &&
    state.isPlanApproved &&
    (state.planStage === "executing" || state.planStage === "completed") &&
    state.planArtifacts.some((artifact) => artifact.kind === "tasks")
  );
}

function seedPlanReloadResumeScenario() {
  const bridge = getBridge();
  if (!bridge) return undefined;

  bridge.events = [{ type: "boot" }];
  bridge.savedDocuments = [];
  bridge.completed = false;

  const workspace = "/tmp/e2e-plan-reload";
  const sessionId = 999002;
  const now = Date.now();

  if (!hasReloadResumeState(workspace, sessionId)) {
    const turnId = "e2e-plan-reload-turn";
    const userBlockId = useAppStore.getState()._nextTaskId();
    const agentBlockId = useAppStore.getState()._nextTaskId();

    incrementSeedCount(PLAN_RELOAD_RESUME_SCENARIO);

    useAppStore.setState((state) => ({
      ...state,
      config: {
        ...state.config,
        language: "zh",
        workflowMode: "plan",
      },
      currentWorkspace: workspace,
      sessionsByWorkspace: {
        [workspace]: [
          {
            id: sessionId,
            title: "E2E Plan Reload Resume",
            date: new Date(now).toISOString(),
            active: true,
            messages: [],
          },
        ],
      },
      currentSessionId: sessionId,
      taskFlow: [
        { id: userBlockId, turnId, type: "user", content: "这个方案已经批准了，请继续把剩余任务做完。" },
        {
          id: agentBlockId,
          turnId,
          type: "agent",
          content: "已恢复到执行阶段，当前还剩余任务未完成，可以继续执行。",
          streaming: false,
        },
      ],
      conversationTurns: [
        {
          id: turnId,
          userPrompt: "这个方案已经批准了，请继续把剩余任务做完。",
          title: "重载恢复执行回归流",
          mode: "plan",
          status: "executing",
          summary: "已恢复到执行阶段，等待继续完成剩余任务。",
          blockIds: [userBlockId, agentBlockId],
          collapsed: false,
          createdAt: now,
        },
      ],
      currentTurnId: turnId,
      planArtifacts: [
        {
          kind: "requirements",
          path: ".MAIN/plans/requirements.md",
          title: "Requirements",
          updatedAt: now - 3_000,
          content: "# Requirements\n\n- 批准后应允许继续执行剩余任务。\n",
        },
        {
          kind: "design",
          path: ".MAIN/plans/design.md",
          title: "Design",
          updatedAt: now - 2_000,
          content: "# Design\n\n- 页面重载后应恢复到原有 Plan 进度与会话内容。\n",
        },
        {
          kind: "tasks",
          path: ".MAIN/plans/tasks.md",
          title: "Tasks",
          updatedAt: now - 1_000,
          content: [
            "# Tasks",
            "",
            "- [x] 恢复计划工作区状态",
            "- [ ] 恢复对话与执行任务进度",
            "- [ ] 继续执行并完成收尾",
          ].join("\n"),
        },
      ],
      planTasks: [
        { id: "reload-task-1", text: "恢复计划工作区状态", status: "completed", evidenceStatus: "satisfied" },
        { id: "reload-task-2", text: "恢复对话与执行任务进度", status: "in_progress" },
        { id: "reload-task-3", text: "继续执行并完成收尾", status: "pending" },
      ],
      planExecutionEvidenceLedger: [{
        id: "e2e-reload-evidence-1",
        kind: "file",
        value: "reload-plan.md",
        target: "reload-plan.md",
        sourceTool: "write_file",
        createdAt: now,
      }],
      planExecutionEvidenceCount: 1,
      planStage: "executing",
      isPlanApproved: true,
      showPlanPanel: true,
      showDiff: false,
      showTerminal: false,
      showFilePanel: false,
      rightPanelTab: "plan",
      agentStatus: "idle",
      isGenerating: false,
      abortController: null,
      pendingReviewResolve: null,
      pendingReviewTaskId: null,
      pendingToolCall: null,
      selectedDiffTaskId: null,
      input: "",
      attachedFiles: [],
      contextMentions: [],
    }));

    appendBridgeEvent("seeded", { seedCount: readSeedCount(PLAN_RELOAD_RESUME_SCENARIO) });
  } else {
    appendBridgeEvent("restored", { seedCount: readSeedCount(PLAN_RELOAD_RESUME_SCENARIO) });
  }

  bindBridgeSnapshot(PLAN_RELOAD_RESUME_SCENARIO);

  const cleanup = () => {
    bridge.initialized = false;
  };

  bridge.cleanup = cleanup;
  return cleanup;
}

function seedAwaitingChoiceScenario() {
  const bridge = getBridge();
  if (!bridge) return undefined;

  bridge.events = [{ type: "boot" }];
  bridge.savedDocuments = [];
  bridge.completed = false;

  const turnId = "e2e-awaiting-choice-turn";
  const sessionId = 999006;
  const now = Date.now();
  const userBlockId = useAppStore.getState()._nextTaskId();
  const agentBlockId = useAppStore.getState()._nextTaskId();

  useAppStore.setState((state) => ({
    ...state,
    config: {
      ...state.config,
      language: "zh",
      workflowMode: "plan",
    },
    currentWorkspace: "/tmp/e2e-awaiting-choice",
    sessionsByWorkspace: {
      "/tmp/e2e-awaiting-choice": [
        {
          id: sessionId,
          title: "E2E Awaiting Choice",
          date: new Date(now).toISOString(),
          active: true,
          messages: [],
        },
      ],
    },
    currentSessionId: sessionId,
    taskFlow: [
      { id: userBlockId, turnId, type: "user", content: "请继续做计划和工程实现。" },
      {
        id: agentBlockId,
        turnId,
        type: "agent",
        content: "我发现这里有一个关键分叉，需要你先确认优先级，然后我再继续当前回合。",
        streaming: false,
        options: [
          { label: "先修暂停等待选择，再补 UI 状态", value: "先修暂停等待选择，再补 UI 状态" },
          { label: "先补 UI 状态，再回头修暂停逻辑", value: "先补 UI 状态，再回头修暂停逻辑" },
        ],
      },
    ],
    conversationTurns: [
      {
        id: turnId,
        userPrompt: "请继续做计划和工程实现。",
        title: "等待用户选择回归流",
        mode: "plan",
        status: "awaiting_input",
        summary: "已识别关键分叉，等待用户点击选择。",
        blockIds: [userBlockId, agentBlockId],
        collapsed: false,
        createdAt: now,
      },
    ],
    currentTurnId: turnId,
    planArtifacts: [
      {
        kind: "requirements",
        path: ".MAIN/plans/requirements.md",
        title: "Requirements",
        updatedAt: now - 2_000,
        content: "# Requirements\n\n- 当模型有真实疑问时，必须暂停并等待用户选择。\n",
      },
      {
        kind: "design",
        path: ".MAIN/plans/design.md",
        title: "Design",
        updatedAt: now - 1_000,
        content: "# Design\n\n- 选择完成后应继续同一回合，而不是新开一轮或直接丢失上下文。\n",
      },
    ],
    planTasks: [],
    planExecutionEvidenceLedger: [],
    planStage: "design",
    isPlanApproved: false,
    showPlanPanel: true,
    showDiff: false,
    showTerminal: false,
    showFilePanel: false,
    rightPanelTab: "plan",
    agentStatus: "idle",
    isGenerating: false,
    abortController: null,
    pendingReviewResolve: null,
    pendingReviewTaskId: null,
    pendingToolCall: null,
    selectedDiffTaskId: null,
    input: "",
    attachedFiles: [],
    contextMentions: [],
  }));

  bindBridgeSnapshot(AWAITING_CHOICE_SCENARIO);
  appendBridgeEvent("choice-requested");

  const cleanup = () => {
    bridge.initialized = false;
  };

  bridge.cleanup = cleanup;
  return cleanup;
}

function seedFeishuRemoteAnalysisScenario() {
  const bridge = getBridge();
  if (!bridge) return undefined;

  bridge.events = [{ type: "boot" }];
  bridge.savedDocuments = [];
  bridge.completed = true;

  const turnId = "e2e-feishu-remote-analysis-turn";
  const sessionId = 999016;
  const now = Date.now();
  const userBlockId = useAppStore.getState()._nextTaskId();
  const agentBlockId = useAppStore.getState()._nextTaskId();

  useAppStore.setState((state) => ({
    ...state,
    config: {
      ...state.config,
      language: "zh",
      workflowMode: "chat",
    },
    currentWorkspace: "/tmp/e2e-feishu-remote-analysis",
    sessionsByWorkspace: {
      "/tmp/e2e-feishu-remote-analysis": [
        {
          id: sessionId,
          title: "E2E Feishu Remote Analysis",
          date: new Date(now).toISOString(),
          active: true,
          messages: [],
        },
      ],
    },
    currentSessionId: sessionId,
    selectedMainModeKey: "main_mode",
    selectedNexusModeKey: "nexus_general",
    taskFlow: [
      { id: userBlockId, turnId, type: "user", content: "检查html版本和pygame版本的界面差别" },
      {
        id: agentBlockId,
        turnId,
        type: "agent",
        content: [
          "已完成 HTML 版本和 Pygame 版本的界面差别分析。",
          "",
          "差异选项如下：",
          "",
          "1. High score loaded from `highscore.json` file",
          "2. Game over overlay drawn on canvas with text prompt",
          "3. No restart button - uses keyboard input",
          "4. Particle effects rendered on canvas",
        ].join("\n"),
        streaming: false,
      },
    ],
    conversationTurns: [
      {
        id: turnId,
        userPrompt: "检查html版本和pygame版本的界面差别",
        title: "飞书远程分析",
        intent: "analyze",
        mode: "chat",
        status: "done",
        summary: "已完成飞书远程只读分析。",
        blockIds: [userBlockId, agentBlockId],
        collapsed: false,
        createdAt: now,
      },
    ],
    currentTurnId: turnId,
    input: "",
    attachedFiles: [],
    contextMentions: [],
    readOnlyAutoApproveForSession: false,
    planArtifacts: [],
    planTasks: [],
    planExecutionEvidenceLedger: [],
    planStage: "idle",
    isPlanApproved: false,
    showPlanPanel: false,
    showDiff: false,
    showTerminal: false,
    showFilePanel: false,
    agentStatus: "idle",
    isGenerating: false,
  }));

  bindBridgeSnapshot(FEISHU_REMOTE_ANALYSIS_SCENARIO);

  const cleanup = () => {
    bridge.initialized = false;
  };

  bridge.cleanup = cleanup;
  return cleanup;
}

function seedReadContextCollapseScenario() {
  const bridge = getBridge();
  if (!bridge) return undefined;

  bridge.events = [{ type: "boot" }];
  bridge.savedDocuments = [];
  bridge.completed = true;

  const turnId = "e2e-read-context-collapse-turn";
  const sessionId = 999007;
  const now = Date.now();
  const userBlockId = useAppStore.getState()._nextTaskId();
  const readTargets = [
    { toolName: "get_project_skeleton", target: "" },
    { toolName: "read_file", target: "Assets/Scripts/Battle/Config/BattleSceneConfigSO.cs" },
    { toolName: "read_file", target: "Assets/Scripts/Battle/Runtime/BattleUnit.cs" },
    { toolName: "read_file", target: "Assets/Scripts/Battle/Data/SkillDataSO.cs" },
    { toolName: "read_file", target: "Assets/Scripts/Battle/Data/StatusEffectDataSO.cs" },
    { toolName: "read_file", target: "Assets/Scripts/Battle/Data/UnitDataSO.cs" },
    { toolName: "read_file", target: "Assets/Scripts/Battle/Events/BattleEventCenter.cs" },
    { toolName: "read_file", target: "Assets/Scripts/Battle/Events/BattleEventData.cs" },
    { toolName: "read_file", target: "Assets/Scripts/Battle/Events/BattleEvents.cs" },
    { toolName: "read_file", target: "Assets/Scripts/Battle/Runtime/BattleActionQueue.cs" },
  ];
  const readBlocks = readTargets.map((item) => ({
    id: useAppStore.getState()._nextTaskId(),
    turnId,
    type: "tool" as const,
    toolName: item.toolName,
    target: item.target,
    status: "done",
    toolStatus: "executed" as const,
    message: "OK",
  }));
  const failedReadBlock = {
    id: useAppStore.getState()._nextTaskId(),
    turnId,
    type: "tool" as const,
    toolName: "read_file",
    target: "Assets/Scripts/Battle/Data/MissingConfig.cs",
    status: "error",
    toolStatus: "failed" as const,
    message: "文件不存在",
  };
  const writeBlock = {
    id: useAppStore.getState()._nextTaskId(),
    turnId,
    type: "tool" as const,
    toolName: "write_file",
    target: "Assets/Scripts/Battle/Runtime/GeneratedBattleUnit.cs",
    status: "done",
    toolStatus: "executed" as const,
    message: "Wrote file",
    diff: {
      old: "",
      new: "public class GeneratedBattleUnit {}\n",
      path: "Assets/Scripts/Battle/Runtime/GeneratedBattleUnit.cs",
    },
  };
  const agentBlockId = useAppStore.getState()._nextTaskId();
  const taskFlow = [
    { id: userBlockId, turnId, type: "user" as const, content: "请读取战斗系统上下文并继续分析。" },
    ...readBlocks,
    failedReadBlock,
    writeBlock,
    {
      id: agentBlockId,
      turnId,
      type: "agent" as const,
      content: "已读取核心战斗上下文，失败项和写入项需要保持单独展示。",
      streaming: false,
    },
  ];

  useAppStore.setState((state) => ({
    ...state,
    config: {
      ...state.config,
      language: "zh",
      workflowMode: "edit",
    },
    currentWorkspace: "/tmp/e2e-read-context-collapse",
    sessionsByWorkspace: {
      "/tmp/e2e-read-context-collapse": [
        {
          id: sessionId,
          title: "E2E Read Context Collapse",
          date: new Date(now).toISOString(),
          active: true,
          messages: [],
        },
      ],
    },
    currentSessionId: sessionId,
    taskFlow,
    conversationTurns: [
      {
        id: turnId,
        userPrompt: "请读取战斗系统上下文并继续分析。",
        title: "读取上下文折叠回归",
        mode: "edit" as const,
        status: "completed_with_changes" as const,
        summary: "已读取核心战斗上下文。",
        blockIds: taskFlow.map((block) => block.id),
        collapsed: false,
        createdAt: now,
      },
    ],
    currentTurnId: turnId,
    agentStatus: "idle",
    isGenerating: false,
    showPlanPanel: false,
    showDiff: false,
    showTerminal: false,
    showFilePanel: false,
  }));

  bindBridgeSnapshot(READ_CONTEXT_COLLAPSE_SCENARIO);
  appendBridgeEvent("seeded", { seedCount: readSeedCount(READ_CONTEXT_COLLAPSE_SCENARIO) });

  const cleanup = () => {
    bridge.initialized = false;
  };

  bridge.cleanup = cleanup;
  return cleanup;
}

function seedThoughtDisplayScenario() {
  const bridge = getBridge();
  if (!bridge) return undefined;

  bridge.events = [{ type: "boot" }];
  bridge.savedDocuments = [];
  bridge.completed = true;

  incrementSeedCount(THOUGHT_DISPLAY_SCENARIO);

  const now = Date.now();
  const turnId = "e2e-thought-display-turn";
  const sessionId = 999018;
  const userBlockId = useAppStore.getState()._nextTaskId();
  const thoughtBlockId = useAppStore.getState()._nextTaskId();
  const agentBlockId = useAppStore.getState()._nextTaskId();
  const thoughtDisplayMode = useAppStore.getState().config.thoughtDisplayMode || "hidden";

  useAppStore.setState((state) => ({
    ...state,
    config: {
      ...state.config,
      language: "zh",
      workflowMode: "chat",
      thoughtDisplayMode,
    },
    currentWorkspace: "/tmp/e2e-thought-display",
    sessionsByWorkspace: {
      "/tmp/e2e-thought-display": [
        {
          id: sessionId,
          title: "E2E Thought Display",
          date: new Date(now).toISOString(),
          active: true,
          messages: [],
        },
      ],
    },
    currentSessionId: sessionId,
    selectedMainModeKey: "main_mode",
    selectedNexusModeKey: "nexus_general",
    taskFlow: [
      { id: userBlockId, turnId, type: "user", content: "验证思考显示模式。" },
      {
        id: thoughtBlockId,
        turnId,
        type: "thought",
        content: [
          'data: {"choices":[{"delta":{"content":"noise"}}]}',
          '{"tool":"read_file","arguments":{"path":"src/components/SettingsModal.tsx"}}',
          "我需要先检查 SettingsModal 的通用设置区域。",
          "我需要先检查 SettingsModal 的通用设置区域。",
          "**检查范围**：`SettingsModal` 的通用设置区域。",
          "下一步会把思考显示接入三档配置，并避免原始长文本刷屏。",
          "由于似乎缓存，换一种方式。，使用来获取关键代码片段，，，，，，，，，整个 ...... 陷入了循环。。，，，，，所以我无法直接。",
          "```ts",
          "const noisy = true;",
          "function dumpRawCode() {",
          "  return noisy;",
          "}",
          "if (noisy) {",
          "  dumpRawCode();",
          "}",
          "```",
          ".........................",
        ].join("\n\n"),
        isStreaming: false,
        duration: 2,
      },
      {
        id: agentBlockId,
        turnId,
        type: "agent",
        content: "思考显示模式测试回复。",
        streaming: false,
      },
    ],
    conversationTurns: [
      {
        id: turnId,
        userPrompt: "验证思考显示模式。",
        title: "思考显示模式",
        mode: "chat",
        status: "done",
        summary: "已准备思考显示测试数据。",
        blockIds: [userBlockId, thoughtBlockId, agentBlockId],
        collapsed: false,
        createdAt: now,
      },
    ],
    currentTurnId: turnId,
    agentMessages: [],
    agentStatus: "idle",
    isGenerating: false,
    showDiff: false,
    showPlanPanel: false,
    showTerminal: false,
    showFilePanel: false,
    selectedDiffTaskId: null,
  }));

  bindBridgeSnapshot(THOUGHT_DISPLAY_SCENARIO);
  appendBridgeEvent("seeded", { seedCount: readSeedCount(THOUGHT_DISPLAY_SCENARIO) });

  const cleanup = () => {
    bridge.initialized = false;
  };

  bridge.cleanup = cleanup;
  return cleanup;
}

function hasDiffReloadSummaryState(workspace: string, sessionId: number): boolean {
  const state = useAppStore.getState();
  return (
    state.currentWorkspace === workspace &&
    state.currentSessionId === sessionId &&
    state.taskFlow.some((block) => block.type === "tool" && block.toolStatus === "executed" && !!block.diff) &&
    state.conversationTurns.length > 0
  );
}

function seedDiffReloadSummaryScenario() {
  const bridge = getBridge();
  if (!bridge) return undefined;

  bridge.events = [{ type: "boot" }];
  bridge.savedDocuments = [];
  bridge.completed = false;

  const workspace = "/tmp/e2e-diff-reload";
  const sessionId = 999003;
  const now = Date.now();

  if (!hasDiffReloadSummaryState(workspace, sessionId)) {
    const turnId = "e2e-diff-reload-turn";
    const userBlockId = useAppStore.getState()._nextTaskId();
    const toolBlockIdA = useAppStore.getState()._nextTaskId();
    const toolBlockIdB = useAppStore.getState()._nextTaskId();
    const toolBlockIdC = useAppStore.getState()._nextTaskId();
    const agentBlockId = useAppStore.getState()._nextTaskId();

    incrementSeedCount(DIFF_RELOAD_SUMMARY_SCENARIO);

    useAppStore.setState((state) => ({
      ...state,
      config: {
        ...state.config,
        language: "zh",
        workflowMode: "edit",
      },
      currentWorkspace: workspace,
      sessionsByWorkspace: {
        [workspace]: [
          {
            id: sessionId,
            title: "E2E Diff Reload Summary",
            date: new Date(now).toISOString(),
            active: true,
            messages: [],
          },
        ],
      },
      currentSessionId: sessionId,
      taskFlow: [
        {
          id: userBlockId,
          turnId,
          type: "user",
          content: "请直接修改三个文件，并给我一个可点击查看的变更摘要。",
        },
        {
          id: toolBlockIdA,
          turnId,
          type: "tool",
          toolName: "write_file",
          target: "src/main.ts",
          status: "executed",
          toolStatus: "executed",
          message: "Updated src/main.ts",
          diff: {
            path: "src/main.ts",
            old: [
              "export function main() {",
              "  return 'old main';",
              "}",
            ].join("\n"),
            new: [
              "export function main() {",
              "  const title = 'new main';",
              "  return title;",
              "}",
            ].join("\n"),
            existed: true,
            fullFile: true,
          },
        },
        {
          id: toolBlockIdB,
          turnId,
          type: "tool",
          toolName: "replace_in_file",
          target: "src/utils/helper.ts",
          status: "executed",
          toolStatus: "executed",
          message: "Updated src/utils/helper.ts",
          diff: {
            path: "src/utils/helper.ts",
            old: [
              "export const helper = () => 'before';",
              "export const status = 'draft';",
            ].join("\n"),
            new: [
              "export const helper = () => 'after';",
              "export const status = 'ready';",
            ].join("\n"),
            existed: true,
            fullFile: true,
          },
        },
        {
          id: toolBlockIdC,
          turnId,
          type: "tool",
          toolName: "write_file",
          target: "src/generated.ts",
          status: "executed",
          toolStatus: "executed",
          message: "Created src/generated.ts",
          diff: {
            path: "src/generated.ts",
            old: "",
            new: [
              "export const generated = true;",
              "",
            ].join("\n"),
            existed: false,
            fullFile: true,
          },
        },
        {
          id: agentBlockId,
          turnId,
          type: "agent",
          content: "已完成三个文件的修改，你可以在摘要卡中查看每个文件的 Diff。",
          streaming: false,
        },
      ],
      conversationTurns: [
        {
          id: turnId,
          userPrompt: "请直接修改三个文件，并给我一个可点击查看的变更摘要。",
          title: "Diff 摘要重载回归流",
          mode: "edit",
          status: "done",
          summary: "三个文件已修改，可点击查看 Diff。",
          blockIds: [userBlockId, toolBlockIdA, toolBlockIdB, toolBlockIdC, agentBlockId],
          collapsed: false,
          createdAt: now,
        },
      ],
      currentTurnId: turnId,
      planArtifacts: [],
      planTasks: [],
      planExecutionEvidenceLedger: [],
      planExecutionEvidenceCount: 0,
      planStage: "idle",
      isPlanApproved: false,
      showPlanPanel: false,
      showDiff: false,
      showTerminal: false,
      showFilePanel: false,
      rightPanelTab: "plan",
      agentStatus: "idle",
      isGenerating: false,
      abortController: null,
      pendingReviewResolve: null,
      pendingReviewTaskId: null,
      pendingToolCall: null,
      selectedDiffTaskId: null,
      input: "",
      attachedFiles: [],
      contextMentions: [],
    }));

    appendBridgeEvent("seeded", { seedCount: readSeedCount(DIFF_RELOAD_SUMMARY_SCENARIO) });
  } else {
    appendBridgeEvent("restored", { seedCount: readSeedCount(DIFF_RELOAD_SUMMARY_SCENARIO) });
  }

  bindBridgeSnapshot(DIFF_RELOAD_SUMMARY_SCENARIO);

  const cleanup = () => {
    bridge.initialized = false;
  };

  bridge.cleanup = cleanup;
  return cleanup;
}

function seedPlanReplaceRefreshScenario() {
  const bridge = getBridge();
  if (!bridge) return undefined;

  bridge.events = [{ type: "boot" }];
  bridge.savedDocuments = [];
  bridge.completed = false;

  const workspace = "/tmp/e2e-plan-replace-refresh";
  const sessionId = 999004;
  const now = Date.now();
  const turnId = "e2e-plan-replace-refresh-turn";
  const userBlockId = useAppStore.getState()._nextTaskId();
  const agentBlockId = useAppStore.getState()._nextTaskId();
  const initialTasksContent = [
    "# Tasks",
    "",
    "- [x] 补齐计划文档与需求说明 — 证据: file:plan-output.md",
    "- [ ] 保存方案供用户留档 — 证据: file:saved-plan.md",
    "- [ ] 批准执行并完成最终收尾 — 证据: file:final-summary.md",
  ].join("\n");

  incrementSeedCount(PLAN_REPLACE_REFRESH_SCENARIO);

  useAppStore.setState((state) => ({
    ...state,
    config: {
      ...state.config,
      language: "zh",
      workflowMode: "plan",
    },
    currentWorkspace: workspace,
    sessionsByWorkspace: {
      [workspace]: [
        {
          id: sessionId,
          title: "E2E Plan Replace Refresh",
          date: new Date(now).toISOString(),
          active: true,
          messages: [],
        },
      ],
    },
    currentSessionId: sessionId,
    taskFlow: [
      { id: userBlockId, turnId, type: "user", content: "继续执行剩余任务，并同步刷新计划面板。" },
      {
        id: agentBlockId,
        turnId,
        type: "agent",
        content: "任务执行中，`tasks.md` 每次更新后都应该立即刷新右侧计划面板。",
        streaming: false,
      },
    ],
    conversationTurns: [
      {
        id: turnId,
        userPrompt: "继续执行剩余任务，并同步刷新计划面板。",
        title: "Plan 替换刷新回归流",
        mode: "plan",
        status: "executing",
        summary: "tasks.md 使用 replace_in_file 更新后，计划面板也应立即刷新。",
        blockIds: [userBlockId, agentBlockId],
        collapsed: false,
        createdAt: now,
      },
    ],
    currentTurnId: turnId,
    planArtifacts: [
      {
        kind: "requirements",
        path: ".MAIN/plans/requirements.md",
        title: "Requirements",
        updatedAt: now - 3_000,
        content: "# Requirements\n\n- 执行中每完成一个任务，都需要立即同步计划面板。\n",
      },
      {
        kind: "design",
        path: ".MAIN/plans/design.md",
        title: "Design",
        updatedAt: now - 2_000,
        content: "# Design\n\n- 任务进度以 tasks.md 为准，replace_in_file 也必须触发刷新。\n",
      },
      {
        kind: "tasks",
        path: ".MAIN/plans/tasks.md",
        title: "Tasks",
        updatedAt: now - 1_000,
        content: initialTasksContent,
      },
    ],
    planTasks: [
      {
        id: "replace-task-1",
        text: "补齐计划文档与需求说明",
        status: "completed",
        evidenceStatus: "satisfied",
        evidence: [{ kind: "file", value: "plan-output.md" }],
      },
      { id: "replace-task-2", text: "保存方案供用户留档", status: "in_progress" },
      { id: "replace-task-3", text: "批准执行并完成最终收尾", status: "pending" },
    ],
    planExecutionEvidenceLedger: [{
      id: "e2e-replace-evidence-1",
      kind: "file",
      value: "plan-output.md",
      target: "plan-output.md",
      sourceTool: "write_file",
      createdAt: now,
    }],
    planExecutionEvidenceCount: 1,
    planStage: "executing",
    isPlanApproved: true,
    showPlanPanel: true,
    showDiff: false,
    showTerminal: false,
    showFilePanel: false,
    rightPanelTab: "plan",
    agentStatus: "idle",
    isGenerating: false,
    abortController: null,
    pendingReviewResolve: null,
    pendingReviewTaskId: null,
    pendingToolCall: null,
    selectedDiffTaskId: null,
    input: "",
    attachedFiles: [],
    contextMentions: [],
  }));

  appendBridgeEvent("seeded", { seedCount: readSeedCount(PLAN_REPLACE_REFRESH_SCENARIO) });
  bindBridgeSnapshot(PLAN_REPLACE_REFRESH_SCENARIO);

  const replacePlanTasks = async () => {
    const updatedTasksContent = [
      "# Tasks",
      "",
      "- [x] 补齐计划文档与需求说明 — 证据: file:plan-output.md",
      "- [x] 保存方案供用户留档（已完成） — 证据: file:saved-plan.md",
      "- [ ] 批准执行并完成最终收尾 — 证据: file:final-summary.md",
    ].join("\n");

    useAppStore.setState((state) => ({
      planExecutionEvidenceLedger: [
        ...state.planExecutionEvidenceLedger,
        {
          id: "e2e-replace-evidence-2",
          kind: "file",
          value: "saved-plan.md",
          target: "saved-plan.md",
          sourceTool: "write_file",
          createdAt: Date.now(),
        },
      ],
      planExecutionEvidenceCount: state.planExecutionEvidenceCount + 1,
    }));

    await syncPlanArtifactAfterToolSuccess(
      "replace_in_file",
      {
        path: ".MAIN/plans/tasks.md",
        search_text: "- [ ] 保存方案供用户留档 — 证据: file:saved-plan.md",
        replace_text: "- [x] 保存方案供用户留档（已完成） — 证据: file:saved-plan.md",
      },
      {
        onPlanArtifactUpdated: (path, content, kind) => {
          const state = useAppStore.getState();
          state.upsertPlanArtifact({
            kind,
            path,
            title: getPlanArtifactTitle(kind, state.config.language === "en" ? "en" : "zh"),
            content,
            updatedAt: Date.now(),
          });
        },
        onPlanTasksUpdated: () => {},
      },
      {
        readFile: async () => updatedTasksContent,
        warn: (message, error) => console.warn(message, error),
      },
    );

    const current = useAppStore.getState();
    appendBridgeEvent("tasks-replaced", {
      statuses: current.planTasks.map((task) => task.status),
      artifactContent: current.planArtifacts.find((artifact) => artifact.kind === "tasks")?.content ?? "",
    });
  };

  let replaceTimer: number | null = window.setTimeout(() => {
    void replacePlanTasks();
  }, 30_000);
  bridge.replacePlanTasks = () => {
    if (replaceTimer != null) window.clearTimeout(replaceTimer);
    replaceTimer = null;
    void replacePlanTasks();
    return true;
  };

  const cleanup = () => {
    if (replaceTimer != null) window.clearTimeout(replaceTimer);
    replaceTimer = null;
    bridge.initialized = false;
  };

  bridge.cleanup = cleanup;
  return cleanup;
}

function seedTopIslandExecutionProgressScenario() {
  const bridge = getBridge();
  if (!bridge) return undefined;

  bridge.events = [{ type: "boot" }];
  bridge.savedDocuments = [];
  bridge.completed = false;

  const workspace = "/tmp/e2e-top-island-execution-progress";
  const sessionId = 999601;
  const now = Date.now();
  const turnId = "e2e-top-island-execution-progress-turn";
  const userBlockId = useAppStore.getState()._nextTaskId();
  const readBlockId = useAppStore.getState()._nextTaskId();
  const editBlockId = useAppStore.getState()._nextTaskId();
  const commandBlockId = useAppStore.getState()._nextTaskId();

  incrementSeedCount(TOP_ISLAND_EXECUTION_PROGRESS_SCENARIO);

  useAppStore.setState((state) => ({
    ...state,
    config: {
      ...state.config,
      language: "zh",
      workflowMode: "edit",
    },
    currentWorkspace: workspace,
    sessionsByWorkspace: {
      [workspace]: [
        {
          id: sessionId,
          title: "E2E TopIsland Execution Progress",
          date: new Date(now).toISOString(),
          active: true,
          messages: [],
        },
      ],
    },
    currentSessionId: sessionId,
    taskFlow: [
      { id: userBlockId, turnId, type: "user", content: "/执行 修改 TopIsland 执行步骤进度。" },
      {
        id: readBlockId,
        turnId,
        type: "tool",
        toolName: "read_file",
        target: "src/components/TopIsland.tsx",
        status: "done",
        toolStatus: "executed",
        message: "File read.",
      },
      {
        id: editBlockId,
        turnId,
        type: "tool",
        toolName: "replace_in_file",
        target: "src/components/TopIsland.tsx",
        status: "running",
        toolStatus: "running",
        message: "Executing...",
      },
      {
        id: commandBlockId,
        turnId,
        type: "tool",
        toolName: "run_command",
        target: "npm test",
        status: "pending",
        toolStatus: "pending",
        message: "Waiting...",
      },
    ],
    conversationTurns: [
      {
        id: turnId,
        userPrompt: "/执行 修改 TopIsland 执行步骤进度。",
        title: "执行步骤进度回归",
        mode: "edit",
        intent: "execute",
        status: "executing",
        summary: "执行模式下 TopIsland 应展示工具步骤进度。",
        blockIds: [userBlockId, readBlockId, editBlockId, commandBlockId],
        collapsed: false,
        createdAt: now,
      },
    ],
    currentTurnId: turnId,
    planArtifacts: [],
    planTasks: [],
    planExecutionEvidenceLedger: [],
    planExecutionEvidenceCount: 0,
    planStage: "idle",
    isPlanApproved: false,
    showPlanPanel: false,
    showDiff: false,
    showTerminal: false,
    showFilePanel: false,
    rightPanelTab: "plan",
    agentStatus: "running",
    isGenerating: true,
    abortController: new AbortController(),
    pendingReviewResolve: null,
    pendingReviewTaskId: null,
    pendingToolCall: null,
    selectedDiffTaskId: null,
    input: "",
    attachedFiles: [],
    contextMentions: [],
  }));

  appendBridgeEvent("seeded", { seedCount: readSeedCount(TOP_ISLAND_EXECUTION_PROGRESS_SCENARIO) });
  bindBridgeSnapshot(TOP_ISLAND_EXECUTION_PROGRESS_SCENARIO);

  const cleanup = () => {
    const latest = useAppStore.getState();
    latest.abortController?.abort();
    useAppStore.setState({ abortController: null, agentStatus: "idle", isGenerating: false });
    bridge.initialized = false;
  };

  bridge.cleanup = cleanup;
  return cleanup;
}

function seedTopIslandPlanTaskProgressScenario() {
  const bridge = getBridge();
  if (!bridge) return undefined;

  bridge.events = [{ type: "boot" }];
  bridge.savedDocuments = [];
  bridge.completed = false;

  const workspace = "/tmp/e2e-top-island-plan-task-progress";
  const sessionId = 999602;
  const now = Date.now();
  const turnId = "e2e-top-island-plan-task-progress-turn";
  const userBlockId = useAppStore.getState()._nextTaskId();
  const planTasks = Array.from({ length: 9 }, (_, index) => {
    const taskNumber = index + 1;
    const filePath = `src/task-${taskNumber}.ts`;
    return {
      id: `plan-task-${taskNumber}`,
      text: `T${taskNumber}: 更新 ${filePath} — 证据: file:${filePath}`,
      status: taskNumber === 9 ? "in_progress" as const : "completed" as const,
      claimedStatus: taskNumber === 9 ? "pending" as const : "completed" as const,
      evidence: [{ kind: "file" as const, value: filePath }],
      evidenceStatus: taskNumber === 9 ? "missing" as const : "satisfied" as const,
      ...(taskNumber === 9 ? { blockedReason: "缺少真实执行证据，暂不能标记完成" } : {}),
    };
  });
  const evidenceLedger = planTasks.slice(0, 8).map((_, index) => ({
    id: `evidence-${index + 1}`,
    kind: "file" as const,
    value: `src/task-${index + 1}.ts`,
    target: `src/task-${index + 1}.ts`,
    sourceTool: "replace_in_file",
    createdAt: now + index,
  }));

  incrementSeedCount(TOP_ISLAND_PLAN_TASK_PROGRESS_SCENARIO);

  useAppStore.setState((state) => ({
    ...state,
    config: {
      ...state.config,
      language: "zh",
      workflowMode: "plan",
    },
    currentWorkspace: workspace,
    sessionsByWorkspace: {
      [workspace]: [
        {
          id: sessionId,
          title: "E2E TopIsland Plan Task Progress",
          date: new Date(now).toISOString(),
          active: true,
          messages: [],
        },
      ],
    },
    currentSessionId: sessionId,
    taskFlow: [
      { id: userBlockId, turnId, type: "user", content: "/计划 执行 9 个任务并追踪进度。" },
    ],
    conversationTurns: [
      {
        id: turnId,
        userPrompt: "/计划 执行 9 个任务并追踪进度。",
        title: "计划任务进度回归",
        mode: "plan",
        intent: "plan",
        status: "executing",
        summary: "计划执行阶段 TopIsland 应展示完整任务列表。",
        blockIds: [userBlockId],
        collapsed: false,
        createdAt: now,
      },
    ],
    currentTurnId: turnId,
    planArtifacts: [
      {
        kind: "tasks",
        path: ".MAIN/plans/tasks.md",
        title: "Tasks",
        content: planTasks.map((task) => `- [${task.status === "completed" ? "x" : " "}] ${task.text}`).join("\n"),
        updatedAt: now,
      },
    ],
    planTasks,
    planExecutionEvidenceLedger: evidenceLedger,
    planExecutionEvidenceCount: evidenceLedger.length,
    planStage: "executing",
    isPlanApproved: true,
    showPlanPanel: true,
    showDiff: false,
    showTerminal: false,
    showFilePanel: false,
    rightPanelTab: "plan",
    agentStatus: "running",
    isGenerating: true,
    abortController: new AbortController(),
    pendingReviewResolve: null,
    pendingReviewTaskId: null,
    pendingToolCall: null,
    selectedDiffTaskId: null,
    input: "",
    attachedFiles: [],
    contextMentions: [],
  }));

  appendBridgeEvent("seeded", { seedCount: readSeedCount(TOP_ISLAND_PLAN_TASK_PROGRESS_SCENARIO) });
  bindBridgeSnapshot(TOP_ISLAND_PLAN_TASK_PROGRESS_SCENARIO);

  const cleanup = () => {
    useAppStore.setState({ abortController: null, isGenerating: false, agentStatus: "idle" });
  };

  return cleanup;
}

function seedGameStudioOnboardingScenario() {
  const bridge = getBridge();
  if (!bridge) return undefined;

  bridge.events = [{ type: "boot" }];
  bridge.savedDocuments = [];
  bridge.completed = false;

  const workspace = "/tmp/e2e-game-studio";
  const sessionId = 999005;
  const now = Date.now();

  const mockSendMessage = (
    text: string,
    _images?: string[],
    _options?: {
      hidden?: boolean;
      reuseCurrentTurn?: boolean;
      preservePlanState?: boolean;
    },
  ): boolean => {
    appendBridgeEvent("send", { text });
    const userBlockId = useAppStore.getState()._nextTaskId();
    const turnId = `e2e-game-studio-turn-${userBlockId}`;

    useAppStore.setState((state) => ({
      ...state,
      input: "",
      pendingSlashCommand: null,
      taskFlow: [
        ...state.taskFlow,
        {
          id: userBlockId,
          turnId,
          type: "user",
          content: text,
        },
      ],
      conversationTurns: [
        ...state.conversationTurns,
        {
          id: turnId,
          userPrompt: text,
          title: "E2E Game Studio",
          mode: "chat",
          status: "done",
          summary: "E2E seeded Game Studio send completed.",
          blockIds: [userBlockId],
          collapsed: false,
          createdAt: Date.now(),
        },
      ],
      currentTurnId: turnId,
    }));

    return true;
  };

  const mockInitializeGameStudioWorkspace = async () => {
    appendBridgeEvent("initialized");
    useAppStore.setState((state) => ({
      ...state,
      gameStudioInitialized: true,
    }));
  };

  const mockRemoveGameStudioWorkspace = async () => {
    appendBridgeEvent("removed");
    useAppStore.setState((state) => ({
      ...state,
      gameStudioInitialized: false,
      activeStudioAgentKey: "studio_auto",
      pendingSlashCommand: null,
    }));
  };

  useAppStore.setState((state) => ({
    ...state,
    config: {
      ...state.config,
      language: "zh",
      themeMode: "dark",
      workflowMode: "chat",
    },
    currentWorkspace: workspace,
    sessionsByWorkspace: {
      [workspace]: [
        {
          id: sessionId,
          title: "E2E Game Studio",
          date: new Date(now).toISOString(),
          active: true,
          messages: [],
          runtimeSnapshot: {
            taskFlow: [],
            agentMessages: [],
            conversationTurns: [],
            currentTurnId: null,
            selectedMainModeKey: "game_studio",
            selectedNexusModeKey: "nexus_game_studio",
            activeStudioAgentKey: "studio_auto",
            gameStudioInitialized: false,
            pendingSlashCommand: null,
            planArtifacts: [],
            planTasks: [],
            planExecutionEvidenceLedger: [],
            planExecutionEvidenceCount: 0,
            planStage: "idle",
            isPlanApproved: false,
            showPlanPanel: false,
            showDiff: false,
            showTerminal: false,
            showFilePanel: false,
            rightPanelTab: "plan",
            selectedDiffTaskId: null,
          },
        },
      ],
    },
    currentSessionId: sessionId,
    selectedMainModeKey: "game_studio",
    selectedNexusModeKey: "nexus_game_studio",
    activeStudioAgentKey: "studio_auto",
    gameStudioInitialized: false,
    pendingSlashCommand: null,
    taskFlow: [],
    conversationTurns: [],
    currentTurnId: null,
    input: "",
    attachedFiles: [],
    contextMentions: [],
    showAgentPicker: false,
    showWorkflowMenu: false,
    isGenerating: false,
    agentStatus: "idle",
    initializeGameStudioWorkspace: mockInitializeGameStudioWorkspace,
    removeGameStudioWorkspace: mockRemoveGameStudioWorkspace,
    sendMessage: mockSendMessage,
  }));

  bridge.getSnapshot = () => {
    const state = useAppStore.getState();
    return {
      input: state.input,
      themeMode: state.config.themeMode,
      conversationTurns: state.conversationTurns.length,
      taskFlowUserCount: state.taskFlow.filter((block) => block.type === "user").length,
      gameStudioInitialized: state.gameStudioInitialized,
      selectedMainModeKey: state.selectedMainModeKey,
      selectedNexusModeKey: state.selectedNexusModeKey,
      seedCount: readSeedCount(GAME_STUDIO_ONBOARDING_SCENARIO),
    };
  };
  bridge.setThemeMode = (mode: "light" | "dark" | "black") => {
    useAppStore.getState().setConfig((prev) => ({
      ...prev,
      themeMode: mode,
    }));
  };
  bridge.setNexusMode = (mode: NexusModeKey) => {
    useAppStore.getState().setSelectedNexusModeKey(mode);
  };
  bridge.resetComposer = () => {
    useAppStore.getState().setInput("");
  };

  const cleanup = () => {
    bridge.initialized = false;
  };

  bridge.cleanup = cleanup;
  return cleanup;
}

function seedComposerMainShortcutsScenario() {
  const bridge = getBridge();
  if (!bridge) return undefined;

  bridge.events = [{ type: "boot" }];
  bridge.savedDocuments = [];
  bridge.completed = false;

  incrementSeedCount(COMPOSER_MAIN_SHORTCUTS_SCENARIO);

  useAppStore.setState((state) => ({
    ...state,
    config: {
      ...state.config,
      language: "zh",
      workflowMode: "chat",
    },
    currentWorkspace: "/tmp/e2e-composer-main-shortcuts",
    selectedWorkspace: "/tmp/e2e-composer-main-shortcuts",
    sessionsByWorkspace: {},
    currentSessionId: null,
    selectedMainModeKey: "main_mode",
    selectedNexusModeKey: "nexus_general",
    activeStudioAgentKey: "studio_auto",
    gameStudioInitialized: false,
    pendingSlashCommand: null,
    taskFlow: [],
    agentMessages: [],
    conversationTurns: [],
    currentTurnId: null,
    input: "",
    attachedFiles: [],
    contextMentions: [],
    showAgentPicker: false,
    showWorkflowMenu: false,
    isGenerating: false,
    agentStatus: "idle",
    elapsedTime: 0,
    planArtifacts: [],
    planTasks: [],
    planExecutionEvidenceLedger: [],
    planExecutionEvidenceCount: 0,
    planStage: "idle",
    isPlanApproved: false,
    showPlanPanel: false,
    showDiff: false,
    showTerminal: false,
    showFilePanel: false,
    rightPanelTab: "plan",
    selectedDiffTaskId: null,
    lockedComposerIntent: null,
  }));

  bridge.getSnapshot = () => {
    const state = useAppStore.getState();
    return {
      input: state.input,
      selectedMainModeKey: state.selectedMainModeKey,
      lockedComposerIntent: state.lockedComposerIntent,
      currentTurnIntent: state.currentTurnId
        ? state.conversationTurns.find((turn) => turn.id === state.currentTurnId)?.intent ?? null
        : null,
      currentTurnTitle: state.currentTurnId
        ? state.conversationTurns.find((turn) => turn.id === state.currentTurnId)?.title ?? null
        : null,
      currentTurnPrompt: state.currentTurnId
        ? state.conversationTurns.find((turn) => turn.id === state.currentTurnId)?.userPrompt ?? null
        : null,
      currentTurnStatus: state.currentTurnId
        ? state.conversationTurns.find((turn) => turn.id === state.currentTurnId)?.status ?? null
        : null,
      planStage: state.planStage,
      seedCount: readSeedCount(COMPOSER_MAIN_SHORTCUTS_SCENARIO),
    };
  };

  const cleanup = () => {
    bridge.initialized = false;
  };

  bridge.cleanup = cleanup;
  return cleanup;
}

function seedCloudSettingsModelSelectScenario() {
  const bridge = getBridge();
  if (!bridge) return undefined;

  bridge.events = [{ type: "boot" }];
  bridge.savedDocuments = [];
  bridge.completed = false;

  incrementSeedCount(CLOUD_SETTINGS_MODEL_SELECT_SCENARIO);

  useAppStore.setState((state) => ({
    ...state,
    config: {
      ...state.config,
      language: "zh",
      activeProfile: "cloud",
      activeCloudServerId: "demo-openai",
      cloudServers: [{
        id: "demo-openai",
        name: "Demo Gateway",
        protocol: "openai",
        provider: "OpenAI",
        apiFormat: "responses",
        endpoint: "https://demo-gateway.example/v1",
        apiKey: "demo-key",
        model: "",
        customHeaders: "",
        temperature: 0.6,
        topP: 0.95,
        reasoningEffort: "none",
        disableResponseStorage: true,
        toolProtocol: "auto",
        auth: { mode: "api_key", status: "disconnected" },
      }],
      cloud: {
        ...state.config.cloud,
        protocol: "openai",
        provider: "OpenAI",
        apiFormat: "responses",
        endpoint: "https://demo-gateway.example/v1",
        apiKey: "demo-key",
        model: "",
        reasoningEffort: "none",
        disableResponseStorage: true,
        toolProtocol: "auto",
        auth: { mode: "api_key", status: "disconnected" },
      },
    },
    currentWorkspace: "",
    currentSessionId: null,
    sessionsByWorkspace: {},
    taskFlow: [],
    conversationTurns: [],
    currentTurnId: null,
    input: "",
    attachedFiles: [],
    contextMentions: [],
    isSettingsOpen: true,
    settingsTab: "cloud",
    showDiff: false,
    showPlanPanel: false,
    showTerminal: false,
    showFilePanel: false,
    selectedDiffTaskId: null,
  }));

  bridge.getSnapshot = () => {
    const state = useAppStore.getState();
    return {
      isSettingsOpen: state.isSettingsOpen,
      settingsTab: state.settingsTab,
      selectedCloudModel: state.config.cloud.model,
      activeCloudServerId: state.config.activeCloudServerId,
      activeCloudServerModel: state.config.cloudServers.find((server: any) => server.id === state.config.activeCloudServerId)?.model ?? null,
      cloudServerCount: state.config.cloudServers.length,
      cloudServers: state.config.cloudServers,
      seedCount: readSeedCount(CLOUD_SETTINGS_MODEL_SELECT_SCENARIO),
    };
  };

  const cleanup = () => {
    bridge.initialized = false;
  };

  bridge.cleanup = cleanup;
  return cleanup;
}

function seedCloudSettingsEmptyScenario() {
  const bridge = getBridge();
  if (!bridge) return undefined;

  bridge.events = [{ type: "boot" }];
  bridge.savedDocuments = [];
  bridge.completed = false;

  incrementSeedCount(CLOUD_SETTINGS_EMPTY_SCENARIO);

  useAppStore.setState((state) => ({
    ...state,
    config: {
      ...state.config,
      language: "zh",
      activeProfile: "cloud",
      activeCloudServerId: "",
      cloudServers: [],
      cloud: {
        ...state.config.cloud,
        model: "",
        apiKey: "",
        customHeaders: "",
      },
    },
    currentWorkspace: "",
    currentSessionId: null,
    sessionsByWorkspace: {},
    taskFlow: [],
    conversationTurns: [],
    currentTurnId: null,
    input: "",
    attachedFiles: [],
    contextMentions: [],
    isSettingsOpen: true,
    settingsTab: "cloud",
    showDiff: false,
    showPlanPanel: false,
    showTerminal: false,
    showFilePanel: false,
    selectedDiffTaskId: null,
  }));

  bridge.getSnapshot = () => {
    const state = useAppStore.getState();
    return {
      isSettingsOpen: state.isSettingsOpen,
      settingsTab: state.settingsTab,
      selectedCloudModel: state.config.cloud.model,
      activeCloudServerId: state.config.activeCloudServerId,
      cloudServerCount: state.config.cloudServers.length,
      cloudServers: state.config.cloudServers,
      seedCount: readSeedCount(CLOUD_SETTINGS_EMPTY_SCENARIO),
    };
  };

  const cleanup = () => {
    bridge.initialized = false;
  };

  bridge.cleanup = cleanup;
  return cleanup;
}

function seedCloudStatusActiveServerModelScenario() {
  const bridge = getBridge();
  if (!bridge) return undefined;

  bridge.events = [{ type: "boot" }];
  bridge.savedDocuments = [];
  bridge.completed = false;

  incrementSeedCount(CLOUD_STATUS_ACTIVE_SERVER_MODEL_SCENARIO);

  useAppStore.setState((state) => ({
    ...state,
    config: {
      ...state.config,
      language: "zh",
      activeProfile: "cloud",
      activeCloudServerId: "qwen-gateway",
      cloudServers: [{
        id: "qwen-gateway",
        name: "Qwen3.6",
        protocol: "openai",
        provider: "OpenAI",
        apiFormat: "chat_completions",
        endpoint: "https://qwen-gateway.example/v1",
        apiKey: "qwen-key",
        model: "qwen3.6-coder",
        customHeaders: "",
        temperature: 0.6,
        topP: 0.95,
        reasoningEffort: "none",
        disableResponseStorage: true,
        toolProtocol: "auto",
        auth: { mode: "api_key", status: "disconnected" },
      }],
      cloud: {
        ...state.config.cloud,
        protocol: "openai",
        provider: "OpenAI",
        apiFormat: "chat_completions",
        endpoint: "https://qwen-gateway.example/v1",
        apiKey: "qwen-key",
        model: "",
        auth: { mode: "api_key", status: "disconnected" },
      },
    },
    currentWorkspace: "",
    currentSessionId: null,
    sessionsByWorkspace: {},
    taskFlow: [],
    conversationTurns: [],
    currentTurnId: null,
    input: "",
    attachedFiles: [],
    contextMentions: [],
    isSettingsOpen: false,
    settingsTab: "cloud",
    showDiff: false,
    showPlanPanel: false,
    showTerminal: false,
    showFilePanel: false,
    selectedDiffTaskId: null,
  }));

  bridge.getSnapshot = () => {
    const state = useAppStore.getState();
    const activeServer = state.config.cloudServers.find((server: any) => server.id === state.config.activeCloudServerId);
    return {
      selectedCloudModel: state.config.cloud.model,
      activeCloudServerModel: activeServer?.model ?? null,
      activeCloudServerName: activeServer?.name ?? null,
      seedCount: readSeedCount(CLOUD_STATUS_ACTIVE_SERVER_MODEL_SCENARIO),
    };
  };

  const cleanup = () => {
    bridge.initialized = false;
  };

  bridge.cleanup = cleanup;
  return cleanup;
}

function seedStreamingTimerScenario() {
  const bridge = getBridge();
  if (!bridge) return undefined;

  bridge.events = [{ type: "boot" }];
  bridge.savedDocuments = [];
  bridge.completed = false;

  incrementSeedCount(STREAMING_TIMER_SCENARIO);

  const now = Date.now();
  const turnId = "e2e-streaming-timer-turn";
  const userBlockId = useAppStore.getState()._nextTaskId();

  useAppStore.setState((state) => ({
    ...state,
    config: {
      ...state.config,
      language: "zh",
      workflowMode: "chat",
    },
    currentWorkspace: "/tmp/e2e-streaming-timer",
    sessionsByWorkspace: {
      "/tmp/e2e-streaming-timer": [
        {
          id: 999006,
          title: "E2E Streaming Timer",
          date: new Date(now).toISOString(),
          active: true,
          messages: [],
        },
      ],
    },
    currentSessionId: 999006,
    taskFlow: [
      { id: userBlockId, turnId, type: "user", content: "请检查计时器是否正常增长。" },
    ],
    conversationTurns: [
      {
        id: turnId,
        userPrompt: "请检查计时器是否正常增长。",
        title: "计时器回归流",
        mode: "chat",
        status: "executing",
        summary: "",
        blockIds: [userBlockId],
        collapsed: false,
        createdAt: now,
      },
    ],
    currentTurnId: turnId,
    input: "",
    attachedFiles: [],
    contextMentions: [],
    elapsedTime: 0,
    isGenerating: true,
    agentStatus: "running",
    showDiff: false,
    showPlanPanel: false,
    showTerminal: false,
    showFilePanel: false,
    selectedDiffTaskId: null,
  }));

  bridge.getSnapshot = () => {
    const state = useAppStore.getState();
    return {
      isGenerating: state.isGenerating,
      elapsedTime: state.elapsedTime,
      seedCount: readSeedCount(STREAMING_TIMER_SCENARIO),
    };
  };

  const cleanup = () => {
    bridge.initialized = false;
  };

  bridge.cleanup = cleanup;
  return cleanup;
}

function seedStreamingResponsivenessScenario() {
  const bridge = getBridge();
  if (!bridge) return undefined;

  bridge.events = [{ type: "boot" }];
  bridge.savedDocuments = [];
  bridge.completed = false;

  incrementSeedCount(STREAMING_RESPONSIVENESS_SCENARIO);

  const now = Date.now();
  const workspace = "/tmp/e2e-streaming-responsiveness";
  const taskFlow: any[] = [];
  const conversationTurns: any[] = [];
  for (let index = 0; index < 70; index += 1) {
    const turnId = `e2e-responsive-history-${index}`;
    const userBlockId = 30_000 + index * 3;
    const agentBlockId = userBlockId + 1;
    taskFlow.push(
      { id: userBlockId, turnId, type: "user", content: `历史问题 ${index}` },
      {
        id: agentBlockId,
        turnId,
        type: "agent",
        content: [
          `历史回复 ${index}`,
          "这是一段用于制造可滚动聊天历史的稳定内容。",
          "- 读取上下文",
          "- 整理结论",
          "- 输出摘要",
        ].join("\n"),
      },
    );
    conversationTurns.push({
      id: turnId,
      userPrompt: `历史问题 ${index}`,
      title: `历史回合 ${index}`,
      mode: "chat",
      status: "done",
      summary: `历史回合 ${index}`,
      blockIds: [userBlockId, agentBlockId],
      collapsed: false,
      createdAt: now + index,
    });
  }

  const activeTurnId = "e2e-responsive-active-turn";
  const activeUserBlockId = 40_000;
  const activeAgentBlockId = 40_001;
  taskFlow.push(
    { id: activeUserBlockId, turnId: activeTurnId, type: "user", content: "请持续输出，同时保持历史滚动流畅。" },
    { id: activeAgentBlockId, turnId: activeTurnId, type: "agent", content: "开始生成...\n", streaming: true },
  );
  conversationTurns.push({
    id: activeTurnId,
    userPrompt: "请持续输出，同时保持历史滚动流畅。",
    title: "流式滚动回归",
    mode: "chat",
    status: "executing",
    summary: "",
    blockIds: [activeUserBlockId, activeAgentBlockId],
    collapsed: false,
    createdAt: now + 100,
  });

  useAppStore.setState((state) => ({
    ...state,
    config: {
      ...state.config,
      language: "zh",
      workflowMode: "chat",
    },
    currentWorkspace: workspace,
    sessionsByWorkspace: {
      [workspace]: [{
        id: 999008,
        title: "E2E Streaming Responsiveness",
        date: new Date(now).toISOString(),
        active: true,
        messages: [],
      }],
    },
    currentSessionId: 999008,
    taskFlow,
    conversationTurns,
    currentTurnId: activeTurnId,
    input: "",
    attachedFiles: [],
    contextMentions: [],
    elapsedTime: 0,
    isGenerating: true,
    agentStatus: "running",
    showDiff: false,
    showPlanPanel: false,
    showTerminal: false,
    showFilePanel: false,
    selectedDiffTaskId: null,
  }));

  let tickCount = 0;
  const timerId = window.setInterval(() => {
    tickCount += 1;
    useAppStore.setState((current) => ({
      ...current,
      taskFlow: current.taskFlow.map((block) =>
        block.id === activeAgentBlockId && block.type === "agent"
          ? { ...block, content: `${block.content}片段 ${tickCount}：保持 UI 可滚动。\n` }
          : block
      ),
    }));
  }, 45);

  bridge.getSnapshot = () => {
    const state = useAppStore.getState();
    return {
      isGenerating: state.isGenerating,
      elapsedTime: state.elapsedTime,
      tickCount,
      taskFlowBlocks: state.taskFlow.length,
      seedCount: readSeedCount(STREAMING_RESPONSIVENESS_SCENARIO),
    };
  };

  const cleanup = () => {
    window.clearInterval(timerId);
    bridge.initialized = false;
  };

  bridge.cleanup = cleanup;
  return cleanup;
}

function seedStreamErrorRecoveryScenario() {
  const bridge = getBridge();
  if (!bridge) return undefined;

  bridge.events = [{ type: "boot" }];
  bridge.savedDocuments = [];
  bridge.completed = false;

  incrementSeedCount(STREAM_ERROR_RECOVERY_SCENARIO);

  const now = Date.now();
  const turnId = "e2e-stream-error-recovery-turn";
  const userBlockId = useAppStore.getState()._nextTaskId();
  const thoughtBlockId = useAppStore.getState()._nextTaskId();

  useAppStore.setState((state) => ({
    ...state,
    config: {
      ...state.config,
      language: "zh",
      workflowMode: "chat",
    },
    currentWorkspace: "/tmp/e2e-stream-error-recovery",
    sessionsByWorkspace: {
      "/tmp/e2e-stream-error-recovery": [
        {
          id: 999007,
          title: "E2E Stream Error Recovery",
          date: new Date(now).toISOString(),
          active: true,
          messages: [],
        },
      ],
    },
    currentSessionId: 999007,
    taskFlow: [
      { id: userBlockId, turnId, type: "user", content: "这个流式报错后不应该还显示思考中。" },
      { id: thoughtBlockId, turnId, type: "thought", content: "先检查流状态，再整理恢复逻辑。", isStreaming: true },
    ],
    conversationTurns: [
      {
        id: turnId,
        userPrompt: "这个流式报错后不应该还显示思考中。",
        title: "流式错误恢复",
        mode: "chat",
        status: "executing",
        summary: "",
        blockIds: [userBlockId, thoughtBlockId],
        collapsed: false,
        createdAt: now,
      },
    ],
    currentTurnId: turnId,
    input: "",
    attachedFiles: [],
    contextMentions: [],
    elapsedTime: 1,
    isGenerating: true,
    agentStatus: "running",
    showDiff: false,
    showPlanPanel: false,
    showTerminal: false,
    showFilePanel: false,
    selectedDiffTaskId: null,
  }));

  const timerId = window.setTimeout(() => {
    const state = useAppStore.getState();
    const errorBlockId = state._nextTaskId();
    useAppStore.setState((current) => ({
      ...current,
      taskFlow: [
        ...finalizeStreamingTaskBlocks(current.taskFlow, turnId, 1),
        {
          id: errorBlockId,
          turnId,
          type: "tool",
          toolName: "Error",
          target: "",
          status: "error",
          toolStatus: "failed",
          message: "模型服务在传输回复时中断或返回了无法解析的数据。原始错误：流读取错误: error decoding response body",
        },
      ],
      conversationTurns: current.conversationTurns.map((turn) =>
        turn.id === turnId
          ? {
              ...turn,
              status: "error",
              summary: "模型服务传输中断，已保留本轮已完成的操作记录。",
              blockIds: turn.blockIds.includes(errorBlockId) ? turn.blockIds : [...turn.blockIds, errorBlockId],
            }
          : turn
      ),
      isGenerating: false,
      agentStatus: "error",
      elapsedTime: 1,
    }));
  }, 1500);

  bridge.getSnapshot = () => {
    const state = useAppStore.getState();
    return {
      isGenerating: state.isGenerating,
      agentStatus: state.agentStatus,
      seedCount: readSeedCount(STREAM_ERROR_RECOVERY_SCENARIO),
    };
  };

  const cleanup = () => {
    window.clearTimeout(timerId);
    bridge.initialized = false;
  };

  bridge.cleanup = cleanup;
  return cleanup;
}

function seedCloudToolProtocolScenario(scenario: string) {
  const bridge = getBridge();
  if (!bridge) return undefined;

  bridge.events = [{ type: "boot" }];
  bridge.savedDocuments = [];
  bridge.completed = false;

  incrementSeedCount(scenario);

  const now = Date.now();
  const workspace = `/tmp/e2e-${scenario}`;
  const sessionId = scenario === CLOUD_TOOL_FALLBACK_SCENARIO
    ? 999501
    : scenario === GAME_STUDIO_EXECUTE_REPLY_SCENARIO
    ? 999504
    : scenario === PSEUDO_TOOL_CALL_RECOVERY_SCENARIO
    ? 999505
    : scenario === LOCAL_FILE_READ_APPROVAL_SCENARIO
    ? 999506
    : 999502;
  const server = {
    id: `e2e-${scenario}-server`,
    name: "E2E Cloud",
    protocol: "openai" as const,
    apiFormat: "responses" as const,
    provider: "OpenAI",
    endpoint: "https://e2e-cloud.example/v1",
    model: "e2e-cloud-model",
    apiKey: "e2e-key",
    customHeaders: "",
    temperature: 0.2,
    topP: 0.95,
    disableResponseStorage: true,
    reasoningEffort: "none" as const,
    toolProtocol: "auto" as const,
    auth: { mode: "api_key" as const, status: "disconnected" as const },
  };

  useAppStore.setState((state) => ({
    ...state,
    config: {
      ...state.config,
      language: "zh",
      workflowMode: "chat",
      activeProfile: "cloud",
      workspace,
      cloud: server,
      cloudServers: [server],
      activeCloudServerId: server.id,
      instructionsEnabled: true,
      hooksEnabled: false,
      sessionRecordingEnabled: false,
    },
    currentWorkspace: workspace,
    selectedWorkspace: workspace,
    sessionsByWorkspace: {
      [workspace]: [
        {
          id: sessionId,
          title: scenario === CLOUD_TOOL_FALLBACK_SCENARIO
            ? "E2E Cloud Tool Fallback"
            : scenario === GAME_STUDIO_EXECUTE_REPLY_SCENARIO
            ? "E2E Game Studio Execute Reply"
            : scenario === PSEUDO_TOOL_CALL_RECOVERY_SCENARIO
            ? "E2E Pseudo Tool Call Recovery"
            : scenario === LOCAL_FILE_READ_APPROVAL_SCENARIO
            ? "E2E Local File Read Approval"
            : "E2E Reply Options Tool Pause",
          date: new Date(now).toISOString(),
          active: true,
          storageStatus: "temporary",
          recordingDisabled: true,
          messages: [],
        },
      ],
    },
    currentSessionId: sessionId,
    selectedMainModeKey: scenario === GAME_STUDIO_EXECUTE_REPLY_SCENARIO ? "game_studio" : "main_mode",
    selectedNexusModeKey: scenario === GAME_STUDIO_EXECUTE_REPLY_SCENARIO ? "nexus_game_studio" : "nexus_general",
    taskFlow: [],
    agentMessages: [],
    conversationTurns: [],
    currentTurnId: null,
    input: "",
    attachedFiles: [],
    contextMentions: [],
    readOnlyAutoApproveForSession: false,
    isGenerating: false,
    agentStatus: "idle",
    elapsedTime: 0,
    showDiff: false,
    showPlanPanel: false,
    showTerminal: false,
    showFilePanel: false,
    selectedDiffTaskId: null,
  }));

  bridge.sendCloudMessage = (text?: string) => {
    if (scenario === EXISTING_PLAN_FOLDER_EXECUTE_SCENARIO) {
      return useAppStore.getState().sendMessage(
        text || "根据.MAIN/plans文件夹的内容，完成执行方案和任务的内容。",
      );
    }

    if (scenario === EXECUTE_MAX_ITERATIONS_CHECKPOINT_SCENARIO) {
      return useAppStore.getState().sendMessage(
        text || "请直接执行一个需要多轮检查的长任务。",
        undefined,
        {
          resolvedIntent: "execute",
          runtimeIntentOverride: "execute",
          executionConsentGranted: true,
          skipIntentResolution: true,
        },
      );
    }

    return useAppStore.getState().sendMessage(
      text || "请读取 README.md 并告诉我是否包含 fallback-ok。",
      undefined,
      {
        resolvedIntent: "discuss",
        skipIntentResolution: true,
      },
    );
  };

  bridge.getSnapshot = () => {
    const state = useAppStore.getState();
    const currentTurn = state.currentTurnId
      ? state.conversationTurns.find((turn) => turn.id === state.currentTurnId) || null
      : null;
    const agentBlocks = state.taskFlow.filter((block) => block.type === "agent") as any[];
    const optionBlocks = agentBlocks.filter((block) => Array.isArray(block.options) && block.options.length > 0);
    const archivedOptionBlocks = agentBlocks.filter((block) => block.archivedAfterChoice);
    const toolBlocks = state.taskFlow.filter((block) => block.type === "tool") as any[];

    return {
      agentStatus: state.agentStatus,
      isGenerating: state.isGenerating,
      planStage: state.planStage,
      isPlanApproved: state.isPlanApproved,
      planAutoResumeCount: state.planAutoResumeCount,
      planTasks: state.planTasks,
      currentTurnStatus: currentTurn?.status ?? null,
      currentTurnIntent: currentTurn?.intent ?? null,
      conversationTurns: state.conversationTurns.length,
      taskFlowBlocks: state.taskFlow.length,
      taskFlowUserCount: state.taskFlow.filter((block) => block.type === "user").length,
      agentTexts: agentBlocks.map((block) => block.content),
      optionBlockCount: optionBlocks.length,
      optionLabels: optionBlocks.flatMap((block) => (block.options || []).map((option: any) => option.label)),
      archivedOptionCount: archivedOptionBlocks.length,
      selectedOptions: archivedOptionBlocks.map((block) => block.selectedOption).filter(Boolean),
      toolNames: toolBlocks.map((block) => block.toolName),
      toolTargets: toolBlocks.map((block) => block.target),
      toolStatuses: toolBlocks.map((block) => block.toolStatus),
      systemTexts: (state.taskFlow.filter((block) => block.type === "system") as any[]).map((block) => block.content),
      seedCount: readSeedCount(scenario),
    };
  };

  const cleanup = () => {
    bridge.initialized = false;
  };

  bridge.cleanup = cleanup;
  return cleanup;
}

function seedPlanApprovalExecuteToolsScenario() {
  const bridge = getBridge();
  if (!bridge) return undefined;

  bridge.events = [{ type: "boot" }];
  bridge.savedDocuments = [];
  bridge.completed = false;

  incrementSeedCount(PLAN_APPROVAL_EXECUTE_TOOLS_SCENARIO);

  const now = Date.now();
  const workspace = "/tmp/e2e-plan-approval-execute-tools";
  const sessionId = 999503;
  const turnId = "e2e-plan-approval-execute-tools-turn";
  const userBlockId = useAppStore.getState()._nextTaskId();
  const agentBlockId = useAppStore.getState()._nextTaskId();
  const server = {
    id: "e2e-plan-approval-execute-tools-server",
    name: "E2E Cloud",
    protocol: "openai" as const,
    apiFormat: "responses" as const,
    provider: "OpenAI",
    endpoint: "https://e2e-cloud.example/v1",
    model: "e2e-cloud-model",
    apiKey: "e2e-key",
    customHeaders: "",
    temperature: 0.2,
    topP: 0.95,
    disableResponseStorage: true,
    reasoningEffort: "none" as const,
    toolProtocol: "auto" as const,
    auth: { mode: "api_key" as const, status: "disconnected" as const },
  };

  useAppStore.setState((state) => ({
    ...state,
    config: {
      ...state.config,
      language: "zh",
      workflowMode: "plan",
      activeProfile: "cloud",
      workspace,
      cloud: server,
      cloudServers: [server],
      activeCloudServerId: server.id,
      instructionsEnabled: false,
      hooksEnabled: false,
      sessionRecordingEnabled: false,
    },
    currentWorkspace: workspace,
    selectedWorkspace: workspace,
    sessionsByWorkspace: {
      [workspace]: [
        {
          id: sessionId,
          title: "E2E Plan Approval Execute Tools",
          date: new Date(now).toISOString(),
          active: true,
          storageStatus: "temporary",
          recordingDisabled: true,
          messages: [],
        },
      ],
    },
    currentSessionId: sessionId,
    selectedMainModeKey: "main_mode",
    selectedNexusModeKey: "nexus_general",
    taskFlow: [
      { id: userBlockId, turnId, type: "user", content: "/计划 修复审批后执行工具不可用的问题。" },
      {
        id: agentBlockId,
        turnId,
        type: "agent",
        content: "计划已经收敛，可以批准执行。",
        streaming: false,
      },
    ],
    agentMessages: [],
    conversationTurns: [
      {
        id: turnId,
        userPrompt: "/计划 修复审批后执行工具不可用的问题。",
        title: "审批后执行工具回归",
        mode: "plan",
        intent: "plan",
        status: "awaiting_approval",
        summary: "等待用户批准执行。",
        blockIds: [userBlockId, agentBlockId],
        collapsed: false,
        createdAt: now,
      },
    ],
    currentTurnId: turnId,
    input: "",
    attachedFiles: [],
    contextMentions: [],
    planArtifacts: [
      {
        kind: "design" as const,
        path: ".MAIN/plans/design.md",
        title: "Design",
        updatedAt: now - 1_000,
        content: "# Design\n\n- 目标：批准后应允许执行工具出现在运行时工具列表中。\n- 方案：Plan 回合保持 plan 身份，但批准后的 runtime intent 使用 execute。\n- 验证：下一轮请求包含 run_command 和写入工具能力。\n",
      },
    ],
    planTasks: [],
    planExecutionEvidenceLedger: [],
    planExecutionEvidenceCount: 0,
    planStage: "design",
    isPlanApproved: false,
    planApprovalChoice: null,
    currentTurnExecutionConsent: { turnId: null, granted: false },
    autoApproveTools: false,
    readOnlyAutoApproveForSession: false,
    showPlanPanel: true,
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
  }));

  bindBridgeSnapshot(PLAN_APPROVAL_EXECUTE_TOOLS_SCENARIO);

  const cleanup = () => {
    bridge.initialized = false;
  };

  bridge.cleanup = cleanup;
  return cleanup;
}

function seedSessionAutoCreateScenario() {
  const bridge = getBridge();
  if (!bridge) return undefined;

  bridge.events = [{ type: "boot" }];
  bridge.savedDocuments = [];
  bridge.completed = false;

  incrementSeedCount(SESSION_AUTO_CREATE_SCENARIO);

  const workspace = "/tmp/e2e-session-auto-create";
  const staleSessionId = 999401;

  const resetRuntime = (sessions: any[], currentSessionId: number | null) => {
    useAppStore.setState((state) => ({
      ...state,
      config: {
        ...state.config,
        language: "zh",
        workflowMode: "chat",
        sessionRecordingEnabled: false,
      },
      currentWorkspace: workspace,
      selectedWorkspace: workspace,
      sessionsByWorkspace: {
        [workspace]: sessions,
      },
      currentSessionId,
      selectedMainModeKey: "game_studio",
      selectedNexusModeKey: "nexus_game_studio",
      activeStudioAgentKey: "studio_auto",
      gameStudioInitialized: false,
      pendingSlashCommand: null,
      taskFlow: [],
      agentMessages: [],
      conversationTurns: [],
      currentTurnId: null,
      input: "",
      attachedFiles: [],
      contextMentions: [],
      readOnlyAutoApproveForSession: false,
      showAgentPicker: false,
      showWorkflowMenu: false,
      isGenerating: false,
      agentStatus: "idle",
      elapsedTime: 0,
      showDiff: false,
      showPlanPanel: false,
      showTerminal: false,
      showFilePanel: false,
      selectedDiffTaskId: null,
    }));
  };

  resetRuntime([], null);

  bridge.prepareEmptyWorkspace = () => {
    resetRuntime([], null);
  };

  bridge.prepareStaleCurrentSession = () => {
    resetRuntime([
      {
        id: staleSessionId,
        title: "旧项目会话",
        date: new Date(Date.now() - 60_000).toISOString(),
        active: false,
        storageStatus: "ok",
        messages: [],
      },
    ], null);
  };

  bridge.sendFirstMessage = () => {
    return useAppStore.getState().sendMessage("/agent writer", undefined, {
      resolvedIntent: "discuss",
      skipIntentResolution: true,
    });
  };

  bridge.getSnapshot = () => {
    const state = useAppStore.getState();
    const sessions = state.sessionsByWorkspace[workspace] || [];
    const currentSession = sessions.find((session) => session.id === state.currentSessionId) || null;
    const staleSession = sessions.find((session) => session.id === staleSessionId) || null;

    return {
      workspace,
      staleSessionId,
      sessionCount: sessions.length,
      currentSessionId: state.currentSessionId,
      activeSessionIds: sessions.filter((session) => session.active).map((session) => session.id),
      currentSessionActive: currentSession?.active === true,
      currentSessionStorageStatus: currentSession?.storageStatus ?? null,
      currentSessionRecordingDisabled: currentSession?.recordingDisabled === true,
      currentSessionRuntimeTurns: currentSession?.runtimeSnapshot?.conversationTurns?.length ?? 0,
      currentSessionRuntimeBlocks: currentSession?.runtimeSnapshot?.taskFlow?.length ?? 0,
      currentSessionMessages: currentSession?.messages?.length ?? 0,
      staleSessionMessages: staleSession?.messages?.length ?? 0,
      taskFlowBlocks: state.taskFlow.length,
      taskFlowUserCount: state.taskFlow.filter((block) => block.type === "user").length,
      conversationTurns: state.conversationTurns.length,
      currentTurnStatus: state.currentTurnId
        ? state.conversationTurns.find((turn) => turn.id === state.currentTurnId)?.status ?? null
        : null,
      activeStudioAgentKey: state.activeStudioAgentKey,
      seedCount: readSeedCount(SESSION_AUTO_CREATE_SCENARIO),
    };
  };

  const cleanup = () => {
    bridge.initialized = false;
  };

  bridge.cleanup = cleanup;
  return cleanup;
}

export function getE2ESavePlanDocumentHandler():
  | ((document: { title: string; suggestedFileName: string; content: string }) => Promise<boolean>)
  | null {
  if (getScenarioName() !== PLAN_FLOW_SCENARIO) return null;

  return async (document) => {
    const bridge = getBridge();
    if (!bridge) return false;
    const snapshot = { ...document, savedAt: Date.now() };
    bridge.savedDocuments = [...(bridge.savedDocuments || []), snapshot];
    bridge.lastSavedDocument = snapshot;
    appendBridgeEvent("saved", { title: document.title });
    return true;
  };
}

export function getE2EQuickReplyHandler(): ((text: string, sourceTurnId?: string) => boolean) | null {
  if (getScenarioName() !== AWAITING_CHOICE_SCENARIO) return null;

  return (text, sourceTurnId) => {
    const bridge = getBridge();
    const state = useAppStore.getState();
    const turnId = sourceTurnId || state.currentTurnId || "e2e-awaiting-choice-turn";
    const replyText = String(text || "").trim();
    if (!replyText) return true;

    appendBridgeEvent("choice-clicked", { text: replyText });
    const userBlockId = state._nextTaskId();

    useAppStore.setState((current) => ({
      ...current,
      taskFlow: [
        ...current.taskFlow.map((block) =>
          block.turnId === turnId &&
          block.type === "agent" &&
          Array.isArray(block.options) &&
          block.options.length > 0
            ? {
                ...block,
                options: undefined,
                archivedAfterChoice: true,
                selectedOption: replyText,
              }
            : block,
        ),
        { id: userBlockId, turnId, type: "user", content: replyText },
      ],
      conversationTurns: current.conversationTurns.map((turn) =>
        turn.id === turnId
          ? {
              ...turn,
              status: "planning",
              summary: "已收到你的选择，正在沿同一回合继续。",
              blockIds: turn.blockIds.includes(userBlockId)
                ? turn.blockIds
                : [...turn.blockIds, userBlockId],
            }
          : turn
      ),
      currentTurnId: turnId,
      agentStatus: "running",
      isGenerating: true,
    }));

    window.setTimeout(() => {
      const latest = useAppStore.getState();
      const assistantBlockId = latest._nextTaskId();
      useAppStore.setState((current) => ({
        ...current,
        taskFlow: [
          ...current.taskFlow,
          {
            id: assistantBlockId,
            turnId,
            type: "agent",
            content: `已按你的选择继续：${replyText}。接下来我会在同一回合里继续补齐正式方案，而不是直接跳过这一步。`,
            streaming: false,
          },
        ],
        conversationTurns: current.conversationTurns.map((turn) =>
          turn.id === turnId
            ? {
                ...turn,
                status: "done",
                summary: "用户完成选择后，当前回合已继续并保留上下文。",
                blockIds: turn.blockIds.includes(assistantBlockId)
                  ? turn.blockIds
                  : [...turn.blockIds, assistantBlockId],
              }
            : turn
        ),
        planStage: "ready_to_execute",
        agentStatus: "idle",
        isGenerating: false,
      }));

      if (bridge) {
        bridge.completed = true;
      }
      appendBridgeEvent("choice-completed", { turnId });
    }, 80);

    return true;
  };
}

export function getE2EResumeExecutionHandler(): (() => Promise<boolean>) | null {
  if (getScenarioName() !== PLAN_RELOAD_RESUME_SCENARIO) return null;

  return async () => {
    appendBridgeEvent("resume-requested");
    useAppStore.setState((state) => ({
      ...state,
      agentStatus: "running",
      isGenerating: true,
      showPlanPanel: true,
      showDiff: false,
      showTerminal: false,
      showFilePanel: false,
      rightPanelTab: "plan",
    }));

    window.setTimeout(() => {
      finishPlanExecution("恢复执行完成，剩余任务已全部收尾。", "页面重载后的 Plan 已成功恢复，并顺利完成剩余任务。");
      appendBridgeEvent("completed");
    }, 80);

    return true;
  };
}


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
      { path: workspace, name: "E2E Sidebar Remove Last", addedAt: now, lastActiveAt: now },
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
    activeStudioAgentKey: "studio_auto",
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

export function initializeE2EScenarios(): (() => void) | undefined {
  const scenario = getScenarioName();
  if (!scenario) return undefined;

  const bridge = getBridge();
  if (!bridge || bridge.initialized) {
    return bridge?.cleanup;
  }

  bridge.initialized = true;
  bridge.scenario = scenario;
  bindCloudServerBridgeControls();

  if (scenario === PLAN_FLOW_SCENARIO) {
    return seedPlanFlowScenario();
  }

  if (scenario === PLAN_QUICK_REPLY_APPROVAL_SCENARIO) {
    return seedPlanQuickReplyApprovalScenario();
  }

  if (scenario === PLAN_RELOAD_RESUME_SCENARIO) {
    return seedPlanReloadResumeScenario();
  }

  if (scenario === DIFF_RELOAD_SUMMARY_SCENARIO) {
    return seedDiffReloadSummaryScenario();
  }

  if (scenario === PLAN_REPLACE_REFRESH_SCENARIO) {
    return seedPlanReplaceRefreshScenario();
  }

  if (scenario === AWAITING_CHOICE_SCENARIO) {
    return seedAwaitingChoiceScenario();
  }

  if (scenario === FEISHU_REMOTE_ANALYSIS_SCENARIO) {
    return seedFeishuRemoteAnalysisScenario();
  }

  if (scenario === READ_CONTEXT_COLLAPSE_SCENARIO) {
    return seedReadContextCollapseScenario();
  }

  if (scenario === THOUGHT_DISPLAY_SCENARIO) {
    return seedThoughtDisplayScenario();
  }

  if (scenario === GAME_STUDIO_ONBOARDING_SCENARIO) {
    return seedGameStudioOnboardingScenario();
  }

  if (scenario === COMPOSER_MAIN_SHORTCUTS_SCENARIO) {
    return seedComposerMainShortcutsScenario();
  }

  if (scenario === CLOUD_SETTINGS_MODEL_SELECT_SCENARIO) {
    return seedCloudSettingsModelSelectScenario();
  }

  if (scenario === CLOUD_SETTINGS_EMPTY_SCENARIO) {
    return seedCloudSettingsEmptyScenario();
  }

  if (scenario === CLOUD_STATUS_ACTIVE_SERVER_MODEL_SCENARIO) {
    return seedCloudStatusActiveServerModelScenario();
  }

  if (scenario === STREAMING_TIMER_SCENARIO) {
    return seedStreamingTimerScenario();
  }

  if (scenario === STREAMING_RESPONSIVENESS_SCENARIO) {
    return seedStreamingResponsivenessScenario();
  }

  if (scenario === STREAM_ERROR_RECOVERY_SCENARIO) {
    return seedStreamErrorRecoveryScenario();
  }

  if (scenario === CLOUD_TOOL_FALLBACK_SCENARIO) {
    return seedCloudToolProtocolScenario(CLOUD_TOOL_FALLBACK_SCENARIO);
  }

  if (scenario === REPLY_OPTIONS_TOOL_PAUSE_SCENARIO) {
    return seedCloudToolProtocolScenario(REPLY_OPTIONS_TOOL_PAUSE_SCENARIO);
  }

  if (scenario === EXECUTE_QUICK_REPLY_RUNTIME_SCENARIO) {
    return seedCloudToolProtocolScenario(EXECUTE_QUICK_REPLY_RUNTIME_SCENARIO);
  }

  if (scenario === GAME_STUDIO_EXECUTE_REPLY_SCENARIO) {
    return seedCloudToolProtocolScenario(GAME_STUDIO_EXECUTE_REPLY_SCENARIO);
  }

  if (scenario === PSEUDO_TOOL_CALL_RECOVERY_SCENARIO) {
    return seedCloudToolProtocolScenario(PSEUDO_TOOL_CALL_RECOVERY_SCENARIO);
  }

  if (scenario === EXISTING_PLAN_FOLDER_EXECUTE_SCENARIO) {
    return seedCloudToolProtocolScenario(EXISTING_PLAN_FOLDER_EXECUTE_SCENARIO);
  }

  if (scenario === EXECUTE_MAX_ITERATIONS_CHECKPOINT_SCENARIO) {
    return seedCloudToolProtocolScenario(EXECUTE_MAX_ITERATIONS_CHECKPOINT_SCENARIO);
  }

  if (scenario === LOCAL_FILE_READ_APPROVAL_SCENARIO) {
    return seedCloudToolProtocolScenario(LOCAL_FILE_READ_APPROVAL_SCENARIO);
  }

  if (scenario === PLAN_APPROVAL_EXECUTE_TOOLS_SCENARIO) {
    return seedPlanApprovalExecuteToolsScenario();
  }

  if (scenario === SESSION_AUTO_CREATE_SCENARIO) {
    return seedSessionAutoCreateScenario();
  }

  if (scenario === TOP_ISLAND_EXECUTION_PROGRESS_SCENARIO) {
    return seedTopIslandExecutionProgressScenario();
  }

  if (scenario === TOP_ISLAND_PLAN_TASK_PROGRESS_SCENARIO) {
    return seedTopIslandPlanTaskProgressScenario();
  }

  
  if (scenario === SIDEBAR_REMOVE_LAST_WORKSPACE_SCENARIO) {
    return seedSidebarRemoveLastWorkspaceScenario();
  }

bridge.initialized = false;
  return undefined;
}
