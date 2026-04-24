import { useAppStore } from "../store/useAppStore";
import { syncPlanArtifactAfterToolSuccess } from "./planArtifactSync";
import { getPlanArtifactTitle } from "./workflowModels";
import type { NexusModeKey } from "./gameStudioCatalog";

const PLAN_FLOW_SCENARIO = "plan-flow";
const PLAN_RELOAD_RESUME_SCENARIO = "plan-reload-resume";
const DIFF_RELOAD_SUMMARY_SCENARIO = "diff-reload-summary";
const PLAN_REPLACE_REFRESH_SCENARIO = "plan-replace-refresh";
const AWAITING_CHOICE_SCENARIO = "awaiting-choice";
const GAME_STUDIO_ONBOARDING_SCENARIO = "game-studio-onboarding";
const CLOUD_SETTINGS_MODEL_SELECT_SCENARIO = "cloud-settings-model-select";
const STREAMING_TIMER_SCENARIO = "streaming-timer";
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
    return {
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
      conversationTurns: state.conversationTurns.length,
      taskFlowUserCount: state.taskFlow.filter((block) => block.type === "user").length,
      seedCount: readSeedCount(scenario),
    };
  };
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
    planTasks: current.planTasks.map((task) => ({ ...task, status: "completed" as const })),
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
      kind: "requirements" as const,
      path: ".MAIN/plans/requirements.md",
      title: "Requirements",
      updatedAt: now - 2_000,
      content: "# Requirements\n\n- 需要支持生成计划、保存方案、批准执行与最终收尾。\n",
    },
    {
      kind: "design" as const,
      path: ".MAIN/plans/design.md",
      title: "Design",
      updatedAt: now - 1_000,
      content: "# Design\n\n- 右侧 Plan Workspace 负责展示方案与审批入口。\n- 保存成功后应明确反馈已保存。\n",
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
          "- 先生成可保存的需求与设计方案，再等待用户确认是否执行。",
          "",
          "## 执行策略",
          "1. 先补齐 `requirements.md` 与 `design.md`。",
          "2. 用户可先保存方案留档。",
          "3. 只有在用户批准后，才生成 `.MAIN/plans/tasks.md` 并进入执行。",
          "",
          "## 风险控制",
          "- 未批准前不生成执行任务，不改源码。",
          "- 保存方案后，即使不执行也能保留文档。",
          "",
          "<plan>",
          JSON.stringify([
            { id: "proposal-1", subject: "补齐需求与设计文档" },
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
        current.upsertPlanArtifact({
          kind: "tasks",
          path: ".MAIN/plans/tasks.md",
          title: "Tasks",
          updatedAt: Date.now(),
          content: [
            "# Tasks",
            "",
            "- [x] 补齐计划文档与需求说明",
            "- [ ] 保存方案供用户留档",
            "- [ ] 批准执行并完成最终收尾",
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
        { id: "reload-task-1", text: "恢复计划工作区状态", status: "completed" },
        { id: "reload-task-2", text: "恢复对话与执行任务进度", status: "in_progress" },
        { id: "reload-task-3", text: "继续执行并完成收尾", status: "pending" },
      ],
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
          content: "请直接修改两个文件，并给我一个可点击查看的变更摘要。",
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
          },
        },
        {
          id: agentBlockId,
          turnId,
          type: "agent",
          content: "已完成两个文件的修改，你可以在摘要卡中查看每个文件的 Diff。",
          streaming: false,
        },
      ],
      conversationTurns: [
        {
          id: turnId,
          userPrompt: "请直接修改两个文件，并给我一个可点击查看的变更摘要。",
          title: "Diff 摘要重载回归流",
          mode: "edit",
          status: "done",
          summary: "两个文件已修改，可点击查看 Diff。",
          blockIds: [userBlockId, toolBlockIdA, toolBlockIdB, agentBlockId],
          collapsed: false,
          createdAt: now,
        },
      ],
      currentTurnId: turnId,
      planArtifacts: [],
      planTasks: [],
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
    "- [x] 补齐计划文档与需求说明",
    "- [ ] 保存方案供用户留档",
    "- [ ] 批准执行并完成最终收尾",
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
      { id: "replace-task-1", text: "补齐计划文档与需求说明", status: "completed" },
      { id: "replace-task-2", text: "保存方案供用户留档", status: "in_progress" },
      { id: "replace-task-3", text: "批准执行并完成最终收尾", status: "pending" },
    ],
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

  let replaceTimer: number | null = window.setTimeout(() => {
    void (async () => {
      const updatedTasksContent = [
        "# Tasks",
        "",
        "- [x] 补齐计划文档与需求说明",
        "- [x] 保存方案供用户留档（已完成）",
        "- [ ] 批准执行并完成最终收尾",
      ].join("\n");

      await syncPlanArtifactAfterToolSuccess(
        "replace_in_file",
        {
          path: ".MAIN/plans/tasks.md",
          search_text: "- [ ] 保存方案供用户留档",
          replace_text: "- [x] 保存方案供用户留档（已完成）",
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
    })();
  }, 500);

  const cleanup = () => {
    if (replaceTimer != null) window.clearTimeout(replaceTimer);
    replaceTimer = null;
    bridge.initialized = false;
  };

  bridge.cleanup = cleanup;
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
  bridge.setThemeMode = (mode: "light" | "dark") => {
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
      cloud: {
        ...state.config.cloud,
        protocol: "openai",
        provider: "OpenAI",
        apiFormat: "responses",
        endpoint: "https://demo-gateway.example/v1",
        apiKey: "demo-key",
        model: "",
        reasoningEffort: "xhigh",
        disableResponseStorage: true,
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
      seedCount: readSeedCount(CLOUD_SETTINGS_MODEL_SELECT_SCENARIO),
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
        ...current.taskFlow,
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
                collapsed: true,
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

export function initializeE2EScenarios(): (() => void) | undefined {
  const scenario = getScenarioName();
  if (!scenario) return undefined;

  const bridge = getBridge();
  if (!bridge || bridge.initialized) {
    return bridge?.cleanup;
  }

  bridge.initialized = true;
  bridge.scenario = scenario;

  if (scenario === PLAN_FLOW_SCENARIO) {
    return seedPlanFlowScenario();
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

  if (scenario === GAME_STUDIO_ONBOARDING_SCENARIO) {
    return seedGameStudioOnboardingScenario();
  }

  if (scenario === CLOUD_SETTINGS_MODEL_SELECT_SCENARIO) {
    return seedCloudSettingsModelSelectScenario();
  }

  if (scenario === STREAMING_TIMER_SCENARIO) {
    return seedStreamingTimerScenario();
  }

  bridge.initialized = false;
  return undefined;
}
