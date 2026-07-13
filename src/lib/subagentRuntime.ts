import type { AppConfig } from "./appTypes";
import type { AgentLoopOutcome, AgentMessage, OrchestratorCallbacks } from "./orchestrator/types";
import {
  acquireSubagentScopeLease,
  findSubagentLeaseOverlap,
  getSubagentBurstAdmission,
  registerSubagentAbortController,
  registerCoordinatedSubagentRun,
  reportSubagentCapacityFailure,
  parseSubagentAllowedPaths,
  releaseSubagentScopeLease,
  resolveSubagentCapacityPolicy,
  unregisterSubagentAbortController,
  withSubagentCapacity,
  type SpawnSubagentRequest,
  type SpawnSubagentResult,
  type SubagentActivity,
  type SubagentProgress,
  type SubagentRunPatch,
  type SubagentResultEnvelope,
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

function compactEvidence(
  evidence: SubagentResultEnvelope["evidence"],
): SubagentResultEnvelope["evidence"] {
  const seen = new Set<string>();
  const compacted: SubagentResultEnvelope["evidence"] = [];
  for (const item of evidence) {
    const tool = compactText(item.tool, 80);
    const target = compactText(item.target, 300);
    if (!tool || !target) continue;
    const key = `${tool}:${target}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    compacted.push({
      tool,
      target,
      detail: compactText(item.detail, 400),
    });
    if (compacted.length >= 10) break;
  }
  return compacted;
}

function buildChildPrompt(request: SpawnSubagentRequest, language: "zh" | "en"): string {
  const hints = compactText(request.contextHints, 1_600);
  const allowedPaths = compactText(request.allowedPaths, 2_000);
  const scope = compactText(request.scope, 500);
  const expectedOutput = compactText(request.expectedOutput, 500);
  if (language === "en") {
    return [
      "You are a bounded read-only subagent working for a parent task.",
      `Role: ${request.role || "explorer"}`,
      `Objective: ${request.objective}`,
      scope ? `Owned scope: ${scope}` : "",
      hints ? `Context hints: ${hints}` : "",
      allowedPaths ? `Allowed paths: ${allowedPaths}` : "",
      expectedOutput ? `Expected output: ${expectedOutput}` : "",
      "Use only the read/search tools exposed to you. Do not modify files, run shell commands, request approval, or spawn another agent.",
      "Stay inside the allowed paths. Return a concise evidence summary with file paths, findings, uncertainty, and remaining work. Never offer approval choices or address the end user directly.",
    ].filter(Boolean).join("\n\n");
  }
  return [
    "你是主任务派生出的有界只读子智能体。",
    `角色：${request.role || "explorer"}`,
    `目标：${request.objective}`,
    scope ? `负责范围：${scope}` : "",
    hints ? `上下文提示：${hints}` : "",
    allowedPaths ? `允许路径：${allowedPaths}` : "",
    expectedOutput ? `预期产出：${expectedOutput}` : "",
    "只使用当前暴露的读取与搜索工具。不得修改文件、运行 Shell 命令、请求用户批准或继续创建子智能体。",
    "严格限制在允许路径内。返回简洁的证据摘要，包含文件路径、结论、不确定项与剩余工作；不要提供批准选项，也不要直接面向最终用户说话。",
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
        default: maxIterations,
        subagent: maxIterations,
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

interface PreparedSubagentRun {
  subagentId: string;
  name: string;
  role: string;
  objective: string;
  scopeKey: string;
  allowedPaths: string[];
}

export function scheduleControlledSubagent(input: {
  request: SpawnSubagentRequest;
  parentCallbacks: OrchestratorCallbacks;
  parentTurnId: string;
  parentSignal?: AbortSignal;
  existingRunCount: number;
  emitEvent: (event: MainThreadEvent) => void;
  executeAgentLoop: ExecuteAgentLoop;
}): SpawnSubagentResult {
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
  const rawObjective = String(input.request.objective || "").trim();
  if (rawObjective.length > 800) {
    throw new Error("SUBAGENT_SCOPE_TOO_BROAD: objective must be 800 characters or fewer.");
  }
  const objective = compactText(rawObjective, 800);
  if (!objective) throw new Error("Subagent objective is required.");
  const allowedPaths = parseSubagentAllowedPaths(input.request.allowedPaths, parentConfig.workspace);
  if (allowedPaths.length === 0) {
    throw new Error("SUBAGENT_SCOPE_REQUIRED: workspace subagents require allowed_paths.");
  }
  if (policy.profile === "local" && allowedPaths.length > 6) {
    throw new Error("SUBAGENT_SCOPE_TOO_BROAD: local subagents may own at most 6 paths.");
  }
  const leaseOverlap = findSubagentLeaseOverlap({
    threadId: input.parentCallbacks.getSessionKey(),
    workspace: parentConfig.workspace,
    allowedPaths,
  });
  if (leaseOverlap) {
    input.parentCallbacks.onDebugEvent?.("delegation_scope_decision", {
      decision: "rejected",
      reason: "duplicate_subagent_scope",
      conflictingSubagentId: leaseOverlap.subagentId,
      conflictingScopeKey: leaseOverlap.scopeKey,
      allowedPaths,
    });
    throw new Error(
      `SUBAGENT_DUPLICATE_SCOPE: allowed_paths overlap ${leaseOverlap.subagentId} (${leaseOverlap.scopeKey}). Delegate a distinct scope.`,
    );
  }
  const scopeKey = compactText(input.request.scopeKey || input.request.scope || objective, 96);
  const prepared: PreparedSubagentRun = {
    subagentId,
    name,
    role,
    objective,
    scopeKey,
    allowedPaths,
  };
  input.parentCallbacks.onDebugEvent?.("subagent_scheduled", {
    subagentId,
    name,
    role,
    scopeKey,
    profile: policy.profile,
    childCapacity: policy.maxActiveRequests,
    burstChildCapacity: policy.maxBurstActiveRequests,
    elasticCandidate: policy.profile === "local" && input.existingRunCount >= policy.maxActiveRequests,
    allowedPathCount: allowedPaths.length,
  });
  const completion = executeControlledSubagent({ ...input, prepared });
  registerCoordinatedSubagentRun({
    threadId: input.parentCallbacks.getSessionKey(),
    parentTurnId: input.parentTurnId,
    subagentId,
    name,
    scopeKey,
    completion,
  });
  return { subagentId, name, status: "queued", scopeKey };
}

export async function executeControlledSubagent(input: {
  request: SpawnSubagentRequest;
  parentCallbacks: OrchestratorCallbacks;
  parentTurnId: string;
  parentSignal?: AbortSignal;
  existingRunCount: number;
  emitEvent: (event: MainThreadEvent) => void;
  executeAgentLoop: ExecuteAgentLoop;
  prepared?: PreparedSubagentRun;
}): Promise<SubagentResultEnvelope> {
  const parentConfig = input.parentCallbacks.getConfig();
  const language = input.parentCallbacks.getPreferredLanguage();
  const policy = resolveSubagentCapacityPolicy(parentConfig);
  const prepared = input.prepared || (() => {
    const objective = compactText(input.request.objective, 800);
    return {
      subagentId: `subagent-${generateId()}`,
      name: sanitizeName(input.request.name, input.existingRunCount),
      role: compactText(input.request.role || "explorer", 48) || "explorer",
      objective,
      scopeKey: compactText(input.request.scopeKey || input.request.scope || objective, 96),
      allowedPaths: parseSubagentAllowedPaths(input.request.allowedPaths, parentConfig.workspace),
    };
  })();
  const { subagentId, name, role, objective, scopeKey, allowedPaths } = prepared;
  const childRunId = `run-${subagentId}`;
  const parentRunId = input.parentCallbacks.getCurrentRunIdentity?.().runId || null;
  const emitChildDebug = (event: string, data: Record<string, unknown> = {}) => {
    input.parentCallbacks.onDebugEvent?.(event, {
      ...data,
      threadId: `${input.parentCallbacks.getSessionKey()}:${subagentId}`,
      turnId: subagentId,
      runId: childRunId,
      parentRunId,
      agentKind: "subagent",
      subagentId,
    });
  };

  const now = Date.now();
  const snapshot: SubagentRunSnapshot = {
    id: subagentId,
    parentTurnId: input.parentTurnId,
    threadId: input.parentCallbacks.getSessionKey(),
    name,
    role,
    objective,
    scopeKey,
    scope: compactText(input.request.scope, 500),
    allowedPaths,
    expectedOutput: compactText(input.request.expectedOutput, 500),
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
  emitChildDebug("subagent_queued", {
    scopeKey,
    profile: policy.profile,
    childCapacity: policy.maxActiveRequests,
    burstChildCapacity: policy.maxBurstActiveRequests,
    elasticCandidate: policy.profile === "local" && input.existingRunCount >= policy.maxActiveRequests,
    allowedPathCount: allowedPaths.length,
  });
  acquireSubagentScopeLease({
    threadId: snapshot.threadId,
    parentTurnId: input.parentTurnId,
    subagentId,
    scopeKey,
    workspace: parentConfig.workspace,
    allowedPaths,
    createdAt: now,
  });

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
  const evidence: SubagentResultEnvelope["evidence"] = [];
  let activitySequence = 0;
  let lastProgressEmitAt = 0;
  let childForceXmlTools = false;

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
    getCurrentRunIdentity: () => ({
      runId: childRunId,
      parentRunId,
    }),
    getSubagentScope: () => ({
      subagentId,
      parentSessionKey: snapshot.threadId,
      scopeKey,
      workspace: parentConfig.workspace,
      allowedPaths,
    }),
    getRuntimeTraceContext: () => ({
      threadId: `${snapshot.threadId}:${subagentId}`,
      turnId: subagentId,
      runId: childRunId,
      parentRunId,
      agentKind: "subagent",
      subagentId,
    }),
    shouldForceXmlForProviderCompatibility: () => childForceXmlTools,
    onProviderCompatibilityFallback: (reason) => {
      childForceXmlTools = true;
      emitChildDebug("subagent_protocol_fallback", {
        reason,
        from: "native_tools",
        to: "xml_tools",
      });
    },
    onProviderNativeToolSuccess: () => {},
    onDebugEvent: (event, data = {}) => {
      if (event === "memory_pressure_sample" && data.action === "hold") {
        emitProgress({
          phase: "waiting",
          title: language === "zh" ? "等待本地模型内存余量" : "Waiting for local model memory",
          completedToolCalls,
        });
      }
      emitChildDebug(event, data);
    },
    runSubagent: undefined,
    waitSubagents: undefined,
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
    onNonActionableStop: (message, _reason, progress) => {
      lastError = progress?.recoveryReason === "empty_model_response"
        ? `SUBAGENT_EMPTY_MODEL_RESPONSE: the provider returned no semantic text or tool calls after the bounded ${childForceXmlTools ? "native-to-XML fallback" : "native tool"} attempts.`
        : String(message || "");
    },
    onPlanArtifactUpdated: () => {},
    onPlanStageChanged: () => {},
    onPlanTasksUpdated: () => {},
    onPlanExecutionProgress: undefined,
    onApprovedPlanExecutionStarted: () => {},
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
      evidence.push({
        tool,
        target,
        detail: compactText(result, 1_000),
      });
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
  let wallClockTimedOut = false;
  const lifecycleStartedAt = Date.now();
  let capacityQueuedAt: number | null = null;
  try {
    return await withSubagentCapacity({
      policy,
      signal: childAbortController.signal,
      onQueued: () => {
        capacityQueuedAt = Date.now();
        const burstAdmission = getSubagentBurstAdmission(policy);
        const elasticCandidate = policy.profile === "local" &&
          input.existingRunCount >= policy.maxActiveRequests;
        emitChildDebug("subagent_capacity_queued", {
          profile: policy.profile,
          childCapacity: policy.maxActiveRequests,
          burstChildCapacity: policy.maxBurstActiveRequests,
          elasticCandidate,
          burstAdmission,
        });
        if (elasticCandidate) {
          emitChildDebug("subagent_elastic_admission", {
            decision: "queued",
            burstAdmission,
          });
        }
        emitUpdate({
          status: "queued",
          progress: {
            phase: "queued",
            title: policy.profile === "local"
              ? language === "zh" ? "等待本地子智能体并发配额" : "Waiting for local subagent capacity"
              : language === "zh" ? "等待云端并发配额" : "Waiting for cloud concurrency capacity",
            completedToolCalls,
          },
        });
      },
      task: async () => {
        const startedAt = Date.now();
        const burstAdmission = getSubagentBurstAdmission(policy);
        const elasticCandidate = policy.profile === "local" &&
          input.existingRunCount >= policy.maxActiveRequests;
        if (elasticCandidate) {
          emitChildDebug("subagent_elastic_admission", {
            decision: burstAdmission.allowed ? "admitted" : "started_after_base_slot_released",
            waitMs: capacityQueuedAt == null ? 0 : startedAt - capacityQueuedAt,
            burstAdmission,
          });
        }
        emitChildDebug("subagent_started", {
          profile: policy.profile,
          capacityWaitMs: capacityQueuedAt == null ? 0 : startedAt - capacityQueuedAt,
          childCapacity: policy.maxActiveRequests,
          burstChildCapacity: policy.maxBurstActiveRequests,
          elasticAdmissionGranted: elasticCandidate && burstAdmission.allowed,
          burstAdmission,
        });
        emitUpdate({
          status: "starting",
          startedAt,
          progress: {
            phase: "starting",
            title: language === "zh" ? "子智能体已启动" : "Subagent started",
            completedToolCalls,
          },
        }, makeActivity("running", language === "zh" ? "开始执行" : "Execution started"));

        const wallClockTimer = setTimeout(() => {
          wallClockTimedOut = true;
          lastError = "SUBAGENT_WALL_CLOCK_TIMEOUT: execution exceeded 240 seconds.";
          childAbortController.abort();
        }, 240_000);
        const outcome = await input.executeAgentLoop(childCallbacks, childAbortController)
          .finally(() => clearTimeout(wallClockTimer));
        finalStatus = resolveOutcomeStatus(outcome, childAbortController.signal.aborted);
        if (wallClockTimedOut) finalStatus = "blocked";
        const candidateSummary = compactText(
          finalText || turnSummary || streamText || childMessages
            .filter((message) => message.role === "assistant" && typeof message.content === "string")
            .map((message) => String(message.content))
            .filter(Boolean)
            .join("\n"),
          16_000,
        );
        finalSummary = candidateSummary;
        if (
          finalStatus === "failed" &&
          (outcome.status === "stopped_no_action" || outcome.status === "stopped_no_output") &&
          (candidateSummary.length > 0 || evidence.length > 0)
        ) {
          finalStatus = "blocked";
          emitChildDebug("subagent_partial_result_preserved", {
            outcomeStatus: outcome.status,
            outcomeReason: outcome.reason,
            summaryChars: candidateSummary.length,
            evidenceCount: evidence.length,
          });
        }
        if (!finalSummary) {
          finalSummary = finalStatus === "completed"
            ? language === "zh" ? "子智能体已完成，但没有返回可见摘要。" : "The subagent completed without a visible summary."
            : lastError || outcome.reason;
        }
        const completedAt = Date.now();
        if (finalStatus === "failed") {
          const degraded = reportSubagentCapacityFailure(policy, lastError || outcome.reason);
          if (degraded) finalStatus = "degraded";
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
              : finalStatus === "blocked" || finalStatus === "degraded"
              ? language === "zh" ? "已返回可用的部分结果" : "Usable partial result returned"
              : finalStatus === "canceled"
              ? language === "zh" ? "已取消" : "Canceled"
              : language === "zh" ? "执行未完成" : "Execution did not complete",
            completedToolCalls,
          },
        }, makeActivity(
          finalStatus === "completed" || finalStatus === "blocked" || finalStatus === "degraded"
            ? "completed"
            : finalStatus === "canceled" ? "canceled" : "failed",
          finalStatus === "completed"
            ? language === "zh" ? "返回摘要" : "Summary returned"
            : finalStatus === "blocked" || finalStatus === "degraded"
            ? language === "zh" ? "返回部分摘要" : "Partial summary returned"
            : language === "zh" ? "执行结束" : "Execution ended",
        ));
        if (finalStatus === "degraded") {
          input.emitEvent(withEventSchema({
            type: "subagent.handed_back",
            threadId: snapshot.threadId,
            turnId: input.parentTurnId,
            timestampMs: completedAt,
            subagentId,
            reason: lastError || outcome.reason,
            evidenceCount: evidence.length,
            remainingWork: objective,
          }));
          emitChildDebug("subagent_handed_back", {
            subagentId,
            scopeKey,
            reason: lastError || outcome.reason,
            evidenceCount: evidence.length,
            remainingWork: objective,
          });
        }
        return {
          subagentId,
          name,
          scopeKey,
          status: finalStatus,
          summary: finalSummary,
          evidence: compactEvidence(evidence),
          ...(finalStatus === "completed" ? {} : { blocker: lastError || outcome.reason }),
          ...(finalStatus === "degraded" ? { remainingWork: objective } : {}),
          ...(finalStatus === "completed" ? {} : { error: lastError || outcome.reason }),
        };
      },
    });
  } catch (error) {
    finalStatus = wallClockTimedOut
      ? "blocked"
      : childAbortController.signal.aborted ? "canceled" : "failed";
    finalSummary = compactText(finalText || turnSummary || streamText, 16_000);
    lastError = finalStatus === "canceled"
      ? language === "zh"
        ? "SUBAGENT_CANCELED_BY_USER：子智能体已停止；除非用户明确要求，否则不要重新创建相同任务。"
        : "SUBAGENT_CANCELED_BY_USER: the subagent was stopped; do not respawn the same task unless the user explicitly asks."
      : error instanceof Error ? error.message : String(error || "");
    if (finalStatus === "failed" && reportSubagentCapacityFailure(policy, error)) {
      finalStatus = "degraded";
    }
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
      scopeKey,
      status: finalStatus,
      summary: finalSummary,
      evidence: compactEvidence(evidence),
      blocker: lastError,
      ...(finalStatus === "degraded" ? { remainingWork: objective } : {}),
      error: lastError,
    };
  } finally {
    const closedAt = Date.now();
    emitChildDebug("subagent_finished", {
      status: finalStatus,
      durationMs: closedAt - lifecycleStartedAt,
      completedToolCalls,
      evidenceCount: compactEvidence(evidence).length,
      blocker: compactText(lastError, 300) || null,
    });
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
    releaseSubagentScopeLease(subagentId);
  }
}
