import { useRef, useEffect, useCallback, useMemo, useState } from "react";
import { open } from '@tauri-apps/plugin-dialog';
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getVersion } from "@tauri-apps/api/app";
import { getCurrentWebview } from "@tauri-apps/api/webview";

import Sidebar from "./components/Sidebar";
import ChatArea from "./components/ChatArea";
import FilePanel from "./components/FilePanel";
import RightPanel from "./components/RightPanel";
import SettingsModal from "./components/SettingsModal";
import SkillsModal from "./components/SkillsModal";
import ThemeStyles from "./components/ThemeStyles";
import {
  useAppStore,
  translations,
  THEMES,
  GLOBAL_CHAT_KEY,
  buildFeishuApprovalStatusCard,
  type TaskBlock,
  type FeishuPendingApproval,
  resolveSessionWorkspaceKey,
  resolveSessionRuntimeKey,
  sanitizeAgentMessagesForPersist,
  sanitizeTaskBlocksForPersist,
  syncTaskIdCounterFromBlocks,
  normalizeInterruptedConversationTurnsForRestore,
} from "./store/useAppStore";
import { getE2EQuickReplyHandler, initializeE2EScenarios } from "./lib/e2e";
import {
  deleteChatSessionTempFiles,
  deleteProjectSession,
  listProjectSessions,
  loadProjectSession,
  loadProjectSessionMeta,
  loadProjectSessionPage,
  type ProjectSessionPage,
  readAttachmentImageDataUrl,
  rebuildProjectSessionsIndex,
  saveProjectSession,
  setWorkspaceRoot as setWorkspaceRootIpc,
  canonicalizeWorkspacePath,
  writeFile,
} from "./lib/ipc";
import {
  type AttachmentPickerResult,
  classifyAttachment,
  createAttachedFileDescriptor,
  getAttachmentDisplayName,
  SUPPORTED_ATTACHMENT_EXTENSIONS,
} from "./lib/attachments";
import { normalizeStudioAgentKey } from "./lib/gameStudioCatalog";
import { normalizeContextMemoryState } from "./lib/contextMemory";
import { MAIN_MODE_KEYS, mapLegacyNexusModeToMainMode, mapMainModeToLegacyNexusMode } from "./lib/mainModes";
import { createDefaultImageStudioRuntime, normalizeImageStudioRuntime } from "./lib/imageStudio";
import {
  resolveSessionModeAffinity,
  type SessionModeAffinity,
  type SessionModeAffinityLike,
} from "./lib/imageStudioSessions";
import { resolveConversationTurnIntent } from "./lib/runIntent";
import { resolvePlanApprovalQuickReplyAction } from "./lib/planControl";
import { materializePlanArtifactFromVisibleText } from "./lib/planMaterialization";
import { runAfterNextPaint } from "./lib/uiScheduling";
import { checkForMainUpdate, installMainUpdate, type MainUpdateInfo, type MainUpdateProgress } from "./lib/updater";
import { getPlanArtifactTitle, normalizeConversationDisplayTitle, type ReplyOption, type RightPanelTab } from "./lib/workflowModels";
import { appendDebugLog } from "./lib/debugLog";
import { applyAppIconVariant } from "./lib/appIcon";
import { safeConfirmAsync } from "./lib/safeConfirm";
import { resolveVisiblePendingToolReview } from "./lib/pendingToolReview";
import {
  buildFeishuMarkdownCard,
  createFeishuPairedUserFromMessage,
  createFeishuPairingRequest,
  createFeishuRemoteSessionTitle,
  findFeishuPairedUser,
  normalizeImAdaptersConfig,
  parseFeishuTextCommand,
  resolveFeishuRemoteIntentOverride,
  upsertFeishuPairedUser,
  type FeishuAdapterEvent,
  type FeishuCardActionEvent,
  type FeishuInboundMessage,
} from "./lib/imAdapters";

function normalizeStoredRightPanelTab(value: unknown): RightPanelTab {
  return value === "diff" || value === "terminal" || value === "plan"
    ? value
    : "plan";
}

function getLatestVisibleAgentTextForTurn(taskFlow: TaskBlock[], turnId?: string | null): string {
  if (!turnId) return "";
  for (let index = taskFlow.length - 1; index >= 0; index--) {
    const block = taskFlow[index];
    if (block.turnId !== turnId || block.type !== "agent" || block.hiddenProcess) continue;
    const content = String(block.content || "").trim();
    if (content) return content;
  }
  return "";
}

function archiveReplyOptionsForTurn(taskFlow: TaskBlock[], turnId: string | undefined, selectedOption?: string): TaskBlock[] {
  if (!turnId) return taskFlow;
  const selected = String(selectedOption || "").trim();
  return taskFlow.map((block) =>
    block.turnId === turnId &&
    block.type === "agent" &&
    Array.isArray(block.options) &&
    block.options.length > 0
      ? {
          ...block,
          options: undefined,
          archivedAfterChoice: true,
          archivedProposal: block.options.some((option: any) =>
            option?.action === "approve_operation_once" ||
            option?.action === "execute_once" ||
            option?.source === "proposal_follow_up" ||
            option?.source === "operation_approval"
          ) || undefined,
          ...(selected ? { selectedOption: selected } : {}),
        }
      : block,
  );
}

function appendPlanQuickReplyBlockedNotice(sourceTurnId: string | undefined, reason?: string, selectedOption?: string): void {
  const state = useAppStore.getState();
  const language = state.config.language === "en" ? "en" : "zh";
  const turnId = sourceTurnId || state.currentTurnId || undefined;
  const blockId = state._nextTaskId();
  const optionBlocks = turnId
    ? state.taskFlow.filter((block) =>
        block.turnId === turnId &&
        block.type === "agent" &&
        Array.isArray(block.options) &&
        block.options.length > 0
      ).length
    : 0;
  const content = language === "en"
    ? `Plan approval was blocked because MAIN could not find or materialize a reviewable .MAIN/plans/plan.md artifact${reason ? ` (${reason})` : ""}. Ask the model to update plan.md, then approve the plan again.`
    : `已阻止计划批准：MAIN 没有找到可审批的 .MAIN/plans/plan.md，也无法从上一条方案自动物化${reason ? `（${reason}）` : ""}。请先让模型更新 plan.md，再批准执行。`;

  appendDebugLog("warn", "ui.quickReply_plan_approval_blocked", {
    sourceTurnId: turnId ?? null,
    reason: reason ?? null,
    archivedOptionBlocks: optionBlocks,
  });

  useAppStore.setState((s) => ({
    input: "",
    contextMentions: [],
    attachedFiles: [],
    currentTurnExecutionConsent: { turnId: null, granted: false },
    taskFlow: [
      ...archiveReplyOptionsForTurn(s.taskFlow, turnId, selectedOption),
      {
        id: blockId,
        ...(turnId ? { turnId } : {}),
        type: "system",
        content,
        variant: "plan_quality_gate",
      },
    ],
    conversationTurns: turnId
      ? s.conversationTurns.map((turn) =>
          turn.id === turnId
            ? {
                ...turn,
                status: "awaiting_input",
                blockIds: turn.blockIds.includes(blockId) ? turn.blockIds : [...turn.blockIds, blockId],
              }
            : turn,
        )
      : s.conversationTurns,
  }));
}

async function materializePlanQuickReplyAndApprove(params: {
  sourceTurnId?: string;
  approvalText: string;
  visiblePlanText: string;
}): Promise<void> {
  const state = useAppStore.getState();
  const sourceTurn = params.sourceTurnId
    ? state.conversationTurns.find((turn) => turn.id === params.sourceTurnId) || null
    : null;
  const materialized = materializePlanArtifactFromVisibleText({
    visibleText: params.visiblePlanText,
    planStage: state.planStage,
    userGoal: sourceTurn?.userPrompt || "",
    evidence: [
      state.config.language === "en"
        ? "The user explicitly approved the visible plan text in ChatArea; materialize that reviewed text before execution."
        : "用户已在聊天区明确批准当前可见方案；先将这份已审阅文本物化为计划文件再进入执行。",
    ],
  });

  if (!materialized.ok || !materialized.path || !materialized.content || !materialized.kind) {
    appendPlanQuickReplyBlockedNotice(params.sourceTurnId, materialized.reason || "quality_gate", params.approvalText);
    return;
  }

  try {
    await writeFile(materialized.path, materialized.content, state.currentWorkspace || undefined);
    const latest = useAppStore.getState();
    latest.upsertPlanArtifact({
      kind: materialized.kind,
      path: materialized.path,
      title: getPlanArtifactTitle(materialized.kind, latest.config.language === "en" ? "en" : "zh"),
      content: materialized.content,
      updatedAt: Date.now(),
    });
    appendDebugLog("info", "ui.quickReply_plan_materialized", {
      sourceTurnId: params.sourceTurnId ?? null,
      path: materialized.path,
      contentChars: materialized.content.length,
    });
    useAppStore.setState({
      ...(params.sourceTurnId ? { currentTurnId: params.sourceTurnId } : {}),
      input: "",
      contextMentions: [],
      attachedFiles: [],
    });
    runAfterNextPaint(() => {
      useAppStore.getState().approvePlan(params.approvalText);
    });
  } catch (error) {
    appendPlanQuickReplyBlockedNotice(
      params.sourceTurnId,
      error instanceof Error ? error.message : String(error || "write_failed"),
      params.approvalText,
    );
  }
}

type MainUpdateStatus = "idle" | "checking" | "upToDate" | "available" | "downloading" | "installing" | "error";

type PendingSessionDelete = {
  scopeKey: string;
  id: number;
  title: string;
  workspaceLabel: string;
} | null;

type ModelRuntimeLock = {
  isLocked: boolean;
  activeProfile?: "local" | "cloud";
  activeCloudServerId?: string;
  reason?: string;
};

const MAIN_UPDATE_LAST_CHECK_KEY = "main:lastDesktopUpdateCheckAt";
const MAIN_UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const MAIN_UPDATE_STARTUP_DELAY_MS = 3000;

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error || "");
}

function summarizeUpdateNotes(notes: string, maxLength = 500) {
  const normalized = notes.replace(/\r/g, "").trim();
  if (!normalized) return "";
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength).trimEnd()}…`;
}

function buildSessionRuntimeSnapshotFromState(state: any) {
  const taskFlow = sanitizeTaskBlocksForPersist(state.taskFlow || []);
  const selectedMainModeKey = mapLegacyNexusModeToMainMode(
    state.selectedMainModeKey || state.selectedNexusModeKey,
  );
  return {
    runtimeEventSchemaVersion: 1,
    runtimeEvents: state.runtimeEvents || [],
    harnessRunMarker: state.harnessRunMarker || null,
    taskFlow,
    agentMessages: sanitizeAgentMessagesForPersist(state.agentMessages || []),
    contextMemoryState: normalizeContextMemoryState(state.contextMemoryState),
    conversationTurns: normalizeInterruptedConversationTurnsForRestore(state.conversationTurns, taskFlow),
    currentTurnId: state.currentTurnId ?? null,
    selectedMainModeKey,
    selectedNexusModeKey: mapMainModeToLegacyNexusMode(selectedMainModeKey),
    sessionModeAffinity: resolveSessionModeAffinity(state as SessionModeAffinityLike, selectedMainModeKey),
    imageStudio: normalizeImageStudioRuntime(state.imageStudio),
    activeStudioAgentKey: state.activeStudioAgentKey,
    gameStudioInitialized: state.gameStudioInitialized,
    pendingSlashCommand: state.pendingSlashCommand ?? null,
    planArtifacts: state.planArtifacts || [],
    planTasks: state.planTasks || [],
    planExecutionEvidenceLedger: state.planExecutionEvidenceLedger || [],
    planExecutionEvidenceCount: state.planExecutionEvidenceCount ?? 0,
    planStage: state.planStage ?? "idle",
    isPlanApproved: state.isPlanApproved === true,
    planApprovalChoice: state.planApprovalChoice ?? null,
    showPlanPanel: state.showPlanPanel === true,
    showDiff: state.showDiff === true,
    showTerminal: state.showTerminal === true,
    showFilePanel: state.showFilePanel === true,
    rightPanelTab: normalizeStoredRightPanelTab(state.rightPanelTab),
    selectedDiffTaskId: state.selectedDiffTaskId ?? null,
    autoApproveTools: state.autoApproveTools === true,
    autoApproveToolScopes: state.autoApproveToolScopes || [],
    queuedUserMessage: state.queuedUserMessage ?? null,
    activeGuidance: state.activeGuidance ?? null,
  };
}

function buildStoredSessionSnapshot(
  state: any,
  scopeKey: string,
  sessionId: number,
  transcriptCache?: Map<string, SessionTranscriptCacheEntry>,
) {
  const session = (state.sessionsByWorkspace[scopeKey] || []).find((item: any) => item.id === sessionId);
  if (!session) return null;
  const sessionKey = resolveSessionRuntimeKey(scopeKey, sessionId);
  const cachedTranscript = sessionKey ? transcriptCache?.get(sessionKey) || null : null;
  const loadedTurnCount = Array.isArray(state.conversationTurns) ? state.conversationTurns.length : 0;
  const totalTurns = Number(cachedTranscript?.totalTurns ?? session.turnCount ?? loadedTurnCount) || loadedTurnCount;
  const transcriptPartial = totalTurns > loadedTurnCount;
  const runtimeSnapshot = buildSessionRuntimeSnapshotFromState(state);
  return {
    ...session,
    messages: sanitizeTaskBlocksForPersist(state.taskFlow || []),
    transcriptPartial,
    transcriptLoadedTurns: loadedTurnCount,
    transcriptTotalTurns: totalTurns,
    runtimeSnapshot: {
      ...runtimeSnapshot,
      transcriptPartial,
      transcriptLoadedTurns: loadedTurnCount,
      transcriptTotalTurns: totalTurns,
    },
  };
}

function hasPersistableSessionTranscript(session: any): boolean {
  const messages = Array.isArray(session?.messages) ? session.messages : [];
  const turns = Array.isArray(session?.runtimeSnapshot?.conversationTurns)
    ? session.runtimeSnapshot.conversationTurns
    : [];
  const runtimeTaskFlow = Array.isArray(session?.runtimeSnapshot?.taskFlow)
    ? session.runtimeSnapshot.taskFlow
    : [];
  return messages.length > 0 || turns.length > 0 || runtimeTaskFlow.length > 0;
}

function hasRecoverableSessionTranscript(session: any): boolean {
  if (hasPersistableSessionTranscript(session)) return true;
  const agentMessages = Array.isArray(session?.runtimeSnapshot?.agentMessages)
    ? session.runtimeSnapshot.agentMessages
    : [];
  return agentMessages.some((message: any) => {
    const role = String(message?.role || "").trim();
    const content = String(message?.content ?? message?.text ?? message?.message ?? "").trim();
    return role !== "system" && content.length > 0;
  });
}

function hasStoredSessionDetailPointer(session: any): boolean {
  return (
    session?.storageStatus === "ok" ||
    Number(session?.turnCount || 0) > 0 ||
    Number(session?.messageCount || 0) > 0
  );
}

function hasSessionTranscriptCounts(session: any): boolean {
  return Number(session?.turnCount || 0) > 0 || Number(session?.messageCount || 0) > 0;
}

function isEmptyTemporarySession(session: any): boolean {
  return (
    session?.storageStatus === "temporary" &&
    !hasRecoverableSessionTranscript(session) &&
    !hasSessionTranscriptCounts(session) &&
    !(Array.isArray(session?.messages) && session.messages.length > 0)
  );
}

function isMissingSessionMeta(session: any): boolean {
  if (!session) return false;
  const title = String(session.title || "");
  return (
    session.storageStatus === "missing" ||
    (
      title === "Missing Session" &&
      !String(session.date || "").trim() &&
      !hasRecoverableSessionTranscript(session) &&
      !hasSessionTranscriptCounts(session)
    )
  );
}

function shouldDiscardMissingSession(session: any): boolean {
  return (
    isMissingSessionMeta(session) &&
    !hasRecoverableSessionTranscript(session) &&
    !hasSessionTranscriptCounts(session) &&
    !(Array.isArray(session?.messages) && session.messages.length > 0)
  );
}

function sessionSortTime(session: any): number {
  const candidates = [
    session?.updatedAtMs,
    session?.updatedAt,
    session?.date,
    session?.id,
  ];
  for (const value of candidates) {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      return value;
    }
    if (typeof value === "string" && value.trim()) {
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) return parsed;
      const numeric = Number(value);
      if (Number.isFinite(numeric) && numeric > 0) return numeric;
    }
  }
  return 0;
}

function sortSessionsByRecent(sessions: any[]): any[] {
  return [...(sessions || [])].sort((a, b) => sessionSortTime(b) - sessionSortTime(a));
}

function mergeDiskSessionWithLocal(localSession: any, diskSession: any, selectedId: number | null) {
  const diskId = Number(diskSession?.id);
  const active = selectedId != null ? diskId === selectedId : diskSession.active === true;
  const localAffinity = resolveSessionModeAffinity(localSession as SessionModeAffinityLike, "main_mode");
  const diskAffinity = resolveSessionModeAffinity(diskSession as SessionModeAffinityLike, localAffinity);
  if (shouldDiscardMissingSession(diskSession) && localSession?.storageStatus !== "temporary") {
    return null;
  }
  if (
    localSession?.storageStatus === "temporary" &&
    isMissingSessionMeta(diskSession) &&
    (localSession.active || isEmptyTemporarySession(localSession))
  ) {
    return {
      ...localSession,
      sessionModeAffinity: localAffinity,
      active: selectedId != null ? localSession.id === selectedId : localSession.active === true,
    };
  }
  return {
    ...diskSession,
    sessionModeAffinity: diskAffinity,
    runtimeSnapshot: diskSession?.runtimeSnapshot
      ? {
          ...diskSession.runtimeSnapshot,
          sessionModeAffinity: resolveSessionModeAffinity(
            diskSession.runtimeSnapshot as SessionModeAffinityLike,
            diskAffinity,
          ),
        }
      : diskSession?.runtimeSnapshot,
    active,
  };
}

function hasArrayItems(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0;
}

function compactTextSignature(value: unknown): string {
  const text = typeof value === "string" ? value : "";
  return `${text.length}:${text.slice(-256)}`;
}

function compactBlockListSignature(blocks: unknown): string {
  if (!Array.isArray(blocks) || blocks.length === 0) return "0";
  const visibleBlocks = blocks.length > 80
    ? [...blocks.slice(0, 20), ...blocks.slice(-60)]
    : blocks;
  return [
    blocks.length,
    visibleBlocks.map((block: any) => [
      block?.id ?? "",
      block?.turnId ?? "",
      block?.type ?? "",
      block?.status ?? "",
      block?.streaming === true ? "1" : "0",
      compactTextSignature(block?.content),
      compactTextSignature(block?.summary),
    ].join("~")).join("|"),
  ].join(":");
}

function compactTurnListSignature(turns: unknown): string {
  if (!Array.isArray(turns) || turns.length === 0) return "0";
  const visibleTurns = turns.length > 80
    ? [...turns.slice(0, 20), ...turns.slice(-60)]
    : turns;
  return [
    turns.length,
    visibleTurns.map((turn: any) => [
      turn?.id ?? "",
      turn?.status ?? "",
      turn?.collapsed === true ? "1" : "0",
      Array.isArray(turn?.blockIds) ? turn.blockIds.join(",") : "",
      compactTextSignature(turn?.title),
      compactTextSignature(turn?.summary),
    ].join("~")).join("|"),
  ].join(":");
}

function compactJsonListSignature(items: unknown): string {
  if (!Array.isArray(items) || items.length === 0) return "0";
  const visibleItems = items.length > 40
    ? [...items.slice(0, 10), ...items.slice(-30)]
    : items;
  return [
    items.length,
    visibleItems.map((item) => compactTextSignature(JSON.stringify(item))).join("|"),
  ].join(":");
}

function stableRuntimeSignature(value: unknown): string {
  const snapshot = (value as any)?.runtimeSnapshot || {};
  return JSON.stringify({
    messages: compactBlockListSignature((value as any)?.messages),
    taskFlow: compactBlockListSignature(snapshot.taskFlow),
    agentMessages: compactBlockListSignature(snapshot.agentMessages),
    contextMemoryState: compactTextSignature(JSON.stringify(snapshot.contextMemoryState || null)),
    conversationTurns: compactTurnListSignature(snapshot.conversationTurns),
    currentTurnId: snapshot.currentTurnId ?? null,
    selectedMainModeKey: snapshot.selectedMainModeKey ?? null,
    selectedNexusModeKey: snapshot.selectedNexusModeKey ?? null,
    sessionModeAffinity: snapshot.sessionModeAffinity ?? null,
    imageStudio: compactTextSignature(JSON.stringify(snapshot.imageStudio || null)),
    activeStudioAgentKey: snapshot.activeStudioAgentKey ?? null,
    pendingSlashCommand: snapshot.pendingSlashCommand ?? null,
    planArtifacts: compactJsonListSignature(snapshot.planArtifacts),
    planTasks: compactJsonListSignature(snapshot.planTasks),
    planExecutionEvidenceLedger: compactJsonListSignature(snapshot.planExecutionEvidenceLedger),
    planExecutionEvidenceCount: snapshot.planExecutionEvidenceCount ?? 0,
    planStage: snapshot.planStage ?? null,
    isPlanApproved: snapshot.isPlanApproved === true,
    planApprovalChoice: snapshot.planApprovalChoice ?? null,
    showPlanPanel: snapshot.showPlanPanel === true,
    showDiff: snapshot.showDiff === true,
    showTerminal: snapshot.showTerminal === true,
    showFilePanel: snapshot.showFilePanel === true,
    rightPanelTab: snapshot.rightPanelTab ?? null,
    selectedDiffTaskId: snapshot.selectedDiffTaskId ?? null,
    transcriptPartial: (value as any)?.transcriptPartial === true,
    transcriptLoadedTurns: (value as any)?.transcriptLoadedTurns ?? 0,
    transcriptTotalTurns: (value as any)?.transcriptTotalTurns ?? 0,
  });
}

function markOnlySessionActive(scopeKey: string, id: number) {
  useAppStore.setState((state: any) => ({
    sessionsByWorkspace: {
      ...state.sessionsByWorkspace,
      [scopeKey]: (state.sessionsByWorkspace[scopeKey] || []).map((session: any) => ({
        ...session,
        active: session.id === id,
      })),
    },
    activeSessionByWorkspace: {
      ...state.activeSessionByWorkspace,
      [scopeKey]: id,
    },
  }));
}

function markAllSessionsInactive(scopeKey: string) {
  useAppStore.setState((state: any) => ({
    sessionsByWorkspace: {
      ...state.sessionsByWorkspace,
      [scopeKey]: (state.sessionsByWorkspace[scopeKey] || []).map((session: any) => ({
        ...session,
        active: false,
      })),
    },
  }));
}

function chooseSessionAfterDelete(sessions: any[], deletedId: number) {
  const orderedSessions = sortSessionsByRecent(sessions || []);
  const index = orderedSessions.findIndex((session) => session.id === deletedId);
  const remaining = orderedSessions.filter((session) => session.id !== deletedId);
  if (remaining.length === 0) return null;
  if (index <= 0) return remaining[0] || null;
  return remaining[Math.min(index - 1, remaining.length - 1)] || null;
}

function getSessionDeleteTitle(session: any, language: string): string {
  const fallback = language === "en" ? "Untitled session" : "未命名会话";
  return normalizeConversationDisplayTitle(session?.title || "", language === "en" ? 56 : 42, fallback);
}

function getWorkspaceDeleteLabel(scopeKey: string, workspaces: any[], language: string): string {
  if (scopeKey === GLOBAL_CHAT_KEY) return language === "en" ? "Global Chat" : "全局聊天";
  const workspace = (workspaces || []).find((entry: any) => entry.path === scopeKey);
  const name = String(workspace?.name || scopeKey.split(/[\\/]/).filter(Boolean).pop() || scopeKey);
  return language === "en" ? name : name;
}

function mergeSessionsAfterDelete(
  localSessions: any[],
  deletedId: number,
  diskSessions: any[],
  selectedId: number | null,
) {
  const diskById = new Map(diskSessions.map((session) => [String(session.id), session]));
  const merged: any[] = [];
  for (const localSession of localSessions) {
    if (localSession.id === deletedId) continue;
    if (shouldDiscardMissingSession(localSession)) continue;
    const diskSession = diskById.get(String(localSession.id));
    if (diskSession) {
      const mergedSession = mergeDiskSessionWithLocal(localSession, diskSession, selectedId);
      if (mergedSession) merged.push(mergedSession);
      diskById.delete(String(localSession.id));
    } else if (
      localSession.recordingDisabled ||
      localSession.storageStatus === "temporary" ||
      (Array.isArray(localSession.messages) && localSession.messages.length > 0) ||
      hasRecoverableSessionTranscript(localSession)
    ) {
      merged.push({ ...localSession, active: selectedId != null && localSession.id === selectedId });
    }
  }
  for (const diskSession of diskById.values()) {
    if (diskSession.id !== deletedId && !shouldDiscardMissingSession(diskSession)) {
      merged.push({ ...diskSession, active: selectedId != null && diskSession.id === selectedId });
    }
  }
  return merged;
}

const CLOSED_SESSION_PANEL_STATE = {
  showPlanPanel: false,
  showDiff: false,
  showTerminal: false,
  showFilePanel: false,
  rightPanelTab: "plan" as const,
  selectedDiffTaskId: null,
  fileViewerPath: "",
  fileViewerContent: "",
  fileViewerWindow: null,
  fileViewerError: "",
  fileViewerLoading: false,
};

const SESSION_INITIAL_PAGE_TURNS = 30;
const SESSION_CACHE_LIMIT = 40;
const SESSION_RECOVERY_SKIP_SAVE = "session_recovery_skip_save";

type SessionTranscriptCacheEntry = {
  scopeKey: string;
  sessionId: number;
  taskFlow: TaskBlock[];
  conversationTurns: any[];
  runtimeSnapshot?: any;
  hasMore: boolean;
  nextBeforeTurnIndex: number | null;
  totalTurns: number;
  lastAccessedAt: number;
};

function mergeSessionPage(
  previous: { taskFlow: TaskBlock[]; conversationTurns: any[] } | null,
  page: ProjectSessionPage,
) {
  const blockMap = new Map<string, TaskBlock>();
  for (const block of previous?.taskFlow || []) {
    blockMap.set(String((block as any).id), block);
  }
  for (const block of page.messages || []) {
    blockMap.set(String((block as any).id), block as TaskBlock);
  }

  const turnMap = new Map<string, any>();
  for (const turn of previous?.conversationTurns || []) {
    turnMap.set(String(turn.id), turn);
  }
  for (const turn of page.turns || []) {
    turnMap.set(String(turn.id), turn);
  }

  const taskFlow = Array.from(blockMap.values()).sort((a: any, b: any) => (Number(a.id) || 0) - (Number(b.id) || 0));
  const conversationTurns = Array.from(turnMap.values()).sort((a: any, b: any) => (Number(a.createdAt) || 0) - (Number(b.createdAt) || 0));

  return { taskFlow, conversationTurns };
}

function buildPagedRuntimePatch(entry: SessionTranscriptCacheEntry, fallbackState: any) {
  const restoredTaskFlow = sanitizeTaskBlocksForPersist(entry.taskFlow || []);
  const selectedMainModeKey = mapLegacyNexusModeToMainMode(
    entry.runtimeSnapshot?.selectedMainModeKey ||
      entry.runtimeSnapshot?.selectedNexusModeKey ||
      entry.runtimeSnapshot?.selectedAgentKey,
  );
  return {
    taskFlow: restoredTaskFlow,
    agentMessages: sanitizeAgentMessagesForPersist(entry.runtimeSnapshot?.agentMessages || []),
    contextMemoryState: normalizeContextMemoryState(entry.runtimeSnapshot?.contextMemoryState),
    selectedMainModeKey,
    selectedNexusModeKey: mapMainModeToLegacyNexusMode(selectedMainModeKey),
    sessionModeAffinity: resolveSessionModeAffinity(
      entry.runtimeSnapshot as SessionModeAffinityLike,
      selectedMainModeKey,
    ),
    imageStudio: normalizeImageStudioRuntime(entry.runtimeSnapshot?.imageStudio ?? fallbackState.imageStudio),
    activeStudioAgentKey: normalizeStudioAgentKey(entry.runtimeSnapshot?.activeStudioAgentKey ?? fallbackState.activeStudioAgentKey),
    gameStudioInitialized: entry.runtimeSnapshot?.gameStudioInitialized === true || fallbackState.gameStudioInitialized,
    pendingSlashCommand: entry.runtimeSnapshot?.pendingSlashCommand ?? null,
    conversationTurns: normalizeInterruptedConversationTurnsForRestore(entry.conversationTurns || [], restoredTaskFlow),
    currentTurnId: entry.runtimeSnapshot?.currentTurnId ?? entry.conversationTurns[entry.conversationTurns.length - 1]?.id ?? null,
    currentTurnState: {
      interceptorHandled: false,
      interceptorThought: "",
      lastReportedThought: "",
      lastReportedAssistantText: "",
      capsuleExplanation: null,
      turnId: "",
    },
    agentStatus: "idle" as const,
    isGenerating: false,
    abortController: null,
    pendingReviewResolve: null,
    pendingReviewTaskId: null,
    pendingToolCall: null,
    autoApproveTools: false,
    autoApproveToolScopes: [],
    readOnlyAutoApproveForSession: false,
    planArtifacts: entry.runtimeSnapshot?.planArtifacts || [],
    planTasks: entry.runtimeSnapshot?.planTasks || [],
    planExecutionEvidenceLedger: entry.runtimeSnapshot?.planExecutionEvidenceLedger || [],
    planExecutionEvidenceCount: entry.runtimeSnapshot?.planExecutionEvidenceCount ?? 0,
    planStage: entry.runtimeSnapshot?.planStage ?? "idle",
    isPlanApproved: entry.runtimeSnapshot?.isPlanApproved ?? false,
    planApprovalChoice: entry.runtimeSnapshot?.planApprovalChoice ?? null,
    ...CLOSED_SESSION_PANEL_STATE,
    elapsedTime: 0,
  };
}

// ==========================================
// MAIN APP COMPONENT
// ==========================================
export default function App() {
  const endOfFlowRef = useRef<HTMLDivElement>(null);

  const sessionsByWorkspace = useAppStore((s) => s.sessionsByWorkspace);
  const workspaces = useAppStore((s) => s.workspaces);
  const activeSessionByWorkspace = useAppStore((s) => s.activeSessionByWorkspace);
  const currentWorkspace = useAppStore((s) => s.currentWorkspace);
  const currentSessionId = useAppStore((s) => s.currentSessionId);
  const setCurrentWorkspace = useAppStore((s) => s.setCurrentWorkspace);
  const addWorkspaceEntry = useAppStore((s) => s.addWorkspaceEntry);
  const removeWorkspaceEntry = useAppStore((s) => s.removeWorkspaceEntry);
  const addSession = useAppStore((s) => s.addSession);
  const removeSession = useAppStore((s) => s.removeSession);
  const updateSession = useAppStore((s) => s.updateSession);
  const setCurrentSessionId = useAppStore((s) => s.setCurrentSessionId);
  const allowToolAction = useAppStore((s) => s.allowToolAction);
  const rejectToolAction = useAppStore((s) => s.rejectToolAction);
  const autoApproveTools = useAppStore((s) => s.autoApproveTools);
  const setAutoApproveTools = useAppStore((s) => s.setAutoApproveTools);
  const mcpServers = useAppStore((s) => s.mcpServers);
  const setMcpServers = useAppStore((s) => s.setMcpServers);
  const mcpDiscoveredTools = useAppStore((s) => s.mcpDiscoveredTools);
  const setMcpDiscoveredTools = useAppStore((s) => s.setMcpDiscoveredTools);

  // ── Config ────────────────────────────────────────────────────────────
  const config = useAppStore((s) => s.config);
  const setConfig = useAppStore((s) => s.setConfig);

  const t = translations[config.language] || translations.en;
  const currentTheme = THEMES[config.theme] || THEMES.purple;
  const remoteFeishuQueueRef = useRef<FeishuInboundMessage[]>([]);
  const feishuStartingRef = useRef(false);
  const sessionSaveTimerRef = useRef<number | null>(null);
  const sessionTranscriptCacheRef = useRef<Map<string, SessionTranscriptCacheEntry>>(new Map());
  const sessionRecoveryAttemptRef = useRef<string>("");
  const lastSessionRuntimeSignatureRef = useRef<string>("");
  const sessionRestoreTokenRef = useRef(0);
  const autosaveSuspendedForSessionRef = useRef<string>("");
  const [sessionMigrationReady, setSessionMigrationReady] = useState(false);
  const [pendingSessionDelete, setPendingSessionDelete] = useState<PendingSessionDelete>(null);

  // ── Agent State (from store, replaces all inline implementations) ─────
  const taskFlow = useAppStore((s) => s.taskFlow);
  const runtimeEvents = useAppStore((s) => s.runtimeEvents);
  const harnessRunMarker = useAppStore((s) => s.harnessRunMarker);
  const agentMessages = useAppStore((s) => s.agentMessages);
  const contextMemoryState = useAppStore((s) => s.contextMemoryState);
  const conversationTurns = useAppStore((s) => s.conversationTurns);
  const currentTurnId = useAppStore((s) => s.currentTurnId);
  const planArtifacts = useAppStore((s) => s.planArtifacts);
  const planTasks = useAppStore((s) => s.planTasks);
  const planExecutionEvidenceLedger = useAppStore((s) => s.planExecutionEvidenceLedger);
  const planExecutionEvidenceCount = useAppStore((s) => s.planExecutionEvidenceCount);
  const planStage = useAppStore((s) => s.planStage);
  const isPlanApproved = useAppStore((s) => s.isPlanApproved);
  const showPlanPanel = useAppStore((s) => s.showPlanPanel);
  const showDiff = useAppStore((s) => s.showDiff);
  const showTerminal = useAppStore((s) => s.showTerminal);
  const showFilePanel = useAppStore((s) => s.showFilePanel);
  const rightPanelTab = useAppStore((s) => s.rightPanelTab);
  const selectedDiffTaskId = useAppStore((s) => s.selectedDiffTaskId);
  const pendingSlashCommand = useAppStore((s) => s.pendingSlashCommand);
  const pendingReviewTaskId = useAppStore((s) => s.pendingReviewTaskId);
  const pendingToolCall = useAppStore((s) => s.pendingToolCall);
  const isStreaming = useAppStore((s) => s.isGenerating);
  const agentStatus = useAppStore((s) => s.agentStatus);
  const runtimeBySessionKey = useAppStore((s) => s.runtimeBySessionKey);

  // ── Composer State ────────────────────────────────────────────────────
  const contextMentions = useAppStore((s) => s.contextMentions);
  const setContextMentions = useAppStore((s) => s.setContextMentions);
  const attachedFiles = useAppStore((s) => s.attachedFiles);
  const setAttachedFiles = useAppStore((s) => s.setAttachedFiles);
  const selectedMainModeKey = useAppStore((s) => s.selectedMainModeKey);
  const setSelectedMainModeKey = useAppStore((s) => s.setSelectedMainModeKey);
  const selectedNexusModeKey = useAppStore((s) => s.selectedNexusModeKey);
  const activeStudioAgentKey = useAppStore((s) => s.activeStudioAgentKey);
  const setActiveStudioAgentKey = useAppStore((s) => s.setActiveStudioAgentKey);
  const gameStudioInitialized = useAppStore((s) => s.gameStudioInitialized);
  const initializeGameStudioWorkspace = useAppStore((s) => s.initializeGameStudioWorkspace);
  const removeGameStudioWorkspace = useAppStore((s) => s.removeGameStudioWorkspace);
  const refreshGameStudioWorkspaceState = useAppStore((s) => s.refreshGameStudioWorkspaceState);
  const selectedWorkspace = useAppStore((s) => s.selectedWorkspace);
  const mainModes = [...MAIN_MODE_KEYS];
  const activeSessionScope = resolveSessionWorkspaceKey(currentWorkspace);
  const activeSessionKey = useMemo(
    () => resolveSessionRuntimeKey(activeSessionScope, currentSessionId),
    [activeSessionScope, currentSessionId],
  );
  const cacheSessionTranscript = useCallback((
    sessionKey: string,
    entry: Omit<SessionTranscriptCacheEntry, "lastAccessedAt">,
  ) => {
    const cache = sessionTranscriptCacheRef.current;
    cache.set(sessionKey, { ...entry, lastAccessedAt: Date.now() });
    if (cache.size <= SESSION_CACHE_LIMIT) return;

    const protectedKeys = new Set(
      [
        activeSessionKey,
        ...Object.entries(useAppStore.getState().runtimeBySessionKey || {})
          .filter(([, runtime]: any) => runtime?.isGenerating || runtime?.agentStatus === "running" || runtime?.agentStatus === "pending_review")
          .map(([key]) => key),
      ].filter(Boolean) as string[],
    );
    const victims = Array.from(cache.entries())
      .filter(([key]) => !protectedKeys.has(key))
      .sort((a, b) => a[1].lastAccessedAt - b[1].lastAccessedAt);
    while (cache.size > SESSION_CACHE_LIMIT && victims.length > 0) {
      const [victimKey] = victims.shift()!;
      cache.delete(victimKey);
    }
  }, [activeSessionKey]);
  const getCachedSessionTranscript = useCallback((sessionKey: string | null) => {
    if (!sessionKey) return null;
    const entry = sessionTranscriptCacheRef.current.get(sessionKey) || null;
    if (entry) {
      entry.lastAccessedAt = Date.now();
    }
    return entry;
  }, []);
  const globalSessions = sessionsByWorkspace[GLOBAL_CHAT_KEY] || [];
  const activeSessionRecord = useMemo(() => {
    if (!currentSessionId) return null;
    return (sessionsByWorkspace[activeSessionScope] || []).find((session: any) => session.id === currentSessionId) || null;
  }, [activeSessionScope, currentSessionId, sessionsByWorkspace]);
  const activeSessionRecoveryKey = useMemo(() => {
    if (!activeSessionRecord) return "";
    const messageCount = Array.isArray(activeSessionRecord.messages) ? activeSessionRecord.messages.length : 0;
    const runtimeTurnCount = Array.isArray(activeSessionRecord.runtimeSnapshot?.conversationTurns)
      ? activeSessionRecord.runtimeSnapshot.conversationTurns.length
      : 0;
    return [
      activeSessionRecord.id,
      activeSessionRecord.storageStatus || "",
      activeSessionRecord.turnCount || 0,
      activeSessionRecord.messageCount || 0,
      messageCount,
      runtimeTurnCount,
    ].join(":");
  }, [activeSessionRecord]);
  const sidebarWorkspace = selectedWorkspace || currentWorkspace;
  const sessionStatuses = useMemo(() => {
    const statuses: Record<string, string> = {};
    Object.entries(runtimeBySessionKey || {}).forEach(([sessionKey, runtime]: any) => {
      const status = runtime?.agentStatus || (runtime?.isGenerating ? "running" : "idle");
      if (status && status !== "idle") statuses[sessionKey] = status;
    });
    if (activeSessionKey && (agentStatus !== "idle" || isStreaming)) {
      statuses[activeSessionKey] = agentStatus || (isStreaming ? "running" : "idle");
    }
    return statuses;
  }, [activeSessionKey, agentStatus, isStreaming, runtimeBySessionKey]);
  const workspaceStatuses = useMemo(() => {
    const rank: Record<string, number> = { error: 4, pending_review: 3, running: 2, idle: 1 };
    const next: Record<string, string> = {};
    const promote = (workspacePath: string, status: string) => {
      if (!workspacePath || status === "idle") return;
      const current = next[workspacePath] || "idle";
      if ((rank[status] || 0) > (rank[current] || 0)) next[workspacePath] = status;
    };
    workspaces.forEach((workspace) => {
      const activeSessionId = activeSessionByWorkspace[workspace.path] ?? null;
      const activeKey = resolveSessionRuntimeKey(workspace.path, activeSessionId);
      if (activeKey && sessionStatuses[activeKey]) {
        promote(workspace.path, sessionStatuses[activeKey]);
      }
      const prefix = `${workspace.path}:`;
      Object.entries(sessionStatuses).forEach(([sessionKey, status]) => {
        if (sessionKey.startsWith(prefix)) promote(workspace.path, status);
      });
    });
    if (currentWorkspace && (agentStatus !== "idle" || isStreaming)) {
      promote(currentWorkspace, agentStatus || "running");
    }
    return next;
  }, [activeSessionByWorkspace, agentStatus, currentWorkspace, isStreaming, sessionStatuses, workspaces]);
  const modelRuntimeLock: ModelRuntimeLock = useMemo(() => {
    const hasActiveRun =
      isStreaming ||
      agentStatus === "running" ||
      agentStatus === "pending_review";
    const hasBackgroundRun = Object.values(runtimeBySessionKey || {}).some((runtime: any) =>
      runtime?.isGenerating ||
      runtime?.agentStatus === "running" ||
      runtime?.agentStatus === "pending_review"
    );
    if (!hasActiveRun && !hasBackgroundRun) return { isLocked: false };
    return {
      isLocked: true,
      activeProfile: config.activeProfile,
      activeCloudServerId: config.activeProfile === "cloud" ? config.activeCloudServerId : "",
      reason: config.language === "en"
        ? "A model run is active."
        : "模型正在执行中。",
    };
  }, [agentStatus, config.activeCloudServerId, config.activeProfile, config.language, isStreaming, runtimeBySessionKey]);

  // ── Layout State ──────────────────────────────────────────────────────
  const rightPanelWidth = useAppStore((s) => s.rightPanelWidth);
  const sidebarWidth = useAppStore((s) => s.sidebarWidth);
  const filePanelWidth = useAppStore((s) => s.workspaceTreePanelWidth);
  const setRightPanelWidth = useAppStore((s) => s.setRightPanelWidth);
  const setFilePanelWidth = useAppStore((s) => s.setWorkspaceTreePanelWidth);
  const setSidebarWidth = useAppStore((s) => s.setSidebarWidth);
  const closeRightPanel = useAppStore((s) => s.closeRightPanel);
  const closeFilePanel = useAppStore((s) => s.closeFilePanel);
  const isRightPanelVisible = showPlanPanel || showDiff || showTerminal;
  const isFilePanelVisible = showFilePanel;
  // isResizing is local UI state (mouse drag), not in the store
  const [isResizing, setIsResizing] = useState(false);
  const [isFilePanelResizing, setIsFilePanelResizing] = useState(false);
  const [isSidebarResizing, setIsSidebarResizing] = useState(false);
  const [isWorkspaceDropActive, setIsWorkspaceDropActive] = useState(false);
  const [mainUpdateStatus, setMainUpdateStatus] = useState<MainUpdateStatus>("idle");
  const [availableMainUpdate, setAvailableMainUpdate] = useState<MainUpdateInfo | null>(null);
  const [mainUpdateError, setMainUpdateError] = useState("");
  const [mainUpdateProgress, setMainUpdateProgress] = useState<MainUpdateProgress | null>(null);
  const [lastMainUpdateCheckedAt, setLastMainUpdateCheckedAt] = useState<number | null>(null);
  const [appVersion, setAppVersion] = useState("");
  const pendingRightPanelWidthRef = useRef<number | null>(null);
  const rightPanelResizeFrameRef = useRef<number | null>(null);

  // ── Modal State ───────────────────────────────────────────────────────
  const isSettingsOpen = useAppStore((s) => s.isSettingsOpen);
  const settingsTab = useAppStore((s) => s.settingsTab);
  const isSkillsOpen = useAppStore((s) => s.isSkillsOpen);
  const isAddingSkill = useAppStore((s) => s.isAddingSkill);
  const showAgentPicker = useAppStore((s) => s.showAgentPicker);
  const setIsSettingsOpen = useAppStore((s) => s.setIsSettingsOpen);
  const setSettingsTab = useAppStore((s) => s.setSettingsTab);
  const setIsSkillsOpen = useAppStore((s) => s.setIsSkillsOpen);
  const setIsAddingSkill = useAppStore((s) => s.setIsAddingSkill);
  const setShowAgentPicker = useAppStore((s) => s.setShowAgentPicker);

  const refreshSessionsForScope = useCallback(async (
    scopeKey: string,
    options: { rebuildIndex?: boolean } = {},
  ) => {
    try {
      const diskSessions = options.rebuildIndex
        ? await rebuildProjectSessionsIndex(scopeKey)
        : await listProjectSessions(scopeKey);
      const existingBeforeMerge = useAppStore.getState().sessionsByWorkspace[scopeKey] || [];
      const existingTemporaryIds = new Set(
        existingBeforeMerge
          .filter((session: any) => session.storageStatus === "temporary")
          .map((session: any) => String(session.id)),
      );
      diskSessions
        .filter((session: any) => shouldDiscardMissingSession(session) && !existingTemporaryIds.has(String(session.id)))
        .forEach((session: any) => {
          void deleteProjectSession(scopeKey, session.id).catch((error) => {
            appendDebugLog("warn", "session.storage", {
              phase: "prune_missing_failed",
              scopeKey,
              sessionId: session.id,
              error: error instanceof Error ? error.message : String(error),
            });
          });
        });
      let mergedSessions = diskSessions;
      useAppStore.setState((state: any) => {
        const existing = state.sessionsByWorkspace[scopeKey] || [];
        const selectedId = scopeKey === resolveSessionWorkspaceKey(state.currentWorkspace)
          ? state.currentSessionId
          : state.activeSessionByWorkspace[scopeKey] ?? null;
        const existingById = new Map(existing.map((session: any) => [String(session.id), session]));
        const diskIds = new Set(diskSessions.map((session: any) => String(session.id)));
        const shouldKeepLocalSession = (session: any) =>
          !shouldDiscardMissingSession(session) && (
          session.active ||
          session.recordingDisabled ||
          session.storageStatus === "temporary" ||
          (Array.isArray(session.messages) && session.messages.length > 0) ||
          !!session.runtimeSnapshot
        );
        const localOnlySessions = existing.filter((session: any) =>
          !diskIds.has(String(session.id)) && shouldKeepLocalSession(session)
        );
        const shouldPreferLocalActive = localOnlySessions.some((session: any) => session.active);
        const normalizedDiskSessions = (shouldPreferLocalActive
          ? diskSessions
              .filter((session: any) => !shouldDiscardMissingSession(session))
              .map((session: any) => ({ ...session, active: false }))
          : diskSessions.map((session: any) => {
              const localSession = existingById.get(String(session.id));
              if (localSession) {
                return mergeDiskSessionWithLocal(
                  localSession,
                  session,
                  selectedId,
                );
              }
              return shouldDiscardMissingSession(session) ? null : session;
            }))
          .filter(Boolean);
        mergedSessions = sortSessionsByRecent([...localOnlySessions, ...normalizedDiskSessions])
          .map((session: any) => ({
            ...session,
            active: selectedId != null ? Number(session.id) === selectedId : session.active === true,
          }));
        return {
          sessionsByWorkspace: {
            ...state.sessionsByWorkspace,
            [scopeKey]: mergedSessions,
          },
        };
      });
      return mergedSessions;
    } catch (error) {
      appendDebugLog("warn", "session.storage", {
        phase: options.rebuildIndex ? "rebuild_failed" : "list_failed",
        scopeKey,
        error: error instanceof Error ? error.message : String(error),
      });
      return useAppStore.getState().sessionsByWorkspace[scopeKey] || [];
    }
  }, []);

  const persistCurrentSessionInBackground = useCallback(() => {
    const state = useAppStore.getState();
    state.saveCurrentRuntimeToSession();
    if (!state.currentSessionId) return;
    const scopeKey = resolveSessionWorkspaceKey(state.currentWorkspace);
    const snapshot = buildStoredSessionSnapshot(
      state,
      scopeKey,
      state.currentSessionId,
      sessionTranscriptCacheRef.current,
    );
    if (!snapshot) return;
    const isPointerOnlyEmptySession =
      hasStoredSessionDetailPointer(snapshot) &&
      !hasRecoverableSessionTranscript(snapshot) &&
      (state.taskFlow || []).length === 0 &&
      (state.conversationTurns || []).length === 0;
    if (isPointerOnlyEmptySession) return;
    if (!hasPersistableSessionTranscript(snapshot)) return;

    const sessionKey = resolveSessionRuntimeKey(scopeKey, state.currentSessionId);
    if (sessionKey) {
      const taskFlowSnapshot = sanitizeTaskBlocksForPersist(state.taskFlow || []);
      cacheSessionTranscript(sessionKey, {
        scopeKey,
        sessionId: state.currentSessionId,
        taskFlow: taskFlowSnapshot,
        conversationTurns: normalizeInterruptedConversationTurnsForRestore(state.conversationTurns || [], taskFlowSnapshot),
        runtimeSnapshot: snapshot.runtimeSnapshot,
        hasMore: false,
        nextBeforeTurnIndex: null,
        totalTurns: state.conversationTurns?.length || 0,
      });
    }

    state.updateSession(scopeKey, state.currentSessionId, {
      messages: snapshot.messages,
      runtimeSnapshot: snapshot.runtimeSnapshot,
    });

    if (!state.config.sessionRecordingEnabled || snapshot.recordingDisabled) return;
    void saveProjectSession(scopeKey, snapshot)
      .then((saved) => {
        useAppStore.getState().updateSession(scopeKey, snapshot.id, {
          ...saved,
          storageStatus: "ok",
          recordingDisabled: false,
        });
      })
      .catch((error) => {
        appendDebugLog("warn", "session.storage", {
          phase: "background_save_failed",
          scopeKey,
          sessionId: snapshot.id,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }, [cacheSessionTranscript]);

  // ── Skills ────────────────────────────────────────────────────────────
  const skills = useAppStore((s) => s.skills);
  const toggleSkill = useAppStore((s) => s.toggleSkill);
  const deleteSkill = useAppStore((s) => s.deleteSkill);
  const addSkill = useAppStore((s) => s.addSkill);
  const updateSkill = useAppStore((s) => s.updateSkill);

  useEffect(() => initializeE2EScenarios(), []);
  useEffect(() => () => {
    if (sessionSaveTimerRef.current !== null) {
      window.clearTimeout(sessionSaveTimerRef.current);
      sessionSaveTimerRef.current = null;
    }
  }, []);
  useEffect(() => {
    appendDebugLog("info", "app.lifecycle", {
      phase: "app_mounted",
      currentWorkspace: currentWorkspace || "global",
      currentSessionId,
      taskFlowBlocks: taskFlow.length,
      agentMessages: agentMessages.length,
      conversationTurns: conversationTurns.length,
    });
  // Log only the initial mount snapshot.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    void applyAppIconVariant(config.appIconVariant).catch((error) => {
      appendDebugLog("warn", "app.icon", {
        phase: "apply_failed",
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }, [config.appIconVariant]);
  useEffect(() => {
    let cancelled = false;
    const migrateLegacySessions = async () => {
      const markerKey = "main.sessions.appDataMigrated.v3";
      try {
        if (window.localStorage.getItem(markerKey) === "1") {
          setSessionMigrationReady(true);
          return;
        }
      } catch {}
      const state = useAppStore.getState();
      const nextSessionsByWorkspace: Record<string, any[]> = {};
      let touched = false;

      for (const [scopeKey, sessions] of Object.entries(state.sessionsByWorkspace || {})) {
        nextSessionsByWorkspace[scopeKey] = await Promise.all((sessions as any[]).map(async (session) => {
          const hasMessages = Array.isArray(session.messages) && session.messages.length > 0;
          const hasVisibleRuntime =
            Array.isArray(session.runtimeSnapshot?.taskFlow) && session.runtimeSnapshot.taskFlow.length > 0;
          const hasTurns =
            Array.isArray(session.runtimeSnapshot?.conversationTurns) && session.runtimeSnapshot.conversationTurns.length > 0;
          if (session.recordingDisabled) return session;
          if (hasMessages || hasVisibleRuntime || hasTurns) {
            try {
              const saved = await saveProjectSession(scopeKey, session);
              touched = true;
              return { ...session, ...saved };
            } catch (error) {
              appendDebugLog("warn", "session.storage", {
                phase: "legacy_migration_save_failed",
                scopeKey,
                sessionId: session.id,
                error: error instanceof Error ? error.message : String(error),
              });
              return session;
            }
          }
          if (!session.storageStatus) {
            touched = true;
            return { ...session, storageStatus: "missing" };
          }
          return session;
        }));
      }

      if (!cancelled && touched) {
        useAppStore.setState({ sessionsByWorkspace: nextSessionsByWorkspace });
      }
      try {
        window.localStorage.setItem(markerKey, "1");
      } catch {}
      if (!cancelled) setSessionMigrationReady(true);
    };

    void migrateLegacySessions();
    return () => {
      cancelled = true;
    };
  }, []);
  useEffect(() => {
    if (!sessionMigrationReady) return;
    void refreshSessionsForScope(activeSessionScope);
  }, [activeSessionScope, refreshSessionsForScope, sessionMigrationReady]);
  useEffect(() => {
    if (!currentWorkspace) return;
    const startedAt = performance.now();
    appendDebugLog("info", "workspace.root", { phase: "set_start", currentWorkspace });
    void setWorkspaceRootIpc(currentWorkspace)
      .catch((error) => {
        appendDebugLog("warn", "workspace.root", {
          phase: "set_failed",
          currentWorkspace,
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .then(() => refreshGameStudioWorkspaceState())
      .finally(() => {
        appendDebugLog("info", "workspace.root", {
          phase: "set_done",
          currentWorkspace,
          elapsedMs: Math.round(performance.now() - startedAt),
        });
      });
  }, [currentWorkspace, refreshGameStudioWorkspaceState]);

  useEffect(() => {
    if (!currentSessionId) return;
    const autosaveSessionKey = resolveSessionRuntimeKey(activeSessionScope, currentSessionId);
    if (autosaveSessionKey && autosaveSuspendedForSessionRef.current === autosaveSessionKey) {
      return;
    }

    const messages = sanitizeTaskBlocksForPersist(taskFlow);
    const cachedTranscript = activeSessionKey ? getCachedSessionTranscript(activeSessionKey) : null;
    const loadedTurnCount = Array.isArray(conversationTurns) ? conversationTurns.length : 0;
    const transcriptTotalTurns = Number(cachedTranscript?.totalTurns ?? loadedTurnCount) || loadedTurnCount;
    const transcriptPartial = transcriptTotalTurns > loadedTurnCount;
    const runtimeSnapshot = {
      runtimeEventSchemaVersion: 1,
      runtimeEvents,
      harnessRunMarker,
      taskFlow: messages,
      agentMessages: sanitizeAgentMessagesForPersist(agentMessages),
      contextMemoryState,
      conversationTurns,
      currentTurnId,
      selectedMainModeKey,
      selectedNexusModeKey,
      sessionModeAffinity: resolveSessionModeAffinity(
        activeSessionRecord as SessionModeAffinityLike,
        selectedMainModeKey,
      ),
      activeStudioAgentKey,
      gameStudioInitialized,
      pendingSlashCommand,
      planArtifacts,
      planTasks,
      planExecutionEvidenceLedger,
      planExecutionEvidenceCount,
      planStage,
      isPlanApproved,
      showPlanPanel,
      showDiff,
      showTerminal,
      showFilePanel,
      rightPanelTab: normalizeStoredRightPanelTab(rightPanelTab),
      selectedDiffTaskId,
      transcriptPartial,
      transcriptLoadedTurns: loadedTurnCount,
      transcriptTotalTurns,
    };

    const shouldSkipDiskSave =
      typeof window !== "undefined" &&
      window.sessionStorage.getItem(`${SESSION_RECOVERY_SKIP_SAVE}:${activeSessionScope}:${currentSessionId}`) === "1" &&
      messages.length === 0 &&
      (!Array.isArray(conversationTurns) || conversationTurns.length === 0);

    if (sessionSaveTimerRef.current !== null) {
      window.clearTimeout(sessionSaveTimerRef.current);
      sessionSaveTimerRef.current = null;
    }

    if (shouldSkipDiskSave) {
      return;
    }

    const activeSessionHasTranscript = hasRecoverableSessionTranscript(activeSessionRecord);
    const activeSessionHasOnlyDetailPointer =
      hasStoredSessionDetailPointer(activeSessionRecord) && !activeSessionHasTranscript;
    if (messages.length === 0 && conversationTurns.length === 0 && activeSessionHasOnlyDetailPointer) {
      return;
    }

    const runtimeSignature = `${activeSessionScope}:${currentSessionId}:${stableRuntimeSignature({
      messages,
      runtimeSnapshot,
      transcriptPartial,
      transcriptLoadedTurns: loadedTurnCount,
      transcriptTotalTurns,
    })}`;
    if (lastSessionRuntimeSignatureRef.current === runtimeSignature) {
      return;
    }
    lastSessionRuntimeSignatureRef.current = runtimeSignature;

    updateSession(activeSessionScope, currentSessionId, {
      messages,
      runtimeSnapshot,
      transcriptPartial,
      transcriptLoadedTurns: loadedTurnCount,
      transcriptTotalTurns,
    });

    if (config.sessionRecordingEnabled) {
      sessionSaveTimerRef.current = window.setTimeout(() => {
        sessionSaveTimerRef.current = null;
        const state = useAppStore.getState();
        const session = (state.sessionsByWorkspace[activeSessionScope] || []).find((item: any) => item.id === currentSessionId);
        if (!session || session.recordingDisabled) return;
        if (!hasPersistableSessionTranscript({ ...session, messages, runtimeSnapshot })) {
          return;
        }
        void saveProjectSession(activeSessionScope, {
          ...session,
          messages,
          transcriptPartial,
          transcriptLoadedTurns: loadedTurnCount,
          transcriptTotalTurns,
          runtimeSnapshot,
        })
          .then((saved) => {
            useAppStore.getState().updateSession(activeSessionScope, currentSessionId, {
              ...saved,
              storageStatus: "ok",
              recordingDisabled: false,
            });
          })
          .catch((error) => {
            appendDebugLog("warn", "session.storage", {
              phase: "debounced_save_failed",
              scopeKey: activeSessionScope,
              sessionId: currentSessionId,
              error: error instanceof Error ? error.message : String(error),
            });
          });
      }, 350);
    }
  }, [
    agentMessages,
    harnessRunMarker,
    activeSessionScope,
    activeSessionKey,
    contextMemoryState,
    conversationTurns,
    config.sessionRecordingEnabled,
    currentSessionId,
    currentTurnId,
    gameStudioInitialized,
    isPlanApproved,
    pendingSlashCommand,
    planArtifacts,
    planExecutionEvidenceLedger,
    planExecutionEvidenceCount,
    planStage,
    planTasks,
    activeStudioAgentKey,
    rightPanelTab,
    selectedMainModeKey,
    selectedNexusModeKey,
    selectedDiffTaskId,
    showDiff,
    showFilePanel,
    showPlanPanel,
    showTerminal,
    taskFlow,
    runtimeEvents,
    getCachedSessionTranscript,
    updateSession,
  ]);

  const activeDiffTask = useMemo(() => {
    return resolveVisiblePendingToolReview({
      taskFlow,
      pendingReviewTaskId,
      pendingToolCall,
      currentTurnId,
    });
  }, [currentTurnId, pendingReviewTaskId, pendingToolCall, taskFlow]);

  const handleAttachFile = async (): Promise<AttachmentPickerResult> => {
    const result: AttachmentPickerResult = { attachments: [], imageDataUrls: [], skipped: [] };
    try {
      const selected = await open({
        multiple: true, title: 'Attach files',
        filters: [{ name: 'Supported attachments', extensions: SUPPORTED_ATTACHMENT_EXTENSIONS }],
      });
      if (!selected) return result;

      const paths = Array.isArray(selected) ? selected : [selected];
      for (const path of paths) {
        const kind = classifyAttachment(path);
        if (kind === "unsupported") {
          result.skipped.push({ name: getAttachmentDisplayName(path), reason: "unsupported" });
          continue;
        }
        if (kind === "image") {
          try {
            result.imageDataUrls.push(await readAttachmentImageDataUrl(path));
          } catch {
            result.skipped.push({ name: getAttachmentDisplayName(path), reason: "read_error" });
          }
          continue;
        }
        const attachment = createAttachedFileDescriptor(path);
        if (attachment) {
          result.attachments.push(attachment);
        } else {
          result.skipped.push({ name: getAttachmentDisplayName(path), reason: "unsupported" });
        }
      }
    } catch (error) {
      console.error('Failed to attach file:', error);
    }
    return result;
  };

  const handleAcceptInline = (id: number) => {
    allowToolAction(id);
  };

  const handleRejectInline = (id: number) => {
    rejectToolAction(id);
  };

  // ── Send Message: delegates to store's sendMessage ─────────────────────
  // This replaces the old inline handleSendMessage + runAgentLoop + 
  // executeToolCall + parseFullText + SSE parsing monolith.
  const handleSendMessage = useCallback((text: string, images?: string[]) => {
    const state = useAppStore.getState();
    const contextMentionsSnapshot = [...state.contextMentions];
    const attachedFilesSnapshot = [...state.attachedFiles];
    const hasPayload =
      text.trim().length > 0 ||
      contextMentionsSnapshot.length > 0 ||
      attachedFilesSnapshot.length > 0 ||
      (images?.length ?? 0) > 0;

    if (!hasPayload) {
      return false;
    }

    if (state.isGenerating || state.agentStatus === "running" || state.agentStatus === "pending_review") {
      appendDebugLog("warn", "ui.sendMessage", {
        phase: "queued_busy",
        agentStatus: state.agentStatus,
        isGenerating: state.isGenerating,
      });
      state.queueUserMessage(text, images, {
        contextMentions: contextMentionsSnapshot,
        attachedFiles: attachedFilesSnapshot,
      });
      return true;
    }

    appendDebugLog("info", "ui.sendMessage", {
      phase: "accepted",
      textChars: text.length,
      images: images?.length ?? 0,
      contextMentions: contextMentionsSnapshot.length,
      attachedFiles: attachedFilesSnapshot.length,
      currentTurnId: state.currentTurnId,
      taskFlowBlocks: state.taskFlow.length,
      agentMessages: state.agentMessages.length,
    });

    runAfterNextPaint(() => {
      useAppStore.getState().sendMessage(text, images, {
        contextMentionsSnapshot,
        attachedFilesSnapshot,
      });
    });

    return true;
  }, []);

  const handleQuickReply = useCallback((choice: string | ReplyOption, sourceTurnId?: string) => {
    const text = typeof choice === "string" ? choice : choice.value;
    const optionAction = typeof choice === "string" ? undefined : choice.action;
    const e2eQuickReplyHandler = getE2EQuickReplyHandler();
    if (e2eQuickReplyHandler?.(text, sourceTurnId)) {
      return;
    }

    const state = useAppStore.getState();
    const reuseCurrentTurn = !!sourceTurnId && sourceTurnId === state.currentTurnId;
    const sourceTurnForLog = sourceTurnId
      ? state.conversationTurns.find((turn) => turn.id === sourceTurnId) || null
      : null;
    appendDebugLog("info", "ui.quickReply", {
      text,
      sourceTurnId,
      currentTurnId: state.currentTurnId,
      reuseCurrentTurn,
      sourceTurnFound: !!sourceTurnForLog,
      currentTurnStatus: state.currentTurnId
        ? state.conversationTurns.find((turn) => turn.id === state.currentTurnId)?.status
        : null,
      taskFlowBlocks: state.taskFlow.length,
      agentMessages: state.agentMessages.length,
      optionAction: optionAction ?? null,
    });
    const sourceTurn = sourceTurnId
      ? state.conversationTurns.find((turn) => turn.id === sourceTurnId) || null
      : state.currentTurnId
      ? state.conversationTurns.find((turn) => turn.id === state.currentTurnId) || null
      : null;
    const sourceIntent = resolveConversationTurnIntent(sourceTurn);
    const sourceVisiblePlanText = getLatestVisibleAgentTextForTurn(state.taskFlow, sourceTurn?.id);
    const sourcePlanMaterialization = sourceVisiblePlanText
      ? materializePlanArtifactFromVisibleText({
          visibleText: sourceVisiblePlanText,
          planStage: state.planStage,
          userGoal: sourceTurn?.userPrompt || "",
          evidence: [
            state.config.language === "en"
              ? "The user can approve this visible plan text from ChatArea; use it as review evidence for quick-reply materialization."
              : "用户可以从聊天区批准这份可见方案；将其作为 quick reply 物化的审阅证据。",
          ],
        })
      : { ok: false, reason: "missing_visible_plan" };
    const planApprovalQuickReplyAction = resolvePlanApprovalQuickReplyAction({
      text,
      optionAction,
      sourceIntent,
      isPlanApproved: state.isPlanApproved,
      planArtifacts: state.planArtifacts,
      planStage: state.planStage,
      sourceHasMaterializablePlan: sourcePlanMaterialization.ok,
    });

    if (planApprovalQuickReplyAction === "approve_existing_plan") {
      appendDebugLog("info", "ui.quickReply_plan_approval", {
        text,
        sourceTurnId,
        currentTurnId: state.currentTurnId,
        planStage: state.planStage,
        planArtifacts: state.planArtifacts.length,
      });
      useAppStore.setState({
        ...(sourceTurnId ? { currentTurnId: sourceTurnId } : {}),
        input: "",
        contextMentions: [],
        attachedFiles: [],
      });
      runAfterNextPaint(() => {
        useAppStore.getState().approvePlan(text);
      });
      return;
    }

    if (planApprovalQuickReplyAction === "materialize_then_approve") {
      appendDebugLog("info", "ui.quickReply_plan_materialize_then_approve", {
        text,
        sourceTurnId,
        currentTurnId: state.currentTurnId,
        visiblePlanChars: sourceVisiblePlanText.length,
      });
      useAppStore.setState({
        ...(sourceTurnId ? { currentTurnId: sourceTurnId } : {}),
        input: "",
        contextMentions: [],
        attachedFiles: [],
      });
      runAfterNextPaint(() => {
        void materializePlanQuickReplyAndApprove({
          sourceTurnId,
          approvalText: text,
          visiblePlanText: sourceVisiblePlanText,
        });
      });
      return;
    }

    if (planApprovalQuickReplyAction === "block_missing_plan_artifact") {
      appendPlanQuickReplyBlockedNotice(sourceTurnId, sourcePlanMaterialization.reason || "missing_plan_artifact", text);
      return;
    }

    const shouldReuseSourceTurn = !!sourceTurnId && !!sourceTurn;
    const shouldExecuteFromQuickReply =
      optionAction === "execute_once" || optionAction === "approve_operation_once";
    const executeQuickReplyIntent = state.selectedMainModeKey === "game_studio" ? "studio_workflow" as const : "execute" as const;

    if (optionAction === "cancel_operation") {
      useAppStore.setState((s) => ({
        ...(sourceTurnId ? { currentTurnId: sourceTurnId } : {}),
        input: "",
        contextMentions: [],
        attachedFiles: [],
        conversationTurns: sourceTurnId
          ? s.conversationTurns.map((turn) =>
              turn.id === sourceTurnId && turn.pendingOperationProposal
                ? {
                    ...turn,
                    pendingOperationProposal: {
                      ...turn.pendingOperationProposal,
                      approvalStatus: "cancelled",
                    },
                    status: "done",
                  }
                : turn,
            )
          : s.conversationTurns,
      }));
      return;
    }

    const sendOptions = shouldReuseSourceTurn
      ? {
          reuseCurrentTurn: true,
          preservePlanState: sourceIntent === "plan",
          resolvedIntent: shouldExecuteFromQuickReply ? executeQuickReplyIntent : sourceIntent,
          ...(shouldExecuteFromQuickReply
            ? {
                runtimeIntentOverride: executeQuickReplyIntent,
                executionConsentGranted: true,
              }
            : {}),
          skipIntentResolution: true,
        }
      : shouldExecuteFromQuickReply
      ? {
          resolvedIntent: executeQuickReplyIntent,
          runtimeIntentOverride: executeQuickReplyIntent,
          executionConsentGranted: true,
          skipIntentResolution: true,
        }
      : undefined;

    if (optionAction === "adjust_plan") {
      state.abortController?.abort();
    }

    useAppStore.setState({
      ...(shouldReuseSourceTurn ? { currentTurnId: sourceTurnId } : {}),
      input: "",
      contextMentions: [],
      attachedFiles: [],
      ...(optionAction === "allow_readonly_session" ? { readOnlyAutoApproveForSession: true } : {}),
      ...(optionAction === "adjust_plan"
        ? {
            agentStatus: "idle" as const,
            isGenerating: false,
            abortController: null,
            isPlanApproved: false,
            planApprovalChoice: null,
            planExecutionEvidenceLedger: [],
            planExecutionEvidenceCount: 0,
            planAutoResumeCount: 0,
            planExecutionProgressSnapshot: null,
            ...(sourceTurnId
              ? {
                  conversationTurns: state.conversationTurns.map((turn) =>
                    turn.id === sourceTurnId && turn.pendingOperationProposal
                      ? {
                          ...turn,
                          pendingOperationProposal: {
                            ...turn.pendingOperationProposal,
                            approvalStatus: "adjusting",
                          },
                        }
                      : turn,
                  ),
                }
              : {}),
          }
        : {}),
      ...(shouldExecuteFromQuickReply && sourceTurnId
        ? { currentTurnExecutionConsent: { turnId: sourceTurnId, granted: true } }
        : {}),
    });

    runAfterNextPaint(() => {
      useAppStore.getState().sendMessage(text, undefined, sendOptions);
    });
  }, []);

  const handleStopGeneration = useCallback(() => {
    useAppStore.getState().stopGeneration();
  }, []);

  const handleLoadOlderSessionHistory = useCallback(async () => {
    const state = useAppStore.getState();
    const scopeKey = resolveSessionWorkspaceKey(state.currentWorkspace);
    const sessionId = state.currentSessionId;
    const sessionKey = resolveSessionRuntimeKey(scopeKey, sessionId);
    if (!sessionKey || !sessionId) return;

    const entry = getCachedSessionTranscript(sessionKey);
    if (!entry?.hasMore || !entry.nextBeforeTurnIndex) return;

    const page = await loadProjectSessionPage(scopeKey, sessionId, entry.nextBeforeTurnIndex, SESSION_INITIAL_PAGE_TURNS);
    const merged = mergeSessionPage(entry, page);
    const nextEntry = {
      ...entry,
      taskFlow: merged.taskFlow,
      conversationTurns: merged.conversationTurns,
      hasMore: page.hasMore,
      nextBeforeTurnIndex: page.nextBeforeTurnIndex ?? null,
      totalTurns: page.totalTurns,
    };
    cacheSessionTranscript(sessionKey, nextEntry);
    const patch = buildPagedRuntimePatch(nextEntry, useAppStore.getState());
    syncTaskIdCounterFromBlocks(patch.taskFlow);
    useAppStore.setState(patch);
    useAppStore.getState().saveCurrentRuntimeToSession();
  }, [cacheSessionTranscript, getCachedSessionTranscript]);

  // --- Workspace & Session Management ---
  const restoreSessionState = async (target: any, id: number, scopeKey = activeSessionScope) => {
    const restoreToken = ++sessionRestoreTokenRef.current;
    const expectedSessionKey = resolveSessionRuntimeKey(scopeKey, id);
    const isCurrentRestore = () => {
      const state = useAppStore.getState();
      return (
        sessionRestoreTokenRef.current === restoreToken &&
        state.currentSessionId === id &&
        resolveSessionWorkspaceKey(state.currentWorkspace) === scopeKey
      );
    };
    const finishRestore = () => {
      if (expectedSessionKey && autosaveSuspendedForSessionRef.current === expectedSessionKey) {
        autosaveSuspendedForSessionRef.current = "";
      }
      lastSessionRuntimeSignatureRef.current = "";
    };
    const startedAt = performance.now();
    const liveSessionKey = resolveSessionRuntimeKey(scopeKey, id);
    const targetHasPersistedTranscript =
      hasStoredSessionDetailPointer(target) ||
      hasRecoverableSessionTranscript(target);
    if (isEmptyTemporarySession(target)) {
      if (!isCurrentRestore()) return;
      resetToEmptyChatView();
      appendDebugLog("info", "session.restore", {
        sessionId: id,
        scopeKey,
        mode: "temporary_empty",
        elapsedMs: Math.round(performance.now() - startedAt),
      });
      finishRestore();
      return;
    }
    const liveRuntime = liveSessionKey
      ? useAppStore.getState().runtimeBySessionKey?.[liveSessionKey]
      : null;
    const shouldUseLiveRuntime =
      !!liveRuntime &&
      (
        !targetHasPersistedTranscript ||
        target?.storageStatus === "temporary" ||
        liveRuntime.isGenerating === true ||
        liveRuntime.agentStatus === "running" ||
        liveRuntime.agentStatus === "pending_review"
      );
    if (shouldUseLiveRuntime && useAppStore.getState().restoreRuntimeForSession(liveSessionKey, {
      resetPanels: true,
      requireTranscript: targetHasPersistedTranscript,
    })) {
      appendDebugLog("info", "session.restore", {
        sessionId: id,
        scopeKey,
        mode: "live_runtime",
        elapsedMs: Math.round(performance.now() - startedAt),
      });
      finishRestore();
      return;
    }

    const cachedTranscript = getCachedSessionTranscript(liveSessionKey);
    if (cachedTranscript && (cachedTranscript.taskFlow.length > 0 || cachedTranscript.conversationTurns.length > 0 || !targetHasPersistedTranscript)) {
      const patch = buildPagedRuntimePatch(cachedTranscript, useAppStore.getState());
      syncTaskIdCounterFromBlocks(patch.taskFlow);
      if (!isCurrentRestore()) return;
      useAppStore.setState(patch);
      appendDebugLog("info", "session.restore", {
        sessionId: id,
        scopeKey,
        mode: "transcript_cache",
        elapsedMs: Math.round(performance.now() - startedAt),
        taskFlowBlocks: patch.taskFlow.length,
        conversationTurns: patch.conversationTurns.length,
      });
      useAppStore.getState().saveCurrentRuntimeToSession();
      finishRestore();
      return;
    }
    let hydratedTarget = target;

    const hydratedHasTranscript = hasRecoverableSessionTranscript(hydratedTarget);
    if (
      hydratedTarget?.storageStatus === "ok" &&
      !hydratedHasTranscript &&
      !(Array.isArray(hydratedTarget?.messages) && hydratedTarget.messages.length > 0) &&
      !hydratedTarget?.recordingDisabled
    ) {
      try {
        const [meta, page] = await Promise.all([
          loadProjectSessionMeta(scopeKey, id),
          loadProjectSessionPage(scopeKey, id, null, SESSION_INITIAL_PAGE_TURNS),
        ]);
        const merged = mergeSessionPage(null, page);
        const cacheEntry = {
          scopeKey,
          sessionId: id,
          taskFlow: merged.taskFlow,
          conversationTurns: merged.conversationTurns,
          runtimeSnapshot: meta.runtimeSnapshot,
          hasMore: page.hasMore,
          nextBeforeTurnIndex: page.nextBeforeTurnIndex ?? null,
          totalTurns: page.totalTurns,
        };
        cacheSessionTranscript(liveSessionKey!, cacheEntry);
        if (typeof window !== "undefined") {
          const recoveryKey = `${SESSION_RECOVERY_SKIP_SAVE}:${scopeKey}:${id}`;
          if (merged.taskFlow.length > 0 || merged.conversationTurns.length > 0) {
            window.sessionStorage.removeItem(recoveryKey);
          } else if (target?.storageStatus === "ok") {
            window.sessionStorage.setItem(recoveryKey, "1");
          }
        }
        const shouldIgnoreMissingMetaForLocalTemporary =
          target?.storageStatus === "temporary" &&
          isMissingSessionMeta(meta) &&
          merged.taskFlow.length === 0 &&
          merged.conversationTurns.length === 0;
        const shouldDiscardMissingMeta =
          target?.storageStatus !== "temporary" &&
          shouldDiscardMissingSession(meta) &&
          merged.taskFlow.length === 0 &&
          merged.conversationTurns.length === 0;
        if (shouldDiscardMissingMeta) {
          if (!isCurrentRestore()) return;
          const state = useAppStore.getState();
          const sessions = state.sessionsByWorkspace[scopeKey] || [];
          const fallbackSession = chooseSessionAfterDelete(sessions, id);
          removeSession(scopeKey, id, { nextSessionId: fallbackSession?.id ?? null });
          appendDebugLog("warn", "session.restore", {
            sessionId: id,
            scopeKey,
            mode: "missing_pruned",
            elapsedMs: Math.round(performance.now() - startedAt),
          });
          if (fallbackSession) {
            void restoreSessionState(fallbackSession, fallbackSession.id, scopeKey);
          } else {
            resetToEmptyChatView();
            finishRestore();
          }
          return;
        }
        hydratedTarget = shouldIgnoreMissingMetaForLocalTemporary
          ? {
              ...target,
              messages: [],
              runtimeSnapshot: {
                ...(target.runtimeSnapshot || {}),
                taskFlow: [],
                conversationTurns: [],
              },
            }
          : {
              ...target,
              ...meta,
              messages: merged.taskFlow,
              runtimeSnapshot: {
                ...(meta.runtimeSnapshot || {}),
                taskFlow: merged.taskFlow,
                conversationTurns: merged.conversationTurns,
              },
            };
        if (!isCurrentRestore()) return;
        if (!shouldIgnoreMissingMetaForLocalTemporary) {
          updateSession(scopeKey, id, hydratedTarget);
        }
      } catch (error) {
        appendDebugLog("warn", "session.restore", {
          sessionId: id,
          scopeKey,
          mode: "paged_load_failed",
          error: error instanceof Error ? error.message : String(error),
        });
        try {
          hydratedTarget = await loadProjectSession(scopeKey, id);
          if (!isCurrentRestore()) return;
          updateSession(scopeKey, id, hydratedTarget);
        } catch (fallbackError) {
          appendDebugLog("warn", "session.restore", {
            sessionId: id,
            scopeKey,
            mode: "load_failed",
            error: fallbackError instanceof Error ? fallbackError.message : String(fallbackError),
          });
          hydratedTarget = { ...hydratedTarget, storageStatus: "missing" };
        }
      }
    }
    if (!isCurrentRestore()) return;

    if (
      hydratedTarget?.storageStatus === "missing" &&
      !hydratedTarget?.runtimeSnapshot &&
      !(Array.isArray(hydratedTarget?.messages) && hydratedTarget.messages.length > 0)
    ) {
      const state = useAppStore.getState();
      const sessions = state.sessionsByWorkspace[scopeKey] || [];
      const fallbackSession = chooseSessionAfterDelete(sessions, id);
      removeSession(scopeKey, id, { nextSessionId: fallbackSession?.id ?? null });
      appendDebugLog("warn", "session.restore", {
        sessionId: id,
        scopeKey,
        mode: "missing_pruned",
        elapsedMs: Math.round(performance.now() - startedAt),
      });
      if (fallbackSession) {
        void restoreSessionState(fallbackSession, fallbackSession.id, scopeKey);
      } else {
        resetToEmptyChatView();
        finishRestore();
      }
      return;
    }

    target = hydratedTarget;
    if (target?.runtimeSnapshot && hasPersistableSessionTranscript(target)) {
      const snapshot = target.runtimeSnapshot;
      const snapshotTaskFlow = hasArrayItems(snapshot.taskFlow) ? snapshot.taskFlow : target.messages;
      const restoredTaskFlow = sanitizeTaskBlocksForPersist(snapshotTaskFlow || []);
      const restoredMainMode = mapLegacyNexusModeToMainMode(
        (snapshot as any).selectedMainModeKey ||
          (snapshot as any).selectedNexusModeKey ||
          (snapshot as any).selectedAgentKey ||
          resolveSessionModeAffinity(target as SessionModeAffinityLike, "main_mode"),
      );
      const restoredConversationTurns = normalizeInterruptedConversationTurnsForRestore(
        hasArrayItems(snapshot.conversationTurns) ? snapshot.conversationTurns : [],
        restoredTaskFlow,
      );
      syncTaskIdCounterFromBlocks(restoredTaskFlow);
      useAppStore.setState({
        taskFlow: restoredTaskFlow,
        agentMessages: sanitizeAgentMessagesForPersist(snapshot.agentMessages || []),
        contextMemoryState: normalizeContextMemoryState(snapshot.contextMemoryState),
        selectedMainModeKey: restoredMainMode,
        selectedNexusModeKey: mapMainModeToLegacyNexusMode(restoredMainMode),
        activeStudioAgentKey: normalizeStudioAgentKey(snapshot.activeStudioAgentKey ?? useAppStore.getState().activeStudioAgentKey),
        gameStudioInitialized: snapshot.gameStudioInitialized === true || useAppStore.getState().gameStudioInitialized,
        pendingSlashCommand: snapshot.pendingSlashCommand ?? null,
        conversationTurns: restoredConversationTurns,
        currentTurnId: snapshot.currentTurnId ?? null,
        currentTurnState: {
          interceptorHandled: false,
          interceptorThought: "",
          lastReportedThought: "",
          lastReportedAssistantText: "",
          capsuleExplanation: null,
          turnId: "",
        },
        agentStatus: 'idle',
        isGenerating: false,
        abortController: null,
        pendingReviewResolve: null,
        pendingReviewTaskId: null,
        pendingToolCall: null,
        autoApproveTools: false,
        autoApproveToolScopes: [],
        readOnlyAutoApproveForSession: false,
        planArtifacts: snapshot.planArtifacts || [],
        planTasks: snapshot.planTasks || [],
        planExecutionEvidenceLedger: snapshot.planExecutionEvidenceLedger || [],
        planExecutionEvidenceCount: snapshot.planExecutionEvidenceCount ?? 0,
        planStage: snapshot.planStage ?? 'idle',
        isPlanApproved: snapshot.isPlanApproved ?? false,
        planApprovalChoice: snapshot.planApprovalChoice ?? null,
        ...CLOSED_SESSION_PANEL_STATE,
        elapsedTime: 0,
      });
      appendDebugLog("info", "session.restore", {
        sessionId: id,
        mode: "runtimeSnapshot",
        elapsedMs: Math.round(performance.now() - startedAt),
        taskFlowBlocks: restoredTaskFlow.length,
        agentMessages: (snapshot.agentMessages || []).length,
        conversationTurns: restoredConversationTurns.length,
      });
      useAppStore.getState().saveCurrentRuntimeToSession();
      finishRestore();
      return;
    }

    if (target?.messages?.length) {
      syncTaskIdCounterFromBlocks(target.messages);
      const turnId = `loaded-${id}-${Date.now()}`;
      const restoredMainMode = resolveSessionModeAffinity(target as SessionModeAffinityLike, "main_mode");
      const restoredTitle = normalizeConversationDisplayTitle(
        target.title || "",
        48,
        useAppStore.getState().config.language === "en" ? "New task" : "新的任务",
      );
      useAppStore.setState({
        taskFlow: target.messages,
        selectedMainModeKey: restoredMainMode,
        selectedNexusModeKey: mapMainModeToLegacyNexusMode(restoredMainMode),
        activeStudioAgentKey: useAppStore.getState().activeStudioAgentKey,
        gameStudioInitialized: useAppStore.getState().gameStudioInitialized,
        pendingSlashCommand: null,
        selectedDiffTaskId: null,
        planExecutionEvidenceLedger: [],
        planExecutionEvidenceCount: 0,
        conversationTurns: [{
          id: turnId,
          userPrompt: target.title || '',
          title: restoredTitle,
          mode: 'chat' as const,
          status: 'done' as const,
          summary: restoredTitle,
          blockIds: target.messages.map((m: any) => m.id),
          collapsed: true,
          createdAt: Date.now(),
        }],
        currentTurnId: turnId,
        currentTurnState: {
          interceptorHandled: false,
          interceptorThought: "",
          lastReportedThought: "",
          lastReportedAssistantText: "",
          capsuleExplanation: null,
          turnId: "",
        },
        showPlanPanel: false,
        showDiff: false,
        showTerminal: false,
        showFilePanel: false,
        fileViewerPath: "",
        fileViewerContent: "",
        fileViewerWindow: null,
        fileViewerError: "",
        fileViewerLoading: false,
        rightPanelTab: 'plan',
      });
      appendDebugLog("info", "session.restore", {
        sessionId: id,
        mode: "messages",
        elapsedMs: Math.round(performance.now() - startedAt),
        taskFlowBlocks: target.messages.length,
      });
      useAppStore.getState().saveCurrentRuntimeToSession();
      finishRestore();
      return;
    }

    const restoredMainMode = resolveSessionModeAffinity(target as SessionModeAffinityLike, "main_mode");
    useAppStore.setState({
      taskFlow: [],
      selectedMainModeKey: restoredMainMode,
      selectedNexusModeKey: mapMainModeToLegacyNexusMode(restoredMainMode),
      imageStudio: useAppStore.getState().imageStudio || createDefaultImageStudioRuntime(),
      activeStudioAgentKey: useAppStore.getState().activeStudioAgentKey,
      gameStudioInitialized: useAppStore.getState().gameStudioInitialized,
      pendingSlashCommand: null,
      selectedDiffTaskId: null,
      conversationTurns: [],
      currentTurnId: null,
      currentTurnState: {
        interceptorHandled: false,
        interceptorThought: "",
        lastReportedThought: "",
        lastReportedAssistantText: "",
        capsuleExplanation: null,
        turnId: "",
      },
      agentMessages: [],
      contextMemoryState: null,
      agentStatus: 'idle',
      isGenerating: false,
      abortController: null,
      pendingReviewResolve: null,
      pendingReviewTaskId: null,
      pendingToolCall: null,
      autoApproveTools: false,
      autoApproveToolScopes: [],
      readOnlyAutoApproveForSession: false,
      showPlanPanel: false,
      showDiff: false,
      showTerminal: false,
      showFilePanel: false,
      fileViewerPath: "",
      fileViewerContent: "",
      fileViewerWindow: null,
      fileViewerError: "",
      fileViewerLoading: false,
      rightPanelTab: 'plan',
      planArtifacts: [],
      planTasks: [],
      planExecutionEvidenceLedger: [],
      planExecutionEvidenceCount: 0,
      planStage: 'idle',
      isPlanApproved: false,
      planApprovalChoice: null,
    });
    if (typeof window !== "undefined" && target?.storageStatus === "ok") {
      window.sessionStorage.setItem(`${SESSION_RECOVERY_SKIP_SAVE}:${scopeKey}:${id}`, "1");
    }
    appendDebugLog("info", "session.restore", {
      sessionId: id,
      mode: "empty",
      elapsedMs: Math.round(performance.now() - startedAt),
    });
    if (scopeKey !== GLOBAL_CHAT_KEY) {
      hydrateWorkspacePlanForEmptySession("empty_session_restore");
    }
    if (target?.storageStatus !== "ok") {
      useAppStore.getState().saveCurrentRuntimeToSession();
    }
    finishRestore();
  };

  const openSessionScope = (scopeKey: string) => {
    setCurrentWorkspace(scopeKey === GLOBAL_CHAT_KEY ? "" : scopeKey);
  };

  const handleOpenWorkspacePath = async (
    path: string,
    options: { selectFirstSession?: boolean; rebuildIndex?: boolean } = {},
  ) => {
    const rawPath = String(path || "").trim();
    if (!rawPath) return;
    try {
      persistCurrentSessionInBackground();
      let stablePath = rawPath;
      try {
        stablePath = await canonicalizeWorkspacePath(rawPath);
      } catch {
        stablePath = await setWorkspaceRootIpc(rawPath);
      }
      const wasKnownWorkspace = useAppStore.getState().workspaces.some((entry: any) => entry.path === stablePath);
      const shouldRebuildIndex = options.rebuildIndex ?? !wasKnownWorkspace;
      addWorkspaceEntry(stablePath);
      const rememberedSessionId = useAppStore.getState().activeSessionByWorkspace[stablePath] ?? null;
      const existing = await refreshSessionsForScope(stablePath, { rebuildIndex: shouldRebuildIndex });
      const targetSession =
        existing.find((session: any) => rememberedSessionId != null && session.id === rememberedSessionId) ||
        existing.find((session: any) => session.active) ||
        (options.selectFirstSession ? existing[0] : null);
      if (targetSession) {
        void handleSelectSession(stablePath, targetSession.id);
      } else {
        setCurrentWorkspace(stablePath);
        setCurrentSessionId(null);
        useAppStore.setState({
          taskFlow: [],
          agentMessages: [],
          contextMemoryState: null,
          conversationTurns: [],
          currentTurnId: null,
          selectedDiffTaskId: null,
          pendingSlashCommand: null,
          planArtifacts: [],
          planTasks: [],
          planExecutionEvidenceLedger: [],
          planExecutionEvidenceCount: 0,
          planStage: "idle",
          isPlanApproved: false,
          planApprovalChoice: null,
          agentStatus: "idle",
          isGenerating: false,
          abortController: null,
          pendingReviewResolve: null,
          pendingReviewTaskId: null,
          pendingToolCall: null,
          showPlanPanel: false,
          showDiff: false,
          showTerminal: false,
          showFilePanel: false,
          rightPanelTab: "plan",
        });
        hydrateWorkspacePlanForEmptySession("workspace_open_empty");
      }
    } catch (error) {
      console.error("Failed to open workspace path:", error);
    }
  };

  const handleSelectWorkspace = async () => {
    try {
      const selected = await open({ directory: true, multiple: false, title: 'Select Project Workspace' });
      if (selected) {
        const selectedPath = Array.isArray(selected) ? selected[0] : selected;
        await handleOpenWorkspacePath(selectedPath, { selectFirstSession: true });
      }
    } catch (error) { console.error('Failed to select workspace:', error); }
  };

  // ── Shared helper: reset chat runtime state to empty view ──────────────
  const resetToEmptyChatView = useCallback(() => {
    useAppStore.setState({
      taskFlow: [],
      agentMessages: [],
      contextMemoryState: null,
      conversationTurns: [],
      currentTurnId: null,
      selectedDiffTaskId: null,
      pendingSlashCommand: null,
      planArtifacts: [],
      planTasks: [],
      planExecutionEvidenceLedger: [],
      planExecutionEvidenceCount: 0,
      planStage: "idle",
      isPlanApproved: false,
      planApprovalChoice: null,
      agentStatus: "idle",
      isGenerating: false,
      abortController: null,
      pendingReviewResolve: null,
      pendingReviewTaskId: null,
      pendingToolCall: null,
      showPlanPanel: false,
      showDiff: false,
      showTerminal: false,
      showFilePanel: false,
      rightPanelTab: "plan",
    });
  }, []);

  const hydrateWorkspacePlanForEmptySession = useCallback((reason: string) => {
    const state = useAppStore.getState();
    if (!state.currentWorkspace.trim()) return;
    void state.ensurePlanArtifactsHydratedForWorkspace({
      reason,
      promoteTasksToExecuting: true,
    }).then((hydrated) => {
      if (hydrated) {
        useAppStore.getState().saveCurrentRuntimeToSession();
      }
    });
  }, []);

  const handleOpenGlobalChat = async () => {
    const state = useAppStore.getState();
    if (!state.currentWorkspace && state.currentSessionId) return;
    persistCurrentSessionInBackground();

    openSessionScope(GLOBAL_CHAT_KEY);
    const existing = await refreshSessionsForScope(GLOBAL_CHAT_KEY);
    if (existing.length === 0) {
      resetToEmptyChatView();
      setCurrentWorkspace("");
      setCurrentSessionId(null);
      return;
    }

    const targetSession = existing.find((session: any) => session.active) || existing[0];
    markOnlySessionActive(GLOBAL_CHAT_KEY, targetSession.id);
    setCurrentSessionId(targetSession.id);
    void restoreSessionState(targetSession, targetSession.id, GLOBAL_CHAT_KEY);
  };

  const handleRemoveWorkspaceEntry = async (path: string) => {
    const normalizedPath = String(path || "").trim();
    if (!normalizedPath) return;

    const state = useAppStore.getState();
    const wasActive = resolveSessionWorkspaceKey(state.currentWorkspace) === normalizedPath;
    const remainingWorkspaces = state.workspaces.filter((entry: any) => entry.path !== normalizedPath);

    state.saveCurrentRuntimeToSession();
    removeWorkspaceEntry(normalizedPath);

    if (!wasActive) return;

    const nextWorkspace = remainingWorkspaces[0]?.path;
    if (nextWorkspace) {
      await handleOpenWorkspacePath(nextWorkspace, { selectFirstSession: true });
    } else {
      await handleOpenGlobalChat();
    }
  };

  const handleCreateSessionForScope = async (scopeKey: string) => {
    if (!scopeKey) return;

    const state = useAppStore.getState();
    const liveScope = resolveSessionWorkspaceKey(state.currentWorkspace);
    const shouldPersistPreviousSession =
      state.currentSessionId &&
      (liveScope !== scopeKey || !isEmptyTemporarySession(
        (state.sessionsByWorkspace[liveScope] || []).find((session: any) => session.id === state.currentSessionId),
      ));
    if (state.currentSessionId) {
      if (shouldPersistPreviousSession) persistCurrentSessionInBackground();
      updateSession(liveScope, state.currentSessionId, {
        messages: sanitizeTaskBlocksForPersist(useAppStore.getState().taskFlow),
        active: false,
      });
    }

    const isGlobalChat = scopeKey === GLOBAL_CHAT_KEY;
    const createdAt = Date.now();
    const createdAtIso = new Date(createdAt).toISOString();
    const emptyRuntimeSnapshot = buildSessionRuntimeSnapshotFromState({
      taskFlow: [],
      agentMessages: [],
      contextMemoryState: null,
      conversationTurns: [],
      currentTurnId: null,
      selectedMainModeKey: "main_mode",
      selectedNexusModeKey: "nexus_general",
      sessionModeAffinity: "main_mode",
      activeStudioAgentKey: useAppStore.getState().activeStudioAgentKey,
      gameStudioInitialized: useAppStore.getState().gameStudioInitialized,
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
    });
    const ns = {
      id: createdAt,
      title: isGlobalChat
        ? (config.language === "en" ? "New Chat" : "新聊天")
        : (config.language === "en" ? "New Conversation" : "新会话"),
      date: createdAtIso,
      updatedAt: createdAtIso,
      updatedAtMs: createdAt,
      active: true,
      sessionModeAffinity: "main_mode" as SessionModeAffinity,
      storageStatus: "temporary" as const,
      recordingDisabled: !config.sessionRecordingEnabled,
      messages: [] as TaskBlock[],
      runtimeSnapshot: emptyRuntimeSnapshot,
    };
    if (!isGlobalChat) addWorkspaceEntry(scopeKey);
    markAllSessionsInactive(scopeKey);
    openSessionScope(scopeKey);
    addSession(scopeKey, { ...ns, active: true });
    setCurrentSessionId(ns.id);
    sessionRecoveryAttemptRef.current = "";
    lastSessionRuntimeSignatureRef.current = "";
    resetToEmptyChatView();
    if (!isGlobalChat) hydrateWorkspacePlanForEmptySession("new_session");
  };

  const handleSelectSession = async (scopeKey: string, id: number) => {
    const state = useAppStore.getState();
    const currentScopeKey = resolveSessionWorkspaceKey(state.currentWorkspace);
    if (state.currentSessionId && (currentScopeKey !== scopeKey || state.currentSessionId !== id)) {
      persistCurrentSessionInBackground();
    }

    if (scopeKey !== GLOBAL_CHAT_KEY) addWorkspaceEntry(scopeKey);
    openSessionScope(scopeKey);
    markOnlySessionActive(scopeKey, id);
    setCurrentSessionId(id);
    const target = (useAppStore.getState().sessionsByWorkspace[scopeKey] || []).find((s: any) => s.id === id);
    const targetSessionKey = resolveSessionRuntimeKey(scopeKey, id);
    autosaveSuspendedForSessionRef.current = targetSessionKey || "";
    lastSessionRuntimeSignatureRef.current = "";
    useAppStore.setState({ ...CLOSED_SESSION_PANEL_STATE });
    void restoreSessionState(target, id, scopeKey);
  };

  const performDeleteSession = useCallback((scopeKey: string, id: number) => {
    setPendingSessionDelete((current) =>
      current?.scopeKey === scopeKey && current?.id === id ? null : current,
    );

    const state = useAppStore.getState();
    const wasCurrent = scopeKey === resolveSessionWorkspaceKey(state.currentWorkspace) && id === state.currentSessionId;
    const sessionTempKey = resolveSessionRuntimeKey(scopeKey, id);
    const sessionsBeforeDelete = state.sessionsByWorkspace[scopeKey] || [];
    const nextSession = wasCurrent ? chooseSessionAfterDelete(sessionsBeforeDelete, id) : null;
    const nextSessionId = nextSession?.id ?? null;
    const nextSessionKey = resolveSessionRuntimeKey(scopeKey, nextSessionId);
    if (sessionTempKey) {
      sessionTranscriptCacheRef.current.delete(sessionTempKey);
    }
    if (wasCurrent) {
      sessionRecoveryAttemptRef.current = "";
      lastSessionRuntimeSignatureRef.current = "";
      autosaveSuspendedForSessionRef.current = nextSessionKey || "";
    }
    removeSession(scopeKey, id, { nextSessionId });
    if (wasCurrent) {
      useAppStore.setState({ ...CLOSED_SESSION_PANEL_STATE });
      if (nextSession) {
        void restoreSessionState(nextSession, nextSession.id, scopeKey);
      } else {
        autosaveSuspendedForSessionRef.current = "";
        resetToEmptyChatView();
      }
    }
    void deleteProjectSession(scopeKey, id).then((sessions) => {
      useAppStore.setState((latest: any) => ({
        sessionsByWorkspace: {
          ...latest.sessionsByWorkspace,
          [scopeKey]: mergeSessionsAfterDelete(
            latest.sessionsByWorkspace[scopeKey] || [],
            id,
            sessions,
            scopeKey === resolveSessionWorkspaceKey(latest.currentWorkspace) ? latest.currentSessionId : latest.activeSessionByWorkspace[scopeKey] ?? null,
          ),
        },
      }));
    }).catch((error) => {
      appendDebugLog("warn", "session.storage", {
        phase: "delete_failed",
        scopeKey,
        sessionId: id,
        error: error instanceof Error ? error.message : String(error),
      });
    });
    if (sessionTempKey) {
      void deleteChatSessionTempFiles(sessionTempKey).catch((error) => {
        appendDebugLog("warn", "session.temp", {
          phase: "delete_failed",
          scopeKey,
          sessionId: id,
          sessionTempKey,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
  }, [removeSession, resetToEmptyChatView, restoreSessionState]);

  const handleDeleteSession = useCallback((scopeKey: string, id: number) => {
    const session = (useAppStore.getState().sessionsByWorkspace[scopeKey] || []).find((item: any) => item.id === id);
    setPendingSessionDelete({
      scopeKey,
      id,
      title: getSessionDeleteTitle(session, config.language),
      workspaceLabel: getWorkspaceDeleteLabel(scopeKey, workspaces, config.language),
    });
  }, [config.language, workspaces]);

  const sendFeishuText = useCallback(async (
    target: string | Pick<FeishuInboundMessage, "chatId" | "userId" | "messageId">,
    text: string,
  ) => {
    const payload = typeof target === "string"
      ? { chatId: target }
      : {
          chatId: target.chatId,
          userId: target.userId,
          openId: target.userId,
          messageId: target.messageId,
        };
    const chatId = payload.chatId;
    if (!chatId || !text.trim()) return;
    try {
      await invoke("send_feishu_message", { ...payload, text });
    } catch (error) {
      appendDebugLog("warn", "feishu.remote", {
        phase: "send_failed",
        chatId,
        hasUserId: typeof target !== "string" && !!target.userId,
        hasMessageId: typeof target !== "string" && !!target.messageId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }, []);

  const patchFeishuApprovalCard = useCallback((
    messageId: string | undefined,
    approval: FeishuPendingApproval,
    status: "approved" | "rejected" | "expired",
    resolvedBy?: string,
  ) => {
    const cardMessageId = String(messageId || approval.cardMessageId || "").trim();
    if (!cardMessageId) return;
    const language = useAppStore.getState().config.language === "en" ? "en" : "zh";
    const card = buildFeishuApprovalStatusCard(language, approval, status, resolvedBy);
    void invoke("patch_feishu_card", {
      messageId: cardMessageId,
      card,
    }).catch((error) => {
      appendDebugLog("warn", "feishu.remote", {
        phase: "patch_approval_card_failed",
        approvalId: approval.approvalId,
        messageId: cardMessageId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }, []);

  const updateFeishuPairingConfig = useCallback((message: FeishuInboundMessage) => {
    const pairedUser = createFeishuPairedUserFromMessage(message);
    setConfig((prev: any) => {
      const imAdapters = normalizeImAdaptersConfig(prev.imAdapters);
      return {
        ...prev,
        imAdapters: {
          ...imAdapters,
          feishu: {
            ...imAdapters.feishu,
            pairedUsers: upsertFeishuPairedUser(imAdapters.feishu.pairedUsers, pairedUser),
          },
        },
      };
    });
    useAppStore.getState().removeFeishuPairingRequest(message.userId);
    return pairedUser;
  }, [setConfig]);

  const ensureFeishuRemoteSession = useCallback((message: FeishuInboundMessage) => {
    const state = useAppStore.getState();
    const workspace = state.currentWorkspace;
    if (!workspace) return null;

    const scopeKey = resolveSessionWorkspaceKey(workspace);
    const title = createFeishuRemoteSessionTitle(message);
    const sessions = state.sessionsByWorkspace[scopeKey] || [];
    let target = sessions.find((session: any) => session.title === title) || null;

    if (state.currentSessionId) {
      state.updateSession(resolveSessionWorkspaceKey(state.currentWorkspace), state.currentSessionId, {
        messages: sanitizeTaskBlocksForPersist(state.taskFlow),
        active: false,
      });
    }

    for (const session of sessions) {
      if (session.active) state.updateSession(scopeKey, session.id, { active: false });
    }

    if (!target) {
      const createdAt = Date.now();
      const createdAtIso = new Date(createdAt).toISOString();
      target = {
        id: createdAt,
        title,
        date: createdAtIso,
        updatedAt: createdAtIso,
        updatedAtMs: createdAt,
        active: true,
        storageStatus: "temporary",
        recordingDisabled: !state.config.sessionRecordingEnabled,
        messages: [] as TaskBlock[],
      };
      state.addSession(scopeKey, target);
    } else {
      state.updateSession(scopeKey, target.id, { active: true });
    }

    state.setCurrentSessionId(target.id);
    void restoreSessionState(target, target.id, scopeKey);
    return target.id;
  }, []);

  const runFeishuRemoteMessage = useCallback((message: FeishuInboundMessage, fromQueue = false) => {
    const state = useAppStore.getState();
    const feishuConfig = normalizeImAdaptersConfig(state.config.imAdapters).feishu;
    const pairedUser = findFeishuPairedUser(feishuConfig, message.userId);
    if (!pairedUser) {
      state.upsertFeishuPairingRequest(createFeishuPairingRequest(message));
      const pairText = state.config.language === "en"
        ? `This Feishu user is not paired yet. Open MAIN Settings > IM Adapters, or reply /pair ${feishuConfig.pairingCode} in this private chat.`
        : `当前飞书用户尚未配对。请在 MAIN 的「系统设置 > 即时通讯适配器」中通过配对请求，或在飞书私聊里回复 /pair ${feishuConfig.pairingCode}。`;
      void sendFeishuText(message, pairText);
      return false;
    }

    if (!state.currentWorkspace) {
      void sendFeishuText(
        message,
        state.config.language === "en"
          ? "MAIN has no workspace open. Please open a project folder in the desktop app first."
          : "MAIN 当前没有打开工作区。请先在桌面端打开项目文件夹。",
      );
      return false;
    }

    const busy = state.isGenerating || state.agentStatus === "running" || state.agentStatus === "pending_review";
    if (busy) {
      if (!fromQueue) {
        remoteFeishuQueueRef.current.push(message);
        void sendFeishuText(
          message,
          state.config.language === "en"
            ? `MAIN is busy. Your message has been queued at position ${remoteFeishuQueueRef.current.length}.`
            : `MAIN 正在处理上一条任务，已将这条消息加入队列（第 ${remoteFeishuQueueRef.current.length} 位）。`,
        );
      }
      return false;
    }

    const linkedSessionId = state.feishuLinkedSessionId;
    const scopeKey = resolveSessionWorkspaceKey(state.currentWorkspace);
    const sessions = state.sessionsByWorkspace[scopeKey] || [];
    const isLinkedSessionValid = linkedSessionId && sessions.some((s: any) => s.id === linkedSessionId);

    if (isLinkedSessionValid) {
      if (state.currentSessionId !== linkedSessionId) {
        if (state.currentSessionId) {
          state.updateSession(scopeKey, state.currentSessionId, {
            messages: sanitizeTaskBlocksForPersist(state.taskFlow),
            active: false,
          });
        }
        for (const session of sessions) {
          if (session.active) state.updateSession(scopeKey, session.id, { active: false });
        }
        state.updateSession(scopeKey, linkedSessionId!, { active: true });
        state.setCurrentSessionId(linkedSessionId!);
        const target = sessions.find((s: any) => s.id === linkedSessionId);
        if (target) void restoreSessionState(target, linkedSessionId!, scopeKey);
      }
    } else {
      ensureFeishuRemoteSession(message);
    }
    void sendFeishuText(
      message,
      state.config.language === "en" ? "MAIN received the remote task and started processing." : "MAIN 已收到远程任务，开始处理。",
    );
    runAfterNextPaint(() => {
      const intentOverride = resolveFeishuRemoteIntentOverride(message.text);
      useAppStore.getState().sendMessage(message.text, undefined, {
        ...intentOverride,
        ...(intentOverride.resolvedIntent === "analyze"
          ? {
              turnTitle: state.config.language === "en" ? "Feishu remote analysis" : "飞书远程分析",
              intentSummary: state.config.language === "en"
                ? "Feishu remote private-chat message defaults to read-only analysis in the current workspace."
                : "飞书私聊远程消息默认按当前工作区的只读分析处理。",
            }
          : {}),
        remoteFeishu: {
          adapter: "feishu",
          chatId: message.chatId,
          userId: message.userId,
          userName: message.userName,
          messageId: message.messageId,
        },
      });
    });
    return true;
  }, [ensureFeishuRemoteSession, sendFeishuText]);

  const handleFeishuCardAction = useCallback((event: FeishuCardActionEvent) => {
    const state = useAppStore.getState();
    const feishuConfig = normalizeImAdaptersConfig(state.config.imAdapters).feishu;
    if (!findFeishuPairedUser(feishuConfig, event.userId)) {
      void sendFeishuText(
        event,
        state.config.language === "en"
          ? "This Feishu user is not paired with MAIN, so the approval was ignored."
          : "当前飞书用户尚未与 MAIN 配对，本次审批已忽略。",
      );
      return;
    }

    const result = state.resolvePendingFeishuApprovalAction({
      userId: event.userId,
      chatId: event.chatId,
      approvalId: event.approvalId,
      nonce: event.nonce,
      action: event.action,
    });

    if (!result.ok) {
      if (result.reason === "expired" && result.approval) {
        patchFeishuApprovalCard(event.messageId, result.approval, "expired", event.userName);
      }
      const message = state.config.language === "en"
        ? result.reason === "expired"
          ? "This approval has expired. Please ask MAIN to request approval again."
          : result.reason === "already_resolved"
          ? "This approval has already been handled."
          : "This approval button is no longer valid."
        : result.reason === "expired"
        ? "这条审批已过期。请让 MAIN 重新发起审批。"
        : result.reason === "already_resolved"
        ? "这条审批已经处理过。"
        : "这个审批按钮已经失效。";
      void sendFeishuText(event, message);
      return;
    }

    useAppStore.getState().setFeishuApprovalCardMessageId(event.approvalId, event.messageId);
    if (event.action === "approve") {
      state.allowToolAction(result.approval.taskId);
      patchFeishuApprovalCard(event.messageId, result.approval, "approved", event.userName);
    } else if (event.action === "approve_session") {
      state.approvePendingReviewForSession();
      patchFeishuApprovalCard(event.messageId, result.approval, "approved", event.userName);
    } else {
      state.rejectToolAction(result.approval.taskId);
      patchFeishuApprovalCard(event.messageId, result.approval, "rejected", event.userName);
    }
  }, [patchFeishuApprovalCard, sendFeishuText]);

  const handleFeishuInboundMessage = useCallback((message: FeishuInboundMessage) => {
    const state = useAppStore.getState();
    const command = parseFeishuTextCommand(message.text);
    const feishuConfig = normalizeImAdaptersConfig(state.config.imAdapters).feishu;

    if (command.kind === "pair") {
      if (command.code === feishuConfig.pairingCode) {
        updateFeishuPairingConfig(message);
        void sendFeishuText(
          message,
          state.config.language === "en"
            ? "Pairing complete. You can now send MAIN tasks from this private chat."
            : "配对完成。现在可以在这个飞书私聊里向 MAIN 发送任务了。",
        );
      } else {
        void sendFeishuText(
          message,
          state.config.language === "en" ? "Pairing code is incorrect." : "配对码不正确。",
        );
      }
      return;
    }

    if (command.kind === "approve" || command.kind === "approve_session" || command.kind === "reject") {
      const approval = state.resolvePendingFeishuApproval(
        message.userId,
        command.code,
        command.kind === "reject" ? "reject" : "approve"
      );
      if (!approval) {
        void sendFeishuText(
          message,
          state.config.language === "en" ? "No matching pending approval was found." : "没有找到匹配的待审批操作。",
        );
        return;
      }
      if (command.kind === "approve") {
        state.allowToolAction(approval.taskId);
        patchFeishuApprovalCard(approval.cardMessageId, approval, "approved", message.userName);
        void sendFeishuText(message, state.config.language === "en" ? "Approved." : "已允许执行。");
      } else if (command.kind === "approve_session") {
        state.approvePendingReviewForSession();
        patchFeishuApprovalCard(approval.cardMessageId, approval, "approved", message.userName);
        void sendFeishuText(message, state.config.language === "en" ? "Always approved." : "已全部批准（允许本会话）。");
      } else {
        state.rejectToolAction(approval.taskId);
        patchFeishuApprovalCard(approval.cardMessageId, approval, "rejected", message.userName);
        void sendFeishuText(message, state.config.language === "en" ? "Rejected." : "已拒绝执行。");
      }
      return;
    }

    if (command.kind === "help") {
      const isEn = state.config.language === "en";
      const helpText = isEn
        ? [
            "📋 **MAIN Feishu Remote Control Commands**",
            "",
            "• `/status` - View current work and adapter status",
            "• `/stop` - Stop current task and clear the remote queue",
            "• `/help` - Show this help message",
            "• `/new` (or `/reset`) - Create a fresh dedicated session and archive history",
            "• `/follow` - Link Feishu remote to the currently active desktop session",
            "• `/approve <code>` - Allow the pending execution once",
            "• `/always_allow <code>` (or `/approve_session <code>`) - Always allow/approve all for this session",
            "• `/reject <code>` - Reject the pending execution",
            "",
            "💡 *Tip: You can send any descriptive task to start remote execution/analysis directly in the current workspace.*",
          ].join("\n")
        : [
            "📋 **MAIN 飞书远程控制命令指南**",
            "",
            "• `/status` - 查看当前 MAIN 的工作状态与适配器连接",
            "• `/stop` - 停止当前生成并清空远程待执行队列",
            "• `/help` - 获取此命令帮助指南",
            "• `/new` (或 `/reset`) - 开辟并激活全新飞书会话，并将旧会话归档",
            "• `/follow` - 关联并锁定当前桌面端的活跃会话，开启离座双向追踪",
            "• `/approve <code>` - 允许本次挂起的工具/脚本执行",
            "• `/always_allow <code>` (或 `/approve_session <code>`) - 全部批准/允许本会话内的所有工具执行",
            "• `/reject <code>` - 拒绝本次挂起的工具执行",
            "",
            "💡 *提示：您可以直接发送任何自然语言任务，机器人将在当前工作区为您启动远程分析或执行。*"
          ].join("\n");
      const title = isEn ? "MAIN Command Guide" : "MAIN 飞书命令指南";
      const card = buildFeishuMarkdownCard(title, helpText, "blue");
      void invoke("send_feishu_card", {
        chatId: message.chatId,
        userId: message.userId,
        openId: message.userId,
        messageId: message.messageId,
        card,
      }).catch(() => {});
      return;
    }

    if (command.kind === "new") {
      const workspace = state.currentWorkspace;
      if (!workspace) {
        void sendFeishuText(
          message,
          state.config.language === "en" ? "No workspace open." : "未打开工作区。",
        );
        return;
      }
      const scopeKey = resolveSessionWorkspaceKey(workspace);
      const title = createFeishuRemoteSessionTitle(message);
      const sessions = state.sessionsByWorkspace[scopeKey] || [];
      const target = sessions.find((session: any) => session.title === title) || null;

      if (target) {
        const timeStr = new Date().toLocaleTimeString(state.config.language === "en" ? "en-US" : "zh-CN", {
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        });
        const dateStr = new Date().toLocaleDateString(state.config.language === "en" ? "en-US" : "zh-CN", {
          month: "2-digit",
          day: "2-digit",
        });
        const archiveSuffix = state.config.language === "en"
          ? ` (Archived ${dateStr} ${timeStr})`
          : ` (归档 ${dateStr} ${timeStr})`;
        state.updateSession(scopeKey, target.id, {
          title: `${title}${archiveSuffix}`,
          active: false,
        });
      }

      state.setFeishuLinkedSession(null, null);

      const responseText = state.config.language === "en"
        ? "Successfully created a fresh remote conversation. Previous history archived."
        : "已成功为您开辟并激活全新飞书会话，接下来的指令将使用干净的上下文运行！";
      void sendFeishuText(message, responseText);
      return;
    }

    if (command.kind === "follow") {
      const currentSessionId = state.currentSessionId;
      if (!currentSessionId || !state.currentWorkspace) {
        void sendFeishuText(
          message,
          state.config.language === "en"
            ? "MAIN has no active session open in the current workspace."
            : "MAIN 当前在工作区中没有打开任何活动会话，无法进行关注。",
        );
        return;
      }

      const scopeKey = resolveSessionWorkspaceKey(state.currentWorkspace);
      const sessions = state.sessionsByWorkspace[scopeKey] || [];
      const currentSession = sessions.find((s: any) => s.id === currentSessionId);
      const sessionTitle = currentSession?.title || "Unknown Session";

      state.setFeishuLinkedSession(currentSessionId, {
        adapter: "feishu",
        chatId: message.chatId,
        userId: message.userId,
        userName: message.userName,
        messageId: message.messageId,
      });

      const successText = state.config.language === "en"
        ? `Successfully linked to desktop active session: 【${sessionTitle}】.\nCommands sent from Feishu will now execute in this session, and any execution updates will be streamed to you in real-time!`
        : `已成功关联当前桌面端活动会话：【${sessionTitle}】。\n您接下来在飞书发送的消息将被直接发送到该会话中执行，且该会话的后续执行状态将实时同步至飞书！`;
      void sendFeishuText(message, successText);
      return;
    }

    if (command.kind === "status") {
      const status = state.feishuAdapterStatus;
      const workspaceLabel = state.currentWorkspace || (state.config.language === "en" ? "No workspace" : "未打开工作区");
      const text = state.config.language === "en"
        ? `Feishu adapter: ${status.status}\nMAIN: ${state.agentStatus}\nWorkspace: ${workspaceLabel}\nQueue: ${remoteFeishuQueueRef.current.length}`
        : `飞书适配器：${status.status}\nMAIN 状态：${state.agentStatus}\n工作区：${workspaceLabel}\n队列：${remoteFeishuQueueRef.current.length}`;
      void sendFeishuText(message, text);
      return;
    }

    if (command.kind === "stop") {
      state.stopGeneration();
      remoteFeishuQueueRef.current = [];
      void sendFeishuText(message, state.config.language === "en" ? "Stopped current generation and cleared the remote queue." : "已停止当前生成，并清空远程队列。");
      return;
    }

    if (!findFeishuPairedUser(feishuConfig, message.userId)) {
      state.upsertFeishuPairingRequest(createFeishuPairingRequest(message));
      void sendFeishuText(
        message,
        state.config.language === "en"
          ? `This Feishu user is not paired yet. Reply /pair ${feishuConfig.pairingCode} to pair.`
          : `当前飞书用户尚未配对。请回复 /pair ${feishuConfig.pairingCode} 完成配对。`,
      );
      return;
    }

    runFeishuRemoteMessage({ ...message, text: command.text });
  }, [patchFeishuApprovalCard, runFeishuRemoteMessage, sendFeishuText, updateFeishuPairingConfig]);

  useEffect(() => {
    const feishuConfig = normalizeImAdaptersConfig(config.imAdapters).feishu;
    if (!feishuConfig.enabled) {
      void invoke("stop_feishu_adapter").catch(() => {});
      useAppStore.getState().setFeishuAdapterStatus({
        status: "stopped",
        running: false,
        message: config.language === "en" ? "Feishu adapter is disabled." : "飞书适配器未启用。",
      });
      return;
    }
    if (!feishuConfig.appId.trim() || !feishuConfig.appSecret.trim()) {
      useAppStore.getState().setFeishuAdapterStatus({
        status: "idle",
        running: false,
        message: config.language === "en" ? "Waiting for Feishu App ID and App Secret." : "等待填写飞书 App ID 和 App Secret。",
      });
      return;
    }
    if (feishuStartingRef.current) return;
    feishuStartingRef.current = true;
    void invoke("start_feishu_adapter", {
      config: {
        appId: feishuConfig.appId,
        appSecret: feishuConfig.appSecret,
        domain: feishuConfig.domain,
      },
    })
      .then((status: any) => {
        useAppStore.getState().setFeishuAdapterStatus(status);
      })
      .catch((error) => {
        useAppStore.getState().setFeishuAdapterStatus({
          status: "error",
          running: false,
          message: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        feishuStartingRef.current = false;
      });
  }, [
    config.imAdapters?.feishu?.appId,
    config.imAdapters?.feishu?.appSecret,
    config.imAdapters?.feishu?.domain,
    config.imAdapters?.feishu?.enabled,
    config.language,
  ]);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    void listen<FeishuAdapterEvent>("feishu-adapter-event", (event) => {
      const payload = event.payload;
      if (payload.type === "status" || payload.type === "error") {
        useAppStore.getState().setFeishuAdapterStatus({
          status: payload.status || (payload.type === "error" ? "error" : "idle"),
          running: payload.running === true,
          message: payload.message || "",
          pid: payload.pid ?? null,
          updatedAt: payload.timestamp || Date.now(),
        });
        return;
      }
      if (payload.type === "message_sent") {
        if (payload.approvalId && payload.messageId) {
          useAppStore.getState().setFeishuApprovalCardMessageId(payload.approvalId, payload.messageId);
        }
        return;
      }
      if (payload.type === "card_action") {
        handleFeishuCardAction(payload);
        return;
      }
      if (payload.type === "message") {
        handleFeishuInboundMessage(payload);
      }
    }).then((dispose) => {
      unlisten = dispose;
    });
    return () => {
      unlisten?.();
    };
  }, [handleFeishuCardAction, handleFeishuInboundMessage]);

  useEffect(() => {
    const state = useAppStore.getState();
    const busy = state.isGenerating || state.agentStatus === "running" || state.agentStatus === "pending_review";
    if (busy || remoteFeishuQueueRef.current.length === 0) return;
    const next = remoteFeishuQueueRef.current.shift();
    if (next) runFeishuRemoteMessage(next, true);
  }, [agentStatus, isStreaming, runFeishuRemoteMessage]);

  const startResizing = (e: React.MouseEvent) => { e.preventDefault(); setIsResizing(true); };
  const startFilePanelResizing = (e: React.MouseEvent) => { e.preventDefault(); setIsFilePanelResizing(true); };
  const startSidebarResizing = (e: React.MouseEvent) => { e.preventDefault(); setIsSidebarResizing(true); };

  const sidebarWidthRef = useRef(sidebarWidth);
  const languageRef = useRef(config.language);
  const handleOpenWorkspacePathRef = useRef(handleOpenWorkspacePath);

  useEffect(() => {
    sidebarWidthRef.current = sidebarWidth;
  }, [sidebarWidth]);

  useEffect(() => {
    languageRef.current = config.language;
  }, [config.language]);

  useEffect(() => {
    handleOpenWorkspacePathRef.current = handleOpenWorkspacePath;
  }, [handleOpenWorkspacePath]);

  useEffect(() => {
    let cancelled = false;
    const storedLastCheckedAt = Number(window.localStorage.getItem(MAIN_UPDATE_LAST_CHECK_KEY) || "0");
    if (Number.isFinite(storedLastCheckedAt) && storedLastCheckedAt > 0) {
      setLastMainUpdateCheckedAt(storedLastCheckedAt);
    }

    void getVersion()
      .then((version) => {
        if (!cancelled) setAppVersion(version);
      })
      .catch((error) => {
        appendDebugLog("warn", "main.update", {
          phase: "version_read_failed",
          error: getErrorMessage(error),
        });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const runMainUpdateCheck = useCallback(async (
    source: "startup" | "manual",
    options: { force?: boolean } = {},
  ) => {
    const now = Date.now();
    const lastCheckedAt = Number(window.localStorage.getItem(MAIN_UPDATE_LAST_CHECK_KEY) || "0");
    const elapsedMs = Number.isFinite(lastCheckedAt) ? now - lastCheckedAt : Number.POSITIVE_INFINITY;

    if (!options.force && Number.isFinite(lastCheckedAt) && elapsedMs < MAIN_UPDATE_CHECK_INTERVAL_MS) {
      if (lastCheckedAt > 0) setLastMainUpdateCheckedAt(lastCheckedAt);
      appendDebugLog("info", "main.update", {
        phase: "check_skipped_throttled",
        source,
        lastCheckedAt,
        elapsedMs,
        nextAllowedAt: lastCheckedAt + MAIN_UPDATE_CHECK_INTERVAL_MS,
      });
      return null;
    }

    window.localStorage.setItem(MAIN_UPDATE_LAST_CHECK_KEY, String(now));
    setLastMainUpdateCheckedAt(now);
    setMainUpdateStatus("checking");
    setMainUpdateError("");
    setMainUpdateProgress(null);
    setAvailableMainUpdate(null);
    appendDebugLog("info", "main.update", {
      phase: "check_start",
      source,
      force: !!options.force,
      currentVersion: appVersion || undefined,
    });

    try {
      const update = await checkForMainUpdate({ ignoreUnavailable: !options.force });
      setAvailableMainUpdate(update);
      setMainUpdateStatus(update ? "available" : "upToDate");

      appendDebugLog("info", "main.update", update
        ? {
            phase: "check_available",
            source,
            currentVersion: update.currentVersion,
            version: update.version,
            date: update.date,
          }
        : {
            phase: "check_up_to_date",
            source,
            currentVersion: appVersion || undefined,
          });

      return update;
    } catch (error) {
      const message = getErrorMessage(error) || "Update check failed.";
      setMainUpdateStatus("error");
      setMainUpdateError(message);
      setMainUpdateProgress(null);
      appendDebugLog("warn", "main.update", {
        phase: "check_failed",
        source,
        error: message,
      });
      return null;
    }
  }, [appVersion]);

  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void (async () => {
        if (cancelled) return;
        await runMainUpdateCheck("startup", { force: false });
      })();
    }, MAIN_UPDATE_STARTUP_DELAY_MS);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [runMainUpdateCheck]);

  const handleCheckMainUpdate = useCallback(() => {
    void runMainUpdateCheck("manual", { force: true });
  }, [runMainUpdateCheck]);

  const handleInstallMainUpdate = useCallback(async () => {
    if (!availableMainUpdate || mainUpdateStatus === "downloading" || mainUpdateStatus === "installing") return;

    const language = languageRef.current === "en" ? "en" : "zh";
    const notes = summarizeUpdateNotes(availableMainUpdate.notes);
    const message = language === "en"
      ? [
          `Install MAIN ${availableMainUpdate.version}?`,
          "",
          `Current version: ${availableMainUpdate.currentVersion}`,
          `New version: ${availableMainUpdate.version}`,
          notes ? "" : null,
          notes || null,
        ].filter(Boolean).join("\n")
      : [
          `安装 MAIN ${availableMainUpdate.version}？`,
          "",
          `当前版本：${availableMainUpdate.currentVersion}`,
          `新版本：${availableMainUpdate.version}`,
          notes ? "" : null,
          notes || null,
        ].filter(Boolean).join("\n");

    if (!(await safeConfirmAsync(message, { source: "App", action: "install_main_update" }))) return;

    setMainUpdateStatus("downloading");
    setMainUpdateError("");
    setMainUpdateProgress(null);
    appendDebugLog("info", "main.update", {
      phase: "install_start",
      currentVersion: availableMainUpdate.currentVersion,
      version: availableMainUpdate.version,
    });

    try {
      await installMainUpdate(availableMainUpdate, (progress) => {
        setMainUpdateProgress(progress);
        setMainUpdateStatus(progress.stage);
      });
    } catch (error) {
      const message = getErrorMessage(error) || (language === "en" ? "Update failed." : "更新失败。");
      setMainUpdateStatus("error");
      setMainUpdateError(message);
      setMainUpdateProgress(null);
      appendDebugLog("warn", "main.update", {
        phase: "install_failed",
        currentVersion: availableMainUpdate.currentVersion,
        version: availableMainUpdate.version,
        error: message,
      });
    }
  }, [availableMainUpdate, mainUpdateStatus]);

  useEffect(() => {
    const MIN_SIDEBAR_WIDTH = 220;
    const MIN_RIGHT_PANEL_WIDTH = 340;
    const MIN_FILE_PANEL_WIDTH = 260;
    const MAX_FILE_PANEL_WIDTH = 520;
    const MIN_CHAT_INPUT_AREA_WIDTH = 368;

    const flushRightPanelWidth = () => {
      if (rightPanelResizeFrameRef.current !== null) {
        window.cancelAnimationFrame(rightPanelResizeFrameRef.current);
        rightPanelResizeFrameRef.current = null;
      }
      const nextWidth = pendingRightPanelWidthRef.current;
      pendingRightPanelWidthRef.current = null;
      if (typeof nextWidth === "number") {
        setRightPanelWidth(nextWidth);
      }
    };

    const scheduleRightPanelWidth = (nextWidth: number) => {
      pendingRightPanelWidthRef.current = nextWidth;
      if (rightPanelResizeFrameRef.current !== null) return;
      rightPanelResizeFrameRef.current = window.requestAnimationFrame(() => {
        rightPanelResizeFrameRef.current = null;
        const width = pendingRightPanelWidthRef.current;
        pendingRightPanelWidthRef.current = null;
        if (typeof width === "number") {
          setRightPanelWidth(width);
        }
      });
    };

    const onMouseMove = (e: MouseEvent) => {
      if (isResizing) {
        let w = window.innerWidth - e.clientX;
        const reservedFileWidth = isFilePanelVisible ? filePanelWidth : 0;
        const maxRightPanelWidth = Math.max(
          MIN_RIGHT_PANEL_WIDTH,
          window.innerWidth - sidebarWidth - reservedFileWidth - MIN_CHAT_INPUT_AREA_WIDTH,
        );
        if (w < MIN_RIGHT_PANEL_WIDTH) w = MIN_RIGHT_PANEL_WIDTH;
        if (w > maxRightPanelWidth) w = maxRightPanelWidth;
        scheduleRightPanelWidth(w);
      } else if (isFilePanelResizing) {
        const reservedRightWidth = isRightPanelVisible ? rightPanelWidth : 0;
        let w = window.innerWidth - reservedRightWidth - e.clientX;
        const maxFilePanelWidth = Math.min(
          MAX_FILE_PANEL_WIDTH,
          Math.max(
            MIN_FILE_PANEL_WIDTH,
            window.innerWidth - sidebarWidth - reservedRightWidth - MIN_CHAT_INPUT_AREA_WIDTH,
          ),
        );
        if (w < MIN_FILE_PANEL_WIDTH) w = MIN_FILE_PANEL_WIDTH;
        if (w > maxFilePanelWidth) w = maxFilePanelWidth;
        setFilePanelWidth(w);
      } else if (isSidebarResizing) {
        let w = e.clientX;
        if (w < MIN_SIDEBAR_WIDTH) w = MIN_SIDEBAR_WIDTH;
        if (w > 500) w = 500;
        setSidebarWidth(w);
      }
    };
    const onMouseUp = () => {
      flushRightPanelWidth();
      setIsResizing(false);
      setIsFilePanelResizing(false);
      setIsSidebarResizing(false);
    };

    if (isResizing || isFilePanelResizing || isSidebarResizing) {
      window.addEventListener("mousemove", onMouseMove);
      window.addEventListener("mouseup", onMouseUp);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    }

    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      if (rightPanelResizeFrameRef.current !== null && !isResizing) {
        window.cancelAnimationFrame(rightPanelResizeFrameRef.current);
        rightPanelResizeFrameRef.current = null;
        pendingRightPanelWidthRef.current = null;
      }
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [
    filePanelWidth,
    isFilePanelResizing,
    isFilePanelVisible,
    isRightPanelVisible,
    isResizing,
    isSidebarResizing,
    rightPanelWidth,
    setFilePanelWidth,
    setRightPanelWidth,
    setSidebarWidth,
    sidebarWidth,
  ]);

  useEffect(() => {
    const MIN_CENTER_WIDTH = 368;
    const MIN_SIDEBAR_WIDTH = 220;
    const MIN_RIGHT_PANEL_WIDTH = 340;
    const MIN_FILE_PANEL_WIDTH = 260;
    const MAX_FILE_PANEL_WIDTH = 520;

    const clampLayout = () => {
      const totalWidth = window.innerWidth;
      let rightWidth = isRightPanelVisible ? rightPanelWidth : 0;
      let fileWidth = isFilePanelVisible ? filePanelWidth : 0;

      if (isRightPanelVisible) {
        const minWithRightOnly = MIN_CENTER_WIDTH + MIN_SIDEBAR_WIDTH + MIN_RIGHT_PANEL_WIDTH + fileWidth;

        if (totalWidth < minWithRightOnly) {
          closeRightPanel();
          rightWidth = 0;
        }
      }

      if (isFilePanelVisible) {
        const minWithFile = MIN_CENTER_WIDTH + MIN_SIDEBAR_WIDTH + MIN_FILE_PANEL_WIDTH + rightWidth;

        if (totalWidth < minWithFile) {
          closeFilePanel();
          fileWidth = 0;
        }
      }

      const nextSidebarMax = Math.max(MIN_SIDEBAR_WIDTH, totalWidth - rightWidth - fileWidth - MIN_CENTER_WIDTH);
      const nextSidebar = Math.min(sidebarWidth, nextSidebarMax);
      if (nextSidebar !== sidebarWidth) {
        setSidebarWidth(nextSidebar);
      }

      const nextFileMax = Math.min(
        MAX_FILE_PANEL_WIDTH,
        Math.max(MIN_FILE_PANEL_WIDTH, totalWidth - nextSidebar - rightWidth - MIN_CENTER_WIDTH),
      );
      if (isFilePanelVisible && filePanelWidth > nextFileMax) {
        setFilePanelWidth(nextFileMax);
        fileWidth = nextFileMax;
      }

      const nextRightMax = Math.max(MIN_RIGHT_PANEL_WIDTH, totalWidth - nextSidebar - fileWidth - MIN_CENTER_WIDTH);
      if (isRightPanelVisible && rightPanelWidth > nextRightMax) {
        setRightPanelWidth(nextRightMax);
      }
    };

    clampLayout();
    window.addEventListener("resize", clampLayout);
    return () => window.removeEventListener("resize", clampLayout);
  }, [
    closeFilePanel,
    closeRightPanel,
    filePanelWidth,
    isFilePanelVisible,
    isRightPanelVisible,
    rightPanelWidth,
    setFilePanelWidth,
    setRightPanelWidth,
    setSidebarWidth,
    sidebarWidth,
  ]);

  useEffect(() => {
    const preventNativeContextMenu = (event: MouseEvent) => {
      event.preventDefault();
    };
    window.addEventListener("contextmenu", preventNativeContextMenu, true);
    return () => {
      window.removeEventListener("contextmenu", preventNativeContextMenu, true);
    };
  }, []);

  useEffect(() => {
    if (!currentSessionId || taskFlow.length > 0) return;
    const target = activeSessionRecord || (useAppStore.getState().sessionsByWorkspace[activeSessionScope] || []).find((s: any) => s.id === currentSessionId);
    if (!target) return;
    const hasTargetDetails =
      hasRecoverableSessionTranscript(target) ||
      hasStoredSessionDetailPointer(target);
    if (hasTargetDetails) {
      const attemptKey = [
        activeSessionScope,
        currentSessionId,
        activeSessionRecoveryKey,
        taskFlow.length,
        conversationTurns.length,
      ].join("|");
      if (sessionRecoveryAttemptRef.current === attemptKey) return;
      sessionRecoveryAttemptRef.current = attemptKey;
      void restoreSessionState(target, currentSessionId, activeSessionScope);
    }
  }, [activeSessionRecoveryKey, activeSessionScope, conversationTurns.length, currentSessionId, taskFlow.length]);

  useEffect(() => {
    let unlisten: (() => void | Promise<void>) | null = null;
    let disposed = false;
    const safelyDispose = (dispose: (() => void | Promise<void>) | null) => {
      if (!dispose) return;
      try {
        const result = dispose();
        if (result && typeof (result as Promise<void>).catch === "function") {
          void (result as Promise<void>).catch(() => {});
        }
      } catch {
        // Listener cleanup can race during hot reload or rapid webview navigation.
      }
    };

    void (async () => {
      try {
        const dispose = await getCurrentWebview().onDragDropEvent((event) => {
          const payload = event.payload;
          if (payload.type === "enter" || payload.type === "over") {
            setIsWorkspaceDropActive(payload.position.x <= sidebarWidthRef.current);
            return;
          }
          if (payload.type === "leave") {
            setIsWorkspaceDropActive(false);
            return;
          }
          if (payload.type !== "drop") return;

          const isSidebarDrop = payload.position.x <= sidebarWidthRef.current;
          setIsWorkspaceDropActive(false);
          if (!isSidebarDrop) return;

          void (async () => {
            const added: Array<{ path: string; rebuildIndex: boolean }> = [];
            let ignoredFiles = 0;
            for (const path of payload.paths || []) {
              try {
                const stablePath = await canonicalizeWorkspacePath(path);
                const wasKnownWorkspace = useAppStore.getState().workspaces.some((entry: any) => entry.path === stablePath);
                addWorkspaceEntry(stablePath);
                added.push({ path: stablePath, rebuildIndex: !wasKnownWorkspace });
              } catch {
                ignoredFiles += 1;
                // Dragging files is intentionally ignored here; only folders become workspaces.
              }
            }
            if (added.length > 0) {
              const [firstWorkspace, ...backgroundWorkspaces] = added;
              await handleOpenWorkspacePathRef.current(firstWorkspace.path, {
                selectFirstSession: true,
                rebuildIndex: firstWorkspace.rebuildIndex,
              });
              backgroundWorkspaces.forEach(({ path, rebuildIndex }) => {
                if (rebuildIndex) void refreshSessionsForScope(path, { rebuildIndex: true });
              });
            } else if (ignoredFiles > 0) {
              window.alert(languageRef.current === "en" ? "Drop folders to add workspaces." : "请拖拽文件夹来加入工作区。");
            }
          })();
        });

        if (disposed) {
          safelyDispose(dispose);
          return;
        }
        unlisten = dispose;
      } catch {
        // Browser/e2e environments without Tauri simply skip native folder drop.
      }
    })();

    return () => {
      disposed = true;
      safelyDispose(unlisten);
    };
  }, [addWorkspaceEntry, refreshSessionsForScope]);

  return (
    <div className="flex h-screen w-full bg-[#000000] text-[#e4e4e7] font-sans text-sm overflow-hidden md:flex-row flex-col relative"
      style={{ '--accent': currentTheme.accent, '--accent-hover': currentTheme.hover, '--accent-light': currentTheme.light, '--accent-subtle': currentTheme.subtle, '--accent-subtle-border': currentTheme.subtleBorder, '--accent-contrast': currentTheme.contrast } as React.CSSProperties}>
      <ThemeStyles />
      <Sidebar
        config={{ ...config, onOpenSettings: () => { setSettingsTab('general'); setIsSettingsOpen(true); }, onOpenSkills: () => setIsSkillsOpen(true) }}
        t={t}
        currentWorkspace={currentWorkspace}
        selectedWorkspace={sidebarWorkspace}
        workspaces={workspaces}
        sessionsByWorkspace={sessionsByWorkspace}
        globalSessions={globalSessions}
        currentSessionId={currentSessionId}
        activeSessionByWorkspace={activeSessionByWorkspace}
        sidebarWidth={sidebarWidth}
        workspaceStatuses={workspaceStatuses}
        sessionStatuses={sessionStatuses}
        isWorkspaceDropActive={isWorkspaceDropActive}
        updateStatus={mainUpdateStatus}
        availableUpdateVersion={availableMainUpdate?.version || ""}
        updateError={mainUpdateError}
        updateProgressPercent={mainUpdateProgress?.percent ?? null}
        onInstallUpdate={handleInstallMainUpdate}
        onSetSidebarWidth={setSidebarWidth}
        onStartResizing={startSidebarResizing}
        onOpenGlobalChat={handleOpenGlobalChat}
        onAddWorkspace={handleSelectWorkspace}
        onSelectWorkspace={handleSelectWorkspace}
        onSelectWorkspaceRoot={(path) => void handleOpenWorkspacePath(path, { selectFirstSession: true })}
        onRemoveWorkspaceEntry={handleRemoveWorkspaceEntry}
        onCreateSession={handleCreateSessionForScope}
        onSelectSession={handleSelectSession}
        onDeleteSession={handleDeleteSession}
      />
      <ChatArea taskFlow={taskFlow} t={t} config={config} setSettingsTab={setSettingsTab} setIsSettingsOpen={setIsSettingsOpen} activeDiffTask={activeDiffTask} endOfFlowRef={endOfFlowRef} isStreaming={isStreaming} activeSessionKey={activeSessionKey} onStopGeneration={handleStopGeneration} onLoadOlderSessionHistory={getCachedSessionTranscript(activeSessionKey)?.hasMore ? handleLoadOlderSessionHistory : undefined} allowToolAction={allowToolAction} rejectToolAction={rejectToolAction} autoApproveTools={autoApproveTools} onToggleAutoApprove={setAutoApproveTools} contextMentions={contextMentions} setContextMentions={setContextMentions} attachedFiles={attachedFiles} setAttachedFiles={setAttachedFiles} onAttachFile={handleAttachFile} showAgentPicker={showAgentPicker} setShowAgentPicker={setShowAgentPicker} selectedMainModeKey={selectedMainModeKey} setSelectedMainModeKey={setSelectedMainModeKey} mainModes={mainModes} activeStudioAgentKey={activeStudioAgentKey} setActiveStudioAgentKey={setActiveStudioAgentKey} gameStudioInitialized={gameStudioInitialized} initializeGameStudioWorkspace={initializeGameStudioWorkspace} removeGameStudioWorkspace={removeGameStudioWorkspace} currentWorkspace={currentWorkspace} handleAcceptInline={handleAcceptInline} handleRejectInline={handleRejectInline} onSendMessage={handleSendMessage} onQuickReply={handleQuickReply} />
      <FilePanel width={filePanelWidth} onStartResizing={startFilePanelResizing} />
      <RightPanel activeDiffTask={activeDiffTask} rightPanelWidth={rightPanelWidth} startResizing={startResizing} />
      {pendingSessionDelete && (
        <div
          data-testid="delete-session-confirmation"
          className="fixed inset-0 z-[80] flex items-center justify-center bg-black/70 px-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="delete-session-confirmation-title"
        >
          <div className="w-full max-w-md rounded-xl border border-[#3f1f1f] bg-[#09090b] p-5 shadow-2xl">
            <div className="flex items-start gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-[#7f1d1d] bg-[#181111] text-[#fca5a5]">
                <span className="text-lg font-black">!</span>
              </div>
              <div className="min-w-0 flex-1">
                <h2 id="delete-session-confirmation-title" className="text-[15px] font-bold text-[#f4f4f5]">
                  {config.language === "en" ? "Delete Session" : "删除会话"}
                </h2>
                <p className="mt-2 break-words text-[13px] leading-relaxed text-[#d4d4d8]">
                  {config.language === "en"
                    ? `Delete “${pendingSessionDelete.title}” from ${pendingSessionDelete.workspaceLabel}?`
                    : `确定要删除「${pendingSessionDelete.title}」吗？`}
                </p>
                <p className="mt-2 text-[12px] leading-relaxed text-[#fca5a5]">
                  {config.language === "en"
                    ? "This will permanently delete the session history and related temporary files. This action cannot be undone."
                    : "删除后会永久移除该会话历史和相关临时文件，此操作不可恢复。"}
                </p>
              </div>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                data-testid="delete-session-cancel"
                onClick={() => setPendingSessionDelete(null)}
                className="rounded-md border border-[#27272a] bg-[#18181b] px-4 py-2 text-[12px] font-bold text-[#d4d4d8] transition-colors hover:border-[#3f3f46] hover:text-white"
              >
                {config.language === "en" ? "Cancel" : "取消"}
              </button>
              <button
                type="button"
                data-testid="delete-session-confirm"
                onClick={() => performDeleteSession(pendingSessionDelete.scopeKey, pendingSessionDelete.id)}
                className="rounded-md border border-[#7f1d1d] bg-[#b91c1c] px-4 py-2 text-[12px] font-bold text-white transition-colors hover:bg-[#dc2626]"
              >
                {config.language === "en" ? "Delete Permanently" : "确认删除"}
              </button>
            </div>
          </div>
        </div>
      )}
      <SettingsModal isOpen={isSettingsOpen} onClose={() => setIsSettingsOpen(false)} config={config} setConfig={setConfig} t={t} THEMES={THEMES} settingsTab={settingsTab} setSettingsTab={setSettingsTab} mcpServers={mcpServers} setMcpServers={setMcpServers} mcpDiscoveredTools={mcpDiscoveredTools} setMcpDiscoveredTools={setMcpDiscoveredTools} appVersion={appVersion} updateStatus={mainUpdateStatus} availableUpdateVersion={availableMainUpdate?.version || ""} availableUpdateNotes={availableMainUpdate?.notes || ""} updateError={mainUpdateError} updateProgressPercent={mainUpdateProgress?.percent ?? null} lastUpdateCheckedAt={lastMainUpdateCheckedAt} onCheckForUpdate={handleCheckMainUpdate} onInstallUpdate={handleInstallMainUpdate} modelRuntimeLock={modelRuntimeLock} />
      <SkillsModal isOpen={isSkillsOpen} onClose={() => setIsSkillsOpen(false)} t={t} skills={skills} currentWorkspace={currentWorkspace} toggleSkill={toggleSkill} deleteSkill={deleteSkill} addSkill={addSkill} updateSkill={updateSkill} isAddingSkill={isAddingSkill} setIsAddingSkill={setIsAddingSkill} />
    </div>
  );
}
