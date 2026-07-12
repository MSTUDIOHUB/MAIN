import { GLOBAL_CHAT_KEY, finalizeStreamingTaskBlocks, useAppStore } from "../store/useAppStore";
import {
  ensureApprovedPlanRuntimeTasksForState,
  evaluateApprovedPlanExecutionReadiness,
} from "../store/submitApprovedPlanExecution";
import { syncPlanArtifactAfterToolSuccess } from "./planArtifactSync";
import { getPlanArtifactTitle } from "./workflowModels";
import { createGoalDefinition, createGoalProgress, type GoalStatus } from "./goalState";
import { buildGoalRuntimeSnapshot } from "./goalRuntime";
import { buildPlanReviewActionRequest, buildUserChoiceActionRequest } from "./actionRequest";
import { buildToolPermissionActionRequest } from "./pendingToolReview";
import { buildPlanApprovalIdentity } from "./planApprovalIdentity";
import type { HarnessRunMarker } from "./harnessCrashTelemetry";
import { MAIN_THREAD_EVENT_SCHEMA_VERSION } from "./turnEvents";
import type { NexusModeKey } from "./gameStudio/catalog";
import {
  isCloudSettingsScenario,
  seedCloudSettingsScenario,
} from "./e2e/scenarios/cloudSettings";

const PLAN_FLOW_SCENARIO = "plan-flow";
const PLAN_QUICK_REPLY_APPROVAL_SCENARIO = "plan-quick-reply-approval";
const PLAN_QUICK_REPLY_MATERIALIZE_GEMMA_SCENARIO = "plan-quick-reply-materialize-gemma";
const PLAN_QUICK_REPLY_MATERIALIZE_QWEN_SCENARIO = "plan-quick-reply-materialize-qwen";
const PLAN_RELOAD_RESUME_SCENARIO = "plan-reload-resume";
const DIFF_RELOAD_SUMMARY_SCENARIO = "diff-reload-summary";
const LIVE_EDIT_DIFF_STEPS_SCENARIO = "live-edit-diff-steps";
const STAGE_CONCLUSION_PRESERVED_SCENARIO = "stage-conclusion-preserved";
const PLAN_REPLACE_REFRESH_SCENARIO = "plan-replace-refresh";
const AWAITING_CHOICE_SCENARIO = "awaiting-choice";
const AWAITING_CHOICE_MIXED_OPTIONS_SCENARIO = "awaiting-choice-mixed-options";
const AWAITING_CHOICE_DIAGNOSTIC_REJECTED_SCENARIO = "awaiting-choice-diagnostic-rejected";
const FEISHU_REMOTE_ANALYSIS_SCENARIO = "feishu-remote-analysis";
const READ_CONTEXT_COLLAPSE_SCENARIO = "read-context-collapse";
const READ_CONTEXT_INTERLEAVED_SCENARIO = "read-context-interleaved";
const READ_CONTEXT_AGENT_SEGMENT_SCENARIO = "read-context-agent-segment";
const READ_CONTEXT_THIN_NARRATION_SCENARIO = "read-context-thin-narration";
const READ_CONTEXT_PERSISTENT_PROGRESS_SCENARIO = "read-context-persistent-progress";
const OPENCODE_TRANSCRIPT_DISPLAY_SCENARIO = "opencode-transcript-display";
const PROCESS_DISPLAY_SCENARIO = "process-display";
const GAME_STUDIO_ONBOARDING_SCENARIO = "game-studio-onboarding";
const COMPOSER_MAIN_SHORTCUTS_SCENARIO = "composer-main-shortcuts";
const GAME_STUDIO_PLAN_SHORTCUTS_SCENARIO = "game-studio-plan-shortcuts";
const STREAMING_TIMER_SCENARIO = "streaming-timer";
const COMPOSER_RUNNING_GUIDANCE_SCENARIO = "composer-running-guidance";
const STREAMING_RESPONSIVENESS_SCENARIO = "streaming-responsiveness";
const LOCAL_PLAN_SLOW_FIRST_TOKEN_SCENARIO = "local-plan-slow-first-token";
const REAL_OMLX_PLAN_FLOW_SCENARIO = "real-omlx-plan-flow";
const STREAM_ERROR_RECOVERY_SCENARIO = "stream-error-recovery";
const SESSION_AUTO_CREATE_SCENARIO = "session-auto-create";
const CLOUD_TOOL_FALLBACK_SCENARIO = "cloud-tool-fallback";
const REPLY_OPTIONS_TOOL_PAUSE_SCENARIO = "reply-options-tool-pause";
const PLAN_OPERATION_APPROVAL_REUSE_SCENARIO = "plan-operation-approval-reuse";
const PLAN_APPROVAL_EXECUTE_TOOLS_SCENARIO = "plan-approval-execute-tools";
const OPERATION_APPROVAL_NATURAL_FLOW_SCENARIO = "operation-approval-natural-flow";
const EXECUTE_QUICK_REPLY_RUNTIME_SCENARIO = "execute-quick-reply-runtime";
const GAME_STUDIO_EXECUTE_REPLY_SCENARIO = "game-studio-execute-reply-runtime";
const UNITY_MCP_OPTIONS_PRIORITY_SCENARIO = "unity-mcp-options-priority";
const UNITY_TOOL_CODE_COMPAT_SCENARIO = "unity-tool-code-compat";
const UNITY_NO_ERROR_ROUTING_SCENARIO = "unity-no-error-routing";
const PSEUDO_TOOL_CALL_RECOVERY_SCENARIO = "pseudo-tool-call-recovery";
const MALFORMED_TOOL_USE_PLAN_SCENARIO = "malformed-tool-use-plan";
const PLAN_CLOSURE_GUARD_EMPTY_SCENARIO = "plan-closure-guard-empty";
const EXISTING_PLAN_FOLDER_EXECUTE_SCENARIO = "existing-plan-folder-execute";
const APPROVED_PLAN_EXECUTION_NO_TOOL_SCENARIO = "approved-plan-execution-no-tool";
const APPROVED_PLAN_EXECUTION_REPLAY_SCENARIO = "approved-plan-execution-replay";
const EXECUTE_MAX_ITERATIONS_CHECKPOINT_SCENARIO = "execute-max-iterations-checkpoint";
const ORDINARY_CONTINUE_NEW_TURN_SCENARIO = "ordinary-continue-new-turn";
const LOCAL_FILE_READ_APPROVAL_SCENARIO = "local-file-read-approval";
const PROGRESS_NARRATION_TOOL_FLOW_SCENARIO = "progress-narration-tool-flow";
const GLOBAL_CHAT_TOOL_SCOPE_SCENARIO = "global-chat-tool-scope";
const GLOBAL_CHAT_ATTACHMENT_READ_SCENARIO = "global-chat-attachment-read";
const TOP_ISLAND_EXECUTION_PROGRESS_SCENARIO = "execution-capsule-execution-progress";
const TOP_ISLAND_PLAN_TASK_PROGRESS_SCENARIO = "execution-capsule-plan-task-progress";
const TOP_ISLAND_STRICT_EVIDENCE_PROGRESS_SCENARIO = "execution-capsule-strict-evidence-progress";
const TOP_ISLAND_PENDING_TOOL_REVIEW_SCENARIO = "execution-capsule-pending-tool-review";
const TOP_ISLAND_ORPHAN_PENDING_REVIEW_SCENARIO = "execution-capsule-orphan-pending-review";
const TOP_ISLAND_PANEL_STABILITY_SCENARIO = "execution-capsule-panel-stability";
const GAME_STUDIO_TOOL_GROUP_COLLAPSE_SCENARIO = "game-studio-tool-group-collapse";
const GAME_STUDIO_AWAITING_CHOICE_SCENARIO = "game-studio-awaiting-choice";
const CAPSULE_MODEL_EXPLANATION_SCENARIO = "capsule-model-explanation";
const CAPSULE_PROGRESS_ONLY_SCENARIO = "capsule-progress-only";
const GOAL_CAPSULE_SCENARIO = "goal-capsule";
const SIDEBAR_REMOVE_LAST_WORKSPACE_SCENARIO = "sidebar-remove-last-workspace";
const USER_CONTEXT_PILLS_SCENARIO = "user-context-pills";
const SUBAGENTS_PANEL_SCENARIO = "subagents-panel";
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

function buildE2ERunningToolPermissionOwner(input: {
  workspace: string;
  sessionId: number;
  turnId: string;
  runId: string;
  workflowMode: string;
  planStage: string;
  isPlanApproved: boolean;
  previous?: HarnessRunMarker | null;
  now?: number;
}): HarnessRunMarker {
  const now = input.now ?? Date.now();
  const previous = input.previous?.runId === input.runId &&
    input.previous.sessionKey === `${input.workspace}:${input.sessionId}` &&
    input.previous.turnId === input.turnId
    ? input.previous
    : null;
  return {
    schemaVersion: 1,
    runId: input.runId,
    parentRunId: previous?.parentRunId ?? null,
    instanceId: previous?.instanceId || `e2e-tool-permission-${input.sessionId}`,
    sessionKey: `${input.workspace}:${input.sessionId}`,
    workspace: input.workspace,
    sessionId: input.sessionId,
    turnId: input.turnId,
    status: "running",
    workflowMode: input.workflowMode,
    runtimeIntent: "execute",
    planStage: input.planStage,
    isPlanApproved: input.isPlanApproved,
    iteration: previous?.iteration ?? 1,
    maxIterations: previous?.maxIterations ?? 12,
    messagesLen: previous?.messagesLen ?? 2,
    toolCount: previous?.toolCount ?? 0,
    latestTool: previous?.latestTool ?? null,
    latestToolTarget: previous?.latestToolTarget ?? null,
    activeStreamId: previous?.activeStreamId ?? null,
    streamStatus: previous?.streamStatus ?? "closed",
    streamChunkCount: previous?.streamChunkCount ?? 0,
    streamByteCount: previous?.streamByteCount ?? 0,
    streamElapsedMs: previous?.streamElapsedMs ?? 0,
    streamLifecycleStatus: previous?.streamLifecycleStatus ?? "completed",
    lastStreamError: previous?.lastStreamError ?? null,
    startedAt: previous?.startedAt ?? now,
    updatedAt: now,
    closedAt: null,
    closeReason: null,
  };
}

function buildE2EPausedActionOwner(input: {
  workspace: string;
  sessionId: number;
  turnId: string;
  runId: string;
  workflowMode: string;
  runtimeIntent: string;
  planStage: string;
  isPlanApproved: boolean;
  closeReason: string;
  parentRunId?: string | null;
  now?: number;
}): HarnessRunMarker {
  const now = input.now ?? Date.now();
  return {
    schemaVersion: 1,
    runId: input.runId,
    activeRunId: input.runId,
    activeParentRunId: input.parentRunId || null,
    parentRunId: input.parentRunId || null,
    instanceId: `e2e-paused-action-${input.sessionId}`,
    sessionKey: `${input.workspace}:${input.sessionId}`,
    workspace: input.workspace,
    sessionId: input.sessionId,
    turnId: input.turnId,
    status: "paused",
    workflowMode: input.workflowMode,
    runtimeIntent: input.runtimeIntent,
    planStage: input.planStage,
    isPlanApproved: input.isPlanApproved,
    iteration: 1,
    maxIterations: 12,
    messagesLen: 2,
    toolCount: 0,
    latestTool: null,
    latestToolTarget: null,
    activeStreamId: null,
    streamStatus: "closed",
    streamChunkCount: 0,
    streamByteCount: 0,
    streamElapsedMs: 0,
    streamLifecycleStatus: "completed",
    lastStreamError: null,
    startedAt: now - 1_000,
    updatedAt: now,
    closedAt: now,
    closeReason: input.closeReason,
  };
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
  bridge.setModelRuntimeLock = (options: {
    activeProfile?: "local" | "cloud";
    activeCloudServerId?: string;
    status?: "running" | "pending_review";
  } = {}) => {
    const status = options.status === "pending_review" ? "pending_review" : "running";
    useAppStore.setState((state) => ({
      ...state,
      config: {
        ...state.config,
        activeProfile: options.activeProfile || state.config.activeProfile,
        activeCloudServerId: options.activeCloudServerId ?? state.config.activeCloudServerId,
      },
      agentStatus: status,
      isGenerating: status === "running",
    }));
  };
  bridge.clearModelRuntimeLock = () => {
    useAppStore.setState((state) => ({
      ...state,
      agentStatus: "idle",
      isGenerating: false,
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
    const userBlocks = state.taskFlow.filter((block) => block.type === "user") as any[];
    const archivedOptionBlocks = agentBlocks.filter((block) => block.archivedAfterChoice);
    const agentMessageSummaries = (state.agentMessages || []).map((message: any) => {
      const content = message?.content;
      if (Array.isArray(content)) {
        return {
          role: message?.role || "",
          hasImage: content.some((part: any) => part?.type === "image_url" || part?.type === "input_image"),
          text: content
            .filter((part: any) => part?.type === "text" || part?.type === "input_text")
            .map((part: any) => String(part.text || ""))
            .join("\n"),
        };
      }
      return {
        role: message?.role || "",
        hasImage: false,
        text: String(content || ""),
      };
    });
    const scopeKey = state.currentWorkspace || GLOBAL_CHAT_KEY;
    const sessions = state.sessionsByWorkspace[scopeKey] || [];
    const currentTurn = state.currentTurnId
      ? state.conversationTurns.find((turn) => turn.id === state.currentTurnId) || null
      : null;
    const visibleConversationTurns = state.conversationTurns
      .filter((turn) => turn.uiVisibility !== "internal")
      .map((turn) => ({
        id: turn.id,
        title: turn.title,
        status: turn.status,
        intent: turn.intent,
        displayIntent: turn.displayIntent || turn.intent,
        parentPlanTurnId: turn.parentPlanTurnId || null,
        uiVisibility: turn.uiVisibility || "visible",
        blockCount: turn.blockIds.length,
      }));
    return {
      workspace: state.currentWorkspace || "",
      currentSessionId: state.currentSessionId,
      sessionCount: sessions.length,
      taskFlowBlocks: state.taskFlow.length,
      planStage: state.planStage,
      isPlanApproved: state.isPlanApproved,
      planArtifactPaths: state.planArtifacts.map((artifact) => artifact.path),
      agentStatus: state.agentStatus,
      isGenerating: state.isGenerating,
      input: state.input,
      queuedUserMessage: state.queuedUserMessage,
      activeGuidance: state.activeGuidance,
      autoApproveTools: state.autoApproveTools,
      planTasks: state.planTasks,
      selectedDiffTaskId: state.selectedDiffTaskId,
      showPlanPanel: state.showPlanPanel,
      showDiff: state.showDiff,
      showTerminal: state.showTerminal,
      rightPanelTab: state.rightPanelTab,
      pendingReviewTaskId: state.pendingReviewTaskId,
      pendingToolCallName: state.pendingToolCall?.name ?? null,
      pendingToolCallArguments: state.pendingToolCall?.arguments ?? null,
      savedDocuments: bridge.savedDocuments || [],
      completed: Boolean(bridge.completed),
      currentTurnId: currentTurn?.id ?? null,
      currentTurnTitle: currentTurn?.title ?? null,
      currentTurnStatus: currentTurn?.status ?? null,
      currentTurnIntent: currentTurn?.intent ?? null,
      currentTurnDisplayIntent: currentTurn?.displayIntent ?? currentTurn?.intent ?? null,
      currentTurnParentPlanTurnId: currentTurn?.parentPlanTurnId ?? null,
      conversationTurns: state.conversationTurns.length,
      executionChildTurns: state.conversationTurns.filter((turn) => turn.parentPlanTurnId === "e2e-execution-capsule-panel-stability-turn").length,
      currentTurnExecutionConsent: state.currentTurnExecutionConsent,
      pendingPlanApprovalHandoff: state.pendingPlanApprovalHandoff,
      planApprovalExecutionStartedForTurnId: state.planApprovalExecutionStartedForTurnId,
      visibleConversationTurns,
      taskFlowUserCount: state.taskFlow.filter((block) => block.type === "user").length,
      agentTexts: agentBlocks.map((block) => block.content),
      toolNames: toolBlocks.map((block) => block.toolName),
      toolTargets: toolBlocks.map((block) => block.target),
      userContextItems: userBlocks.flatMap((block) => Array.isArray(block.contextItems) ? block.contextItems : []),
      userBlockImagesCount: userBlocks.reduce(
        (count, block) => count + (Array.isArray(block.images) ? block.images.length : 0),
        0,
      ),
      agentMessageSummaries,
      selectedOptions: archivedOptionBlocks.map((block) => block.selectedOption).filter(Boolean),
      themeMode: state.config.themeMode,
      goalStatus: state.goalStatus,
      activeGoalId: state.activeGoal?.id ?? null,
      activeGoalObjective: state.activeGoal?.rawText || state.activeGoal?.objective || null,
      activeGoalRevision: state.activeGoal?.revision ?? null,
      seedCount: readSeedCount(scenario),
    };
  };
  bridge.setThemeMode = (mode: "light" | "dark" | "black") => {
    useAppStore.getState().setConfig((prev) => ({
      ...prev,
      themeMode: mode,
    }));
  };
  bridge.setTheme = (theme: string) => {
    useAppStore.getState().setConfig((prev) => ({
      ...prev,
      theme: theme as any,
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
  const workspace = "/tmp/e2e-plan-flow";
  const reviewRunId = "run-e2e-plan-flow-review";
  const now = Date.now();
  const userBlockId = useAppStore.getState()._nextTaskId();
  const agentBlockId = useAppStore.getState()._nextTaskId();

  const artifacts = [
    {
      kind: "design" as const,
      path: ".MAIN/plans/plan.md",
      title: "Design",
      updatedAt: now - 1_000,
      content: [
        "# Design",
        "",
        "## 目标",
        "- 支持生成计划、保存方案、批准执行与最终收尾。",
        "",
        "## 关键改动",
        "- 修改 `src/lib/planControl.ts`，让正式 Plan 审批进入同一回合的执行 handoff。",
        "- 修改 `src/components/RightPanel.tsx`，保持 Plan Workspace 的保存与审批入口可见。",
        "",
        "## 数据流",
        "- Plan artifact -> exact review request -> approved child run -> evidence-backed completion。",
        "",
        "## 验证方式",
        "- 运行 `node --test tests/node/workflow-models.test.mjs`，验证审批和执行状态转换。",
        "- 使用 E2E 点击批准，验证同一逻辑回合进入执行并最终完成。",
      ].join("\n"),
    },
  ];
  const approvalIdentity = buildPlanApprovalIdentity(artifacts);

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
          title: "E2E Plan Flow",
          date: new Date(now).toISOString(),
          active: true,
          messages: [],
        },
      ],
    },
    currentSessionId: sessionId,
    harnessRunMarker: {
      schemaVersion: 1,
      runId: reviewRunId,
      instanceId: "e2e-plan-flow-instance",
      sessionKey: `${workspace}:${sessionId}`,
      workspace,
      sessionId,
      turnId,
      status: "paused",
      workflowMode: "plan",
      runtimeIntent: "plan",
      planStage: "design",
      isPlanApproved: false,
      iteration: 1,
      maxIterations: 12,
      messagesLen: 2,
      toolCount: 0,
      latestTool: null,
      latestToolTarget: null,
      activeStreamId: null,
      streamStatus: "closed",
      streamChunkCount: 0,
      streamByteCount: 0,
      streamElapsedMs: 0,
      streamLifecycleStatus: "completed",
      lastStreamError: null,
      startedAt: now - 1_000,
      updatedAt: now,
      closedAt: now,
      closeReason: "plan_review_required",
    },
    activeActionRequest: approvalIdentity
      ? buildPlanReviewActionRequest({
          sessionKey: `${workspace}:${sessionId}`,
          turnId,
          runId: reviewRunId,
          title: "计划审批回归流",
          planRevision: approvalIdentity.revision,
          artifactHash: approvalIdentity.artifactHash,
          artifactPaths: approvalIdentity.artifactPaths,
          now,
        })
      : null,
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
          "1. 先补齐 `plan.md`。",
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
  const workspace = "/tmp/e2e-plan-quick-reply-approval";
  const sessionId = 999030;
  const now = Date.now();
  const userBlockId = useAppStore.getState()._nextTaskId();
  const agentBlockId = useAppStore.getState()._nextTaskId();
  const runId = "run-e2e-plan-quick-reply-approval";
  const optionValues = [
    "批准执行：先运行诊断脚本，再根据结果修复字体加载",
    "继续调整方案，不进入执行",
  ];
  const choiceRequest = {
    ...buildUserChoiceActionRequest({
      sessionKey: `${workspace}:${sessionId}`,
      turnId,
      runId,
      title: "计划 Quick Reply 审批",
      optionValues,
      allowCustomReply: true,
      now,
    }),
    requestId: "request-e2e-plan-quick-reply-approval",
  };

  useAppStore.setState((state) => ({
    ...state,
    config: {
      ...state.config,
      language: "zh",
      workflowMode: "plan",
    },
    currentWorkspace: workspace,
    sessionsByWorkspace: {
      [workspace]: [{
        id: sessionId,
        title: "E2E Plan Quick Reply Approval",
        date: new Date(now).toISOString(),
        active: true,
        messages: [],
      }],
    },
    currentSessionId: sessionId,
    harnessRunMarker: buildE2EPausedActionOwner({
      workspace,
      sessionId,
      turnId,
      runId,
      workflowMode: "plan",
      runtimeIntent: "plan",
      planStage: "design",
      isPlanApproved: false,
      closeReason: "awaiting_user_choice",
      now,
    }),
    activeActionRequest: choiceRequest,
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
            label: "继续调整方案，不进入执行",
            value: "继续调整方案，不进入执行",
          },
        ],
        choiceRequest,
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
        path: ".MAIN/plans/plan.md",
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

function seedPlanQuickReplyMaterializeScenario(modelStyle: "gemma" | "qwen") {
  const bridge = getBridge();
  if (!bridge) return undefined;

  bridge.events = [{ type: "boot" }];
  bridge.savedDocuments = [];
  bridge.completed = false;

  const turnId = `e2e-plan-quick-reply-materialize-${modelStyle}-turn`;
  const workspace = `/tmp/e2e-plan-quick-reply-materialize-${modelStyle}`;
  const sessionId = modelStyle === "gemma" ? 999031 : 999032;
  const now = Date.now();
  const userBlockId = useAppStore.getState()._nextTaskId();
  const agentBlockId = useAppStore.getState()._nextTaskId();
  const runId = `run-e2e-plan-quick-reply-materialize-${modelStyle}`;
  const optionValues = [
    "我批准按上面的方案开始真实操作，请复用上一轮方案，不要重新规划，直接执行并验证",
    "继续调整上面的方案，暂不执行真实操作",
  ];
  const choiceRequest = {
    ...buildUserChoiceActionRequest({
      sessionKey: `${workspace}:${sessionId}`,
      turnId,
      runId,
      title: `${modelStyle} 计划物化 Quick Reply`,
      optionValues,
      allowCustomReply: true,
      now,
    }),
    requestId: `request-e2e-plan-quick-reply-materialize-${modelStyle}`,
  };
  const agentContent = modelStyle === "gemma"
    ? [
        "## 修复方案",
        "",
        "### 目标与约束",
        "- 目标：修复 MAIN Plan 模式中 Gemma4 普通方案没有落成 plan.md 的问题。",
        "- 约束：批准前只能写 `.MAIN/plans/plan.md`，不能修改源码。",
        "",
        "### 当前发现",
        "- `hasStructuredProposal:false` 时仍然出现 approve_operation_once。",
        "- 用户点击批准后不应进入普通 execute/edit。",
        "",
        "### 实施步骤",
        "1. 更新 `src/lib/planMaterialization.ts` 识别普通 Markdown 方案。",
        "2. 更新 `src/lib/orchestrator.ts` 在暂停审批前先自动物化方案。",
        "3. 更新 `src/App.tsx` 让 quick reply 进入 approvePlan。",
        "",
        "### 数据流与控制流",
        "- ChatArea 方案文本 -> 自动写入 `.MAIN/plans/plan.md` -> Plan Review -> approvePlan。",
        "",
        "### 风险与注意事项",
        "- 低质量聊天不得落盘。",
        "- 普通聊天的一次性执行审批继续保留。",
        "",
        "### 验证方式",
        "- 使用 E2E 点击批准，验证已生成 plan.md，且状态进入 `isPlanApproved:true` 和 `planStage:executing`。",
      ].join("\n")
    : [
        "### 目标",
        "- 修复 Qwen 直接输出方案与选项时，计划文件没有落盘的问题。",
        "",
        "### 方案",
        "- 修改 `src/lib/replyOptions.ts` 识别 proposal_follow_up。",
        "- 修改 `src/lib/planControl.ts` 区分 materialize_then_approve。",
        "- 修改 `src/App.tsx` 在批准前写入 `.MAIN/plans/plan.md`。",
        "",
        "### 执行顺序",
        "1. 先物化可见方案。",
        "2. 再调用 approvePlan。",
        "3. 最后进入 executing 并保留 Browser/Playwright 验证能力。",
        "",
        "### 数据流",
        "- 可见 Qwen 方案 -> materializePlanArtifactFromVisibleText -> plan.md -> approvePlan。",
        "",
        "### 风险与边界",
        "- 不写模型名分支，只按输出形态判断。",
        "- 物化失败时阻断执行。",
        "",
        "### 验证方式",
        "- 使用 E2E 点击批准，验证已生成 plan.md 并进入执行状态。",
      ].join("\n");

  useAppStore.setState((state) => ({
    ...state,
    config: {
      ...state.config,
      language: "zh",
      workflowMode: "plan",
    },
    currentWorkspace: workspace,
    sessionsByWorkspace: {
      [workspace]: [{
        id: sessionId,
        title: `E2E ${modelStyle} Plan Materialization`,
        date: new Date(now).toISOString(),
        active: true,
        messages: [],
      }],
    },
    currentSessionId: sessionId,
    harnessRunMarker: buildE2EPausedActionOwner({
      workspace,
      sessionId,
      turnId,
      runId,
      workflowMode: "plan",
      runtimeIntent: "plan",
      planStage: "idle",
      isPlanApproved: false,
      closeReason: "awaiting_user_choice",
      now,
    }),
    activeActionRequest: choiceRequest,
    taskFlow: [
      { id: userBlockId, turnId, type: "user", content: `请用 ${modelStyle} 风格先规划，批准后再执行。` },
      {
        id: agentBlockId,
        turnId,
        type: "agent",
        content: agentContent,
        options: [
          {
            label: "批准执行本轮操作",
            value: "我批准按上面的方案开始真实操作，请复用上一轮方案，不要重新规划，直接执行并验证",
            action: "approve_operation_once" as const,
            source: "proposal_follow_up" as const,
          },
          {
            label: "继续调整方案",
            value: "继续调整上面的方案，暂不执行真实操作",
            action: "adjust_plan" as const,
            source: "proposal_follow_up" as const,
          },
        ],
        choiceRequest,
        streaming: false,
      },
    ],
    conversationTurns: [
      {
        id: turnId,
        userPrompt: `请用 ${modelStyle} 风格先规划，批准后再执行。`,
        title: `${modelStyle} 计划物化 Quick Reply`,
        mode: "plan",
        intent: "plan",
        status: "awaiting_input",
        summary: "等待用户批准执行。",
        blockIds: [userBlockId, agentBlockId],
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
    planApprovalChoice: null,
    currentTurnExecutionConsent: { turnId: null, granted: false },
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

  bindBridgeSnapshot(modelStyle === "gemma"
    ? PLAN_QUICK_REPLY_MATERIALIZE_GEMMA_SCENARIO
    : PLAN_QUICK_REPLY_MATERIALIZE_QWEN_SCENARIO);

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
  const hasExistingState = hasReloadResumeState(workspace, sessionId);
  const hadSeededBefore = readSeedCount(PLAN_RELOAD_RESUME_SCENARIO) > 0;

  if (!hasExistingState) {
    const turnId = "e2e-plan-reload-turn";
    const userBlockId = useAppStore.getState()._nextTaskId();
    const agentBlockId = useAppStore.getState()._nextTaskId();

    if (!hadSeededBefore) {
      incrementSeedCount(PLAN_RELOAD_RESUME_SCENARIO);
    }

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
          path: ".MAIN/plans/plan.md",
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

    appendBridgeEvent(hadSeededBefore ? "restored" : "seeded", {
      seedCount: readSeedCount(PLAN_RELOAD_RESUME_SCENARIO),
    });
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
  const workspace = "/tmp/e2e-awaiting-choice";
  const runId = "run-e2e-awaiting-choice";
  const request = {
    ...buildUserChoiceActionRequest({
      sessionKey: `${workspace}:${sessionId}`,
      turnId,
      runId,
      title: "等待用户选择回归流",
      optionValues: ["先修暂停等待选择，再补 UI 状态", "先补 UI 状态，再回头修暂停逻辑"],
      allowCustomReply: true,
      now,
    }),
    requestId: "request-e2e-awaiting-choice",
  };

  useAppStore.setState((state) => ({
    ...state,
    config: {
      ...state.config,
      language: "zh",
      workflowMode: "plan",
    },
    currentWorkspace: workspace,
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
    harnessRunMarker: {
      schemaVersion: 1,
      runId,
      parentRunId: null,
      instanceId: "e2e-awaiting-choice-instance",
      sessionKey: `${workspace}:${sessionId}`,
      workspace,
      sessionId,
      turnId,
      status: "paused",
      workflowMode: "plan",
      runtimeIntent: "plan",
      planStage: "design",
      isPlanApproved: false,
      iteration: 2,
      maxIterations: 12,
      messagesLen: 3,
      toolCount: 0,
      latestTool: null,
      latestToolTarget: null,
      activeStreamId: null,
      streamStatus: "closed",
      streamChunkCount: 0,
      streamByteCount: 0,
      streamElapsedMs: 0,
      streamLifecycleStatus: "completed",
      lastStreamError: null,
      startedAt: now - 1_000,
      updatedAt: now,
      closedAt: now,
      closeReason: "awaiting_user_choice",
    },
    activeActionRequest: request,
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
        choiceRequest: request,
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
        path: ".MAIN/plans/plan.md",
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

function seedAwaitingChoiceMixedOptionsScenario() {
  const bridge = getBridge();
  if (!bridge) return undefined;

  bridge.events = [{ type: "boot" }];
  bridge.savedDocuments = [];
  bridge.completed = false;

  const turnId = "e2e-awaiting-choice-mixed-options-turn";
  const sessionId = 999028;
  const now = Date.now();
  const userBlockId = useAppStore.getState()._nextTaskId();
  const agentBlockId = useAppStore.getState()._nextTaskId();
  const workspace = "/tmp/e2e-awaiting-choice-mixed-options";
  const runId = "run-e2e-awaiting-choice-mixed";
  const optionValues = [
    "先确认代码主逻辑，再决定是否改动",
    "我来确认类型，然后执行修复",
    "继续调整上面的方案，暂不执行真实操作",
    "取消上面的执行操作，本轮到此为止",
    "先确认渲染层，再回头看业务逻辑",
    "请继续当前只读读取。",
    "本会话只读读取、搜索和分析步骤全部允许。",
  ];
  const choiceRequest = {
    ...buildUserChoiceActionRequest({
      sessionKey: `${workspace}:${sessionId}`,
      turnId,
      runId,
      title: "混合选项分区",
      optionValues,
      allowCustomReply: true,
      now,
    }),
    requestId: "request-e2e-awaiting-choice-mixed",
  };

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
          title: "E2E Awaiting Choice Mixed",
          date: new Date(now).toISOString(),
          active: true,
          messages: [],
        },
      ],
    },
    currentSessionId: sessionId,
    harnessRunMarker: buildE2EPausedActionOwner({
      workspace,
      sessionId,
      turnId,
      runId,
      workflowMode: "plan",
      runtimeIntent: "plan",
      planStage: "design",
      isPlanApproved: false,
      closeReason: "awaiting_user_choice",
      now,
    }),
    activeActionRequest: choiceRequest,
    taskFlow: [
      { id: userBlockId, turnId, type: "user", content: "请告诉我下一步该怎么处理。" },
      {
        id: agentBlockId,
        turnId,
        type: "agent",
        content: "这里有真实分叉和只读授权动作，请先选择。",
        streaming: false,
        options: [
          { label: "先确认代码主逻辑，再决定是否改动", value: "先确认代码主逻辑，再决定是否改动" },
          { label: "我来确认类型，然后执行修复", value: "我来确认类型，然后执行修复", action: "approve_operation_once", source: "explicit_user_options" },
          { label: "继续调整方案", value: "继续调整上面的方案，暂不执行真实操作", action: "adjust_plan", source: "explicit_user_options" },
          { label: "取消操作", value: "取消上面的执行操作，本轮到此为止", action: "cancel_operation", source: "explicit_user_options" },
          { label: "先确认渲染层，再回头看业务逻辑", value: "先确认渲染层，再回头看业务逻辑" },
          { label: "继续当前只读读取", value: "请继续当前只读读取。", action: "continue_readonly_once" },
          { label: "当前会话只读步骤全部批准", value: "本会话只读读取、搜索和分析步骤全部允许。", action: "allow_readonly_session" },
        ],
        choiceRequest,
      },
    ],
    conversationTurns: [
      {
        id: turnId,
        userPrompt: "请告诉我下一步该怎么处理。",
        title: "混合选项分区",
        mode: "plan",
        status: "awaiting_input",
        summary: "等待用户选择真实分叉或授权动作。",
        blockIds: [userBlockId, agentBlockId],
        collapsed: false,
        createdAt: now,
      },
    ],
    currentTurnId: turnId,
    planArtifacts: [],
    planTasks: [],
    planExecutionEvidenceLedger: [],
    planStage: "design",
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

  bindBridgeSnapshot(AWAITING_CHOICE_MIXED_OPTIONS_SCENARIO);
  appendBridgeEvent("choice-requested-mixed");

  const cleanup = () => {
    bridge.initialized = false;
  };

  bridge.cleanup = cleanup;
  return cleanup;
}

function seedAwaitingChoiceDiagnosticRejectedScenario() {
  const bridge = getBridge();
  if (!bridge) return undefined;

  bridge.events = [{ type: "boot" }];
  bridge.savedDocuments = [];
  bridge.completed = false;

  const turnId = "e2e-awaiting-choice-diagnostic-rejected-turn";
  const sessionId = 999007;
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
    currentWorkspace: "/tmp/e2e-awaiting-choice-diagnostic-rejected",
    sessionsByWorkspace: {
      "/tmp/e2e-awaiting-choice-diagnostic-rejected": [
        {
          id: sessionId,
          title: "E2E Diagnostic Options Rejected",
          date: new Date(now).toISOString(),
          active: true,
          messages: [],
        },
      ],
    },
    currentSessionId: sessionId,
    taskFlow: [
      { id: userBlockId, turnId, type: "user", content: "检查为什么样式没有生效。" },
      {
        id: agentBlockId,
        turnId,
        type: "agent",
        content: "请选择：\n\n1. 那问题可能出在 Vite 的构建过程中\n2. `App.css` 被自动引入了",
        streaming: false,
        options: [],
      },
    ],
    conversationTurns: [
      {
        id: turnId,
        userPrompt: "检查为什么样式没有生效。",
        title: "诊断陈述不应变成选项",
        mode: "chat",
        status: "stopped_no_action",
        summary: "诊断陈述被保留为文本，不显示为可点击分叉。",
        blockIds: [userBlockId, agentBlockId],
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

  bindBridgeSnapshot(AWAITING_CHOICE_DIAGNOSTIC_REJECTED_SCENARIO);

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
  const singleReadBlockId = useAppStore.getState()._nextTaskId();
  const agentAfterSingleReadBlockId = useAppStore.getState()._nextTaskId();
  const taskFlow: any[] = [
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
    {
      id: singleReadBlockId,
      turnId,
      type: "tool" as const,
      toolName: "read_file",
      target: "README.md",
      status: "done",
      toolStatus: "executed" as const,
      message: "OK",
    },
    {
      id: agentAfterSingleReadBlockId,
      turnId,
      type: "agent" as const,
      content: "补充读取了 README 作为单项上下文，用于校验单项也能折叠。",
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

function seedReadContextInterleavedScenario() {
  const bridge = getBridge();
  if (!bridge) return undefined;

  bridge.events = [{ type: "boot" }];
  bridge.savedDocuments = [];
  bridge.completed = true;

  const turnId = "e2e-read-context-interleaved-turn";
  const sessionId = 999026;
  const now = Date.now();
  const userBlockId = useAppStore.getState()._nextTaskId();
  const taskFlow: any[] = [
    { id: userBlockId, turnId, type: "user" as const, content: "读取并搜索后执行几条命令，继续总结。" },
    {
      id: useAppStore.getState()._nextTaskId(),
      turnId,
      type: "tool" as const,
      toolName: "read_file",
      target: "package.json",
      status: "done",
      toolStatus: "executed" as const,
      message: "OK",
    },
    {
      id: useAppStore.getState()._nextTaskId(),
      turnId,
      type: "tool" as const,
      toolName: "run_command",
      target: "git status --short --branch",
      status: "done",
      toolStatus: "executed" as const,
      message: "## main",
    },
    {
      id: useAppStore.getState()._nextTaskId(),
      turnId,
      type: "tool" as const,
      toolName: "read_file",
      target: "src/store/useAppStore.ts",
      status: "done",
      toolStatus: "executed" as const,
      message: "OK",
    },
    {
      id: useAppStore.getState()._nextTaskId(),
      turnId,
      type: "tool" as const,
      toolName: "execute_command",
      target: "npm run build -- --mode test",
      status: "done",
      toolStatus: "executed" as const,
      message: "Build done",
    },
    {
      id: useAppStore.getState()._nextTaskId(),
      turnId,
      type: "tool" as const,
      toolName: "glob_search",
      target: "**/*release*.md",
      status: "done",
      toolStatus: "executed" as const,
      message: "OK",
    },
    {
      id: useAppStore.getState()._nextTaskId(),
      turnId,
      type: "agent" as const,
      content: "读取与命令交错完成，命令步骤已折叠保留。",
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
    currentWorkspace: "/tmp/e2e-read-context-interleaved",
    sessionsByWorkspace: {
      "/tmp/e2e-read-context-interleaved": [
        {
          id: sessionId,
          title: "E2E Read Context Interleaved",
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
        userPrompt: "读取并搜索后执行几条命令，继续总结。",
        title: "读搜命令交错",
        mode: "edit" as const,
        status: "done" as const,
        summary: "读搜与命令交错执行完成。",
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

  bindBridgeSnapshot(READ_CONTEXT_INTERLEAVED_SCENARIO);
  appendBridgeEvent("seeded", { seedCount: readSeedCount(READ_CONTEXT_INTERLEAVED_SCENARIO) });

  const cleanup = () => {
    bridge.initialized = false;
  };

  bridge.cleanup = cleanup;
  return cleanup;
}

function seedReadContextAgentSegmentScenario() {
  const bridge = getBridge();
  if (!bridge) return undefined;

  bridge.events = [{ type: "boot" }];
  bridge.savedDocuments = [];
  bridge.completed = true;

  const turnId = "e2e-read-context-agent-segment-turn";
  const sessionId = 999027;
  const now = Date.now();
  const userBlockId = useAppStore.getState()._nextTaskId();
  const taskFlow: any[] = [
    { id: userBlockId, turnId, type: "user" as const, content: "分两段读取上下文并在中间输出一次结论。" },
    {
      id: useAppStore.getState()._nextTaskId(),
      turnId,
      type: "tool" as const,
      toolName: "read_file",
      target: "src/components/ChatArea.tsx",
      status: "done",
      toolStatus: "executed" as const,
      message: "OK",
    },
    {
      id: useAppStore.getState()._nextTaskId(),
      turnId,
      type: "tool" as const,
      toolName: "glob_search",
      target: "src/**/*.tsx",
      status: "done",
      toolStatus: "executed" as const,
      message: "OK",
    },
    {
      id: useAppStore.getState()._nextTaskId(),
      turnId,
      type: "agent" as const,
      content: [
        "阶段性结论：第一段读取确认 ChatArea 会把读取记录按正文边界分段。",
        "这说明上下文没有丢失；后续只需要核对 README 中的展示约束。",
      ].join("\n\n"),
      streaming: false,
    },
    {
      id: useAppStore.getState()._nextTaskId(),
      turnId,
      type: "tool" as const,
      toolName: "read_document",
      target: "README.md",
      status: "done",
      toolStatus: "executed" as const,
      message: "OK",
    },
    {
      id: useAppStore.getState()._nextTaskId(),
      turnId,
      type: "agent" as const,
      content: "第二段读取完成。",
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
    currentWorkspace: "/tmp/e2e-read-context-agent-segment",
    sessionsByWorkspace: {
      "/tmp/e2e-read-context-agent-segment": [
        {
          id: sessionId,
          title: "E2E Read Context Agent Segment",
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
        userPrompt: "分两段读取上下文并在中间输出一次结论。",
        title: "读搜按正文断段",
        mode: "edit" as const,
        status: "done" as const,
        summary: "中间正文把读取段落切开。",
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

  bindBridgeSnapshot(READ_CONTEXT_AGENT_SEGMENT_SCENARIO);
  appendBridgeEvent("seeded", { seedCount: readSeedCount(READ_CONTEXT_AGENT_SEGMENT_SCENARIO) });

  const cleanup = () => {
    bridge.initialized = false;
  };

  bridge.cleanup = cleanup;
  return cleanup;
}

function seedReadContextThinNarrationScenario() {
  const bridge = getBridge();
  if (!bridge) return undefined;

  bridge.events = [{ type: "boot" }];
  bridge.savedDocuments = [];
  bridge.completed = true;

  const turnId = "e2e-read-context-thin-narration-turn";
  const sessionId = 999029;
  const now = Date.now();
  const nextId = () => useAppStore.getState()._nextTaskId();
  const userBlockId = nextId();
  const taskFlow: any[] = [
    { id: userBlockId, turnId, type: "user" as const, content: "根据截图说明问题，然后继续读取三个关键文件。" },
    {
      id: nextId(),
      turnId,
      type: "agent" as const,
      content: [
        "根据截图观察到的现象：",
        "",
        "图1（深色模式）：左侧导航是深色背景，右侧订单列表表格可见，但整体视觉像是白色背景简单反色。",
        "",
        "核心问题映射：CSV 数据已加载，但面板统计和图表未渲染，需要检查数据解析、状态管理和图表绑定。",
      ].join("\n"),
      streaming: false,
    },
    {
      id: nextId(),
      turnId,
      type: "agent" as const,
      content: "让我继续读取关键文件来确认问题根因。",
      streaming: false,
    },
    {
      id: nextId(),
      turnId,
      type: "tool" as const,
      toolName: "read_file",
      target: "src/App.tsx",
      status: "done",
      toolStatus: "executed" as const,
      message: "OK",
    },
    {
      id: nextId(),
      turnId,
      type: "tool" as const,
      toolName: "read_file",
      target: "src/components/Dashboard/OverviewCards.tsx",
      status: "done",
      toolStatus: "executed" as const,
      message: "OK",
    },
    {
      id: nextId(),
      turnId,
      type: "tool" as const,
      toolName: "read_file",
      target: "src/components/Dashboard/CourseBarChart.tsx",
      status: "done",
      toolStatus: "executed" as const,
      message: "OK",
    },
    {
      id: nextId(),
      turnId,
      type: "agent" as const,
      content: "让我继续读取关键文件来确认问题根因。",
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
    currentWorkspace: "/tmp/e2e-read-context-thin-narration",
    sessionsByWorkspace: {
      "/tmp/e2e-read-context-thin-narration": [
        {
          id: sessionId,
          title: "E2E Thin Read Narration",
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
        userPrompt: "根据截图说明问题，然后继续读取三个关键文件。",
        title: "读取叙述透明折叠",
        mode: "edit" as const,
        status: "done" as const,
        summary: "薄工具叙述不打断读取折叠。",
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

  bindBridgeSnapshot(READ_CONTEXT_THIN_NARRATION_SCENARIO);
  appendBridgeEvent("seeded", { seedCount: readSeedCount(READ_CONTEXT_THIN_NARRATION_SCENARIO) });

  const cleanup = () => {
    bridge.initialized = false;
  };

  bridge.cleanup = cleanup;
  return cleanup;
}

function seedReadContextPersistentProgressScenario() {
  const bridge = getBridge();
  if (!bridge) return undefined;

  bridge.events = [{ type: "boot" }];
  bridge.savedDocuments = [];
  bridge.completed = true;

  const planTurnId = "e2e-read-context-persistent-plan-turn";
  const followupTurnId = "e2e-read-context-persistent-followup-turn";
  const sessionId = 999028;
  const now = Date.now();
  const nextId = () => useAppStore.getState()._nextTaskId();
  const planUserBlockId = nextId();
  const readOneBlockId = nextId();
  const duplicateReadBlockId = nextId();
  const readTwoBlockId = nextId();
  const planWriteBlockId = nextId();
  const planAgentBlockId = nextId();
  const followupUserBlockId = nextId();
  const followupAgentBlockId = nextId();
  const taskFlow: any[] = [
    {
      id: planUserBlockId,
      turnId: planTurnId,
      type: "user" as const,
      content: "先读取关键文件并生成可审批计划，批准前不要改源码。",
    },
    {
      id: readOneBlockId,
      turnId: planTurnId,
      type: "tool" as const,
      toolName: "read_file",
      target: "src/store/dashboardStore.ts",
      status: "done",
      toolStatus: "executed" as const,
      observationSummary: "确认 Dashboard 指标和导入状态入口。",
      message: "OK",
    },
    {
      id: duplicateReadBlockId,
      turnId: planTurnId,
      type: "tool" as const,
      toolName: "read_file",
      target: "src/store/dashboardStore.ts",
      status: "done",
      toolStatus: "executed" as const,
      message: "FILE_UNCHANGED_STUB: src/store/dashboardStore.ts",
    },
    {
      id: readTwoBlockId,
      turnId: planTurnId,
      type: "tool" as const,
      toolName: "read_file",
      target: "src/hooks/useCsvParser.ts",
      status: "done",
      toolStatus: "executed" as const,
      observationSummary: "确认 CSV 解析输出记录结构。",
      message: "OK",
    },
    {
      id: planWriteBlockId,
      turnId: planTurnId,
      type: "tool" as const,
      toolName: "write_file",
      target: ".MAIN/plans/plan.md",
      status: "done",
      toolStatus: "executed" as const,
      message: "Wrote .MAIN/plans/plan.md",
    },
    {
      id: planAgentBlockId,
      turnId: planTurnId,
      type: "agent" as const,
      content: "我已经生成了可审批计划文件 .MAIN/plans/plan.md，现在停在审批阶段。请审阅右侧计划面板，确认后再进入执行。",
      streaming: false,
    },
    {
      id: followupUserBlockId,
      turnId: followupTurnId,
      type: "user" as const,
      content: "这是一条后续消息，用来确认上一轮进展不会被刷新掉。",
    },
    {
      id: followupAgentBlockId,
      turnId: followupTurnId,
      type: "agent" as const,
      content: "后续消息已显示；上一轮工具记录仍保留在折叠上下文分组中。",
      streaming: false,
    },
  ];

  useAppStore.setState((state) => ({
    ...state,
    config: {
      ...state.config,
      language: "zh",
      workflowMode: "plan",
    },
    currentWorkspace: "/tmp/e2e-read-context-persistent-progress",
    sessionsByWorkspace: {
      "/tmp/e2e-read-context-persistent-progress": [
        {
          id: sessionId,
          title: "E2E Read Context Persistent Progress",
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
        id: planTurnId,
        userPrompt: "先读取关键文件并生成可审批计划，批准前不要改源码。",
        title: "计划进展保留",
        mode: "plan" as const,
        intent: "plan" as const,
        status: "awaiting_approval" as const,
        summary: "已生成计划并等待审批。",
        blockIds: [planUserBlockId, readOneBlockId, duplicateReadBlockId, readTwoBlockId, planWriteBlockId, planAgentBlockId],
        collapsed: false,
        createdAt: now,
      },
      {
        id: followupTurnId,
        userPrompt: "这是一条后续消息，用来确认上一轮进展不会被刷新掉。",
        title: "后续消息",
        mode: "chat" as const,
        intent: "respond" as const,
        status: "done" as const,
        summary: "确认上一轮进展仍保留。",
        blockIds: [followupUserBlockId, followupAgentBlockId],
        collapsed: false,
        createdAt: now + 1,
      },
    ],
    currentTurnId: followupTurnId,
    planStage: "ready_to_execute",
    isPlanApproved: false,
    planArtifacts: [
      {
        kind: "design" as const,
        path: ".MAIN/plans/plan.md",
        title: "Plan",
        updatedAt: now,
        content: "# 计划\n\n## 用户目标\n- 先读取关键文件并生成可审批计划，批准前不要改源码。\n\n## 已读证据\n- src/store/dashboardStore.ts\n- src/hooks/useCsvParser.ts\n\n## 执行步骤\n1. 基于已读证据收窄修改点。\n2. 批准后实施最小源码变更。\n\n## 验证标准\n- 运行聚焦测试并确认 Dashboard 指标更新。",
      },
    ],
    planTasks: [],
    planExecutionEvidenceLedger: [],
    agentStatus: "idle",
    isGenerating: false,
    showPlanPanel: false,
    showDiff: false,
    showTerminal: false,
    showFilePanel: false,
  }));

  bindBridgeSnapshot(READ_CONTEXT_PERSISTENT_PROGRESS_SCENARIO);
  appendBridgeEvent("seeded", { seedCount: readSeedCount(READ_CONTEXT_PERSISTENT_PROGRESS_SCENARIO) });

  const cleanup = () => {
    bridge.initialized = false;
  };

  bridge.cleanup = cleanup;
  return cleanup;
}

function seedOpencodeTranscriptDisplayScenario() {
  const bridge = getBridge();
  if (!bridge) return undefined;

  bridge.events = [{ type: "boot" }];
  bridge.savedDocuments = [];
  bridge.completed = false;

  const workspace = "/tmp/e2e-opencode-transcript-display";
  const sessionId = 999041;
  const now = Date.now();

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
          title: "E2E opencode transcript display",
          date: new Date(now).toISOString(),
          active: true,
          messages: [],
        },
      ],
    },
    currentSessionId: sessionId,
    taskFlow: [],
    conversationTurns: [],
    currentTurnId: null,
    agentStatus: "idle",
    isGenerating: false,
    isPlanApproved: false,
    planStage: "idle",
    showPlanPanel: false,
    showDiff: false,
    showTerminal: false,
    showFilePanel: false,
  }));

  bridge.sendOpencodeTranscriptTestContent = (text: string) => {
    const state = useAppStore.getState();
    const turnId = "e2e-opencode-transcript-turn";
    const createdAt = Date.now();
    const nextId = () => useAppStore.getState()._nextTaskId();
    const taskFlow: any[] = [
      {
        id: nextId(),
        turnId,
        type: "user" as const,
        content: text,
      },
      {
        id: nextId(),
        turnId,
        type: "agent" as const,
        content: "我会先整体理解项目结构，然后读取 ChatArea、工具分组和 Plan runtime 的关键链路。",
        streaming: false,
      },
      {
        id: nextId(),
        turnId,
        type: "tool" as const,
        toolName: "get_project_skeleton",
        target: "",
        status: "done",
        toolStatus: "executed" as const,
        message: "src/, tests/, src-tauri/",
        observationSummary: "捕获项目结构入口。",
      },
      {
        id: nextId(),
        turnId,
        type: "agent" as const,
        content: "让我继续读取关键文件来确认渲染结构。",
        streaming: false,
      },
      {
        id: nextId(),
        turnId,
        type: "tool" as const,
        toolName: "read_file",
        target: "src/components/ChatArea.tsx",
        status: "done",
        toolStatus: "executed" as const,
        message: "OK",
        observationSummary: "读取 ChatArea 渲染入口。",
      },
      {
        id: nextId(),
        turnId,
        type: "tool" as const,
        toolName: "read_file",
        target: "src/lib/toolUiGrouping.ts",
        status: "done",
        toolStatus: "executed" as const,
        message: "OK",
        observationSummary: "读取工具 UI 分组逻辑。",
      },
      {
        id: nextId(),
        turnId,
        type: "tool" as const,
        toolName: "read_file",
        target: "src/lib/planRuntime.ts",
        status: "done",
        toolStatus: "executed" as const,
        message: "OK",
        observationSummary: "读取 Plan runtime 阶段逻辑。",
      },
      {
        id: nextId(),
        turnId,
        type: "agent" as const,
        content: "让我继续读取关键文件来确认渲染结构。",
        streaming: false,
      },
      {
        id: nextId(),
        turnId,
        type: "agent" as const,
        content: "从已读取的文件中，我发现显示层需要先生成 operation cluster，再交给 ChatArea 渲染；Plan 模式也需要先进入 Explore 项目结构阶段。",
        streaming: false,
      },
    ];

    useAppStore.setState((current) => ({
      ...current,
      taskFlow,
      conversationTurns: [
        {
          id: turnId,
          userPrompt: text,
          title: "opencode transcript 渲染回归",
          mode: "plan" as const,
          status: "done" as const,
          summary: "已验证 opencode 风格 transcript 渲染。",
          blockIds: taskFlow.map((block) => block.id),
          collapsed: false,
          createdAt,
        },
      ],
      currentTurnId: turnId,
      agentStatus: "idle",
      isGenerating: false,
      currentWorkspace: workspace,
      currentSessionId: sessionId,
    }));
    appendBridgeEvent("sent_opencode_transcript_test", { text });
    return {
      taskFlowBlocks: taskFlow.length,
      turnId,
      previousTurns: state.conversationTurns.length,
    };
  };

  bindBridgeSnapshot(OPENCODE_TRANSCRIPT_DISPLAY_SCENARIO);
  appendBridgeEvent("seeded", { seedCount: readSeedCount(OPENCODE_TRANSCRIPT_DISPLAY_SCENARIO) });

  const cleanup = () => {
    bridge.initialized = false;
  };

  bridge.cleanup = cleanup;
  return cleanup;
}

function seedProcessDisplayScenario() {
  const bridge = getBridge();
  if (!bridge) return undefined;

  bridge.events = [{ type: "boot" }];
  bridge.savedDocuments = [];
  bridge.completed = true;

  incrementSeedCount(PROCESS_DISPLAY_SCENARIO);

  const now = Date.now();
  const turnId = "e2e-process-display-turn";
  const sessionId = 999018;
  const userBlockId = useAppStore.getState()._nextTaskId();
  const thoughtBlockId = useAppStore.getState()._nextTaskId();
  const latestThoughtBlockId = useAppStore.getState()._nextTaskId();
  const toolBlockId = useAppStore.getState()._nextTaskId();
  const agentBlockId = useAppStore.getState()._nextTaskId();

  useAppStore.setState((state) => ({
    ...state,
    config: {
      ...state.config,
      language: "zh",
      workflowMode: "chat",
      reasoningDisplay: "debug_summary",
    },
    currentWorkspace: "/tmp/e2e-process-display",
    sessionsByWorkspace: {
      "/tmp/e2e-process-display": [
        {
          id: sessionId,
          title: "E2E Process Display",
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
      { id: userBlockId, turnId, type: "user", content: "验证过程显示。" },
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
          "下一步会确认过程显示始终按正常摘要处理，并避免原始长文本刷屏。",
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
        id: latestThoughtBlockId,
        turnId,
        type: "thought",
        content: [
          "阶段性结论：设置项检查已经完成。",
          "验证结果确认，有用的思考摘要应在流式结束后继续保留。",
        ].join("\n\n"),
        isStreaming: false,
        duration: 1,
      },
      {
        id: toolBlockId,
        turnId,
        type: "tool",
        toolName: "read_file",
        target: "src/components/ChatArea.tsx",
        status: "done",
        toolStatus: "executed",
        message: "OK",
      },
      {
        id: agentBlockId,
        turnId,
        type: "agent",
        content: "过程显示测试回复。",
        streaming: false,
      },
    ],
    conversationTurns: [
      {
        id: turnId,
        userPrompt: "验证过程显示。",
        title: "过程显示",
        mode: "chat",
        status: "done",
        summary: "已准备过程显示测试数据。",
        blockIds: [userBlockId, thoughtBlockId, latestThoughtBlockId, toolBlockId, agentBlockId],
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

  bindBridgeSnapshot(PROCESS_DISPLAY_SCENARIO);
  appendBridgeEvent("seeded", { seedCount: readSeedCount(PROCESS_DISPLAY_SCENARIO) });

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
    const commandBlockId = useAppStore.getState()._nextTaskId();
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
          id: commandBlockId,
          turnId,
          type: "tool",
          toolName: "execute_command",
          target: "npm test -- --runInBand",
          status: "executed",
          toolStatus: "executed",
          message: "Tests passed.",
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
          blockIds: [userBlockId, toolBlockIdA, toolBlockIdB, toolBlockIdC, commandBlockId, agentBlockId],
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
  bridge.notifyWorkspaceContentChanged = () => {
    useAppStore.getState().bumpWorkspaceContentVersion();
  };

  const cleanup = () => {
    delete bridge.notifyWorkspaceContentChanged;
    bridge.initialized = false;
  };

  bridge.cleanup = cleanup;
  return cleanup;
}

function seedLiveEditDiffStepsScenario() {
  const bridge = getBridge();
  if (!bridge) return undefined;

  bridge.events = [{ type: "boot" }];
  bridge.savedDocuments = [];
  bridge.completed = false;

  const workspace = "/tmp/e2e-live-edit-diff-steps";
  const sessionId = 999013;
  const now = Date.now();
  const turnId = "e2e-live-edit-diff-steps-turn";
  const userBlockId = useAppStore.getState()._nextTaskId();
  const toolBlockIdA = useAppStore.getState()._nextTaskId();
  const toolBlockIdB = useAppStore.getState()._nextTaskId();
  const toolBlockIdC = useAppStore.getState()._nextTaskId();

  incrementSeedCount(LIVE_EDIT_DIFF_STEPS_SCENARIO);

  const taskFlow: any[] = [
    {
      id: userBlockId,
      turnId,
      type: "user",
      content: "请继续修复并展示本轮编辑 diff。",
    },
    {
      id: toolBlockIdA,
      turnId,
      type: "tool",
      toolName: "write_file",
      target: "src/main.ts",
      status: "done",
      toolStatus: "executed",
      message: "Updated src/main.ts",
      diff: {
        path: "src/main.ts",
        old: "export const title = 'old';\n",
        new: "export const title = 'new';\nexport const enabled = true;\n",
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
      status: "done",
      toolStatus: "executed",
      message: "Updated src/utils/helper.ts",
      diff: {
        path: "src/utils/helper.ts",
        old: "export const helper = () => 'before';\n",
        new: "export const helper = () => 'after';\n",
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
      status: "done",
      toolStatus: "executed",
      message: "Created src/generated.ts",
      diff: {
        path: "src/generated.ts",
        old: "",
        new: "export const generated = true;\n",
        existed: false,
        fullFile: true,
      },
    },
  ];

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
          title: "E2E Live Edit Diff Steps",
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
        userPrompt: "请继续修复并展示本轮编辑 diff。",
        title: "Live 编辑 diff 步骤",
        mode: "edit",
        status: "executing",
        summary: "正在执行连续编辑。",
        blockIds: taskFlow.map((block) => block.id),
        collapsed: false,
        createdAt: now,
      },
    ],
    currentTurnId: turnId,
    planArtifacts: [],
    planTasks: [],
    planExecutionEvidenceLedger: [],
    planExecutionEvidenceCount: 0,
    isPlanApproved: false,
    showPlanPanel: false,
    showDiff: false,
    showTerminal: false,
    showFilePanel: false,
    selectedDiffTaskId: null,
    agentStatus: "running",
    isGenerating: true,
    abortController: new AbortController(),
  }));

  bindBridgeSnapshot(LIVE_EDIT_DIFF_STEPS_SCENARIO);
  appendBridgeEvent("seeded", { seedCount: readSeedCount(LIVE_EDIT_DIFF_STEPS_SCENARIO) });

  const cleanup = () => {
    const latest = useAppStore.getState();
    latest.abortController?.abort();
    useAppStore.setState({
      abortController: null,
      agentStatus: "idle",
      isGenerating: false,
    });
    bridge.initialized = false;
  };

  bridge.cleanup = cleanup;
  return cleanup;
}

function seedStageConclusionPreservedScenario() {
  const bridge = getBridge();
  if (!bridge) return undefined;

  bridge.events = [{ type: "boot" }];
  bridge.savedDocuments = [];
  bridge.completed = true;

  const workspace = "/tmp/e2e-stage-conclusion";
  const sessionId = 999014;
  const now = Date.now();
  const turnId = "e2e-stage-conclusion-turn";
  const userBlockId = useAppStore.getState()._nextTaskId();
  const readBlockId = useAppStore.getState()._nextTaskId();
  const stageAgentBlockId = useAppStore.getState()._nextTaskId();
  const editBlockId = useAppStore.getState()._nextTaskId();
  const finalAgentBlockId = useAppStore.getState()._nextTaskId();
  const stageText = [
    "阶段性结论：我已经定位到编译错误的根因。",
    "",
    "1. `SnakeData` 缺少 `canvasSize` 和 `pointsPerFood`。",
    "2. `SnakeController` 仍在使用旧的输入常量和渲染方法。",
    "",
    "下一步我会直接修复这些文件并运行验证。",
  ].join("\n");

  const taskFlow: any[] = [
    { id: userBlockId, turnId, type: "user", content: "修复 Unity console 里的编译错误。" },
    {
      id: readBlockId,
      turnId,
      type: "tool",
      toolName: "read_file",
      target: "Assets/Scripts/Entities/SnakeController.cs",
      status: "done",
      toolStatus: "executed",
      message: "OK",
    },
    {
      id: stageAgentBlockId,
      turnId,
      type: "agent",
      content: stageText,
      streaming: false,
    },
    {
      id: editBlockId,
      turnId,
      type: "tool",
      toolName: "replace_in_file",
      target: "Assets/Scripts/Core/SnakeData.cs",
      status: "done",
      toolStatus: "executed",
      message: "Updated SnakeData.cs",
      diff: {
        path: "Assets/Scripts/Core/SnakeData.cs",
        old: "public int gridSize = 20;\n",
        new: "public int gridSize = 20;\npublic int canvasSize = 600;\npublic int pointsPerFood = 10;\n",
        existed: true,
        fullFile: true,
      },
    },
    {
      id: finalAgentBlockId,
      turnId,
      type: "agent",
      content: "已完成当前修复并保留阶段性结论。",
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
    currentWorkspace: workspace,
    sessionsByWorkspace: {
      [workspace]: [
        {
          id: sessionId,
          title: "E2E Stage Conclusion Preserved",
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
        userPrompt: "修复 Unity console 里的编译错误。",
        title: "阶段性结论保留",
        mode: "edit",
        status: "done",
        summary: "已完成当前修复并保留阶段性结论。",
        blockIds: taskFlow.map((block) => block.id),
        collapsed: false,
        createdAt: now,
      },
    ],
    currentTurnId: turnId,
    showPlanPanel: false,
    showDiff: false,
    showTerminal: false,
    showFilePanel: false,
    selectedDiffTaskId: null,
    agentStatus: "idle",
    isGenerating: false,
  }));

  bindBridgeSnapshot(STAGE_CONCLUSION_PRESERVED_SCENARIO);

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
    "| 验证项 | 期望 |",
    "| --- | --- |",
    "| PlanPanel 表格 | light / dark / black 下都渲染为真实表格 |",
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
        path: ".MAIN/plans/plan.md",
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
      "| 验证项 | 期望 |",
      "| --- | --- |",
      "| PlanPanel 表格 | light / dark / black 下都渲染为真实表格 |",
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

function seedExecutionCapsuleExecutionProgressScenario() {
  const bridge = getBridge();
  if (!bridge) return undefined;

  bridge.events = [{ type: "boot" }];
  bridge.savedDocuments = [];
  bridge.completed = false;

  const workspace = "/tmp/e2e-execution-capsule-execution-progress";
  const sessionId = 999601;
  const now = Date.now();
  const turnId = "e2e-execution-capsule-execution-progress-turn";
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
          title: "E2E ExecutionCapsule Execution Progress",
          date: new Date(now).toISOString(),
          active: true,
          messages: [],
        },
      ],
    },
    currentSessionId: sessionId,
    taskFlow: [
      { id: userBlockId, turnId, type: "user", content: "/执行 修改 ExecutionCapsule 执行步骤进度。" },
      {
        id: readBlockId,
        turnId,
        type: "tool",
        toolName: "read_file",
        target: "src/components/ExecutionCapsule.tsx",
        status: "done",
        toolStatus: "executed",
        message: "File read.",
      },
      {
        id: editBlockId,
        turnId,
        type: "tool",
        toolName: "replace_in_file",
        target: "src/components/ExecutionCapsule.tsx",
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
        userPrompt: "/执行 修改 ExecutionCapsule 执行步骤进度。",
        title: "执行步骤进度回归",
        mode: "edit",
        intent: "execute",
        status: "executing",
        summary: "执行模式下 ExecutionCapsule 应展示工具步骤进度。",
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

function seedExecutionCapsulePlanTaskProgressScenario() {
  const bridge = getBridge();
  if (!bridge) return undefined;

  bridge.events = [{ type: "boot" }];
  bridge.savedDocuments = [];
  bridge.completed = false;

  const workspace = "/tmp/e2e-execution-capsule-plan-task-progress";
  const sessionId = 999602;
  const now = Date.now();
  const turnId = "e2e-execution-capsule-plan-task-progress-turn";
  const reviewRunId = "run-e2e-execution-capsule-plan-review";
  const childRunId = "run-e2e-execution-capsule-plan-child";
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
          title: "E2E ExecutionCapsule Plan Task Progress",
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
        summary: "计划执行阶段 ExecutionCapsule 应展示完整任务列表。",
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
    planExecutionProgressSnapshot: {
      turnId,
      runId: childRunId,
      parentRunId: reviewRunId,
      phase: "tool_start",
      currentTask: planTasks[8].text,
      currentTool: "apply_patch · src/task-9.ts",
      latestEvidence: "已完成前 8 项文件修改",
      nextStep: "完成 src/task-9.ts 后运行验证",
      repeatedTargets: [],
      iteration: 9,
      maxIterations: 50,
      autoResumeCount: 0,
      updatedAt: now,
    },
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
    harnessRunMarker: {
      schemaVersion: 1,
      runId: childRunId,
      parentRunId: reviewRunId,
      instanceId: "e2e-execution-capsule-plan-child-instance",
      sessionKey: `${workspace}:${sessionId}`,
      workspace,
      sessionId,
      turnId,
      status: "running",
      workflowMode: "plan",
      runtimeIntent: "execute",
      planStage: "executing",
      isPlanApproved: true,
      iteration: 9,
      maxIterations: 50,
      messagesLen: 12,
      toolCount: 9,
      latestTool: "apply_patch",
      latestToolTarget: "src/task-9.ts",
      activeStreamId: "stream-e2e-execution-capsule-plan-child",
      streamStatus: "tool_running",
      streamChunkCount: 0,
      streamByteCount: 0,
      streamElapsedMs: 0,
      streamLifecycleStatus: "streaming",
      lastStreamError: null,
      startedAt: now - 2_000,
      updatedAt: now,
      closedAt: null,
      closeReason: null,
    },
    runtimeEvents: [
      {
        schemaVersion: MAIN_THREAD_EVENT_SCHEMA_VERSION,
        type: "run.paused" as const,
        threadId: `${workspace}:${sessionId}`,
        turnId,
        timestampMs: now - 1_000,
        runId: reviewRunId,
        parentRunId: null,
        reason: "plan_review",
        message: "计划产物已物化并通过校验，等待审核。",
      },
      {
        schemaVersion: MAIN_THREAD_EVENT_SCHEMA_VERSION,
        type: "progress.updated" as const,
        threadId: `${workspace}:${sessionId}`,
        turnId,
        timestampMs: now - 900,
        runId: reviewRunId,
        parentRunId: null,
        progress: {
          phase: "plan_review",
          title: "旧审核进度",
          status: "paused",
          summary: "计划产物已物化并通过校验，等待审核。",
        },
      },
      {
        schemaVersion: MAIN_THREAD_EVENT_SCHEMA_VERSION,
        type: "progress.updated" as const,
        threadId: `${workspace}:${sessionId}`,
        turnId,
        timestampMs: now,
        runId: childRunId,
        parentRunId: reviewRunId,
        progress: {
          phase: "plan_execution:tool_start",
          title: "正在执行已批准计划",
          status: "running",
          summary: "apply_patch · src/task-9.ts",
          dedupeKey: `plan-execution-progress:${childRunId}`,
        },
      },
    ],
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

function seedExecutionCapsuleStrictEvidenceProgressScenario() {
  const bridge = getBridge();
  if (!bridge) return undefined;

  bridge.events = [{ type: "boot" }];
  bridge.savedDocuments = [];
  bridge.completed = false;

  const workspace = "/tmp/e2e-execution-capsule-strict-evidence-progress";
  const sessionId = 999604;
  const now = Date.now();
  const turnId = "e2e-execution-capsule-strict-evidence-progress-turn";
  const userBlockId = useAppStore.getState()._nextTaskId();
  const planTasks = Array.from({ length: 8 }, (_, index) => {
    const taskNumber = index + 1;
    const filePath = `src/task-${taskNumber}.ts`;
    return {
      id: `strict-plan-task-${taskNumber}`,
      text: taskNumber === 2
        ? `1.1 修复 useTrendData 回退逻辑 — 证据: file:${filePath}`
        : `T${taskNumber}: 更新 ${filePath} — 证据: file:${filePath}`,
      status: taskNumber <= 7 ? "completed" as const : "pending" as const,
      claimedStatus: taskNumber <= 7 ? "completed" as const : "pending" as const,
      evidence: [{ kind: "file" as const, value: filePath }],
      evidenceStatus: taskNumber === 1 ? "satisfied" as const : "missing" as const,
      ...(taskNumber === 1 ? {} : { blockedReason: "缺少真实执行证据，暂不能标记完成" }),
    };
  });
  const evidenceLedger = [{
    id: "strict-evidence-1",
    kind: "file" as const,
    value: "src/task-1.ts",
    target: "src/task-1.ts",
    sourceTool: "replace_in_file",
    createdAt: now,
  }];

  incrementSeedCount(TOP_ISLAND_STRICT_EVIDENCE_PROGRESS_SCENARIO);

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
          title: "E2E ExecutionCapsule Strict Evidence Progress",
          date: new Date(now).toISOString(),
          active: true,
          messages: [],
        },
      ],
    },
    currentSessionId: sessionId,
    taskFlow: [
      { id: userBlockId, turnId, type: "user", content: "/计划 执行 8 个任务并严格追踪证据。" },
    ],
    conversationTurns: [
      {
        id: turnId,
        userPrompt: "/计划 执行 8 个任务并严格追踪证据。",
        title: "计划任务严格证据进度回归",
        mode: "plan",
        intent: "plan",
        status: "executing",
        summary: "ExecutionCapsule 不应把 claimed completed 当成可信完成。",
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
        content: planTasks.map((task) => `- [${task.claimedStatus === "completed" ? "x" : " "}] ${task.text}`).join("\n"),
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

  appendBridgeEvent("seeded", { seedCount: readSeedCount(TOP_ISLAND_STRICT_EVIDENCE_PROGRESS_SCENARIO) });
  bindBridgeSnapshot(TOP_ISLAND_STRICT_EVIDENCE_PROGRESS_SCENARIO);

  const cleanup = () => {
    useAppStore.setState({ abortController: null, isGenerating: false, agentStatus: "idle" });
  };

  return cleanup;
}

function seedExecutionCapsulePendingToolReviewScenario() {
  const bridge = getBridge();
  if (!bridge) return undefined;

  bridge.events = [{ type: "boot" }];
  bridge.savedDocuments = [];
  bridge.completed = false;

  const workspace = "/tmp/e2e-execution-capsule-pending-tool-review";
  const sessionId = 999603;
  const now = Date.now();
  const turnId = "e2e-execution-capsule-pending-tool-review-turn";
  const runId = "run-e2e-pending-tool-review";
  const userBlockId = useAppStore.getState()._nextTaskId();
  const reviewBlockId = useAppStore.getState()._nextTaskId();
  const longCommand = "printf '\\x89PNG\\r\\n\\x1a\\n\\x00\\x00\\x00\\rIHDR\\x00\\x00\\x00\\x01\\x00\\x00\\x00\\x01\\x08\\x02\\x00\\x00\\x00\\x90wS\\xde\\x00\\x00\\x00\\x0cIDATx\\x9cc\\xf8\\x0f\\x00\\x01\\x01\\x01\\x00\\x18\\xdd\\x8d\\xb4\\x00\\x00\\x00\\x00IEND\\xaeB`\\x82' > src-tauri/icons/icon.png && echo Created valid icon.png";
  const planTasks = Array.from({ length: 12 }, (_, index) => {
    const taskNumber = index + 1;
    return {
      id: `review-plan-task-${taskNumber}`,
      text: `T${taskNumber}: 执行验证步骤 — 证据: cmd:npm run check-${taskNumber}`,
      status: taskNumber <= 8 ? "completed" as const : "in_progress" as const,
      claimedStatus: taskNumber <= 8 ? "completed" as const : "pending" as const,
      evidence: [{ kind: "cmd" as const, value: `npm run check-${taskNumber}` }],
      evidenceStatus: taskNumber <= 8 ? "satisfied" as const : "missing" as const,
    };
  });
  const completedEvidenceTaskOrder = [3, 1, 2, 4, 5, 6, 7, 8];
  const evidenceLedger = completedEvidenceTaskOrder.map((taskNumber, index) => {
    const task = planTasks[taskNumber - 1];
    return {
      id: `review-evidence-${taskNumber}`,
      kind: "cmd" as const,
      value: `npm run check-${taskNumber}`,
      target: task.text,
      sourceTool: "run_command",
      createdAt: now + index,
    };
  });
  const pendingToolActionRequest = buildToolPermissionActionRequest({
    sessionKey: `${workspace}:${sessionId}`,
    turnId,
    runId,
    title: "长命令审批回归",
    taskId: reviewBlockId,
    toolCall: {
      name: "run_command",
      arguments: { command: longCommand },
      shellPermissionDecision: { requiresApproval: true },
    },
    now,
  });
  const pendingToolCall = {
    name: "run_command",
    arguments: { command: longCommand },
    shellPermissionDecision: {
      command: longCommand,
      decision: "ask" as const,
      source: "builtin_default",
      sourcePath: null,
      segmentDecisions: [],
      allowedBy: null,
      matchedRule: "printf",
      suggestedRule: "printf",
      suggestedRules: ["printf"],
      riskLevel: "medium" as const,
      reviewReason: "Shell segment writes a workspace file.",
      requiresApproval: true,
    },
  };

  incrementSeedCount(TOP_ISLAND_PENDING_TOOL_REVIEW_SCENARIO);

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
          title: "E2E ExecutionCapsule Pending Tool Review",
          date: new Date(now).toISOString(),
          active: true,
          messages: [],
        },
      ],
    },
    currentSessionId: sessionId,
    taskFlow: [
      { id: userBlockId, turnId, type: "user", content: "/计划 执行含长命令审批的任务。" },
      {
        id: reviewBlockId,
        turnId,
        type: "tool" as const,
        toolName: "run_command",
        target: longCommand,
        status: "pending_review",
        toolStatus: "pending" as const,
        message: "Waiting for shell permission approval.",
        shellPermissionDecision: {
          command: longCommand,
          decision: "ask",
          source: "builtin_default",
          sourcePath: null,
          segmentDecisions: [
            {
              command: longCommand,
              decision: "ask",
              matchedRule: "printf",
              suggestedRule: "printf",
              riskLevel: "medium",
              reviewReason: "Shell segment writes a workspace file.",
            },
          ],
          allowedBy: null,
          matchedRule: "printf",
          suggestedRule: "printf",
          suggestedRules: ["printf"],
          riskLevel: "medium",
          reviewReason: "Shell segment writes a workspace file.",
          requiresApproval: true,
        },
      },
    ],
    conversationTurns: [
      {
        id: turnId,
        userPrompt: "/计划 执行含长命令审批的任务。",
        title: "长命令审批回归",
        mode: "plan",
        intent: "plan",
        status: "awaiting_approval",
        summary: "ExecutionCapsule 应优先展示审批按钮。",
        blockIds: [userBlockId, reviewBlockId],
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
    planExecutionProgressSnapshot: {
      turnId,
      phase: "waiting_review",
      currentTask: planTasks[8].text,
      currentTool: `run_command · ${longCommand}`,
      latestEvidence: "已完成 8/12 项可信验证",
      nextStep: "批准命令后继续执行第 9 项验证",
      repeatedTargets: [],
      recoveryReason: "tool_permission_required",
      iteration: 9,
      maxIterations: 50,
      autoResumeCount: 0,
      updatedAt: now,
    },
    planStage: "executing",
    isPlanApproved: true,
    showPlanPanel: false,
    showDiff: false,
    showTerminal: false,
    showFilePanel: false,
    rightPanelTab: "plan",
    agentStatus: "pending_review",
    isGenerating: false,
    abortController: null,
    pendingReviewResolve: () => undefined,
    pendingReviewTaskId: reviewBlockId,
    activeActionRequest: pendingToolActionRequest,
    pendingToolCall,
    selectedDiffTaskId: null,
    input: "",
    attachedFiles: [],
    contextMentions: [],
  }));

  bridge.showPendingToolReviewPrompt = () => {
    // Session hydration intentionally clears resolver-backed approval state.
    // Restore the complete, identity-matched fixture checkpoint after hydrate;
    // restoring only the ActionRequest would correctly fail the production
    // ownership gate because the referenced task/tool request no longer exists.
    useAppStore.setState((state) => ({
      activeActionRequest: pendingToolActionRequest,
      harnessRunMarker: buildE2ERunningToolPermissionOwner({
        workspace,
        sessionId,
        turnId,
        runId,
        workflowMode: "plan",
        planStage: "executing",
        isPlanApproved: true,
        previous: state.harnessRunMarker,
      }),
      pendingReviewTaskId: reviewBlockId,
      pendingToolCall,
      pendingReviewResolve: (decision: unknown) => appendBridgeEvent("pending_tool_review_resolved", { decision }),
      agentStatus: "pending_review",
      currentTurnId: turnId,
      conversationTurns: state.conversationTurns.map((turn) =>
        turn.id === turnId ? { ...turn, status: "awaiting_approval" as const } : turn
      ),
    }));
    appendBridgeEvent("pending_tool_review_prompt_restored", {
      requestId: pendingToolActionRequest.requestId,
      runId: pendingToolActionRequest.runId,
    });
  };

  bridge.rotatePendingToolReviewIdentity = () => {
    const rotatedAt = Date.now();
    const nextRunId = `${runId}-rotated-${rotatedAt}`;
    const nextRequest = buildToolPermissionActionRequest({
      sessionKey: `${workspace}:${sessionId}`,
      turnId,
      runId: nextRunId,
      title: "长命令审批回归（新请求）",
      taskId: reviewBlockId,
      toolCall: pendingToolCall,
      now: rotatedAt,
    });
    useAppStore.setState((state) => ({
      activeActionRequest: nextRequest,
      harnessRunMarker: buildE2ERunningToolPermissionOwner({
        workspace,
        sessionId,
        turnId,
        runId: nextRunId,
        workflowMode: "plan",
        planStage: "executing",
        isPlanApproved: true,
        previous: state.harnessRunMarker,
        now: rotatedAt,
      }),
    }));
    appendBridgeEvent("pending_tool_review_identity_rotated", {
      requestId: nextRequest.requestId,
      runId: nextRequest.runId,
    });
    return {
      sessionKey: nextRequest.sessionKey,
      turnId: nextRequest.turnId,
      runId: nextRequest.runId,
      requestId: nextRequest.requestId,
      taskId: nextRequest.taskId,
    };
  };

  bridge.getPendingToolReviewIdentity = () => {
    const request = useAppStore.getState().activeActionRequest;
    if (request?.kind !== "tool_permission") return null;
    return {
      sessionKey: request.sessionKey,
      turnId: request.turnId,
      runId: request.runId,
      requestId: request.requestId,
      taskId: request.taskId,
    };
  };

  bridge.resolvePendingToolReviewWithIdentity = (
    action: "approve_once" | "approve_session" | "reject",
    identity: {
      sessionKey: string;
      turnId: string;
      runId: string;
      requestId: string;
      taskId: number;
    },
  ) => {
    const state = useAppStore.getState();
    if (action === "approve_once") state.approvePendingReviewOnce(identity);
    else if (action === "approve_session") state.approvePendingReviewForSession(identity);
    else state.rejectToolAction(identity.taskId, identity);
  };

  appendBridgeEvent("seeded", { seedCount: readSeedCount(TOP_ISLAND_PENDING_TOOL_REVIEW_SCENARIO) });
  bindBridgeSnapshot(TOP_ISLAND_PENDING_TOOL_REVIEW_SCENARIO);

  const cleanup = () => {
    useAppStore.setState({
      pendingReviewResolve: null,
      pendingReviewTaskId: null,
      activeActionRequest: null,
      pendingToolCall: null,
      agentStatus: "idle",
      isGenerating: false,
    });
  };

  return cleanup;
}

function seedExecutionCapsuleOrphanPendingReviewScenario() {
  const bridge = getBridge();
  if (!bridge) return undefined;

  bridge.events = [{ type: "boot" }];
  bridge.savedDocuments = [];
  bridge.completed = false;

  const workspace = "/tmp/e2e-execution-capsule-orphan-pending-review";
  const sessionId = 999613;
  const now = Date.now();
  const turnId = "e2e-execution-capsule-orphan-pending-review-turn";
  const runId = "run-e2e-orphan-pending-review";
  const userBlockId = useAppStore.getState()._nextTaskId();
  const pendingReviewTaskId = useAppStore.getState()._nextTaskId();
  const patch = [
    "*** Begin Patch",
    "*** Update File: Assets/Scripts/Entities/SnakeController.cs",
    "@@",
    "-old",
    "+new",
    "*** End Patch",
  ].join("\n");

  incrementSeedCount(TOP_ISLAND_ORPHAN_PENDING_REVIEW_SCENARIO);

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
          title: "E2E Orphan Pending Review",
          date: new Date(now).toISOString(),
          active: true,
          messages: [],
        },
      ],
    },
    currentSessionId: sessionId,
    taskFlow: [
      { id: userBlockId, turnId, type: "user", content: "修复 unity console 窗口里的报错。" },
    ],
    conversationTurns: [
      {
        id: turnId,
        userPrompt: "修复 unity console 窗口里的报错。",
        title: "孤立审批状态回归",
        mode: "edit",
        intent: "execute",
        displayIntent: "execute",
        status: "awaiting_approval",
        summary: "状态处于待审批，但 taskFlow 里没有 pending 工具卡。",
        blockIds: [userBlockId],
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
    agentStatus: "pending_review",
    isGenerating: false,
    abortController: null,
    pendingReviewResolve: (decision: unknown) => appendBridgeEvent("orphan_review_resolved", { decision }),
    pendingReviewTaskId,
    pendingToolCall: {
      name: "apply_patch",
      arguments: { patch },
    },
    selectedDiffTaskId: null,
    input: "",
    attachedFiles: [],
    contextMentions: [],
  }));

  bridge.showOrphanPendingReviewPrompt = () => {
    useAppStore.setState((state) => {
      const hasUserBlock = state.taskFlow.some((block) => block.id === userBlockId);
      const nextTurns = state.conversationTurns.some((turn) => turn.id === turnId)
        ? state.conversationTurns.map((turn) =>
            turn.id === turnId
              ? { ...turn, status: "awaiting_approval" as const, blockIds: turn.blockIds.includes(userBlockId) ? turn.blockIds : [...turn.blockIds, userBlockId] }
              : turn
          )
        : [
            ...state.conversationTurns,
            {
              id: turnId,
              userPrompt: "修复 unity console 窗口里的报错。",
              title: "孤立审批状态回归",
              mode: "edit" as const,
              intent: "execute" as const,
              displayIntent: "execute" as const,
              status: "awaiting_approval" as const,
              summary: "状态处于待审批，但 taskFlow 里没有 pending 工具卡。",
              blockIds: [userBlockId],
              collapsed: false,
              createdAt: now,
            },
          ];
      return {
        ...state,
        taskFlow: hasUserBlock
          ? state.taskFlow.filter((block) => !(block.type === "tool" && block.id === pendingReviewTaskId))
          : [
              ...state.taskFlow,
              { id: userBlockId, turnId, type: "user" as const, content: "修复 unity console 窗口里的报错。" },
            ],
        conversationTurns: nextTurns,
        currentTurnId: turnId,
        agentStatus: "pending_review",
        isGenerating: false,
        abortController: null,
        pendingReviewResolve: (decision: unknown) => appendBridgeEvent("orphan_review_resolved", { decision }),
        pendingReviewTaskId,
        harnessRunMarker: buildE2ERunningToolPermissionOwner({
          workspace,
          sessionId,
          turnId,
          runId,
          workflowMode: "edit",
          planStage: "idle",
          isPlanApproved: false,
          previous: state.harnessRunMarker,
        }),
        activeActionRequest: buildToolPermissionActionRequest({
          sessionKey: `${workspace}:${sessionId}`,
          turnId,
          runId,
          title: "孤立审批状态回归",
          taskId: pendingReviewTaskId,
          toolCall: {
            name: "apply_patch",
            arguments: { patch },
          },
        }),
        pendingToolCall: {
          name: "apply_patch",
          arguments: { patch },
        },
      };
    });
    appendBridgeEvent("orphan_pending_prompt_shown");
  };

  appendBridgeEvent("seeded", { seedCount: readSeedCount(TOP_ISLAND_ORPHAN_PENDING_REVIEW_SCENARIO) });
  bindBridgeSnapshot(TOP_ISLAND_ORPHAN_PENDING_REVIEW_SCENARIO);

  const cleanup = () => {
    useAppStore.setState({
      pendingReviewResolve: null,
      pendingReviewTaskId: null,
      activeActionRequest: null,
      pendingToolCall: null,
      agentStatus: "idle",
      isGenerating: false,
    });
  };

  return cleanup;
}

function seedExecutionCapsulePanelStabilityScenario() {
  const bridge = getBridge();
  if (!bridge) return undefined;

  bridge.events = [{ type: "boot" }];
  bridge.savedDocuments = [];
  bridge.completed = false;

  const workspace = "/tmp/e2e-execution-capsule-panel-stability";
  const sessionId = 999604;
  const now = Date.now();
  const turnId = "e2e-execution-capsule-panel-stability-turn";
  const userBlockId = useAppStore.getState()._nextTaskId();
  const agentBlockId = useAppStore.getState()._nextTaskId();
  const reviewBlockId = useAppStore.getState()._nextTaskId();
  const planTasks = [
    {
      id: "panel-task-1",
      text: "T1: 更新 ExecutionCapsule 审批状态 — 证据: file:src/components/ExecutionCapsule.tsx",
      status: "pending" as const,
      claimedStatus: "pending" as const,
      evidence: [{ kind: "file" as const, value: "src/components/ExecutionCapsule.tsx" }],
      evidenceStatus: "missing" as const,
    },
    {
      id: "panel-task-2",
      text: "T2: 验证右侧面板状态稳定 — 证据: cmd:npx playwright test tests/e2e/execution-capsule-execution-progress.spec.ts",
      status: "pending" as const,
      claimedStatus: "pending" as const,
      evidence: [{ kind: "cmd" as const, value: "npx playwright test tests/e2e/execution-capsule-execution-progress.spec.ts" }],
      evidenceStatus: "missing" as const,
    },
  ];
  const reviewCommand = "npm run build";

  incrementSeedCount(TOP_ISLAND_PANEL_STABILITY_SCENARIO);

  const baseUserBlock = { id: userBlockId, turnId, type: "user" as const, content: "/计划 修复 ExecutionCapsule 审批时右侧面板状态。" };
  const baseAgentBlock = {
    id: agentBlockId,
    turnId,
    type: "agent" as const,
    content: "已根据你的需求生成计划，等待确认后开始执行。",
  };
  const reviewBlock: any = {
    id: reviewBlockId,
    turnId,
    type: "tool" as const,
    toolName: "run_command",
    target: reviewCommand,
    status: "pending_review",
    toolStatus: "pending" as const,
    message: "Waiting for shell permission approval.",
    shellPermissionDecision: {
      command: reviewCommand,
      decision: "ask",
      source: "builtin_default",
      sourcePath: null,
      segmentDecisions: [],
      allowedBy: null,
      matchedRule: "npm run",
      suggestedRule: "npm run build",
      suggestedRules: ["npm run build"],
      riskLevel: "medium",
      reviewReason: "Command requires explicit approval.",
      requiresApproval: true,
    },
  };

  const removeReviewBlock = (state: ReturnType<typeof useAppStore.getState>) => ({
    taskFlow: state.taskFlow.filter((block) => block.id !== reviewBlockId),
    conversationTurns: state.conversationTurns.map((turn) =>
      turn.id === turnId
        ? { ...turn, blockIds: turn.blockIds.filter((id) => id !== reviewBlockId) }
        : turn
    ),
  });

  const addReviewBlock = (state: ReturnType<typeof useAppStore.getState>) => {
    const hasReviewBlock = state.taskFlow.some((block) => block.id === reviewBlockId);
    return {
      taskFlow: hasReviewBlock
        ? state.taskFlow.map((block) => block.id === reviewBlockId ? reviewBlock : block)
        : [...state.taskFlow, reviewBlock],
      conversationTurns: state.conversationTurns.map((turn) =>
        turn.id === turnId && !turn.blockIds.includes(reviewBlockId)
          ? { ...turn, blockIds: [...turn.blockIds, reviewBlockId] }
          : turn
      ),
    };
  };

  useAppStore.setState((state) => ({
    ...state,
    config: {
      ...state.config,
      language: "zh",
      workflowMode: "plan",
      theme: "green",
    },
    currentWorkspace: workspace,
    sessionsByWorkspace: {
      [workspace]: [
        {
          id: sessionId,
          title: "E2E ExecutionCapsule Panel Stability",
          date: new Date(now).toISOString(),
          active: true,
          messages: [],
        },
      ],
    },
    currentSessionId: sessionId,
    taskFlow: [baseUserBlock, baseAgentBlock],
    conversationTurns: [
      {
        id: turnId,
        userPrompt: "/计划 修复 ExecutionCapsule 审批时右侧面板状态。",
        title: "ExecutionCapsule 面板稳定回归",
        mode: "plan",
        intent: "plan",
        status: "awaiting_approval",
        summary: "计划审批出现时不应改变右侧面板状态。",
        blockIds: [userBlockId, agentBlockId],
        collapsed: false,
        createdAt: now,
      },
    ],
    currentTurnId: turnId,
    planArtifacts: [
      {
        kind: "design",
        path: ".MAIN/plans/plan.md",
        title: "Design",
        content: [
          "# ExecutionCapsule 面板稳定设计",
          "",
          "## 影响文件",
          "- 修改 `src/components/ExecutionCapsule.tsx`，让审批状态跟随当前主题色并保持右侧面板稳定。",
          "- 更新 `tests/e2e/execution-capsule-execution-progress.spec.ts`，覆盖审批后的面板状态。",
          "",
          "## 执行顺序",
          "1. 修改 ExecutionCapsule 的审批状态投影，不改变右侧面板选择。",
          "2. 运行可执行的 Playwright 回归测试验证批准与执行衔接。",
          "",
          "## 关键数据流",
          "Plan review request 绑定当前 revision/hash；批准后创建执行 run，面板展示状态保持独立。",
          "",
          "## 验证方式",
          "- 运行 `npx playwright test tests/e2e/execution-capsule-execution-progress.spec.ts`。",
        ].join("\n"),
        updatedAt: now,
      },
      {
        kind: "tasks",
        path: ".MAIN/plans/tasks.md",
        title: "Tasks",
        content: `${planTasks.map((task) => `- [ ] ${task.text}`).join("\n")}\n\n> 任务高亮也应跟随当前主题色。`,
        updatedAt: now + 1,
      },
    ],
    planTasks,
    planExecutionEvidenceLedger: [],
    planExecutionEvidenceCount: 0,
    planStage: "ready_to_execute",
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

  bridge.setPanelMode = (mode: "plan" | "diff" | "terminal" | "closed") => {
    useAppStore.setState({
      showPlanPanel: mode === "plan",
      showDiff: mode === "diff",
      showTerminal: mode === "terminal",
      showFilePanel: false,
      rightPanelTab: mode === "diff" ? "diff" : mode === "terminal" ? "terminal" : "plan",
      selectedDiffTaskId: mode === "diff" ? reviewBlockId : null,
    });
    appendBridgeEvent("panel_mode", { mode });
  };

  bridge.showPlanDraftRecovery = () => {
    const heartbeatAt = Date.now();
    const runId = "run-e2e-plan-draft-recovery";
    const staleReadBlockId = useAppStore.getState()._nextTaskId();
    const phaseBlockId = useAppStore.getState()._nextTaskId();
    const staleReadBlock = {
      id: staleReadBlockId,
      turnId,
      type: "agent" as const,
      content: "我已读取 tauri.conf.json，接下来会继续整理计划。",
      streaming: false,
      createdAt: heartbeatAt - 66_000,
      updatedAt: heartbeatAt - 66_000,
    };
    const phaseBlock = {
      id: phaseBlockId,
      turnId,
      type: "progress" as const,
      phase: "summarizing" as const,
      title: "Needs rewrite",
      why: "草稿结构不完整，直接重写可见方案。",
      action: "第 4 次计划生成已持续 65 秒，收到 420 个流式分块；隐藏推理正文不会展示。",
      evidence: "",
      next: "计划通过质量门后才会进入审核；当前不会请求执行批准。",
      targets: [],
      status: "running" as const,
      source: "runtime" as const,
      hypothesisStatus: "unverified" as const,
      turnPhase: {
        id: "plan_needs_rewrite",
        kind: "diagnosis" as const,
        title: "Needs rewrite",
        summary: "草稿结构不完整，直接重写可见方案。",
        domain: "plan_runtime",
        status: "running" as const,
      },
      runId,
      parentRunId: null,
      dedupeKey: `plan-runtime:${runId}:plan_needs_rewrite`,
      phaseReason: "excessive_plan_code_dump",
      iteration: 4,
      qualityRejectCount: 1,
      elapsedMs: 65_000,
      createdAt: heartbeatAt - 65_000,
      updatedAt: heartbeatAt,
    };
    useAppStore.setState((state) => ({
      taskFlow: [baseUserBlock, staleReadBlock, phaseBlock],
      conversationTurns: state.conversationTurns.map((turn) =>
        turn.id === turnId
          ? {
              ...turn,
              status: "planning" as const,
              summary: "",
              blockIds: [userBlockId, staleReadBlockId, phaseBlockId],
            }
          : turn
      ),
      currentTurnState: {
        ...state.currentTurnState,
        capsuleExplanation: {
          turnId,
          text: "正在整理已确认信息，生成可审批计划",
          updatedAt: heartbeatAt,
          source: "runtime" as const,
        },
      },
      planArtifacts: [],
      planTasks: [],
      planExecutionEvidenceLedger: [],
      planExecutionEvidenceCount: 0,
      planExecutionProgressSnapshot: null,
      planStage: "idle",
      isPlanApproved: false,
      activeActionRequest: null,
      pendingReviewResolve: null,
      pendingReviewTaskId: null,
      pendingToolCall: null,
      showPlanPanel: false,
      showDiff: false,
      showTerminal: false,
      rightPanelTab: "plan",
      agentStatus: "running",
      isGenerating: true,
      abortController: new AbortController(),
      harnessRunMarker: {
        schemaVersion: 1,
        runId,
        parentRunId: null,
        instanceId: "e2e-plan-draft-recovery-instance",
        sessionKey: `${workspace}:${sessionId}`,
        workspace,
        sessionId,
        turnId,
        status: "running",
        workflowMode: "plan",
        runtimeIntent: "plan",
        planStage: "idle",
        isPlanApproved: false,
        iteration: 4,
        maxIterations: 25,
        messagesLen: 15,
        toolCount: 2,
        latestTool: "read_file",
        latestToolTarget: "src-tauri/Cargo.toml",
        activeStreamId: "stream-e2e-plan-draft-recovery",
        streamStatus: "chunk_progress",
        streamChunkCount: 420,
        streamByteCount: 88_000,
        streamElapsedMs: 65_000,
        streamLifecycleStatus: "streaming",
        lastStreamError: null,
        startedAt: heartbeatAt - 65_000,
        updatedAt: heartbeatAt,
        closedAt: null,
        closeReason: null,
      },
    }));
    appendBridgeEvent("plan_draft_recovery_shown", { runId, turnId });
  };

  bridge.setExecutionCapsuleIdentity = (runId: string, requestId: string) => {
    const identityNow = Date.now();
    const planIdentity = buildPlanApprovalIdentity(useAppStore.getState().planArtifacts);
    useAppStore.setState({
      harnessRunMarker: {
        schemaVersion: 1,
        runId,
        instanceId: "e2e-execution-capsule-instance",
        sessionKey: `${workspace}:${sessionId}`,
        workspace,
        sessionId,
        turnId,
        status: "paused",
        workflowMode: "plan",
        runtimeIntent: "plan",
        planStage: "ready_to_execute",
        isPlanApproved: false,
        iteration: 1,
        maxIterations: 12,
        messagesLen: 2,
        toolCount: 0,
        latestTool: null,
        latestToolTarget: null,
        activeStreamId: requestId,
        streamStatus: "completed",
        streamChunkCount: 0,
        streamByteCount: 0,
        streamElapsedMs: 0,
        streamLifecycleStatus: "completed",
        lastStreamError: null,
        startedAt: identityNow,
        updatedAt: identityNow,
        closedAt: identityNow,
        closeReason: "plan_review",
      },
      activeActionRequest: planIdentity
        ? {
            ...buildPlanReviewActionRequest({
              sessionKey: `${workspace}:${sessionId}`,
              turnId,
              runId,
              title: "ExecutionCapsule 面板稳定回归",
              planRevision: planIdentity.revision,
              artifactHash: planIdentity.artifactHash,
              artifactPaths: planIdentity.artifactPaths,
              now: identityNow,
            }),
            requestId,
          }
        : null,
    });
    appendBridgeEvent("execution_capsule_identity", { runId, requestId, turnId });
  };

  bridge.resetPlanApprovalPrompt = () => {
    useAppStore.setState((state) => {
      const withoutReview = removeReviewBlock(state);
      const planIdentity = buildPlanApprovalIdentity(state.planArtifacts);
      return {
        ...withoutReview,
        isPlanApproved: false,
        planApprovalChoice: null,
        pendingPlanApprovalHandoff: null,
        planApprovalExecutionStartedForTurnId: null,
        currentTurnExecutionConsent: { turnId: null, granted: false },
        planStage: "ready_to_execute",
        agentStatus: "pending_review",
        isGenerating: false,
        abortController: null,
        harnessRunMarker: state.harnessRunMarker
          ? {
              ...state.harnessRunMarker,
              status: "paused" as const,
              planStage: "ready_to_execute",
              isPlanApproved: false,
              updatedAt: Date.now(),
              closedAt: state.harnessRunMarker.closedAt || Date.now(),
              closeReason: state.harnessRunMarker.closeReason || "plan_review",
            }
          : state.harnessRunMarker,
        pendingReviewResolve: null,
        pendingReviewTaskId: null,
        pendingToolCall: null,
        activeActionRequest: planIdentity
          ? buildPlanReviewActionRequest({
              sessionKey: `${workspace}:${sessionId}`,
              turnId,
              runId: state.harnessRunMarker?.runId || "run-e2e-plan-review",
              parentRunId: state.harnessRunMarker?.parentRunId || null,
              title: "ExecutionCapsule 面板稳定回归",
              planRevision: planIdentity.revision,
              artifactHash: planIdentity.artifactHash,
              artifactPaths: planIdentity.artifactPaths,
            })
          : null,
        selectedDiffTaskId: state.selectedDiffTaskId === reviewBlockId ? null : state.selectedDiffTaskId,
        conversationTurns: withoutReview.conversationTurns.map((turn) =>
          turn.id === turnId ? { ...turn, status: "awaiting_approval" } : turn
        ),
      };
    });
    appendBridgeEvent("plan_prompt_reset");
  };

  bridge.dropPlanRunOwner = () => {
    useAppStore.setState({
      agentStatus: "pending_review",
      isGenerating: false,
      abortController: null,
    });
    appendBridgeEvent("plan_run_owner_dropped");
  };

  bridge.failNextPlanExecutionSubmission = () => {
    const originalSendMessage = useAppStore.getState().sendMessage;
    const interceptSendMessage: typeof originalSendMessage = (text, images, options) => {
      if (options?.runtimeIntentOverride === "execute" && options?.reuseCurrentTurn === true) {
        useAppStore.setState({ sendMessage: originalSendMessage });
        appendBridgeEvent("plan_execution_submission_rejected");
        return false;
      }
      return originalSendMessage(text, images, options);
    };
    useAppStore.setState({ sendMessage: interceptSendMessage });
  };

  bridge.approveThenRejectBeforeFallback = () => {
    useAppStore.getState().approvePlan("批准后立即撤销");
    useAppStore.getState().rejectPlan();
    appendBridgeEvent("plan_approval_revoked_before_fallback");
  };

  bridge.attemptBusyPlanResume = () => {
    const owner = new AbortController();
    useAppStore.setState((state) => ({
      selectedMainModeKey: "main_mode",
      lockedComposerIntent: null,
      pendingRunDecision: null,
      pendingRunDecisionResolver: null,
      isPlanApproved: true,
      planStage: "executing",
      agentStatus: "running",
      isGenerating: true,
      abortController: owner,
      pendingPlanApprovalHandoff: null,
      planApprovalExecutionStartedForTurnId: turnId,
      conversationTurns: state.conversationTurns.map((turn) =>
        turn.id === turnId ? { ...turn, status: "executing" } : turn
      ),
    }));
    const accepted = useAppStore.getState().sendMessage("继续");
    const latest = useAppStore.getState();
    return {
      accepted,
      ownerPreserved: latest.abortController === owner,
      queuedText: latest.queuedUserMessage?.text || null,
      startedForTurnId: latest.planApprovalExecutionStartedForTurnId,
    };
  };

  bridge.showToolApprovalPrompt = () => {
    useAppStore.setState((state) => {
      const withReview = addReviewBlock(state);
      const runId = state.harnessRunMarker?.runId || "run-e2e-panel-tool-review";
      return {
        ...withReview,
        isPlanApproved: true,
        planStage: "executing",
        agentStatus: "pending_review",
        isGenerating: false,
        abortController: null,
        currentTurnExecutionConsent: { turnId, granted: true },
        pendingReviewResolve: (decision: unknown) => appendBridgeEvent("tool_review_resolved", { decision }),
        pendingReviewTaskId: reviewBlockId,
        harnessRunMarker: buildE2ERunningToolPermissionOwner({
          workspace,
          sessionId,
          turnId,
          runId,
          workflowMode: "plan",
          planStage: "executing",
          isPlanApproved: true,
          previous: state.harnessRunMarker,
        }),
        activeActionRequest: buildToolPermissionActionRequest({
          sessionKey: `${workspace}:${sessionId}`,
          turnId,
          runId,
          parentRunId: state.harnessRunMarker?.parentRunId || null,
          title: "ExecutionCapsule 面板稳定回归",
          taskId: reviewBlockId,
          toolCall: {
            name: "run_command",
            arguments: { command: reviewCommand },
            shellPermissionDecision: reviewBlock.shellPermissionDecision,
          },
        }),
        pendingToolCall: {
          name: "run_command",
          arguments: { command: reviewCommand },
          shellPermissionDecision: reviewBlock.shellPermissionDecision,
        },
        conversationTurns: withReview.conversationTurns.map((turn) =>
          turn.id === turnId ? { ...turn, status: "awaiting_approval" } : turn
        ),
      };
    });
    appendBridgeEvent("tool_prompt_shown");
  };

  bridge.showChildRunToolApprovalPrompt = () => {
    bridge.showToolApprovalPrompt?.();
    useAppStore.setState((state) => {
      const outerRunId = state.harnessRunMarker?.runId || "run-e2e-panel-tool-review";
      const childRunId = `${outerRunId}-child`;
      const request = state.activeActionRequest?.kind === "tool_permission"
        ? state.activeActionRequest
        : null;
      return {
        harnessRunMarker: state.harnessRunMarker
          ? {
              ...state.harnessRunMarker,
              activeRunId: childRunId,
              activeParentRunId: outerRunId,
            }
          : state.harnessRunMarker,
        activeActionRequest: request
          ? {
              ...request,
              runId: childRunId,
              parentRunId: outerRunId,
              requestId: `${request.requestId}-child`,
            }
          : null,
      };
    });
    appendBridgeEvent("child_run_tool_prompt_shown");
  };

  bridge.setRunState = (stateName: "running" | "pending_review" | "idle") => {
    if (stateName === "pending_review") {
      bridge.showToolApprovalPrompt?.();
      return;
    }

    useAppStore.setState((state) => {
      const withoutReview = removeReviewBlock(state);
      return {
        ...withoutReview,
        isPlanApproved: true,
        planStage: stateName === "idle" ? "completed" : "executing",
        agentStatus: stateName === "idle" ? "idle" : "running",
        isGenerating: stateName === "running",
        abortController: stateName === "running" ? new AbortController() : null,
        pendingReviewResolve: null,
        pendingReviewTaskId: null,
        activeActionRequest: null,
        pendingToolCall: null,
        conversationTurns: withoutReview.conversationTurns.map((turn) =>
          turn.id === turnId ? { ...turn, status: stateName === "idle" ? "done" : "executing" } : turn
        ),
      };
    });
    appendBridgeEvent("run_state", { state: stateName });
  };

  appendBridgeEvent("seeded", { seedCount: readSeedCount(TOP_ISLAND_PANEL_STABILITY_SCENARIO) });
  bindBridgeSnapshot(TOP_ISLAND_PANEL_STABILITY_SCENARIO);

  const cleanup = () => {
    const latest = useAppStore.getState();
    latest.abortController?.abort();
    useAppStore.setState({
      abortController: null,
      pendingReviewResolve: null,
      pendingReviewTaskId: null,
      activeActionRequest: null,
      pendingToolCall: null,
      agentStatus: "idle",
      isGenerating: false,
    });
    bridge.initialized = false;
  };

  bridge.cleanup = cleanup;
  return cleanup;
}

function seedGameStudioToolGroupScenario(status: "executing" | "awaiting_input") {
  const bridge = getBridge();
  if (!bridge) return undefined;

  bridge.events = [{ type: "boot" }];
  bridge.savedDocuments = [];
  bridge.completed = status !== "executing";

  const workspace = status === "executing"
    ? "/tmp/e2e-game-studio-tool-group"
    : "/tmp/e2e-game-studio-awaiting-choice";
  const sessionId = status === "executing" ? 999611 : 999612;
  const now = Date.now();
  const turnId = status === "executing"
    ? "e2e-game-studio-tool-group-turn"
    : "e2e-game-studio-awaiting-choice-turn";
  const userBlockId = useAppStore.getState()._nextTaskId();
  const completedAId = useAppStore.getState()._nextTaskId();
  const thoughtBlockId = useAppStore.getState()._nextTaskId();
  const completedBId = useAppStore.getState()._nextTaskId();
  const completedCId = useAppStore.getState()._nextTaskId();
  const tailToolId = useAppStore.getState()._nextTaskId();
  const agentBlockId = useAppStore.getState()._nextTaskId();

  const taskFlow: any[] = [
    { id: userBlockId, turnId, type: "user" as const, content: "继续排查 Main Camera 行为。" },
    {
      id: completedAId,
      turnId,
      type: "tool" as const,
      toolName: "find_gameobjects",
      target: "Main Camera",
      status: "done",
      toolStatus: "executed" as const,
      message: "OK",
      intentSummary: "定位 Main Camera 对象",
    },
    {
      id: thoughtBlockId,
      turnId,
      type: "thought" as const,
      content: "我需要先核对 Main Camera 状态，再继续调用相机管理工具。",
      isStreaming: false,
    },
    {
      id: completedBId,
      turnId,
      type: "tool" as const,
      toolName: "manage_camera",
      target: "Main Camera",
      status: "done",
      toolStatus: "executed" as const,
      message: "OK",
      intentSummary: "核对 Main Camera 当前相机参数",
    },
    {
      id: completedCId,
      turnId,
      type: "tool" as const,
      toolName: "execute_code",
      target: "Assets/Scripts/Camera/SnakeCameraController.cs",
      status: "done",
      toolStatus: "executed" as const,
      message: "OK",
      intentSummary: "读取控制脚本确认行为",
    },
  ];

  if (status === "executing") {
    taskFlow.push({
      id: tailToolId,
      turnId,
      type: "tool",
      toolName: "manage_camera",
      target: "Main Camera",
      status: "running",
      toolStatus: "running",
      message: "Executing...",
      intentSummary: "继续调整 Main Camera 视角\n**视角偏移** 需要用工具结果确认后再继续。",
    });
  } else {
    taskFlow.push({
      id: agentBlockId,
      turnId,
      type: "agent",
      content: "请选择下一步。",
      options: [
        { label: "继续分析 Main Camera", value: "继续分析 Main Camera", action: "continue_readonly_once" },
        { label: "本会话只读全部允许", value: "本会话只读全部允许", action: "allow_readonly_session" },
      ],
      choiceRequest: {
        sessionKey: `${workspace}:${sessionId}`,
        turnId,
        runId: "run-e2e-game-studio-choice",
        requestId: "request-e2e-game-studio-choice",
        parentRunId: null,
        optionValues: ["继续分析 Main Camera", "本会话只读全部允许"],
        allowCustomReply: true,
        status: "pending",
      },
      streaming: false,
    });
  }

  useAppStore.setState((state) => ({
    ...state,
    config: {
      ...state.config,
      language: "zh",
      workflowMode: "edit",
    },
    selectedMainModeKey: "game_studio",
    selectedNexusModeKey: "nexus_game_studio",
    currentWorkspace: workspace,
    sessionsByWorkspace: {
      [workspace]: [
        {
          id: sessionId,
          title: status === "executing"
            ? "E2E Game Studio Tool Group Collapse"
            : "E2E Game Studio Awaiting Choice",
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
        userPrompt: "继续排查 Main Camera 行为。",
        title: status === "executing" ? "工具折叠回归" : "等待选择状态回归",
        mode: "edit",
        intent: "studio_workflow",
        status,
        summary: status === "executing" ? "Game Studio 连续工具调用中。" : "Game Studio 已暂停等待选择。",
        blockIds: taskFlow.map((block) => block.id),
        collapsed: false,
        createdAt: now,
      },
    ],
    currentTurnId: turnId,
    agentStatus: status === "executing" ? "running" : "idle",
    isGenerating: status === "executing",
    showPlanPanel: false,
    showDiff: false,
    showTerminal: false,
    showFilePanel: false,
  }));

  bindBridgeSnapshot(
    status === "executing"
      ? GAME_STUDIO_TOOL_GROUP_COLLAPSE_SCENARIO
      : GAME_STUDIO_AWAITING_CHOICE_SCENARIO,
  );

  const cleanup = () => {
    bridge.initialized = false;
  };

  bridge.cleanup = cleanup;
  return cleanup;
}

function seedCapsuleProcessScenario(kind: "model" | "progress") {
  const bridge = getBridge();
  if (!bridge) return undefined;

  bridge.events = [{ type: "boot" }];
  bridge.savedDocuments = [];
  bridge.completed = false;

  const workspace = kind === "model"
    ? "/tmp/e2e-capsule-model-explanation"
    : "/tmp/e2e-capsule-progress-only";
  const sessionId = kind === "model" ? 999613 : 999614;
  const now = Date.now();
  const turnId = kind === "model"
    ? "e2e-capsule-model-explanation-turn"
    : "e2e-capsule-progress-only-turn";
  const userBlockId = useAppStore.getState()._nextTaskId();
  const readToolId = useAppStore.getState()._nextTaskId();
  const commandToolId = useAppStore.getState()._nextTaskId();
  const runningToolId = useAppStore.getState()._nextTaskId();
  const capsuleText = "我会保留这条模型说明，并在工具执行时继续围绕 capsule 链路排查。";
  const taskFlow: any[] = [
    { id: userBlockId, turnId, type: "user" as const, content: "继续排查 capsule 和工具折叠。" },
    {
      id: readToolId,
      turnId,
      type: "tool" as const,
      toolName: "read_file",
      target: "src/components/ChatArea.tsx",
      status: "done",
      toolStatus: "executed" as const,
      message: "OK",
      intentSummary: "确认 capsule 渲染链路",
      observationSummary: "找到 ChatArea 中 capsule 的显示优先级。",
    },
    {
      id: commandToolId,
      turnId,
      type: "tool" as const,
      toolName: "run_command",
      target: "npm run test:workflow-assets",
      status: "done",
      toolStatus: "executed" as const,
      message: "OK",
      intentSummary: "运行回归测试确认折叠状态",
      observationSummary: "验证命令已完成。",
    },
    {
      id: runningToolId,
      turnId,
      type: "tool" as const,
      toolName: "grep_search",
      target: "src/components/ChatArea.tsx",
      status: "running",
      toolStatus: "running" as const,
      message: "Searching...",
      intentSummary: "继续确认 capsule 不会被工具调用冲刷",
    },
  ];

  useAppStore.setState((state) => ({
    ...state,
    config: {
      ...state.config,
      language: "zh",
      workflowMode: "edit",
    },
    selectedMainModeKey: "main_mode",
    selectedNexusModeKey: "nexus_general",
    currentWorkspace: workspace,
    sessionsByWorkspace: {
      [workspace]: [
        {
          id: sessionId,
          title: kind === "model" ? "E2E Capsule Model Explanation" : "E2E Capsule Progress Only",
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
        userPrompt: "继续排查 capsule 和工具折叠。",
        title: kind === "model" ? "Capsule 模型说明缓存" : "Capsule 工具进度兜底",
        mode: "edit",
        intent: "execute",
        status: "executing",
        summary: "工具调用进行中。",
        blockIds: taskFlow.map((block) => block.id),
        collapsed: false,
        createdAt: now,
      },
    ],
    currentTurnId: turnId,
    currentTurnState: {
      interceptorHandled: false,
      interceptorThought: "",
      lastReportedThought: "",
      lastReportedAssistantText: "",
      capsuleExplanation: kind === "model"
        ? { turnId, text: capsuleText, updatedAt: now, source: "model" as const }
        : null,
      turnId,
    },
    agentStatus: "running",
    isGenerating: true,
    showPlanPanel: false,
    showDiff: false,
    showTerminal: false,
    showFilePanel: false,
  }));

  bindBridgeSnapshot(
    kind === "model"
      ? CAPSULE_MODEL_EXPLANATION_SCENARIO
      : CAPSULE_PROGRESS_ONLY_SCENARIO,
  );

  const cleanup = () => {
    bridge.initialized = false;
  };

  bridge.cleanup = cleanup;
  return cleanup;
}

function seedGoalCapsuleScenario() {
  const bridge = getBridge();
  if (!bridge) return undefined;

  bridge.events = [{ type: "boot" }];
  bridge.savedDocuments = [];
  bridge.completed = false;

  const workspace = "/tmp/e2e-goal-capsule";
  const sessionId = 999615;
  const now = Date.now();
  const turnId = "e2e-goal-capsule-turn";
  const userBlockId = useAppStore.getState()._nextTaskId();
  const agentBlockId = useAppStore.getState()._nextTaskId();
  const goal = createGoalDefinition({
    objective: "重构 Goal Runtime；完成标准：Loop 与 Capsule 通过测试；约束：兼容 dark、black、light 三大主题",
    iterationBudget: 40,
    maxDurationMs: 2 * 60 * 60 * 1000,
    sessionKey: workspace,
  });
  const progress = createGoalProgress(goal.id, `${workspace}/.MAIN/goals/${goal.id}/progress.md`);
  progress.currentIteration = 3;
  progress.totalIterationsUsed = 3;
  progress.totalTokensUsed = 4820;
  progress.estimatedTokens = true;
  progress.iterations = [
    {
      index: 3,
      phase: "execute",
      startedAt: now - 20_000,
      summary: "已完成 Goal Runtime 状态投影，正在验证 Capsule 菜单。",
      toolCallCount: 3,
      filesModified: ["src/lib/goalRuntime.ts", "src/components/GoalPanel.tsx"],
      testsRun: ["npm run lint"],
      testsPassed: true,
      unresolvedBlockers: [],
    },
  ];
  progress.evidence = [
    {
      id: "e2e-goal-evidence-file",
      goalId: goal.id,
      goalRevision: goal.revision || 1,
      iteration: 3,
      kind: "file_change",
      status: "passed",
      sourceTool: "apply_patch",
      target: "src/components/GoalPanel.tsx",
      summary: "Goal panel updated",
      references: ["src/components/GoalPanel.tsx"],
      createdAt: now - 15_000,
    },
    {
      id: "e2e-goal-evidence-lint",
      goalId: goal.id,
      goalRevision: goal.revision || 1,
      iteration: 3,
      kind: "build",
      status: "passed",
      sourceTool: "run_command",
      target: "npm run lint",
      summary: "TypeScript passed",
      references: [],
      createdAt: now - 10_000,
    },
  ];
  progress.milestones = [{
    id: "e2e-goal-milestone",
    text: "验证 Capsule Goal 菜单与三主题",
    status: "in_progress",
    criterionIds: goal.criteria?.map((criterion) => criterion.id) || [],
  }];
  progress.currentMilestoneId = "e2e-goal-milestone";
  progress.usage = {
    modelIterations: 3,
    toolCalls: 8,
    totalTokensUsed: 4820,
    activeDurationMs: 12 * 60 * 1000,
    activeStartedAt: now - 20_000,
    estimatedTokens: true,
  };
  const runtime = buildGoalRuntimeSnapshot({ goal, progress, phase: "execute" });

  useAppStore.setState((state) => ({
    ...state,
    config: { ...state.config, language: "zh", workflowMode: "edit" },
    selectedMainModeKey: "main_mode",
    selectedNexusModeKey: "nexus_general",
    currentWorkspace: workspace,
    selectedWorkspace: workspace,
    workspaces: [{ path: workspace, name: "E2E Goal Capsule", addedAt: now, lastActiveAt: now }],
    activeSessionByWorkspace: { [workspace]: sessionId },
    sessionsByWorkspace: {
      [workspace]: [{ id: sessionId, title: "E2E Goal Capsule", date: new Date(now).toISOString(), active: true, messages: [] }],
      [GLOBAL_CHAT_KEY]: [],
    },
    currentSessionId: sessionId,
    taskFlow: [
      { id: userBlockId, turnId, type: "user", content: "持续完成 Goal Runtime 重构。" },
      { id: agentBlockId, turnId, type: "agent", content: "已进入持续目标执行。", streaming: false },
    ],
    conversationTurns: [{
      id: turnId,
      userPrompt: "持续完成 Goal Runtime 重构。",
      title: "Goal Runtime 重构",
      mode: "edit",
      intent: "goal",
      displayIntent: "goal",
      status: "done",
      summary: "Goal Runtime 正在后台持续推进。",
      blockIds: [userBlockId, agentBlockId],
      collapsed: false,
      createdAt: now,
    }],
    currentTurnId: turnId,
    currentTurnState: {
      interceptorHandled: false,
      interceptorThought: "",
      lastReportedThought: "",
      lastReportedAssistantText: "",
      capsuleExplanation: null,
      turnId,
    },
    activeGoal: goal,
    goalProgress: progress,
    goalStatus: "active",
    goalIterationBudget: goal.iterationBudget,
    goalRuntime: runtime,
    agentStatus: "idle",
    isGenerating: false,
    abortController: null,
    showPlanPanel: false,
    showDiff: false,
    showTerminal: false,
    showFilePanel: false,
  }));

  bindBridgeSnapshot(GOAL_CAPSULE_SCENARIO);
  bridge.setGoalStatus = (status: GoalStatus) => {
    const state = useAppStore.getState();
    if (!state.activeGoal || !state.goalProgress) return;
    const nextGoal = {
      ...state.activeGoal,
      status,
      updatedAt: Date.now(),
      criteria: state.activeGoal.criteria?.map((criterion) => ({
        ...criterion,
        status: status === "completed" ? "satisfied" as const : criterion.status,
        evidenceIds: status === "completed" ? state.goalProgress?.evidence?.map((entry) => entry.id) || [] : criterion.evidenceIds,
      })),
    };
    const nextRuntime = {
      ...(state.goalRuntime || buildGoalRuntimeSnapshot({ goal: nextGoal, progress: state.goalProgress, phase: "observe" })),
      goal: nextGoal,
      status,
      phase: status === "completed" ? "observe" as const : "re_plan" as const,
      pauseReason: status === "paused" ? "E2E pause" : undefined,
      updatedAt: Date.now(),
    };
    useAppStore.setState({ activeGoal: nextGoal, goalStatus: status, goalRuntime: nextRuntime });
  };

  const cleanup = () => {
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
      currentTurnDisplayIntent: state.currentTurnId
        ? (() => {
            const turn = state.conversationTurns.find((candidate) => candidate.id === state.currentTurnId);
            return turn?.displayIntent ?? turn?.intent ?? null;
          })()
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

function seedGameStudioPlanShortcutsScenario() {
  const bridge = getBridge();
  if (!bridge) return undefined;

  bridge.events = [{ type: "boot" }];
  bridge.savedDocuments = [];
  bridge.completed = false;

  incrementSeedCount(GAME_STUDIO_PLAN_SHORTCUTS_SCENARIO);

  useAppStore.setState((state) => ({
    ...state,
    config: {
      ...state.config,
      language: "zh",
      workflowMode: "chat",
    },
    currentWorkspace: "/tmp/e2e-game-studio-plan-shortcuts",
    selectedWorkspace: "/tmp/e2e-game-studio-plan-shortcuts",
    sessionsByWorkspace: {},
    currentSessionId: null,
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
      currentTurnId: state.currentTurnId,
      turnIds: state.conversationTurns.map((turn) => turn.id),
      currentTurnIntent: state.currentTurnId
        ? state.conversationTurns.find((turn) => turn.id === state.currentTurnId)?.intent ?? null
        : null,
      currentTurnDisplayIntent: state.currentTurnId
        ? (() => {
            const turn = state.conversationTurns.find((candidate) => candidate.id === state.currentTurnId);
            return turn?.displayIntent ?? turn?.intent ?? null;
          })()
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
      conversationTurns: state.conversationTurns.length,
      planStage: state.planStage,
      seedCount: readSeedCount(GAME_STUDIO_PLAN_SHORTCUTS_SCENARIO),
    };
  };

  bridge.seedPlanTurnForContinuation = () => {
    const now = Date.now();
    const turnId = "e2e-game-studio-plan-continuation-turn";
    const userBlockId = useAppStore.getState()._nextTaskId();
    const agentBlockId = useAppStore.getState()._nextTaskId();
    useAppStore.setState((state) => ({
      ...state,
      taskFlow: [
        { id: userBlockId, turnId, type: "user", content: "先规划 Game Studio 大整改" },
        {
          id: agentBlockId,
          turnId,
          type: "agent",
          content: "计划回合还需要继续推进。",
          streaming: false,
        },
      ],
      conversationTurns: [
        {
          id: turnId,
          userPrompt: "先规划 Game Studio 大整改",
          title: "Game Studio 大整改计划",
          mode: "plan",
          intent: "plan",
          status: "stopped_no_action",
          summary: "等待继续生成计划。",
          blockIds: [userBlockId, agentBlockId],
          collapsed: false,
          createdAt: now,
        },
      ],
      currentTurnId: turnId,
      planArtifacts: [],
      planTasks: [],
      planStage: "design",
      isPlanApproved: false,
      lockedComposerIntent: null,
      input: "",
      isGenerating: false,
      agentStatus: "idle",
      abortController: null,
    }));
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

function seedComposerRunningGuidanceScenario() {
  const bridge = getBridge();
  if (!bridge) return undefined;

  bridge.events = [{ type: "boot" }];
  bridge.savedDocuments = [];
  bridge.completed = false;

  incrementSeedCount(COMPOSER_RUNNING_GUIDANCE_SCENARIO);

  const now = Date.now();
  const turnId = "e2e-composer-running-guidance-turn";
  const userBlockId = useAppStore.getState()._nextTaskId();

  useAppStore.setState((state) => ({
    ...state,
    config: {
      ...state.config,
      language: "zh",
      workflowMode: "chat",
    },
    currentWorkspace: "/tmp/e2e-composer-running-guidance",
    selectedWorkspace: "/tmp/e2e-composer-running-guidance",
    sessionsByWorkspace: {
      "/tmp/e2e-composer-running-guidance": [
        {
          id: 999011,
          title: "E2E Composer Running Guidance",
          date: new Date(now).toISOString(),
          active: true,
          messages: [],
        },
      ],
    },
    currentSessionId: 999011,
    selectedMainModeKey: "main_mode",
    selectedNexusModeKey: "nexus_general",
    taskFlow: [
      { id: userBlockId, turnId, type: "user", content: "请检查运行中输入体验。" },
    ],
    conversationTurns: [
      {
        id: turnId,
        userPrompt: "请检查运行中输入体验。",
        title: "运行中输入体验",
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
    queuedUserMessage: null,
    activeGuidance: null,
    autoApproveTools: false,
    autoApproveToolScopes: [],
    elapsedTime: 0,
    isGenerating: true,
    agentStatus: "running",
    abortController: new AbortController(),
    showDiff: false,
    showPlanPanel: false,
    showTerminal: false,
    showFilePanel: false,
    selectedDiffTaskId: null,
  }));

  bindBridgeSnapshot(COMPOSER_RUNNING_GUIDANCE_SCENARIO);

  const cleanup = () => {
    const latest = useAppStore.getState();
    latest.abortController?.abort();
    useAppStore.setState({ abortController: null });
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

function seedLocalPlanSlowFirstTokenScenario() {
  const bridge = getBridge();
  if (!bridge) return undefined;

  bridge.events = [{ type: "boot" }];
  bridge.savedDocuments = [];
  bridge.completed = false;

  incrementSeedCount(LOCAL_PLAN_SLOW_FIRST_TOKEN_SCENARIO);

  const now = Date.now();
  const workspace = "/tmp/e2e-local-plan-slow-first-token";
  const sessionId = 999511;

  useAppStore.setState((state) => ({
    ...state,
    config: {
      ...state.config,
      language: "zh",
      workflowMode: "plan",
      activeProfile: "local",
      local: {
        ...state.config.local,
        provider: "Ollama",
        endpoint: "http://127.0.0.1:11434",
        model: "e2e-slow-local-plan",
        apiKey: "ollama",
        contextLimit: 16384,
        toolProtocol: "xml",
      },
      workspace,
      instructionsEnabled: false,
      hooksEnabled: false,
      sessionRecordingEnabled: false,
    },
    currentWorkspace: workspace,
    selectedWorkspace: workspace,
    workspaces: [{ path: workspace, name: "E2E Local Plan Slow First Token", addedAt: now, lastActiveAt: now }],
    activeSessionByWorkspace: { [workspace]: sessionId },
    sessionsByWorkspace: {
      [workspace]: [
        {
          id: sessionId,
          title: "E2E Local Plan Slow First Token",
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
    taskFlow: [],
    agentMessages: [],
    conversationTurns: [],
    currentTurnId: null,
    input: "",
    attachedFiles: [],
    contextMentions: [],
    planArtifacts: [],
    planTasks: [],
    planStage: "idle",
    isPlanApproved: false,
    readOnlyAutoApproveForSession: false,
    isGenerating: false,
    agentStatus: "idle",
    elapsedTime: 0,
    showPlanPanel: false,
    showTerminal: false,
    showFilePanel: false,
    showDiff: false,
    selectedDiffTaskId: null,
  }));

  bridge.sendCloudMessage = (text?: string) =>
    useAppStore.getState().sendMessage(
      text || "请为慢首 token 的本地模型生成一个可审批执行计划。",
      undefined,
      {
        resolvedIntent: "plan",
        skipIntentResolution: true,
      },
    );

  bridge.getSnapshot = () => {
    const state = useAppStore.getState();
    const currentTurn = state.currentTurnId
      ? state.conversationTurns.find((turn) => turn.id === state.currentTurnId) || null
      : null;
    return {
      agentStatus: state.agentStatus,
      isGenerating: state.isGenerating,
      planStage: state.planStage,
      planArtifactPaths: state.planArtifacts.map((artifact) => artifact.path),
      currentTurnStatus: currentTurn?.status ?? null,
      systemTexts: (state.taskFlow.filter((block) => block.type === "system") as any[]).map((block) => block.content),
      seedCount: readSeedCount(LOCAL_PLAN_SLOW_FIRST_TOKEN_SCENARIO),
    };
  };

  const cleanup = () => {
    bridge.initialized = false;
  };

  bridge.cleanup = cleanup;
  return cleanup;
}

function seedRealOmlxPlanFlowScenario() {
  const bridge = getBridge();
  if (!bridge) return undefined;

  bridge.events = [{ type: "boot" }];
  bridge.savedDocuments = [];
  bridge.completed = false;
  bridge.dispatchError = null;

  incrementSeedCount(REAL_OMLX_PLAN_FLOW_SCENARIO);

  const params = new URLSearchParams(window.location.search);
  const model = params.get("model") || "gemma-4-26b-a4b-it-8bit";
  const realOmlxConfig = (window as any).__REAL_OMLX_CONFIG__ || {};
  const workspace = `/tmp/e2e-real-omlx-${model.replace(/[^a-z0-9_-]+/gi, "-").toLowerCase()}`;
  const sessionId = model.includes("Qwen") ? 999522 : 999521;
  const now = Date.now();

  useAppStore.setState((state) => ({
    ...state,
    config: {
      ...state.config,
      language: "zh",
      workflowMode: "plan",
      activeProfile: "local",
      local: {
        ...state.config.local,
        provider: "OMLX",
        endpoint: String(realOmlxConfig.endpoint || "http://127.0.0.1:8000/v1"),
        model,
        apiKey: String(realOmlxConfig.apiKey || "mmnn"),
        contextLimit: 32768,
        toolProtocol: "auto",
      },
      workspace,
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
          title: `E2E Real OMLX ${model}`,
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
    taskFlow: [],
    agentMessages: [],
    conversationTurns: [],
    currentTurnId: null,
    input: "",
    attachedFiles: [],
    contextMentions: [],
    planArtifacts: [],
    planTasks: [],
    planExecutionEvidenceLedger: [],
    planExecutionEvidenceCount: 0,
    planStage: "idle",
    isPlanApproved: false,
    readOnlyAutoApproveForSession: true,
    autoApproveTools: true,
    autoApproveToolScopes: ["workspace_write", "shell"],
    isGenerating: false,
    agentStatus: "idle",
    elapsedTime: 0,
    showPlanPanel: true,
    showTerminal: false,
    showFilePanel: false,
    showDiff: false,
    selectedDiffTaskId: null,
  }));

  bridge.sendCloudMessage = (text?: string) =>
    useAppStore.getState().sendMessage(
      text || "请修复 src/hooks/useCsvParser.ts，让 CSV creator 字段正确映射为 Dashboard 使用的 creatorName。先生成可审批计划，批准后真实修改并验证。",
      undefined,
      {
        resolvedIntent: "plan",
        skipIntentResolution: true,
      },
    );

  bridge.sendGoalMessage = (text?: string) => {
    const objective = text || "修改 src/hooks/useCsvParser.ts，将 creator 正确映射到 creatorName，并运行验证。";
    const state = useAppStore.getState();
    state.startGoal(objective, {
      sessionKey: `${workspace}:${sessionId}`,
      maxIterations: 6,
      maxDurationMs: 20 * 60 * 1000,
    });
    return state.sendMessage(objective, undefined, {
      resolvedIntent: "execute",
      runtimeIntentOverride: "goal",
      skipIntentResolution: true,
      preservePlanState: true,
      turnTitle: "OMLX Goal Runtime",
      intentSummary: "Run a bounded Goal Runtime loop with local OMLX",
    });
  };

  bridge.approvePlan = () => {
    const before = useAppStore.getState();
    const executionTasks = ensureApprovedPlanRuntimeTasksForState(
      before,
      before.config.language === "en" ? "en" : "zh",
    );
    const readiness = evaluateApprovedPlanExecutionReadiness({
      planArtifacts: before.planArtifacts,
      executionPlanTasks: executionTasks,
    });
    before.approvePlan("批准执行");
    const after = useAppStore.getState();
    return {
      before: {
        turnId: before.currentTurnId,
        runId: before.harnessRunMarker?.runId || null,
        agentStatus: before.agentStatus,
        isGenerating: before.isGenerating,
        actionRequestId: before.activeActionRequest?.requestId || null,
        readiness,
        executionTasks,
        planContent: before.planArtifacts[0]?.content || "",
      },
      after: {
        turnId: after.currentTurnId,
        runId: after.harnessRunMarker?.runId || null,
        agentStatus: after.agentStatus,
        isGenerating: after.isGenerating,
        approved: after.isPlanApproved,
        pendingHandoff: after.pendingPlanApprovalHandoff,
        executionStartedForTurnId: after.planApprovalExecutionStartedForTurnId,
      },
    };
  };
  bridge.approvePendingTool = () => {
    useAppStore.getState().approvePendingReviewOnce();
  };

  bridge.getSnapshot = () => {
    const state = useAppStore.getState();
    const currentTurn = state.currentTurnId
      ? state.conversationTurns.find((turn) => turn.id === state.currentTurnId) || null
      : null;
    const agentTexts = (state.taskFlow.filter((block) => block.type === "agent") as any[]).map((block) => block.content);
    const toolBlocks = (state.taskFlow.filter((block) => block.type === "tool") as any[]).map((block) => ({
      name: block.toolName,
      target: block.target,
      status: block.status,
      error: block.error,
    }));
    return {
      model,
      agentStatus: state.agentStatus,
      isGenerating: state.isGenerating,
      planStage: state.planStage,
      isPlanApproved: state.isPlanApproved,
      planArtifacts: state.planArtifacts.map((artifact) => ({
        path: artifact.path,
        title: artifact.title,
        content: artifact.content,
      })),
      planTasks: state.planTasks,
      planExecutionEvidence: state.planExecutionEvidenceLedger.map((entry) => ({
        kind: entry.kind,
        value: entry.value,
        target: entry.target,
        sourceTool: entry.sourceTool,
      })),
      goalStatus: state.goalStatus,
      activeGoal: state.activeGoal ? {
        id: state.activeGoal.id,
        objective: state.activeGoal.rawText || state.activeGoal.objective,
        revision: state.activeGoal.revision || 1,
      } : null,
      goalIterations: state.goalProgress?.totalIterationsUsed || 0,
      goalPauseReason: state.goalRuntime?.pauseReason || state.goalProgress?.pauseReason || null,
      goalLastError: state.goalRuntime?.lastError || null,
      goalEvidence: (state.goalProgress?.evidence || []).map((entry) => ({
        kind: entry.kind,
        status: entry.status,
        sourceTool: entry.sourceTool,
        target: entry.target,
      })),
      currentTurnStatus: currentTurn?.status ?? null,
      currentRunId: state.harnessRunMarker?.runId || null,
      parentRunId: state.harnessRunMarker?.parentRunId || null,
      pendingPlanApprovalHandoff: state.pendingPlanApprovalHandoff,
      planApprovalExecutionStartedForTurnId: state.planApprovalExecutionStartedForTurnId,
      activeActionRequest: state.activeActionRequest ? {
        kind: state.activeActionRequest.kind,
        requestId: state.activeActionRequest.requestId,
        turnId: state.activeActionRequest.turnId,
        runId: state.activeActionRequest.runId,
      } : null,
      agentTexts,
      toolBlocks,
      taskFlowTypes: state.taskFlow.map((block) => block.type),
      taskFlowPreview: state.taskFlow.map((block: any) => ({
        type: block.type,
        title: block.title || "",
        content: String(block.content || block.error || "").slice(0, 800),
        toolName: block.toolName || "",
        target: block.target || "",
        status: block.status || "",
      })),
      debugTail: ((window as any).__REAL_OMLX_DEBUG_LOGS__ || []).slice(-80),
      dispatchError: bridge.dispatchError || null,
      seedCount: readSeedCount(REAL_OMLX_PLAN_FLOW_SCENARIO),
    };
  };

  const cleanup = () => {
    bridge.initialized = false;
  };

  bridge.cleanup = cleanup;
  return cleanup;
}

function seedLocalPlanClosureGuardEmptyScenario() {
  const bridge = getBridge();
  if (!bridge) return undefined;

  bridge.events = [{ type: "boot" }];
  bridge.savedDocuments = [];
  bridge.completed = false;

  incrementSeedCount(PLAN_CLOSURE_GUARD_EMPTY_SCENARIO);

  const now = Date.now();
  const workspace = "/tmp/e2e-plan-closure-guard-empty";
  const sessionId = 999512;

  useAppStore.setState((state) => ({
    ...state,
    config: {
      ...state.config,
      language: "zh",
      workflowMode: "plan",
      activeProfile: "local",
      local: {
        ...state.config.local,
        provider: "Ollama",
        endpoint: "http://127.0.0.1:11434",
        model: "e2e-local-empty-plan",
        apiKey: "ollama",
        contextLimit: 16384,
        toolProtocol: "xml",
      },
      workspace,
      instructionsEnabled: false,
      hooksEnabled: false,
      sessionRecordingEnabled: false,
    },
    currentWorkspace: workspace,
    selectedWorkspace: workspace,
    workspaces: [{ path: workspace, name: "E2E Plan Closure Guard Empty", addedAt: now, lastActiveAt: now }],
    activeSessionByWorkspace: { [workspace]: sessionId },
    sessionsByWorkspace: {
      [workspace]: [
        {
          id: sessionId,
          title: "E2E Plan Closure Guard Empty",
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
    taskFlow: [],
    agentMessages: [],
    conversationTurns: [],
    currentTurnId: null,
    input: "",
    attachedFiles: [],
    contextMentions: [],
    planArtifacts: [],
    planTasks: [],
    planStage: "idle",
    isPlanApproved: false,
    readOnlyAutoApproveForSession: false,
    isGenerating: false,
    agentStatus: "idle",
    elapsedTime: 0,
    showPlanPanel: false,
    showTerminal: false,
    showFilePanel: false,
    showDiff: false,
    selectedDiffTaskId: null,
  }));

  bridge.sendCloudMessage = (text?: string) =>
    useAppStore.getState().sendMessage(
      text || "请基于 orders.csv 生成一个数据分析自动化执行计划。",
      undefined,
      {
        resolvedIntent: "plan",
        skipIntentResolution: true,
      },
    );

  bridge.getSnapshot = () => {
    const state = useAppStore.getState();
    const currentTurn = state.currentTurnId
      ? state.conversationTurns.find((turn) => turn.id === state.currentTurnId) || null
      : null;
    const agentBlocks = state.taskFlow.filter((block) => block.type === "agent") as any[];
    const thoughtBlocks = state.taskFlow.filter((block) => block.type === "thought") as any[];
    const progressBlocks = state.taskFlow.filter((block) => block.type === "progress") as any[];
    const toolBlocks = state.taskFlow.filter((block) => block.type === "tool") as any[];
    const progressTexts = progressBlocks.map((block) =>
      [
        block.title,
        block.why,
        block.action,
        block.evidence,
        block.next,
        ...(Array.isArray(block.targets) ? block.targets : []),
      ]
        .filter(Boolean)
        .join(" "),
    );
    return {
      agentStatus: state.agentStatus,
      isGenerating: state.isGenerating,
      planStage: state.planStage,
      planArtifactPaths: state.planArtifacts.map((artifact) => artifact.path),
      currentTurnStatus: currentTurn?.status ?? null,
      agentTexts: agentBlocks.map((block) => block.content),
      thoughtTexts: [
        ...thoughtBlocks.map((block) => block.content),
        ...progressTexts,
        ...toolBlocks.map((block) => [block.toolName, block.target, block.message].filter(Boolean).join(" ")),
      ],
      seedCount: readSeedCount(PLAN_CLOSURE_GUARD_EMPTY_SCENARIO),
    };
  };

  const cleanup = () => {
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
  const isGlobalChatScenario =
    scenario === GLOBAL_CHAT_TOOL_SCOPE_SCENARIO ||
    scenario === GLOBAL_CHAT_ATTACHMENT_READ_SCENARIO;
  const workspace = isGlobalChatScenario ? "" : `/tmp/e2e-${scenario}`;
  const scopeKey = isGlobalChatScenario ? GLOBAL_CHAT_KEY : workspace;
  const ordinaryContinueSeed = scenario === ORDINARY_CONTINUE_NEW_TURN_SCENARIO
    ? (() => {
        const turnId = "e2e-ordinary-continue-previous-turn";
        const userBlockId = useAppStore.getState()._nextTaskId();
        const toolBlockId = useAppStore.getState()._nextTaskId();
        const agentBlockId = useAppStore.getState()._nextTaskId();
        return {
          turnId,
          taskFlow: [
            {
              id: userBlockId,
              turnId,
              type: "user" as const,
              content: "请修复 README 检查链路并验证。",
            },
            {
              id: toolBlockId,
              turnId,
              type: "tool" as const,
              toolName: "read_file",
              target: "README.md",
              status: "done",
              toolStatus: "executed" as const,
              message: "已读取 README.md，下一步尚未完成。",
            },
            {
              id: agentBlockId,
              turnId,
              type: "agent" as const,
              content: "我已经定位到 README 检查链路，但还没完成后续处理。",
              streaming: false,
            },
          ],
          agentMessages: [
            { role: "user" as const, content: "请修复 README 检查链路并验证。" },
            { role: "assistant" as const, content: "我已经定位到 README 检查链路，但还没完成后续处理。" },
          ],
          conversationTurns: [
            {
              id: turnId,
              userPrompt: "请修复 README 检查链路并验证。",
              title: "README 检查链路修复",
              mode: "chat" as const,
              intent: "execute" as const,
              displayIntent: "execute" as const,
              status: "stopped_no_action" as const,
              summary: "上一轮已停止，等待用户继续。",
              blockIds: [userBlockId, toolBlockId, agentBlockId],
              collapsed: false,
              createdAt: now - 1_000,
            },
          ],
        };
      })()
    : null;
  const sessionId = scenario === CLOUD_TOOL_FALLBACK_SCENARIO
    ? 999501
    : scenario === GAME_STUDIO_EXECUTE_REPLY_SCENARIO
    ? 999504
    : scenario === UNITY_MCP_OPTIONS_PRIORITY_SCENARIO
    ? 999507
    : scenario === UNITY_TOOL_CODE_COMPAT_SCENARIO
    ? 999508
    : scenario === UNITY_NO_ERROR_ROUTING_SCENARIO
    ? 999509
    : scenario === PSEUDO_TOOL_CALL_RECOVERY_SCENARIO
    ? 999505
    : scenario === LOCAL_FILE_READ_APPROVAL_SCENARIO
    ? 999506
    : scenario === MALFORMED_TOOL_USE_PLAN_SCENARIO
    ? 999510
    : scenario === APPROVED_PLAN_EXECUTION_NO_TOOL_SCENARIO
    ? 999513
    : scenario === APPROVED_PLAN_EXECUTION_REPLAY_SCENARIO
    ? 999518
    : scenario === PROGRESS_NARRATION_TOOL_FLOW_SCENARIO
    ? 999514
    : scenario === ORDINARY_CONTINUE_NEW_TURN_SCENARIO
    ? 999515
    : scenario === GLOBAL_CHAT_TOOL_SCOPE_SCENARIO
    ? 999516
    : scenario === GLOBAL_CHAT_ATTACHMENT_READ_SCENARIO
    ? 999517
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
      workflowMode:
        scenario === MALFORMED_TOOL_USE_PLAN_SCENARIO ||
        scenario === APPROVED_PLAN_EXECUTION_NO_TOOL_SCENARIO ||
        scenario === APPROVED_PLAN_EXECUTION_REPLAY_SCENARIO ||
        scenario === PLAN_OPERATION_APPROVAL_REUSE_SCENARIO
          ? "plan"
          : "chat",
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
    workspaces: isGlobalChatScenario
      ? []
      : [{ path: workspace, name: `E2E ${scenario}`, addedAt: now, lastActiveAt: now }],
    activeSessionByWorkspace: {
      [scopeKey]: sessionId,
    },
    sessionsByWorkspace: {
      [scopeKey]: [
        {
          id: sessionId,
          title: scenario === CLOUD_TOOL_FALLBACK_SCENARIO
            ? "E2E Cloud Tool Fallback"
            : scenario === GAME_STUDIO_EXECUTE_REPLY_SCENARIO
            ? "E2E Game Studio Execute Reply"
            : scenario === UNITY_MCP_OPTIONS_PRIORITY_SCENARIO
            ? "E2E Unity MCP Options Priority"
            : scenario === UNITY_TOOL_CODE_COMPAT_SCENARIO
            ? "E2E Unity Tool Code Compatibility"
            : scenario === UNITY_NO_ERROR_ROUTING_SCENARIO
            ? "E2E Unity No Error Routing"
            : scenario === PSEUDO_TOOL_CALL_RECOVERY_SCENARIO
            ? "E2E Pseudo Tool Call Recovery"
            : scenario === LOCAL_FILE_READ_APPROVAL_SCENARIO
            ? "E2E Local File Read Approval"
            : scenario === MALFORMED_TOOL_USE_PLAN_SCENARIO
            ? "E2E Malformed Tool Use Plan"
            : scenario === APPROVED_PLAN_EXECUTION_NO_TOOL_SCENARIO
            ? "E2E Approved Plan No Tool"
            : scenario === APPROVED_PLAN_EXECUTION_REPLAY_SCENARIO
            ? "E2E Approved Plan Execution Replay"
            : scenario === PROGRESS_NARRATION_TOOL_FLOW_SCENARIO
            ? "E2E Progress Narration Tool Flow"
            : scenario === ORDINARY_CONTINUE_NEW_TURN_SCENARIO
            ? "E2E Ordinary Continue New Turn"
            : scenario === GLOBAL_CHAT_TOOL_SCOPE_SCENARIO
            ? "E2E Global Chat Tool Scope"
            : scenario === GLOBAL_CHAT_ATTACHMENT_READ_SCENARIO
            ? "E2E Global Chat Attachment Read"
            : scenario === PLAN_OPERATION_APPROVAL_REUSE_SCENARIO
            ? "E2E Plan Operation Approval Reuse"
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
    selectedMainModeKey:
      scenario === GAME_STUDIO_EXECUTE_REPLY_SCENARIO ||
        scenario === UNITY_TOOL_CODE_COMPAT_SCENARIO ||
        scenario === UNITY_NO_ERROR_ROUTING_SCENARIO
        ? "game_studio"
        : "main_mode",
    selectedNexusModeKey:
      scenario === GAME_STUDIO_EXECUTE_REPLY_SCENARIO ||
        scenario === UNITY_TOOL_CODE_COMPAT_SCENARIO ||
        scenario === UNITY_NO_ERROR_ROUTING_SCENARIO
        ? "nexus_game_studio"
        : "nexus_general",
    taskFlow: ordinaryContinueSeed?.taskFlow ?? [],
    agentMessages: ordinaryContinueSeed?.agentMessages ?? [],
    conversationTurns: ordinaryContinueSeed?.conversationTurns ?? [],
    currentTurnId: ordinaryContinueSeed?.turnId ?? null,
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
    ...(scenario === APPROVED_PLAN_EXECUTION_NO_TOOL_SCENARIO || scenario === APPROVED_PLAN_EXECUTION_REPLAY_SCENARIO
      ? {
          planArtifacts: [],
          planTasks: [],
          planExecutionEvidenceLedger: [],
          planExecutionEvidenceCount: 0,
          planStage: "idle",
          isPlanApproved: false,
          autoApproveTools: true,
          autoApproveToolScopes: ["shell", "workspace_write"],
        }
      : {}),
  }));

  bridge.setThemeMode = (mode: "light" | "dark" | "black") => {
    useAppStore.setState((state) => ({
      config: { ...state.config, themeMode: mode },
    }));
  };

  bridge.sendCloudRespondMessage = (text?: string) => useAppStore.getState().sendMessage(
    text || "请只解释当前上下文，不要执行操作。",
    undefined,
    {
      resolvedIntent: "respond",
      runtimeIntentOverride: "respond",
      skipIntentResolution: true,
    },
  );

  bridge.sendCloudMessage = (text?: string) => {
    if (scenario === GLOBAL_CHAT_ATTACHMENT_READ_SCENARIO) {
      return useAppStore.getState().sendMessage(
        text || "请读取附件并确认是否包含 GLOBAL_ATTACHMENT_READ_OK。",
        undefined,
        {
          resolvedIntent: "respond",
          skipIntentResolution: true,
          attachedFilesSnapshot: ["/tmp/e2e-outside-main-debug.log"],
        },
      );
    }

    if (scenario === ORDINARY_CONTINUE_NEW_TURN_SCENARIO) {
      return useAppStore.getState().sendMessage(text || "继续");
    }

    if (scenario === MALFORMED_TOOL_USE_PLAN_SCENARIO) {
      return useAppStore.getState().sendMessage(
        text || "请基于 orders.csv 生成一个数据分析自动化执行计划。",
        undefined,
        {
          resolvedIntent: "plan",
          skipIntentResolution: true,
        },
      );
    }

    if (scenario === LOCAL_FILE_READ_APPROVAL_SCENARIO) {
      return useAppStore.getState().sendMessage(
        text || "请读取外部日志 /tmp/e2e-outside-main-debug.log。",
        undefined,
        {
          resolvedIntent: "analyze",
          skipIntentResolution: true,
        },
      );
    }

    if (
      scenario === EXISTING_PLAN_FOLDER_EXECUTE_SCENARIO ||
      scenario === APPROVED_PLAN_EXECUTION_NO_TOOL_SCENARIO ||
      scenario === APPROVED_PLAN_EXECUTION_REPLAY_SCENARIO
    ) {
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

    if (scenario === OPERATION_APPROVAL_NATURAL_FLOW_SCENARIO) {
      return useAppStore.getState().sendMessage(text || "请修复这个问题。");
    }

    if (scenario === PLAN_OPERATION_APPROVAL_REUSE_SCENARIO) {
      return useAppStore.getState().sendMessage(
        text || "请修复 CSV 导入后图表不显示。",
        undefined,
        {
          resolvedIntent: "plan",
          skipIntentResolution: true,
        },
      );
    }

    if (scenario === UNITY_MCP_OPTIONS_PRIORITY_SCENARIO) {
      return useAppStore.getState().sendMessage(
        text || "请在 Unity 场景下先给我可点击选项。",
        undefined,
        {
          resolvedIntent: "respond",
          skipIntentResolution: true,
          commandDirective: {
            kind: "unity",
            action: "code",
            source: "debug",
          },
        },
      );
    }

    if (scenario === UNITY_TOOL_CODE_COMPAT_SCENARIO) {
      return useAppStore.getState().sendMessage(
        text || "请在 Unity 项目里先读取 src 目录定位脚本入口。",
        undefined,
        {
          resolvedIntent: "respond",
          skipIntentResolution: true,
          commandDirective: {
            kind: "unity",
            action: "code",
            source: "debug",
          },
        },
      );
    }

    if (scenario === UNITY_NO_ERROR_ROUTING_SCENARIO) {
      return useAppStore.getState().sendMessage(
        text || "Unity 没有报错，但蛇没有自动移动，请先排查行为问题。",
        undefined,
        {
          resolvedIntent: "respond",
          skipIntentResolution: true,
          commandDirective: {
            kind: "unity",
            action: "code",
            source: "debug",
          },
        },
      );
    }

    return useAppStore.getState().sendMessage(
      text || "请读取 README.md 并告诉我是否包含 fallback-ok。",
      undefined,
      {
        resolvedIntent: "respond",
        skipIntentResolution: true,
      },
    );
  };

  bridge.getSnapshot = () => {
    const state = useAppStore.getState();
    const currentTurn = state.currentTurnId
      ? state.conversationTurns.find((turn) => turn.id === state.currentTurnId) || null
      : null;
    const visibleConversationTurns = state.conversationTurns
      .filter((turn) => turn.uiVisibility !== "internal")
      .map((turn) => ({
        id: turn.id,
        title: turn.title,
        status: turn.status,
        intent: turn.intent,
        displayIntent: turn.displayIntent || turn.intent,
        blockCount: turn.blockIds.length,
      }));
    const agentBlocks = state.taskFlow.filter((block) => block.type === "agent") as any[];
    const optionBlocks = agentBlocks.filter((block) => Array.isArray(block.options) && block.options.length > 0);
    const archivedOptionBlocks = agentBlocks.filter((block) => block.archivedAfterChoice);
    const progressBlocks = state.taskFlow.filter((block) => block.type === "progress") as any[];
    const toolBlocks = state.taskFlow.filter((block) => block.type === "tool") as any[];

    return {
      agentStatus: state.agentStatus,
      isGenerating: state.isGenerating,
      planStage: state.planStage,
      isPlanApproved: state.isPlanApproved,
      planAutoResumeCount: state.planAutoResumeCount,
      planArtifactPaths: state.planArtifacts.map((artifact) => artifact.path),
      planTasks: state.planTasks,
      currentTurnId: currentTurn?.id ?? null,
      currentTurnStatus: currentTurn?.status ?? null,
      currentTurnIntent: currentTurn?.intent ?? null,
      currentTurnDisplayIntent: currentTurn?.displayIntent ?? currentTurn?.intent ?? null,
      pendingRunDecision: state.pendingRunDecision
        ? {
            kind: state.pendingRunDecision.kind,
            suggestedIntent: state.pendingRunDecision.suggestedIntent,
            optionIds: (state.pendingRunDecision.options || []).map((option) => option.id),
            optionLabels: (state.pendingRunDecision.options || []).map((option) => option.label),
          }
        : null,
      conversationTurns: state.conversationTurns.length,
      visibleConversationTurns,
      taskFlowBlocks: state.taskFlow.length,
      taskFlowUserCount: state.taskFlow.filter((block) => block.type === "user").length,
      currentTurnBlockIds: currentTurn?.blockIds || [],
      taskBlockSummaries: state.taskFlow.map((block: any) => ({
        id: block.id,
        turnId: block.turnId,
        type: block.type,
        content: typeof block.content === "string" ? block.content.slice(0, 120) : "",
      })),
      agentTexts: agentBlocks.map((block) => block.content),
      agentBlockDebug: agentBlocks.map((block) => ({
        id: block.id,
        turnId: block.turnId,
        hasOptions: Array.isArray(block.options) && block.options.length > 0,
        optionLabels: Array.isArray(block.options) ? block.options.map((option: any) => option.label) : [],
        archivedAfterChoice: block.archivedAfterChoice === true,
        selectedOption: block.selectedOption || null,
      })),
      optionBlockCount: optionBlocks.length,
      optionLabels: optionBlocks.flatMap((block) => (block.options || []).map((option: any) => option.label)),
      progressBlockCount: progressBlocks.length,
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
  const reviewRunId = "run-e2e-plan-approval-execute-tools-review";
  const userBlockId = useAppStore.getState()._nextTaskId();
  const agentBlockId = useAppStore.getState()._nextTaskId();
  const planArtifacts = [
    {
      kind: "plan" as const,
      path: ".MAIN/plans/plan.md",
      title: "Plan",
      revision: 1,
      updatedAt: now - 1_000,
      content: [
        "# 审批后执行工具回归计划",
        "",
        "## 摘要",
        "- 用户目标：验证 Plan 审批后以新的执行 run 修改源码并运行验证。",
        "",
        "## 已确认证据",
        "- `src/main.js` 是当前 E2E 工作区的可写源码入口。",
        "- 执行 run 需要同时获得 workspace write 与 shell 工具能力。",
        "",
        "## 关键改动",
        "- 修改 `src/main.js`，加入批准执行路径的回归标记。",
        "",
        "## 公共 API / 接口 / 类型",
        "- 不修改公共 API；仅增加内部回归标记。",
        "",
        "## 测试方案",
        "- 运行 `npm run test:workflow-assets` 验证批准后的执行链路。",
        "",
        "## 假设与默认值",
        "- 保持现有启动流程不变。",
      ].join("\n"),
    },
    {
      kind: "tasks" as const,
      path: ".MAIN/plans/tasks.md",
      title: "Tasks",
      revision: 1,
      updatedAt: now,
      content: [
        "# Tasks",
        "",
        "- [ ] 修改 `src/main.js` 加入批准执行回归标记 — 证据: file:src/main.js",
        "- [ ] 运行 `npm run test:workflow-assets` — 证据: cmd:npm run test:workflow-assets",
      ].join("\n"),
    },
  ];
  const approvalIdentity = buildPlanApprovalIdentity(planArtifacts);
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
    harnessRunMarker: {
      schemaVersion: 1,
      runId: reviewRunId,
      instanceId: "e2e-plan-approval-execute-tools-instance",
      sessionKey: `${workspace}:${sessionId}`,
      workspace,
      sessionId,
      turnId,
      status: "paused",
      workflowMode: "plan",
      runtimeIntent: "plan",
      planStage: "ready_to_execute",
      isPlanApproved: false,
      iteration: 1,
      maxIterations: 12,
      messagesLen: 2,
      toolCount: 0,
      latestTool: null,
      latestToolTarget: null,
      activeStreamId: null,
      streamStatus: "closed",
      streamChunkCount: 0,
      streamByteCount: 0,
      streamElapsedMs: 0,
      streamLifecycleStatus: "completed",
      lastStreamError: null,
      startedAt: now - 1_000,
      updatedAt: now,
      closedAt: now,
      closeReason: "plan_review_required",
    },
    activeActionRequest: approvalIdentity
      ? buildPlanReviewActionRequest({
          sessionKey: `${workspace}:${sessionId}`,
          turnId,
          runId: reviewRunId,
          title: "审批后执行工具回归",
          planRevision: approvalIdentity.revision,
          artifactHash: approvalIdentity.artifactHash,
          artifactPaths: approvalIdentity.artifactPaths,
          now,
        })
      : null,
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
    planArtifacts,
    planTasks: [
      {
        id: "plan-approval-task-mutation",
        text: "修改 `src/main.js` 加入批准执行回归标记",
        status: "pending",
        evidence: [{ kind: "file", value: "src/main.js" }],
      },
      {
        id: "plan-approval-task-validation",
        text: "运行 `npm run test:workflow-assets` 验证批准后的执行链路",
        status: "pending",
        commands: ["npm run test:workflow-assets"],
        evidence: [{ kind: "cmd", value: "npm run test:workflow-assets" }],
      },
    ],
    planExecutionEvidenceLedger: [],
    planExecutionEvidenceCount: 0,
    planStage: "ready_to_execute",
    isPlanApproved: false,
    planApprovalChoice: null,
    currentTurnExecutionConsent: { turnId: null, granted: false },
    // This scenario exercises scoped execution progression, not permission UI.
    // Opt in explicitly so mutation can advance to the validation-focused run.
    autoApproveTools: true,
    autoApproveToolScopes: ["workspace_write", "shell"],
    readOnlyAutoApproveForSession: false,
    showPlanPanel: true,
    showDiff: false,
    showTerminal: false,
    showFilePanel: false,
    rightPanelTab: "plan",
    selectedDiffTaskId: null,
    agentStatus: "pending_review",
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
      resolvedIntent: "respond",
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
  const scenario = getScenarioName();

  if (scenario === PLAN_FLOW_SCENARIO) {
    return (text, sourceTurnId) => {
      const state = useAppStore.getState();
      const turnId = sourceTurnId || state.currentTurnId || "e2e-plan-flow-turn";
      const replyText = String(text || "").trim();
      if (!replyText) return true;

      appendBridgeEvent("plan-adjustment-submitted", { text: replyText, sourceTurnId: turnId });
      const userBlockId = state._nextTaskId();
      const agentBlockId = state._nextTaskId();

      useAppStore.setState((current) => ({
        ...current,
        taskFlow: [
          ...current.taskFlow,
          { id: userBlockId, turnId, type: "user", content: replyText },
          {
            id: agentBlockId,
            turnId,
            type: "agent",
            content: `已收到调整建议：${replyText}。我会先更新 plan.md，然后再次等待确认。`,
            streaming: false,
          },
        ],
        conversationTurns: current.conversationTurns.map((turn) =>
          turn.id === turnId
            ? {
                ...turn,
                status: "awaiting_approval",
                summary: "已收到计划调整建议，等待再次确认。",
                blockIds: [
                  ...turn.blockIds,
                  ...[userBlockId, agentBlockId].filter((id) => !turn.blockIds.includes(id)),
                ],
              }
            : turn
        ),
        currentTurnId: turnId,
        isPlanApproved: false,
        planStage: "design",
        agentStatus: "pending_review",
        isGenerating: false,
      }));
      return true;
    };
  }

  if (scenario !== AWAITING_CHOICE_SCENARIO) return null;

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

function seedUserContextPillsScenario() {
  const bridge = getBridge();
  if (!bridge) return undefined;

  bridge.events = [{ type: "boot" }];
  bridge.savedDocuments = [];
  bridge.completed = true;

  const workspace = "/tmp/e2e-user-context-pills";
  const sessionId = 999701;
  const turnId = "e2e-user-context-pills-turn";
  const now = Date.now();
  const previewDataUrl =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";
  const userBlockId = useAppStore.getState()._nextTaskId();
  const agentBlockId = useAppStore.getState()._nextTaskId();

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
      [workspace]: [
        {
          id: sessionId,
          title: "E2E User Context Pills",
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
      {
        id: userBlockId,
        turnId,
        type: "user",
        content: "请结合 @ 文件、附件和截图检查逻辑。",
        images: [previewDataUrl],
        contextItems: [
          {
            id: "mention:/tmp/e2e-user-context-pills/src/App.tsx",
            kind: "mention",
            label: "src/App.tsx",
            path: "/tmp/e2e-user-context-pills/src/App.tsx",
            status: "ready",
          },
          {
            id: "attachment:/tmp/e2e-user-context-pills/data/report.csv",
            kind: "attachment",
            label: "report.csv",
            path: "/tmp/e2e-user-context-pills/data/report.csv",
            status: "failed",
          },
          {
            id: "image:0",
            kind: "image",
            label: "截图 1",
            status: "ready",
            previewDataUrl,
          },
          {
            id: "image:restored",
            kind: "image",
            label: "截图 2",
            status: "ready",
          },
        ],
      },
      {
        id: agentBlockId,
        turnId,
        type: "agent",
        content: "已接收文件和截图上下文。",
        streaming: false,
      },
    ],
    agentMessages: [
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: previewDataUrl } },
          {
            type: "text",
            text: [
              "```App.tsx",
              "[attached_file]",
              "path: /tmp/e2e-user-context-pills/src/App.tsx",
              "export const ready = true;",
              "```",
              "",
              "请结合 @ 文件、附件和截图检查逻辑。",
            ].join("\n"),
          },
        ],
      },
    ],
    conversationTurns: [
      {
        id: turnId,
        userPrompt: "请结合 @ 文件、附件和截图检查逻辑。",
        title: "E2E User Context Pills",
        intent: "respond",
        mode: "chat",
        status: "done",
        summary: "已接收上下文。",
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
    rightPanelTab: "plan",
    agentStatus: "idle",
    isGenerating: false,
  }));

  bindBridgeSnapshot(USER_CONTEXT_PILLS_SCENARIO);

  const cleanup = () => {
    bridge.initialized = false;
  };

  bridge.cleanup = cleanup;
  return cleanup;
}

function seedSubagentsPanelScenario() {
  const bridge = getBridge();
  if (!bridge) return undefined;

  bridge.events = [{ type: "boot" }];
  bridge.savedDocuments = [];
  bridge.completed = true;

  const workspace = "/tmp/e2e-subagents-panel";
  const sessionId = 999702;
  const turnId = "e2e-subagents-panel-turn";
  const now = Date.now();
  const requestedTheme = typeof window !== "undefined"
    ? new URLSearchParams(window.location.search).get("theme")
    : null;
  const themeMode = requestedTheme === "light" || requestedTheme === "black" ? requestedTheme : "dark";
  const userBlockId = useAppStore.getState()._nextTaskId();
  const agentBlockId = useAppStore.getState()._nextTaskId();
  const baseSubagent = {
    parentTurnId: turnId,
    threadId: `${workspace}:${sessionId}`,
    role: "explorer",
    profile: "local" as const,
    provider: "OMLX",
    model: "qwen3.6-35b-a3b",
  };

  useAppStore.setState((state) => ({
    ...state,
    config: {
      ...state.config,
      language: "zh",
      workflowMode: "chat",
      activeProfile: "local",
      themeMode,
      local: {
        ...state.config.local,
        provider: "OMLX",
        model: "qwen3.6-35b-a3b",
      },
      sessionRecordingEnabled: false,
    },
    currentWorkspace: workspace,
    selectedWorkspace: workspace,
    sessionsByWorkspace: {
      [workspace]: [{
        id: sessionId,
        title: "E2E Subagents Panel",
        date: new Date(now).toISOString(),
        active: true,
        storageStatus: "temporary",
        recordingDisabled: true,
        messages: [],
      }],
    },
    currentSessionId: sessionId,
    selectedMainModeKey: "main_mode",
    selectedNexusModeKey: "nexus_general",
    taskFlow: [
      { id: userBlockId, turnId, type: "user", content: "并行检查事件协议与右侧面板。" },
      { id: agentBlockId, turnId, type: "agent", content: "已委派两个只读子智能体并收集执行状态。", streaming: false },
    ],
    conversationTurns: [{
      id: turnId,
      userPrompt: "并行检查事件协议与右侧面板。",
      title: "子智能体执行检查",
      intent: "analyze",
      mode: "chat",
      status: "done",
      summary: "已完成一个子智能体，另一个仍在读取代码。",
      blockIds: [userBlockId, agentBlockId],
      collapsed: false,
      createdAt: now - 20_000,
    }],
    currentTurnId: turnId,
    runtimeEvents: [
      {
        schemaVersion: MAIN_THREAD_EVENT_SCHEMA_VERSION,
        type: "subagent.created",
        threadId: baseSubagent.threadId,
        turnId,
        timestampMs: now - 18_000,
        subagent: {
          ...baseSubagent,
          id: "subagent-euler",
          name: "Euler",
          objective: "检查 runtime event 的创建、更新与关闭投影。",
          status: "queued",
          createdAt: now - 18_000,
          updatedAt: now - 18_000,
        },
      },
      {
        schemaVersion: MAIN_THREAD_EVENT_SCHEMA_VERSION,
        type: "subagent.updated",
        threadId: baseSubagent.threadId,
        turnId,
        timestampMs: now - 12_000,
        subagentId: "subagent-euler",
        patch: {
          status: "completed",
          startedAt: now - 17_000,
          completedAt: now - 12_000,
          updatedAt: now - 12_000,
          summary: "事件投影保持完成状态，并单独记录 closedAt。",
          progress: { phase: "done", title: "执行完成", completedToolCalls: 2 },
        },
        activity: {
          id: "euler-activity-1",
          timestampMs: now - 12_000,
          status: "completed",
          title: "返回摘要",
          tool: "read_file",
          target: "src/lib/turnEvents.ts",
        },
      },
      {
        schemaVersion: MAIN_THREAD_EVENT_SCHEMA_VERSION,
        type: "subagent.closed",
        threadId: baseSubagent.threadId,
        turnId,
        timestampMs: now - 11_500,
        subagentId: "subagent-euler",
        closedAt: now - 11_500,
        reason: "completed",
      },
      {
        schemaVersion: MAIN_THREAD_EVENT_SCHEMA_VERSION,
        type: "subagent.created",
        threadId: baseSubagent.threadId,
        turnId,
        timestampMs: now - 8_000,
        subagent: {
          ...baseSubagent,
          id: "subagent-mendel",
          name: "Mendel",
          role: "reviewer",
          objective: "检查 ChatArea 点击提示与 RightPanel 详情联动。",
          status: "running",
          createdAt: now - 8_000,
          updatedAt: now - 2_000,
          startedAt: now - 7_500,
          progress: {
            phase: "tool",
            title: "正在执行 read_file",
            tool: "read_file",
            target: "src/components/ChatArea.tsx",
            completedToolCalls: 1,
          },
        },
      },
      {
        schemaVersion: MAIN_THREAD_EVENT_SCHEMA_VERSION,
        type: "subagent.updated",
        threadId: baseSubagent.threadId,
        turnId,
        timestampMs: now - 2_000,
        subagentId: "subagent-mendel",
        patch: {
          status: "running",
          updatedAt: now - 2_000,
          progress: {
            phase: "tool",
            title: "正在执行 read_file",
            tool: "read_file",
            target: "src/components/ChatArea.tsx",
            completedToolCalls: 1,
          },
        },
        activity: {
          id: "mendel-activity-1",
          timestampMs: now - 2_000,
          status: "running",
          title: "开始工具调用",
          tool: "read_file",
          target: "src/components/ChatArea.tsx",
        },
      },
    ],
    input: "",
    planArtifacts: [],
    planTasks: [],
    planExecutionEvidenceLedger: [],
    planStage: "idle",
    isPlanApproved: false,
    showPlanPanel: false,
    showDiff: false,
    showTerminal: false,
    showFilePanel: false,
    rightPanelTab: "plan",
    selectedSubagentId: null,
    agentStatus: "idle",
    isGenerating: false,
  }));

  bindBridgeSnapshot(SUBAGENTS_PANEL_SCENARIO);
  const cleanup = () => { bridge.initialized = false; };
  bridge.cleanup = cleanup;
  return cleanup;
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

  try {
    bridge.initialized = true;
    bridge.scenario = scenario;
    bindCloudServerBridgeControls();

  if (scenario === PLAN_FLOW_SCENARIO) {
    return seedPlanFlowScenario();
  }

  if (scenario === PLAN_QUICK_REPLY_APPROVAL_SCENARIO) {
    return seedPlanQuickReplyApprovalScenario();
  }

  if (scenario === PLAN_QUICK_REPLY_MATERIALIZE_GEMMA_SCENARIO) {
    return seedPlanQuickReplyMaterializeScenario("gemma");
  }

  if (scenario === PLAN_QUICK_REPLY_MATERIALIZE_QWEN_SCENARIO) {
    return seedPlanQuickReplyMaterializeScenario("qwen");
  }

  if (scenario === PLAN_RELOAD_RESUME_SCENARIO) {
    return seedPlanReloadResumeScenario();
  }

  if (scenario === DIFF_RELOAD_SUMMARY_SCENARIO) {
    return seedDiffReloadSummaryScenario();
  }

  if (scenario === LIVE_EDIT_DIFF_STEPS_SCENARIO) {
    return seedLiveEditDiffStepsScenario();
  }

  if (scenario === STAGE_CONCLUSION_PRESERVED_SCENARIO) {
    return seedStageConclusionPreservedScenario();
  }

  if (scenario === PLAN_REPLACE_REFRESH_SCENARIO) {
    return seedPlanReplaceRefreshScenario();
  }

  if (scenario === AWAITING_CHOICE_SCENARIO) {
    return seedAwaitingChoiceScenario();
  }

  if (scenario === AWAITING_CHOICE_MIXED_OPTIONS_SCENARIO) {
    return seedAwaitingChoiceMixedOptionsScenario();
  }
  if (scenario === AWAITING_CHOICE_DIAGNOSTIC_REJECTED_SCENARIO) {
    return seedAwaitingChoiceDiagnosticRejectedScenario();
  }

  if (scenario === FEISHU_REMOTE_ANALYSIS_SCENARIO) {
    return seedFeishuRemoteAnalysisScenario();
  }

  if (scenario === READ_CONTEXT_COLLAPSE_SCENARIO) {
    return seedReadContextCollapseScenario();
  }

  if (scenario === READ_CONTEXT_INTERLEAVED_SCENARIO) {
    return seedReadContextInterleavedScenario();
  }

  if (scenario === READ_CONTEXT_AGENT_SEGMENT_SCENARIO) {
    return seedReadContextAgentSegmentScenario();
  }

  if (scenario === READ_CONTEXT_THIN_NARRATION_SCENARIO) {
    return seedReadContextThinNarrationScenario();
  }

  if (scenario === READ_CONTEXT_PERSISTENT_PROGRESS_SCENARIO) {
    return seedReadContextPersistentProgressScenario();
  }

  if (scenario === OPENCODE_TRANSCRIPT_DISPLAY_SCENARIO) {
    return seedOpencodeTranscriptDisplayScenario();
  }

  if (scenario === PROCESS_DISPLAY_SCENARIO) {
    return seedProcessDisplayScenario();
  }

  if (scenario === GAME_STUDIO_ONBOARDING_SCENARIO) {
    return seedGameStudioOnboardingScenario();
  }

  if (scenario === COMPOSER_MAIN_SHORTCUTS_SCENARIO) {
    return seedComposerMainShortcutsScenario();
  }

  if (scenario === GAME_STUDIO_PLAN_SHORTCUTS_SCENARIO) {
    return seedGameStudioPlanShortcutsScenario();
  }

  if (isCloudSettingsScenario(scenario)) {
    return seedCloudSettingsScenario(scenario, {
      bridge,
      store: useAppStore,
      readSeedCount,
      incrementSeedCount,
    });
  }

  if (scenario === STREAMING_TIMER_SCENARIO) {
    return seedStreamingTimerScenario();
  }

  if (scenario === COMPOSER_RUNNING_GUIDANCE_SCENARIO) {
    return seedComposerRunningGuidanceScenario();
  }

  if (scenario === STREAMING_RESPONSIVENESS_SCENARIO) {
    return seedStreamingResponsivenessScenario();
  }

  if (scenario === LOCAL_PLAN_SLOW_FIRST_TOKEN_SCENARIO) {
    return seedLocalPlanSlowFirstTokenScenario();
  }

  if (scenario === REAL_OMLX_PLAN_FLOW_SCENARIO) {
    return seedRealOmlxPlanFlowScenario();
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

  if (scenario === PLAN_OPERATION_APPROVAL_REUSE_SCENARIO) {
    return seedCloudToolProtocolScenario(PLAN_OPERATION_APPROVAL_REUSE_SCENARIO);
  }

  if (scenario === EXECUTE_QUICK_REPLY_RUNTIME_SCENARIO) {
    return seedCloudToolProtocolScenario(EXECUTE_QUICK_REPLY_RUNTIME_SCENARIO);
  }

  if (scenario === OPERATION_APPROVAL_NATURAL_FLOW_SCENARIO) {
    return seedCloudToolProtocolScenario(OPERATION_APPROVAL_NATURAL_FLOW_SCENARIO);
  }

  if (scenario === GAME_STUDIO_EXECUTE_REPLY_SCENARIO) {
    return seedCloudToolProtocolScenario(GAME_STUDIO_EXECUTE_REPLY_SCENARIO);
  }

  if (scenario === UNITY_MCP_OPTIONS_PRIORITY_SCENARIO) {
    return seedCloudToolProtocolScenario(UNITY_MCP_OPTIONS_PRIORITY_SCENARIO);
  }

  if (scenario === UNITY_TOOL_CODE_COMPAT_SCENARIO) {
    return seedCloudToolProtocolScenario(UNITY_TOOL_CODE_COMPAT_SCENARIO);
  }

  if (scenario === UNITY_NO_ERROR_ROUTING_SCENARIO) {
    return seedCloudToolProtocolScenario(UNITY_NO_ERROR_ROUTING_SCENARIO);
  }

  if (scenario === PSEUDO_TOOL_CALL_RECOVERY_SCENARIO) {
    return seedCloudToolProtocolScenario(PSEUDO_TOOL_CALL_RECOVERY_SCENARIO);
  }

  if (scenario === MALFORMED_TOOL_USE_PLAN_SCENARIO) {
    return seedCloudToolProtocolScenario(MALFORMED_TOOL_USE_PLAN_SCENARIO);
  }
  if (scenario === PLAN_CLOSURE_GUARD_EMPTY_SCENARIO) {
    return seedLocalPlanClosureGuardEmptyScenario();
  }

  if (scenario === EXISTING_PLAN_FOLDER_EXECUTE_SCENARIO) {
    return seedCloudToolProtocolScenario(EXISTING_PLAN_FOLDER_EXECUTE_SCENARIO);
  }

  if (scenario === APPROVED_PLAN_EXECUTION_NO_TOOL_SCENARIO) {
    return seedCloudToolProtocolScenario(APPROVED_PLAN_EXECUTION_NO_TOOL_SCENARIO);
  }

  if (scenario === APPROVED_PLAN_EXECUTION_REPLAY_SCENARIO) {
    return seedCloudToolProtocolScenario(APPROVED_PLAN_EXECUTION_REPLAY_SCENARIO);
  }

  if (scenario === EXECUTE_MAX_ITERATIONS_CHECKPOINT_SCENARIO) {
    return seedCloudToolProtocolScenario(EXECUTE_MAX_ITERATIONS_CHECKPOINT_SCENARIO);
  }

  if (scenario === ORDINARY_CONTINUE_NEW_TURN_SCENARIO) {
    return seedCloudToolProtocolScenario(ORDINARY_CONTINUE_NEW_TURN_SCENARIO);
  }

  if (scenario === LOCAL_FILE_READ_APPROVAL_SCENARIO) {
    return seedCloudToolProtocolScenario(LOCAL_FILE_READ_APPROVAL_SCENARIO);
  }

  if (scenario === PROGRESS_NARRATION_TOOL_FLOW_SCENARIO) {
    return seedCloudToolProtocolScenario(PROGRESS_NARRATION_TOOL_FLOW_SCENARIO);
  }

  if (scenario === GLOBAL_CHAT_TOOL_SCOPE_SCENARIO) {
    return seedCloudToolProtocolScenario(GLOBAL_CHAT_TOOL_SCOPE_SCENARIO);
  }

  if (scenario === GLOBAL_CHAT_ATTACHMENT_READ_SCENARIO) {
    return seedCloudToolProtocolScenario(GLOBAL_CHAT_ATTACHMENT_READ_SCENARIO);
  }

  if (scenario === PLAN_APPROVAL_EXECUTE_TOOLS_SCENARIO) {
    return seedPlanApprovalExecuteToolsScenario();
  }

  if (scenario === SESSION_AUTO_CREATE_SCENARIO) {
    return seedSessionAutoCreateScenario();
  }

  if (scenario === TOP_ISLAND_EXECUTION_PROGRESS_SCENARIO) {
    return seedExecutionCapsuleExecutionProgressScenario();
  }

  if (scenario === TOP_ISLAND_PLAN_TASK_PROGRESS_SCENARIO) {
    return seedExecutionCapsulePlanTaskProgressScenario();
  }

  if (scenario === TOP_ISLAND_STRICT_EVIDENCE_PROGRESS_SCENARIO) {
    return seedExecutionCapsuleStrictEvidenceProgressScenario();
  }

  if (scenario === TOP_ISLAND_PENDING_TOOL_REVIEW_SCENARIO) {
    return seedExecutionCapsulePendingToolReviewScenario();
  }

  if (scenario === TOP_ISLAND_ORPHAN_PENDING_REVIEW_SCENARIO) {
    return seedExecutionCapsuleOrphanPendingReviewScenario();
  }

  if (scenario === TOP_ISLAND_PANEL_STABILITY_SCENARIO) {
    return seedExecutionCapsulePanelStabilityScenario();
  }

  if (scenario === GAME_STUDIO_TOOL_GROUP_COLLAPSE_SCENARIO) {
    return seedGameStudioToolGroupScenario("executing");
  }

  if (scenario === GAME_STUDIO_AWAITING_CHOICE_SCENARIO) {
    return seedGameStudioToolGroupScenario("awaiting_input");
  }

  if (scenario === CAPSULE_MODEL_EXPLANATION_SCENARIO) {
    return seedCapsuleProcessScenario("model");
  }

  if (scenario === CAPSULE_PROGRESS_ONLY_SCENARIO) {
    return seedCapsuleProcessScenario("progress");
  }

  if (scenario === GOAL_CAPSULE_SCENARIO) {
    return seedGoalCapsuleScenario();
  }

  if (scenario === USER_CONTEXT_PILLS_SCENARIO) {
    return seedUserContextPillsScenario();
  }

  if (scenario === SUBAGENTS_PANEL_SCENARIO) {
    return seedSubagentsPanelScenario();
  }

  
  if (scenario === SIDEBAR_REMOVE_LAST_WORKSPACE_SCENARIO) {
    return seedSidebarRemoveLastWorkspaceScenario();
  }

    bridge.initialized = false;
    return undefined;
  } catch (error) {
    // A synchronous seed failure must not leave a bridge that claims to be
    // initialized while its scenario controls were never installed.
    bridge.initialized = false;
    bridge.initializationError = error instanceof Error ? error.message : String(error);
    throw error;
  }
}
