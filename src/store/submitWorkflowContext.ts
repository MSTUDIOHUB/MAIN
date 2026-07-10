import type { AttachedFile } from "../lib/attachments";
import type { FeishuRemoteContext } from "../lib/remoteContextTypes";
import type { StudioConfig } from "../lib/gameStudio/catalog";
import type { CommandDirective, ResolvedRunIntent } from "../lib/runIntent";
import type { WorkflowContext } from "../lib/orchestrator/workflowEngine";

export interface CreateSubmitWorkflowContextInput {
  turnId: string;
  uiDisplayTurnId: string;
  runWorkspace: string | undefined;
  runSessionKey: string;
  runSessionId: number | null | undefined;
  runScopeKey: string;
  phaseLanguage: "zh" | "en";
  effectiveRunIntent: ResolvedRunIntent;
  runtimeRunIntent: ResolvedRunIntent;
  effectiveCommandDirective: CommandDirective | null;
  options: unknown;
  attachedFilesSnapshot: Array<AttachedFile | string>;
  mentionSnapshot: string[];
  remoteFeishu: FeishuRemoteContext | undefined;
  workspaceTree: string | null;
  gameStudioConfigForTurn: StudioConfig | null;
  abortCtrl: AbortController;
  timerInterval: unknown;
  sendStartedAt: number;
  harnessRunId: string;
  turnAgentMessagesStart: number;
  getElapsedSeconds: () => number;
  PLAN_EXECUTION_PROGRESS_DEFAULT_MAX_ITERATIONS: number;
  PROVIDER_COMPATIBILITY_FORCE_XML_TTL_MS: number;
  PROVIDER_COMPATIBILITY_NATIVE_RECOVERY_SUCCESS_STREAK: number;
}

export function createSubmitWorkflowContext(
  input: CreateSubmitWorkflowContextInput,
): WorkflowContext {
  return {
    turnId: input.turnId,
    uiDisplayTurnId: input.uiDisplayTurnId,
    runWorkspace: input.runWorkspace,
    runSessionKey: input.runSessionKey,
    runSessionId: input.runSessionId,
    runScopeKey: input.runScopeKey,
    phaseLanguage: input.phaseLanguage,
    effectiveRunIntent: input.effectiveRunIntent,
    runtimeRunIntent: input.runtimeRunIntent,
    effectiveCommandDirective: input.effectiveCommandDirective,
    options: input.options,
    attachedFilesSnapshot: input.attachedFilesSnapshot,
    mentionSnapshot: input.mentionSnapshot,
    remoteFeishu: input.remoteFeishu,
    workspaceTree: input.workspaceTree,
    gameStudioConfigForTurn: input.gameStudioConfigForTurn,
    abortCtrl: input.abortCtrl,
    timerInterval: input.timerInterval,
    sendStartedAt: input.sendStartedAt,
    harnessRunId: input.harnessRunId,
    streamBuffer: null,
    thinkingInterceptor: null,
    turnAgentMessagesStart: input.turnAgentMessagesStart,
    getElapsedSeconds: input.getElapsedSeconds,
    agentBlockIdsCreatedThisRun: new Set<number>(),
    firstStreamTokenAt: null,
    streamTokenCount: 0,
    streamTextChars: 0,
    noFirstTokenNoticeTimer: null,
    currentStreamingBlockId: null,
    currentThoughtBlockId: null,
    thoughtStartTime: null,
    streamingAssistantDisplayBuffer: "",
    understandingProgressBlockId: null,
    understandingProgressClosed: false,
    PLAN_EXECUTION_PROGRESS_DEFAULT_MAX_ITERATIONS: input.PLAN_EXECUTION_PROGRESS_DEFAULT_MAX_ITERATIONS,
    PROVIDER_COMPATIBILITY_FORCE_XML_TTL_MS: input.PROVIDER_COMPATIBILITY_FORCE_XML_TTL_MS,
    PROVIDER_COMPATIBILITY_NATIVE_RECOVERY_SUCCESS_STREAK: input.PROVIDER_COMPATIBILITY_NATIVE_RECOVERY_SUCCESS_STREAK,
  };
}
