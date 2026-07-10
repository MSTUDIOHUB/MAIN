import { isCloudGatewayTimeoutMessage, isRetryableCloudErrorMessage } from "../../cloudRetry";
import { clampContextLimitToReported, resolveReactiveContextLimit } from "../../contextWindow";
import { estimateMessagesTokens, manageContext } from "../../contextTrim";
import { getErrorMessage } from "../../errorUtils";
import { buildPlanStreamTimeoutPauseMessage } from "../../orchestrator/planOrchestration";
import {
  buildCompatibilityRetryMessages,
  buildTranscriptCompatibilityRetryMessages,
  ensureProviderCompatibilityMode,
  isProviderCompatibilityErrorMessage,
} from "../../providerCompatibility";
import type { PlanToolActivitySummary } from "../../planExecutionRecovery";
import type { ResolvedUserIntent } from "../../runIntent";
import type { StreamResult } from "../../streaming";
import type { ToolDefinition } from "../../toolSchemas";
import type { PlanExecutionProgressPhase, PlanExecutionProgressUpdate } from "../../workflowModels";
import {
  computeManagedContextLimit,
  fetchLLMStream,
  isStreamWatchdogTimeoutMessage,
  logAgentEvent,
  prepareMessagesForToolProtocol,
  shouldTreatCloudGatewayErrorAsCompatibility,
} from "../../orchestrator";
import type { AgentMessage, OrchestratorCallbacks } from "../types";
import type { AgentLoopRuntimeState } from "./turnPreparation";
import { invokeInitialStreamForIteration, type PlanStreamWatchdogOptionsResolver } from "./streamInvocation";
import type { ExecuteRecoveryMode } from "../../executeRecoveryTools";

export type StreamWithRecoveryResult =
  | {
      status: "streamed";
      streamResult: StreamResult;
      snapshotContextLimit: number | undefined;
    }
  | {
      status: "stopped";
      snapshotContextLimit: number | undefined;
    };

function isAbortError(error: unknown): boolean {
  return (error as Error)?.name === "AbortError";
}

function handlePlanDraftStreamTimeout(input: {
  callbacks: OrchestratorCallbacks;
  runtimeState: AgentLoopRuntimeState;
  iteration: number;
  reason: string;
  message: string;
}): boolean {
  const {
    callbacks,
    runtimeState,
    iteration,
    reason,
    message,
  } = input;
  if (
    runtimeState.workflowMode !== "plan" ||
    callbacks.getIsPlanApproved() ||
    !isStreamWatchdogTimeoutMessage(message)
  ) {
    return false;
  }

  const planStage = callbacks.getPlanStage();
  logAgentEvent("plan_stage_waiting_for_design", {
    iteration,
    planStage,
    reason,
    message: message.slice(0, 240),
  });
  callbacks.onNonActionableStop(
    buildPlanStreamTimeoutPauseMessage(callbacks.getPreferredLanguage(), planStage),
    "incomplete_plan",
  );
  callbacks.onStatusChange("idle");
  return true;
}

function emitReactiveContextCompression(input: {
  callbacks: OrchestratorCallbacks;
  iteration: number;
  reason: string;
  managedResult: ReturnType<typeof manageContext>;
  emitPlanExecutionProgress: (
    phase: PlanExecutionProgressPhase,
    update?: Partial<PlanExecutionProgressUpdate>,
  ) => void;
}) {
  const {
    callbacks,
    iteration,
    reason,
    managedResult,
    emitPlanExecutionProgress,
  } = input;
  if (!managedResult.changed || managedResult.tokenReduction <= 0) {
    return;
  }

  try {
    callbacks.onContextCompress({
      droppedCount: managedResult.droppedCount,
      droppedMessageCount: managedResult.droppedMessageCount,
      tokenCountBefore: managedResult.tokenCountBefore,
      tokenCountAfter: managedResult.tokenCountAfter,
      tokenReduction: managedResult.tokenReduction,
      compressedContext: managedResult.compressedContext,
      displaySummary: managedResult.displaySummary,
      memoryPacket: managedResult.memoryPacket,
      microCompactionKind: managedResult.microCompactionKind,
      microCompactedCount: managedResult.microCompactedCount,
      tokenBreakdown: managedResult.tokenBreakdownBefore,
    }, "reactive");
    emitPlanExecutionProgress("context_compression");
  } catch (compressErr) {
    logAgentEvent("on_context_compress_error", {
      iteration,
      error: (compressErr as Error).message || String(compressErr),
      reason,
    });
  }
}

function replaceMessagesForRetry(input: {
  callbacks: OrchestratorCallbacks;
  iteration: number;
  messages: AgentMessage[];
  reason: string;
  onlyWhenChanged?: boolean;
  changed?: boolean;
}) {
  const {
    callbacks,
    iteration,
    messages,
    reason,
    onlyWhenChanged = false,
    changed = true,
  } = input;
  if (onlyWhenChanged && !changed) {
    return;
  }
  try {
    callbacks.replaceMessages(messages);
  } catch (replaceErr) {
    logAgentEvent("replace_messages_error", {
      iteration,
      error: (replaceErr as Error).message || String(replaceErr),
      messagesLength: messages.length,
      reason,
    });
  }
}

export async function invokeStreamWithRecoveryForIteration(input: {
  callbacks: OrchestratorCallbacks;
  abortSignal: AbortSignal;
  runtimeState: AgentLoopRuntimeState;
  assistantMsgId: string;
  iteration: number;
  effectiveMaxIterations: number;
  runtimeIntent: ResolvedUserIntent;
  managedAgentMessages: AgentMessage[];
  iterationAllTools: ToolDefinition[];
  llmTools: ToolDefinition[];
  currentMaxTokens: number | undefined;
  maxOutputEscalations: number;
  forceXmlTools: boolean;
  providerCompatibilityOverride: boolean | undefined;
  snapshotContextLimit: number | undefined;
  executeRecoveryMode: ExecuteRecoveryMode;
  executeRecoveryReason: string | null;
  allowExecuteRecoveryFileRead: boolean;
  isExecuteRecoveryEligible: boolean;
  approvedPlanActionOnlyRecoveryActive: boolean;
  approvedPlanNoToolRecoveryFileReadActive: boolean;
  finalTextOnlyStep: boolean;
  chatFinalSynthesisActive: boolean;
  chatFinalSynthesisReason: string;
  usedChatFinalSynthesisPrompt: boolean;
  markChatFinalSynthesisPromptUsed: () => void;
  recentToolActivity: PlanToolActivitySummary[];
  consecutiveNoToolCount: number;
  getPlanStreamWatchdogOptions: PlanStreamWatchdogOptionsResolver;
  approvedPlanRecoveryStreamMaxElapsedMs: number;
  pauseApprovedPlanStreamWatchdog: (message: string, logContext?: Record<string, unknown>) => boolean;
  emitPlanExecutionProgress: (
    phase: PlanExecutionProgressPhase,
    update?: Partial<PlanExecutionProgressUpdate>,
  ) => void;
}): Promise<StreamWithRecoveryResult> {
  const {
    callbacks,
    abortSignal,
    runtimeState,
    assistantMsgId,
    iteration,
    effectiveMaxIterations,
    runtimeIntent,
    managedAgentMessages,
    iterationAllTools,
    llmTools,
    currentMaxTokens,
    maxOutputEscalations,
    forceXmlTools,
    providerCompatibilityOverride,
    executeRecoveryMode,
    executeRecoveryReason,
    allowExecuteRecoveryFileRead,
    isExecuteRecoveryEligible,
    approvedPlanActionOnlyRecoveryActive,
    approvedPlanNoToolRecoveryFileReadActive,
    finalTextOnlyStep,
    chatFinalSynthesisActive,
    chatFinalSynthesisReason,
    usedChatFinalSynthesisPrompt,
    markChatFinalSynthesisPromptUsed,
    recentToolActivity,
    consecutiveNoToolCount,
    getPlanStreamWatchdogOptions,
    approvedPlanRecoveryStreamMaxElapsedMs,
    pauseApprovedPlanStreamWatchdog,
    emitPlanExecutionProgress,
  } = input;
  const {
    config,
    isCloudProfile,
    settings,
    workflowMode,
  } = runtimeState;
  let snapshotContextLimit = input.snapshotContextLimit;

  try {
    const initialStreamInvocation = await invokeInitialStreamForIteration({
      callbacks,
      abortSignal,
      runtimeState,
      assistantMsgId,
      iteration,
      effectiveMaxIterations,
      runtimeIntent,
      managedAgentMessages,
      iterationAllTools,
      llmTools,
      currentMaxTokens,
      maxOutputEscalations,
      forceXmlTools,
      providerCompatibilityOverride,
      snapshotContextLimit,
      executeRecoveryMode,
      executeRecoveryReason,
      allowExecuteRecoveryFileRead,
      isExecuteRecoveryEligible,
      approvedPlanActionOnlyRecoveryActive,
      approvedPlanNoToolRecoveryFileReadActive,
      finalTextOnlyStep,
      chatFinalSynthesisActive,
      chatFinalSynthesisReason,
      usedChatFinalSynthesisPrompt,
      markChatFinalSynthesisPromptUsed,
      recentToolActivity,
      consecutiveNoToolCount,
      getPlanStreamWatchdogOptions,
      approvedPlanRecoveryStreamMaxElapsedMs,
    });
    if (initialStreamInvocation.status === "stopped") {
      return { status: "stopped", snapshotContextLimit };
    }
    return {
      status: "streamed",
      streamResult: initialStreamInvocation.streamResult,
      snapshotContextLimit,
    };
  } catch (err) {
    if (isAbortError(err)) {
      callbacks.onStatusChange("idle");
      return { status: "stopped", snapshotContextLimit };
    }

    const errMsg = (err as Error).message || "";
    if (pauseApprovedPlanStreamWatchdog(errMsg, { stage: "initial_stream" })) {
      return { status: "stopped", snapshotContextLimit };
    }
    if (
      handlePlanDraftStreamTimeout({
        callbacks,
        runtimeState,
        iteration,
        reason: "stream_first_chunk_timeout",
        message: errMsg,
      })
    ) {
      return { status: "stopped", snapshotContextLimit };
    }

    const nativeToolsWereAttempted = llmTools.length > 0;
    const isContextError =
      (err as Error & { isContextError?: boolean }).isContextError === true ||
      errMsg.includes("CONTEXT_LENGTH_EXCEEDED") ||
      errMsg.includes("context_length_exceeded") ||
      errMsg.includes("context window") ||
      errMsg.includes("maximum context length") ||
      errMsg.includes("token limit") ||
      errMsg.includes("prefill memory guard") ||
      errMsg.includes("context too large");
    const isCompatibilityError =
      isProviderCompatibilityErrorMessage(errMsg) ||
      shouldTreatCloudGatewayErrorAsCompatibility(
        errMsg,
        isCloudProfile,
        managedAgentMessages,
        nativeToolsWereAttempted,
      );

    if (isContextError && snapshotContextLimit != null) {
      logAgentEvent("context_retry_start", {
        iteration,
        reason: "local_context_length_exceeded",
        snapshotContextLimit,
        error: errMsg.slice(0, 240),
      });

      const configuredContextLimit = snapshotContextLimit;
      const { contextLimit: reactiveContextLimit, reportedContextLimit } =
        clampContextLimitToReported(configuredContextLimit, errMsg);
      if (reportedContextLimit != null && reactiveContextLimit < configuredContextLimit) {
        logAgentEvent("context_limit_clamped", {
          iteration,
          reportedContextLimit,
          configuredContextLimit,
          reactiveContextLimit,
        });
      }
      snapshotContextLimit = reactiveContextLimit;

      const aggressiveOutputBudget = Math.min(3072, Math.max(1536, Math.floor(reactiveContextLimit * 0.08)));
      const aggressiveContextLimit = computeManagedContextLimit(
        reactiveContextLimit,
        llmTools,
        aggressiveOutputBudget,
      );
      const aggressivelyManagedResult = manageContext(
        callbacks.getMessages(),
        aggressiveContextLimit,
        aggressiveOutputBudget,
        800,
        480,
        true,
        {
          previousMemoryState: callbacks.getContextMemoryState?.() || null,
        },
      );
      callbacks.onContextMemoryBuilt?.(aggressivelyManagedResult.memoryState, aggressivelyManagedResult.memoryPacket);
      const aggressivelyManaged = aggressivelyManagedResult.messages as AgentMessage[];
      replaceMessagesForRetry({
        callbacks,
        iteration,
        messages: aggressivelyManaged,
        reason: "reactive_context_trim",
      });
      emitReactiveContextCompression({
        callbacks,
        iteration,
        reason: "reactive_context_trim",
        managedResult: aggressivelyManagedResult,
        emitPlanExecutionProgress,
      });

      try {
        const aggressivelyManagedForLLM = prepareMessagesForToolProtocol(
          aggressivelyManaged,
          config,
          settings,
          providerCompatibilityOverride,
        );
        const streamResult = await fetchLLMStream(
          aggressivelyManagedForLLM,
          settings,
          assistantMsgId,
          callbacks,
          abortSignal,
          llmTools,
          aggressiveOutputBudget,
          1,
          {
            ...getPlanStreamWatchdogOptions(llmTools.length),
            workflowMode,
            runtimeIntent,
          },
        );
        if (llmTools.length > 0) {
          callbacks.onProviderNativeToolSuccess?.();
        }
        return { status: "streamed", streamResult, snapshotContextLimit };
      } catch (retryErr) {
        if (isAbortError(retryErr)) {
          callbacks.onStatusChange("idle");
          return { status: "stopped", snapshotContextLimit };
        }
        const retryErrMsg = (retryErr as Error).message || "";
        if (pauseApprovedPlanStreamWatchdog(retryErrMsg, { stage: "context_compaction_retry" })) {
          return { status: "stopped", snapshotContextLimit };
        }
        if (
          handlePlanDraftStreamTimeout({
            callbacks,
            runtimeState,
            iteration,
            reason: "stream_first_chunk_timeout_after_compaction",
            message: retryErrMsg,
          })
        ) {
          return { status: "stopped", snapshotContextLimit };
        }

        logAgentEvent("context_retry_start", {
          iteration,
          reason: "strip_tool_calls_for_emergency_retry",
        });
        const strippedMessages = buildCompatibilityRetryMessages(aggressivelyManaged);
        const emergencyOutputBudget = Math.min(2048, Math.max(1024, Math.floor(reactiveContextLimit * 0.06)));
        const emergencyContextLimit = computeManagedContextLimit(reactiveContextLimit, llmTools, emergencyOutputBudget);
        const emergencyManagedResult = manageContext(
          strippedMessages,
          emergencyContextLimit,
          emergencyOutputBudget,
          320,
          220,
          true,
          {
            previousMemoryState: callbacks.getContextMemoryState?.() || null,
          },
        );
        callbacks.onContextMemoryBuilt?.(emergencyManagedResult.memoryState, emergencyManagedResult.memoryPacket);
        const emergencyManaged = emergencyManagedResult.messages as AgentMessage[];

        if (emergencyManagedResult.changed && emergencyManagedResult.tokenReduction > 0) {
          replaceMessagesForRetry({
            callbacks,
            iteration,
            messages: emergencyManaged,
            reason: "emergency_context_trim",
          });
          emitReactiveContextCompression({
            callbacks,
            iteration,
            reason: "emergency_context_trim",
            managedResult: emergencyManagedResult,
            emitPlanExecutionProgress,
          });
        }

        try {
          const emergencyManagedForLLM = prepareMessagesForToolProtocol(
            emergencyManaged,
            config,
            settings,
            providerCompatibilityOverride,
          );
          const streamResult = await fetchLLMStream(
            emergencyManagedForLLM,
            settings,
            assistantMsgId,
            callbacks,
            abortSignal,
            llmTools,
            emergencyOutputBudget,
            0,
            {
              ...getPlanStreamWatchdogOptions(llmTools.length),
              workflowMode,
              runtimeIntent,
            },
          );
          if (llmTools.length > 0) {
            callbacks.onProviderNativeToolSuccess?.();
          }
          return { status: "streamed", streamResult, snapshotContextLimit };
        } catch (finalErr) {
          if (isAbortError(finalErr)) {
            callbacks.onStatusChange("idle");
            return { status: "stopped", snapshotContextLimit };
          }
          const finalErrMsg = (finalErr as Error).message || "";
          if (pauseApprovedPlanStreamWatchdog(finalErrMsg, { stage: "emergency_compaction_retry" })) {
            return { status: "stopped", snapshotContextLimit };
          }
          if (
            handlePlanDraftStreamTimeout({
              callbacks,
              runtimeState,
              iteration,
              reason: "stream_first_chunk_timeout_after_emergency_compaction",
              message: finalErrMsg,
            })
          ) {
            return { status: "stopped", snapshotContextLimit };
          }
          callbacks.onError(callbacks.getPreferredLanguage() === "zh"
            ? "上下文在压缩后仍超过模型限制。请新建会话，或缩短当前历史后重试。"
            : "Context remained over the model limit after compaction. Start a new conversation or shorten the current history.");
          callbacks.onStatusChange("error");
          return { status: "stopped", snapshotContextLimit };
        }
      }
    }

    if (isContextError) {
      logAgentEvent("context_retry_start", {
        iteration,
        reason: "cloud_context_length_exceeded",
        error: errMsg.slice(0, 240),
      });
      const estimatedCurrentTokens = estimateMessagesTokens(
        callbacks.getMessages() as Parameters<typeof estimateMessagesTokens>[0],
      );
      const cloudContextDecision = resolveReactiveContextLimit(
        estimatedCurrentTokens,
        errMsg,
      );
      const cloudReactiveContextLimit = cloudContextDecision.contextLimit;
      snapshotContextLimit = cloudReactiveContextLimit;
      logAgentEvent("cloud_context_limit_resolved", {
        iteration,
        source: cloudContextDecision.source,
        reportedContextLimit: cloudContextDecision.reportedContextLimit,
        estimatedCurrentTokens,
        reactiveContextLimit: cloudReactiveContextLimit,
      });
      const cloudReactiveOutputBudget = Math.min(
        2048,
        Math.max(1024, Math.floor(cloudReactiveContextLimit * 0.06)),
      );
      const cloudReactiveManagedLimit = computeManagedContextLimit(
        cloudReactiveContextLimit,
        llmTools,
        cloudReactiveOutputBudget,
      );
      const cloudManagedResult = manageContext(
        callbacks.getMessages(),
        cloudReactiveManagedLimit,
        cloudReactiveOutputBudget,
        700,
        500,
        true,
        {
          previousMemoryState: callbacks.getContextMemoryState?.() || null,
        },
      );
      callbacks.onContextMemoryBuilt?.(cloudManagedResult.memoryState, cloudManagedResult.memoryPacket);
      const cloudManagedMessages = cloudManagedResult.messages as AgentMessage[];
      replaceMessagesForRetry({
        callbacks,
        iteration,
        messages: cloudManagedMessages,
        reason: "cloud_context_retry",
        onlyWhenChanged: true,
        changed: cloudManagedResult.changed,
      });
      emitReactiveContextCompression({
        callbacks,
        iteration,
        reason: "cloud_context_retry",
        managedResult: cloudManagedResult,
        emitPlanExecutionProgress,
      });

      try {
        const cloudManagedForLLM = prepareMessagesForToolProtocol(
          cloudManagedMessages,
          config,
          settings,
          providerCompatibilityOverride,
        );
        const streamResult = await fetchLLMStream(
          cloudManagedForLLM,
          settings,
          assistantMsgId,
          callbacks,
          abortSignal,
          llmTools,
          cloudReactiveOutputBudget,
          1,
          {
            ...getPlanStreamWatchdogOptions(llmTools.length),
            workflowMode,
            runtimeIntent,
          },
        );
        if (llmTools.length > 0) {
          callbacks.onProviderNativeToolSuccess?.();
        }
        return { status: "streamed", streamResult, snapshotContextLimit };
      } catch (cloudRetryErr) {
        if (isAbortError(cloudRetryErr)) {
          callbacks.onStatusChange("idle");
          return { status: "stopped", snapshotContextLimit };
        }
        const cloudRetryErrMsg = (cloudRetryErr as Error).message || "";
        if (pauseApprovedPlanStreamWatchdog(cloudRetryErrMsg, { stage: "cloud_compaction_retry" })) {
          return { status: "stopped", snapshotContextLimit };
        }
        if (
          handlePlanDraftStreamTimeout({
            callbacks,
            runtimeState,
            iteration,
            reason: "stream_first_chunk_timeout_after_cloud_compaction",
            message: cloudRetryErrMsg,
          })
        ) {
          return { status: "stopped", snapshotContextLimit };
        }
        callbacks.onError(callbacks.getPreferredLanguage() === "zh"
          ? "远程模型上下文在本地压缩重试后仍然超限。请新建会话，或缩短当前历史。"
          : "The remote model context remained over its limit after local compaction retry. Start a new conversation or shorten the current history.");
        callbacks.onStatusChange("error");
        return { status: "stopped", snapshotContextLimit };
      }
    }

    if (isCompatibilityError) {
      logAgentEvent("provider_compatibility_retry", {
        iteration,
        reason: errMsg.slice(0, 240),
        nativeToolsAttempted: nativeToolsWereAttempted,
      });
      callbacks.onProviderCompatibilityFallback?.(errMsg);
      const compatibilityMessages = ensureProviderCompatibilityMode(
        buildCompatibilityRetryMessages(managedAgentMessages),
        workflowMode,
      );
      replaceMessagesForRetry({
        callbacks,
        iteration,
        messages: compatibilityMessages,
        reason: "compatibility_fallback",
      });
      logAgentEvent("native_tool_fallback", {
        iteration,
        nativeToolsAttempted: nativeToolsWereAttempted,
        allTools: iterationAllTools.length,
        llmToolsBeforeFallback: llmTools.length,
        llmToolsAfterFallback: 0,
        xmlToolsEnabled: true,
        reason: errMsg.slice(0, 240),
      });

      try {
        const streamResult = await fetchLLMStream(
          compatibilityMessages,
          settings,
          assistantMsgId,
          callbacks,
          abortSignal,
          [],
          currentMaxTokens,
          maxOutputEscalations,
          {
            ...getPlanStreamWatchdogOptions(0),
            workflowMode,
            runtimeIntent,
          },
        );
        return { status: "streamed", streamResult, snapshotContextLimit };
      } catch (retryErr) {
        if (isAbortError(retryErr)) {
          callbacks.onStatusChange("idle");
          return { status: "stopped", snapshotContextLimit };
        }

        const retryMsg = (retryErr as Error).message || "";
        if (pauseApprovedPlanStreamWatchdog(retryMsg, { stage: "provider_compatibility_retry" })) {
          return { status: "stopped", snapshotContextLimit };
        }
        if (
          handlePlanDraftStreamTimeout({
            callbacks,
            runtimeState,
            iteration,
            reason: "stream_first_chunk_timeout_after_compatibility_retry",
            message: retryMsg,
          })
        ) {
          return { status: "stopped", snapshotContextLimit };
        }
        const retryLooksLikeCompatibility =
          isProviderCompatibilityErrorMessage(retryMsg) ||
          (isCloudProfile && !isCloudGatewayTimeoutMessage(retryMsg) && isRetryableCloudErrorMessage(retryMsg));

        if (!retryLooksLikeCompatibility) {
          callbacks.onError(getErrorMessage(retryErr, retryMsg || "LLM stream failed"));
          callbacks.onStatusChange("error");
          return { status: "stopped", snapshotContextLimit };
        }

        const providerCompatibilityMessages = ensureProviderCompatibilityMode(
          compatibilityMessages,
          workflowMode,
        );
        replaceMessagesForRetry({
          callbacks,
          iteration,
          messages: providerCompatibilityMessages,
          reason: "provider_compatibility_retry",
        });
        try {
          const streamResult = await fetchLLMStream(
            providerCompatibilityMessages,
            settings,
            assistantMsgId,
            callbacks,
            abortSignal,
            [],
            currentMaxTokens,
            maxOutputEscalations,
            {
              ...getPlanStreamWatchdogOptions(0),
              workflowMode,
              runtimeIntent,
            },
          );
          return { status: "streamed", streamResult, snapshotContextLimit };
        } catch (finalErr) {
          if (isAbortError(finalErr)) {
            callbacks.onStatusChange("idle");
            return { status: "stopped", snapshotContextLimit };
          }
          const finalErrMsg = (finalErr as Error).message || "";
          if (pauseApprovedPlanStreamWatchdog(finalErrMsg, { stage: "provider_compatibility_final_retry" })) {
            return { status: "stopped", snapshotContextLimit };
          }
          if (
            handlePlanDraftStreamTimeout({
              callbacks,
              runtimeState,
              iteration,
              reason: "stream_first_chunk_timeout_after_provider_compatibility_retry",
              message: finalErrMsg,
            })
          ) {
            return { status: "stopped", snapshotContextLimit };
          }
          const transcriptMessages = buildTranscriptCompatibilityRetryMessages(
            managedAgentMessages,
            workflowMode,
          );
          replaceMessagesForRetry({
            callbacks,
            iteration,
            messages: transcriptMessages,
            reason: "transcript_retry",
          });
          try {
            const streamResult = await fetchLLMStream(
              transcriptMessages,
              settings,
              assistantMsgId,
              callbacks,
              abortSignal,
              [],
              currentMaxTokens,
              maxOutputEscalations,
              {
                ...getPlanStreamWatchdogOptions(0),
                workflowMode,
                runtimeIntent,
              },
            );
            return { status: "streamed", streamResult, snapshotContextLimit };
          } catch (lastErr) {
            if (isAbortError(lastErr)) {
              callbacks.onStatusChange("idle");
              return { status: "stopped", snapshotContextLimit };
            }
            const language = callbacks.getPreferredLanguage();
            const lastErrorMessage = getErrorMessage(
              lastErr,
              language === "zh" ? "未知错误" : "Unknown error",
            );
            if (pauseApprovedPlanStreamWatchdog(lastErrorMessage, { stage: "provider_compatibility_transcript_retry" })) {
              return { status: "stopped", snapshotContextLimit };
            }
            if (
              handlePlanDraftStreamTimeout({
                callbacks,
                runtimeState,
                iteration,
                reason: "stream_first_chunk_timeout_after_transcript_retry",
                message: lastErrorMessage,
              })
            ) {
              return { status: "stopped", snapshotContextLimit };
            }
            callbacks.onError(language === "zh"
              ? "当前云端服务对会话内容格式兼容性较弱。MAIN 已尝试精简历史、关闭原生 tools，并回退到单条纯文本 transcript，但服务端仍然拒绝。请新建纯文本会话后重试，或更换兼容性更好的 OpenAI 协议网关。\n\n上游返回：" + lastErrorMessage
              : "The cloud service rejected the conversation format after MAIN compacted history, disabled native tools, and retried with a single plain-text transcript. Start a plain-text conversation or use a more compatible OpenAI-protocol gateway.\n\nUpstream response: " + lastErrorMessage);
            callbacks.onStatusChange("error");
            return { status: "stopped", snapshotContextLimit };
          }
        }
      }
    }

    callbacks.onError(getErrorMessage(
      err,
      callbacks.getPreferredLanguage() === "zh" ? "模型流式请求失败" : "LLM stream failed",
    ));
    callbacks.onStatusChange("error");
    return { status: "stopped", snapshotContextLimit };
  }
}
