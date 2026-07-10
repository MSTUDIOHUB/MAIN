import type { AppConfig } from "./appTypes";
import type { AgentLoopOutcome, AgentMessage, OrchestratorCallbacks } from "./orchestrator/types";
import {
  registerSubagentAbortController,
  reportSubagentCapacityFailure,
  resolveSubagentCapacityPolicy,
  unregisterSubagentAbortController,
  withSubagentCapacity,
  type SpawnSubagentRequest,
  type SpawnSubagentResult,
  type SubagentActivity,
  type SubagentProgress,
  type SubagentRunPatch,
  type SubagentRunSnapshot,
  type SubagentStatus,
} from "./subagents";
import { withEventSchema, type MainThreadEvent } from "./turnEvents";
import { generateId } from "./utils";

const SUBAGENT_NAMES = ["Euler", "Mendel", "Herschel", "Noether", "Turing", "Curie"];

type ExecuteAgentLoop = (
  callbacks: OrchestratorCallbacks,
  abortController: AbortController,
) => Promise<AgentLoopOutcome>;

function sanitizeName(value: unknown, fallbackIndex: number): string {
  const normalized = String(value || "")
    .replace(/[^A-Za-z0-9 _-]+/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 32);
  return normalized || SUBAGENT_NAMES[fallbackIndex % SUBAGENT_NAMES.length];
}

function compactText(value: unknown, maxChars: number): string {
  const text = String(value || "").trim();
  return text.length > maxChars ? `${text.slice(0, maxChars).trimEnd()}...` : text;
}

function buildChildPrompt(request: SpawnSubagentRequest, language: "zh" | "en"): string {
  const hints = compactText(request.contextHints, 4_000);
  const allowedPaths = compactText(request.allowedPaths, 2_000);
  if (language === "en") {
    return [
      "You are a bounded read-only subagent working for a parent task.",
      `Role: ${request.role || "explorer"}`,
      `Objective: ${request.objective}`,
      hints ? `Context hints: ${hints}` : "",
      allowedPaths ? `Preferred paths: ${allowedPaths}` : "",
      "Use only the read/search tools exposed to you. Do not modify files, run shell commands, request approval, or spawn another agent.",
      "Return a concise evidence-based summary with relevant file paths, findings, and any uncertainty. Do not address the end user directly.",
    ].filter(Boolean).join("\n\n");
  }
  return [
    "你是主任务派生出的有界只读子智能体。",
    `角色：${request.role || "explorer"}`,
    `目标：${request.objective}`,
    hints ? `上下文提示：${hints}` : "",
    allowedPaths ? `优先路径：${allowedPaths}` : "",
    "只使用当前暴露的读取与搜索工具。不得修改文件、运行 Shell 命令、请求用户批准或继续创建子智能体。",
    "返回简洁、基于证据的摘要，包含相关文件路径、结论与不确定项；不要直接面向最终用户说话。",
  ].filter(Boolean).join("\n\n");
}

function resolveChildConfig(config: AppConfig, maxIterations: number): AppConfig {
  const currentAgentLoop = (config as AppConfig & { agentLoop?: Record<string, unknown> }).agentLoop || {};
  const currentLimits = (currentAgentLoop.iterationLimits as Record<string, unknown> | undefined) || {};
  return {
    ...config,
    local: { ...config.local },
    cloud: { ...config.cloud },
    cloudServers: config.cloudServers.map((server) => ({ ...server })),
    agentLoop: {
      ...currentAgentLoop,
      iterationLimits: {
        ...currentLimits,
        chatRespond: maxIterations,
      },
    },
  } as AppConfig;
}

function resolveOutcomeStatus(outcome: AgentLoopOutcome, aborted: boolean): SubagentStatus {
  if (aborted || outcome.status === "aborted") return "canceled";
  if (outcome.status === "completed") return "completed";
  if (outcome.status === "paused") return "blocked";
  return "failed";
}

export async function executeControlledSubagent(input: {
  request: SpawnSubagentRequest;
  parentCallbacks: OrchestratorCallbacks;
  parentTurnId: string;
  parentSignal?: AbortSignal;
  existingRunCount: number;
  emitEvent: (event: MainThreadEvent) => void;
  executeAgentLoop: ExecuteAgentLoop;
}): Promise<SpawnSubagentResult> {
  const parentConfig = input.parentCallbacks.getConfig();
  const language = input.parentCallbacks.getPreferredLanguage();
  const policy = resolveSubagentCapacityPolicy(parentConfig);
  if (input.existingRunCount >= policy.maxCreatedPerTurn) {
    throw new Error(
      language === "zh"
        ? `本轮最多创建 ${policy.maxCreatedPerTurn} 个子智能体。`
        : `This turn can create at most ${policy.maxCreatedPerTurn} subagents.`,
    );
  }

  const subagentId = `subagent-${generateId()}`;
  const name = sanitizeName(input.request.name, input.existingRunCount);
  const role = compactText(input.request.role || "explorer", 48) || "explorer";
  const objective = compactText(input.request.objective, 4_000);
  if (!objective) throw new Error("Subagent objective is required.");

  const now = Date.now();
  const snapshot: SubagentRunSnapshot = {
    id: subagentId,
    parentTurnId: input.parentTurnId,
    threadId: input.parentCallbacks.getSessionKey(),
    name,
    role,
    objective,
    status: "queued",
    profile: policy.profile,
    provider: policy.provider,
    model: policy.model,
    createdAt: now,
    updatedAt: now,
    progress: {
      phase: "queued",
      title: language === "zh" ? "等待可用模型通道" : "Waiting for an available model lane",
      completedToolCalls: 0,
    },
  };
  input.emitEvent(withEventSchema({
    type: "subagent.created",
    threadId: snapshot.threadId,
    turnId: input.parentTurnId,
    timestampMs: now,
    subagent: snapshot,
  }));

  const childAbortController = new AbortController();
  registerSubagentAbortController(subagentId, childAbortController);
  const abortFromParent = () => childAbortController.abort();
  if (input.parentSignal?.aborted) {
    childAbortController.abort();
  } else {
    input.parentSignal?.addEventListener("abort", abortFromParent, { once: true });
  }

  let childMessages: AgentMessage[] = [{
    role: "user",
    content: buildChildPrompt(input.request, language),
  }];
  let childStatus: "idle" | "running" | "pending_review" | "error" = "idle";
  let streamText = "";
  let finalText = "";
  let turnSummary = "";
  let lastError = "";
  let completedToolCalls = 0;
  let activitySequence = 0;
  let lastProgressEmitAt = 0;

  const emitUpdate = (patch: SubagentRunPatch, activity?: SubagentActivity) => {
    input.emitEvent(withEventSchema({
      type: "subagent.updated",
      threadId: snapshot.threadId,
      turnId: input.parentTurnId,
      timestampMs: Date.now(),
      subagentId,
      patch: { updatedAt: Date.now(), ...patch },
      ...(activity ? { activity } : {}),
    }));
  };
  const emitProgress = (progress: SubagentProgress) => {
    const current = Date.now();
    if (current - lastProgressEmitAt < 500 && progress.phase === "thinking") return;
    lastProgressEmitAt = current;
    emitUpdate({ status: "running", progress });
  };
  const makeActivity = (
    status: SubagentActivity["status"],
    title: string,
    tool?: string,
    target?: string,
    detail?: string,
  ): SubagentActivity => ({
    id: `${subagentId}-activity-${++activitySequence}`,
    timestampMs: Date.now(),
    status,
    title,
    ...(tool ? { tool } : {}),
    ...(target ? { target } : {}),
    ...(detail ? { detail: compactText(detail, 1_000) } : {}),
  });

  const childCallbacks: OrchestratorCallbacks = {
    ...input.parentCallbacks,
    getMessages: () => childMessages,
    getConfig: () => resolveChildConfig(parentConfig, policy.childMaxIterations),
    getPendingSlashCommand: () => null,
    getSessionKey: () => `${snapshot.threadId}:${subagentId}`,
    getCurrentTurnId: () => subagentId,
    getCurrentRunIntent: () => "analyze",
    getRuntimeRunIntent: () => "analyze",
    getGoalTurnContract: () => null,
    getExecutionConsentGranted: () => false,
    getForcedExecuteRecoveryMode: () => null,
    getCommandDirective: () => null,
    getWorkflowMode: () => "chat",
    getIsPlanApproved: () => false,
    getPlanApprovalChoice: () => null,
    getReadOnlyAutoApproveForSession: () => true,
    getPlanStage: () => "idle",
    getPlanTasks: () => [],
    getPlanExecutionEvidenceLedger: () => [],
    getPlanAutoResumeCount: () => 0,
    getStatus: () => childStatus,
    consumeActiveGuidance: () => null,
    startNewTurn: () => {},
    getContextMemoryState: () => null,
    getSubagentDepth: () => 1,
    runSubagent: undefined,
    onGoalProgressUpdate: undefined,
    onGoalRuntimeUpdate: undefined,
    onGoalIterationStart: undefined,
    onGoalIterationEnd: undefined,
    onGoalCheckpointSaved: undefined,
    onGoalUserConfirmNeeded: undefined,
    onGoalOutcome: undefined,
    onStreamToken: (token) => {
      streamText += token;
      emitProgress({
        phase: "thinking",
        title: language === "zh" ? "正在分析并整理证据" : "Analyzing and organizing evidence",
        completedToolCalls,
      });
    },
    onStreamDone: (text) => {
      if (String(text || "").trim()) streamText = String(text);
    },
    onThought: () => {
      emitProgress({
        phase: "thinking",
        title: language === "zh" ? "正在推理下一步" : "Reasoning about the next step",
        completedToolCalls,
      });
    },
    onAssistantFinalText: (text) => {
      if (String(text || "").trim()) finalText = String(text).trim();
    },
    onStatusChange: (status) => {
      childStatus = status;
    },
    onError: (error) => {
      childStatus = "error";
      lastError = String(error || "");
    },
    onNonActionableStop: (message) => {
      lastError = String(message || "");
    },
    onPlanArtifactUpdated: () => {},
    onPlanStageChanged: () => {},
    onPlanTasksUpdated: () => {},
    onPlanExecutionProgress: undefined,
    onApprovedPlanHandoff: () => {},
    onPlanMaxIterationsCheckpoint: undefined,
    onExecuteMaxIterationsCheckpoint: undefined,
    onTurnSummaryReady: (summary) => {
      turnSummary = String(summary || "").trim();
    },
    onExecutionDigestUpdate: undefined,
    onTurnRuntimePhaseChanged: (phase) => {
      emitProgress({
        phase: phase.kind === "validation" ? "summarizing" : "thinking",
        title: phase.title,
        completedToolCalls,
      });
    },
    onTurnEvent: undefined,
    onHarnessRunUpdate: undefined,
    onInstructionsResolved: () => {},
    onHooksLoaded: () => {},
    onHookStart: () => {},
    onHookResult: () => {},
    onHookBlocked: () => {},
    appendMessage: (message) => {
      childMessages = [...childMessages, message];
    },
    replaceMessages: (messages) => {
      childMessages = [...messages];
    },
    onContextMemoryBuilt: undefined,
    onContextCompress: () => {},
    onToolExecuting: (tool, target) => {
      emitUpdate({
        status: "running",
        progress: {
          phase: "tool",
          title: language === "zh" ? `正在执行 ${tool}` : `Running ${tool}`,
          tool,
          target,
          completedToolCalls,
        },
      }, makeActivity("running", language === "zh" ? "开始工具调用" : "Tool call started", tool, target));
    },
    onToolDone: (tool, target, result) => {
      completedToolCalls += 1;
      emitUpdate({
        status: "running",
        progress: {
          phase: "tool",
          title: language === "zh" ? `已完成 ${tool}` : `Completed ${tool}`,
          tool,
          target,
          completedToolCalls,
        },
      }, makeActivity("completed", language === "zh" ? "工具调用完成" : "Tool call completed", tool, target, result));
    },
    onToolError: (tool, target, error) => {
      emitUpdate({
        status: "running",
        progress: {
          phase: "tool",
          title: language === "zh" ? `${tool} 执行失败` : `${tool} failed`,
          tool,
          target,
          completedToolCalls,
        },
      }, makeActivity("failed", language === "zh" ? "工具调用失败" : "Tool call failed", tool, target, error));
    },
    requestReview: async () => ({ action: "reject" }),
  };

  let finalStatus: SubagentStatus = "failed";
  let finalSummary = "";
  try {
    return await withSubagentCapacity({
      policy,
      signal: childAbortController.signal,
      onQueued: () => emitUpdate({
        status: "queued",
        progress: {
          phase: "queued",
          title: policy.profile === "local"
            ? language === "zh" ? "本地模型单通道排队中" : "Queued on the single local model lane"
            : language === "zh" ? "等待云端并发配额" : "Waiting for cloud concurrency capacity",
          completedToolCalls,
        },
      }),
      task: async () => {
        const startedAt = Date.now();
        emitUpdate({
          status: "starting",
          startedAt,
          progress: {
            phase: "starting",
            title: language === "zh" ? "子智能体已启动" : "Subagent started",
            completedToolCalls,
          },
        }, makeActivity("running", language === "zh" ? "开始执行" : "Execution started"));

        const outcome = await input.executeAgentLoop(childCallbacks, childAbortController);
        finalStatus = resolveOutcomeStatus(outcome, childAbortController.signal.aborted);
        finalSummary = compactText(
          finalText || turnSummary || streamText || childMessages
            .filter((message) => message.role === "assistant" && typeof message.content === "string")
            .map((message) => String(message.content))
            .filter(Boolean)
            .join("\n"),
          16_000,
        );
        if (!finalSummary) {
          finalSummary = finalStatus === "completed"
            ? language === "zh" ? "子智能体已完成，但没有返回可见摘要。" : "The subagent completed without a visible summary."
            : lastError || outcome.reason;
        }
        const completedAt = Date.now();
        if (finalStatus === "failed") {
          reportSubagentCapacityFailure(policy, lastError || outcome.reason);
        }
        emitUpdate({
          status: finalStatus,
          completedAt,
          summary: finalSummary,
          ...(finalStatus === "completed" ? {} : { error: lastError || outcome.reason }),
          progress: {
            phase: "done",
            title: finalStatus === "completed"
              ? language === "zh" ? "执行完成" : "Completed"
              : finalStatus === "canceled"
              ? language === "zh" ? "已取消" : "Canceled"
              : language === "zh" ? "执行未完成" : "Execution did not complete",
            completedToolCalls,
          },
        }, makeActivity(
          finalStatus === "completed" ? "completed" : finalStatus === "canceled" ? "canceled" : "failed",
          finalStatus === "completed"
            ? language === "zh" ? "返回摘要" : "Summary returned"
            : language === "zh" ? "执行结束" : "Execution ended",
        ));
        return {
          subagentId,
          name,
          status: finalStatus,
          summary: finalSummary,
          ...(finalStatus === "completed" ? {} : { error: lastError || outcome.reason }),
        };
      },
    });
  } catch (error) {
    finalStatus = childAbortController.signal.aborted ? "canceled" : "failed";
    finalSummary = compactText(finalText || turnSummary || streamText, 16_000);
    lastError = finalStatus === "canceled"
      ? language === "zh"
        ? "SUBAGENT_CANCELED_BY_USER：子智能体已停止；除非用户明确要求，否则不要重新创建相同任务。"
        : "SUBAGENT_CANCELED_BY_USER: the subagent was stopped; do not respawn the same task unless the user explicitly asks."
      : error instanceof Error ? error.message : String(error || "");
    reportSubagentCapacityFailure(policy, error);
    emitUpdate({
      status: finalStatus,
      completedAt: Date.now(),
      summary: finalSummary,
      error: lastError,
      progress: {
        phase: "done",
        title: finalStatus === "canceled"
          ? language === "zh" ? "已取消" : "Canceled"
          : language === "zh" ? "执行失败" : "Execution failed",
        completedToolCalls,
      },
    }, makeActivity(
      finalStatus === "canceled" ? "canceled" : "failed",
      finalStatus === "canceled"
        ? language === "zh" ? "用户已停止子智能体" : "Subagent stopped by the user"
        : language === "zh" ? "子智能体执行失败" : "Subagent execution failed",
      undefined,
      undefined,
      lastError,
    ));
    return {
      subagentId,
      name,
      status: finalStatus,
      summary: finalSummary,
      error: lastError,
    };
  } finally {
    const closedAt = Date.now();
    input.emitEvent(withEventSchema({
      type: "subagent.closed",
      threadId: snapshot.threadId,
      turnId: input.parentTurnId,
      timestampMs: closedAt,
      subagentId,
      closedAt,
      reason: finalStatus,
    }));
    input.parentSignal?.removeEventListener("abort", abortFromParent);
    unregisterSubagentAbortController(subagentId);
  }
}
