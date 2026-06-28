import { type OpenAiToolChoice, type StreamResult } from "../../streaming";
import { buildToolDefinitions, skillNameToToolName, type ToolDefinition } from "../../toolSchemas";
import { compactContextForExecuteRecovery, computeContextBudgets, manageContext } from "../../contextTrim";
import { clampContextLimitToReported } from "../../contextWindow";

import { createThread, createTurn } from "../state/Thread";
import { TurnContext } from "../state/TurnContext";
import { pruneEphemeralItems } from "../state/EphemeralPruner";
import { strainReasoning } from "../state/ReasoningStrainer";
import { PolicyFactory } from "../policies/PolicyFactory";
import { generateId } from "../../utils";
import { summarizeThought, thoughtSummaryToString } from "../../chat/StreamingThoughtSummarizer";
import { buildSystemPrompt } from "../../systemPrompt";
import { discoverAllMcpTools, getMcpToolServerMap, setMcpToolServerMap, type MCPServerStatusSnapshot } from "../../mcpClient";
import { ensureVisibleConclusionWithPolicy, isAssistantTurnEmpty, isSyntheticVisibleConclusion, normalizeAssistantTurn } from "../../normalizedTurn";
import { hasTieredPlanProposal } from "../../planProposal";
import { runModelProbe, createProbeRunner } from "../../modelProbe";
import { buildReadOnlyPermissionContinuationPrompt, hasExecutableProposalReplyOptions, hasOnlyNonBlockingPlanReplyOptions, hasOnlyReadOnlyPermissionReplyOptions, serializeAssistantReplyForHistory, shouldAutoContinueReadOnlyPermission as shouldAutoContinueReadOnlyPermissionState, shouldPauseForReplyOptions, shouldRouteUnapprovedPlanReplyOptionsToArtifact, shouldSuppressApprovedPlanExecutionReplyOptions as shouldSuppressApprovedPlanExecutionReplyOptionsState, stripReadOnlyPermissionPrompt } from "../../replyOptions";
import { planReadFileWindowCoverage } from "../../readFileWindow";
import { FILE_UNCHANGED_STUB, buildFileReadSignature, buildFileUnchangedReplayContent, buildFileUnchangedStub, formatReadFileWindowCoverageStub, formatReadFileWindowNarrowedNote, getReadFileCoverageForPath, getSessionFileReadStates, hashString, pruneFileReadStates } from "../../orchestrator/fileReadCache";
import { buildExecuteNoActionPauseMessage, buildExecuteXmlTextActionRecoveryPrompt, buildLanguageMismatchRecoveryPrompt, buildMalformedToolUseRecoveryPrompt, buildPseudoToolCallRecoveryPrompt, buildReasoningDominatedPauseMessage, buildReasoningDominatedRecoveryPrompt, buildToolProtocolDoomLoopStopMessage, buildToolUnavailableRecoveryPrompt, choosePseudoToolRecovery, containsToolNameParameterFallback, containsToolUseBlock, extractPseudoToolCallName, extractUserMentionedFilePathsFromMessages, isReasoningDominatedNoActionResult, looksLikeNonStandardToolCallFormat, looksLikePseudoToolCallPlaceholder, looksLikeToolUnavailableClaim, shouldRecoverLanguageMismatchTurn, shouldRecoverExecuteXmlTextWithoutAction, summarizeProtocolFragmentForLog } from "../../orchestrator/agentRecovery";
import { UNITY_FALLBACK_RECOVERY_READ_ONLY_TOOL_NAMES, annotateUnityEditToolDescriptions, extractMcpCallFailureCategory, isGameEngineLikelyServer, isUnityCommandDirective, isUnityConsoleDiagnosticsDirective, isUnityScriptWriteToolCall, normalizeGameStudioEngineKey, shouldRepromptBeforeUnityConsoleFallback, shouldTriggerUnityMcpFirstIterationFallback, shouldTriggerUnityMcpStrictRetry } from "../../orchestrator/unityDiagnostics";
import { buildPlanAutoScaffoldPrompt, buildPlanEvidenceRecoveryBlockedPrompt, buildPlanEvidenceRecoveryClosurePrompt, buildPlanFallbackNotice, buildPlanPostConvergenceToolRedirectPrompt, buildPlanReadOnlyConvergencePause, buildPlanReadOnlyConvergencePrompt, buildPlanStreamTimeoutPauseMessage, countSuccessfulPlanReadEvidence, hasGroundedPlanClosureEvidence, hasSuccessfulTabularActivity, planRuntimePhasePresentation, resolvePlanClosureArtifactKind } from "../../orchestrator/planOrchestration";
import { initialLifecycleStateForPlanAction, planRuntimeToolCall } from "../../runtimeTools";
import type { AppConfig } from "../../../store/useAppStore";
import { buildPlanTaskEvidenceAudit, hasBrowserValidationCapability, isPlanTaskTrustedComplete, looksLikeSubstantivePlanAssistantText, type PlanExecutionProgressPhase, type PlanExecutionProgressUpdate, type PlanRuntimePhase } from "../../workflowModels";
import { hasExplicitUnityConsoleDiagnosticCue, type ResolvedUserIntent } from "../../runIntent";
import { loadResolvedInstructions } from "../../instructions";
import { loadHooksConfig } from "../../hooks";
import { buildRepeatLoopArgsKey, buildRepeatLoopSignature, formatRepeatLoopFatalMessage, formatRepeatLoopRecoveryMessage, formatTargetProgressLoopRecoveryMessage, getShellMutationTargetForLoopGuard, isReadOnlyShellInspectionToolCall, registerTargetProgressEventForLoopGuard, registerToolCallForRepeatGuard } from "../../repetitionGuard";
import { buildToolCapabilityRegistry, filterToolDefinitionsForIntent, isLocalFileReadApproved, type McpRoutingPriorityMode, isToolAutoExecutableForCall, routeMcpToolsForPrompt } from "../../toolCapabilities";
import { buildCompatibilityRetryMessages, buildTranscriptCompatibilityRetryMessages, ensureProviderCompatibilityMode, extractCompatibilityTextContent, isProviderCompatibilityErrorMessage } from "../../providerCompatibility";
import { resolveReasoningPolicy } from "../../cloudProtocol";
import { getErrorMessage } from "../../errorUtils";
import { isCloudGatewayTimeoutMessage, isRetryableCloudErrorMessage } from "../../cloudRetry";
import { buildMissingToolCallContinuationPrompt, resolveMissingToolCallRepromptKind } from "../../missingToolCallReprompt";
import { buildPlanExecutionProgressUpdate, buildExecuteMaxIterationsPauseNotice, buildPlanNoProgressLoopPauseNotice, buildPlanProgressSignatureFromToolActivity, buildPlanMaxIterationsCheckpoint, buildPlanMaxIterationsPauseNotice, isCachedReadOnlyPlanActivity, summarizeRepeatedPlanTargetsFromToolActivity, type PlanToolActivitySummary } from "../../planExecutionRecovery";
import { describeApprovedPlanRecoveryToolSurface, describeApprovedPlanSourceEditFirstToolSurface, isApprovedPlanCachedReadOnlyNoProgressBatch, shouldBypassApprovedPlanReadCacheForPatchRecovery, shouldAllowApprovedPlanRecoveryFileRead } from "../../approvedPlanRecoveryTools";
import { buildExecuteNoProgressLoopPauseNotice, buildExecuteRecoveryPrompt, buildExecuteValidationRecoveryPrompt, describeExecuteRecoveryToolSurface, isExecuteRecoveryToolName, normalizeExecuteRecoveryMode, resolveExecuteReadOnlyRecoveryTrigger, resolveReadOnlyNoProgressTrigger, shouldAllowExecuteRecoveryFileRead, summarizeRepeatedExecuteTargets, type ExecuteRecoveryMode } from "../../executeRecoveryTools";
import { buildPlanExecutionNoToolRecoveryPrompt } from "../../planExecutionNoTool";
import { buildExecutionDigest } from "../../executionDigest";
import { withEventSchema, type MainThreadEventInput, type MainThreadItem } from "../../turnEvents";
import { composeReviewablePlanFromEvidence, summarizePlanEvidenceDetail } from "../../planMaterialization";
import { progressNarrationToText } from "../../progressNarration";
import { buildChatFinalSynthesisPrompt, buildEmptyModelResponsePauseNotice, buildMaxStepsFinalTextPrompt, buildMaxStepsToolCallIgnoredNotice, resolveAgentLoopMaxIterations, shouldTriggerChatFinalSynthesis, shouldUseMaxStepsFinalTextOnly, type AgentLoopIterationLimits } from "../../agentLoopSafety";
import { buildTaskTargetingProfile, getTaskTargetingEvidenceKey, shouldBlockToolCallForTargeting, type TaskOrchestratorPhase } from "../../taskTargeting";
import { assessPlanEvidenceReadiness, shouldTriggerPlanReadOnlyConvergence } from "../../planReadOnlyConvergence";
import { buildPlanEvidenceBlockedPauseMessage, buildPlanTargetedEvidenceRecoveryPrompt, isPlanDraftWriteToolName, resolvePlanNoActionRecovery, resolvePlanSuppressedToolRecovery, shouldClosePlanToolSurfaceAfterReadOnlyConvergence, shouldRedirectPlanToolsAfterReadOnlyConvergence, MAX_PLAN_EVIDENCE_RECOVERY_PASSES } from "../../planRuntime";
import { extractPrimaryUserRequestText, extractTurnInputContextSignalsFromMessages } from "../../turnIntake";
import { buildRequiredWebResearchQuery, formatWebResearchLocalDate, shouldRequireWebResearchForPrompt } from "../../webResearchGuard";
import { deriveStreamSettings, resolveEffectiveToolProtocol, shouldUseXmlToolProtocol, resolveModelProtocolProfile, compactDiagnosticText, getOriginalUserPromptForPlanFallback, logAgentEvent, looksLikeRepairExecutionRequest, WEB_RESEARCH_TOOL_NAMES, KNOWLEDGE_TOOL_NAMES, filterGlobalChatToolDefinitions, getSessionTaskTargetingEvidence, runLifecycleHooks, createHookContextMessages, shouldUsePlanNoVisibleTokenWatchdog, PLAN_NO_VISIBLE_TOKEN_TIMEOUT_MS, truncateForLog, MAX_RECENT_PLAN_TOOL_ACTIVITY, EDIT_PROGRESS_TOOL_NAMES, EXECUTION_VERIFICATION_TOOL_NAMES, isReviewablePlanStage, buildPlanReviewReadyMessage, buildApprovedPlanContinuationPrompt, collectPlanClosureMaterializationInput, shouldAttemptPlanClosureGuard, isStreamWatchdogTimeoutMessage, buildApprovedPlanNoProgressStrategySwitchPrompt, PLAN_EXPLORATION_READ_ONLY_TOOLS, approvedPlanNeedsSourceEditBeforeValidation, isApprovedPlanSourceEditFirstTool, isApprovedPlanRecoveryTool, filterPlanRuntimeToolDefinitionsForPhase, hasPlanUserContextObservation, computeManagedContextLimit, computeContextForceReason, prepareMessagesForToolProtocol, summarizeMessagesForDiagnostics, summarizeToolsForDiagnostics, fetchLLMStream, shouldTreatCloudGatewayErrorAsCompatibility, buildNonActionableStopMessage, normalizeToolCallToExecute, buildAssistantHistoryMessage, shouldCompactProseCodeDump, buildProseCodeDumpNotice, summarizeReplyOptionsForLog, looksLikePlanCompletionClaim, isPreApprovalPlanDraftWrite, parseToolCallArguments, buildToolActionNarration, getToolTarget, MAX_NO_ACTION_RETRIES, buildReadOnlyPermissionHardRecoveryPrompt, formatPlanAuditRemainingTasks, resolveApprovedPlanValidationBoundary, buildApprovedPlanValidationPendingMessage, MAX_APPROVED_PLAN_NO_PROGRESS_RECOVERY_ATTEMPTS, buildApprovedPlanNoToolPauseMessage, buildBrowserValidationContinuationPrompt, buildPlanCommandExecutionHint, looksLikeOperationCompletionClaim, buildExecuteCompletionEvidencePrompt, looksLikeExecutionReplanningText, buildExecuteReplanningEvidencePrompt, autoMaterializePlanArtifactFromVisibleText, buildPlanRecoveryPrompt, CONCISE_PLAN_ARTIFACT_HINT_ZH, CONCISE_PLAN_ARTIFACT_HINT_EN, isPlanArtifactPath, buildHiddenThoughtOnlyContinuationPrompt, emitToolPreflightBlocked, planUnsupportedToolFeedbackMessage, buildReadOnlyCacheSignature, readFileMetadataIfAvailable, buildPlanExplorationBudget, PLAN_REPEAT_READ_LIMIT, buildPlanClosurePromptFromEvidence, appendPlanRepeatReadLimitGuidance, formatCachedReadOnlyToolResult, buildPlanGateBlockedResult, truncateToolContent, executeReadOnlyToolsConcurrently, isReadFileRepeatLimitResult, executeLocalFileReadToolWithReview, executeWriteToolWithReview, isProjectSourceWriteResult, inferLifecycleStateFromToolResult, targetProgressReasonForToolResult, isSuccessfulPlanArtifactWriteResult, shouldDeferNoProgressStopToPlanReadOnlyConvergence, buildNoProgressBatchSignature, MAX_NO_PROGRESS_LOOP_REPEATS, buildToolResultHistoryContentByFormat, summarizeReadFileRepeatLimitBatch, buildReadFileRepeatLimitBatchPauseNotice, targetProgressOutcomeForToolResult, PLAN_EXECUTE_CONVERGENCE_PROMPT_RATIO, EXECUTE_CONVERGENCE_PROMPT_RATIO, buildExecuteConvergencePrompt, isExecutionPlanArtifactWrite, isTasksPlanWrite } from "../../orchestrator";
import { AgentMessage, ToolExecutionResult, FetchLLMStreamOptions, CachedReadOnlyToolResult, ToolCallToExecute, ToolCallInMessage, OrchestratorCallbacks, type AgentLoopOutcome } from "../types";

export class AgentOrchestrator {
    async prepareTurn() {
        // TODO: Extract Phase 4 setup logic here in future iterations
        // Requires AgentTurnContext to pass 117+ variables
    }

    async invokeStream() {
        // TODO: Extract LLM fetch logic here
    }

    async evaluateResults() {
        // TODO: Extract tool evaluation logic here
    }

    async execute(callbacks: OrchestratorCallbacks, abortController: AbortController) {
        const config = callbacks.getConfig();
        const isCloudProfile = config.activeProfile === "cloud";
        const skills = callbacks.getSkills();
        const initialMessages = callbacks.getMessages();
        const settings = deriveStreamSettings(config);
        const effectiveToolProtocol = resolveEffectiveToolProtocol(config, settings);
        const compatibilityForcedAtStart = callbacks.shouldForceXmlForProviderCompatibility?.();
        const nativeToolsEnabled = !shouldUseXmlToolProtocol(
                config,
                settings,
                initialMessages,
                compatibilityForcedAtStart,
              );
        const modelProtocolProfile = resolveModelProtocolProfile({
                activeProfile: config.activeProfile,
                provider: settings.provider,
                model: settings.model,
                protocol: settings.apiProtocol,
                configuredToolProtocol: effectiveToolProtocol,
                compatibilityOverride: compatibilityForcedAtStart,
              });
        const reasoningPolicy = resolveReasoningPolicy({
                activeProfile: config.activeProfile,
                requestedMode: modelProtocolProfile.reasoning,
                reasoningRequest: config.activeProfile === "cloud" ? "auto" : "off",
                reasoningDisplay: config.reasoningDisplay,
                reasoningEffort: settings.reasoningEffort,
              });
        const workspace = config.workspace;
        const mainModeKey = callbacks.getMainModeKey();
        const workspaceTree = callbacks.getWorkspaceTree();
        const turnIntent = callbacks.getCurrentRunIntent();
        const workflowMode = callbacks.getWorkflowMode();
        const resolveRuntimeIntent = (): ResolvedUserIntent => {
                const currentConversationIntent = callbacks.getCurrentRunIntent();
                const requestedRuntimeIntent = callbacks.getRuntimeRunIntent?.() ?? currentConversationIntent;
                if (
                  currentConversationIntent === "plan" &&
                  callbacks.getIsPlanApproved() &&
                  requestedRuntimeIntent === "plan"
                ) {
                  return "execute";
                }
                return requestedRuntimeIntent;
              };
        const eventThreadId = callbacks.getSessionKey() || "default";
        const eventTurnId = callbacks.getCurrentTurnId?.() || generateId();
        let turnEventTerminalEmitted = false;
        const emitTurnEvent = (event: MainThreadEventInput): void => {
                callbacks.onTurnEvent?.(withEventSchema(event));
              };
        const emitTurnCompletedEvent = () => {
                if (turnEventTerminalEmitted) return;
                turnEventTerminalEmitted = true;
                emitTurnEvent({
                  type: "turn.completed",
                  threadId: eventThreadId,
                  turnId: eventTurnId,
                  timestampMs: Date.now(),
                });
              };
        const emitTurnFailedEvent = (message: string) => {
                if (turnEventTerminalEmitted) return;
                turnEventTerminalEmitted = true;
                emitTurnEvent({
                  type: "turn.failed",
                  threadId: eventThreadId,
                  turnId: eventTurnId,
                  timestampMs: Date.now(),
                  error: { message },
                });
              };
        emitTurnEvent({
        type: "thread.started",
        threadId: eventThreadId,
        timestampMs: Date.now(),
        });
        emitTurnEvent({
        type: "turn.started",
        threadId: eventThreadId,
        turnId: eventTurnId,
        timestampMs: Date.now(),
        });
        if (turnIntent !== "respond" && turnIntent !== "discuss") {
        const language = callbacks.getPreferredLanguage();
        const userGoal = compactDiagnosticText(getOriginalUserPromptForPlanFallback(callbacks), 220);
        const hasImages = callbacks.getMessages().some((message) =>
          Array.isArray(message.content) &&
          message.content.some((part: any) => part?.type === "image_url" || part?.type === "input_image")
        );
        emitTurnEvent({
          type: "progress.updated",
          threadId: eventThreadId,
          turnId: eventTurnId,
          timestampMs: Date.now(),
          progress: {
            phase: "understanding",
            title: language === "zh" ? "理解需求" : "Understanding request",
            status: "running",
            summary: hasImages
              ? language === "zh"
                ? "正在理解用户目标、截图内容和执行约束，随后再定向读取必要证据。"
                : "Understanding the user goal, screenshots, and constraints before targeted evidence reads."
              : language === "zh"
              ? "正在理解用户目标、约束和安全边界，随后选择最小必要行动。"
              : "Understanding the user goal, constraints, and safety boundary before choosing the smallest useful action.",
            evidence: userGoal ? (language === "zh" ? `用户目标：${userGoal}` : `User goal: ${userGoal}`) : "",
            next: workflowMode === "plan" && !callbacks.getIsPlanApproved()
              ? language === "zh"
                ? "先做只读证据收束；批准前只允许生成计划文件。"
                : "First gather read-only evidence; before approval only plan artifacts may be written."
              : language === "zh"
              ? "进入定向上下文读取、执行或明确阻塞。"
              : "Move into targeted context reads, execution, or a concrete blocker.",
            dedupeKey: `understanding:${eventTurnId}`,
          },
        });
        }

        logAgentEvent("runtime_settings", {
        baseUrl: settings.baseUrl,
        model: settings.model,
        useRustProxy: settings.useRustProxy,
        hasApiKey: !!settings.apiKey,
        provider: settings.provider,
        nativeToolsEnabled,
        toolProtocol: effectiveToolProtocol,
        modelProtocolToolProtocol: modelProtocolProfile.toolProtocol,
        modelProtocolReasoning: modelProtocolProfile.reasoning,
        reasoningPolicyMode: reasoningPolicy.mode,
        reasoningDisplay: reasoningPolicy.display,
        reasoningReplayInContext: reasoningPolicy.replayInContext,
        providerFamily: modelProtocolProfile.providerFamily,
        xmlToolsEnabled: true,
        });
        logAgentEvent("reasoning_policy_applied", {
        mode: reasoningPolicy.mode,
        request: reasoningPolicy.request,
        display: reasoningPolicy.display,
        replayInContext: reasoningPolicy.replayInContext,
        maxHiddenChars: reasoningPolicy.maxHiddenChars,
        providerFamily: modelProtocolProfile.providerFamily,
        activeProfile: config.activeProfile,
        });
        let snapshotContextLimit = isCloudProfile ? undefined : config.local.contextLimit;
        const mcpServers = callbacks.getMcpServers();
        const latestUserPrompt = [...initialMessages]
                .reverse()
                .find((message) => message.role === "user");
        const latestUserPromptFullText = latestUserPrompt ? extractCompatibilityTextContent(latestUserPrompt.content) : "";
        const latestUserPromptText = extractPrimaryUserRequestText(latestUserPromptFullText) || latestUserPromptFullText;
        const repairExecutionRequestInChat = workflowMode === "chat" && looksLikeRepairExecutionRequest(latestUserPromptText);
        const turnInputContextSignals = extractTurnInputContextSignalsFromMessages(initialMessages);
        const commandDirective = callbacks.getCommandDirective?.() ?? null;
        const gameStudioConfig = callbacks.getGameStudioConfig?.() ?? null;
        const gameStudioEngine = normalizeGameStudioEngineKey(gameStudioConfig?.engine);
        const gameStudioEngineContext = callbacks.getMainModeKey() === "game_studio" && gameStudioEngine != null;
        const gameStudioUnityContext = gameStudioEngineContext && gameStudioEngine === "unity";
        const unityCommandRequested = isUnityCommandDirective(commandDirective) || gameStudioUnityContext;
        const unityConsoleDiagnosticsRequested = isUnityConsoleDiagnosticsDirective(commandDirective) ||
                (unityCommandRequested && hasExplicitUnityConsoleDiagnosticCue(latestUserPromptText));
        const gameStudioScriptEditRequested = (gameStudioEngineContext || unityCommandRequested) &&
                /fix|repair|patch|edit|modify|refactor|script|code|c#|cs|gdscript|blueprint|cpp|c\+\+|修复|补丁|修改|脚本|代码|蓝图|编译|报错|错误/i.test(
                  latestUserPromptText,
                );
        const unityScriptEditRequested = unityCommandRequested &&
                /fix|repair|patch|edit|modify|refactor|script|code|c#|cs|修复|补丁|修改|脚本|代码|编译|报错|错误/i.test(
                  latestUserPromptText,
                );
        const enabledMcpServers = mcpServers.filter((server) => server.enabled !== false);
        let mcpTools = callbacks.getMcpDiscoveredTools();
        let mcpToolServerMap = getMcpToolServerMap();
        let mcpServerStatuses: MCPServerStatusSnapshot[] = mcpServers.map((server) => ({
                serverName: server.name,
                url: server.url,
                enabled: server.enabled !== false,
                status: server.enabled === false ? "disabled" : "failed",
                toolCount: 0,
                category: server.enabled === false ? "ok" : "invalid_response",
                message: server.enabled === false
                  ? "Server is disabled in settings."
                  : "Server status is unknown until discovery runs.",
              }));
        if (mcpServers.length > 0) {
        logAgentEvent("mcp_discovery_start", {
          enabledServers: enabledMcpServers.length,
          totalServers: mcpServers.length,
        });
        const { tools: discovered, toolServerMap, serverStatuses } = await discoverAllMcpTools(mcpServers);
        mcpServerStatuses = serverStatuses;
        mcpToolServerMap = toolServerMap;
        setMcpToolServerMap(toolServerMap);
        if (discovered.length > 0) {
          logAgentEvent("mcp_discovery_done", {
            discoveredTools: discovered.length,
            toolNames: discovered.map(t => t.name).slice(0, 24),
          });
          mcpTools = discovered;
        } else {
          logAgentEvent("mcp_discovery_done", {
            discoveredTools: 0,
          });
          mcpTools = [];
        }
        }

        const connectedMcpServerUrls = new Set(
                mcpServerStatuses
                  .filter((status) => status.status === "connected" && status.enabled)
                  .map((status) => status.url),
              );
        const connectedMcpServers = enabledMcpServers.filter((server) => connectedMcpServerUrls.has(server.url));
        const mcpPriorityEngine = gameStudioEngine ?? (unityCommandRequested ? "unity" : null);
        const preferredGameStudioMcpServerUrls = mcpPriorityEngine
                ? connectedMcpServers
                  .filter((server) => isGameEngineLikelyServer(server, mcpPriorityEngine))
                  .map((server) => server.url)
                : [];
        const effectiveGameStudioMcpServerUrls = preferredGameStudioMcpServerUrls.length > 0
                ? preferredGameStudioMcpServerUrls
                : connectedMcpServers.map((server) => server.url);
        const gameStudioMcpFirstEligible = (gameStudioEngineContext || unityCommandRequested) &&
                !!mcpPriorityEngine &&
                effectiveGameStudioMcpServerUrls.length > 0;
        const effectivePreferredUnityUrls = mcpPriorityEngine === "unity" ? effectiveGameStudioMcpServerUrls : [];
        const unityMcpFirstEligible = unityCommandRequested && mcpPriorityEngine === "unity" && gameStudioMcpFirstEligible;
        const mcpPriorityMode: McpRoutingPriorityMode = gameStudioMcpFirstEligible ? "game_studio_mcp_first" : "none";
        const forceFirstMcpTools = unityMcpFirstEligible && unityConsoleDiagnosticsRequested
                ? ["read_console", "set_active_instance"]
                : [];
        logAgentEvent("mcp_server_status", {
        requestedUnityRouting: unityCommandRequested,
        gameStudioUnityContext,
        gameStudioEngine,
        gameStudioEngineContext,
        requestedGameStudioMcpRouting: gameStudioMcpFirstEligible,
        unityConsoleDiagnosticsRequested,
        statuses: mcpServerStatuses.map((status) => ({
          server: status.serverName,
          url: status.url,
          enabled: status.enabled,
          state: status.status,
          toolCount: status.toolCount,
          category: status.category,
          httpStatus: status.httpStatus,
        })),
        });
        const mcpRoutingResult = routeMcpToolsForPrompt({
                tools: mcpTools,
                servers: connectedMcpServers,
                toolServerMap: mcpToolServerMap,
                userPrompt: latestUserPromptText,
                config: config.mcpRouting,
                priorityMode: mcpPriorityMode,
                preferredServerUrls: preferredGameStudioMcpServerUrls,
                forceFirstTools: forceFirstMcpTools,
                unityRoutingContext: {
                  preferStructuredScriptEdits: unityScriptEditRequested,
                },
                gameStudioRoutingContext: {
                  engine: mcpPriorityEngine,
                  preferStructuredScriptEdits: unityScriptEditRequested || gameStudioScriptEditRequested,
                },
              });
        mcpTools = mcpRoutingResult.tools;
        mcpTools = annotateUnityEditToolDescriptions(mcpTools, unityCommandRequested);
        logAgentEvent("mcp_routing", { ...mcpRoutingResult.telemetry });
        const webSearchEnabled = callbacks.getWebSearchEnabled?.() === true;
        const enabledKnowledgeBaseIds = callbacks.getEnabledKnowledgeBaseIds?.() || [];
        const knowledgeToolsEnabled = enabledKnowledgeBaseIds.length > 0;
        const routedToolDefinitions = buildToolDefinitions(skills, mcpTools).filter((tool) => {
                if (!webSearchEnabled && WEB_RESEARCH_TOOL_NAMES.has(tool.function.name)) return false;
                if (!knowledgeToolsEnabled && KNOWLEDGE_TOOL_NAMES.has(tool.function.name)) return false;
                return true;
              });
        const toolCapabilityRegistry = buildToolCapabilityRegistry({
                toolDefinitions: routedToolDefinitions,
                skills,
                mcpTools,
                mcpServers: connectedMcpServers,
                mcpToolServerMap,
                policy: config.toolPermissionPolicy,
              });
        const preferredUnityServerUrlSet = new Set(effectivePreferredUnityUrls);
        const preferredUnityMcpToolNameSet = new Set(
                mcpTools
                  .filter((tool) => preferredUnityServerUrlSet.has(mcpToolServerMap[tool.name] || ""))
                  .map((tool) => tool.name),
              );
        const fallbackUnityMcpToolNameSet = new Set(mcpTools.map((tool) => tool.name));
        const effectiveUnityMcpToolNameSet = preferredUnityMcpToolNameSet.size > 0
                ? preferredUnityMcpToolNameSet
                : fallbackUnityMcpToolNameSet;
        let unityMcpFirstPhaseActive = unityMcpFirstEligible && effectiveUnityMcpToolNameSet.size > 0;
        let unityMcpFallbackReason: string | null = null;
        let unityMcpFirstIterationPending = unityMcpFirstPhaseActive;
        let unityMcpForceConsoleFirstPending = unityMcpFirstPhaseActive && unityConsoleDiagnosticsRequested;
        let unityMcpStrictRetryPending = false;
        let unityMcpStrictRetryIssued = false;
        let unityConsoleMissingFirstToolRepromptIssued = false;
        let unityConsoleFinalVerificationRequired = false;
        let unityConsoleRefreshObservedAfterWrite = false;
        const activateUnityMcpFallback = (reason: string) => {
                if (!unityMcpFirstPhaseActive) return;
                unityMcpFirstPhaseActive = false;
                unityMcpForceConsoleFirstPending = false;
                unityMcpStrictRetryPending = false;
                unityMcpFallbackReason = reason;
                logAgentEvent("unity_mcp_fallback", {
                  reason,
                  unityCommandRequested,
                  unityConsoleDiagnosticsRequested,
                  preferredServers: effectivePreferredUnityUrls,
                });
              };
        const resolveAllToolsForRuntime = (runtimeIntent: ResolvedUserIntent): ToolDefinition[] => {
                const intentFiltered = filterToolDefinitionsForIntent(
                  routedToolDefinitions,
                  callbacks.getCurrentRunIntent(),
                  toolCapabilityRegistry,
                  {
                    runtimeIntent,
                    planApproved: callbacks.getIsPlanApproved(),
                  },
                );
                const filtered = filterGlobalChatToolDefinitions({
                  tools: intentFiltered,
                  workspace,
                  userContext: turnInputContextSignals,
                });
                if (!workspace.trim() && filtered.length !== intentFiltered.length) {
                  logAgentEvent("global_chat_tool_scope_applied", {
                    runtimeIntent,
                    workflowMode,
                    explicitFileContext:
                      turnInputContextSignals.mentionedFilePaths.length +
                      turnInputContextSignals.attachedFilePaths.length,
                    rawTools: intentFiltered.map((tool) => tool.function.name).slice(0, 24),
                    scopedTools: filtered.map((tool) => tool.function.name),
                    removedToolCount: Math.max(0, intentFiltered.length - filtered.length),
                  });
                }

                if (!unityMcpFirstPhaseActive) {
                  return filtered;
                }

                const shouldForceConsoleTools = unityMcpForceConsoleFirstPending || unityMcpStrictRetryPending;
                const forcedOrder = shouldForceConsoleTools
                  ? ["read_console", "set_active_instance"]
                  : [];
                const forcedTools = forcedOrder
                  .map((name) => filtered.find((tool) => tool.function.name === name))
                  .filter((tool): tool is ToolDefinition => !!tool);

                if (shouldForceConsoleTools && !forcedTools.some((tool) => tool.function.name === "read_console")) {
                  activateUnityMcpFallback("missing_required_console_tool");
                  return filtered;
                }

                if (unityMcpStrictRetryPending) {
                  return forcedTools;
                }

                const forcedSet = new Set(forcedTools.map((tool) => tool.function.name));
                const prioritizedUnityMcpTools = filtered.filter(
                  (tool) => effectiveUnityMcpToolNameSet.has(tool.function.name) && !forcedSet.has(tool.function.name),
                );

                if (forcedTools.length === 0 && prioritizedUnityMcpTools.length === 0) {
                  activateUnityMcpFallback("mcp_tools_not_exposed_for_runtime");
                  return filtered;
                }

                return [
                  ...forcedTools,
                  ...prioritizedUnityMcpTools,
                  ...filtered.filter(
                    (tool) =>
                      !forcedSet.has(tool.function.name) &&
                      !effectiveUnityMcpToolNameSet.has(tool.function.name),
                  ),
                ];
              };
        const associatedPaths = callbacks.getAssociatedPaths();
        const resolvedInstructions = config.instructionsEnabled
                ? await loadResolvedInstructions(workspace, skills, associatedPaths)
                : {
                    layers: [],
                    templates: [],
                    sources: [],
                    matchedRules: [],
                    associatedPaths: [],
                    loadedAt: Date.now(),
                    debugSummary: "Workspace instructions are disabled.",
                  };
        callbacks.onInstructionsResolved(resolvedInstructions);
        const taskTargetingEvidence = getSessionTaskTargetingEvidence(callbacks.getSessionKey());
        const emitTaskOrchestratorPhase = (phase: TaskOrchestratorPhase, extra: Record<string, unknown> = {}) => {
                logAgentEvent("task_orchestrator_phase", {
                  phase,
                  workflowMode,
                  turnIntent,
                  planApproved: callbacks.getIsPlanApproved(),
                  ...extra,
                });
              };
        const buildCurrentTaskTargetingProfile = () => buildTaskTargetingProfile({
                userPrompt: latestUserPromptText,
                planTaskTexts: callbacks.getPlanTasks().map((task) => task.text),
                associatedPaths,
                skills,
                observedEvidence: [...taskTargetingEvidence],
                userContext: turnInputContextSignals,
              });
        const initialTaskTargetingProfile = buildCurrentTaskTargetingProfile();
        emitTaskOrchestratorPhase("INTAKE_PARSE", {
        facets: initialTaskTargetingProfile.facets,
        explicitPaths: initialTaskTargetingProfile.explicitPaths.slice(0, 8),
        symbols: initialTaskTargetingProfile.symbols.slice(0, 8),
        preferredReadTools: initialTaskTargetingProfile.preferredReadTools,
        allowRootSkeleton: initialTaskTargetingProfile.allowRootSkeleton,
        imageParts: initialTaskTargetingProfile.imageParts,
        mentionedFilePaths: initialTaskTargetingProfile.mentionedFilePaths.slice(0, 6),
        attachedFilePaths: initialTaskTargetingProfile.attachedFilePaths.slice(0, 6),
        hasUserProvidedContext: initialTaskTargetingProfile.hasUserProvidedContext,
        requiresDesignProtocol: initialTaskTargetingProfile.requiresDesignProtocol,
        designProtocolSatisfied: initialTaskTargetingProfile.designProtocolSatisfied,
        });
        const hooksConfig = config.hooksEnabled
                ? await loadHooksConfig(workspace)
                : {
                    path: null,
                    hooks: {
                      SessionStart: [],
                      UserPromptSubmit: [],
                      PreToolUse: [],
                      PostToolUse: [],
                    },
                    loadedAt: Date.now(),
                  };
        callbacks.onHooksLoaded(
        Object.values(hooksConfig.hooks).flat(),
        hooksConfig.loadedAt,
        );
        const mcpToolNameSet = new Set(mcpTools.map(t => t.name));
        const skillToolNameSet = new Set(skills
                .filter(s => s.active && s.type === "tool")
                .map(s => skillNameToToolName(s.name))
                .filter(Boolean));
        let appliedSystemPromptKey = "";
        const applySystemPromptForRuntime = (runtimeIntent: ResolvedUserIntent, tools: ToolDefinition[]) => {
                const availableToolNameList = tools.map((tool) => tool.function.name);
                const webResearchPromptDate = (
                  availableToolNameList.includes("web_search") ||
                  availableToolNameList.includes("web_fetch")
                )
                  ? formatWebResearchLocalDate()
                  : "";
                const systemPromptKey = [
                  runtimeIntent,
                  workflowMode,
                  callbacks.getPreferredLanguage(),
                  webResearchPromptDate,
                  callbacks.getGameStudioConfig?.()?.engine ?? "",
                  callbacks.getGameStudioConfig?.()?.engineVersion ?? "",
                  callbacks.getCommandDirective?.()?.kind ?? "none",
                  callbacks.getCommandDirective?.()?.action ?? "",
                  mcpPriorityEngine ?? "",
                  gameStudioMcpFirstEligible ? "game-studio-mcp-first" : "",
                  unityMcpFirstPhaseActive ? "unity-mcp-first" : "",
                  unityConsoleDiagnosticsRequested ? "unity-console-first" : "",
                  config.activeProfile,
                  settings.provider || "",
                  settings.model || "",
                  modelProtocolProfile.providerFamily,
                  modelProtocolProfile.reasoning,
                  modelProtocolProfile.notes.join(","),
                  availableToolNameList.join(","),
                ].join("|");
                if (systemPromptKey === appliedSystemPromptKey) return;

                const mcpToolNames = availableToolNameList.filter((name) => mcpToolNameSet.has(name));
                const customToolNames = availableToolNameList.filter((name) => skillToolNameSet.has(name));
                const systemPrompt = buildSystemPrompt(
                  skills,
                  workspace,
                  mainModeKey,
                  workspaceTree,
                  customToolNames,
                  mcpToolNames,
                  workflowMode,
                  callbacks.getPreferredLanguage(),
                  resolvedInstructions,
                  {
                    initialized: callbacks.getGameStudioInitialized(),
                    activeStudioAgentKey: callbacks.getActiveStudioAgentKey(),
                    pendingSlashCommand: callbacks.getPendingSlashCommand(),
                    studioConfig: callbacks.getGameStudioConfig?.() ?? null,
                  },
                  runtimeIntent,
                  config.promptLanguageStrategy,
                  availableToolNameList,
                  callbacks.getCommandDirective?.() ?? null,
                  {
                    gameStudioMcpFirst: !!mcpPriorityEngine && (
                      mcpPriorityEngine === "unity" ? unityMcpFirstPhaseActive : gameStudioMcpFirstEligible
                    ),
                    unityMcpFirst: unityMcpFirstPhaseActive,
                    engine: mcpPriorityEngine,
                    unityConsoleFirst: unityMcpFirstPhaseActive && unityConsoleDiagnosticsRequested,
                    connectedServerNames: mcpServerStatuses
                      .filter((status) =>
                        status.status === "connected" &&
                        !!mcpPriorityEngine &&
                        (
                          preferredGameStudioMcpServerUrls.length > 0
                            ? isGameEngineLikelyServer({ name: status.serverName, url: status.url }, mcpPriorityEngine)
                            : connectedMcpServerUrls.has(status.url)
                        )
                      )
                      .map((status) => status.serverName),
                  },
                  {
                    displayLanguage: config.language,
                    resolvedResponseLanguage: callbacks.getPreferredLanguage(),
                  },
                  {
                    activeProfile: config.activeProfile,
                    provider: settings.provider,
                    model: settings.model,
                    toolProtocol: effectiveToolProtocol,
                    nativeToolsEnabled: !shouldUseXmlToolProtocol(
                      config,
                      settings,
                      callbacks.getMessages(),
                      compatibilityForcedAtStart,
                    ),
                    modelProtocolNotes: modelProtocolProfile.notes,
                  },
                );
                const currentMessages = callbacks.getMessages();
                if (currentMessages.length === 0) {
                  callbacks.appendMessage({ role: "system", content: systemPrompt });
                } else if (currentMessages[0].role === "system") {
                  const refreshed = [...currentMessages];
                  refreshed[0] = { ...refreshed[0], content: systemPrompt };
                  callbacks.replaceMessages(refreshed);
                } else {
                  callbacks.replaceMessages([{ role: "system", content: systemPrompt }, ...currentMessages]);
                }
                appliedSystemPromptKey = systemPromptKey;
                logAgentEvent("tool_protocol_card_applied", {
                  runtimeIntent,
                  workflowMode,
                  activeProfile: config.activeProfile,
                  provider: settings.provider || "unknown",
                  toolProtocol: effectiveToolProtocol,
                  nativeToolsEnabled: !shouldUseXmlToolProtocol(
                    config,
                    settings,
                    callbacks.getMessages(),
                    compatibilityForcedAtStart,
                  ),
                  availableTools: availableToolNameList.length,
                  mcpTools: mcpToolNames.length,
                  toolSchemaChars: JSON.stringify(tools).length,
                });
              };
        const initialRuntimeIntent = resolveRuntimeIntent();
        // ── Model Probe (async, non-blocking) ─────────────────────
        // Probe the model at turn start to detect instruction language,
        // quantization state, and capability level. Results are cached
        // for subsequent turns. If the probe fails or times out,
        // heuristic fallback is used by detectInstructionLanguage.
        if (settings.model && settings.provider && settings.baseUrl) {
          const probeRunner = createProbeRunner(
            settings.provider,
            settings.model,
            settings.baseUrl,
            settings.apiKey ?? "",
          );
          // Fire-and-forget: probe runs in background, caches results
          setTimeout(() => {
            runModelProbe(probeRunner, settings.model!, settings.provider!)
              .then(() => {
                // Results are already cached inside runModelProbe
              })
              .catch(() => {
                // Probe failed; heuristic will be used
              });
          }, 0);
        }

        applySystemPromptForRuntime(initialRuntimeIntent, resolveAllToolsForRuntime(initialRuntimeIntent));
        if (config.hooksEnabled) {
        const sessionKey = callbacks.getSessionKey();
        if (!callbacks.hasSessionHookInitialized(sessionKey)) {
          const sessionHookResult = await runLifecycleHooks(
            callbacks,
            hooksConfig,
            "SessionStart",
            {
              workspace,
              workflowMode,
              language: callbacks.getPreferredLanguage(),
              sessionKey,
            },
          );
          createHookContextMessages("SessionStart", sessionHookResult.additionalContexts)
            .forEach(message => callbacks.appendMessage(message));
          callbacks.markSessionHookInitialized(sessionKey);
          if (sessionHookResult.blocked) {
            callbacks.onStatusChange("idle");
            return;
          }
        }

        const lastUserMessage = [...callbacks.getMessages()]
          .reverse()
          .find(message => message.role === "user");
        const userPrompt = lastUserMessage ? extractCompatibilityTextContent(lastUserMessage.content) : "";
        const promptHookResult = await runLifecycleHooks(
          callbacks,
          hooksConfig,
          "UserPromptSubmit",
          {
            workspace,
            workflowMode,
            language: callbacks.getPreferredLanguage(),
            prompt: userPrompt,
            associatedPaths,
          },
        );

        createHookContextMessages("UserPromptSubmit", promptHookResult.additionalContexts)
          .forEach(message => callbacks.appendMessage(message));
        if (promptHookResult.blocked) {
          callbacks.onStatusChange("idle");
          return;
        }
        }

        callbacks.onStatusChange("running");
        let iteration = 0;
        let consecutiveNoToolCount = 0;
        let consecutiveEmptyResponseCount = 0;
        let emptyResponseCountThisTurn = 0;
        let consecutiveReasoningDominatedCount = 0;
        let usedMaxStepsFinalTextPrompt = false;
        let chatFinalSynthesisActive = false;
        let chatFinalSynthesisReason = "";
        let usedChatFinalSynthesisPrompt = false;
        let currentMaxTokens: number | undefined;
        const getMaxOutputEscalations = () =>
                workflowMode === "plan" && !callbacks.getIsPlanApproved()
                  ? 0
                  : 2;
        let loggedLocalPlanNoVisibleTokenNoticeOnly = false;
        const getPlanStreamWatchdogOptions = (nativeToolCount: number): FetchLLMStreamOptions | undefined => {
                const watchdogEnabled = shouldUsePlanNoVisibleTokenWatchdog({
                  workflowMode,
                  isPlanApproved: callbacks.getIsPlanApproved(),
                  nativeToolCount,
                  activeProfile: config.activeProfile,
                  provider: settings.provider,
                  toolProtocol: effectiveToolProtocol,
                });

                if (
                  !watchdogEnabled &&
                  !loggedLocalPlanNoVisibleTokenNoticeOnly &&
                  workflowMode === "plan" &&
                  !callbacks.getIsPlanApproved() &&
                  nativeToolCount === 0 &&
                  config.activeProfile === "local"
                ) {
                  loggedLocalPlanNoVisibleTokenNoticeOnly = true;
                  logAgentEvent("plan_no_visible_token_notice_only", {
                    activeProfile: config.activeProfile,
                    provider: settings.provider || "unknown",
                    toolProtocol: effectiveToolProtocol,
                    workflowMode,
                    turnIntent,
                  });
                }

                return watchdogEnabled
                  ? {
                      noVisibleTokenTimeoutMs: PLAN_NO_VISIBLE_TOKEN_TIMEOUT_MS,
                      noVisibleTokenTimeoutLabel: `${workflowMode}:preapproval_xml_tools`,
                    }
                  : undefined;
              };
        let sawPlanModeToolActivity = false;
        let usedPlanRecoveryPrompt = false;
        let usedToolUnavailableRecoveryPrompt = false;
        let usedPseudoToolCallRecoveryPrompt = false;
        let usedMalformedToolUseRecoveryPrompt = false;
        let usedLanguageMismatchRecoveryPrompt = false;
        let usedExecuteConvergencePrompt = false;
        let usedPlanClosureGuard = false;
        let usedPlanClosurePrompt = false;
        let usedPlanReadOnlyConvergencePrompt = false;
        let planPostConvergenceToolRedirectCount = 0;
        // P1 improvement: use a function-scoped mutable plan phase to avoid TS narrowing.
        function initialPlanPhase(): PlanRuntimePhase {
          return workflowMode === "plan" && !callbacks.getIsPlanApproved()
            ? "explore_structure"
            : "grounding";
        }
        let planRuntimePhase: PlanRuntimePhase = initialPlanPhase();
        let planQualityRejectCount = 0;
        let planLastQualityGateReason = "";
        let planLastMissingSections: string[] = [];
        let planEvidenceRecoveryPasses = 0;
        let planReasoningOnlyRecoveryPasses = 0;
        let planAutoScaffoldPromptIssued = false;
        // P1 improvement: track how many recovery reads the model has used during drafting.
        let planDraftingRecoveryReadCount = 0;
        let planClosureEvidenceRecoveryIssued = false;
        let usedReadOnlyPermissionHardRecoveryPrompt = false;
        let planReadOnlyConvergenceBatches = 0;
        let planReadOnlyConvergenceTools = 0;
        const attemptedPlanWriteTargets: string[] = [];
        let recentSuccessfulProjectWrite: { name: string; target: string } | null = null;
        let sawExecuteOperationEvidence = false;
        let recoveringFromEmptyAssistantReplyAfterWrite = false;
        let lastAssistantTextForCheckpoint = "";
        const recentPlanToolActivity: PlanToolActivitySummary[] = [];
        const recentToolActivity: PlanToolActivitySummary[] = [];
        const successfulEditTargetsSinceVerification = new Map<string, number>();
        let lastNoProgressBatchSignature = "";
        let noProgressBatchRepeatCount = 0;
        let approvedPlanNoProgressRecoveryAttempts = 0;
        let approvedPlanActionOnlyRecoveryActive = false;
        let approvedPlanNoToolRecoveryFileReadActive = false;
        let repeatedEditValidationRecoveryAttempts = 0;
        let executeRecoveryMode: ExecuteRecoveryMode = workflowMode === "edit"
                  ? normalizeExecuteRecoveryMode(callbacks.getForcedExecuteRecoveryMode?.())
                  : "normal";
        let executeRecoveryReason = executeRecoveryMode === "normal" ? "" : "forced_execute_recovery";
        let executeRecoveryAttempts = executeRecoveryMode === "normal" ? 0 : 1;
        const activateExecuteRecovery = (
                mode: Exclude<ExecuteRecoveryMode, "normal">,
                reason: string,
                context: Record<string, unknown> = {},
              ) => {
                const normalizedMode = normalizeExecuteRecoveryMode(mode) as Exclude<ExecuteRecoveryMode, "normal">;
                executeRecoveryAttempts += 1;
                executeRecoveryMode = normalizedMode;
                executeRecoveryReason = reason;
                logAgentEvent("execute_recovery_activated", {
                  iteration,
                  executeRecoveryMode,
                  executeRecoveryAttempts,
                  reason,
                  recoveryToolSurface: describeExecuteRecoveryToolSurface(
                    executeRecoveryMode,
                    shouldAllowExecuteRecoveryFileRead(recentToolActivity),
                  ),
                  ...context,
                });
              };
        const activateChatFinalSynthesis = (
                reason: string,
                context: Record<string, unknown> = {},
              ) => {
                if (chatFinalSynthesisActive) return;
                chatFinalSynthesisActive = true;
                chatFinalSynthesisReason = reason || "chat_final_synthesis";
                currentMaxTokens = Math.min(currentMaxTokens ?? 2048, 2048);
                logAgentEvent("chat_final_synthesis_activated", {
                  iteration,
                  reason: chatFinalSynthesisReason,
                  recentToolActivity: recentToolActivity.length,
                  repeatedTargets: summarizeRepeatedExecuteTargets(recentToolActivity.slice(-12)),
                  ...context,
                });
              };
        const clearExecuteRecovery = (reason: string) => {
                if (executeRecoveryMode === "normal") return;
                logAgentEvent("execute_recovery_cleared", {
                  iteration,
                  previousMode: executeRecoveryMode,
                  executeRecoveryAttempts,
                  reason,
                });
                executeRecoveryMode = "normal";
                executeRecoveryReason = "";
                executeRecoveryAttempts = 0;
              };
        const rememberToolActivity = (targetList: PlanToolActivitySummary[], result: ToolExecutionResult) => {
                if (result.internalFeedback) return;
                const rawDetail = result.displayContent || result.content || "";
                const planEvidenceDetail = summarizePlanEvidenceDetail({
                  tool: result.name,
                  target: result.target,
                  content: rawDetail,
                  maxChars: 220,
                });
                const detail = planEvidenceDetail || (/\bREAD_FILE_RESULT\b/i.test(rawDetail) ? "" : truncateForLog(rawDetail, 120));
                targetList.push({
                  name: result.name,
                  target: result.target,
                  status: result.isError ? "failed" : "succeeded",
                  ...(detail ? { detail } : {}),
                });
                if (targetList.length > MAX_RECENT_PLAN_TOOL_ACTIVITY) {
                  targetList.splice(0, targetList.length - MAX_RECENT_PLAN_TOOL_ACTIVITY);
                }
              };
        const rememberPlanToolActivity = (result: ToolExecutionResult) => rememberToolActivity(recentPlanToolActivity, result);
        const rememberAnyToolActivity = (result: ToolExecutionResult) => rememberToolActivity(recentToolActivity, result);
        const normalizeLoopGuardTarget = (target: string) => String(target || "")
                .replace(/^shell-write:/, "")
                .replace(/\\/g, "/")
                .replace(/\s+/g, " ")
                .trim()
                .toLowerCase();
        const isEditProgressResult = (result: ToolExecutionResult) =>
                EDIT_PROGRESS_TOOL_NAMES.has(result.name) || String(result.target || "").startsWith("shell-write:");
        const isVerificationEvidenceResult = (result: ToolExecutionResult) =>
                !result.isError &&
                !result.internalFeedback &&
                EXECUTION_VERIFICATION_TOOL_NAMES.has(result.name);
        const setPlanRuntimePhase = (
                phase: PlanRuntimePhase,
                reason?: string,
                status: "pending" | "running" | "done" | "failed" = "running",
              ) => {
                if (workflowMode !== "plan" || callbacks.getIsPlanApproved()) return;
                if (planRuntimePhase === phase && !reason) return;
                planRuntimePhase = phase;
                const presentation = planRuntimePhasePresentation(phase, callbacks.getPreferredLanguage(), reason);
                callbacks.onTurnRuntimePhaseChanged?.({
                  id: `plan_${phase}`,
                  kind: presentation.kind,
                  title: presentation.title,
                  summary: presentation.summary,
                  domain: "plan_runtime",
                  status,
                });
                logAgentEvent("plan_runtime_phase_changed", {
                  phase,
                  reason: reason || "",
                  iteration,
                  qualityRejectCount: planQualityRejectCount,
                  missingSections: planLastMissingSections,
                });
              };
        const recentToolCalls: Array<{ name: string; argsKey: string }> = [];
        const recentTargetToolCalls: Array<{ name: string; targetKey: string; family: "edit" | "verify" | "other" }> = [];
        const repeatGuardRecoveredSignatures = new Set<string>();
        const targetProgressGuardRecoveredSignatures = new Set<string>();
        const failedToolCallCounts = new Map<string, number>();
        const readOnlyResultCache = new Map<string, CachedReadOnlyToolResult>();
        const approvedPlanBrowserValidationCache = new Map<string, ToolExecutionResult>();
        const readOnlyDuplicateSkipCounts = new Map<string, number>();
        const fileReadStates = getSessionFileReadStates(callbacks.getSessionKey());

        async function waitForPlanApprovalIfNeeded(): Promise<boolean> {
            if (workflowMode !== "plan") return true;
            if (callbacks.getIsPlanApproved()) return true;
            callbacks.onStatusChange("pending_review");
            return new Promise<boolean>((resolve) => {
              const checkInterval = setInterval(() => {
                if (abortController.signal.aborted) {
                  clearInterval(checkInterval);
                  resolve(false);
                  return;
                }
                if (callbacks.getIsPlanApproved()) {
                  clearInterval(checkInterval);
                  resolve(true);
                }
              }, 300);
            });
        }

        async function pauseForReviewablePlanArtifact(trigger: string): Promise<"not_reviewable" | "stopped" | "approved_continue"> {
            if (workflowMode !== "plan" || callbacks.getIsPlanApproved()) return "not_reviewable";
            const stage = callbacks.getPlanStage();
            if (!isReviewablePlanStage(stage)) return "not_reviewable";
            const language = callbacks.getPreferredLanguage();
            logAgentEvent("plan_review_ready_after_tool", {
              trigger,
              iteration,
              planStage: stage,
              isPlanApproved: callbacks.getIsPlanApproved(),
              statusBeforeReview: callbacks.getStatus(),
            });
            if (stage === "design") {
              logAgentEvent("plan_design_review_ready_after_tool", {
                trigger,
                iteration,
                planStage: stage,
                isPlanApproved: callbacks.getIsPlanApproved(),
                statusBeforeReview: callbacks.getStatus(),
              });
            }

            setPlanRuntimePhase("review_ready", "quality gate accepted", "done");
            callbacks.onAssistantFinalText(buildPlanReviewReadyMessage(language, stage));
            const approved = await waitForPlanApprovalIfNeeded();
            if (!approved) {
              if (callbacks.getStatus() !== "pending_review") {
                callbacks.onStatusChange("idle");
              }
              return "stopped";
            }

            callbacks.onPlanStageChanged("executing");
            approvedPlanActionOnlyRecoveryActive = false;
            approvedPlanNoProgressRecoveryAttempts = 0;
            const continuationPrompt = buildApprovedPlanContinuationPrompt(callbacks);
            if (callbacks.onApprovedPlanHandoff) {
              callbacks.onApprovedPlanHandoff(continuationPrompt);
              callbacks.onStatusChange("idle");
              return "stopped";
            }

            callbacks.appendMessage({
              role: "user",
              content: continuationPrompt,
            });
            return "approved_continue";
        }

        const buildPlanClosureEvidenceRecoveryPrompt = (reason: string): string => {
                const language = callbacks.getPreferredLanguage();
                if (language === "en") {
                  return [
                    "PLAN_CLOSURE_NEEDS_EVIDENCE: MAIN could not get a model-authored reviewable plan from the current clean evidence.",
                    reason ? `Failure reason: ${reason}.` : "",
                    "Do exactly one targeted read/search for the missing source or data fact. Prefer the specific file, symbol, or dataset already implicated by the user request.",
                    "After that single tool result, stop exploring and write `.MAIN/plans/plan.md`; if write tools are unavailable, produce a concise visible `<proposed_plan>`.",
                    "Do not call broad directory scans, do not edit source files, and do not create `tasks.md` before approval.",
                  ].filter(Boolean).join("\n");
                }
                return [
                  "PLAN_CLOSURE_NEEDS_EVIDENCE: MAIN 无法基于当前干净证据拿到模型亲自生成的可审批计划。",
                  reason ? `失败原因：${reason}。` : "",
                  "下一步只做一次定向读取/搜索，补齐缺失的源码或数据事实。优先读取用户目标已经指向的具体文件、符号或数据集。",
                  "拿到这一次工具结果后，停止探索并写入 `.MAIN/plans/plan.md`；如果写入工具不可用，输出精简可见 `<proposed_plan>`。",
                  "不要再泛扫目录；批准前不要修改源码，也不要创建 `tasks.md`。",
                ].filter(Boolean).join("\n");
              };

        async function tryClosePlanWithEvidence(trigger: string, details: {
            consecutiveEmptyResponseCount?: number;
            rejectedVisibleChars?: number;
            toolCallCount?: number;
            replyOptionCount?: number;
            } = {}): Promise<"not_attempted" | "failed" | "stopped" | "approved_continue"> {
            const closureInput = collectPlanClosureMaterializationInput(
                      callbacks,
                      recentPlanToolActivity,
                      attemptedPlanWriteTargets,
                      latestUserPromptText,
                    );
            const evidenceCount = closureInput.evidence.length;
            const currentStage = callbacks.getPlanStage();
            const hasReviewablePlanArtifacts = isReviewablePlanStage(currentStage);
            const closureKind = resolvePlanClosureArtifactKind(closureInput, currentStage, recentPlanToolActivity);
            const targetPath = closureKind === "design" ? ".MAIN/plans/design.md" : ".MAIN/plans/plan.md";
            const shouldAttempt = shouldAttemptPlanClosureGuard({
                      workflowMode,
                      isPlanApproved: callbacks.getIsPlanApproved(),
                      hasReviewablePlanArtifacts,
                      evidenceCount,
                      usedPlanRecoveryPrompt,
                      ...details,
                    });
            if (!shouldAttempt) return "not_attempted";
            if (usedPlanClosureGuard) {
              logAgentEvent("plan_closure_artifact_rejected", {
                trigger,
                iteration,
                reason: "closure_prompt_already_used_fallback_disabled",
                evidenceCount,
                targetPath,
              });
              return "failed";
            }

            logAgentEvent("plan_closure_guard_start", {
              trigger,
              iteration,
              evidenceCount,
              structuredEvidenceCount: closureInput.evidenceRecords.length,
              fileCount: closureInput.files.length,
              constraintCount: closureInput.constraints.length,
              targetPath,
              closureKind,
              userGoalPreview: compactDiagnosticText(closureInput.userGoal, 160),
              planStage: currentStage,
            });
            if (!usedPlanClosurePrompt) {
              usedPlanClosureGuard = true;
              usedPlanClosurePrompt = true;
              setPlanRuntimePhase("drafting", `${closureKind} closure prompt ready`);
              const prompt = composeReviewablePlanFromEvidence({
                ...closureInput,
                kind: closureKind,
                language: callbacks.getPreferredLanguage(),
              });
              logAgentEvent("plan_closure_prompt", {
                trigger,
                iteration,
                evidenceCount,
                structuredEvidenceCount: closureInput.evidenceRecords.length,
                fileCount: closureInput.files.length,
                targetPath,
              });
              if (closureKind === "design") {
                logAgentEvent("plan_design_closure_prompt", {
                  trigger,
                  iteration,
                  evidenceCount,
                  fileCount: closureInput.files.length,
                  targetPath,
                });
              }
              callbacks.onStatusChange("running");
              callbacks.appendMessage({
                role: "user",
                content: prompt,
              });
              return "approved_continue";
            }

            return "failed";
        }

        const agentLoopConfig = config as AppConfig & {
                agentLoop?: { iterationLimits?: AgentLoopIterationLimits | null } | null;
              };
        const effectiveMaxIterations = resolveAgentLoopMaxIterations({
                workflowMode,
                runtimeIntent: resolveRuntimeIntent(),
                isPlanApproved: callbacks.getIsPlanApproved(),
                limits: agentLoopConfig.agentLoop?.iterationLimits ?? null,
              });
        const emitPlanExecutionProgress = (
                phase: PlanExecutionProgressPhase,
                overrides: Partial<PlanExecutionProgressUpdate> = {},
              ) => {
                if (workflowMode !== "plan" || !callbacks.getIsPlanApproved() || !callbacks.onPlanExecutionProgress) return;
                callbacks.onPlanExecutionProgress({
                  ...buildPlanExecutionProgressUpdate({
                    language: callbacks.getPreferredLanguage(),
                    phase,
                    iterationCount: iteration,
                    maxIterations: effectiveMaxIterations,
                    autoResumeCount: callbacks.getPlanAutoResumeCount?.() ?? 0,
                    tasks: callbacks.getPlanTasks(),
                    evidenceLedger: callbacks.getPlanExecutionEvidenceLedger(),
                    recentToolActivity: recentPlanToolActivity,
                  }),
                  ...overrides,
                });
              };
        const pauseApprovedPlanNoProgressLoop = (input: {
                reason: string;
                repeats: number;
                remainingText?: string;
                logContext?: Record<string, unknown>;
              }) => {
                const language = callbacks.getPreferredLanguage();
                const repeatedTargets = summarizeRepeatedPlanTargetsFromToolActivity(recentPlanToolActivity);
                const progressSignature = buildPlanProgressSignatureFromToolActivity(recentPlanToolActivity);
                const nextStep = language === "zh"
                  ? "换目标、改为写入/命令/浏览器验证，或说明真实阻塞"
                  : "switch target, patch/run/browser-verify, or state the real blocker";
                const pauseNotice = buildPlanNoProgressLoopPauseNotice({
                  language,
                  repeats: Math.max(1, input.repeats),
                  remainingTask: input.remainingText,
                  evidenceLedger: callbacks.getPlanExecutionEvidenceLedger(),
                  recentToolActivity: recentPlanToolActivity,
                  repeatedTargets,
                });

                logAgentEvent("loop_stop", {
                  reason: input.reason,
                  iteration,
                  repeats: Math.max(1, input.repeats),
                  repeatedTargets,
                  progressSignature: truncateForLog(progressSignature, 220),
                  ...(input.logContext || {}),
                });
                emitTaskOrchestratorPhase("PAUSED", {
                  reason: input.reason,
                  iteration,
                  repeats: Math.max(1, input.repeats),
                  remainingTask: input.remainingText || "",
                  repeatedTargets,
                });
                emitPlanExecutionProgress("paused", {
                  progressSignature,
                  repeatedTargets,
                  recoveryReason: input.reason,
                  nextStep,
                });
                callbacks.onNonActionableStop(
                  pauseNotice,
                  "no_action",
                  {
                    progressSignature,
                    repeatedTargets,
                    recoveryReason: input.reason,
                    nextStep,
                  },
                );
                callbacks.onStatusChange("idle");
              };
        const pauseApprovedPlanStreamWatchdog = (
                message: string,
                logContext?: Record<string, unknown>,
              ): boolean => {
                if (workflowMode !== "plan" || !callbacks.getIsPlanApproved() || !isStreamWatchdogTimeoutMessage(message)) {
                  return false;
                }

                const language = callbacks.getPreferredLanguage();
                const repeatedTargets = summarizeRepeatedPlanTargetsFromToolActivity(recentPlanToolActivity);
                const progressSignature = buildPlanProgressSignatureFromToolActivity(recentPlanToolActivity);
                const nextStep = language === "zh"
                  ? "恢复后直接调用真实工具执行下一项计划任务，或说明具体阻塞"
                  : "resume by calling real tools for the next plan task, or state the concrete blocker";
                const pauseNotice = language === "zh"
                  ? [
                      "执行已暂停：模型持续返回流式内容，但没有产生可见说明或工具调用。",
                      "MAIN 已保留当前 workspace 状态，没有把这次不可见输出当作执行失败。",
                      `最近工具目标：${repeatedTargets.length > 0 ? repeatedTargets.join("、") : "未定位到单一目标"}`,
                      `建议恢复动作：${nextStep}。`,
                    ].join("\n")
                  : [
                      "Execution paused: the model kept streaming content but produced no visible explanation or tool call.",
                      "MAIN kept the current workspace state and did not treat this invisible-output stall as an execution failure.",
                      `Recent targets: ${repeatedTargets.length > 0 ? repeatedTargets.join(", ") : "no single target identified"}`,
                      `Suggested recovery: ${nextStep}.`,
                    ].join("\n");

                logAgentEvent("approved_plan_stream_watchdog_paused", {
                  iteration,
                  message: message.slice(0, 240),
                  progressSignature: truncateForLog(progressSignature, 220),
                  repeatedTargets,
                  ...(logContext || {}),
                });
                emitTaskOrchestratorPhase("PAUSED", {
                  reason: "stream_no_visible_progress_timeout",
                  iteration,
                  repeatedTargets,
                });
                emitPlanExecutionProgress("paused", {
                  progressSignature,
                  repeatedTargets,
                  recoveryReason: "stream_no_visible_progress_timeout",
                  nextStep,
                });
                callbacks.onNonActionableStop(
                  pauseNotice,
                  "no_output",
                  {
                    progressSignature,
                    repeatedTargets,
                    recoveryReason: "stream_no_visible_progress_timeout",
                    nextStep,
                  },
                );
                callbacks.onStatusChange("idle");
                return true;
              };
        const continueApprovedPlanWithStrategySwitch = (input: {
                reason: string;
                remainingText: string;
                logContext?: Record<string, unknown>;
              }) => {
                const language = callbacks.getPreferredLanguage();
                const repeatedTargets = summarizeRepeatedPlanTargetsFromToolActivity(recentPlanToolActivity);
                const progressSignature = buildPlanProgressSignatureFromToolActivity(recentPlanToolActivity);
                const allowFileRead = shouldAllowApprovedPlanRecoveryFileRead(recentPlanToolActivity);
                approvedPlanNoProgressRecoveryAttempts += 1;
                approvedPlanActionOnlyRecoveryActive = true;
                logAgentEvent("plan_execution_strategy_switch_reprompt", {
                  reason: input.reason,
                  iteration,
                  attempts: approvedPlanNoProgressRecoveryAttempts,
                  repeatedTargets,
                  progressSignature: truncateForLog(progressSignature, 220),
                  recoveryToolSurface: describeApprovedPlanRecoveryToolSurface(allowFileRead),
                  ...(input.logContext || {}),
                });
                emitTaskOrchestratorPhase("EXECUTE_STEP", {
                  reason: input.reason,
                  iteration,
                  attempts: approvedPlanNoProgressRecoveryAttempts,
                  repeatedTargets,
                });
                emitPlanExecutionProgress("running", {
                  progressSignature,
                  repeatedTargets,
                  recoveryReason: input.reason,
                  nextStep: language === "zh"
                    ? "下一轮保留行动工具和定向恢复读取；避免重复缓存目标，优先写入/命令/浏览器验证"
                    : "next turn keeps action tools and targeted recovery reads; avoid cached rereads and prioritize patching, commands, or browser validation",
                });
                callbacks.onStatusChange("running");
                callbacks.appendMessage({
                  role: "user",
                  content: buildApprovedPlanNoProgressStrategySwitchPrompt({
                    language,
                    remainingText: input.remainingText,
                    repeatedTargets,
                    recentToolActivity: recentPlanToolActivity,
                    allowFileRead,
                  }),
                });
              };
        const loopStartRuntimeIntent = resolveRuntimeIntent();
        const loopStartTools = resolveAllToolsForRuntime(loopStartRuntimeIntent);
        logAgentEvent("loop_start", {
        workflowMode,
        turnIntent,
        runtimeIntent: loopStartRuntimeIntent,
        messagesLen: callbacks.getMessages().length,
        allTools: loopStartTools.length,
        mcpTools: mcpTools.length,
        builtinAndSkillTools: Math.max(0, loopStartTools.length - mcpTools.length),
        activeProfile: config.activeProfile,
        provider: settings.provider || "unknown",
        maxIterations: effectiveMaxIterations,
        iterationLimitSource: {
          chatRespond: agentLoopConfig.agentLoop?.iterationLimits?.chatRespond ?? null,
          editExecute: agentLoopConfig.agentLoop?.iterationLimits?.editExecute ?? null,
          planDraft: agentLoopConfig.agentLoop?.iterationLimits?.planDraft ?? null,
          planExecution: agentLoopConfig.agentLoop?.iterationLimits?.planExecution ?? null,
        },
        nativeToolsEnabled: !shouldUseXmlToolProtocol(
          config,
          settings,
          callbacks.getMessages(),
          callbacks.shouldForceXmlForProviderCompatibility?.(),
        ),
        toolProtocol: effectiveToolProtocol,
        xmlToolsEnabled: true,
        unityMcpFirstPhaseActive,
        unityMcpFallbackReason,
        maxOutputEscalations: getMaxOutputEscalations(),
        });
        emitPlanExecutionProgress("starting");
        if (workflowMode === "plan" && !callbacks.getIsPlanApproved()) {
        setPlanRuntimePhase("explore_structure", "start");
        }

        while (iteration < effectiveMaxIterations) {
        iteration++;
        emitPlanExecutionProgress("running");

        if (abortController.signal.aborted) {
          callbacks.onStatusChange("idle");
          return;
        }

        // Keep a persistent thread container linked to the session
        if (!(this as any)._thread || (this as any)._thread.threadId !== eventThreadId) {
          (this as any)._thread = createThread(eventThreadId);
        }
        const thread = (this as any)._thread;
        const turn = createTurn(eventTurnId + `-${iteration}`, callbacks.getMessages());
        thread.turns.push(turn);
        const turnContext = new TurnContext(turn);
        turnContext.startTurn();

        // ── Pre-LLM Turn Preparation ──
        callbacks.startNewTurn();
        const runtimeIntent = resolveRuntimeIntent();
        const finalTextOnlyStep = shouldUseMaxStepsFinalTextOnly({
          workflowMode,
          runtimeIntent,
          isPlanApproved: callbacks.getIsPlanApproved(),
          iteration,
          maxIterations: effectiveMaxIterations,
          alreadyPrompted: usedMaxStepsFinalTextPrompt,
        });
        if (finalTextOnlyStep) {
          usedMaxStepsFinalTextPrompt = true;
          logAgentEvent("max_steps_final_text_prompt", {
            iteration,
            maxIterations: effectiveMaxIterations,
            workflowMode,
            runtimeIntent,
            repeatedTargets: summarizeRepeatedExecuteTargets(recentToolActivity.slice(-12)),
          });
        }
        const rawIterationAllTools = finalTextOnlyStep || chatFinalSynthesisActive
          ? []
          : resolveAllToolsForRuntime(runtimeIntent);
        const allowApprovedPlanRecoveryFileRead =
          approvedPlanNoToolRecoveryFileReadActive ||
          shouldAllowApprovedPlanRecoveryFileRead(recentPlanToolActivity);
        const isExecuteRecoveryEligible =
          (workflowMode === "edit" || (workflowMode === "plan" && callbacks.getIsPlanApproved())) &&
          runtimeIntent === "execute" &&
          executeRecoveryMode !== "normal";
        const allowExecuteRecoveryFileRead = shouldAllowExecuteRecoveryFileRead(recentToolActivity);
        const effectiveExecuteRecoveryFileRead =
          executeRecoveryMode === "patch_recovery_read" || allowExecuteRecoveryFileRead;
        const recoveryIterationAllTools = isExecuteRecoveryEligible
          ? rawIterationAllTools.filter((tool) => isExecuteRecoveryToolName(
              tool.function.name,
              PLAN_EXPLORATION_READ_ONLY_TOOLS,
              {
                mode: executeRecoveryMode,
                allowFileRead: allowExecuteRecoveryFileRead,
              },
            ))
          : rawIterationAllTools;
        if (isExecuteRecoveryEligible && recoveryIterationAllTools.length !== rawIterationAllTools.length) {
          logAgentEvent("execute_recovery_tool_scope_applied", {
            iteration,
            executeRecoveryMode,
            executeRecoveryReason,
            executeRecoveryAttempts,
            allowFileRead: effectiveExecuteRecoveryFileRead,
            adaptiveFileReadAllowed: allowExecuteRecoveryFileRead,
            recoveryToolSurface: describeExecuteRecoveryToolSurface(executeRecoveryMode, effectiveExecuteRecoveryFileRead),
            rawTools: rawIterationAllTools.map((tool) => tool.function.name).slice(0, 24),
            scopedTools: recoveryIterationAllTools.map((tool) => tool.function.name),
            removedToolCount: Math.max(0, rawIterationAllTools.length - recoveryIterationAllTools.length),
          });
        }
        const approvedPlanSourceEditFirstActive =
          workflowMode === "plan" &&
          callbacks.getIsPlanApproved() &&
          approvedPlanNeedsSourceEditBeforeValidation(
            callbacks.getPlanTasks(),
            callbacks.getPlanExecutionEvidenceLedger(),
          );
        const baseIterationAllTools =
          approvedPlanSourceEditFirstActive
            ? recoveryIterationAllTools.filter((tool) => isApprovedPlanSourceEditFirstTool(tool, {
                allowFileRead: allowApprovedPlanRecoveryFileRead,
              }))
            : approvedPlanActionOnlyRecoveryActive &&
              workflowMode === "plan" &&
              callbacks.getIsPlanApproved()
            ? recoveryIterationAllTools.filter((tool) => isApprovedPlanRecoveryTool(tool, {
                allowFileRead: allowApprovedPlanRecoveryFileRead,
              }))
            : recoveryIterationAllTools;
        if (approvedPlanSourceEditFirstActive && baseIterationAllTools.length !== recoveryIterationAllTools.length) {
          logAgentEvent("approved_plan_source_edit_first_tool_scope_applied", {
            iteration,
            allowFileRead: allowApprovedPlanRecoveryFileRead,
            recoveryToolSurface: describeApprovedPlanSourceEditFirstToolSurface(allowApprovedPlanRecoveryFileRead),
            rawTools: recoveryIterationAllTools.map((tool) => tool.function.name).slice(0, 24),
            scopedTools: baseIterationAllTools.map((tool) => tool.function.name),
            removedToolCount: Math.max(0, recoveryIterationAllTools.length - baseIterationAllTools.length),
            taskCount: callbacks.getPlanTasks().length,
            evidenceCount: callbacks.getPlanExecutionEvidenceLedger().length,
          });
        }
        // P1 improvement: allow one controlled recovery read during drafting
        // to prevent wasteful drafting→needs_evidence→drafting redirects.
        const allowDraftingRecoveryRead =
          workflowMode === "plan" &&
          !callbacks.getIsPlanApproved() &&
          planRuntimePhase === "drafting" &&
          planDraftingRecoveryReadCount < 1;
        const phaseScopedIterationAllTools = filterPlanRuntimeToolDefinitionsForPhase({
          tools: baseIterationAllTools,
          workflowMode,
          isPlanApproved: callbacks.getIsPlanApproved(),
          planRuntimePhase,
          allowDraftingRecoveryRead,
        });
        const shouldClosePlanToolSurface = shouldClosePlanToolSurfaceAfterReadOnlyConvergence({
          workflowMode,
          isPlanApproved: callbacks.getIsPlanApproved(),
          convergencePromptAlreadyUsed: usedPlanReadOnlyConvergencePrompt,
          planRuntimePhase,
          evidenceReadiness: assessPlanEvidenceReadiness({
            userContext: turnInputContextSignals,
            recentToolActivity: recentPlanToolActivity,
            hasObservedUserContext: hasPlanUserContextObservation(
              callbacks.getMessages() as AgentMessage[],
              lastAssistantTextForCheckpoint,
            ),
          }).status,
        });
        const iterationAllTools = shouldClosePlanToolSurface
          ? baseIterationAllTools.filter((tool) => isPlanDraftWriteToolName(tool.function.name))
          : phaseScopedIterationAllTools;
        if (workflowMode === "plan" && !callbacks.getIsPlanApproved() && iterationAllTools.length !== baseIterationAllTools.length) {
          logAgentEvent("plan_runtime_tool_scope_applied", {
            iteration,
            planRuntimePhase,
            rawTools: rawIterationAllTools.map((tool) => tool.function.name).slice(0, 24),
            scopedTools: iterationAllTools.map((tool) => tool.function.name),
            removedToolCount: Math.max(0, baseIterationAllTools.length - iterationAllTools.length),
            postConvergence: shouldClosePlanToolSurface,
          });
        }
        const availableToolNames = new Set(iterationAllTools.map((tool) => tool.function.name));
        applySystemPromptForRuntime(runtimeIntent, iterationAllTools);

        // 1. Context management. Cloud mode uses a lightweight pass so tool-heavy
        // histories do not trigger slow Responses requests or gateway 524s.
        let managedAgentMessages = callbacks.getMessages() as AgentMessage[];
        const providerCompatibilityOverride = callbacks.shouldForceXmlForProviderCompatibility?.();
        const forceXmlTools = shouldUseXmlToolProtocol(
          config,
          settings,
          callbacks.getMessages(),
          providerCompatibilityOverride,
        );
        const llmTools = !forceXmlTools ? iterationAllTools : [];
        const cloudResponsesCompact = isCloudProfile && config.cloud.apiFormat === "responses";
        const contextLimitForManagement = snapshotContextLimit ?? (cloudResponsesCompact ? 32768 : null);
        const effectiveContextLimitForManagement = contextLimitForManagement != null
          ? computeManagedContextLimit(contextLimitForManagement, llmTools)
          : null;
        const contextBudgetsForManagement = effectiveContextLimitForManagement != null
          ? computeContextBudgets(effectiveContextLimitForManagement)
          : null;
        const contextForceForManagement = contextBudgetsForManagement
          ? computeContextForceReason({
              messages: callbacks.getMessages() as AgentMessage[],
              iteration,
              workflowMode,
              isPlanApproved: callbacks.getIsPlanApproved(),
              inputBudget: contextBudgetsForManagement.inputBudget,
              proactiveTriggerBudget: isExecuteRecoveryEligible
                ? Math.min(16000, contextBudgetsForManagement.proactiveTriggerBudget)
                : contextBudgetsForManagement.proactiveTriggerBudget,
            })
          : null;
        let executeRecoveryContextAlreadyCompacted = false;
        if (isExecuteRecoveryEligible && contextForceForManagement?.shouldForce) {
          const recoveryMessagesBefore = callbacks.getMessages().length;
          const recoveryManagedResult = compactContextForExecuteRecovery(
            callbacks.getMessages(),
            {
              previousMemoryState: callbacks.getContextMemoryState?.() || null,
              turnId: callbacks.getCurrentTurnId?.() || eventTurnId,
              maxMessages: config.activeProfile === "local" ? 60 : 36,
              maxToolResultMessages: config.activeProfile === "local" ? 24 : 12,
              maxToolChars: config.activeProfile === "local" ? 30000 : 12000,
              maxToolCallGroups: config.activeProfile === "local" ? 12 : 6,
              maxToolResultTokens: config.activeProfile === "local" ? 1200 : 360,
              latestUserMessages: config.activeProfile === "local" ? 4 : 2,
            },
          );
          callbacks.onContextMemoryBuilt?.(recoveryManagedResult.memoryState, recoveryManagedResult.memoryPacket);
          managedAgentMessages = recoveryManagedResult.messages as AgentMessage[];
          if (recoveryManagedResult.changed) {
            try {
              callbacks.replaceMessages(managedAgentMessages);
            } catch (replaceErr) {
              logAgentEvent('replace_messages_error', {
                iteration,
                error: (replaceErr as Error).message || String(replaceErr),
                messagesLength: managedAgentMessages.length,
                reason: 'execute_recovery_context_trim',
              });
            }
            try {
              callbacks.onContextCompress({
                droppedCount: recoveryManagedResult.droppedCount,
                droppedMessageCount: recoveryManagedResult.droppedMessageCount,
                tokenCountBefore: recoveryManagedResult.tokenCountBefore,
                tokenCountAfter: recoveryManagedResult.tokenCountAfter,
                tokenReduction: recoveryManagedResult.tokenReduction,
                compressedContext: recoveryManagedResult.compressedContext,
                displaySummary: recoveryManagedResult.displaySummary,
                memoryPacket: recoveryManagedResult.memoryPacket,
                microCompactionKind: recoveryManagedResult.microCompactionKind,
                microCompactedCount: recoveryManagedResult.microCompactedCount,
                tokenBreakdown: recoveryManagedResult.tokenBreakdownBefore,
              }, 'execute_recovery');
            } catch (compressErr) {
              logAgentEvent('on_context_compress_error', {
                iteration,
                error: (compressErr as Error).message || String(compressErr),
                reason: 'execute_recovery_context_trim',
              });
            }
          }
          executeRecoveryContextAlreadyCompacted = true;
          logAgentEvent("execute_recovery_context_compacted", {
            iteration,
            executeRecoveryMode,
            executeRecoveryReason,
            forceReason: contextForceForManagement.reason,
            estimatedTokens: Math.round(contextForceForManagement.estimatedTokens),
            tokenPressure: Number(contextForceForManagement.tokenPressure.toFixed(3)),
            messagesBefore: recoveryMessagesBefore,
            messagesAfter: managedAgentMessages.length,
            droppedMessageCount: recoveryManagedResult.droppedMessageCount,
            tokenBefore: Math.round(recoveryManagedResult.tokenCountBefore),
            tokenAfter: Math.round(recoveryManagedResult.tokenCountAfter),
            toolResultMessagesAfter: managedAgentMessages.filter((message) => message.role === "tool").length,
            toolCharsAfter: managedAgentMessages.reduce((sum, message) =>
              message.role === "tool" && typeof message.content === "string"
                ? sum + message.content.length
                : sum,
            0),
            recoveryToolSurface: describeExecuteRecoveryToolSurface(executeRecoveryMode, allowExecuteRecoveryFileRead),
          });
        } else if (isExecuteRecoveryEligible) {
          logAgentEvent("execute_recovery_context_skipped", {
            iteration,
            executeRecoveryMode,
            executeRecoveryReason,
            reason: "below_context_threshold",
            estimatedTokens: contextForceForManagement
              ? Math.round(contextForceForManagement.estimatedTokens)
              : null,
            tokenPressure: contextForceForManagement
              ? Number(contextForceForManagement.tokenPressure.toFixed(3))
              : null,
            proactiveTriggerBudget: contextBudgetsForManagement?.proactiveTriggerBudget ?? null,
            recoveryToolSurface: describeExecuteRecoveryToolSurface(executeRecoveryMode, allowExecuteRecoveryFileRead),
          });
        }
        if (
          !executeRecoveryContextAlreadyCompacted &&
          effectiveContextLimitForManagement != null &&
          contextBudgetsForManagement &&
          contextForceForManagement
        ) {
          const effectiveContextLimit = effectiveContextLimitForManagement;
          const contextBudgets = contextBudgetsForManagement;
          const { inputBudget, outputBudget } = contextBudgets;
          const contextForce = contextForceForManagement;
          // ── Strain reasoning and prune ephemeral tools from prompt messages ──
          const messagesForPruning = callbacks.getMessages();

          // Step 1: Strain reasoning — purge prior-turn reasoning_content to break thinking loops
          const strainResult = strainReasoning(messagesForPruning, {
            currentTurnReasoningThreshold: config.activeProfile === "local" ? 1200 : 2000,
          });
          const reasoningStrained = strainResult.messages;
          if (strainResult.isReasoningDominated) {
            logAgentEvent("reasoning_dominated_detected", {
              turnId: eventTurnId,
              reasoningChars: strainResult.totalPurgedReasoningChars,
              messagesStrained: strainResult.messagesStrained,
            });
          }

          // Step 2: Prune ephemeral tool outputs — "burn after reading"
          const prunedResult = pruneEphemeralItems(
            reasoningStrained,
            turnContext,
            {
              maxToolChars: config.activeProfile === "local" ? 2000 : 4000,
              maxReasoningChars: 500,
              purgeReasoningFromPriorTurns: true,
            },
          );
          const prunedMessages = prunedResult.messages;

          // Step 3: Record burned replacements in turn context
          for (const _rep of turnContext.getBurnedReplacements()) {
            // Already recorded during pruneEphemeralItems
          }

          const isUnapprovedPlanContext = workflowMode === "plan" && !callbacks.getIsPlanApproved();
          const forcedContextToolBudget = contextForce.shouldForce
            ? callbacks.getIsPlanApproved()
              ? 1200
              : isUnapprovedPlanContext
              ? 1000
              : 1600
            : null;
          const forcedContextAssistantBudget = contextForce.shouldForce
            ? callbacks.getIsPlanApproved()
              ? 900
              : isUnapprovedPlanContext
              ? 700
              : 1000
            : null;

          const managedResult = manageContext(
            prunedMessages,
            effectiveContextLimit,
            cloudResponsesCompact ? Math.min(outputBudget, 2048) : outputBudget,
            cloudResponsesCompact
              ? 700
              : forcedContextToolBudget
              ? forcedContextToolBudget
              : isUnapprovedPlanContext
              ? 1200
              : callbacks.getIsPlanApproved()
              ? 2200
              : Math.max(4000, Math.floor(inputBudget * 0.32)),
            cloudResponsesCompact
              ? 500
              : forcedContextAssistantBudget
              ? forcedContextAssistantBudget
              : isUnapprovedPlanContext
              ? 900
              : callbacks.getIsPlanApproved()
              ? 1400
              : Math.max(2000, Math.floor(inputBudget * 0.18)),
            contextForce.shouldForce,
            {
              previousMemoryState: callbacks.getContextMemoryState?.() || null,
              turnId: callbacks.getCurrentTurnId?.() || eventTurnId,
            },
          );
          callbacks.onContextMemoryBuilt?.(managedResult.memoryState, managedResult.memoryPacket);
          logAgentEvent("context_memory_built", {
            memoryId: managedResult.memoryState.id,
            goals: managedResult.memoryState.goals.length,
            constraints: managedResult.memoryState.constraints.length,
            evidence: managedResult.memoryState.evidence.length,
            files: managedResult.memoryState.files.length,
            packetChars: managedResult.memoryPacket.length,
          });
          managedAgentMessages = managedResult.messages as AgentMessage[];
          try {
            if (managedResult.changed) {
              callbacks.replaceMessages(managedAgentMessages);
            }
          } catch (replaceErr) {
            logAgentEvent('replace_messages_error', {
              iteration,
              error: (replaceErr as Error).message || String(replaceErr),
              messagesLength: managedAgentMessages.length,
              reason: 'proactive_context_trim',
            });
          }
          const compressionRatio = managedResult.tokenCountBefore > 0
            ? managedResult.tokenReduction / managedResult.tokenCountBefore
            : 0;
          const shouldAnnounceCompression =
            managedResult.droppedMessageCount > 0 ||
            managedResult.tokenReduction >= 1024 ||
            compressionRatio >= 0.05;
          if (managedResult.changed && shouldAnnounceCompression) {
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
              }, 'proactive');
              emitPlanExecutionProgress('context_compression');
            } catch (compressErr) {
              logAgentEvent('on_context_compress_error', {
                iteration,
                error: (compressErr as Error).message || String(compressErr),
                reason: 'proactive_context_trim',
              });
            }
          }
          logAgentEvent("context_pack_built", {
            messagesBefore: callbacks.getMessages().length,
            messagesAfter: managedAgentMessages.length,
            tokenBefore: Math.round(managedResult.tokenCountBefore),
            tokenAfter: Math.round(managedResult.tokenCountAfter),
            droppedMessageCount: managedResult.droppedMessageCount,
            microCompactionKind: managedResult.microCompactionKind,
            microCompactedCount: managedResult.microCompactedCount,
            forceManaged: contextForce.shouldForce,
            forceReason: contextForce.reason,
            textChars: contextForce.textChars,
            toolChars: contextForce.toolChars,
            toolMessages: contextForce.toolMessages,
            estimatedTokens: Math.round(contextForce.estimatedTokens),
            tokenPressure: Number(contextForce.tokenPressure.toFixed(3)),
          });
        }

        const activeGuidance = callbacks.consumeActiveGuidance?.();
        if (activeGuidance?.text?.trim()) {
          const guidanceText = activeGuidance.text.trim();
          const guidanceMessage: AgentMessage = {
            role: "user",
            content: callbacks.getPreferredLanguage() === "en"
              ? `Runtime guidance from the user for the current run. Treat this as high-priority direction for the next step without restarting the task:\n\n${guidanceText}`
              : `用户在当前执行中追加的运行引导。请把它作为下一步的高优先级方向，不要重启任务：\n\n${guidanceText}`,
          };
          managedAgentMessages = [...managedAgentMessages, guidanceMessage];
          callbacks.appendMessage(guidanceMessage);
          logAgentEvent("runtime_guidance_injected", {
            iteration,
            guidanceId: activeGuidance.id,
            chars: guidanceText.length,
          });
        }

        // 2. Stream LLM response
        const assistantMsgId = generateId();
        let streamResult: StreamResult;
        const maxOutputEscalations = getMaxOutputEscalations();
        const iterationRequestStartedAt = Date.now();

        logAgentEvent("iteration_start", {
          iteration,
          workflowMode,
          turnIntent,
          runtimeIntent,
          messagesLen: managedAgentMessages.length,
          allTools: iterationAllTools.length,
          llmTools: llmTools.length,
          toolProtocol: effectiveToolProtocol,
          xmlToolsEnabled: true,
          mcpTools: mcpTools.length,
          currentMaxTokens: currentMaxTokens ?? "default",
        });
        callbacks.onHarnessRunUpdate?.({
          status: "running",
          iteration,
          maxIterations: effectiveMaxIterations,
          workflowMode,
          runtimeIntent,
          planStage: callbacks.getPlanStage(),
          isPlanApproved: callbacks.getIsPlanApproved(),
          messagesLen: managedAgentMessages.length,
          toolCount: iterationAllTools.length,
          activeStreamId: null,
          streamStatus: "iteration_started",
          streamChunkCount: 0,
          streamByteCount: 0,
          lastStreamError: null,
        });

        try {
          const protocolMessagesForLLM = prepareMessagesForToolProtocol(
            managedAgentMessages,
            config,
            settings,
            providerCompatibilityOverride,
          );
          const finalTextOnlyPrompt = finalTextOnlyStep
            ? buildMaxStepsFinalTextPrompt({
                language: callbacks.getPreferredLanguage(),
                iteration,
                maxIterations: effectiveMaxIterations,
                repeatedTargets: summarizeRepeatedExecuteTargets(recentToolActivity.slice(-12)),
              })
            : "";
          const chatFinalSynthesisPrompt = chatFinalSynthesisActive && !usedChatFinalSynthesisPrompt
            ? buildChatFinalSynthesisPrompt({
                language: callbacks.getPreferredLanguage(),
                reason: chatFinalSynthesisReason,
                iteration,
                repeatedTargets: summarizeRepeatedExecuteTargets(recentToolActivity.slice(-12)),
                recentActivity: recentToolActivity,
              })
            : "";
          const recoveryPromptForLLM = finalTextOnlyPrompt || chatFinalSynthesisPrompt;
          const messagesForLLM = recoveryPromptForLLM
            ? [...protocolMessagesForLLM, { role: "user" as const, content: recoveryPromptForLLM }]
            : protocolMessagesForLLM;
          if (chatFinalSynthesisPrompt) {
            usedChatFinalSynthesisPrompt = true;
          }
          const streamWatchdogOptions = getPlanStreamWatchdogOptions(llmTools.length) ?? {};
          const recoveryToolChoice: OpenAiToolChoice | undefined =
            isExecuteRecoveryEligible && executeRecoveryMode !== "normal" && llmTools.length > 0 && !forceXmlTools
              ? "required"
              : undefined;
          logAgentEvent("llm_request_shape", {
            iteration,
            workflowMode,
            turnIntent,
            runtimeIntent,
            activeProfile: config.activeProfile,
            provider: settings.provider || "unknown",
            providerFamily: modelProtocolProfile.providerFamily,
            model: settings.model,
            apiProtocol: settings.apiProtocol,
            useRustProxy: settings.useRustProxy,
            contextLimit: settings.contextLimit,
            configuredContextLimit: snapshotContextLimit ?? null,
            currentMaxTokens: currentMaxTokens ?? "default",
            maxOutputEscalations,
            forceXmlTools,
            toolProtocol: effectiveToolProtocol,
            nativeToolsEnabled: !forceXmlTools,
            compatibilityOverride: !!providerCompatibilityOverride,
            executeRecoveryMode,
            executeRecoveryReason,
            recoveryToolSurface: describeExecuteRecoveryToolSurface(executeRecoveryMode, allowExecuteRecoveryFileRead),
            finalTextOnlyStep,
            chatFinalSynthesisActive,
            chatFinalSynthesisReason,
            messages: summarizeMessagesForDiagnostics(messagesForLLM),
            allTools: summarizeToolsForDiagnostics(iterationAllTools),
            llmTools: summarizeToolsForDiagnostics(llmTools),
            toolChoice: recoveryToolChoice ?? null,
            watchdog: {
              hardTimeoutMs: streamWatchdogOptions.noVisibleTokenTimeoutMs ?? null,
              label: streamWatchdogOptions.noVisibleTokenTimeoutLabel ?? null,
              noticeOnlyForLocalPlan:
                workflowMode === "plan" &&
                !callbacks.getIsPlanApproved() &&
                config.activeProfile === "local" &&
                forceXmlTools,
            },
          });
           // ── Structured Output JSON Schema & Reasoning stops ──
           const isExecute = runtimeIntent === "execute";
           const executionPolicy = PolicyFactory.createPolicy(config);
           const responseSchema = (isExecute && config.activeProfile === "local")
             ? executionPolicy.getResponseFormatSchema?.()
             : undefined;

           streamResult = await fetchLLMStream(
            messagesForLLM,
            settings,
            assistantMsgId,
            callbacks,
            abortController.signal,
            llmTools,
            currentMaxTokens,
            maxOutputEscalations,
            {
              ...streamWatchdogOptions,
              toolChoice: recoveryToolChoice,
              workflowMode,
              runtimeIntent,
              responseFormat: responseSchema,
            },
          );

          // Check if output is reasoning-dominated (>80% tokens) with no tool calls
          const totalOutputChars = streamResult.content.length + (streamResult.reasoningContent || "").length;
          if (totalOutputChars > 200 && (!streamResult.toolCalls || streamResult.toolCalls.length === 0)) {
            const reasoningRatio = (streamResult.reasoningContent || "").length / totalOutputChars;
            if (reasoningRatio > 0.8) {
              const stopMessage = executionPolicy.getReasoningDominatedStopMessage?.(
                callbacks.getPreferredLanguage(),
                reasoningRatio
              ) || "Halted: reasoning-dominated output.";
              callbacks.onNonActionableStop(stopMessage, "no_action");
              callbacks.onStatusChange("idle");
              return;
            }
          }
          if (llmTools.length > 0) {
            callbacks.onProviderNativeToolSuccess?.();
          }
          if (
            config.activeProfile === "local" &&
            snapshotContextLimit != null &&
            isAssistantTurnEmpty(normalizeAssistantTurn(streamResult))
          ) {
            const contextErr = new Error(
              "Local model returned an empty completion. Treating as context window limit exceeded to trigger reactive compaction."
            );
            (contextErr as any).isContextError = true;
            throw contextErr;
          }
        } catch (err) {
          if ((err as Error).name === "AbortError") {
            callbacks.onStatusChange("idle");
            return;
          }

          // ── Reactive Compact (local profile only) ───────────────
          // If the error is a context_length_exceeded, compact the messages
          // more aggressively and retry once.
          const errMsg = (err as Error).message || "";
          if (pauseApprovedPlanStreamWatchdog(errMsg, { stage: "initial_stream" })) {
            return;
          }
          if (workflowMode === "plan" && !callbacks.getIsPlanApproved() && isStreamWatchdogTimeoutMessage(errMsg)) {
            const planStage = callbacks.getPlanStage();
            logAgentEvent("plan_stage_waiting_for_design", {
              iteration,
              planStage,
              reason: "stream_first_chunk_timeout",
              message: errMsg.slice(0, 240),
            });
            callbacks.onNonActionableStop(
              buildPlanStreamTimeoutPauseMessage(callbacks.getPreferredLanguage(), planStage),
              "incomplete_plan",
            );
            callbacks.onStatusChange("idle");
            return;
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

            const { contextLimit: reactiveContextLimit, reportedContextLimit } =
              clampContextLimitToReported(snapshotContextLimit, errMsg);
            snapshotContextLimit = reactiveContextLimit;
            if (reportedContextLimit != null && reportedContextLimit < snapshotContextLimit) {
              logAgentEvent("context_limit_clamped", {
                iteration,
                reportedContextLimit,
                configuredContextLimit: snapshotContextLimit,
              });
            }

            // More aggressive compaction: reduce tool result budget while keeping
            // enough response room for a tool call instead of a length stop.
            const aggressiveOutputBudget = Math.min(3072, Math.max(1536, Math.floor(reactiveContextLimit * 0.08)));
            const aggressiveContextLimit = computeManagedContextLimit(
              reactiveContextLimit,
              llmTools,
              aggressiveOutputBudget,
            );
            const maxToolResultTokens = 800;
            const aggressivelyManagedResult = manageContext(
              callbacks.getMessages(),
              aggressiveContextLimit,
              aggressiveOutputBudget,
              maxToolResultTokens,
              480,
              true,
              {
                previousMemoryState: callbacks.getContextMemoryState?.() || null,
              },
            );
            callbacks.onContextMemoryBuilt?.(aggressivelyManagedResult.memoryState, aggressivelyManagedResult.memoryPacket);
            const aggressivelyManaged = aggressivelyManagedResult.messages as AgentMessage[];
            try {
              callbacks.replaceMessages(aggressivelyManaged);
            } catch (replaceErr) {
              logAgentEvent('replace_messages_error', {
                iteration,
                error: (replaceErr as Error).message || String(replaceErr),
                messagesLength: aggressivelyManaged.length,
                reason: 'reactive_context_trim',
              });
            }
            if (aggressivelyManagedResult.changed && aggressivelyManagedResult.tokenReduction > 0) {
              try {
                callbacks.onContextCompress({
                  droppedCount: aggressivelyManagedResult.droppedCount,
                  droppedMessageCount: aggressivelyManagedResult.droppedMessageCount,
                  tokenCountBefore: aggressivelyManagedResult.tokenCountBefore,
                  tokenCountAfter: aggressivelyManagedResult.tokenCountAfter,
                  tokenReduction: aggressivelyManagedResult.tokenReduction,
                  compressedContext: aggressivelyManagedResult.compressedContext,
                  displaySummary: aggressivelyManagedResult.displaySummary,
                  memoryPacket: aggressivelyManagedResult.memoryPacket,
                  microCompactionKind: aggressivelyManagedResult.microCompactionKind,
                  microCompactedCount: aggressivelyManagedResult.microCompactedCount,
                  tokenBreakdown: aggressivelyManagedResult.tokenBreakdownBefore,
                }, 'reactive');
                emitPlanExecutionProgress('context_compression');
              } catch (compressErr) {
                logAgentEvent('on_context_compress_error', {
                  iteration,
                  error: (compressErr as Error).message || String(compressErr),
                  reason: 'reactive_context_trim',
                });
              }
            }

            // Retry once with the compacted context
            try {
              const aggressivelyManagedForLLM = prepareMessagesForToolProtocol(
                aggressivelyManaged,
                config,
                settings,
                providerCompatibilityOverride,
              );
              streamResult = await fetchLLMStream(
                aggressivelyManagedForLLM,
                settings,
                assistantMsgId,
                callbacks,
                abortController.signal,
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
            } catch (retryErr) {
              if ((retryErr as Error).name === "AbortError") {
                callbacks.onStatusChange("idle");
                return;
              }
              const retryErrMsg = (retryErr as Error).message || "";
              if (pauseApprovedPlanStreamWatchdog(retryErrMsg, { stage: "context_compaction_retry" })) {
                return;
              }
              if (workflowMode === "plan" && !callbacks.getIsPlanApproved() && isStreamWatchdogTimeoutMessage(retryErrMsg)) {
                const planStage = callbacks.getPlanStage();
                logAgentEvent("plan_stage_waiting_for_design", {
                  iteration,
                  planStage,
                  reason: "stream_first_chunk_timeout_after_compaction",
                  message: retryErrMsg.slice(0, 240),
                });
                callbacks.onNonActionableStop(
                  buildPlanStreamTimeoutPauseMessage(callbacks.getPreferredLanguage(), planStage),
                  "incomplete_plan",
                );
                callbacks.onStatusChange("idle");
                return;
              }

              // Second retry: strip tool_calls from messages entirely (some providers
              // like Ollama choke on tool_calls in message history) and retry with
              // plain text-only messages
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
                try {
                  callbacks.replaceMessages(emergencyManaged);
                } catch (replaceErr) {
                  logAgentEvent('replace_messages_error', {
                    iteration,
                    error: (replaceErr as Error).message || String(replaceErr),
                    messagesLength: emergencyManaged.length,
                    reason: 'emergency_context_trim',
                  });
                }
                try {
                  callbacks.onContextCompress({
                    droppedCount: emergencyManagedResult.droppedCount,
                    droppedMessageCount: emergencyManagedResult.droppedMessageCount,
                    tokenCountBefore: emergencyManagedResult.tokenCountBefore,
                    tokenCountAfter: emergencyManagedResult.tokenCountAfter,
                    tokenReduction: emergencyManagedResult.tokenReduction,
                    compressedContext: emergencyManagedResult.compressedContext,
                    displaySummary: emergencyManagedResult.displaySummary,
                    memoryPacket: emergencyManagedResult.memoryPacket,
                    microCompactionKind: emergencyManagedResult.microCompactionKind,
                    microCompactedCount: emergencyManagedResult.microCompactedCount,
                    tokenBreakdown: emergencyManagedResult.tokenBreakdownBefore,
                  }, 'reactive');
                  emitPlanExecutionProgress('context_compression');
                } catch (compressErr) {
                  logAgentEvent('on_context_compress_error', {
                    iteration,
                    error: (compressErr as Error).message || String(compressErr),
                    reason: 'emergency_context_trim',
                  });
                }
              }

              try {
                const emergencyManagedForLLM = prepareMessagesForToolProtocol(
                  emergencyManaged,
                  config,
                  settings,
                  providerCompatibilityOverride,
                );
                streamResult = await fetchLLMStream(
                  emergencyManagedForLLM,
                  settings,
                  assistantMsgId,
                  callbacks,
                  abortController.signal,
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
              } catch (finalErr) {
                if ((finalErr as Error).name === "AbortError") {
                  callbacks.onStatusChange("idle");
                  return;
                }
                const finalErrMsg = (finalErr as Error).message || "";
                if (pauseApprovedPlanStreamWatchdog(finalErrMsg, { stage: "emergency_compaction_retry" })) {
                  return;
                }
                if (workflowMode === "plan" && !callbacks.getIsPlanApproved() && isStreamWatchdogTimeoutMessage(finalErrMsg)) {
                  const planStage = callbacks.getPlanStage();
                  logAgentEvent("plan_stage_waiting_for_design", {
                    iteration,
                    planStage,
                    reason: "stream_first_chunk_timeout_after_emergency_compaction",
                    message: finalErrMsg.slice(0, 240),
                  });
                  callbacks.onNonActionableStop(
                    buildPlanStreamTimeoutPauseMessage(callbacks.getPreferredLanguage(), planStage),
                    "incomplete_plan",
                  );
                  callbacks.onStatusChange("idle");
                  return;
                }
                callbacks.onError(`Context too long even after compaction. Please start a new conversation or reduce context.`);
                callbacks.onStatusChange("error");
                return;
              }
            }
          } else if (isContextError) {
            logAgentEvent("context_retry_start", {
              iteration,
              reason: "cloud_context_length_exceeded",
              error: errMsg.slice(0, 240),
            });
            const cloudReactiveContextLimit = 32768;
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
            try {
              if (cloudManagedResult.changed) {
                callbacks.replaceMessages(cloudManagedMessages);
              }
            } catch (replaceErr) {
              logAgentEvent('replace_messages_error', {
                iteration,
                error: (replaceErr as Error).message || String(replaceErr),
                messagesLength: cloudManagedMessages.length,
                reason: 'cloud_context_retry',
              });
            }
            if (cloudManagedResult.changed && cloudManagedResult.tokenReduction > 0) {
              try {
                callbacks.onContextCompress({
                  droppedCount: cloudManagedResult.droppedCount,
                  droppedMessageCount: cloudManagedResult.droppedMessageCount,
                  tokenCountBefore: cloudManagedResult.tokenCountBefore,
                  tokenCountAfter: cloudManagedResult.tokenCountAfter,
                  tokenReduction: cloudManagedResult.tokenReduction,
                  compressedContext: cloudManagedResult.compressedContext,
                  displaySummary: cloudManagedResult.displaySummary,
                  memoryPacket: cloudManagedResult.memoryPacket,
                  microCompactionKind: cloudManagedResult.microCompactionKind,
                  microCompactedCount: cloudManagedResult.microCompactedCount,
                  tokenBreakdown: cloudManagedResult.tokenBreakdownBefore,
                }, 'reactive');
                emitPlanExecutionProgress('context_compression');
              } catch (compressErr) {
                logAgentEvent('on_context_compress_error', {
                  iteration,
                  error: (compressErr as Error).message || String(compressErr),
                  reason: 'cloud_context_retry',
                });
              }
            }

            try {
              const cloudManagedForLLM = prepareMessagesForToolProtocol(
                cloudManagedMessages,
                config,
                settings,
                providerCompatibilityOverride,
              );
              streamResult = await fetchLLMStream(
                cloudManagedForLLM,
                settings,
                assistantMsgId,
                callbacks,
                abortController.signal,
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
            } catch (cloudRetryErr) {
              if ((cloudRetryErr as Error).name === "AbortError") {
                callbacks.onStatusChange("idle");
                return;
              }
              const cloudRetryErrMsg = (cloudRetryErr as Error).message || "";
              if (pauseApprovedPlanStreamWatchdog(cloudRetryErrMsg, { stage: "cloud_compaction_retry" })) {
                return;
              }
              if (workflowMode === "plan" && !callbacks.getIsPlanApproved() && isStreamWatchdogTimeoutMessage(cloudRetryErrMsg)) {
                const planStage = callbacks.getPlanStage();
                logAgentEvent("plan_stage_waiting_for_design", {
                  iteration,
                  planStage,
                  reason: "stream_first_chunk_timeout_after_cloud_compaction",
                  message: cloudRetryErrMsg.slice(0, 240),
                });
                callbacks.onNonActionableStop(
                  buildPlanStreamTimeoutPauseMessage(callbacks.getPreferredLanguage(), planStage),
                  "incomplete_plan",
                );
                callbacks.onStatusChange("idle");
                return;
              }
              callbacks.onError(
                "Remote context limit exceeded even after local compaction retry. Please start a new conversation or shorten the history.",
              );
              callbacks.onStatusChange("error");
              return;
            }
          } else if (isCompatibilityError) {
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
            try { callbacks.replaceMessages(compatibilityMessages); } catch (replaceErr) { logAgentEvent("replace_messages_error", { iteration, error: (replaceErr as Error).message || String(replaceErr), messagesLength: compatibilityMessages.length, reason: "compatibility_fallback" }); }
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
              streamResult = await fetchLLMStream(
                compatibilityMessages,
                settings,
                assistantMsgId,
                callbacks,
                abortController.signal,
                [],
                currentMaxTokens,
                maxOutputEscalations,
                {
                  ...getPlanStreamWatchdogOptions(0),
                  workflowMode,
                  runtimeIntent,
                },
              );
            } catch (retryErr) {
              if ((retryErr as Error).name === "AbortError") {
                callbacks.onStatusChange("idle");
                return;
              }

              const retryMsg = (retryErr as Error).message || "";
              if (pauseApprovedPlanStreamWatchdog(retryMsg, { stage: "provider_compatibility_retry" })) {
                return;
              }
              if (workflowMode === "plan" && !callbacks.getIsPlanApproved() && isStreamWatchdogTimeoutMessage(retryMsg)) {
                const planStage = callbacks.getPlanStage();
                logAgentEvent("plan_stage_waiting_for_design", {
                  iteration,
                  planStage,
                  reason: "stream_first_chunk_timeout_after_compatibility_retry",
                  message: retryMsg.slice(0, 240),
                });
                callbacks.onNonActionableStop(
                  buildPlanStreamTimeoutPauseMessage(callbacks.getPreferredLanguage(), planStage),
                  "incomplete_plan",
                );
                callbacks.onStatusChange("idle");
                return;
              }
              const retryLooksLikeCompatibility =
                isProviderCompatibilityErrorMessage(retryMsg) ||
                (isCloudProfile && !isCloudGatewayTimeoutMessage(retryMsg) && isRetryableCloudErrorMessage(retryMsg));

              if (retryLooksLikeCompatibility) {
                const providerCompatibilityMessages = ensureProviderCompatibilityMode(
                  compatibilityMessages,
                  workflowMode,
                );
                try { callbacks.replaceMessages(providerCompatibilityMessages); } catch (replaceErr) { logAgentEvent("replace_messages_error", { iteration, error: (replaceErr as Error).message || String(replaceErr), messagesLength: providerCompatibilityMessages.length, reason: "provider_compatibility_retry" }); }
                try {
                  streamResult = await fetchLLMStream(
                    providerCompatibilityMessages,
                    settings,
                    assistantMsgId,
                    callbacks,
                    abortController.signal,
                    [],
                    currentMaxTokens,
                    maxOutputEscalations,
                    {
                      ...getPlanStreamWatchdogOptions(0),
                      workflowMode,
                      runtimeIntent,
                    },
                  );
                } catch (finalErr) {
                  if ((finalErr as Error).name === "AbortError") {
                    callbacks.onStatusChange("idle");
                    return;
                  }
                  const finalErrMsg = (finalErr as Error).message || "";
                  if (pauseApprovedPlanStreamWatchdog(finalErrMsg, { stage: "provider_compatibility_final_retry" })) {
                    return;
                  }
                  if (workflowMode === "plan" && !callbacks.getIsPlanApproved() && isStreamWatchdogTimeoutMessage(finalErrMsg)) {
                    const planStage = callbacks.getPlanStage();
                    logAgentEvent("plan_stage_waiting_for_design", {
                      iteration,
                      planStage,
                      reason: "stream_first_chunk_timeout_after_provider_compatibility_retry",
                      message: finalErrMsg.slice(0, 240),
                    });
                    callbacks.onNonActionableStop(
                      buildPlanStreamTimeoutPauseMessage(callbacks.getPreferredLanguage(), planStage),
                      "incomplete_plan",
                    );
                    callbacks.onStatusChange("idle");
                    return;
                  }
                  const transcriptMessages = buildTranscriptCompatibilityRetryMessages(
                    managedAgentMessages,
                    workflowMode,
                  );
                  try { callbacks.replaceMessages(transcriptMessages); } catch (replaceErr) { logAgentEvent("replace_messages_error", { iteration, error: (replaceErr as Error).message || String(replaceErr), messagesLength: transcriptMessages.length, reason: "transcript_retry" }); }
                  try {
                    streamResult = await fetchLLMStream(
                      transcriptMessages,
                      settings,
                      assistantMsgId,
                      callbacks,
                      abortController.signal,
                      [],
                      currentMaxTokens,
                      maxOutputEscalations,
                      {
                        ...getPlanStreamWatchdogOptions(0),
                        workflowMode,
                        runtimeIntent,
                      },
                    );
                  } catch (lastErr) {
                    if ((lastErr as Error).name === "AbortError") {
                      callbacks.onStatusChange("idle");
                      return;
                    }
                    const lastErrorMessage = getErrorMessage(lastErr, "未知错误");
                    if (pauseApprovedPlanStreamWatchdog(lastErrorMessage, { stage: "provider_compatibility_transcript_retry" })) {
                      return;
                    }
                    if (workflowMode === "plan" && !callbacks.getIsPlanApproved() && isStreamWatchdogTimeoutMessage(lastErrorMessage)) {
                      const planStage = callbacks.getPlanStage();
                      logAgentEvent("plan_stage_waiting_for_design", {
                        iteration,
                        planStage,
                        reason: "stream_first_chunk_timeout_after_transcript_retry",
                        message: lastErrorMessage.slice(0, 240),
                      });
                      callbacks.onNonActionableStop(
                        buildPlanStreamTimeoutPauseMessage(callbacks.getPreferredLanguage(), planStage),
                        "incomplete_plan",
                      );
                      callbacks.onStatusChange("idle");
                      return;
                    }
                    callbacks.onError(
                      "当前云端服务对会话内容格式兼容性较弱。我已经自动尝试过精简历史、关闭原生 tools，并回退到单条纯文本 transcript，但仍被服务端拒绝。请先新建一个纯文本新会话再试，或换一个兼容性更好的 OpenAI 协议网关。\n\n上游返回：" + lastErrorMessage,
                    );
                    callbacks.onStatusChange("error");
                    return;
                  }
                }
              } else {
                callbacks.onError(getErrorMessage(retryErr, retryMsg || "LLM stream failed"));
                callbacks.onStatusChange("error");
                return;
              }
            }
          } else {
            callbacks.onError(getErrorMessage(err, "LLM stream failed"));
            callbacks.onStatusChange("error");
            return;
          }
        }

        const streamText = streamResult.content;
        const providerReasoningForHistory =
          typeof streamResult.reasoningContent === "string" && streamResult.reasoningContent.trim()
            ? {
                reasoningContent: streamResult.reasoningContent,
                reasoningField: streamResult.reasoningField,
              }
            : null;
        const _contentShort = streamText.length < 10;
        const _toolCallsFew = streamResult.toolCalls.length < 2;
        logAgentEvent("stream_done", {
          iteration,
          finishReason: streamResult.finishReason || "unknown",
          contentChars: streamText.length,
          providerReasoningChars: providerReasoningForHistory?.reasoningContent.length ?? 0,
          toolCalls: streamResult.toolCalls.length,
          elapsedMs: Date.now() - iterationRequestStartedAt,
          emptyResult: streamText.length === 0 && streamResult.toolCalls.length === 0,
        });
        if (_contentShort && _toolCallsFew) {
          logAgentEvent("stream_low_content_diagnostic", {
            iteration,
            contentChars: streamText.length,
            contentPreview: streamText.slice(0, 200),
            toolCallCount: streamResult.toolCalls.length,
            toolCallNames: streamResult.toolCalls.map((tc) => tc.name).slice(0, 8),
            finishReason: streamResult.finishReason || "unknown",
            elapsedMs: Date.now() - iterationRequestStartedAt,
            provider: settings.provider || "unknown",
            model: settings.model,
            reasoningChars: providerReasoningForHistory?.reasoningContent.length ?? 0,
            messageCount: managedAgentMessages.length,
            activeProfile: config.activeProfile,
          });
        }
        if (providerReasoningForHistory) {
          logAgentEvent("reasoning_suppressed", {
            iteration,
            chars: providerReasoningForHistory.reasoningContent.length,
            field: providerReasoningForHistory.reasoningField || "reasoning_content",
            replayInContext: false,
            display: reasoningPolicy.display,
          });
        }

        // Summarize provider reasoning for context memory injection at turn end
        if (providerReasoningForHistory && providerReasoningForHistory.reasoningContent.length > 200) {
          const thoughtSummary = summarizeThought(providerReasoningForHistory.reasoningContent);
          const summaryText = thoughtSummaryToString(thoughtSummary);
          try { turnContext.setSummary(summaryText); } catch {}
          try { turnContext.accumulateReasoning(providerReasoningForHistory.reasoningContent.length); } catch {}
        }
        if (streamText.length === 0 && streamResult.toolCalls.length === 0) {
          logAgentEvent("llm_empty_response_diagnostic", {
            iteration,
            elapsedMs: Date.now() - iterationRequestStartedAt,
            workflowMode,
            turnIntent,
            runtimeIntent,
            activeProfile: config.activeProfile,
            provider: settings.provider || "unknown",
            model: settings.model,
            toolProtocol: effectiveToolProtocol,
            nativeToolsEnabled: llmTools.length > 0,
            llmToolCount: llmTools.length,
            messageCount: managedAgentMessages.length,
            contextLimit: settings.contextLimit,
            currentMaxTokens: currentMaxTokens ?? "default",
            likelyCauses: [
              config.activeProfile === "local" ? "local_prefill_or_provider_empty_completion" : "gateway_or_provider_empty_completion",
              forceXmlTools ? "text_xml_tool_protocol_no_native_tool_call" : "native_tool_protocol",
              managedAgentMessages.length > 12 ? "long_multi_turn_context" : "short_context",
            ],
          });
        }

        // 3. 将不同模型输出统一整理成标准结构，避免 UI 继续靠多处分支猜测。
        const normalizedBase = normalizeAssistantTurn(streamResult);
        const normalized = ensureVisibleConclusionWithPolicy(
          normalizedBase,
          true,
        );
        const reasoningDominatedNoAction = isReasoningDominatedNoActionResult(streamResult);
        if (reasoningDominatedNoAction && normalized.toolCalls.length === 0 && normalized.replyOptions.length === 0) {
          if (workflowMode === "plan" && !callbacks.getIsPlanApproved()) {
            const readiness = assessPlanEvidenceReadiness({
              userContext: turnInputContextSignals,
              recentToolActivity: recentPlanToolActivity,
              hasObservedUserContext: hasPlanUserContextObservation(
                callbacks.getMessages() as AgentMessage[],
                lastAssistantTextForCheckpoint,
              ),
            });
            const targetedRecoveryPasses = Math.max(planEvidenceRecoveryPasses, planReasoningOnlyRecoveryPasses);
            const recoveryDecision = resolvePlanNoActionRecovery({
              workflowMode,
              isPlanApproved: callbacks.getIsPlanApproved(),
              reasoningOnly: true,
              evidenceReadiness: readiness.status,
              targetedRecoveryPasses,
            });
            logAgentEvent("plan_reasoning_only_recovery_decision", {
              iteration,
              action: recoveryDecision.action,
              reason: recoveryDecision.reason,
              finishReason: streamResult.finishReason || "unknown",
              evidenceReadiness: readiness.status,
              evidenceReadinessReason: readiness.reason,
              successfulTargetedReads: readiness.successfulTargetedReads,
              successfulSearches: readiness.successfulSearches,
              targetedRecoveryPasses,
              contentChars: streamResult.content.length,
              reasoningChars: String(streamResult.reasoningContent || "").length,
            });

            if (recoveryDecision.action === "targeted_evidence") {
              callbacks.onStreamToken("__ESCALATION_RESET__:", assistantMsgId);
              planReasoningOnlyRecoveryPasses += 1;
              setPlanRuntimePhase("needs_evidence", readiness.reason);
              callbacks.onStatusChange("running");
              callbacks.appendMessage({
                role: "user",
                content: buildPlanTargetedEvidenceRecoveryPrompt({
                  language: callbacks.getPreferredLanguage(),
                  reason: readiness.reason,
                }),
              });
              continue;
            }

            if (recoveryDecision.action === "pause_blocked") {
              callbacks.onStreamToken("__ESCALATION_RESET__:", assistantMsgId);
              setPlanRuntimePhase("blocked", readiness.reason, "failed");
              callbacks.onNonActionableStop(
                buildPlanEvidenceBlockedPauseMessage({
                  language: callbacks.getPreferredLanguage(),
                  reason: readiness.reason,
                }),
                "incomplete_plan",
                {
                  recoveryReason: "plan_reasoning_only_evidence_blocked",
                  nextStep: callbacks.getPreferredLanguage() === "zh"
                    ? "补充一个具体缺失事实或关键选择后继续"
                    : "provide the concrete missing fact or key decision, then resume",
                },
              );
              callbacks.onStatusChange("idle");
              return;
            }
          }

          consecutiveReasoningDominatedCount++;
          callbacks.onStreamToken("__ESCALATION_RESET__:", assistantMsgId);
          logAgentEvent(
            consecutiveReasoningDominatedCount >= 2
              ? "reasoning_dominated_pause"
              : "reasoning_dominated_recovery",
            {
              iteration,
              consecutiveReasoningDominatedCount,
              contentChars: streamResult.content.length,
              reasoningChars: String(streamResult.reasoningContent || "").length,
              workflowMode,
              turnIntent,
              planStage: callbacks.getPlanStage(),
              isPlanApproved: callbacks.getIsPlanApproved(),
            },
          );
          if (consecutiveReasoningDominatedCount >= 2) {
            callbacks.onNonActionableStop(
              buildReasoningDominatedPauseMessage(callbacks.getPreferredLanguage(), workflowMode),
              workflowMode === "plan" ? "incomplete_plan" : "no_output",
            );
            callbacks.onStatusChange("idle");
            return;
          }
          if (workflowMode === "plan" && callbacks.getIsPlanApproved()) {
            approvedPlanActionOnlyRecoveryActive = true;
            logAgentEvent("approved_plan_reasoning_recovery_tool_surface", {
              iteration,
              recoveryToolSurface: "approved_plan_action_only",
              allowFileRead: false,
            });
          } else if (workflowMode === "edit" && resolveRuntimeIntent() === "execute") {
            activateExecuteRecovery("mutation_first", "reasoning_dominated_recovery", {
              consecutiveReasoningDominatedCount,
              contentChars: streamResult.content.length,
              reasoningChars: String(streamResult.reasoningContent || "").length,
            });
          }
          callbacks.onStatusChange("running");
          callbacks.appendMessage({
            role: "user",
            content: buildReasoningDominatedRecoveryPrompt(callbacks.getPreferredLanguage(), workflowMode),
          });
          continue;
        }
        if (isAssistantTurnEmpty(normalized)) {
          if (workflowMode === "plan" && !callbacks.getIsPlanApproved() && isReviewablePlanStage(callbacks.getPlanStage())) {
            logAgentEvent("plan_review_ready_after_empty_response", {
              iteration,
              planStage: callbacks.getPlanStage(),
              consecutiveEmptyResponseCount,
            });
            const reviewResult = await pauseForReviewablePlanArtifact("empty_response_with_reviewable_artifact");
            if (reviewResult === "approved_continue") continue;
            if (reviewResult === "stopped") return;
          }

          const malformedToolUseBlock =
            workflowMode === "plan" &&
            !callbacks.getIsPlanApproved() &&
            containsToolUseBlock(streamText) &&
            normalizedBase.toolCalls.length === 0;
          if (malformedToolUseBlock && !usedMalformedToolUseRecoveryPrompt) {
            usedMalformedToolUseRecoveryPrompt = true;
            logAgentEvent("tool_protocol_parse_failed", {
              iteration,
              workflowMode,
              turnIntent,
              reason: "unparsed_tool_use_block",
              preview: summarizeProtocolFragmentForLog(streamText),
            });
            callbacks.onStatusChange("running");
            callbacks.appendMessage({
              role: "user",
              content: buildMalformedToolUseRecoveryPrompt(callbacks.getPreferredLanguage()),
            });
            continue;
          }

          consecutiveEmptyResponseCount++;
          emptyResponseCountThisTurn++;
          if (
            workflowMode === "chat" &&
            runtimeIntent === "respond" &&
            emptyResponseCountThisTurn >= 2
          ) {
            const repeatedTargets = summarizeRepeatedExecuteTargets(recentToolActivity.slice(-12));
            logAgentEvent("loop_stop", {
              reason: "empty_model_response",
              iteration,
              consecutiveEmptyResponseCount,
              emptyResponseCountThisTurn,
              repeatedTargets,
            });
            callbacks.onNonActionableStop(
              buildEmptyModelResponsePauseNotice({
                language: callbacks.getPreferredLanguage(),
                emptyResponses: emptyResponseCountThisTurn,
                repeatedTargets,
                localProfile: config.activeProfile === "local",
              }),
              "no_output",
              {
                repeatedTargets,
                recoveryReason: "empty_model_response",
                nextStep: callbacks.getPreferredLanguage() === "zh"
                  ? "复用已读上下文，要求直接总结、换目标或说明具体阻塞"
                  : "reuse cached context and ask for a direct summary, a different target, or the concrete blocker",
              },
            );
            callbacks.onStatusChange("idle");
            return;
          }
          if (workflowMode === "plan" && !callbacks.getIsPlanApproved()) {
            if (consecutiveEmptyResponseCount >= 2) {
              const closureResult = await tryClosePlanWithEvidence("empty_response_checkpoint", {
                consecutiveEmptyResponseCount,
                toolCallCount: 0,
                replyOptionCount: 0,
              });
              if (closureResult === "approved_continue") continue;
              if (closureResult === "stopped") return;
              if (closureResult === "failed") {
                logAgentEvent("plan_empty_after_closure_failed", {
                  iteration,
                  consecutiveEmptyResponseCount,
                });
              }
              logAgentEvent("loop_stop", {
                reason: "plan_empty_response_checkpoint",
                iteration,
                consecutiveEmptyResponseCount,
              });
              callbacks.onNonActionableStop(
                buildNonActionableStopMessage(callbacks.getPreferredLanguage(), "incomplete_plan"),
                "incomplete_plan",
              );
              callbacks.onStatusChange("idle");
              return;
            }

            const assistantPlaceholder = normalized.hiddenThought
              ? `<thought>\n${normalized.hiddenThought}\n</thought>`
              : "...";
            callbacks.appendMessage({
              role: "assistant",
              content: assistantPlaceholder,
            });

            callbacks.appendMessage({
              role: "user",
              content: callbacks.getPreferredLanguage() === "zh"
                ? "上一条 Plan 回复是空的。请立即继续生成可审批的正式计划：复杂实现和修复类请求默认用 write_file 或 replace_in_file 创建/更新 `.MAIN/plans/plan.md`；如果信息不足，只能用 `<user_options>` 给出关键选择。不要只返回空消息、隐藏 thinking/analysis，或伪工具占位。"
                : "The previous Plan reply was empty. Continue now with a reviewable plan: complex implementation and fix plans should use write_file or replace_in_file to create/update `.MAIN/plans/plan.md`; if information is insufficient, offer key choices with `<user_options>`. Do not return an empty message, hidden thinking/analysis only, or pseudo-tool placeholders.",
            });
            continue;
          }
          if (consecutiveEmptyResponseCount >= 3) {
            const repeatedTargets = summarizeRepeatedExecuteTargets(recentToolActivity.slice(-12));
            logAgentEvent("loop_stop", {
              reason: "empty_model_response",
              iteration,
              consecutiveEmptyResponseCount,
              emptyResponseCountThisTurn,
              repeatedTargets,
            });
            callbacks.onNonActionableStop(
              buildEmptyModelResponsePauseNotice({
                language: callbacks.getPreferredLanguage(),
                emptyResponses: consecutiveEmptyResponseCount,
                repeatedTargets,
                localProfile: config.activeProfile === "local",
              }),
              "no_output",
              {
                repeatedTargets,
                recoveryReason: "empty_model_response",
                nextStep: callbacks.getPreferredLanguage() === "zh"
                  ? "复用已读上下文，要求直接总结、换目标或说明具体阻塞"
                  : "reuse cached context and ask for a direct summary, a different target, or the concrete blocker",
              },
            );
            callbacks.onStatusChange("idle");
            return;
          }

          const shouldForcePostWriteVerification =
            workflowMode === "edit" &&
            !!recentSuccessfulProjectWrite;

          const assistantPlaceholder = normalized.hiddenThought
            ? `<thought>\n${normalized.hiddenThought}\n</thought>`
            : "...";
          callbacks.appendMessage({
            role: "assistant",
            content: assistantPlaceholder,
          });

          callbacks.appendMessage({
            role: "user",
            content:
              shouldForcePostWriteVerification
                ? buildMissingToolCallContinuationPrompt(
                    "post_write_verify",
                    callbacks.getPreferredLanguage(),
                    consecutiveEmptyResponseCount,
                  )
                : workflowMode === "chat"
                ? "上一条回复是空的。请直接输出对用户可见的 Markdown 正文来回答用户；如果确实需要工具，请使用正式工具调用。不要只返回空消息，也不要只输出不可见的 thinking/analysis 标签。现在继续。"
                : "上一条回复是空的。请继续执行，并确保这次返回可见正文或正式工具调用；不要只返回空消息，也不要只输出不可见的 thinking/analysis 标签。现在继续。",
          });
          if (shouldForcePostWriteVerification) {
            recoveringFromEmptyAssistantReplyAfterWrite = true;
          }
          continue;
        }
        consecutiveEmptyResponseCount = 0;
        consecutiveReasoningDominatedCount = 0;

        let effectiveToolCalls: Array<{ id: string; name: string; arguments: string }> =
          normalized.toolCalls.map((call) => normalizeToolCallToExecute({
            id: call.id || `call_${generateId()}`,
            name: call.name,
            arguments: call.arguments,
          }, workspace));
        if (effectiveToolCalls.length > 0 && containsToolNameParameterFallback(streamText)) {
          const recoveredArgKeys = (() => {
            try {
              const parsedArgs = JSON.parse(effectiveToolCalls[0].arguments || "{}");
              return parsedArgs && typeof parsedArgs === "object" && !Array.isArray(parsedArgs)
                ? Object.keys(parsedArgs).sort()
                : [];
            } catch {
              return [];
            }
          })();
          logAgentEvent("tool_protocol_parse_recovered", {
            iteration,
            toolName: effectiveToolCalls[0].name,
            argumentKeys: recoveredArgKeys,
            workflowMode,
            turnIntent,
          });
        }
        if ((finalTextOnlyStep || chatFinalSynthesisActive) && effectiveToolCalls.length > 0) {
          callbacks.onStreamToken("__ESCALATION_RESET__:", assistantMsgId);
          const finalText = normalized.visibleText.trim();
          const repeatedTargets = summarizeRepeatedExecuteTargets(recentToolActivity.slice(-12));
          const shouldPauseUnresolvedChatRepair =
            chatFinalSynthesisActive &&
            repairExecutionRequestInChat &&
            runtimeIntent === "respond";
          logAgentEvent(chatFinalSynthesisActive ? "chat_final_synthesis_tool_calls_ignored" : "max_steps_tool_calls_ignored", {
            iteration,
            maxIterations: effectiveMaxIterations,
            reason: chatFinalSynthesisReason,
            toolCalls: effectiveToolCalls.length,
            toolNames: effectiveToolCalls.map((call) => call.name).slice(0, 8),
            visibleChars: finalText.length,
            repeatedTargets,
            unresolvedRepairRequest: shouldPauseUnresolvedChatRepair,
          });
          if (shouldPauseUnresolvedChatRepair) {
            const language = callbacks.getPreferredLanguage();
            const pauseMessage = buildExecuteNoProgressLoopPauseNotice({
              language,
              scope: "chat",
              repeats: Math.max(1, noProgressBatchRepeatCount),
              remainingTask: language === "zh"
                ? "用户要求找到问题并修复，但本轮仍停留在重复只读探索，没有产生真实修改、验证或明确阻塞。请继续时按执行意图恢复，基于已读上下文直接修改/验证，或说明缺少哪个关键输入。"
                : "The user asked to find and fix the issue, but this turn stayed in repeated read-only exploration without a real change, validation, or concrete blocker. Resume as an execution intent: patch/validate from cached context, or state the exact missing input.",
              recentActivity: recentToolActivity,
              repeatedTargets,
            });
            callbacks.onNonActionableStop(pauseMessage, "no_action", {
              phase: "paused",
              nextStep: language === "zh"
                ? "继续时应进入执行能力，复用已读证据直接修复或给出精确阻塞。"
                : "Resume with execution capabilities, reuse cached evidence, and patch or state the exact blocker.",
              repeatedTargets,
            });
            callbacks.onStatusChange("idle");
            return;
          }
          if (finalText) {
            callbacks.onAssistantFinalText(finalText, [], {
              hasToolCalls: false,
              modelAuthored: true,
            });
            const assistantHistoryText = serializeAssistantReplyForHistory(finalText, []);
            callbacks.appendMessage(buildAssistantHistoryMessage(assistantHistoryText, providerReasoningForHistory));
            emitTurnEvent({
              type: "item.completed",
              threadId: eventThreadId,
              turnId: eventTurnId,
              timestampMs: Date.now(),
              item: {
                id: assistantMsgId,
                details: {
                  type: "agent_message",
                  text: assistantHistoryText,
                },
              } as MainThreadItem,
            });
            callbacks.onStatusChange("idle");
            emitTurnCompletedEvent();
            return;
          }
          callbacks.onNonActionableStop(
            chatFinalSynthesisActive
              ? callbacks.getPreferredLanguage() === "zh"
                ? [
                    "本轮已进入收束回答模式，但模型仍尝试继续调用工具。",
                    "MAIN 已忽略这些工具调用并停止，避免继续扩大同一轮循环。",
                    repeatedTargets.length ? `重复目标：${repeatedTargets.join("、")}` : "重复目标：未定位到单一目标",
                    "下一步：请继续时要求基于已读上下文直接总结，或明确新的执行目标。",
                  ].join("\n")
                : [
                    "This turn entered final-answer synthesis mode, but the model still attempted tool calls.",
                    "MAIN ignored those calls and stopped to avoid extending the same turn loop.",
                    repeatedTargets.length ? `Repeated targets: ${repeatedTargets.join(", ")}` : "Repeated targets: none isolated",
                    "Next: resume by asking for a direct summary from existing context, or provide a new execution target.",
                  ].join("\n")
              : buildMaxStepsToolCallIgnoredNotice({
                  language: callbacks.getPreferredLanguage(),
                  iteration,
                  maxIterations: effectiveMaxIterations,
                  repeatedTargets,
                }),
            "no_action",
            {
              repeatedTargets,
              recoveryReason: chatFinalSynthesisActive ? "chat_final_synthesis_tool_call" : "max_iterations_boundary",
              nextStep: callbacks.getPreferredLanguage() === "zh"
                ? "复用已读上下文，直接总结、换目标或说明具体阻塞"
                : "reuse cached context, summarize directly, switch targets, or state the concrete blocker",
            },
          );
          callbacks.onStatusChange("idle");
          return;
        }

        const compactedProseCodeDump = shouldCompactProseCodeDump({
          workflowMode,
          turnIntent,
          visibleText: normalized.visibleText,
          toolCallCount: effectiveToolCalls.length,
          isPlanApproved: callbacks.getIsPlanApproved(),
        });
        const compactedIncompletePlanText =
          !compactedProseCodeDump &&
          workflowMode === "plan" &&
          !callbacks.getIsPlanApproved() &&
          effectiveToolCalls.length === 0 &&
          normalized.finishReason === "length" &&
          (normalizedBase.visibleText || normalized.visibleText).trim().length > 1200;
        const autoContinueReadOnlyPermission =
          effectiveToolCalls.length === 0 &&
          !compactedProseCodeDump &&
          shouldAutoContinueReadOnlyPermissionState({
            replyOptions: normalized.replyOptions,
            readOnlyAutoApproveForSession: workflowMode === "edit" || callbacks.getReadOnlyAutoApproveForSession(),
          });
        const suppressReadOnlyPermissionOptionsForToolCalls =
          effectiveToolCalls.length > 0 &&
          hasOnlyReadOnlyPermissionReplyOptions(normalized.replyOptions);
        const suppressTruncatedReadOnlyPermissionOptions =
          effectiveToolCalls.length === 0 &&
          workflowMode === "plan" &&
          !callbacks.getIsPlanApproved() &&
          normalized.finishReason === "length" &&
          hasOnlyReadOnlyPermissionReplyOptions(normalized.replyOptions);
        const suppressReadOnlyPermissionOptions =
          autoContinueReadOnlyPermission ||
          suppressReadOnlyPermissionOptionsForToolCalls ||
          suppressTruncatedReadOnlyPermissionOptions;
        const suppressPlanContinuationReplyOptions =
          effectiveToolCalls.length === 0 &&
          workflowMode === "plan" &&
          !callbacks.getIsPlanApproved() &&
          hasOnlyNonBlockingPlanReplyOptions(normalized.replyOptions);
        const suppressExecutableProposalOptionsForToolCalls =
          effectiveToolCalls.length > 0 &&
          workflowMode === "plan" &&
          !callbacks.getIsPlanApproved() &&
          hasExecutableProposalReplyOptions(normalized.replyOptions);
        const currentPlanStageForReview = callbacks.getPlanStage();
        const isApprovedPlanExecutionTurn =
          workflowMode === "plan" &&
          callbacks.getIsPlanApproved() &&
          currentPlanStageForReview === "executing";
        const suppressApprovedPlanExecutionReplyOptions =
          shouldSuppressApprovedPlanExecutionReplyOptionsState({
            replyOptions: normalized.replyOptions,
            workflowMode,
            isPlanApproved: callbacks.getIsPlanApproved(),
            planStage: currentPlanStageForReview,
          });
        const suppressNonDecisionReplyOptions =
          suppressReadOnlyPermissionOptions ||
          suppressPlanContinuationReplyOptions ||
          suppressExecutableProposalOptionsForToolCalls ||
          suppressApprovedPlanExecutionReplyOptions;
        const sourceVisibleText = normalizedBase.visibleText || normalized.visibleText;
        const hasStructuredProposal = hasTieredPlanProposal(streamText);
        const hasReadyPlanArtifacts = currentPlanStageForReview === "ready_to_execute";
        const hasReviewablePlanArtifacts = isReviewablePlanStage(currentPlanStageForReview);
        const rawFinalReplyOptions = compactedProseCodeDump || suppressNonDecisionReplyOptions
          ? []
          : normalized.replyOptions;
        const planReplyOptionsRoutedToArtifact = shouldRouteUnapprovedPlanReplyOptionsToArtifact({
          replyOptions: rawFinalReplyOptions,
          workflowMode,
          isPlanApproved: callbacks.getIsPlanApproved(),
          hasStructuredProposal,
          hasReadyPlanArtifacts,
          hasReviewablePlanArtifacts,
          sawPlanModeToolActivity,
          visibleText: sourceVisibleText,
        });
        const normalizedVisibleTextForUser = suppressReadOnlyPermissionOptions
          ? stripReadOnlyPermissionPrompt(normalized.visibleText)
          : normalized.visibleText;
        const finalVisibleText = compactedProseCodeDump
          ? buildProseCodeDumpNotice(callbacks.getPreferredLanguage(), normalized.visibleText.length)
          : compactedIncompletePlanText
          ? buildPlanFallbackNotice(callbacks.getPreferredLanguage(), sourceVisibleText.length)
          : normalizedVisibleTextForUser;
        const finalReplyOptions = planReplyOptionsRoutedToArtifact ? [] : rawFinalReplyOptions;
        let recoveredPseudoToolCall = false;
        let injectedRequiredWebResearchCall = false;
        const pseudoToolNameCandidate =
          effectiveToolCalls.length === 0 &&
          finalReplyOptions.length === 0 &&
          !compactedProseCodeDump &&
          !compactedIncompletePlanText
            ? extractPseudoToolCallName(normalized.visibleText) ||
              extractPseudoToolCallName(normalized.hiddenThought) ||
              extractPseudoToolCallName(streamText)
            : null;
        if (pseudoToolNameCandidate) {
          const pseudoRecovery = choosePseudoToolRecovery({
            pseudoToolName: pseudoToolNameCandidate,
            availableToolNames,
            mentionedPaths: extractUserMentionedFilePathsFromMessages(callbacks.getMessages()),
            workflowMode,
            turnIntent,
          });
          if (pseudoRecovery.call) {
            recoveredPseudoToolCall = true;
            effectiveToolCalls = [pseudoRecovery.call];
            callbacks.onStreamToken("__ESCALATION_RESET__:", assistantMsgId);
            logAgentEvent("pseudo_tool_recovered", {
              iteration,
              requestedToolName: pseudoRecovery.requestedToolName,
              recoveredToolName: pseudoRecovery.recoveredToolName,
              reason: pseudoRecovery.reason,
              argumentKeys: pseudoRecovery.argumentKeys,
              mentionedPathCount: pseudoRecovery.mentionedPathCount,
              workflowMode,
              turnIntent,
            });
          } else {
            logAgentEvent("pseudo_tool_recovery_unavailable", {
              iteration,
              requestedToolName: pseudoRecovery.requestedToolName,
              reason: pseudoRecovery.reason,
              mentionedPathCount: pseudoRecovery.mentionedPathCount,
              workflowMode,
              turnIntent,
            });
          }
        }
        const shouldInjectRequiredWebResearchCall =
          webSearchEnabled &&
          workflowMode === "chat" &&
          runtimeIntent === "respond" &&
          effectiveToolCalls.length === 0 &&
          finalReplyOptions.length === 0 &&
          availableToolNames.has("web_search") &&
          shouldRequireWebResearchForPrompt(latestUserPromptText) &&
          !recentToolActivity.some((activity) => WEB_RESEARCH_TOOL_NAMES.has(activity.name || ""));
        if (shouldInjectRequiredWebResearchCall) {
          injectedRequiredWebResearchCall = true;
          const query = buildRequiredWebResearchQuery(latestUserPromptText);
          effectiveToolCalls = [{
            id: `call_${generateId()}`,
            name: "web_search",
            arguments: JSON.stringify({
              query,
              provider: callbacks.getWebSearchProvider?.() || "duckduckgo",
              max_results: 5,
            }),
          }];
          callbacks.onStreamToken("__ESCALATION_RESET__:", assistantMsgId);
          logAgentEvent("web_research_required_tool_injected", {
            iteration,
            workflowMode,
            turnIntent,
            runtimeIntent,
            query: truncateForLog(query, 180),
            provider: callbacks.getWebSearchProvider?.() || "duckduckgo",
            visibleChars: finalVisibleText.length,
          });
        }
        if (suppressReadOnlyPermissionOptionsForToolCalls) {
          logAgentEvent("readonly_permission_options_ignored_for_tool_call", {
            iteration,
            toolCalls: effectiveToolCalls.length,
            replyOptions: normalized.replyOptions.length,
            workflowMode,
            turnIntent,
          });
        }
        if (suppressTruncatedReadOnlyPermissionOptions) {
          logAgentEvent("truncated_readonly_permission_options_ignored", {
            iteration,
            replyOptions: normalized.replyOptions.length,
            hiddenThoughtChars: normalized.hiddenThought.length,
            visibleChars: normalized.visibleText.length,
            workflowMode,
            turnIntent,
          });
        }
        if (suppressPlanContinuationReplyOptions) {
          logAgentEvent("plan_continuation_reply_options_ignored", {
            iteration,
            replyOptions: normalized.replyOptions.length,
            optionPreview: summarizeReplyOptionsForLog(normalized.replyOptions),
            visibleChars: normalized.visibleText.length,
            workflowMode,
            turnIntent,
          });
        }
        if (suppressExecutableProposalOptionsForToolCalls) {
          logAgentEvent("plan_executable_reply_options_ignored_for_tool_call", {
            iteration,
            toolCalls: effectiveToolCalls.length,
            replyOptions: normalized.replyOptions.length,
            optionPreview: summarizeReplyOptionsForLog(normalized.replyOptions),
            workflowMode,
            turnIntent,
          });
        }
        if (suppressApprovedPlanExecutionReplyOptions) {
          logAgentEvent("approved_plan_execution_reply_options_ignored", {
            iteration,
            replyOptions: normalized.replyOptions.length,
            optionPreview: summarizeReplyOptionsForLog(normalized.replyOptions),
            visibleChars: normalized.visibleText.length,
            workflowMode,
            turnIntent,
            runtimeIntent,
            planStage: currentPlanStageForReview,
          });
        }
        if (planReplyOptionsRoutedToArtifact) {
          logAgentEvent("plan_reply_options_routed_to_artifact", {
            iteration,
            replyOptions: rawFinalReplyOptions.length,
            optionPreview: summarizeReplyOptionsForLog(rawFinalReplyOptions),
            sawPlanModeToolActivity,
            visibleChars: sourceVisibleText.length,
            workflowMode,
            turnIntent,
          });
        }
        const pseudoToolCallPlaceholder =
          effectiveToolCalls.length === 0 &&
          finalReplyOptions.length === 0 &&
          !compactedProseCodeDump &&
          !compactedIncompletePlanText &&
          (
            looksLikePseudoToolCallPlaceholder(normalized.visibleText) ||
            looksLikePseudoToolCallPlaceholder(normalized.hiddenThought) ||
            looksLikeNonStandardToolCallFormat(streamText)
          );
        const syntheticVisibleConclusion =
          !compactedProseCodeDump &&
          !compactedIncompletePlanText &&
          (recoveredPseudoToolCall || isSyntheticVisibleConclusion(finalVisibleText) || pseudoToolCallPlaceholder);
        const userVisibleText = syntheticVisibleConclusion ? "" : finalVisibleText;
        if (syntheticVisibleConclusion) {
          callbacks.onStreamToken("__ESCALATION_RESET__:", assistantMsgId);
          logAgentEvent("synthetic_visible_conclusion_suppressed", {
            iteration,
            workflowMode,
            turnIntent,
            hiddenThoughtChars: normalized.hiddenThought.length,
            toolCalls: effectiveToolCalls.length,
          });
        }
        if (finalReplyOptions.length > 0) {
          logAgentEvent("reply_options_detected", {
            iteration,
            replyOptions: finalReplyOptions.length,
            optionPreview: summarizeReplyOptionsForLog(finalReplyOptions),
            toolCalls: effectiveToolCalls.length,
            workflowMode,
            turnIntent,
          });
        }

        const recentReadOnlyActivityCountForChat = recentToolActivity.filter((activity) =>
          activity.status === "succeeded" && PLAN_EXPLORATION_READ_ONLY_TOOLS.has(activity.name || "")
        ).length;
        if (
          !chatFinalSynthesisActive &&
          shouldTriggerChatFinalSynthesis({
            workflowMode,
            runtimeIntent,
            finishReason: normalized.finishReason,
            toolCallCount: effectiveToolCalls.length,
            visibleChars: userVisibleText.length,
            recentReadOnlyActivityCount: recentReadOnlyActivityCountForChat,
            consecutiveNoToolCount,
          })
        ) {
          activateChatFinalSynthesis("length_no_tool_chat", {
            finishReason: normalized.finishReason || "unknown",
            visibleChars: userVisibleText.length,
            hiddenThoughtChars: normalized.hiddenThought.length,
            replyOptions: finalReplyOptions.length,
            recentReadOnlyActivityCount: recentReadOnlyActivityCountForChat,
          });
          callbacks.onStreamToken("__ESCALATION_RESET__:", assistantMsgId);
          callbacks.onStatusChange("running");
          continue;
        }

        const shouldRecoverToolUnavailableClaim =
          isCloudProfile &&
          iterationAllTools.length > 0 &&
          effectiveToolCalls.length === 0 &&
          finalReplyOptions.length === 0 &&
          !compactedProseCodeDump &&
          looksLikeToolUnavailableClaim(userVisibleText);

        if (shouldRecoverToolUnavailableClaim && !usedToolUnavailableRecoveryPrompt) {
          usedToolUnavailableRecoveryPrompt = true;
          logAgentEvent("tool_unavailable_claim_reprompt", {
            iteration,
            allTools: iterationAllTools.length,
            llmTools: llmTools.length,
            xmlToolsEnabled: true,
            visibleChars: userVisibleText.length,
          });
          callbacks.onStatusChange("running");
          callbacks.appendMessage({
            role: "user",
            content: buildToolUnavailableRecoveryPrompt(callbacks.getPreferredLanguage(), workflowMode),
          });
          continue;
        }

        if (pseudoToolCallPlaceholder && !usedPseudoToolCallRecoveryPrompt) {
          usedPseudoToolCallRecoveryPrompt = true;
          logAgentEvent("pseudo_tool_repair_requested", {
            iteration,
            workflowMode,
            turnIntent,
            requestedToolName: pseudoToolNameCandidate || "unknown",
            visibleChars: normalized.visibleText.length,
            hiddenThoughtChars: normalized.hiddenThought.length,
          });
          callbacks.onStatusChange("running");
          callbacks.appendMessage({
            role: "user",
            content: buildPseudoToolCallRecoveryPrompt(callbacks.getPreferredLanguage(), workflowMode),
          });
          continue;
        }

        if (pseudoToolCallPlaceholder && usedPseudoToolCallRecoveryPrompt) {
          logAgentEvent("tool_protocol_doom_loop", {
            iteration,
            workflowMode,
            turnIntent,
            requestedToolName: pseudoToolNameCandidate || "unknown",
            visibleChars: normalized.visibleText.length,
            hiddenThoughtChars: normalized.hiddenThought.length,
          });
          callbacks.onStreamToken("__ESCALATION_RESET__:", assistantMsgId);
          callbacks.onNonActionableStop(
            buildToolProtocolDoomLoopStopMessage(callbacks.getPreferredLanguage(), pseudoToolNameCandidate),
            "missing_tool_loop",
          );
          callbacks.onStatusChange("idle");
          return;
        }

        if (
          unityMcpStrictRetryPending &&
          effectiveToolCalls.length === 0 &&
          finalReplyOptions.length === 0
        ) {
          unityMcpStrictRetryPending = false;
          activateUnityMcpFallback("strict_retry_no_tool_call");
          callbacks.onStatusChange("running");
          callbacks.appendMessage({
            role: "user",
            content: callbacks.getPreferredLanguage() === "zh"
              ? "Unity MCP strict retry 仍没有产生 read_console 工具调用，本轮自动回退到本地诊断路径。请立即使用本地只读工具读取最相关日志并给出报错定位。"
              : "Unity MCP strict retry still did not produce a read_console tool call, so this turn has auto-fallbacked to local diagnostics. Use local read-only tools now and localize the console error.",
          });
          continue;
        }

        if (forceXmlTools && shouldTriggerUnityMcpStrictRetry({
          toolCallCount: effectiveToolCalls.length,
          replyOptionCount: finalReplyOptions.length,
          unityMcpFirstPhaseActive,
          unityMcpFirstIterationPending,
          unityConsoleDiagnosticsRequested,
          strictRetryAlreadyIssued: unityMcpStrictRetryIssued,
        })) {
          unityMcpFirstIterationPending = false;
          unityMcpStrictRetryPending = true;
          unityMcpStrictRetryIssued = true;
          logAgentEvent("unity_mcp_strict_retry", {
            iteration,
            reason: "first_iteration_no_tool_call",
            forceXmlTools,
            forcedTools: ["read_console", "set_active_instance"],
          });
          callbacks.onStatusChange("running");
          callbacks.appendMessage({
            role: "user",
            content: callbacks.getPreferredLanguage() === "zh"
              ? [
                  "Unity MCP 首轮没有触发工具调用。下一条只能输出一个标准 XML `<tool_use>`，不要解释、不要总结、不要使用本地日志或 run_command。",
                  "首选调用：",
                  "<tool_use>",
                  "<tool>read_console</tool>",
                  "</tool_use>",
                  "如果必须先选择 Unity 实例，先调用 `set_active_instance`；随后必须调用 `read_console`。",
                ].join("\n")
              : [
                  "Unity MCP did not produce a tool call in the first iteration. In the next reply, output exactly one standard XML `<tool_use>` block with no explanation, no summary, and no local log/run_command fallback.",
                  "Preferred call:",
                  "<tool_use>",
                  "<tool>read_console</tool>",
                  "</tool_use>",
                  "If an active Unity instance must be selected first, call `set_active_instance`; then you must call `read_console`.",
                ].join("\n"),
          });
          continue;
        }

        if (shouldTriggerUnityMcpFirstIterationFallback({
          toolCallCount: effectiveToolCalls.length,
          replyOptionCount: finalReplyOptions.length,
          unityMcpFirstPhaseActive,
          unityMcpFirstIterationPending,
          unityConsoleDiagnosticsRequested: unityConsoleDiagnosticsRequested && forceXmlTools,
        })) {
          unityMcpFirstIterationPending = false;
          activateUnityMcpFallback("first_iteration_no_tool_call");
          callbacks.onStatusChange("running");
          callbacks.appendMessage({
            role: "user",
            content: callbacks.getPreferredLanguage() === "zh"
              ? "Unity MCP 首轮没有触发工具调用。请立即改用当前可用的本地只读工具继续诊断，不要再声称将要读取。先读取最相关的日志/文件并给出发现。"
              : "Unity MCP did not produce a tool call in the first iteration. Immediately continue with currently available local read-only tools, read the most relevant logs/files now, and report findings.",
          });
          continue;
        }

        if (compactedProseCodeDump) {
          logAgentEvent("prose_code_dump_compacted", {
            iteration,
            originalVisibleChars: normalized.visibleText.length,
            compactedVisibleChars: finalVisibleText.length,
            workflowMode,
            turnIntent,
          });
        }

        const approvedPlanAuditForNoTool =
          workflowMode === "plan" &&
          callbacks.getIsPlanApproved() &&
          effectiveToolCalls.length === 0
            ? buildPlanTaskEvidenceAudit({
                tasks: callbacks.getPlanTasks(),
                evidenceLedger: callbacks.getPlanExecutionEvidenceLedger(),
                highlightNext: true,
              })
            : null;
        const approvedPlanMissingTasksForNoTool =
          workflowMode === "plan" &&
          callbacks.getIsPlanApproved() &&
          effectiveToolCalls.length === 0 &&
          approvedPlanAuditForNoTool?.totalCount === 0;
        const hasRemainingApprovedPlanTasksForNoTool =
          workflowMode === "plan" &&
          callbacks.getIsPlanApproved() &&
          effectiveToolCalls.length === 0 &&
          !!approvedPlanAuditForNoTool &&
          (!approvedPlanAuditForNoTool.allTrustedComplete || approvedPlanAuditForNoTool.pendingExternalValidation);
        const shouldSuppressApprovedPlanNoToolText =
          approvedPlanMissingTasksForNoTool || hasRemainingApprovedPlanTasksForNoTool;
        const rejectedCompletionClaim =
          shouldSuppressApprovedPlanNoToolText && looksLikePlanCompletionClaim(userVisibleText);
        const shouldHideApprovedPlanNoToolText =
          shouldSuppressApprovedPlanNoToolText && rejectedCompletionClaim;

        if (shouldSuppressApprovedPlanNoToolText && (userVisibleText.trim() || finalReplyOptions.length > 0)) {
          if (shouldHideApprovedPlanNoToolText) {
            callbacks.onStreamToken("__ESCALATION_RESET__:", assistantMsgId);
          }
          logAgentEvent(rejectedCompletionClaim ? "plan_completion_claim_rejected" : "plan_no_tool_text_suppressed", {
            iteration,
            completionClaimRejected: rejectedCompletionClaim,
            auditCompleted: approvedPlanAuditForNoTool?.completedCount ?? 0,
            auditTotal: approvedPlanAuditForNoTool?.totalCount ?? 0,
            remaining: approvedPlanAuditForNoTool?.remainingTasks.length ?? 0,
            visibleChars: userVisibleText.length,
            preservedVisibleText: !shouldHideApprovedPlanNoToolText,
          });
        }

        const languageMismatchDecision = shouldRecoverLanguageMismatchTurn({
          text: userVisibleText,
          targetLanguage: callbacks.getPreferredLanguage(),
          suppressedByPlanGuard: shouldSuppressApprovedPlanNoToolText,
          toolCallCount: effectiveToolCalls.length,
          alreadyRetried: usedLanguageMismatchRecoveryPrompt || chatFinalSynthesisActive,
        });

        if (
          languageMismatchDecision.exhausted &&
          !chatFinalSynthesisActive &&
          shouldTriggerChatFinalSynthesis({
            workflowMode,
            runtimeIntent,
            wasLanguageMismatchRecovery: true,
            languageMismatchAlreadyRetried: true,
            toolCallCount: effectiveToolCalls.length,
            visibleChars: userVisibleText.length,
            recentReadOnlyActivityCount: recentReadOnlyActivityCountForChat,
            consecutiveNoToolCount,
          })
        ) {
          activateChatFinalSynthesis("language_mismatch_after_retry", {
            detectedLanguage: languageMismatchDecision.detectedLanguage,
            visibleChars: userVisibleText.length,
          });
          callbacks.onStreamToken("__ESCALATION_RESET__:", assistantMsgId);
          callbacks.onStatusChange("running");
          continue;
        }

        if (languageMismatchDecision.action === "recover_once") {
          usedLanguageMismatchRecoveryPrompt = true;
          callbacks.onStreamToken("__ESCALATION_RESET__:", assistantMsgId);
          logAgentEvent("language_mismatch_reprompt", {
            iteration,
            targetLanguage: callbacks.getPreferredLanguage(),
            detectedLanguage: languageMismatchDecision.detectedLanguage,
            hanCount: languageMismatchDecision.hanCount,
            latinLetters: languageMismatchDecision.latinLetters,
            latinWords: languageMismatchDecision.latinWords,
            visibleChars: userVisibleText.length,
          });
          callbacks.onStatusChange("running");
          callbacks.appendMessage({
            role: "user",
            content: buildLanguageMismatchRecoveryPrompt(callbacks.getPreferredLanguage()),
          });
          continue;
        }

        let visibleAssistantText = userVisibleText;
        if (injectedRequiredWebResearchCall) {
          visibleAssistantText = "";
        }
        if (languageMismatchDecision.action === "hide_text_continue") {
          callbacks.onStreamToken("__ESCALATION_RESET__:", assistantMsgId);
          visibleAssistantText = "";
          logAgentEvent("language_mismatch_text_hidden_for_tool_calls", {
            iteration,
            targetLanguage: callbacks.getPreferredLanguage(),
            detectedLanguage: languageMismatchDecision.detectedLanguage,
            hanCount: languageMismatchDecision.hanCount,
            latinLetters: languageMismatchDecision.latinLetters,
            latinWords: languageMismatchDecision.latinWords,
            visibleChars: userVisibleText.length,
            toolCalls: effectiveToolCalls.length,
          });
        }

        if (languageMismatchDecision.exhausted) {
          logAgentEvent("language_mismatch_reprompt_exhausted", {
            iteration,
            targetLanguage: callbacks.getPreferredLanguage(),
            detectedLanguage: languageMismatchDecision.detectedLanguage,
            visibleChars: userVisibleText.length,
          });
        }

        const isAllowedUnapprovedPlanDraftMutationCall = (call: ToolCallToExecute) =>
          workflowMode === "plan" &&
          !callbacks.getIsPlanApproved() &&
          isPreApprovalPlanDraftWrite(call.name, parseToolCallArguments(call, workspace));
        const unsupportedToolCalls = effectiveToolCalls.filter((call) =>
          !availableToolNames.has(call.name) &&
          !isAllowedUnapprovedPlanDraftMutationCall(call)
        );
        const progressEligibleToolCalls = effectiveToolCalls.filter((call) =>
          availableToolNames.has(call.name) ||
          isAllowedUnapprovedPlanDraftMutationCall(call)
        );
        const hasSuppressedUnsupportedPlanToolCalls =
          workflowMode === "plan" &&
          !callbacks.getIsPlanApproved() &&
          unsupportedToolCalls.length > 0;
        const hasSubstantivePlanAssistantText =
          workflowMode === "plan" &&
          !callbacks.getIsPlanApproved() &&
          looksLikeSubstantivePlanAssistantText(visibleAssistantText);
        const toolActionNarration = progressEligibleToolCalls.length > 0
          ? buildToolActionNarration({
            calls: progressEligibleToolCalls,
            workspace,
            language: callbacks.getPreferredLanguage(),
            workflowMode,
            isPlanApproved: callbacks.getIsPlanApproved(),
            userGoal: latestUserPromptText,
            turnIntent,
            currentHypothesis: visibleAssistantText.trim() || lastAssistantTextForCheckpoint,
            previousObservation: recentToolActivity[recentToolActivity.length - 1]?.detail || "",
            userContext: turnInputContextSignals,
          })
          : null;
        const runtimeNarrationInjected = progressEligibleToolCalls.length > 0 && !visibleAssistantText.trim() && !!toolActionNarration;
        if (runtimeNarrationInjected && toolActionNarration) {
          visibleAssistantText = progressNarrationToText(toolActionNarration, callbacks.getPreferredLanguage());
          logAgentEvent("tool_action_narration_injected", {
            iteration,
            workflowMode,
            turnIntent,
            toolCalls: progressEligibleToolCalls.length,
            toolNames: progressEligibleToolCalls.map((call) => call.name).slice(0, 8),
          });
        }
        if (hasSuppressedUnsupportedPlanToolCalls) {
          logAgentEvent("plan_unsupported_tool_call_suppressed", {
            iteration,
            reason: "unavailable_before_progress",
            toolNames: unsupportedToolCalls.map((call) => call.name).slice(0, 8),
            availableToolNames: Array.from(availableToolNames).slice(0, 12),
            preservedVisibleText: visibleAssistantText.trim().length > 0,
            planRuntimePhase,
          });
        }

        if (effectiveToolCalls.length > 0 && containsToolUseBlock(streamText)) {
          const preserveScopedPlanVisibleText =
            workflowMode === "plan" &&
            !callbacks.getIsPlanApproved() &&
            visibleAssistantText.trim().length > 0;
          if (!preserveScopedPlanVisibleText) {
            callbacks.onStreamToken("__ESCALATION_RESET__:", assistantMsgId);
          }
          logAgentEvent("tool_protocol_stream_cleared", {
            iteration,
            toolCalls: effectiveToolCalls.length,
            narrationInjected: visibleAssistantText.trim().length > 0,
            preservedVisibleText: preserveScopedPlanVisibleText,
            workflowMode,
            turnIntent,
          });
        }

        const historyAssistantText = visibleAssistantText || "";
        if (historyAssistantText.trim() && !runtimeNarrationInjected) {
          lastAssistantTextForCheckpoint = historyAssistantText;
        }

        const autoContinueNonBlockingPlanChoices =
          suppressPlanContinuationReplyOptions &&
          effectiveToolCalls.length === 0 &&
          workflowMode === "plan" &&
          !callbacks.getIsPlanApproved();
        if (autoContinueNonBlockingPlanChoices) {
          logAgentEvent("plan_non_blocking_choice_auto_continue", {
            iteration,
            replyOptions: normalized.replyOptions.length,
            optionPreview: summarizeReplyOptionsForLog(normalized.replyOptions),
            visibleChars: normalized.visibleText.length,
            workflowMode,
            turnIntent,
          });
          const nonBlockingHistoryText = serializeAssistantReplyForHistory(historyAssistantText, []);
          if (nonBlockingHistoryText.trim()) {
            callbacks.appendMessage(buildAssistantHistoryMessage(nonBlockingHistoryText, providerReasoningForHistory));
          }
          callbacks.onStatusChange("running");
          callbacks.appendMessage({
            role: "user",
            content: callbacks.getPreferredLanguage() === "zh"
              ? "MAIN 已将刚才的非阻塞计划选项视为继续规划许可：不要再询问是否开始探索或是否提供路径；请立即调用一个最具体的只读工具读取/搜索缺失证据。如果证据已经足够，直接创建/更新 `.MAIN/plans/plan.md`。"
              : "MAIN treated the previous non-blocking plan options as permission to continue planning: do not ask whether to start exploration or provide paths again; immediately call one specific read/search tool for the missing evidence. If evidence is sufficient, create/update `.MAIN/plans/plan.md`.",
          });
          continue;
        }

        if (!shouldHideApprovedPlanNoToolText) {
          callbacks.onTurnSummaryReady(visibleAssistantText);
        }

        if (normalized.hiddenThought) {
          callbacks.onThought(normalized.hiddenThought);
        }

        const shouldRenderToolProgress =
          progressEligibleToolCalls.length > 0 &&
          finalReplyOptions.length === 0 &&
          !hasSubstantivePlanAssistantText;
        const shouldPreserveApprovedExecutionText =
          shouldRenderToolProgress &&
          workflowMode === "plan" &&
          callbacks.getIsPlanApproved() &&
          !runtimeNarrationInjected &&
          visibleAssistantText.trim().length > 0;
        if (!shouldHideApprovedPlanNoToolText && (visibleAssistantText || finalReplyOptions.length > 0)) {
          callbacks.onAssistantFinalText(visibleAssistantText, finalReplyOptions, {
            hasToolCalls: effectiveToolCalls.length > 0,
            visibility: hasSubstantivePlanAssistantText
              ? "substantive_plan_text"
              : shouldRenderToolProgress || shouldSuppressApprovedPlanNoToolText ? "user_progress" : undefined,
            preserveAssistantText: shouldPreserveApprovedExecutionText,
            capsuleCandidate: shouldRenderToolProgress && !runtimeNarrationInjected && visibleAssistantText.trim().length > 0,
            modelAuthored: !runtimeNarrationInjected,
            progress: shouldRenderToolProgress
              ? toolActionNarration || undefined
              : undefined,
            hiddenThought: normalized.hiddenThought,
            toolCalls: progressEligibleToolCalls.map((call) => {
              const args = parseToolCallArguments(call, workspace);
              return {
                id: call.id,
                name: call.name,
                target: getToolTarget(call.name, args),
              };
            }),
          });
        }

        if (autoContinueReadOnlyPermission) {
          consecutiveNoToolCount++;
          logAgentEvent("readonly_permission_auto_continue", {
            iteration,
            consecutiveNoToolCount,
            visibleChars: normalized.visibleText.length,
            strippedVisibleChars: finalVisibleText.length,
          });
          if (consecutiveNoToolCount >= (config.activeProfile === "local" ? 5 : MAX_NO_ACTION_RETRIES)) {
            logAgentEvent("readonly_permission_auto_continue_limit", {
              iteration,
              consecutiveNoToolCount,
              workflowMode,
              turnIntent,
              runtimeIntent,
              usedHardRecovery: usedReadOnlyPermissionHardRecoveryPrompt,
            });
            if (!usedReadOnlyPermissionHardRecoveryPrompt) {
              usedReadOnlyPermissionHardRecoveryPrompt = true;
              consecutiveNoToolCount = 0;
              if (historyAssistantText.trim()) {
                callbacks.appendMessage(buildAssistantHistoryMessage(historyAssistantText, providerReasoningForHistory));
              }
              callbacks.onStatusChange("running");
              callbacks.appendMessage({
                role: "user",
                content: buildReadOnlyPermissionHardRecoveryPrompt(callbacks.getPreferredLanguage(), workflowMode),
              });
              continue;
            }
            callbacks.onNonActionableStop(
              callbacks.getPreferredLanguage() === "zh"
                ? "本轮已暂停：模型在只读许可已授予后仍没有产生有效工具动作。恢复时请直接使用一个未缓存的定向工具调用，或基于已缓存内容继续写入/验证。"
                : "This turn is paused: after read-only permission was granted, the model still did not produce useful tool action. Resume with one uncached targeted tool call, or continue from cached content with write/validation.",
              workflowMode === "plan" ? "incomplete_plan" : "no_action",
            );
            callbacks.onStatusChange("idle");
            return;
          }

          if (historyAssistantText.trim()) {
            callbacks.appendMessage(buildAssistantHistoryMessage(historyAssistantText, providerReasoningForHistory));
          }
          callbacks.onStatusChange("running");
          callbacks.appendMessage({
            role: "user",
            content: buildReadOnlyPermissionContinuationPrompt(callbacks.getPreferredLanguage()),
          });
          continue;
        }

        if (workflowMode === "plan" && effectiveToolCalls.length > 0) {
          sawPlanModeToolActivity = true;
        }

        const hasExecutablePlanProposalOptions =
          workflowMode === "plan" &&
          !callbacks.getIsPlanApproved() &&
          hasExecutableProposalReplyOptions(rawFinalReplyOptions);
        const shouldPauseForUserChoice = shouldPauseForReplyOptions({
          replyOptions: finalReplyOptions,
          toolCallCount: effectiveToolCalls.length,
          workflowMode,
          hasStructuredProposal,
          hasReadyPlanArtifacts,
          isPlanApproved: callbacks.getIsPlanApproved(),
          forcePause: normalized.hasExplicitUserChoiceRequest,
          finishReason: normalized.finishReason,
        });
        const assistantHistoryText = serializeAssistantReplyForHistory(historyAssistantText, finalReplyOptions);
        const hasMeaningfulVisibleText = visibleAssistantText.trim().length > 0;
        const wasTruncated = normalized.finishReason === "length";
        const hiddenThoughtOnlyNoToolStop =
          effectiveToolCalls.length === 0 &&
          finalReplyOptions.length === 0 &&
          !hasMeaningfulVisibleText &&
          normalized.hiddenThought.trim().length > 0;

        logAgentEvent("normalized_turn", {
          iteration,
          visibleChars: normalized.visibleText.length,
          hiddenThoughtChars: normalized.hiddenThought.length,
          replyOptions: normalized.replyOptions.length,
          toolCalls: effectiveToolCalls.length,
          finishReason: normalized.finishReason || "unknown",
          hasStructuredProposal,
          planStage: currentPlanStageForReview,
          isPlanApproved: callbacks.getIsPlanApproved(),
        });

        if (finalReplyOptions.length > 0 && !shouldPauseForUserChoice) {
          logAgentEvent("reply_options_rejected", {
            iteration,
            reason: wasTruncated ? "truncated_inferred_options" : "non_pauseable_options",
            replyOptions: finalReplyOptions.length,
            optionPreview: summarizeReplyOptionsForLog(finalReplyOptions),
            finishReason: normalized.finishReason || "unknown",
            workflowMode,
            turnIntent,
          });
        }

        const planEvidenceReadinessForRedirect = assessPlanEvidenceReadiness({
          userContext: turnInputContextSignals,
          recentToolActivity: recentPlanToolActivity,
          hasObservedUserContext: hasPlanUserContextObservation(
            callbacks.getMessages() as AgentMessage[],
            lastAssistantTextForCheckpoint || visibleAssistantText,
          ),
        });
        const shouldRedirectPostConvergenceToolCalls = shouldRedirectPlanToolsAfterReadOnlyConvergence({
          workflowMode,
          isPlanApproved: callbacks.getIsPlanApproved(),
          convergencePromptAlreadyUsed: usedPlanReadOnlyConvergencePrompt,
          hasPlanDecisionOutput: hasStructuredProposal || finalReplyOptions.length > 0 || hasReviewablePlanArtifacts,
          toolNames: effectiveToolCalls
            .filter((call) => !isAllowedUnapprovedPlanDraftMutationCall(call))
            .map((call) => call.name),
          evidenceReadiness: planEvidenceReadinessForRedirect.status,
          planRuntimePhase,
        });
        if (shouldRedirectPostConvergenceToolCalls) {
          if (hasMeaningfulVisibleText) {
            callbacks.appendMessage(buildAssistantHistoryMessage(assistantHistoryText, providerReasoningForHistory));
          } else {
            callbacks.onStreamToken("__ESCALATION_RESET__:", assistantMsgId);
          }
          logAgentEvent("plan_post_convergence_tool_redirect", {
            iteration,
            redirectCount: planPostConvergenceToolRedirectCount + 1,
            toolNames: effectiveToolCalls.map((call) => call.name).slice(0, 8),
            imageParts: turnInputContextSignals.imageParts,
            mentionedFilePaths: turnInputContextSignals.mentionedFilePaths.length,
            attachedFilePaths: turnInputContextSignals.attachedFilePaths.length,
            preservedVisibleText: hasMeaningfulVisibleText,
            evidenceReadiness: planEvidenceReadinessForRedirect.status,
            evidenceReadinessReason: planEvidenceReadinessForRedirect.reason,
            planRuntimePhase,
          });
          logAgentEvent("plan_unsupported_tool_call_suppressed", {
            iteration,
            reason: "post_convergence_readonly_tool",
            toolNames: effectiveToolCalls.map((call) => call.name).slice(0, 8),
            availableToolNames: Array.from(availableToolNames).slice(0, 12),
            preservedVisibleText: hasMeaningfulVisibleText,
            evidenceReadiness: planEvidenceReadinessForRedirect.status,
            evidenceReadinessReason: planEvidenceReadinessForRedirect.reason,
            planRuntimePhase,
            qualityGateReason: planLastQualityGateReason,
            missingSections: planLastMissingSections,
          });

          // P1 improvement: handle drafting-phase suppressed reads gracefully.
          // If the model is in drafting and wants a read tool we didn't allow,
          // inject a targeted hint instead of redirecting to needs_evidence.
          const suppressedToolNames = effectiveToolCalls.map((c) => c.name);
          const isDraftingReadAttempt =
            planRuntimePhase === "drafting" &&
            suppressedToolNames.some((t) =>
              t === "read_file" || t === "read_document" || t === "get_file_outline"
            );
          if (isDraftingReadAttempt && planDraftingRecoveryReadCount < 3) {
            // Allow up to 3 controlled recovery reads during drafting.
            // Instead of immediately redirecting to needs_evidence (which causes
            // drafting→needs_evidence→drafting pendulum swings), let the model
            // read the specific files it needs while nudging it toward writing.
            planDraftingRecoveryReadCount += 1;
            planReasoningOnlyRecoveryPasses += 1;
            const isUrgent = planDraftingRecoveryReadCount >= 2;
            const urgencyHint = isUrgent
              ? (callbacks.getPreferredLanguage() === "zh"
                ? `【紧急恢复读取 ${planDraftingRecoveryReadCount}/3】drafting 阶段只允许写文件，但你还需要读取：${suppressedToolNames.join(", ")}。请先读取具体文件，然后立即写入 plan.md，不要再尝试其他只读工具。`
                : `[URGENCY ${planDraftingRecoveryReadCount}/3] You are in drafting phase but need to read: ${suppressedToolNames.join(", ")}. Read the file now, then immediately write plan.md with write_file or replace_in_file. Do not attempt additional read tools after this.`)
              : (callbacks.getPreferredLanguage() === "zh"
                ? `定向恢复读取提示：当前处于 drafting 阶段，请尝试读取缺失的证据文件后直接写入 plan.md。你刚才尝试调用的工具：${suppressedToolNames.join(", ")}。请用最具体的文件路径读取，然后写计划。`
                : `Controlled recovery read hint: You are in drafting phase. Try reading the missing evidence file then write plan.md directly. Tools you attempted: ${suppressedToolNames.join(", ")}. Use the most specific file path for reading, then produce the plan.`);
            callbacks.appendMessage({
              role: "user",
              content: urgencyHint,
            });
            logAgentEvent("plan_drafting_recovery_read_injected", {
              iteration,
              attemptedTools: suppressedToolNames,
              planDraftingRecoveryReadCount,
              urgency: isUrgent,
            });
            continue;
          }

          const suppressedRecoveryDecision = resolvePlanSuppressedToolRecovery({
            workflowMode,
            isPlanApproved: callbacks.getIsPlanApproved(),
            evidenceReadiness: planEvidenceReadinessForRedirect.status,
            targetedRecoveryPasses: Math.max(planEvidenceRecoveryPasses, planReasoningOnlyRecoveryPasses),
          });
          logAgentEvent("plan_suppressed_tool_recovery_decision", {
            iteration,
            action: suppressedRecoveryDecision.action,
            reason: suppressedRecoveryDecision.reason,
            evidenceReadiness: planEvidenceReadinessForRedirect.status,
            evidenceReadinessReason: planEvidenceReadinessForRedirect.reason,
            targetedRecoveryPasses: Math.max(planEvidenceRecoveryPasses, planReasoningOnlyRecoveryPasses),
          });
          if (suppressedRecoveryDecision.action === "targeted_evidence") {
            planReasoningOnlyRecoveryPasses += 1;
            setPlanRuntimePhase("needs_evidence", planEvidenceReadinessForRedirect.reason);
            callbacks.onStatusChange("running");
            callbacks.appendMessage({
              role: "user",
              content: buildPlanTargetedEvidenceRecoveryPrompt({
                language: callbacks.getPreferredLanguage(),
                reason: planEvidenceReadinessForRedirect.reason,
              }),
            });
            continue;
          }
          if (suppressedRecoveryDecision.action === "pause_blocked") {
            // Instead of blocking and returning a non-actionable stop,
            // inject a strong directive that forces the model to write the plan
            // using only the evidence it has already gathered.
            planPostConvergenceToolRedirectCount += 1;
            setPlanRuntimePhase("drafting", "recovery exhausted, write with existing evidence");
            callbacks.onStatusChange("running");
            callbacks.appendMessage({
              role: "user",
              content: callbacks.getPreferredLanguage() === "zh"
                ? `【强制写入提示】定向补证和恢复读取已全部使用完毕，证据已充分。请立即停止尝试任何只读工具，直接使用 write_file 或 replace_in_file 创建或更新 .MAIN/plans/plan.md。如果你认为还需要某个具体文件的信息，在计划中将该缺失信息标记为"用户待提供"并写入计划；否则现在就写。`
                : `[FORCED WRITE] All targeted evidence recovery passes and controlled recovery reads are exhausted — you have sufficient evidence. Immediately stop attempting read tools and use write_file or replace_in_file to create or update .MAIN/plans/plan.md. If you believe a specific file is missing, mark it as "pending user input" within the plan itself; otherwise write the plan now.`,
            });
            logAgentEvent("plan_suppressed_tool_forced_write_injected", {
              iteration,
              reason: planEvidenceReadinessForRedirect.reason,
              evidenceReadiness: planEvidenceReadinessForRedirect.status,
            });
            continue;
          }

          planPostConvergenceToolRedirectCount += 1;
          if (String(planRuntimePhase) !== "needs_rewrite") {
            setPlanRuntimePhase("drafting", "read-only tool suppressed");
          }
          callbacks.onStatusChange("running");
          const shouldIssueAutoScaffold =
            planPostConvergenceToolRedirectCount >= 2 &&
            planQualityRejectCount >= 1 &&
            !planAutoScaffoldPromptIssued;
          if (shouldIssueAutoScaffold) {
            planAutoScaffoldPromptIssued = true;
            setPlanRuntimePhase("needs_rewrite", "auto scaffold after repeated blocked reads");
            callbacks.appendMessage({
              role: "user",
              content: buildPlanAutoScaffoldPrompt({
                language: callbacks.getPreferredLanguage(),
                latestUserPromptText,
                recentToolActivity: recentPlanToolActivity,
                qualityGateReason: planLastQualityGateReason,
                missingSections: planLastMissingSections,
              }),
            });
            continue;
          }
          callbacks.appendMessage({
            role: "user",
            content: buildPlanPostConvergenceToolRedirectPrompt({
              language: callbacks.getPreferredLanguage(),
              toolNames: effectiveToolCalls.map((call) => call.name),
              userContext: turnInputContextSignals,
              phase: planRuntimePhase,
              qualityGateReason: planLastQualityGateReason,
              missingSections: planLastMissingSections,
              rejectCount: planQualityRejectCount,
            }),
          });
          continue;
        }

        // 4. Handle turn termination or continuation
        if (shouldPauseForUserChoice && !shouldSuppressApprovedPlanNoToolText) {
          logAgentEvent("reply_options_pause", {
            iteration,
            replyOptions: finalReplyOptions.length,
            optionPreview: summarizeReplyOptionsForLog(finalReplyOptions),
            droppedToolCalls: effectiveToolCalls.length,
            workflowMode,
            turnIntent,
          });
          if (workflowMode === "plan" && !callbacks.getIsPlanApproved()) {
            logAgentEvent("plan_user_choice_checkpoint", {
              iteration,
              replyOptions: finalReplyOptions.length,
              optionPreview: summarizeReplyOptionsForLog(finalReplyOptions),
              hasStructuredProposal,
              planStage: currentPlanStageForReview,
            });
          }
          callbacks.appendMessage(buildAssistantHistoryMessage(assistantHistoryText, providerReasoningForHistory));
          emitTurnEvent({
            type: "item.completed",
            threadId: eventThreadId,
            turnId: eventTurnId,
            timestampMs: Date.now(),
            item: {
              id: assistantMsgId,
              details: {
                type: "agent_message",
                text: assistantHistoryText,
              },
            } as MainThreadItem,
          });
          callbacks.onStatusChange("idle");
          emitTurnCompletedEvent();
          return;
        }

        if (isApprovedPlanExecutionTurn && effectiveToolCalls.length === 0 && shouldSuppressApprovedPlanNoToolText) {
          callbacks.onStatusChange("running");
          consecutiveNoToolCount++;
          const language = callbacks.getPreferredLanguage();
          const approvedPlanTasks = approvedPlanAuditForNoTool?.tasks || callbacks.getPlanTasks();
          const approvedPlanMissingTasks = (approvedPlanAuditForNoTool?.totalCount || 0) === 0;
          const remainingText = approvedPlanAuditForNoTool
            ? formatPlanAuditRemainingTasks(
                approvedPlanAuditForNoTool,
                language,
                language === "zh"
                  ? "- 先派生 runtime 任务清单；只有长任务或需要审计留档时才生成 `.MAIN/plans/tasks.md`，再执行源码或交付物写入。"
                  : "- First derive a runtime task list; generate `.MAIN/plans/tasks.md` only for long work or audit-file needs, then execute source or deliverable writes.",
              )
            : language === "zh"
            ? "- 先派生 runtime 任务清单；只有长任务或需要审计留档时才生成 `.MAIN/plans/tasks.md`，再执行源码或交付物写入。"
            : "- First derive a runtime task list; generate `.MAIN/plans/tasks.md` only for long work or audit-file needs, then execute source or deliverable writes.";
          const validationBoundary = resolveApprovedPlanValidationBoundary({
            audit: approvedPlanAuditForNoTool,
            availableToolNames,
          });
          const browserValidationAvailable = hasBrowserValidationCapability(availableToolNames);
          const truncatedAfterCachedReadOnly =
            wasTruncated &&
            !sawExecuteOperationEvidence &&
            recentPlanToolActivity.slice(-4).some(isCachedReadOnlyPlanActivity);

          if (validationBoundary === "pause_external_validation" && approvedPlanAuditForNoTool) {
            logAgentEvent("plan_execution_validation_boundary", {
              iteration,
              reason: "external_validation_unavailable",
              auditCompleted: approvedPlanAuditForNoTool.completedCount,
              auditTotal: approvedPlanAuditForNoTool.totalCount,
              remaining: approvedPlanAuditForNoTool.remainingTasks.length,
              pendingUserValidation: approvedPlanAuditForNoTool.pendingUserValidationTasks.length,
              browserValidationAvailable,
            });
            emitPlanExecutionProgress("paused", {
              currentTask: language === "zh" ? "待用户验证" : "pending user validation",
              nextStep: language === "zh"
                ? "自动验证能力不足，等待用户完成浏览器/Tauri/人工确认"
                : "automation boundary reached; wait for browser/Tauri/user confirmation",
            });
            callbacks.onNonActionableStop(
              buildApprovedPlanValidationPendingMessage({
                language,
                audit: approvedPlanAuditForNoTool,
                browserValidationAvailable,
              }),
              "incomplete_plan",
            );
            callbacks.onStatusChange("idle");
            return;
          }

          if (truncatedAfterCachedReadOnly) {
            const recoveryInput = {
              reason: "no_progress_cached_read_only_length",
              remainingText,
              logContext: {
                finishReason: normalized.finishReason || "unknown",
                hiddenThoughtChars: normalized.hiddenThought.length,
                visibleChars: normalized.visibleText.length,
              },
            };
            if (approvedPlanNoProgressRecoveryAttempts < MAX_APPROVED_PLAN_NO_PROGRESS_RECOVERY_ATTEMPTS) {
              continueApprovedPlanWithStrategySwitch(recoveryInput);
              continue;
            } else {
              pauseApprovedPlanNoProgressLoop({
                ...recoveryInput,
                repeats: Math.max(1, consecutiveNoToolCount),
              });
              return;
            }
          }

          logAgentEvent("plan_execution_no_tool_reprompt", {
            iteration,
            consecutiveNoToolCount,
            visibleChars: normalized.visibleText.length,
            completionClaimRejected: rejectedCompletionClaim,
            missingTasksArtifact: approvedPlanMissingTasks,
            auditCompleted: approvedPlanAuditForNoTool?.completedCount ?? 0,
            auditTotal: approvedPlanAuditForNoTool?.totalCount ?? 0,
            remaining: approvedPlanAuditForNoTool?.remainingTasks.length ?? 0,
          });
          approvedPlanActionOnlyRecoveryActive = true;
          approvedPlanNoToolRecoveryFileReadActive = true;
          logAgentEvent("approved_plan_no_tool_recovery_tool_surface", {
            iteration,
            allowFileRead: true,
            recoveryToolSurface: describeApprovedPlanRecoveryToolSurface(true),
            availableTools: Array.from(availableToolNames).slice(0, 24),
          });

          if (consecutiveNoToolCount >= (config.activeProfile === "local" ? 5 : MAX_NO_ACTION_RETRIES)) {
            logAgentEvent("loop_stop", {
              reason: "plan_execution_no_tool_checkpoint",
              iteration,
              consecutiveNoToolCount,
              completionClaimRejected: rejectedCompletionClaim,
              auditCompleted: approvedPlanAuditForNoTool?.completedCount ?? 0,
              auditTotal: approvedPlanAuditForNoTool?.totalCount ?? 0,
            });
            emitPlanExecutionProgress("paused", {
              nextStep: language === "zh"
                ? "恢复后先核查当前 workspace 状态，再基于 runtime 任务清单继续；只有已知存在时才读取 tasks.md"
                : "on resume, inspect current workspace state and continue from the runtime task list; read tasks.md only if it is already known to exist",
            });
            callbacks.onNonActionableStop(
              buildApprovedPlanNoToolPauseMessage(
                language,
                remainingText,
                consecutiveNoToolCount,
                approvedPlanAuditForNoTool || undefined,
                rejectedCompletionClaim,
                Array.from(availableToolNames),
              ),
              "incomplete_plan",
            );
            callbacks.onStatusChange("idle");
            return;
          }

          callbacks.appendMessage({
            role: "user",
            content: validationBoundary === "browser_prompt"
              ? buildBrowserValidationContinuationPrompt({ language, remainingText })
              : buildPlanExecutionNoToolRecoveryPrompt({
                  language,
                  missingTasksArtifact: approvedPlanMissingTasks,
                  remainingText,
                  commandHint: buildPlanCommandExecutionHint(approvedPlanTasks, language),
                  rejectedCompletionClaim,
                }),
          });
          continue;
        }

        if (effectiveToolCalls.length === 0) {
            const isExecuteRuntimeWithoutEvidence =
              workflowMode === "edit" ||
              turnIntent === "execute" ||
              runtimeIntent === "execute" ||
              runtimeIntent === "studio_workflow";
            const rejectedExecuteCompletionClaim =
              isExecuteRuntimeWithoutEvidence &&
              finalReplyOptions.length === 0 &&
              !sawExecuteOperationEvidence &&
              looksLikeOperationCompletionClaim(visibleAssistantText || userVisibleText);
            if (rejectedExecuteCompletionClaim) {
              callbacks.onStreamToken("__ESCALATION_RESET__:", assistantMsgId);
              callbacks.onStatusChange("running");
              consecutiveNoToolCount++;
              logAgentEvent("execute_completion_claim_without_evidence", {
                iteration,
                consecutiveNoToolCount,
                workflowMode,
                turnIntent,
                runtimeIntent,
                visibleChars: (visibleAssistantText || userVisibleText).length,
              });

              if (consecutiveNoToolCount >= (config.activeProfile === "local" ? 5 : MAX_NO_ACTION_RETRIES)) {
                logAgentEvent("loop_stop", {
                  reason: "execute_completion_claim_without_evidence",
                  iteration,
                  consecutiveNoToolCount,
                });
                callbacks.onNonActionableStop(
                  buildNonActionableStopMessage(callbacks.getPreferredLanguage(), "plain_text_execution"),
                  "no_action",
                );
                callbacks.onStatusChange("idle");
                return;
              }

              callbacks.appendMessage({
                role: "user",
                content: buildExecuteCompletionEvidencePrompt(callbacks.getPreferredLanguage(), consecutiveNoToolCount),
              });
              continue;
            }

            const rejectedExecuteReplanningText =
              isExecuteRuntimeWithoutEvidence &&
              finalReplyOptions.length === 0 &&
              !sawExecuteOperationEvidence &&
              looksLikeExecutionReplanningText(visibleAssistantText || userVisibleText);
            if (rejectedExecuteReplanningText) {
              callbacks.onStreamToken("__ESCALATION_RESET__:", assistantMsgId);
              callbacks.onStatusChange("running");
              consecutiveNoToolCount++;
              logAgentEvent("execute_replanning_text_without_evidence", {
                iteration,
                consecutiveNoToolCount,
                workflowMode,
                turnIntent,
                runtimeIntent,
                visibleChars: (visibleAssistantText || userVisibleText).length,
              });

              if (consecutiveNoToolCount >= (config.activeProfile === "local" ? 5 : MAX_NO_ACTION_RETRIES)) {
                logAgentEvent("loop_stop", {
                  reason: "execute_replanning_text_without_evidence",
                  iteration,
                  consecutiveNoToolCount,
                });
                callbacks.onNonActionableStop(
                  buildNonActionableStopMessage(callbacks.getPreferredLanguage(), "plain_text_execution"),
                  "no_action",
                );
                callbacks.onStatusChange("idle");
                return;
              }

              callbacks.appendMessage({
                role: "user",
                content: buildExecuteReplanningEvidencePrompt(callbacks.getPreferredLanguage(), consecutiveNoToolCount),
              });
              continue;
            }

            const shouldRecoverExecuteXmlText =
              shouldRecoverExecuteXmlTextWithoutAction({
                workflowMode,
                turnIntent,
                runtimeIntent,
                forceXmlTools,
                availableToolCount: availableToolNames.size,
                toolCallCount: effectiveToolCalls.length,
                replyOptionCount: shouldPauseForUserChoice ? finalReplyOptions.length : 0,
                sawExecuteOperationEvidence,
                visibleText: visibleAssistantText || userVisibleText,
              });
            if (shouldRecoverExecuteXmlText) {
              callbacks.onStreamToken("__ESCALATION_RESET__:", assistantMsgId);
              callbacks.onStatusChange("running");
              consecutiveNoToolCount++;
              logAgentEvent("execute_xml_text_without_action", {
                iteration,
                consecutiveNoToolCount,
                workflowMode,
                turnIntent,
                runtimeIntent,
                visibleChars: (visibleAssistantText || userVisibleText).length,
                availableToolCount: availableToolNames.size,
              });

              if (consecutiveNoToolCount >= (config.activeProfile === "local" ? 5 : MAX_NO_ACTION_RETRIES)) {
                logAgentEvent("loop_stop", {
                  reason: "execute_xml_text_without_action",
                  iteration,
                  consecutiveNoToolCount,
                });
                callbacks.onNonActionableStop(
                  buildNonActionableStopMessage(callbacks.getPreferredLanguage(), "plain_text_execution"),
                  "no_action",
                );
                callbacks.onStatusChange("idle");
                return;
              }

              callbacks.appendMessage({
                role: "user",
                content: buildExecuteXmlTextActionRecoveryPrompt({
                  language: callbacks.getPreferredLanguage(),
                  retryCount: consecutiveNoToolCount,
                  availableTools: Array.from(availableToolNames),
                }),
              });
              continue;
            }

            // ── Plan Mode Interception ────────────────────────────────
            // In Plan mode, only enter review when the model has either:
            // 1. submitted a valid top-level proposal payload, or
            // 2. finished writing spec artifacts up to a legacy ready_to_execute stage.
            // Ordinary summaries / progress notes stay in ChatArea only.
            if (workflowMode === "plan" && !callbacks.getIsPlanApproved() && (hasStructuredProposal || hasReviewablePlanArtifacts)) {
              let hasMaterializedStructuredProposal = hasReviewablePlanArtifacts;
              if (hasStructuredProposal && !hasReviewablePlanArtifacts) {
                const materializedProposal = await autoMaterializePlanArtifactFromVisibleText({
                  visibleText: sourceVisibleText || streamText,
                  workspace,
                  callbacks,
                  userGoal: latestUserPromptText,
                  recentToolActivity: recentPlanToolActivity,
                  attemptedTargets: attemptedPlanWriteTargets,
                  turnContext: turnInputContextSignals,
                });
                logAgentEvent(materializedProposal.ok ? "plan_structured_proposal_materialized" : "plan_structured_proposal_materialization_rejected", {
                  iteration,
                  ok: materializedProposal.ok,
                  path: materializedProposal.path || "",
                  kind: materializedProposal.kind || "",
                  reason: materializedProposal.reason || "",
                  planArtifactSource: materializedProposal.source || "",
                  visibleChars: (sourceVisibleText || streamText).length,
                  replyOptionsCount: (materializedProposal.replyOptions || []).length,
                });
                // Preserve reply options for post-validation routing
                hasMaterializedStructuredProposal = materializedProposal.ok;
              }
              if (hasMaterializedStructuredProposal) {
                setPlanRuntimePhase("review_ready", "proposal ready", "done");
                callbacks.appendMessage(buildAssistantHistoryMessage(assistantHistoryText, providerReasoningForHistory));
                const approved = await waitForPlanApprovalIfNeeded();
                if (!approved) {
                  // Aborted during plan review — preserve pending_review status
                  // so the plan panel stays visible for the user to review.
                  // stopGeneration() already handles the isGenerating flag.
                  // Only fall back to idle if something else cleared the status.
                  if (callbacks.getStatus() !== "pending_review") {
                    callbacks.onStatusChange("idle");
                  }
                  return;
                }
                // Approved — 保留计划文件给右侧 Plan 面板继续展示，由用户在文件树或计划面板中手动删除。
                callbacks.onPlanStageChanged("executing");
                const continuationPrompt = buildApprovedPlanContinuationPrompt(callbacks);
                if (callbacks.onApprovedPlanHandoff) {
                  callbacks.onApprovedPlanHandoff(continuationPrompt);
                  callbacks.onStatusChange("idle");
                  return;
                }
                const continuationMsg: AgentMessage = {
                  role: "user",
                  content: continuationPrompt,
                };
                callbacks.appendMessage(continuationMsg);
                continue;
              }
            }

            const currentPlanStage = callbacks.getPlanStage();
            const planningStillIncomplete =
              workflowMode === "plan" &&
              !callbacks.getIsPlanApproved() &&
              !hasStructuredProposal &&
              currentPlanStage !== "ready_to_execute";
            const hasMeaningfulSourcePlanText = sourceVisibleText.trim().length > 0;
            const shouldMaterializeFallbackPlan =
              planningStillIncomplete &&
              hasMeaningfulSourcePlanText &&
              !hasReviewablePlanArtifacts &&
              (sawPlanModeToolActivity || wasTruncated || hasExecutablePlanProposalOptions || planReplyOptionsRoutedToArtifact);
            const shouldTryPlanTextMaterialization =
              planningStillIncomplete &&
              hasMeaningfulSourcePlanText &&
              !hasReviewablePlanArtifacts &&
              (finalReplyOptions.length === 0 || hasExecutablePlanProposalOptions || planReplyOptionsRoutedToArtifact) &&
              !hasStructuredProposal &&
              (
                sawPlanModeToolActivity ||
                wasTruncated ||
                hasExecutablePlanProposalOptions ||
                planReplyOptionsRoutedToArtifact ||
                turnIntent === "plan" ||
                commandDirective?.action === "plan_file_change"
              );
            const shouldRefineLongPlanIntoChoice =
              planningStillIncomplete &&
              hasMeaningfulVisibleText &&
              wasTruncated &&
              !shouldMaterializeFallbackPlan;
            const shouldForcePlanContinuation = planningStillIncomplete && !hasMeaningfulVisibleText;

            if (shouldTryPlanTextMaterialization) {
              const materializedPlan = await autoMaterializePlanArtifactFromVisibleText({
                visibleText: sourceVisibleText,
                workspace,
                callbacks,
                userGoal: latestUserPromptText,
                recentToolActivity: recentPlanToolActivity,
                attemptedTargets: attemptedPlanWriteTargets,
                turnContext: turnInputContextSignals,
              });

              if (materializedPlan.ok) {
                setPlanRuntimePhase("review_ready", "materialized plan accepted", "done");
                callbacks.appendMessage(buildAssistantHistoryMessage(assistantHistoryText, providerReasoningForHistory));
                logAgentEvent("plan_text_materialized", {
                  iteration,
                  path: materializedPlan.path,
                  kind: materializedPlan.kind,
                  planArtifactSource: materializedPlan.source || "",
                  visibleChars: sourceVisibleText.length,
                  sawPlanModeToolActivity,
                  wasTruncated,
                });
                const approved = await waitForPlanApprovalIfNeeded();
                if (!approved) {
                  if (callbacks.getStatus() !== "pending_review") {
                    callbacks.onStatusChange("idle");
                  }
                  return;
                }
                callbacks.onPlanStageChanged("executing");
                const continuationPrompt = buildApprovedPlanContinuationPrompt(callbacks);
                if (callbacks.onApprovedPlanHandoff) {
                  callbacks.onApprovedPlanHandoff(continuationPrompt);
                  callbacks.onStatusChange("idle");
                  return;
                }
                callbacks.appendMessage({
                  role: "user",
                  content: continuationPrompt,
                });
                continue;
              }

              logAgentEvent("plan_text_materialization_rejected", {
                iteration,
                reason: materializedPlan.reason || "unknown",
                visibleChars: sourceVisibleText.length,
              });
            }

            if (shouldMaterializeFallbackPlan) {
              if (sourceVisibleText.trim()) {
                callbacks.onAssistantFinalText(sourceVisibleText, [], {
                  hasToolCalls: false,
                  visibility: "substantive_plan_text",
                });
              }
              callbacks.appendMessage(buildAssistantHistoryMessage(assistantHistoryText, providerReasoningForHistory));

              if (usedPlanRecoveryPrompt) {
                const closureResult = await tryClosePlanWithEvidence("plan_recovery_prompt_limit", {
                  rejectedVisibleChars: sourceVisibleText.length,
                  toolCallCount: effectiveToolCalls.length,
                  replyOptionCount: finalReplyOptions.length,
                });
                if (closureResult === "approved_continue") continue;
                if (closureResult === "stopped") return;
                if (closureResult === "failed") {
                  logAgentEvent("plan_empty_after_closure_failed", {
                    iteration,
                    visibleChars: sourceVisibleText.length,
                  });
                  if (!planClosureEvidenceRecoveryIssued && planEvidenceRecoveryPasses < MAX_PLAN_EVIDENCE_RECOVERY_PASSES) {
                    planClosureEvidenceRecoveryIssued = true;
                    setPlanRuntimePhase("needs_evidence", "plan closure failed");
                    callbacks.onStatusChange("running");
                    callbacks.appendMessage({
                      role: "user",
                      content: buildPlanClosureEvidenceRecoveryPrompt(
                        planLastQualityGateReason || "plan closure failed",
                      ),
                    });
                    continue;
                  }
                }
                logAgentEvent("loop_stop", {
                  reason: "plan_recovery_prompt_limit",
                  iteration,
                  visibleChars: sourceVisibleText.length,
                  finishReason: normalized.finishReason || "unknown",
                });
                callbacks.onNonActionableStop(
                  buildNonActionableStopMessage(callbacks.getPreferredLanguage(), "incomplete_plan"),
                  "incomplete_plan",
                );
                callbacks.onStatusChange("idle");
                return;
              }

              usedPlanRecoveryPrompt = true;
              logAgentEvent("plan_recovery_prompt_start", {
                iteration,
                visibleChars: sourceVisibleText.length,
                finishReason: normalized.finishReason || "unknown",
                sawPlanModeToolActivity,
              });
              callbacks.onStatusChange("running");
              callbacks.appendMessage({
                role: "user",
                content: buildPlanRecoveryPrompt(callbacks, sourceVisibleText, attemptedPlanWriteTargets),
              });
              continue;
            }

            if (shouldRefineLongPlanIntoChoice) {
              callbacks.onStatusChange("running");
              consecutiveNoToolCount++;
              logAgentEvent("plan_refine_long_output", {
                iteration,
                consecutiveNoToolCount,
                visibleChars: normalized.visibleText.length,
                finishReason: normalized.finishReason || "unknown",
              });
              if (consecutiveNoToolCount >= (config.activeProfile === "local" ? 5 : MAX_NO_ACTION_RETRIES)) {
                logAgentEvent("loop_stop", {
                  reason: "plan_refine_long_output_limit",
                  iteration,
                  consecutiveNoToolCount,
                });
                callbacks.appendMessage(buildAssistantHistoryMessage(assistantHistoryText, providerReasoningForHistory));
                callbacks.onNonActionableStop(
                  buildNonActionableStopMessage(callbacks.getPreferredLanguage(), "incomplete_plan"),
                  "incomplete_plan",
                );
                callbacks.onStatusChange("idle");
                return;
              }
              const language = callbacks.getPreferredLanguage();
              callbacks.appendMessage({
                role: "user",
                content:
                  language === "zh"
                    ? "上一条规划内容过长并发生截断。不要继续输出长篇计划，也不要写入 `.MAIN/plans/`。请把刚才内容收束成不超过 8 条要点，然后用面向用户的口吻提出 2-4 个可点击选项。每个 `<option>` 必须是用户点击后会发送的完整选择，不要写成“是否……”问题句。使用 `<user_options>` 后立刻停止等待。"
                    : "The previous planning reply was too long and was truncated. Do not continue with a long plan and do not write `.MAIN/plans/` files. Condense it into no more than 8 bullets, then offer 2-4 decision options with `<user_options>` and stop immediately.",
              });
              continue;
            }

            if (shouldForcePlanContinuation) {
              consecutiveNoToolCount++;
              if (consecutiveNoToolCount >= (config.activeProfile === "local" ? 5 : MAX_NO_ACTION_RETRIES)) {
                const closureResult = await tryClosePlanWithEvidence("force_plan_continuation_limit", {
                  rejectedVisibleChars: sourceVisibleText.length,
                  toolCallCount: effectiveToolCalls.length,
                  replyOptionCount: finalReplyOptions.length,
                });
                if (closureResult === "approved_continue") continue;
                if (closureResult === "stopped") return;
                if (closureResult === "failed") {
                  logAgentEvent("plan_empty_after_closure_failed", {
                    iteration,
                    consecutiveNoToolCount,
                  });
                }
                logAgentEvent("loop_stop", {
                  reason: "force_plan_continuation_limit",
                  iteration,
                  consecutiveNoToolCount,
                });
                callbacks.onNonActionableStop(
                  buildNonActionableStopMessage(callbacks.getPreferredLanguage(), "no_output"),
                  "no_output",
                );
                callbacks.onStatusChange("idle");
                return;
              }
              const language = callbacks.getPreferredLanguage();

              const missingStepHint =
                language === "zh"
                  ? currentPlanStage === "requirements"
                    ? "你已经有旧流程的 requirements.md，下一步必须创建/更新 `.MAIN/plans/plan.md` 作为可审批方案；如果设计方向仍不明确，只能用 `<user_options>` 给出面向用户的选择并停止。不要重复读取已读文件。"
                    : currentPlanStage === "design"
                    ? "你已经有 plan.md，下一步应输出正式 Proposal 或给用户关键选择；不要在批准前提前生成 tasks.md。"
                    : sawPlanModeToolActivity
                    ? "你已经开始做项目探索了，但还没有给出可让用户决策的规划结果。下一步应先收束分歧并询问用户。"
                    : "请先给出可让用户决策的规划问题。"
                  : currentPlanStage === "requirements"
                  ? "A legacy requirements.md exists. Next create/update `.MAIN/plans/plan.md` as the reviewable plan; if the plan direction is still unclear, offer `<user_options>` and stop. Do not repeat reads of files already in context."
                  : currentPlanStage === "design"
                  ? "plan.md exists. Next submit the formal Proposal or offer the key choices; do not generate tasks.md before approval."
                  : sawPlanModeToolActivity
                  ? "You have started project exploration but have not produced a planning result the user can decide on. Next condense the tradeoffs and ask the user."
                  : "First present a planning question the user can decide on.";

              const continuationMsg: AgentMessage = {
                role: "user",
                content:
                  language === "zh"
                    ? `当前规划还没有进入可执行阶段。${missingStepHint}\n` +
                      `${CONCISE_PLAN_ARTIFACT_HINT_ZH}\n` +
                      "请继续规划，并在本轮结束前完成以下其一：\n" +
                      "1. 用普通 Markdown 输出 3-8 条关键判断，然后用面向用户的口吻给出 2-4 个 `<user_options>` 让用户选择；每个选项必须是用户可直接点击发送的完整选择，不要写成“是否……”问题句。\n" +
                      "2. 如果信息已经足够，用 write_file 或 replace_in_file 创建/更新 `.MAIN/plans/plan.md`，提交正式可审批方案。\n" +
                      "3. 如果这是复杂实现计划，必须落盘可审批 plan.md；requirements.md 只是可选需求台账，在用户批准之前不要生成 `tasks.md` 或修改源码。\n" +
                      `${currentPlanStage === "requirements" ? "当前已经有旧流程 requirements.md，本轮不要重复读文件；请直接写入 plan.md，或用 user_options 询问设计分叉。\n" : ""}` +
                      `${wasTruncated ? "你上一条回复已经发生截断，请从中断处继续，不要重头重复。\n" : ""}` +
                      "不要只输出一句总结、结束语，或空结束符。"
                    : `The current plan has not reached an executable stage. ${missingStepHint}\n` +
                      `${CONCISE_PLAN_ARTIFACT_HINT_EN}\n` +
                      "Continue planning and complete one of these before ending this turn:\n" +
                      "1. Output 3-8 key judgments in Markdown, then offer 2-4 `<user_options>` for the user to choose from.\n" +
                      "2. If there is enough information, use write_file or replace_in_file to create/update `.MAIN/plans/plan.md` as the formal reviewable plan.\n" +
                      "3. For complex implementation planning, the reviewable plan must be persisted to plan.md; requirements.md is only an optional requirement ledger. Do not generate `tasks.md` or edit source files before approval.\n" +
                      `${currentPlanStage === "requirements" ? "A legacy requirements.md already exists. Do not repeat file reads in this turn; write plan.md directly, or ask for design choices with user_options.\n" : ""}` +
                      `${wasTruncated ? "Your previous reply was truncated; continue from the interruption point without restarting.\n" : ""}` +
                      "Do not output only a summary, sign-off, or empty stop.",
              };
              callbacks.appendMessage(continuationMsg);
              continue;
            }

            const truncatedWithoutToolCall = wasTruncated && workflowMode !== "chat";
            const missingToolCallRepromptKind = compactedProseCodeDump || truncatedWithoutToolCall
              ? "generic"
              : resolveMissingToolCallRepromptKind({
                  workflowMode,
                  visibleText: normalized.visibleText,
                  mainModeKey,
                  recentWrite: recentSuccessfulProjectWrite
                    ? {
                        lastSuccessfulToolName: recentSuccessfulProjectWrite.name,
                        lastSuccessfulTargetPath: recentSuccessfulProjectWrite.target,
                        lastSuccessfulTargetOutsidePlan: !isPlanArtifactPath(recentSuccessfulProjectWrite.target),
                        recoveringFromEmptyAssistantReply: recoveringFromEmptyAssistantReplyAfterWrite,
                      }
                    : {
                        recoveringFromEmptyAssistantReply: recoveringFromEmptyAssistantReplyAfterWrite,
                      },
                });
            const shouldRepromptForMissingToolCall =
              (!hasMeaningfulVisibleText && workflowMode !== "chat") ||
              missingToolCallRepromptKind !== "none" ||
              hiddenThoughtOnlyNoToolStop;

            if (shouldRepromptForMissingToolCall) {
              callbacks.onStatusChange("running");
              consecutiveNoToolCount++;
              if (!hasMeaningfulVisibleText) {
                callbacks.onStreamToken("__ESCALATION_RESET__:", assistantMsgId);
              }
              logAgentEvent("missing_tool_reprompt", {
                iteration,
                kind: hiddenThoughtOnlyNoToolStop
                  ? "hidden_thought_only"
                  : missingToolCallRepromptKind === "none" ? "generic" : missingToolCallRepromptKind,
                consecutiveNoToolCount,
                visibleChars: normalized.visibleText.length,
                preservedVisibleText: hasMeaningfulVisibleText,
              });
              if (consecutiveNoToolCount >= (config.activeProfile === "local" ? 5 : MAX_NO_ACTION_RETRIES)) {
                if (
                  isExecuteRuntimeWithoutEvidence &&
                  recentToolActivity.length >= 3 &&
                  !sawExecuteOperationEvidence
                ) {
                  const pauseMessage = buildExecuteNoActionPauseMessage({
                    language: callbacks.getPreferredLanguage(),
                    recentToolActivity,
                    visibleText: visibleAssistantText || userVisibleText,
                  });
                  logAgentEvent("loop_stop", {
                    reason: "execute_read_only_no_action_checkpoint",
                    iteration,
                    consecutiveNoToolCount,
                    recentToolActivity: recentToolActivity.length,
                    repeatedTargets: summarizeRepeatedPlanTargetsFromToolActivity(recentToolActivity),
                  });
                  callbacks.onNonActionableStop(
                    pauseMessage,
                    "no_action",
                    {
                      repeatedTargets: summarizeRepeatedPlanTargetsFromToolActivity(recentToolActivity),
                      recoveryReason: "execute_read_only_no_action_checkpoint",
                      nextStep: callbacks.getPreferredLanguage() === "zh"
                        ? "复用已读上下文，转向写入/验证/明确阻塞"
                        : "reuse read context and pivot to write/verify/a concrete blocker",
                    },
                  );
                  callbacks.onStatusChange("idle");
                  return;
                }
                logAgentEvent("loop_stop", {
                  reason: "missing_tool_reprompt_limit",
                  iteration,
                  consecutiveNoToolCount,
                  kind: hiddenThoughtOnlyNoToolStop
                    ? "hidden_thought_only"
                    : missingToolCallRepromptKind === "none" ? "generic" : missingToolCallRepromptKind,
                });
                callbacks.onNonActionableStop(
                  buildNonActionableStopMessage(
                    callbacks.getPreferredLanguage(),
                    hiddenThoughtOnlyNoToolStop ? "no_output" : "missing_tool_loop",
                  ),
                  hiddenThoughtOnlyNoToolStop ? "no_output" : "missing_tool_loop",
                );
                callbacks.onStatusChange("idle");
                return;
              }

              const continuationMsg: AgentMessage = {
                role: "user",
                content: hiddenThoughtOnlyNoToolStop
                  ? buildHiddenThoughtOnlyContinuationPrompt(callbacks.getPreferredLanguage(), consecutiveNoToolCount)
                  : buildMissingToolCallContinuationPrompt(
                      missingToolCallRepromptKind === "none" ? "generic" : missingToolCallRepromptKind,
                      callbacks.getPreferredLanguage(),
                      consecutiveNoToolCount,
                    ),
              };
              if (missingToolCallRepromptKind === "post_write_verify") {
                recoveringFromEmptyAssistantReplyAfterWrite = true;
              }
              callbacks.appendMessage(continuationMsg);
              continue;
            }

            if (unityConsoleDiagnosticsRequested && unityConsoleFinalVerificationRequired) {
              callbacks.onStatusChange("running");
              callbacks.appendMessage({
                role: "user",
                content: callbacks.getPreferredLanguage() === "zh"
                  ? "在输出最终结论前，必须先完成一次最终验证：先调用 refresh_unity，再调用 read_console。完成这一次验证后再给结论，不要重复多轮验证。"
                  : "Before giving the final conclusion, run one final verification pass: call refresh_unity first, then read_console. After this single verification pass, provide the conclusion without repeating more verification loops.",
              });
              continue;
            }

            // No intent detected — genuinely done
            const approvedPlanAudit = approvedPlanAuditForNoTool ||
              (workflowMode === "plan" && callbacks.getIsPlanApproved()
                ? buildPlanTaskEvidenceAudit({
                    tasks: callbacks.getPlanTasks(),
                    evidenceLedger: callbacks.getPlanExecutionEvidenceLedger(),
                    highlightNext: true,
                  })
                : null);
            const approvedPlanTasks = approvedPlanAudit?.tasks || [];
            const approvedPlanMissingTasks =
              workflowMode === "plan" &&
              callbacks.getIsPlanApproved() &&
              (approvedPlanAudit?.totalCount || 0) === 0;
            const hasRemainingApprovedPlanTasks =
              workflowMode === "plan" &&
              callbacks.getIsPlanApproved() &&
              !!approvedPlanAudit &&
              (!approvedPlanAudit.allTrustedComplete || approvedPlanAudit.pendingExternalValidation);

            if (approvedPlanMissingTasks || hasRemainingApprovedPlanTasks) {
              callbacks.onStatusChange("running");
              consecutiveNoToolCount++;
              const language = callbacks.getPreferredLanguage();
              const remainingText = approvedPlanAudit
                ? formatPlanAuditRemainingTasks(
                    approvedPlanAudit,
                    language,
                    language === "zh"
                      ? "- 先派生 runtime 任务清单；只有长任务或需要审计留档时才生成 `.MAIN/plans/tasks.md`，再执行源码或交付物写入。"
                      : "- First derive a runtime task list; generate `.MAIN/plans/tasks.md` only for long work or audit-file needs, then execute source or deliverable writes.",
                  )
                : language === "zh"
                ? "- 先派生 runtime 任务清单；只有长任务或需要审计留档时才生成 `.MAIN/plans/tasks.md`，再执行源码或交付物写入。"
                : "- First derive a runtime task list; generate `.MAIN/plans/tasks.md` only for long work or audit-file needs, then execute source or deliverable writes.";
              const validationBoundary = resolveApprovedPlanValidationBoundary({
                audit: approvedPlanAudit,
                availableToolNames,
              });
              const browserValidationAvailable = hasBrowserValidationCapability(availableToolNames);
              if (validationBoundary === "pause_external_validation" && approvedPlanAudit) {
                logAgentEvent("plan_execution_validation_boundary", {
                  iteration,
                  reason: "external_validation_unavailable",
                  auditCompleted: approvedPlanAudit.completedCount,
                  auditTotal: approvedPlanAudit.totalCount,
                  remaining: approvedPlanAudit.remainingTasks.length,
                  pendingUserValidation: approvedPlanAudit.pendingUserValidationTasks.length,
                  browserValidationAvailable,
                });
                emitPlanExecutionProgress("paused", {
                  currentTask: callbacks.getPreferredLanguage() === "zh" ? "待用户验证" : "pending user validation",
                  nextStep: callbacks.getPreferredLanguage() === "zh"
                    ? "自动验证能力不足，等待用户完成浏览器/Tauri/人工确认"
                    : "automation boundary reached; wait for browser/Tauri/user confirmation",
                });
                callbacks.onNonActionableStop(
                  buildApprovedPlanValidationPendingMessage({
                    language,
                    audit: approvedPlanAudit,
                    browserValidationAvailable,
                  }),
                  "incomplete_plan",
                );
                callbacks.onStatusChange("idle");
                return;
              }
              if (consecutiveNoToolCount >= (config.activeProfile === "local" ? 5 : MAX_NO_ACTION_RETRIES)) {
                logAgentEvent("loop_stop", {
                  reason: "remaining_plan_tasks_limit",
                  iteration,
                  consecutiveNoToolCount,
                  completionClaimRejected: rejectedCompletionClaim,
                  auditCompleted: approvedPlanAudit?.completedCount ?? 0,
                  auditTotal: approvedPlanAudit?.totalCount ?? 0,
                });
                emitPlanExecutionProgress("paused", {
                  nextStep: callbacks.getPreferredLanguage() === "zh"
                    ? "点击 Resume Execution 后重新读取当前 workspace 状态并继续"
                    : "click Resume Execution, reread current workspace state, and continue",
                });
                callbacks.onNonActionableStop(
                  buildApprovedPlanNoToolPauseMessage(
                    callbacks.getPreferredLanguage(),
                    remainingText,
                    consecutiveNoToolCount,
                    approvedPlanAudit || undefined,
                    rejectedCompletionClaim,
                    Array.from(availableToolNames),
                  ),
                  "incomplete_plan",
                );
                callbacks.onStatusChange("idle");
                return;
              }

              callbacks.appendMessage({
                role: "user",
                content:
                  validationBoundary === "browser_prompt"
                    ? buildBrowserValidationContinuationPrompt({ language, remainingText })
                    : (approvedPlanMissingTasks
                        ? buildApprovedPlanContinuationPrompt(callbacks) + "\n\n"
                        : language === "zh"
                        ? `${rejectedCompletionClaim ? "你刚才的完成声明没有通过可信证据审计；不要再输出完成总结，先继续真实执行。\n" : ""}继续执行当前任务清单中证据未满足的任务。不要重复计划说明，直接根据当前进度继续实现下一个任务；如果需要修改文件，继续使用工具调用；如果文件已读且再次读取只返回 \`FILE_UNCHANGED_STUB\`，不要继续重复读取，必须写入/替换、换目标，或明确暂停说明阻塞。凡是任务里带有 shell 命令的，一次性命令优先用 run_command 并检查 exitCode/stdout/stderr；长驻或交互式命令用 execute_command 后再用 read_pty_since/read_pty_tail/get_pty_status 检查结果。完成当前任务后，必须先产生真实文件/命令/验证证据；如果 \`.MAIN/plans/tasks.md\` 已存在，再更新对应 checkbox 为 \`[x]\`。只有所有任务证据满足后才能结束。\n下一批优先任务：\n`
                        : `${rejectedCompletionClaim ? "Your completion claim did not pass the trusted evidence audit; do not output a final summary yet, continue the real work first.\n" : ""}Continue executing tasks whose evidence is not satisfied in the current task list. Do not restate the plan; just move to the next task based on the current progress. If a file has already been read and another read only returns \`FILE_UNCHANGED_STUB\`, do not keep rereading it: write/patch, choose another target, or pause with the exact blocker. If a task includes shell commands, prefer run_command for finite commands and inspect exitCode/stdout/stderr; use execute_command for long-running or interactive commands, then verify with read_pty_since/read_pty_tail/get_pty_status. After each task, produce real file/command/verification evidence; if \`.MAIN/plans/tasks.md\` exists, update the matching checkbox to \`[x]\`. Only stop when every task has satisfied evidence.\nNext priority tasks:\n`) +
                      remainingText +
                      "\n\n" +
                      buildPlanCommandExecutionHint(approvedPlanTasks, language),
              });
              continue;
            }

            if (
              workflowMode === "plan" &&
              callbacks.getIsPlanApproved() &&
              approvedPlanAudit &&
              approvedPlanAudit.pendingUserValidationTasks.length > 0
            ) {
              const language = callbacks.getPreferredLanguage();
              emitPlanExecutionProgress("paused", {
                currentTask: language === "zh" ? "待用户验证" : "pending user validation",
                nextStep: language === "zh"
                  ? "自动部分已完成，等待用户完成剩余验证"
                  : "automated work is complete; waiting for remaining user validation",
              });
              callbacks.onNonActionableStop(
                buildApprovedPlanValidationPendingMessage({
                  language,
                  audit: approvedPlanAudit,
                  browserValidationAvailable: hasBrowserValidationCapability(availableToolNames),
                }),
                "incomplete_plan",
              );
              callbacks.onStatusChange("idle");
              return;
            }

            if (workflowMode === "plan" && callbacks.getIsPlanApproved()) {
              const finalPlanAudit = buildPlanTaskEvidenceAudit({
                tasks: callbacks.getPlanTasks(),
                evidenceLedger: callbacks.getPlanExecutionEvidenceLedger(),
                highlightNext: true,
              });
              if (finalPlanAudit.totalCount === 0 || !finalPlanAudit.allTrustedComplete || finalPlanAudit.pendingExternalValidation) {
                logAgentEvent("plan_completion_guard_reprompt", {
                  iteration,
                  completed: finalPlanAudit.completedCount,
                  total: finalPlanAudit.totalCount,
                  remaining: finalPlanAudit.remainingTasks.length,
                  pendingExternalValidation: finalPlanAudit.pendingExternalValidation,
                  pendingUserValidation: finalPlanAudit.pendingUserValidationTasks.length,
                });
                callbacks.onStatusChange("running");
                callbacks.appendMessage({
                  role: "user",
                  content: callbacks.getPreferredLanguage() === "zh"
                    ? [
                        "MAIN 的完成闸门没有通过：当前已批准 Plan 不能仅凭模型正文或单次工具结果结束。",
                        "请继续真实执行并产生文件/命令/验证证据；如果只剩浏览器/Tauri/用户验证且自动工具不可用，请暂停并说明待用户验证。",
                      ].join("\n")
                    : [
                        "MAIN's completion gate did not pass: the approved Plan cannot end from assistant prose or a single tool result alone.",
                        "Continue with real execution evidence from files, commands, or validation. If only browser/Tauri/user validation remains and automation is unavailable, pause and report pending user validation.",
                      ].join("\n"),
                });
                continue;
              }
              emitTaskOrchestratorPhase("DONE", {
                reason: "plan_evidence_complete",
                iteration,
              });
              emitPlanExecutionProgress("completed");
              callbacks.onPlanStageChanged("completed");
            }

            if (workflowMode === "plan" && !callbacks.getIsPlanApproved() && currentPlanStage !== "ready_to_execute") {
              logAgentEvent("loop_stop", {
                reason: "plan_waiting_for_user_or_summary",
                iteration,
                visibleChars: normalized.visibleText.length,
                replyOptions: normalized.replyOptions.length,
                planStage: currentPlanStage,
              });
              callbacks.appendMessage(buildAssistantHistoryMessage(assistantHistoryText, providerReasoningForHistory));
              emitTurnEvent({
                type: "item.completed",
                threadId: eventThreadId,
                turnId: eventTurnId,
                timestampMs: Date.now(),
                item: {
                  id: assistantMsgId,
                  details: {
                    type: "agent_message",
                    text: assistantHistoryText,
                  },
                } as MainThreadItem,
              });
              callbacks.onNonActionableStop(
                buildNonActionableStopMessage(callbacks.getPreferredLanguage(), "incomplete_plan"),
                "incomplete_plan",
              );
              callbacks.onStatusChange("idle");
              emitTurnCompletedEvent();
              return;
            }

            logAgentEvent("loop_stop", {
              reason: "assistant_text_done",
              iteration,
              visibleChars: normalized.visibleText.length,
              replyOptions: normalized.replyOptions.length,
            });
            callbacks.appendMessage(buildAssistantHistoryMessage(assistantHistoryText, providerReasoningForHistory));
            emitTurnEvent({
              type: "item.completed",
              threadId: eventThreadId,
              turnId: eventTurnId,
              timestampMs: Date.now(),
              item: {
                id: assistantMsgId,
                details: {
                  type: "agent_message",
                  text: assistantHistoryText,
                },
              } as MainThreadItem,
            });
            callbacks.onStatusChange("idle");
            emitTurnCompletedEvent();
            return;
          }

        // Tools have been found, reset the no-tool streak
        consecutiveNoToolCount = 0;
        usedPlanRecoveryPrompt = false;
        usedToolUnavailableRecoveryPrompt = false;
        usedPseudoToolCallRecoveryPrompt = false;
        usedMalformedToolUseRecoveryPrompt = false;
        usedLanguageMismatchRecoveryPrompt = false;
        usedReadOnlyPermissionHardRecoveryPrompt = false;
        if (unityMcpFirstIterationPending) {
          unityMcpFirstIterationPending = false;
        }
        if (unityMcpStrictRetryPending) {
          unityMcpStrictRetryPending = false;
        }
        logAgentEvent("tool_calls_detected", {
          iteration,
          count: effectiveToolCalls.length,
          names: effectiveToolCalls.map((call) => call.name).slice(0, 12),
        });
        emitTaskOrchestratorPhase("EXECUTE_STEP", {
          iteration,
          toolCalls: effectiveToolCalls.length,
          toolNames: effectiveToolCalls.map((call) => call.name).slice(0, 12),
        });

        // 4. Process tool calls
        // Append the assistant message with tool_calls
        const toolCallsForMsg: ToolCallInMessage[] = effectiveToolCalls.map((tc) => ({
          id: tc.id,
          type: "function" as const,
          function: {
            name: tc.name,
            arguments: tc.arguments,
          },
        }));

        callbacks.appendMessage(buildAssistantHistoryMessage(
          historyAssistantText,
          providerReasoningForHistory,
          { tool_calls: toolCallsForMsg },
        ));

        // Partition tool calls into auto-executable, local file read approvals,
        // spec file writes (auto-approved in Plan Mode), and review-gated tools.
        const readOnlyCalls: Array<ToolCallToExecute & { allowExternalLocalRead?: boolean }> = [];
        const localFileReadCalls: Array<ToolCallToExecute & { localFileReadPath: string }> = [];
        const specFileCalls: ToolCallToExecute[] = [];
        const writeCalls: Array<ToolCallToExecute & { skipUserReview?: boolean }> = [];
        const toolArgsByCallId = new Map<string, Record<string, unknown>>();
        const readOnlyCallSignatures = new Map<string, string>();
        const readFileWindowNarrowedNotes = new Map<string, string>();
        const queuedReadOnlySignatures = new Set<string>();
        const toolFailureSignatures = new Map<string, string>();
        let allResults: ToolExecutionResult[] = [];

        for (const tc of effectiveToolCalls) {
          let toolArgs = parseToolCallArguments(tc, workspace);
          const targetingProfile = buildCurrentTaskTargetingProfile();
          const isPlanStructureExploreTool =
            workflowMode === "plan" &&
            !callbacks.getIsPlanApproved() &&
            planRuntimePhase === "explore_structure" &&
            tc.name === "get_project_skeleton";
          if (
            tc.name === "get_project_skeleton" &&
            (targetingProfile.allowRootSkeleton || isPlanStructureExploreTool) &&
            (
              toolArgs.depth == null ||
              String(toolArgs.depth).trim() === "" ||
              Number(toolArgs.depth) > 2
            )
          ) {
            toolArgs = { ...toolArgs, depth: 2 };
            tc.arguments = JSON.stringify(toolArgs);
            logAgentEvent("task_targeting_tool_args_normalized", {
              iteration,
              tool: tc.name,
              reason: isPlanStructureExploreTool ? "plan_explore_structure_depth_clamp" : "shallow_root_skeleton_default",
              depth: 2,
              imageParts: targetingProfile.imageParts,
              hasUserProvidedContext: targetingProfile.hasUserProvidedContext,
            });
          }
          toolArgsByCallId.set(tc.id, toolArgs);
          const target = getToolTarget(tc.name, toolArgs);
          callbacks.onHarnessRunUpdate?.({
            latestTool: tc.name,
            latestToolTarget: target || null,
            toolCallId: tc.id,
            streamStatus: "tool_called",
          });
          const failureSignature = buildRepeatLoopSignature(tc.name, buildRepeatLoopArgsKey(toolArgs));
          toolFailureSignatures.set(tc.id, failureSignature);

          if ((failedToolCallCounts.get(failureSignature) ?? 0) >= 2) {
            const failureCount = failedToolCallCounts.get(failureSignature) ?? 0;
            const argsJson = typeof tc.arguments === "string" ? tc.arguments : "";
            logAgentEvent("repeated_failure_block_details", {
              iteration,
              tool: tc.name,
              arguments: argsJson,
              target,
              toolCallId: tc.id,
              failureSignature,
              failureCount,
              firstSeenIteration: iteration - (failureCount - 1),
            });
            const message = callbacks.getPreferredLanguage() === "zh"
              ? `REPEATED_FAILURE_BLOCKED: ${tc.name}${target ? ` (${target})` : ""} 已用相同参数连续失败。请先诊断最近错误，改变参数或换一条策略，不要原样重试。`
              : `REPEATED_FAILURE_BLOCKED: ${tc.name}${target ? ` (${target})` : ""} has failed repeatedly with identical arguments. Diagnose the latest error and change arguments or strategy before retrying.`;
            const _recentActivity = recentPlanToolActivity.slice(-MAX_RECENT_PLAN_TOOL_ACTIVITY);
            const _evidenceKeys = Array.from(getSessionTaskTargetingEvidence(callbacks.getSessionKey())).slice(0, 20);
            emitToolPreflightBlocked(callbacks, {
              reason: "repeated_failure_blocked",
              tool: tc.name,
              target,
              message,
              toolCallId: tc.id,
              lifecycleState: "blocked",
              evidenceChain: _recentActivity.length > 0 || _evidenceKeys.length > 0
                ? { recentToolActivity: JSON.stringify(_recentActivity.slice(-6).map((a) => `${a.name}->${a.target}`)), evidenceKeys: _evidenceKeys }
                : undefined,
            });
            callbacks.onToolError(tc.name, target, message, { toolCallId: tc.id });
            allResults.push({
              toolCallId: tc.id,
              name: tc.name,
              target,
              content: `Error: ${message}`,
              isError: true,
              lifecycleState: "blocked",
            });
            continue;
          }

          const isAllowedPlanDraftMutation =
            workflowMode === "plan" &&
            !callbacks.getIsPlanApproved() &&
            isPreApprovalPlanDraftWrite(tc.name, toolArgs);
          if (!availableToolNames.has(tc.name) && !isAllowedPlanDraftMutation) {
            const isUnapprovedPlanContext = workflowMode === "plan" && !callbacks.getIsPlanApproved();
            const message = planUnsupportedToolFeedbackMessage({
              language: callbacks.getPreferredLanguage(),
              toolName: tc.name,
              runtimeIntent,
              workflowMode,
              isPlanApproved: callbacks.getIsPlanApproved(),
              planRuntimePhase,
              availableToolNames: Array.from(availableToolNames),
            });
            logAgentEvent("plan_unsupported_tool_call_suppressed", {
              iteration,
              tool: tc.name,
              target,
              runtimeIntent,
              workflowMode,
              isPlanApproved: callbacks.getIsPlanApproved(),
              availableToolNames: Array.from(availableToolNames).slice(0, 12),
              planRuntimePhase,
              internalFeedback: isUnapprovedPlanContext,
            });
            if (!isUnapprovedPlanContext) {
              callbacks.onToolError(tc.name, target, message, { toolCallId: tc.id });
            }
            allResults.push({
              toolCallId: tc.id,
              name: tc.name,
              target,
              content: `Error: ${message}`,
              isError: true,
              lifecycleState: "blocked",
              ...(isUnapprovedPlanContext ? { internalFeedback: true, displayContent: "" } : {}),
            });
            continue;
          }

          const targetingGate = isPlanStructureExploreTool
            ? { blocked: false }
            : shouldBlockToolCallForTargeting({
                profile: targetingProfile,
                toolName: tc.name,
                args: toolArgs,
                target,
                availableToolNames,
                language: callbacks.getPreferredLanguage(),
                allowApprovedPlanDesignWrite:
                  workflowMode === "plan" &&
                  callbacks.getIsPlanApproved() &&
                  runtimeIntent === "execute",
              });
          if (targetingGate.blocked) {
            const message = targetingGate.message || (
              callbacks.getPreferredLanguage() === "zh"
                ? "TASK_TARGETING_BLOCKED: 请先使用更定向的读取或确认步骤。"
                : "TASK_TARGETING_BLOCKED: use a more targeted read or confirmation step first."
            );
            callbacks.onToolError(tc.name, target, message, { toolCallId: tc.id });
            logAgentEvent("task_targeting_tool_blocked", {
              iteration,
              tool: tc.name,
              target,
              reason: targetingGate.reason || "unknown",
              facets: targetingProfile.facets,
              preferredReadTools: targetingProfile.preferredReadTools,
              explicitPaths: targetingProfile.explicitPaths.slice(0, 8),
              symbols: targetingProfile.symbols.slice(0, 8),
              imageParts: targetingProfile.imageParts,
              hasUserProvidedContext: targetingProfile.hasUserProvidedContext,
            });
            allResults.push({
              toolCallId: tc.id,
              name: tc.name,
              target,
              content: `Error: ${message}`,
              isError: true,
              lifecycleState: "blocked",
            });
            continue;
          }

          if (
            workflowMode === "plan" &&
            callbacks.getIsPlanApproved() &&
            approvedPlanActionOnlyRecoveryActive &&
            isReadOnlyShellInspectionToolCall(tc.name, toolArgs)
          ) {
            const message = callbacks.getPreferredLanguage() === "zh"
              ? [
                  "APPROVED_PLAN_SHELL_READ_BLOCKED: 已批准计划的执行阶段不能在首次项目写入前用 shell 分页读取源码。",
                  "请复用已批准 plan.md 和已确认的源码证据，直接使用 `apply_patch`、`replace_in_file` 或 `write_file` 修改目标源码文件；写入后再运行验证命令。",
                ].join("\n")
              : [
                  "APPROVED_PLAN_SHELL_READ_BLOCKED: approved plan execution must not page source files through shell before the first project write.",
                  "Reuse the approved plan and confirmed source evidence, then call `apply_patch`, `replace_in_file`, or `write_file` against the target source file. Run validation commands after the write.",
                ].join("\n");
            callbacks.onToolError(tc.name, target, message, { toolCallId: tc.id });
            logAgentEvent("approved_plan_shell_read_blocked", {
              iteration,
              tool: tc.name,
              target,
              actionOnly: approvedPlanActionOnlyRecoveryActive,
            });
            allResults.push({
              toolCallId: tc.id,
              name: tc.name,
              target,
              content: `Error: ${message}`,
              isError: true,
              lifecycleState: "blocked",
            });
            continue;
          }

          const approvedLocalFileReadPaths = callbacks.getApprovedLocalFileReadPaths();
          const effectiveAvailableToolNames = isAllowedPlanDraftMutation
            ? new Set([...availableToolNames, tc.name])
            : availableToolNames;
          const planned = planRuntimeToolCall({
            toolCall: tc,
            workspace,
            availableToolNames: effectiveAvailableToolNames,
            capabilityRegistry: toolCapabilityRegistry,
            toolPermissionPolicy: config.toolPermissionPolicy,
            approvedLocalFileReadPaths,
            autoApproveToolScopes: callbacks.getAutoApproveToolScopes?.() || [],
            workflowMode,
            runtimeIntent,
            isPlanApproved: callbacks.getIsPlanApproved(),
            planTaskCount: callbacks.getPlanTasks().length,
            getToolTarget,
            isPreApprovalPlanDraftWrite,
            isExecutionPlanArtifactWrite,
            isTasksPlanWrite,
          });
          logAgentEvent("tool_permission_plan", {
            tool: tc.name,
            source: planned.source,
            risk: planned.risk,
            autoApproveToolScopes: callbacks.getAutoApproveToolScopes?.() || [],
            plannedAction: planned.action,
            sessionAutoApproved: planned.sessionAutoApproved,
          });
          const targetState = initialLifecycleStateForPlanAction(planned.action);
          emitTurnEvent({
            type: "item.started",
            threadId: eventThreadId,
            turnId: eventTurnId,
            timestampMs: Date.now(),
            item: {
              id: tc.id,
              details: {
                type: "tool_lifecycle",
                toolCallId: tc.id,
                tool: tc.name,
                target: planned.target,
                status: targetState,
              },
            } as MainThreadItem,
          });

          if (planned.action === "local_file_read_review" && planned.localFileReadPath) {
            localFileReadCalls.push({ id: tc.id, name: tc.name, arguments: tc.arguments, localFileReadPath: planned.localFileReadPath });
          } else if (planned.action === "auto_execute") {
            if (planned.sessionAutoApproved && planned.risk !== "local_file_read") {
              writeCalls.push({ id: tc.id, name: tc.name, arguments: tc.arguments, skipUserReview: true });
              continue;
            }
            let effectiveToolArgs = toolArgs;
            let signature = buildReadOnlyCacheSignature(tc.name, effectiveToolArgs);
            let cached = readOnlyResultCache.get(signature);
            const fileReadMetadata =
              tc.name === "read_file" && typeof toolArgs.path === "string"
                ? await readFileMetadataIfAvailable(toolArgs.path, workspace)
                : null;
            let fileReadSignature =
              tc.name === "read_file" && typeof toolArgs.path === "string"
                ? buildFileReadSignature(fileReadMetadata?.path ?? toolArgs.path, effectiveToolArgs)
                : "";
            let fileReadState = fileReadSignature ? fileReadStates.get(fileReadSignature) : undefined;
            const bypassApprovedPlanPatchRecoveryReadCache =
              (workflowMode === "plan" &&
                callbacks.getIsPlanApproved() &&
                runtimeIntent === "execute" &&
                shouldBypassApprovedPlanReadCacheForPatchRecovery({
                  toolName: tc.name,
                  allowFileRead: allowApprovedPlanRecoveryFileRead,
                })) ||
              (workflowMode === "edit" &&
                runtimeIntent === "execute" &&
                tc.name === "read_file" &&
                effectiveExecuteRecoveryFileRead);
            if (bypassApprovedPlanPatchRecoveryReadCache) {
              logAgentEvent("approved_plan_patch_recovery_read_cache_bypass", {
                iteration,
                target,
                recentActivity: (workflowMode === "plan" ? recentPlanToolActivity : recentToolActivity)
                  .slice(-4)
                  .map((activity) => ({
                    name: activity.name,
                    target: activity.target,
                    status: activity.status,
                  })),
              });
            }

            if (fileReadState && !bypassApprovedPlanPatchRecoveryReadCache) {
              const metadata = fileReadMetadata ?? await readFileMetadataIfAvailable(fileReadState.path, workspace);
              const unchanged =
                metadata != null &&
                metadata.sizeBytes === fileReadState.sizeBytes &&
                metadata.modifiedMs === fileReadState.modifiedMs;

              if (!unchanged) {
                fileReadStates.delete(fileReadSignature);
                logAgentEvent("file_read_cache_invalidated", {
                  iteration,
                  target: target || fileReadState.path,
                  reason: metadata ? "metadata_changed" : "metadata_unavailable",
                  signature: truncateForLog(fileReadSignature, 180),
                  previous: {
                    sizeBytes: fileReadState.sizeBytes,
                    modifiedMs: fileReadState.modifiedMs,
                    contentHash: fileReadState.contentHash,
                  },
                  current: metadata
                    ? {
                        sizeBytes: metadata.sizeBytes,
                        modifiedMs: metadata.modifiedMs,
                      }
                    : null,
                });
              } else {
                const duplicateCount = (readOnlyDuplicateSkipCounts.get(fileReadSignature) ?? 0) + 1;
                readOnlyDuplicateSkipCounts.set(fileReadSignature, duplicateCount);
                const planBudget = buildPlanExplorationBudget({
                  workflowMode,
                  isPlanApproved: callbacks.getIsPlanApproved(),
                  toolName: tc.name,
                  target: target || fileReadState.path,
                  duplicateCount,
                  hasTabularEvidence: hasSuccessfulTabularActivity(recentPlanToolActivity),
                  successfulReadEvidenceCount: countSuccessfulPlanReadEvidence(recentPlanToolActivity),
                });
                const shouldPushPlanReadLimit =
                  workflowMode === "plan" &&
                  !callbacks.getIsPlanApproved() &&
                  (duplicateCount >= PLAN_REPEAT_READ_LIMIT || planBudget.shouldRedirectToPlanClosure);
                if (shouldPushPlanReadLimit) {
                  logAgentEvent("plan_repeat_read_limit", {
                    iteration,
                    stage: callbacks.getPlanStage(),
                    tool: tc.name,
                    target: target || fileReadState.path,
                    duplicateCount,
                    reason: planBudget.reason || "duplicate_file_read",
                  });
                }
                logAgentEvent("file_read_cache_hit", {
                  iteration,
                  target: target || fileReadState.path,
                  decision: shouldPushPlanReadLimit ? "unchanged_stub_with_plan_redirect" : "unchanged_stub",
                  signature: truncateForLog(fileReadSignature, 180),
                  duplicateCount,
                  sizeBytes: fileReadState.sizeBytes,
                  modifiedMs: fileReadState.modifiedMs,
                  contentHash: fileReadState.contentHash,
                });
                const replayApprovedExecutionRead =
                  workflowMode === "plan" &&
                  callbacks.getIsPlanApproved() &&
                  runtimeIntent === "execute" &&
                  tc.name === "read_file" &&
                  duplicateCount >= 2 &&
                  !shouldPushPlanReadLimit;
                const baseStub = replayApprovedExecutionRead
                  ? buildFileUnchangedReplayContent(fileReadState, duplicateCount)
                  : buildFileUnchangedStub(fileReadState);
                const closurePrompt = shouldPushPlanReadLimit
                  ? `\n\n${buildPlanClosurePromptFromEvidence(callbacks, recentPlanToolActivity, attemptedPlanWriteTargets, latestUserPromptText)}`
                  : "";
                const content = shouldPushPlanReadLimit
                  ? appendPlanRepeatReadLimitGuidance(
                      `${baseStub}${closurePrompt}`,
                      callbacks.getPreferredLanguage(),
                      callbacks.getPlanStage(),
                    )
                  : baseStub;
                allResults.push({
                  toolCallId: tc.id,
                  name: tc.name,
                  target,
                  content,
                  displayContent: `${FILE_UNCHANGED_STUB}: ${target || fileReadState.path}`,
                  isError: false,
                });
                continue;
              }
            }

            if (
              tc.name === "read_file" &&
              typeof toolArgs.path === "string" &&
              fileReadMetadata &&
              !bypassApprovedPlanPatchRecoveryReadCache
            ) {
              const coverage = getReadFileCoverageForPath({
                states: fileReadStates,
                path: toolArgs.path,
                metadata: fileReadMetadata,
                currentSignature: fileReadSignature,
              });
              if (coverage.fullFileState) {
                const duplicateCount = (readOnlyDuplicateSkipCounts.get(coverage.fullFileState.signature) ?? 0) + 1;
                readOnlyDuplicateSkipCounts.set(coverage.fullFileState.signature, duplicateCount);
                const content = buildFileUnchangedStub(coverage.fullFileState);
                logAgentEvent("file_read_cache_hit", {
                  iteration,
                  target: target || coverage.fullFileState.path,
                  decision: "full_file_covers_requested_read",
                  signature: truncateForLog(coverage.fullFileState.signature, 180),
                  duplicateCount,
                  sizeBytes: coverage.fullFileState.sizeBytes,
                  modifiedMs: coverage.fullFileState.modifiedMs,
                  contentHash: coverage.fullFileState.contentHash,
                });
                allResults.push({
                  toolCallId: tc.id,
                  name: tc.name,
                  target,
                  content,
                  displayContent: `${FILE_UNCHANGED_STUB}: ${target || coverage.fullFileState.path}`,
                  isError: false,
                });
                continue;
              }

              if (coverage.ranges.length > 0) {
                const totalLines = Math.max(
                  coverage.totalLines,
                  ...coverage.ranges.map((range) => range.endLine),
                );
                const resolvedCoveragePlan = planReadFileWindowCoverage(effectiveToolArgs, totalLines, coverage.ranges);
                if (resolvedCoveragePlan.fullyCovered) {
                  const duplicateCount = (readOnlyDuplicateSkipCounts.get(fileReadSignature || signature) ?? 0) + 1;
                  readOnlyDuplicateSkipCounts.set(fileReadSignature || signature, duplicateCount);
                  const content = formatReadFileWindowCoverageStub(fileReadMetadata.path, resolvedCoveragePlan);
                  logAgentEvent("file_read_cache_hit", {
                    iteration,
                    target: target || fileReadMetadata.path,
                    decision: "window_fully_covered",
                    signature: truncateForLog(fileReadSignature || signature, 180),
                    duplicateCount,
                    requested: resolvedCoveragePlan.original,
                    coveredRanges: resolvedCoveragePlan.coveredRanges,
                  });
                  allResults.push({
                    toolCallId: tc.id,
                    name: tc.name,
                    target,
                    content,
                    displayContent: `${FILE_UNCHANGED_STUB}: ${target || fileReadMetadata.path}`,
                    isError: false,
                  });
                  continue;
                }
                if (resolvedCoveragePlan.overlapped && resolvedCoveragePlan.suggestedArgs) {
                  effectiveToolArgs = resolvedCoveragePlan.suggestedArgs;
                  signature = buildReadOnlyCacheSignature(tc.name, effectiveToolArgs);
                  cached = readOnlyResultCache.get(signature);
                  fileReadSignature = buildFileReadSignature(fileReadMetadata.path, effectiveToolArgs);
                  fileReadState = fileReadStates.get(fileReadSignature);
                  const note = formatReadFileWindowNarrowedNote(fileReadMetadata.path, resolvedCoveragePlan);
                  if (note) readFileWindowNarrowedNotes.set(tc.id, note);
                  logAgentEvent("file_read_cache_window_narrowed", {
                    iteration,
                    target: target || fileReadMetadata.path,
                    original: resolvedCoveragePlan.original,
                    suggestedRange: resolvedCoveragePlan.suggestedRange,
                    coveredRanges: resolvedCoveragePlan.coveredRanges,
                    newSignature: truncateForLog(fileReadSignature, 180),
                  });
                  if (fileReadState) {
                    readFileWindowNarrowedNotes.delete(tc.id);
                    const content = buildFileUnchangedStub(fileReadState);
                    logAgentEvent("file_read_cache_hit", {
                      iteration,
                      target: target || fileReadState.path,
                      decision: "narrowed_window_already_cached",
                      signature: truncateForLog(fileReadSignature, 180),
                      sizeBytes: fileReadState.sizeBytes,
                      modifiedMs: fileReadState.modifiedMs,
                      contentHash: fileReadState.contentHash,
                    });
                    allResults.push({
                      toolCallId: tc.id,
                      name: tc.name,
                      target,
                      content,
                      displayContent: `${FILE_UNCHANGED_STUB}: ${target || fileReadState.path}`,
                      isError: false,
                    });
                    continue;
                  }
                }
              }
            }

            if (!bypassApprovedPlanPatchRecoveryReadCache && (cached || queuedReadOnlySignatures.has(signature))) {
              const duplicateCount = (readOnlyDuplicateSkipCounts.get(signature) ?? 0) + 1;
              readOnlyDuplicateSkipCounts.set(signature, duplicateCount);
              const shouldPushReadOnlyRepeatLimit =
                duplicateCount >= 8 &&
                (workflowMode === "edit" || workflowMode === "chat" || callbacks.getIsPlanApproved());
              const planBudget = buildPlanExplorationBudget({
                workflowMode,
                isPlanApproved: callbacks.getIsPlanApproved(),
                toolName: tc.name,
                target,
                duplicateCount,
                hasTabularEvidence: hasSuccessfulTabularActivity(recentPlanToolActivity),
                successfulReadEvidenceCount: countSuccessfulPlanReadEvidence(recentPlanToolActivity),
              });
              const shouldPushPlanReadLimit =
                workflowMode === "plan" &&
                !callbacks.getIsPlanApproved() &&
                (duplicateCount >= PLAN_REPEAT_READ_LIMIT || planBudget.shouldRedirectToPlanClosure);
              if (shouldPushPlanReadLimit) {
                logAgentEvent("plan_repeat_read_limit", {
                  iteration,
                  stage: callbacks.getPlanStage(),
                  tool: tc.name,
                  target,
                  duplicateCount,
                  reason: planBudget.reason || "duplicate_read",
                });
              }
              const duplicateContent = formatCachedReadOnlyToolResult(tc.name, target, cached, duplicateCount);
              const repeatLimitGuidance = shouldPushReadOnlyRepeatLimit
                ? callbacks.getPreferredLanguage() === "zh"
                  ? [
                      `READ_ONLY_REPEAT_LIMIT: ${tc.name}${target ? ` (${target})` : ""} 已用相同参数重复 ${duplicateCount} 次，本次不会再执行真实工具。`,
                      "请复用已缓存上下文，转向写入、命令/浏览器验证、不同目标，或给出明确阻塞/结论；不要继续原样调用同一个只读工具。",
                    ].join("\n")
                  : [
                      `READ_ONLY_REPEAT_LIMIT: ${tc.name}${target ? ` (${target})` : ""} has repeated ${duplicateCount} times with identical arguments, so the real tool was not run again.`,
                      "Reuse the cached context and move to a write, command/browser validation, a different target, or a concrete blocker/final conclusion. Do not retry the same read-only call.",
                    ].join("\n")
                : "";
              const closurePrompt = shouldPushPlanReadLimit
                ? `\n\n${buildPlanClosurePromptFromEvidence(callbacks, recentPlanToolActivity, attemptedPlanWriteTargets, latestUserPromptText)}`
                : "";
              allResults.push({
                toolCallId: tc.id,
                name: tc.name,
                target,
                content: shouldPushPlanReadLimit
                  ? appendPlanRepeatReadLimitGuidance(
                      `${duplicateContent}${closurePrompt}`,
                      callbacks.getPreferredLanguage(),
                      callbacks.getPlanStage(),
                    )
                  : repeatLimitGuidance
                  ? `${repeatLimitGuidance}\n\n${duplicateContent}`
                  : duplicateContent,
                displayContent: shouldPushReadOnlyRepeatLimit
                  ? `READ_ONLY_REPEAT_LIMIT: ${target || tc.name}`
                  : undefined,
                isError: false,
              });
              continue;
            }

            queuedReadOnlySignatures.add(signature);
            readOnlyCallSignatures.set(tc.id, signature);
            if (fileReadSignature) readOnlyCallSignatures.set(`${tc.id}:file_read`, fileReadSignature);
            readOnlyCalls.push({
              id: tc.id,
              name: tc.name,
              arguments: JSON.stringify(effectiveToolArgs),
              allowExternalLocalRead:
                !!planned.localFileReadPath &&
                (planned.risk === "local_file_read" ||
                  isLocalFileReadApproved(planned.localFileReadPath, approvedLocalFileReadPaths)),
            });
          } else if (planned.action === "spec_file_auto_approved") {
            specFileCalls.push({ id: tc.id, name: tc.name, arguments: tc.arguments });
          } else if (planned.action === "blocked_plan_gate") {
            if (planned.target) attemptedPlanWriteTargets.push(planned.target);
            allResults.push(buildPlanGateBlockedResult(tc, toolArgs, callbacks, planned.reason || "pre_approval_source_write"));
          } else if (planned.action === "blocked_unavailable") {
            const message = callbacks.getPreferredLanguage() === "zh"
              ? `工具 "${tc.name}" 当前没有暴露给 ${runtimeIntent} 运行意图。请使用本轮可用工具；如果这是已批准计划的执行步骤，请继续按执行阶段恢复。`
              : `Tool "${tc.name}" is not exposed for the current ${runtimeIntent} runtime intent. Use an available tool; if this is approved plan execution, continue from the execution stage.`;
            callbacks.onToolError(tc.name, planned.target, message, { toolCallId: tc.id });
            allResults.push({
              toolCallId: tc.id,
              name: tc.name,
              target: planned.target,
              content: `Error: ${message}`,
              isError: true,
              lifecycleState: "blocked",
            });
          } else {
            const reviewSignature = buildRepeatLoopSignature(tc.name, buildRepeatLoopArgsKey(toolArgs));
            const cachedBrowserValidation =
              workflowMode === "plan" &&
              callbacks.getIsPlanApproved() &&
              runtimeIntent === "execute" &&
              tc.name === "browser_evaluate"
                ? approvedPlanBrowserValidationCache.get(reviewSignature)
                : undefined;
            if (cachedBrowserValidation) {
              logAgentEvent("approved_plan_browser_validation_reused", {
                iteration,
                target,
                signature: truncateForLog(reviewSignature, 180),
              });
              allResults.push({
                toolCallId: tc.id,
                name: tc.name,
                target,
                content: [
                  `REUSED_BROWSER_VALIDATION: identical browser_evaluate for ${target || "the same target"} already succeeded in this execution turn.`,
                  "Reuse the previous browser/DOM result and continue with the next unverified task or final summary.",
                  "",
                  truncateToolContent(cachedBrowserValidation.content || cachedBrowserValidation.displayContent || "", 4000),
                ].filter(Boolean).join("\n"),
                displayContent: `REUSED_BROWSER_VALIDATION: ${target || cachedBrowserValidation.target || "browser_evaluate"}`,
                isError: false,
                lifecycleState: "completed",
              });
              continue;
            }
            writeCalls.push({ id: tc.id, name: tc.name, arguments: tc.arguments });
          }
        }

        // Execute read-only tools concurrently (claude-code-haha pattern)
        if (readOnlyCalls.length > 0) {
          const readResults = await executeReadOnlyToolsConcurrently(
            readOnlyCalls,
            workspace,
            callbacks,
            iterationAllTools,
            hooksConfig,
            {
              turnContext: turnInputContextSignals,
              recentPlanToolActivity,
              attemptedPlanWriteTargets,
            },
          );
          const normalizedReadResults: ToolExecutionResult[] = [];
          for (const result of readResults) {
            const readFileRepeatLimitResult = isReadFileRepeatLimitResult(result);
            const narrowedNote = readFileWindowNarrowedNotes.get(result.toolCallId);
            const resultForModel = narrowedNote && !result.isError
              ? {
                  ...result,
                  content: `${narrowedNote}\n\n${result.content}`,
                  displayContent: result.displayContent || `${narrowedNote}\n\n${result.content}`,
              }
              : result;
            const signature = readOnlyCallSignatures.get(result.toolCallId);
            if (signature && !result.isError && !readFileRepeatLimitResult) {
              readOnlyResultCache.set(signature, {
                name: result.name,
                target: result.target,
                content: result.content,
              });
              readOnlyDuplicateSkipCounts.delete(signature);
            }
            const fileReadSignature = readOnlyCallSignatures.get(`${result.toolCallId}:file_read`);
            if (fileReadSignature && result.name === "read_file" && !result.isError && !readFileRepeatLimitResult) {
              const parsedCall = readOnlyCalls.find((call) => call.id === result.toolCallId);
              const args = parsedCall ? parseToolCallArguments(parsedCall, workspace) : {};
              const path = typeof args.path === "string" ? args.path : result.target;
              const metadata = await readFileMetadataIfAvailable(path, workspace);
              const contentHash = hashString(result.content);
              const previous = fileReadStates.get(fileReadSignature);
              if (metadata && (!previous || previous.contentHash !== contentHash || previous.modifiedMs !== metadata.modifiedMs || previous.sizeBytes !== metadata.sizeBytes)) {
                fileReadStates.set(fileReadSignature, {
                  signature: fileReadSignature,
                  path: metadata.path,
                  argsKey: buildRepeatLoopArgsKey(
                    Object.fromEntries(Object.entries(args).filter(([key]) => key !== "path")),
                  ),
                  contentHash,
                  contentLength: result.content.length,
                  sizeBytes: metadata.sizeBytes,
                  modifiedMs: metadata.modifiedMs,
                  modelContent: result.content,
                  updatedAt: Date.now(),
                });
                pruneFileReadStates(fileReadStates);
                logAgentEvent("file_read_cache_stored", {
                  iteration,
                  target: result.target || metadata.path,
                  signature: truncateForLog(fileReadSignature, 180),
                  reason: previous ? "content_or_metadata_changed" : "new_read",
                  cacheSize: fileReadStates.size,
                  sizeBytes: metadata.sizeBytes,
                  modifiedMs: metadata.modifiedMs,
                  contentChars: result.content.length,
                  contentHash,
                });
              }
              readOnlyDuplicateSkipCounts.delete(fileReadSignature);
            }
            normalizedReadResults.push(resultForModel);
          }
          allResults.push(...normalizedReadResults);
        }

        // Execute approved-by-user local file reads sequentially. These are read
        // tools, but the first access to each external path is intentionally
        // human-gated.
        for (const tc of localFileReadCalls) {
          const toolArgs = parseToolCallArguments(tc, workspace);
          const result = await executeLocalFileReadToolWithReview(
            tc,
            toolArgs,
            tc.localFileReadPath,
            workspace,
            callbacks,
            iterationAllTools,
            hooksConfig,
          );
          allResults.push(result);

          if (abortController.signal.aborted) {
            callbacks.onStatusChange("idle");
            return;
          }
        }

        // Execute spec file writes concurrently — auto-approved, no user review needed
        if (specFileCalls.length > 0) {
          const specResults = await executeReadOnlyToolsConcurrently(
            specFileCalls,
            workspace,
            callbacks,
            iterationAllTools,
            hooksConfig,
            {
              turnContext: turnInputContextSignals,
              recentPlanToolActivity,
              attemptedPlanWriteTargets,
            },
          );
          allResults.push(...specResults);
        }

        // Execute write tools sequentially (they may have side effects)
        for (const tc of writeCalls) {
          const result = await executeWriteToolWithReview(
            tc,
            workspace,
            callbacks,
            iterationAllTools,
            hooksConfig,
            {
              turnContext: turnInputContextSignals,
              recentPlanToolActivity,
              attemptedPlanWriteTargets,
              skipUserReview: tc.skipUserReview === true,
            },
          );
          allResults.push(result);
          if (tc.name === "browser_evaluate" && !result.isError) {
            const toolArgs = parseToolCallArguments(tc, workspace);
            const signature = buildRepeatLoopSignature(tc.name, buildRepeatLoopArgsKey(toolArgs));
            approvedPlanBrowserValidationCache.set(signature, result);
          }

          // Check if the loop was aborted during user review
          if (abortController.signal.aborted) {
            callbacks.onStatusChange("idle");
            return;
          }
        }

        for (const result of allResults) {
          if (result.isError) continue;
          if (!PLAN_EXPLORATION_READ_ONLY_TOOLS.has(result.name)) {
            sawExecuteOperationEvidence = true;
          }
          const resultArgs = toolArgsByCallId.get(result.toolCallId) ?? {};
          const targetingEvidenceKey = getTaskTargetingEvidenceKey(result.name, resultArgs, result.target);
          if (targetingEvidenceKey) {
            taskTargetingEvidence.add(targetingEvidenceKey);
          }
          if (unityConsoleDiagnosticsRequested && isUnityScriptWriteToolCall(result.name, resultArgs)) {
            unityConsoleFinalVerificationRequired = true;
            unityConsoleRefreshObservedAfterWrite = false;
          }
          if (unityConsoleDiagnosticsRequested && unityConsoleFinalVerificationRequired) {
            if (result.name === "refresh_unity") {
              unityConsoleRefreshObservedAfterWrite = true;
            } else if (result.name === "read_console" && unityConsoleRefreshObservedAfterWrite) {
              unityConsoleFinalVerificationRequired = false;
              unityConsoleRefreshObservedAfterWrite = false;
            }
          }

          if (isProjectSourceWriteResult(result)) {
            recentSuccessfulProjectWrite = {
              name: result.name,
              target: result.target,
            };
            sawExecuteOperationEvidence = true;
            recoveringFromEmptyAssistantReplyAfterWrite = false;
            continue;
          }
          if (EXECUTION_VERIFICATION_TOOL_NAMES.has(result.name)) {
            sawExecuteOperationEvidence = true;
            recentSuccessfulProjectWrite = null;
            recoveringFromEmptyAssistantReplyAfterWrite = false;
          }
        }

        let unityMcpFallbackPrompt: string | null = null;
        if (unityMcpForceConsoleFirstPending) {
          const readConsoleResult = allResults.find((result) => result.name === "read_console");
          if (!readConsoleResult) {
            const hasSuccessfulReadOnlyActivity = allResults.some(
              (result) =>
                !result.isError &&
                (
                  result.name === "set_active_instance" ||
                  UNITY_FALLBACK_RECOVERY_READ_ONLY_TOOL_NAMES.has(result.name)
                ),
            );
            if (shouldRepromptBeforeUnityConsoleFallback({
              readConsoleCalled: false,
              hasSuccessfulReadOnlyActivity,
              repromptAlreadyIssued: unityConsoleMissingFirstToolRepromptIssued,
            })) {
              unityConsoleMissingFirstToolRepromptIssued = true;
              unityMcpFallbackPrompt = callbacks.getPreferredLanguage() === "zh"
                ? "你已经调用了可用工具，但这轮是 Unity console 诊断路径，仍缺少必需的 `read_console`。下一条请只输出一个标准 XML `<tool_use>` 调用 `read_console`（必要时先 `set_active_instance`），不要输出 `<tool_code>` 或过程说明。"
                : "You already called an available tool, but this Unity console diagnostics path still requires `read_console`. In the next reply, output exactly one standard XML `<tool_use>` call for `read_console` (use `set_active_instance` first only if required), with no `<tool_code>` wrapper and no process narration.";
            } else {
              activateUnityMcpFallback("forced_console_tool_not_called");
              unityMcpForceConsoleFirstPending = false;
              unityMcpFallbackPrompt = callbacks.getPreferredLanguage() === "zh"
                ? "Unity MCP 未按预期执行 read_console，本轮自动回退到本地诊断路径。请立即使用本地只读工具读取最相关日志并给出结论。"
                : "Unity MCP did not execute read_console as expected. This turn has been auto-fallbacked to local diagnostics. Use local read-only tools now and report findings.";
            }
          } else if (readConsoleResult.isError) {
            const failureCategory = extractMcpCallFailureCategory(readConsoleResult.content || "");
            if (failureCategory && ["unreachable", "route_mismatch", "session"].includes(failureCategory)) {
              activateUnityMcpFallback(`forced_console_call_failed:${failureCategory}`);
              unityMcpForceConsoleFirstPending = false;
              unityMcpFallbackPrompt = callbacks.getPreferredLanguage() === "zh"
                ? "Unity MCP 首轮 read_console 调用失败，已自动回退到本地诊断路径。请直接读取本地日志并给出报错定位。"
                : "Unity MCP read_console failed on the first pass, so the turn has auto-fallbacked to local diagnostics. Read local logs directly and provide error localization.";
            } else {
              unityMcpForceConsoleFirstPending = false;
            }
          } else {
            unityMcpForceConsoleFirstPending = false;
          }
        }

        allResults.forEach(rememberAnyToolActivity);
        const remainingTaskForDigest = callbacks.getPlanTasks().find((task) => !isPlanTaskTrustedComplete(task));
        const externalResultsForDigest = allResults.filter((result) => !result.internalFeedback);
        if (callbacks.onExecutionDigestUpdate && externalResultsForDigest.length > 0) {
          const digest = buildExecutionDigest({
            language: callbacks.getPreferredLanguage(),
            turnIntent,
            toolResults: externalResultsForDigest,
            remainingTask: remainingTaskForDigest?.text,
          });
          if (digest) callbacks.onExecutionDigestUpdate(digest);
        }

        if (workflowMode === "plan") {
          allResults.forEach(rememberPlanToolActivity);
          // P1 improvement: track recovery reads during drafting to allow only one.
          if (
            !callbacks.getIsPlanApproved() &&
            planRuntimePhase === "drafting" &&
            allResults.some((r) => r.name === "read_file" || r.name === "read_document" || r.name === "get_file_outline")
          ) {
            planDraftingRecoveryReadCount += 1;
          }
        }
        if (
          workflowMode === "plan" &&
          !callbacks.getIsPlanApproved() &&
          planRuntimePhase === "explore_structure" &&
          allResults.some((result) => result.name === "get_project_skeleton" && !result.internalFeedback)
        ) {
          const structureSucceeded = allResults.some((result) =>
            result.name === "get_project_skeleton" &&
            !result.internalFeedback &&
            !result.isError
          );
          if (structureSucceeded) {
            setPlanRuntimePhase("explore_structure", "project structure explored", "done");
            setPlanRuntimePhase("grounding", "after project structure");
          } else {
            setPlanRuntimePhase("grounding", "project structure unavailable; continue targeted grounding");
          }
        }
        const failedEvidenceResults = allResults.filter((result) => !result.internalFeedback && result.isError);
        const firstFailedEvidenceResult = failedEvidenceResults[0];
        const firstFailedEvidenceLifecycleState = firstFailedEvidenceResult
          ? inferLifecycleStateFromToolResult(firstFailedEvidenceResult)
          : null;
        emitTaskOrchestratorPhase("EVIDENCE_RECONCILE", {
          iteration,
          results: allResults.length,
          successfulResults: allResults.filter((result) => !result.isError).length,
          failedResults: failedEvidenceResults.length,
          firstFailureReason: firstFailedEvidenceResult
            ? compactDiagnosticText(targetProgressReasonForToolResult(firstFailedEvidenceResult))
            : null,
          firstFailureTool: firstFailedEvidenceResult?.name ?? null,
          firstFailureTarget: firstFailedEvidenceResult?.target ?? null,
          firstFailureLifecycleState: firstFailedEvidenceLifecycleState,
          tool: firstFailedEvidenceResult?.name ?? null,
          target: firstFailedEvidenceResult?.target ?? null,
          lifecycleState: firstFailedEvidenceLifecycleState,
          evidenceKeys: [...taskTargetingEvidence].slice(-8),
        });
        logAgentEvent("post_tool_result_continuation", {
          stage: "after_evidence_reconcile",
          iteration,
          results: allResults.length,
          successfulResults: allResults.filter((result) => !result.isError).length,
          editResults: allResults.filter((result) => !result.isError && EDIT_PROGRESS_TOOL_NAMES.has(result.name)).length,
          verificationResults: allResults.filter((result) => !result.isError && EXECUTION_VERIFICATION_TOOL_NAMES.has(result.name)).length,
          runtimeIntent,
          workflowMode,
          planApproved: callbacks.getIsPlanApproved(),
        });

        const successfulReadOnlyExplorationResults = allResults.filter((result) =>
          !result.isError && PLAN_EXPLORATION_READ_ONLY_TOOLS.has(result.name)
        );
        const nonReadOnlySuccessfulResultCount = allResults.filter((result) =>
          !result.isError && !PLAN_EXPLORATION_READ_ONLY_TOOLS.has(result.name)
        ).length;
        if (
          workflowMode === "plan" &&
          callbacks.getIsPlanApproved() &&
          approvedPlanNoToolRecoveryFileReadActive &&
          allResults.some((result) => result.name === "read_file")
        ) {
          approvedPlanNoToolRecoveryFileReadActive = false;
        }
        if (workflowMode === "plan" && callbacks.getIsPlanApproved() && nonReadOnlySuccessfulResultCount > 0) {
          approvedPlanActionOnlyRecoveryActive = false;
          approvedPlanNoToolRecoveryFileReadActive = false;
          approvedPlanNoProgressRecoveryAttempts = 0;
        }
        if (workflowMode === "edit" && nonReadOnlySuccessfulResultCount > 0) {
          clearExecuteRecovery("action_evidence_observed");
        }
        const hasPlanDecisionOutput =
          hasStructuredProposal ||
          finalReplyOptions.length > 0 ||
          isReviewablePlanStage(callbacks.getPlanStage()) ||
          allResults.some(isSuccessfulPlanArtifactWriteResult);
        const isUnapprovedPlanReadOnlyBatch = shouldDeferNoProgressStopToPlanReadOnlyConvergence({
          workflowMode,
          isPlanApproved: callbacks.getIsPlanApproved(),
          hasPlanDecisionOutput,
          resultCount: allResults.length,
          successfulReadOnlyResultCount: successfulReadOnlyExplorationResults.length,
          nonReadOnlySuccessfulResultCount,
        });
        const wasPlanEvidenceRecoveryPhase = String(planRuntimePhase) === "needs_evidence";
        let pendingPlanRuntimeRecoveryPrompt: string | null = null;
        let pendingExecuteRecoveryPrompt: string | null = null;
        let pendingExecuteNoProgressPause: {
          notice: string;
          repeatedTargets: string[];
          progressSignature: string;
          reason: string;
        } | null = null;
        const planQualityRecoveryResults = allResults.filter((result) =>
          result.internalFeedback &&
          !!result.planRecoveryAction
        );
        if (workflowMode === "plan" && !callbacks.getIsPlanApproved() && planQualityRecoveryResults.length > 0) {
          planQualityRejectCount += planQualityRecoveryResults.length;
          const latestQualityResult = planQualityRecoveryResults[planQualityRecoveryResults.length - 1];
          planLastQualityGateReason = latestQualityResult.qualityGateReason || "quality_gate";
          planLastMissingSections = latestQualityResult.missingPlanSections || [];
          logAgentEvent("plan_quality_recovery_action", {
            iteration,
            recoveryAction: latestQualityResult.planRecoveryAction,
            qualityRejectCount: planQualityRejectCount,
            qualityGateReason: planLastQualityGateReason,
            missingSections: planLastMissingSections,
            evidenceRecoveryPasses: planEvidenceRecoveryPasses,
          });

          if (latestQualityResult.planRecoveryAction === "targeted_evidence" && planEvidenceRecoveryPasses < MAX_PLAN_EVIDENCE_RECOVERY_PASSES) {
            setPlanRuntimePhase("needs_evidence", planLastQualityGateReason);
          } else if (
            latestQualityResult.planRecoveryAction === "auto_scaffold" ||
            planQualityRejectCount >= 2 ||
            (latestQualityResult.planRecoveryAction === "targeted_evidence" && planEvidenceRecoveryPasses >= MAX_PLAN_EVIDENCE_RECOVERY_PASSES)
          ) {
            if (!planAutoScaffoldPromptIssued) {
              planAutoScaffoldPromptIssued = true;
              setPlanRuntimePhase("needs_rewrite", "auto scaffold after quality gate");
              pendingPlanRuntimeRecoveryPrompt = buildPlanAutoScaffoldPrompt({
                language: callbacks.getPreferredLanguage(),
                latestUserPromptText,
                recentToolActivity: recentPlanToolActivity,
                qualityGateReason: planLastQualityGateReason,
                missingSections: planLastMissingSections,
              });
            } else {
              setPlanRuntimePhase("needs_rewrite", planLastQualityGateReason);
            }
          } else {
            setPlanRuntimePhase("needs_rewrite", planLastQualityGateReason);
          }

          const qualityClosureEvidence = collectPlanClosureMaterializationInput(
            callbacks,
            recentPlanToolActivity,
            attemptedPlanWriteTargets,
            latestUserPromptText,
          );
          const hasQualityClosureEvidence = hasGroundedPlanClosureEvidence(
            qualityClosureEvidence,
            recentPlanToolActivity,
          );
          const hasStructuredQualityClosureEvidence = qualityClosureEvidence.evidenceRecords.length > 0;
          const shouldRequestTargetedEvidenceAfterQualityGate =
            planQualityRejectCount >= 1 &&
            hasQualityClosureEvidence &&
            !planClosureEvidenceRecoveryIssued &&
            planEvidenceRecoveryPasses < MAX_PLAN_EVIDENCE_RECOVERY_PASSES &&
            (
              latestQualityResult.planRecoveryAction !== "targeted_evidence" ||
              hasStructuredQualityClosureEvidence
            );
          logAgentEvent("plan_quality_gate_recovery_decision", {
            iteration,
            qualityGateReason: planLastQualityGateReason,
            qualityRejectCount: planQualityRejectCount,
            recoveryAction: latestQualityResult.planRecoveryAction || "",
            hasGroundedEvidence: hasQualityClosureEvidence,
            hasStructuredEvidence: hasStructuredQualityClosureEvidence,
            deterministicClosure: false,
            fallbackPlanMaterializationDisabled: true,
            targetedEvidenceRecovery: shouldRequestTargetedEvidenceAfterQualityGate,
            sanitizedEvidenceCount: qualityClosureEvidence.evidence.length,
            structuredEvidenceCount: qualityClosureEvidence.evidenceRecords.length,
            sanitizedFileCount: qualityClosureEvidence.files.length,
            sanitizerDropped: qualityClosureEvidence.sanitizer.dropped,
            sanitizerDropReasons: qualityClosureEvidence.sanitizer.dropReasons,
          });
          if (shouldRequestTargetedEvidenceAfterQualityGate) {
            pendingPlanRuntimeRecoveryPrompt = null;
            planClosureEvidenceRecoveryIssued = true;
            setPlanRuntimePhase("needs_evidence", "quality gate needs model-authored plan evidence");
            pendingPlanRuntimeRecoveryPrompt = buildPlanClosureEvidenceRecoveryPrompt(
              planLastQualityGateReason || "quality gate rejected plan draft",
            );
          }
        }

        const evidenceRecoveryBatchResults = wasPlanEvidenceRecoveryPhase
          ? allResults.filter((result) =>
              !result.internalFeedback &&
              PLAN_EXPLORATION_READ_ONLY_TOOLS.has(result.name)
            )
          : [];
        if (
          workflowMode === "plan" &&
          !callbacks.getIsPlanApproved() &&
          evidenceRecoveryBatchResults.length > 0 &&
          pendingPlanRuntimeRecoveryPrompt == null
        ) {
          planEvidenceRecoveryPasses += 1;
          const hasSuccessfulEvidence = evidenceRecoveryBatchResults.some((result) => !result.isError);
          if (hasSuccessfulEvidence) {
            setPlanRuntimePhase("drafting", "evidence recovery complete");
            pendingPlanRuntimeRecoveryPrompt = buildPlanEvidenceRecoveryClosurePrompt({
              language: callbacks.getPreferredLanguage(),
              recentToolActivity: recentPlanToolActivity,
              qualityGateReason: planLastQualityGateReason,
              missingSections: planLastMissingSections,
            });
          } else {
            setPlanRuntimePhase("blocked", "evidence recovery failed", "failed");
            pendingPlanRuntimeRecoveryPrompt = buildPlanEvidenceRecoveryBlockedPrompt({
              language: callbacks.getPreferredLanguage(),
              recentToolActivity: recentPlanToolActivity,
              qualityGateReason: planLastQualityGateReason,
              missingSections: planLastMissingSections,
            });
          }
        }

        const noProgressBatchSignature = buildNoProgressBatchSignature(allResults);
        if (noProgressBatchSignature) {
          if (noProgressBatchSignature === lastNoProgressBatchSignature) {
            noProgressBatchRepeatCount += 1;
          } else {
            lastNoProgressBatchSignature = noProgressBatchSignature;
            noProgressBatchRepeatCount = 1;
          }
        } else {
          lastNoProgressBatchSignature = "";
          noProgressBatchRepeatCount = 0;
        }

        const executeReadOnlyRecovery =
          workflowMode === "edit" && runtimeIntent === "execute"
            ? resolveExecuteReadOnlyRecoveryTrigger({
                results: allResults,
                recentActivity: recentToolActivity,
                readOnlyTools: PLAN_EXPLORATION_READ_ONLY_TOOLS,
                sawExecuteOperationEvidence,
                noProgressBatchRepeatCount,
                minReadOnlyActivities: executeRecoveryMode === "normal"
                  ? (config.activeProfile === "local" ? 24 : 8)
                  : Infinity,
                minCachedReadOnlyActivities: executeRecoveryMode === "normal"
                  ? (config.activeProfile === "local" ? 14 : 3)
                  : Infinity,
                maxNoProgressReadOnlyRepeats: config.activeProfile === "local" ? 6 : 2,
                maxReadOnlyToolChars: config.activeProfile === "local" ? 100000 : 30000,
              })
            : { shouldRecover: false, reason: "", readOnlyActivityCount: 0, batchToolChars: 0 };
        if (executeReadOnlyRecovery.shouldRecover) {
          const language = callbacks.getPreferredLanguage();
          const repeatedTargets = summarizeRepeatedExecuteTargets(recentToolActivity.slice(-12));
          const allowFileRead = shouldAllowExecuteRecoveryFileRead(recentToolActivity);
          if (executeRecoveryAttempts < 2) {
            const nextMode: Exclude<ExecuteRecoveryMode, "normal"> = allowFileRead
              ? "patch_recovery_read"
              : "mutation_first";
            activateExecuteRecovery(nextMode, executeReadOnlyRecovery.reason, {
              readOnlyActivityCount: executeReadOnlyRecovery.readOnlyActivityCount,
              batchToolChars: executeReadOnlyRecovery.batchToolChars,
              repeatedTargets,
            });
            pendingExecuteRecoveryPrompt = buildExecuteRecoveryPrompt({
              language,
              reason: executeReadOnlyRecovery.reason,
              mode: nextMode,
              repeatedTargets,
              recentActivity: recentToolActivity,
              allowFileRead,
            });
          } else {
            const remainingText = callbacks.getPreferredLanguage() === "zh"
              ? "执行恢复后仍只有只读探索，没有写入、命令或浏览器验证证据。"
              : "execute recovery still produced read-only exploration without write, command, or browser validation evidence";
            pendingExecuteNoProgressPause = {
              notice: buildExecuteNoProgressLoopPauseNotice({
                language,
                repeats: Math.max(1, noProgressBatchRepeatCount),
                remainingTask: remainingText,
                recentActivity: recentToolActivity,
                repeatedTargets,
              }),
              repeatedTargets,
              progressSignature: buildPlanProgressSignatureFromToolActivity(recentToolActivity) || noProgressBatchSignature,
              reason: executeReadOnlyRecovery.reason,
            };
          }
        }

        const chatReadOnlyNoProgress =
          workflowMode === "chat" && runtimeIntent === "respond"
            ? resolveReadOnlyNoProgressTrigger({
                results: allResults,
                recentActivity: recentToolActivity,
                readOnlyTools: PLAN_EXPLORATION_READ_ONLY_TOOLS,
                sawExecuteOperationEvidence,
                noProgressBatchRepeatCount,
                minReadOnlyActivities: config.activeProfile === "local" ? 24 : 16,
                minCachedReadOnlyActivities: config.activeProfile === "local" ? 10 : 6,
                maxNoProgressReadOnlyRepeats: config.activeProfile === "local" ? 5 : 3,
                maxReadOnlyToolChars: config.activeProfile === "local" ? 80000 : 48000,
              })
            : { shouldRecover: false, reason: "", readOnlyActivityCount: 0, batchToolChars: 0 };
        if (chatReadOnlyNoProgress.shouldRecover) {
          const repeatedTargets = summarizeRepeatedExecuteTargets(recentToolActivity.slice(-12));
          const progressSignature = buildPlanProgressSignatureFromToolActivity(recentToolActivity) || noProgressBatchSignature;
          if (repairExecutionRequestInChat) {
            logAgentEvent("chat_repair_readonly_no_progress_paused", {
              reason: chatReadOnlyNoProgress.reason,
              iteration,
              repeats: noProgressBatchRepeatCount,
              readOnlyActivityCount: chatReadOnlyNoProgress.readOnlyActivityCount,
              batchToolChars: chatReadOnlyNoProgress.batchToolChars,
              repeatedTargets,
              progressSignature: truncateForLog(progressSignature, 220),
              userPromptPreview: truncateForLog(latestUserPromptText, 180),
            });
            const language = callbacks.getPreferredLanguage();
            callbacks.onNonActionableStop(
              buildExecuteNoProgressLoopPauseNotice({
                language,
                scope: "chat",
                repeats: Math.max(1, noProgressBatchRepeatCount),
                remainingTask: language === "zh"
                  ? "用户目标是找到问题并修复；当前回合只完成了只读排查，没有进入写入、命令验证、浏览器验证或明确阻塞。请继续时按执行意图恢复，而不是再输出普通总结。"
                  : "The user's goal is to find and fix the issue; this turn only completed read-only investigation and did not reach a write, command validation, browser validation, or concrete blocker. Resume as execution instead of ending with a plain summary.",
                recentActivity: recentToolActivity,
                repeatedTargets,
              }),
              "no_action",
              {
                phase: "paused",
                nextStep: language === "zh"
                  ? "继续时应进入执行能力，基于已读证据直接修复/验证，或说明精确阻塞。"
                  : "Resume with execution capabilities and patch/validate from cached evidence, or state the exact blocker.",
                repeatedTargets,
                progressSignature,
              },
            );
            callbacks.onStatusChange("idle");
            return;
          }
          activateChatFinalSynthesis(chatReadOnlyNoProgress.reason, {
            repeats: noProgressBatchRepeatCount,
            readOnlyActivityCount: chatReadOnlyNoProgress.readOnlyActivityCount,
            batchToolChars: chatReadOnlyNoProgress.batchToolChars,
            repeatedTargets,
            progressSignature: truncateForLog(progressSignature, 220),
          });
          logAgentEvent("chat_readonly_no_progress_final_synthesis", {
            reason: chatReadOnlyNoProgress.reason,
            iteration,
            repeats: noProgressBatchRepeatCount,
            readOnlyActivityCount: chatReadOnlyNoProgress.readOnlyActivityCount,
            batchToolChars: chatReadOnlyNoProgress.batchToolChars,
            repeatedTargets,
            progressSignature: truncateForLog(progressSignature, 220),
          });
          callbacks.onStatusChange("running");
          continue;
        }

        const approvedPlanCachedReadOnlyBatch =
          workflowMode === "plan" &&
          callbacks.getIsPlanApproved() &&
          isApprovedPlanCachedReadOnlyNoProgressBatch({
            results: allResults,
            readOnlyTools: PLAN_EXPLORATION_READ_ONLY_TOOLS,
            sawExecutionEvidence: sawExecuteOperationEvidence,
          });
        let approvedPlanNoProgressDecision: {
          action: "recover" | "pause";
          reason: string;
          remainingText: string;
          repeats: number;
          logContext: Record<string, unknown>;
        } | null = null;

        if (approvedPlanCachedReadOnlyBatch) {
          const remainingText = remainingTaskForDigest?.text || (
            callbacks.getPreferredLanguage() === "zh"
              ? "当前已批准计划仍有任务缺少写入、命令或浏览器验证证据。"
              : "the approved plan still has tasks missing write, command, or browser validation evidence"
          );
          const recoveryInput = {
            reason: "no_progress_cached_read_only_batch",
            remainingText,
            logContext: {
              currentBatchTools: allResults.map((result) => result.name).slice(0, 8),
              currentBatchTargets: allResults.map((result) => result.target).filter(Boolean).slice(0, 8),
            },
          };
          approvedPlanNoProgressDecision = {
            ...recoveryInput,
            action: approvedPlanNoProgressRecoveryAttempts < MAX_APPROVED_PLAN_NO_PROGRESS_RECOVERY_ATTEMPTS
              ? "recover"
              : "pause",
            repeats: Math.max(1, noProgressBatchRepeatCount),
          };
        }

        if (noProgressBatchRepeatCount >= MAX_NO_PROGRESS_LOOP_REPEATS) {
          if (isUnapprovedPlanReadOnlyBatch) {
            logAgentEvent("no_progress_deferred_to_plan_readonly_convergence", {
              iteration,
              repeats: noProgressBatchRepeatCount,
              batches: planReadOnlyConvergenceBatches,
              tools: planReadOnlyConvergenceTools,
            });
          } else if (workflowMode === "edit" && runtimeIntent === "execute" && pendingExecuteRecoveryPrompt) {
            logAgentEvent("execute_no_progress_deferred_to_recovery", {
              iteration,
              repeats: noProgressBatchRepeatCount,
              executeRecoveryMode,
              executeRecoveryReason,
            });
          } else if (workflowMode === "edit" && runtimeIntent === "execute") {
            const language = callbacks.getPreferredLanguage();
            const repeatedTargets = pendingExecuteNoProgressPause?.repeatedTargets.length
              ? pendingExecuteNoProgressPause.repeatedTargets
              : summarizeRepeatedExecuteTargets(recentToolActivity.slice(-12));
            const progressSignature =
              pendingExecuteNoProgressPause?.progressSignature ||
              buildPlanProgressSignatureFromToolActivity(recentToolActivity) ||
              noProgressBatchSignature;
            const pauseNotice = pendingExecuteNoProgressPause?.notice || buildExecuteNoProgressLoopPauseNotice({
              language,
              repeats: noProgressBatchRepeatCount,
              remainingTask: language === "zh"
                ? "先停止重复读取，改为写入、命令验证、浏览器验证，或说明真实阻塞。"
                : "stop repeated reads and pivot to patch/write, command validation, browser validation, or the real blocker",
              recentActivity: recentToolActivity,
              repeatedTargets,
            });
            logAgentEvent("loop_stop", {
              reason: "execute_no_progress_batch_loop",
              iteration,
              repeats: noProgressBatchRepeatCount,
              repeatedTargets,
              progressSignature: truncateForLog(progressSignature, 220),
              recoveryReason: pendingExecuteNoProgressPause?.reason || "",
            });
            emitTaskOrchestratorPhase("PAUSED", {
              reason: "execute_no_progress_batch_loop",
              iteration,
              repeats: noProgressBatchRepeatCount,
              remainingTask: language === "zh"
                ? "复用已读上下文，改为执行动作或说明真实阻塞。"
                : "reuse read context, take action, or state the real blocker",
              repeatedTargets,
            });
            callbacks.onNonActionableStop(
              pauseNotice,
              "no_action",
              {
                progressSignature,
                repeatedTargets,
                recoveryReason: "execute_no_progress_batch_loop",
                nextStep: language === "zh"
                  ? "复用已读上下文，转向写入/命令/浏览器验证，或说明真实阻塞"
                  : "reuse cached context and pivot to patch/run/browser validation, or state the real blocker",
              },
            );
            callbacks.onStatusChange("idle");
            return;
          } else {
            const remainingText = remainingTaskForDigest?.text || (
              callbacks.getPreferredLanguage() === "zh"
                ? "先重新核对当前目标与参数，再选择不同策略继续。"
                : "Recheck current targets and parameters, then continue with a different strategy."
            );
            const language = callbacks.getPreferredLanguage();
            const repeatedTargets = (() => {
              const counts = new Map<string, number>();
              for (const activity of recentPlanToolActivity.slice(-8)) {
                const target = String(activity.target || "").trim();
                if (!target) continue;
                const cachedWeight = /FILE_UNCHANGED_STUB|Repeated read-only tool call skipped|READ_FILE_REPEAT_LIMIT|READ_ONLY_REPEAT_LIMIT/i.test(activity.detail || "") ? 2 : 1;
                counts.set(target, (counts.get(target) || 0) + cachedWeight);
              }
              return [...counts.entries()]
                .filter(([, count]) => count >= 2)
                .sort((a, b) => b[1] - a[1])
                .map(([target]) => target)
                .slice(0, 4);
            })();
            const progressSignature = buildPlanProgressSignatureFromToolActivity(recentPlanToolActivity) || noProgressBatchSignature;
            const pauseNotice = buildPlanNoProgressLoopPauseNotice({
              language,
              repeats: noProgressBatchRepeatCount,
              remainingTask: remainingText,
              evidenceLedger: callbacks.getPlanExecutionEvidenceLedger(),
              recentToolActivity: recentPlanToolActivity,
              repeatedTargets,
            });
            logAgentEvent("loop_stop", {
              reason: "no_progress_batch_loop",
              iteration,
              repeats: noProgressBatchRepeatCount,
              repeatedTargets,
              progressSignature: truncateForLog(progressSignature, 220),
            });
            emitTaskOrchestratorPhase("PAUSED", {
              reason: "no_progress_batch_loop",
              iteration,
              repeats: noProgressBatchRepeatCount,
              remainingTask: remainingText,
              repeatedTargets,
            });
            callbacks.onNonActionableStop(
              pauseNotice,
              "no_action",
              {
                progressSignature,
                repeatedTargets,
                recoveryReason: "no_progress_batch_loop",
                nextStep: language === "zh"
                  ? "换目标、改为写入/命令/浏览器验证，或说明真实阻塞"
                  : "switch target, patch/run/browser-verify, or state the real blocker",
              },
            );
            callbacks.onStatusChange("idle");
            return;
          }
        }

        for (const result of allResults) {
          const signature = toolFailureSignatures.get(result.toolCallId);
          if (!signature) continue;
          if (result.internalFeedback) continue;
          if (result.isError) {
            failedToolCallCounts.set(signature, (failedToolCallCounts.get(signature) ?? 0) + 1);
          } else {
            failedToolCallCounts.delete(signature);
          }
        }

        // Append all tool result messages
        for (const result of allResults) {
          // Register tool execution with TurnContext for ephemeral tracking
          try {
            const resultChars = typeof result.content === "string" ? result.content.length : 0;
            turnContext.registerToolExecution({
              toolCallId: result.toolCallId,
              toolName: result.name,
              argumentsHash: buildRepeatLoopArgsKey(toolArgsByCallId.get(result.toolCallId) ?? {}),
              resultLength: resultChars,
              resultTruncated: resultChars > 2000,
            });
            turnContext.addItem({
              category: "tool",
              burned: false,
              scope: "ephemeral",
              purpose: `${result.name} tool result`,
              source: { toolName: result.name },
            });
          } catch {
            // TurnContext registration is best-effort
          }
          const toolHistoryContent = buildToolResultHistoryContentByFormat(result, config.toolFeedbackFormat);
          callbacks.appendMessage({
            role: "tool",
            content: toolHistoryContent,
            tool_call_id: result.toolCallId,
          });
          if (result.internalFeedback) continue;
          emitTurnEvent({
            type: "item.completed",
            threadId: eventThreadId,
            turnId: eventTurnId,
            timestampMs: Date.now(),
            item: {
              id: result.toolCallId,
              details: {
                type: "tool_result",
                toolCallId: result.toolCallId,
                tool: result.name,
                target: result.target,
                status: inferLifecycleStateFromToolResult(result),
                text: result.displayContent || result.content,
              },
            } as MainThreadItem,
          });
          if (result.additionalContexts?.length) {
            createHookContextMessages("PostToolUse", result.additionalContexts)
              .forEach(message => callbacks.appendMessage(message));
          }
        }
        const readFileRepeatLimitBatch = workflowMode === "edit" && runtimeIntent === "execute"
          ? summarizeReadFileRepeatLimitBatch(allResults)
          : null;
        if (readFileRepeatLimitBatch) {
          const language = callbacks.getPreferredLanguage();
          const pauseNotice = buildReadFileRepeatLimitBatchPauseNotice({
            language,
            target: readFileRepeatLimitBatch.target,
            total: readFileRepeatLimitBatch.total,
            targetCount: readFileRepeatLimitBatch.targetCount,
          });
          logAgentEvent("loop_stop", {
            reason: "read_file_repeat_limit_batch",
            iteration,
            target: readFileRepeatLimitBatch.target,
            total: readFileRepeatLimitBatch.total,
            targetCount: readFileRepeatLimitBatch.targetCount,
          });
          emitTaskOrchestratorPhase("PAUSED", {
            reason: "read_file_repeat_limit_batch",
            iteration,
            repeatedTargets: [readFileRepeatLimitBatch.target],
            remainingTask: language === "zh"
              ? "复用已读文件上下文，改为修改、验证或说明阻塞。"
              : "reuse cached file context and switch to patching, validation, or a blocker",
          });
          callbacks.onNonActionableStop(
            pauseNotice,
            "no_action",
            {
              repeatedTargets: [readFileRepeatLimitBatch.target],
              recoveryReason: "read_file_repeat_limit_batch",
              nextStep: language === "zh"
                ? "复用缓存内容，转向 patch/验证/阻塞说明"
                : "reuse cached context and pivot to patch/validation/blocker",
            },
          );
          callbacks.onStatusChange("idle");
          return;
        }
        if (unityMcpFallbackPrompt) {
          callbacks.appendMessage({
            role: "user",
            content: unityMcpFallbackPrompt,
          });
        }
        if (allResults.some(isVerificationEvidenceResult)) {
          successfulEditTargetsSinceVerification.clear();
          repeatedEditValidationRecoveryAttempts = 0;
        }
        let pendingRepeatedEditValidationRecoveryPrompt: string | null = null;
        for (const result of allResults) {
          if (result.isError || result.internalFeedback || !isEditProgressResult(result)) continue;
          const targetKey = normalizeLoopGuardTarget(result.target);
          if (!targetKey) continue;
          const count = (successfulEditTargetsSinceVerification.get(targetKey) || 0) + 1;
          successfulEditTargetsSinceVerification.set(targetKey, count);
          if (count < 3) continue;

          const displayTarget = String(result.target || targetKey).replace(/^shell-write:/, "");
          const language = callbacks.getPreferredLanguage();
          const availableValidationTools = Array.from(availableToolNames)
            .filter((name) => EXECUTION_VERIFICATION_TOOL_NAMES.has(name))
            .filter((name) => name !== "send_pty_input" && name !== "clear_pty_buffer");
          const canAttemptValidationRecovery =
            runtimeIntent === "execute" &&
            (workflowMode === "edit" || (workflowMode === "plan" && callbacks.getIsPlanApproved())) &&
            repeatedEditValidationRecoveryAttempts < 1 &&
            availableValidationTools.length > 0;
          if (canAttemptValidationRecovery) {
            repeatedEditValidationRecoveryAttempts += 1;
            activateExecuteRecovery("validation_only", "repeat_edit_target_without_validation", {
              target: displayTarget,
              editCount: count,
              validationTools: availableValidationTools,
            });
            logAgentEvent("repeat_edit_target_validation_recovery", {
              iteration,
              target: displayTarget,
              editCount: count,
              attempts: repeatedEditValidationRecoveryAttempts,
              validationTools: availableValidationTools,
            });
            emitPlanExecutionProgress("running", {
              repeatedTargets: [displayTarget],
              recoveryReason: "repeat_edit_target_without_validation",
              nextStep: language === "zh"
                ? "同一目标已连续修改；下一轮强制先运行命令或浏览器验证"
                : "same target was edited repeatedly; next turn must run command or browser validation first",
            });
            callbacks.onStatusChange("running");
            pendingRepeatedEditValidationRecoveryPrompt = buildExecuteValidationRecoveryPrompt({
              language,
              reason: "repeat_edit_target_without_validation",
              target: displayTarget,
              editCount: count,
              recentActivity: recentToolActivity,
              availableValidationTools,
            });
            break;
          }
          logAgentEvent("loop_stop", {
            reason: "repeat_edit_target_without_validation",
            iteration,
            target: displayTarget,
            editCount: count,
            validationRecoveryAttempts: repeatedEditValidationRecoveryAttempts,
            validationTools: availableValidationTools,
          });
          callbacks.onNonActionableStop(
            language === "zh"
              ? [
                  "执行已暂停：同一回合连续修改同一目标，但期间没有新的验证证据。",
                  `重复目标：${displayTarget}`,
                  "继续前请先运行测试、命令或浏览器验证；如果无法验证，请说明真实阻塞并给出当前状态。",
                ].join("\n")
              : [
                  "Execution paused: this turn kept editing the same target without fresh validation evidence.",
                  `Repeated target: ${displayTarget}`,
                  "Before continuing, run a test, command, or browser validation; if validation is blocked, state the blocker and current status.",
                ].join("\n"),
            "no_action",
            {
              repeatedTargets: [displayTarget],
              recoveryReason: "repeat_edit_target_without_validation",
              nextStep: language === "zh"
                ? "先验证当前目标，再决定继续修改、换目标或总结"
                : "validate this target before editing it again, switching targets, or summarizing",
            },
          );
          callbacks.onStatusChange("idle");
          return;
        }
        if (pendingRepeatedEditValidationRecoveryPrompt) {
          callbacks.appendMessage({
            role: "user",
            content: pendingRepeatedEditValidationRecoveryPrompt,
          });
          continue;
        }
        if (pendingExecuteRecoveryPrompt) {
          callbacks.onStatusChange("running");
          callbacks.appendMessage({
            role: "user",
            content: pendingExecuteRecoveryPrompt,
          });
          continue;
        }
        if (pendingExecuteNoProgressPause) {
          callbacks.onNonActionableStop(
            pendingExecuteNoProgressPause.notice,
            "no_action",
            {
              progressSignature: pendingExecuteNoProgressPause.progressSignature,
              repeatedTargets: pendingExecuteNoProgressPause.repeatedTargets,
              recoveryReason: pendingExecuteNoProgressPause.reason,
              nextStep: callbacks.getPreferredLanguage() === "zh"
                ? "复用已读上下文，转向写入/命令/浏览器验证，或说明真实阻塞"
                : "reuse cached context and pivot to patch/run/browser validation, or state the real blocker",
            },
          );
          callbacks.onStatusChange("idle");
          return;
        }
        if (pendingPlanRuntimeRecoveryPrompt) {
          callbacks.onStatusChange("running");
          callbacks.appendMessage({
            role: "user",
            content: pendingPlanRuntimeRecoveryPrompt,
          });
          continue;
        }

        if (approvedPlanNoProgressDecision) {
          if (approvedPlanNoProgressDecision.action === "recover") {
            continueApprovedPlanWithStrategySwitch(approvedPlanNoProgressDecision);
            continue;
          } else {
            pauseApprovedPlanNoProgressLoop(approvedPlanNoProgressDecision);
            return;
          }
        }

        if (isUnapprovedPlanReadOnlyBatch && !hasPlanDecisionOutput) {
          planReadOnlyConvergenceBatches += 1;
          planReadOnlyConvergenceTools += successfulReadOnlyExplorationResults.length;
        } else if (!isUnapprovedPlanReadOnlyBatch || hasPlanDecisionOutput) {
          planReadOnlyConvergenceBatches = 0;
          planReadOnlyConvergenceTools = 0;
        }

        const planEvidenceReadinessForConvergence = assessPlanEvidenceReadiness({
          userContext: turnInputContextSignals,
          recentToolActivity: recentPlanToolActivity,
          hasObservedUserContext: hasPlanUserContextObservation(
            callbacks.getMessages() as AgentMessage[],
            lastAssistantTextForCheckpoint,
          ),
        });
        const shouldConvergeUnapprovedPlanReadOnly = shouldTriggerPlanReadOnlyConvergence({
          isUnapprovedPlanReadOnlyBatch,
          hasPlanDecisionOutput,
          batchCount: planReadOnlyConvergenceBatches,
          toolCount: planReadOnlyConvergenceTools,
          userContext: turnInputContextSignals,
          recentToolActivity: recentPlanToolActivity,
          hasObservedUserContext: planEvidenceReadinessForConvergence.status !== "needs_observation",
          convergencePromptAlreadyUsed: usedPlanReadOnlyConvergencePrompt,
        });

        if (shouldConvergeUnapprovedPlanReadOnly) {
          const language = callbacks.getPreferredLanguage();
          const convergencePhase = planEvidenceReadinessForConvergence.status === "needs_targeted_read"
            ? "needs_evidence"
            : "synthesis";
          const convergenceReason = planEvidenceReadinessForConvergence.status === "needs_targeted_read"
            ? planEvidenceReadinessForConvergence.reason
            : "targeted evidence ready";
          setPlanRuntimePhase(convergencePhase, convergenceReason);
          logAgentEvent("plan_readonly_convergence_threshold", {
            iteration,
            batches: planReadOnlyConvergenceBatches,
            tools: planReadOnlyConvergenceTools,
            imageParts: turnInputContextSignals.imageParts,
            mentionedFilePaths: turnInputContextSignals.mentionedFilePaths.length,
            attachedFilePaths: turnInputContextSignals.attachedFilePaths.length,
            promptAlreadyUsed: usedPlanReadOnlyConvergencePrompt,
            evidenceReadiness: planEvidenceReadinessForConvergence.status,
            evidenceReadinessReason: planEvidenceReadinessForConvergence.reason,
            successfulTargetedReads: planEvidenceReadinessForConvergence.successfulTargetedReads,
            successfulSearches: planEvidenceReadinessForConvergence.successfulSearches,
          });
          if (!usedPlanReadOnlyConvergencePrompt) {
            usedPlanReadOnlyConvergencePrompt = true;
            setPlanRuntimePhase(
              planEvidenceReadinessForConvergence.status === "needs_targeted_read" ? "needs_evidence" : "drafting",
              convergenceReason,
            );
            callbacks.appendMessage({
              role: "user",
              content: buildPlanReadOnlyConvergencePrompt(
                language,
                planReadOnlyConvergenceBatches,
                planReadOnlyConvergenceTools,
                turnInputContextSignals,
              ),
            });
            continue;
          }

          const pause = buildPlanReadOnlyConvergencePause(
            language,
            planReadOnlyConvergenceBatches,
            planReadOnlyConvergenceTools,
            turnInputContextSignals,
          );
          const historyText = serializeAssistantReplyForHistory(pause.text, pause.options);
          callbacks.onAssistantFinalText(pause.text, pause.options, { hasToolCalls: false });
          callbacks.appendMessage({ role: "assistant", content: historyText });
          callbacks.onStatusChange("idle");
          return;
        }

        if (workflowMode === "plan" && !callbacks.getIsPlanApproved() && allResults.some(isSuccessfulPlanArtifactWriteResult)) {
          const currentStage = callbacks.getPlanStage();
          if (isReviewablePlanStage(currentStage)) {
            const reviewResult = await pauseForReviewablePlanArtifact("post_tool_plan_artifact_write");
            if (reviewResult === "approved_continue") continue;
            if (reviewResult === "stopped") return;
          } else {
            logAgentEvent("plan_artifact_write_not_reviewable_after_tool", {
              iteration,
              planStage: currentStage,
              targets: allResults
                .filter(isSuccessfulPlanArtifactWriteResult)
                .map((result) => result.target)
                .slice(0, 6),
            });
          }
        }

        if (workflowMode === "plan" && callbacks.getIsPlanApproved() && allResults.some((result) => !result.isError)) {
          callbacks.onPlanStageChanged("executing");
        }

        if (workflowMode === "plan" && callbacks.getIsPlanApproved()) {
          if (allResults.some((result) => result.isError)) {
            emitPlanExecutionProgress("tool_error");
          } else if (allResults.some((result) => !result.isError)) {
            emitPlanExecutionProgress("tool_done");
          }
        }

        // ── Strict Repeat Guard check ────────────────────────────────────
        // After each batch of tool calls, check for repetition loops
        let recoveredReadOnlyRepeat = false;
        for (const tc of effectiveToolCalls) {
          const toolArgs = parseToolCallArguments(tc, workspace);
          const autoExecutable = isToolAutoExecutableForCall(
            tc.name,
            toolArgs,
            toolCapabilityRegistry,
            config.toolPermissionPolicy,
            {
              workspace,
              approvedLocalFileReadPaths: callbacks.getApprovedLocalFileReadPaths(),
            },
          );
          const readOnlyShellInspection = isReadOnlyShellInspectionToolCall(tc.name, toolArgs);
          const repeatGuardReadOnly = autoExecutable || readOnlyShellInspection;
          const repeatCheck = registerToolCallForRepeatGuard(recentToolCalls, tc.name, toolArgs, repeatGuardReadOnly);
          if (!repeatCheck.repeated) continue;

          const target = getToolTarget(tc.name, toolArgs);
          if (repeatGuardReadOnly && (readOnlyShellInspection || !repeatGuardRecoveredSignatures.has(repeatCheck.signature))) {
            const recoveryMessage = formatRepeatLoopRecoveryMessage(
              tc.name,
              target,
              repeatCheck.threshold,
              availableToolNames,
            );
            if (!readOnlyShellInspection) {
              repeatGuardRecoveredSignatures.add(repeatCheck.signature);
            }
            recentToolCalls.length = 0;
            callbacks.onToolError(tc.name, target, recoveryMessage, { toolCallId: tc.id });
            callbacks.appendMessage({
              role: "system",
              content: `[System: ${recoveryMessage}]`,
            });
            recoveredReadOnlyRepeat = true;
            break;
          }

          if (workflowMode === "plan" && callbacks.getIsPlanApproved() && tc.name === "browser_evaluate") {
            const recoveryMessage = formatRepeatLoopRecoveryMessage(
              tc.name,
              target,
              repeatCheck.threshold,
              availableToolNames,
            );
            if (!repeatGuardRecoveredSignatures.has(repeatCheck.signature)) {
              repeatGuardRecoveredSignatures.add(repeatCheck.signature);
              recentToolCalls.length = 0;
              callbacks.onToolError(tc.name, target, recoveryMessage, { toolCallId: tc.id });
              callbacks.appendMessage({
                role: "system",
                content: `[System: ${recoveryMessage}]`,
              });
              recoveredReadOnlyRepeat = true;
              break;
            }

            const language = callbacks.getPreferredLanguage();
            const repeatedTargets = target ? [target] : summarizeRepeatedPlanTargetsFromToolActivity(recentPlanToolActivity);
            const progressSignature = buildPlanProgressSignatureFromToolActivity(recentPlanToolActivity);
            const notice = language === "zh"
              ? [
                  "执行已暂停：浏览器验证重复调用同一目标，没有产生新的执行证据。",
                  `重复目标：${repeatedTargets.join("、") || "未定位到单一目标"}`,
                  "MAIN 已保留最近一次 Browser/Playwright 结果；继续时请复用已有验证，改为下一个任务、命令验证、源码修正或最终总结。",
                ].join("\n")
              : [
                  "Execution paused: browser validation repeated the same target without new evidence.",
                  `Repeated target: ${repeatedTargets.join(", ") || "no single target identified"}`,
                  "MAIN kept the latest Browser/Playwright result; on resume, reuse it and move to the next task, command validation, source edit, or final summary.",
                ].join("\n");
            logAgentEvent("loop_stop", {
              reason: "approved_plan_repeated_browser_validation",
              iteration,
              target,
              progressSignature: truncateForLog(progressSignature, 220),
            });
            callbacks.onNonActionableStop(
              notice,
              "no_action",
              {
                progressSignature,
                repeatedTargets,
                recoveryReason: "approved_plan_repeated_browser_validation",
                nextStep: language === "zh"
                  ? "复用已有浏览器结果，转向下一个任务、命令验证、源码修正或最终总结"
                  : "reuse the browser result and move to the next task, command validation, source edit, or final summary",
              },
            );
            callbacks.onStatusChange("idle");
            return;
          }

          const fatalMessage = formatRepeatLoopFatalMessage(tc.name, target, repeatCheck.threshold);
          const remainingTask = callbacks.getPlanTasks().find((task) => !isPlanTaskTrustedComplete(task));
          const defaultSuggestedNextTask = callbacks.getPreferredLanguage() === "zh"
            ? "先复用已成功结果，再继续下一个文件或不同目标"
            : "reuse successful results already in context, then continue with the next file or a different target";
          const recentEvidence = callbacks.getPlanExecutionEvidenceLedger().slice(-5);
          const recentEvidenceText = recentEvidence.length > 0
            ? recentEvidence.map((entry) => `${entry.kind}:${entry.target || entry.value} via ${entry.sourceTool}`).join(" | ")
            : callbacks.getPreferredLanguage() === "zh" ? "无" : "none";
          const structuredRecovery = callbacks.getPreferredLanguage() === "zh"
            ? [
                "RecoveryDetails:",
                `- duplicateTool: ${tc.name}`,
                `- target: ${target || "unknown"}`,
                `- duplicateCount: ${repeatCheck.threshold}+`,
                `- recentSuccessfulEvidence: ${recentEvidenceText}`,
                `- suggestedNextTask: ${remainingTask?.text || defaultSuggestedNextTask}`,
              ].join("\n")
            : [
                "RecoveryDetails:",
                `- duplicateTool: ${tc.name}`,
                `- target: ${target || "unknown"}`,
                `- duplicateCount: ${repeatCheck.threshold}+`,
                `- recentSuccessfulEvidence: ${recentEvidenceText}`,
                `- suggestedNextTask: ${remainingTask?.text || defaultSuggestedNextTask}`,
              ].join("\n");
          const recoveryHint = remainingTask
            ? callbacks.getPreferredLanguage() === "zh"
              ? `\nRecovery: 请开启新的恢复上下文，从证据未满足的任务继续：${remainingTask.text}`
              : `\nRecovery: start a fresh recovery context and continue with an evidence-unsatisfied task such as: ${remainingTask.text}`
            : callbacks.getPreferredLanguage() === "zh"
            ? "\nRecovery: 请开启新的恢复上下文，先复用已成功结果，再继续下一个文件或不同目标。"
            : "\nRecovery: start a fresh recovery context, reuse successful results, then continue with the next file or a different target.";
          callbacks.onError(`${fatalMessage}\n${structuredRecovery}${recoveryHint}`);
          callbacks.onStatusChange("error");
          emitTurnFailedEvent(fatalMessage);
          return;
        }

        let recoveredTargetProgressLoop = false;
        if (!recoveredReadOnlyRepeat) {
          const resultByToolCallId = new Map(allResults.map((result) => [result.toolCallId, result]));
          for (const tc of effectiveToolCalls) {
            const toolArgs = parseToolCallArguments(tc, workspace);
            const target = getShellMutationTargetForLoopGuard(tc.name, toolArgs) || getToolTarget(tc.name, toolArgs);
            const toolResult = resultByToolCallId.get(tc.id);
            const outcome = targetProgressOutcomeForToolResult(toolResult);
            const reason = targetProgressReasonForToolResult(toolResult);
            const progressCheck = registerTargetProgressEventForLoopGuard(recentTargetToolCalls, {
              name: tc.name,
              target,
              outcome,
              reason,
            });
            if (!progressCheck.repeated) continue;

            const recoveryMessage = formatTargetProgressLoopRecoveryMessage(
              progressCheck.family,
              target || progressCheck.targetKey,
              progressCheck.threshold,
            );
            const isExecuteTargetRecoveryEligible =
              runtimeIntent === "execute" &&
              progressCheck.family === "edit" &&
              (workflowMode === "edit" || (workflowMode === "plan" && callbacks.getIsPlanApproved())) &&
              (outcome === "blocked" || outcome === "failed" || outcome === "no_change");
            const displayTarget = String(target || progressCheck.targetKey || "").replace(/^shell-write:/, "");
            const appendExecuteTargetRecoveryPrompt = (mode: Exclude<ExecuteRecoveryMode, "normal">, recoveryReason: string) => {
              activateExecuteRecovery(mode, recoveryReason, {
                target: displayTarget,
                outcome,
                reason,
              });
              callbacks.appendMessage({
                role: "user",
                content: buildExecuteRecoveryPrompt({
                  language: callbacks.getPreferredLanguage(),
                  reason: recoveryReason,
                  mode,
                  repeatedTargets: displayTarget ? [displayTarget] : summarizeRepeatedExecuteTargets(recentToolActivity.slice(-12)),
                  recentActivity: recentToolActivity,
                  allowFileRead: mode === "patch_recovery_read",
                }),
              });
            };
            if (!targetProgressGuardRecoveredSignatures.has(progressCheck.signature)) {
              targetProgressGuardRecoveredSignatures.add(progressCheck.signature);
              recentTargetToolCalls.length = 0;
              callbacks.onToolError(tc.name, target, recoveryMessage, { toolCallId: tc.id });
              callbacks.appendMessage({
                role: "system",
                content: `[System: ${recoveryMessage}]`,
              });
              if (isExecuteTargetRecoveryEligible && executeRecoveryAttempts < 2) {
                appendExecuteTargetRecoveryPrompt("patch_recovery_read", "target_progress_patch_mismatch");
              }
              recoveredTargetProgressLoop = true;
              break;
            }

            if (isExecuteTargetRecoveryEligible && executeRecoveryAttempts < 3) {
              recentTargetToolCalls.length = 0;
              callbacks.onToolError(tc.name, target, recoveryMessage, { toolCallId: tc.id });
              callbacks.appendMessage({
                role: "system",
                content: `[System: ${recoveryMessage}]`,
              });
              appendExecuteTargetRecoveryPrompt("mutation_first", "target_progress_no_diff_chain");
              recoveredTargetProgressLoop = true;
              break;
            }

            callbacks.onNonActionableStop(
              callbacks.getPreferredLanguage() === "zh"
                ? [
                    "执行已暂停：检测到同一目标上的工具进展循环。",
                    recoveryMessage,
                    "请继续时先核查当前 workspace 状态，再选择不同策略或输出最终结果。",
                  ].join("\n")
                : [
                    "Execution paused: detected a tool progress loop on the same target.",
                    recoveryMessage,
                    "On resume, first inspect current workspace state, then choose a different strategy or output the final result.",
                  ].join("\n"),
              "no_action",
            );
            callbacks.onStatusChange("idle");
            return;
          }
        }

        if (recoveredReadOnlyRepeat || recoveredTargetProgressLoop) {
          continue;
        }

        const shouldConvergeExecuteTurn =
          workflowMode === "edit" ||
          (workflowMode === "plan" && callbacks.getIsPlanApproved() && runtimeIntent === "execute");
        const convergencePromptRatio =
          workflowMode === "plan" && callbacks.getIsPlanApproved()
            ? PLAN_EXECUTE_CONVERGENCE_PROMPT_RATIO
            : EXECUTE_CONVERGENCE_PROMPT_RATIO;
        if (
          shouldConvergeExecuteTurn &&
          !usedExecuteConvergencePrompt &&
          iteration >= Math.max(8, Math.floor(effectiveMaxIterations * convergencePromptRatio))
        ) {
          usedExecuteConvergencePrompt = true;
          logAgentEvent("execute_convergence_prompt", {
            iteration,
            maxIterations: effectiveMaxIterations,
            recentToolActivity: recentToolActivity.length,
            executeRecoveryMode,
          });
          if (workflowMode === "edit" && runtimeIntent === "execute") {
            activateExecuteRecovery("mutation_first", "execute_convergence_prompt", {
              maxIterations: effectiveMaxIterations,
              recentToolActivity: recentToolActivity.length,
            });
          }
          callbacks.appendMessage({
            role: "user",
            content: buildExecuteConvergencePrompt(callbacks.getPreferredLanguage(), iteration, effectiveMaxIterations),
          });
        }

        logAgentEvent("post_tool_result_continuation", {
          stage: "loop_continue",
          iteration,
          nextIteration: iteration + 1,
          pendingExecuteRecovery: !!pendingExecuteRecoveryPrompt,
          pendingPlanRecovery: !!pendingPlanRuntimeRecoveryPrompt,
          usedExecuteConvergencePrompt,
          repeatedEditTargets: Array.from(successfulEditTargetsSinceVerification.entries()).slice(-6),
          runtimeIntent,
          workflowMode,
          planApproved: callbacks.getIsPlanApproved(),
        });
        // Loop continues — the model sees all tool results and can respond
        }

        if (workflowMode === "plan" && callbacks.getIsPlanApproved()) {
        const checkpoint = buildPlanMaxIterationsCheckpoint({
          iterationCount: effectiveMaxIterations,
          maxIterations: effectiveMaxIterations,
          autoResumeCount: callbacks.getPlanAutoResumeCount?.() ?? 0,
          tasks: callbacks.getPlanTasks(),
          evidenceLedger: callbacks.getPlanExecutionEvidenceLedger(),
          recentToolActivity: recentPlanToolActivity,
          lastAssistantText: lastAssistantTextForCheckpoint,
          unresolvedBlockers: [
            `Agent loop reached maximum iterations (${effectiveMaxIterations}) while plan execution was still active.`,
          ],
        });
        logAgentEvent("max_iterations_checkpoint", {
          workflowMode,
          iteration: effectiveMaxIterations,
          autoResumeCount: checkpoint.autoResumeCount,
          remainingTasks: checkpoint.remainingTasks.length,
          recentToolActivity: checkpoint.recentToolActivity.length,
        });
        emitPlanExecutionProgress(
          checkpoint.autoResumeCount < 1 ? "checkpoint" : "paused",
          {
            nextStep: checkpoint.autoResumeCount < 1
              ? callbacks.getPreferredLanguage() === "zh"
                ? "保存检查点并自动开启一次隐藏续跑"
                : "save checkpoint and start one hidden auto-resume"
              : callbacks.getPreferredLanguage() === "zh"
              ? "点击 Resume Execution 后从检查点继续"
              : "click Resume Execution to continue from checkpoint",
          },
        );
        callbacks.onStatusChange("idle");
        const handled = await callbacks.onPlanMaxIterationsCheckpoint?.(checkpoint);
        if (handled) return;
        callbacks.onError(buildPlanMaxIterationsPauseNotice(checkpoint, callbacks.getPreferredLanguage()));
        return;
        }

        if (workflowMode === "edit") {
        const checkpoint = buildPlanMaxIterationsCheckpoint({
          iterationCount: effectiveMaxIterations,
          maxIterations: effectiveMaxIterations,
          autoResumeCount: callbacks.getPlanAutoResumeCount?.() ?? 0,
          tasks: [],
          evidenceLedger: [],
          recentToolActivity,
          lastAssistantText: lastAssistantTextForCheckpoint,
          unresolvedBlockers: [
            `Agent loop reached maximum iterations (${effectiveMaxIterations}) while execute runtime was still active.`,
          ],
        });
        logAgentEvent("execute_max_iterations_checkpoint", {
          workflowMode,
          iteration: effectiveMaxIterations,
          autoResumeCount: checkpoint.autoResumeCount,
          recentToolActivity: checkpoint.recentToolActivity.length,
          sawExecuteOperationEvidence,
          executeRecoveryMode,
        });
        const handled = await callbacks.onExecuteMaxIterationsCheckpoint?.(checkpoint);
        if (handled) {
          callbacks.onStatusChange("idle");
          return;
        }
        callbacks.onNonActionableStop(
          buildExecuteMaxIterationsPauseNotice(checkpoint, callbacks.getPreferredLanguage()),
          "no_action",
        );
        callbacks.onStatusChange("idle");
        return;
        }

        const repeatedTargets = summarizeRepeatedExecuteTargets(recentToolActivity.slice(-12));
        const progressSignature = buildPlanProgressSignatureFromToolActivity(recentToolActivity);
        logAgentEvent("loop_stop", {
        reason: "max_iterations_boundary",
        iteration: effectiveMaxIterations,
        workflowMode,
        runtimeIntent: resolveRuntimeIntent(),
        repeatedTargets,
        progressSignature: truncateForLog(progressSignature, 220),
        });
        callbacks.onNonActionableStop(
        callbacks.getPreferredLanguage() === "zh"
          ? `本轮达到 ${effectiveMaxIterations} 轮安全边界，已停止在可恢复状态。`
          : `This turn reached the ${effectiveMaxIterations}-iteration safety boundary and stopped in a recoverable state.`,
        "no_action",
        {
          progressSignature,
          repeatedTargets,
          recoveryReason: "max_iterations_boundary",
          nextStep: callbacks.getPreferredLanguage() === "zh"
            ? "复用已读上下文，直接总结、换目标或说明具体阻塞"
            : "reuse cached context, summarize directly, switch targets, or state the concrete blocker",
        },
        );
        callbacks.onStatusChange("idle");
        emitTurnCompletedEvent();
    }
}

export async function executeAgentLoop(callbacks: OrchestratorCallbacks, abortController: AbortController): Promise<AgentLoopOutcome> {
    const orchestrator = new AgentOrchestrator();
    let outcome: AgentLoopOutcome = { status: "completed", reason: "agent_loop_completed" };
    const setOutcome = (next: AgentLoopOutcome) => {
        if (outcome.status === "error") return;
        if (outcome.status === "aborted" && next.status !== "error") return;
        outcome = next;
    };
    const wrappedCallbacks: OrchestratorCallbacks = {
        ...callbacks,
        onNonActionableStop: (message, reason, progress) => {
            const status: AgentLoopOutcome["status"] =
                reason === "no_output" ? "stopped_no_output" :
                reason === "incomplete_plan" ? "paused" :
                "stopped_no_action";
            setOutcome({ status, reason });
            callbacks.onNonActionableStop(message, reason, progress);
        },
        onError: (error) => {
            setOutcome({ status: "error", reason: "agent_loop_error" });
            callbacks.onError(error);
        },
    };

    try {
        await orchestrator.execute(wrappedCallbacks, abortController);
    } catch (error) {
        setOutcome({ status: "error", reason: "agent_loop_error" });
        throw error;
    }

    if (abortController.signal.aborted) {
        return { status: "aborted", reason: "agent_loop_aborted" };
    }

    if (outcome.status === "completed" && callbacks.getWorkflowMode() === "plan" && callbacks.getIsPlanApproved()) {
        const audit = buildPlanTaskEvidenceAudit({
            tasks: callbacks.getPlanTasks(),
            evidenceLedger: callbacks.getPlanExecutionEvidenceLedger(),
            highlightNext: true,
        });
        if (audit.totalCount === 0 || !audit.allTrustedComplete || audit.pendingExternalValidation || audit.pendingUserValidationTasks.length > 0) {
            const language = callbacks.getPreferredLanguage();
            const remainingText = formatPlanAuditRemainingTasks(
                audit,
                language,
                language === "zh"
                    ? "- 已批准 Plan 尚未产生可审计的运行时任务证据。"
                    : "- The approved Plan has not produced auditable runtime task evidence yet.",
            );
            logAgentEvent("plan_completion_guard_outcome_paused", {
                completed: audit.completedCount,
                total: audit.totalCount,
                remaining: audit.remainingTasks.length,
                pendingExternalValidation: audit.pendingExternalValidation,
                pendingUserValidation: audit.pendingUserValidationTasks.length,
            });
            callbacks.onNonActionableStop(
                buildApprovedPlanNoToolPauseMessage(
                    language,
                    remainingText,
                    1,
                    audit,
                    false,
                ),
                "incomplete_plan",
            );
            callbacks.onStatusChange("idle");
            return { status: "paused", reason: "approved_plan_completion_guard" };
        }
    }

    return outcome;
}
