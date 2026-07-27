import type { AttachedFile } from "../lib/attachments";
import type { FeishuRemoteContext } from "../lib/remoteContextTypes";
import type { StudioConfig } from "../lib/gameStudio/catalog";
import type { CommandDirective, ResolvedRunIntent } from "../lib/runIntent";
import type { SubmissionRuntimeContext } from "../lib/submissionRuntimeContracts";
import type { PlanExecutionRunProvenance } from "../lib/planExecutionProvenance";
import type {
  GoalContinuationAuthorization,
  GoalCreationAuthorization,
} from "../lib/submit/turnSubmission";
import {
  normalizeTurnInputContextSignals,
  type TurnInputContextSignals,
} from "../lib/turnIntake";

export interface CreateSubmitRuntimeContextInput {
  turnId: string;
  uiDisplayTurnId: string;
  runWorkspace: string | undefined;
  runSessionKey: string;
  runSessionId: number | null | undefined;
  runScopeKey: string;
  phaseLanguage: "zh" | "en";
  effectiveRunIntent: ResolvedRunIntent;
  runtimeRunIntent: ResolvedRunIntent;
  goalCreationAuthorization: GoalCreationAuthorization | null;
  goalContinuationAuthorization: GoalContinuationAuthorization | null;
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
  planExecution: PlanExecutionRunProvenance | null;
  /** First-admission payload facts; contains no image bytes. */
  turnInputContextSignals: TurnInputContextSignals;
  turnAgentMessagesStart: number;
  getElapsedSeconds: () => number;
  PLAN_EXECUTION_PROGRESS_DEFAULT_MAX_ITERATIONS: number;
  PROVIDER_COMPATIBILITY_FORCE_XML_TTL_MS: number;
  PROVIDER_COMPATIBILITY_NATIVE_RECOVERY_SUCCESS_STREAK: number;
}

export function createSubmitRuntimeContext(
  input: CreateSubmitRuntimeContextInput,
): SubmissionRuntimeContext {
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
    goalCreationAuthorization: input.goalCreationAuthorization,
    goalContinuationAuthorization: input.goalContinuationAuthorization,
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
    planExecution: input.planExecution
      ? Object.freeze({ ...input.planExecution })
      : null,
    turnInputContextSignals: normalizeTurnInputContextSignals(
      input.turnInputContextSignals,
    ),
    streamBuffer: null,
    thinkingInterceptor: null,
    turnAgentMessagesStart: input.turnAgentMessagesStart,
    getElapsedSeconds: input.getElapsedSeconds,
    agentBlockIdsCreatedThisRun: new Set<number>(),
    firstStreamTokenAt: null,
    streamTokenCount: 0,
    streamTextChars: 0,
    iterationStreamTokenCount: 0,
    iterationStreamTextChars: 0,
    runStreamTokenCount: 0,
    runStreamTextChars: 0,
    noFirstTokenNoticeTimer: null,
    currentStreamingBlockId: null,
    currentThoughtBlockId: null,
    thoughtStartTime: null,
    streamingAssistantDisplayBuffer: "",
    executionEvidenceDraftHeld: false,
    executionEvidenceDraftBuffer: "",
    understandingProgressBlockId: null,
    understandingProgressClosed: false,
    PLAN_EXECUTION_PROGRESS_DEFAULT_MAX_ITERATIONS: input.PLAN_EXECUTION_PROGRESS_DEFAULT_MAX_ITERATIONS,
    PROVIDER_COMPATIBILITY_FORCE_XML_TTL_MS: input.PROVIDER_COMPATIBILITY_FORCE_XML_TTL_MS,
    PROVIDER_COMPATIBILITY_NATIVE_RECOVERY_SUCCESS_STREAK: input.PROVIDER_COMPATIBILITY_NATIVE_RECOVERY_SUCCESS_STREAK,
  };
}
