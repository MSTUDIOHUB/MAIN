import { resolveReasoningPolicy } from "../../cloudProtocol";
import type { MainModeKey } from "../../mainModes";
import { loadResolvedInstructions, type ResolvedInstructionSet } from "../../instructions";
import { loadHooksConfig, type HooksConfig } from "../../hooks";
import type { MCPServerStatusSnapshot, MCPTool } from "../../mcpClient";
import {
  compactDiagnosticText,
  createHookContextMessages,
  deriveStreamSettings,
  getOriginalUserPromptForPlanFallback,
  getSessionTaskTargetingEvidence,
  logAgentEvent,
  looksLikeRepairExecutionRequest,
  resolveEffectiveToolProtocol,
  resolveModelProtocolProfile,
  runLifecycleHooks,
  shouldUseXmlToolProtocol,
} from "../../orchestrator";
import { buildEffectiveTurnContract, hasExplicitUnityConsoleDiagnosticCue, type CommandDirective, type EffectiveTurnContract, type ResolvedUserIntent } from "../../runIntent";
import type { StreamSettings } from "../../streaming";
import { extractCompatibilityTextContent } from "../../providerCompatibility";
import { buildSystemPrompt } from "../../systemPrompt";
import { skillNameToToolName, type ToolDefinition } from "../../toolSchemas";
import { withEventSchema, type MainThreadEventInput, type MainThreadProgressUpdate } from "../../turnEvents";
import { extractPrimaryUserRequestText, extractTurnInputContextSignalsFromMessages, type TurnInputContextSignals } from "../../turnIntake";
import { collectCanonicalTurnUserContext } from "../../turnContext";
import { readHarnessRunMarker } from "../../harnessCrashTelemetry";
import { markerBelongsToTurn, markerContinuesLogicalTurn, resolveRuntimeRunIdentity } from "../../runIdentity";
import { buildTaskTargetingProfile, type TaskOrchestratorPhase, type TaskTargetingProfile } from "../../taskTargeting";
import {
  isUnityCommandDirective,
  isUnityConsoleDiagnosticsDirective,
  normalizeGameStudioEngineKey,
} from "../../orchestrator/unityDiagnostics";
import { generateId } from "../../utils";
import type { AgentMessage, OrchestratorCallbacks } from "../types";
import { formatWebResearchLocalDate } from "../../webResearchGuard";
import { createProbeRunner, runModelProbe } from "../../modelProbe";

export interface AgentLoopRuntimeState {
  config: ReturnType<OrchestratorCallbacks["getConfig"]>;
  isCloudProfile: boolean;
  skills: ReturnType<OrchestratorCallbacks["getSkills"]>;
  initialMessages: AgentMessage[];
  settings: StreamSettings;
  effectiveToolProtocol: ReturnType<typeof resolveEffectiveToolProtocol>;
  compatibilityForcedAtStart: boolean | undefined;
  nativeToolsEnabled: boolean;
  modelProtocolProfile: ReturnType<typeof resolveModelProtocolProfile>;
  reasoningPolicy: ReturnType<typeof resolveReasoningPolicy>;
  workspace: string;
  mainModeKey: MainModeKey;
  workspaceTree: string;
  turnIntent: ResolvedUserIntent;
  workflowMode: ReturnType<OrchestratorCallbacks["getWorkflowMode"]>;
}

export interface TurnEventEmitter {
  eventThreadId: string;
  eventTurnId: string;
  eventRunId: string;
  eventParentRunId: string | null;
  eventGoalSliceId?: string;
  eventContinuesTurn: boolean;
  emitTurnEvent: (event: MainThreadEventInput) => void;
  emitTurnCompletedEvent: () => void;
  emitTurnFailedEvent: (message: string) => void;
  emitRunPausedEvent: (reason: string, message: string, progress?: MainThreadProgressUpdate) => boolean;
}

export interface AgentLoopTurnInputContext {
  latestUserPromptText: string;
  repairExecutionRequestInChat: boolean;
  turnInputContextSignals: TurnInputContextSignals;
  commandDirective: CommandDirective | null;
  gameStudioEngine: ReturnType<typeof normalizeGameStudioEngineKey>;
  gameStudioEngineContext: boolean;
  gameStudioUnityContext: boolean;
  unityCommandRequested: boolean;
  unityConsoleDiagnosticsRequested: boolean;
  gameStudioScriptEditRequested: boolean;
  unityScriptEditRequested: boolean;
}

export interface SystemPromptApplier {
  applySystemPromptForRuntime: (runtimeIntent: ResolvedUserIntent, tools: ToolDefinition[]) => void;
}

export interface TaskTargetingRuntime {
  taskTargetingEvidence: Set<string>;
  emitTaskOrchestratorPhase: (
    phase: TaskOrchestratorPhase,
    extra?: Record<string, unknown>,
  ) => void;
  buildCurrentTaskTargetingProfile: () => TaskTargetingProfile;
}

export async function prepareAgentLoopRuntimeState(
  callbacks: OrchestratorCallbacks,
): Promise<AgentLoopRuntimeState> {
  const config = callbacks.getConfig();
  const isCloudProfile = config.activeProfile === "cloud";
  const skills = callbacks.getSkills();
  const initialMessages = callbacks.getMessages();
  const settings = deriveStreamSettings(config);

  if (!isCloudProfile && settings.contextLimit) {
    try {
      const { computeDynamicLocalContextLimit } = await import("../../modelDiscovery");
      settings.contextLimit = await computeDynamicLocalContextLimit(
        settings.provider || "",
        settings.baseUrl || "http://127.0.0.1:11434",
        settings.model || "",
        settings.contextLimit,
      );
      if (config.local) {
        config.local.contextLimit = settings.contextLimit;
      }
    } catch (e) {
      console.warn("Failed to dynamically compute local context limit", e);
    }
  }

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
  settings.reasoningRequest = reasoningPolicy.request;

  return {
    config,
    isCloudProfile,
    skills,
    initialMessages,
    settings,
    effectiveToolProtocol,
    compatibilityForcedAtStart,
    nativeToolsEnabled,
    modelProtocolProfile,
    reasoningPolicy,
    workspace: config.workspace,
    mainModeKey: callbacks.getMainModeKey(),
    workspaceTree: callbacks.getWorkspaceTree(),
    turnIntent: callbacks.getCurrentRunIntent(),
    workflowMode: callbacks.getWorkflowMode(),
  };
}

export function resolveAgentLoopTurnInputContext(
  runtimeState: AgentLoopRuntimeState,
  callbacks: OrchestratorCallbacks,
): AgentLoopTurnInputContext {
  const sessionKey = callbacks.getSessionKey() || "default";
  const turnId = callbacks.getCurrentTurnId?.() || "";
  const marker = readHarnessRunMarker();
  const turnStartMessageIndex = turnId && markerBelongsToTurn(marker, sessionKey, turnId)
    ? marker?.turnStartMessageIndex ?? null
    : null;
  const canonicalUserContext = collectCanonicalTurnUserContext({
    messages: runtimeState.initialMessages,
    turnStartMessageIndex,
  });
  const latestUserPrompt = [...runtimeState.initialMessages]
    .reverse()
    .find((message) => message.role === "user");
  const latestUserPromptFullText = latestUserPrompt ? extractCompatibilityTextContent(latestUserPrompt.content) : "";
  const latestUserPromptText = canonicalUserContext.texts.join("\n\n") ||
    extractPrimaryUserRequestText(latestUserPromptFullText) ||
    latestUserPromptFullText;
  logAgentEvent("turn_context_sources", {
    sessionKey,
    turnId: turnId || null,
    runId: marker?.runId || null,
    parentRunId: marker?.parentRunId || null,
    source: canonicalUserContext.source,
    turnStartMessageIndex: canonicalUserContext.turnStartMessageIndex,
    canonicalUserMessageCount: canonicalUserContext.texts.length,
    canonicalUserChars: canonicalUserContext.texts.reduce((total, text) => total + text.length, 0),
    inspectedUserMessages: canonicalUserContext.inspectedUserMessages,
    filteredSyntheticMessages: canonicalUserContext.filteredSyntheticMessages,
    durableMessageCount: runtimeState.initialMessages.length,
    durableContextPreserved: true,
  });
  const repairExecutionRequestInChat =
    runtimeState.workflowMode === "chat" && looksLikeRepairExecutionRequest(latestUserPromptText);
  const turnInputContextSignals = extractTurnInputContextSignalsFromMessages(runtimeState.initialMessages);
  const commandDirective = callbacks.getCommandDirective?.() ?? null;
  const gameStudioConfig = callbacks.getGameStudioConfig?.() ?? null;
  const gameStudioEngine = normalizeGameStudioEngineKey(gameStudioConfig?.engine);
  const gameStudioEngineContext = callbacks.getMainModeKey() === "game_studio" && gameStudioEngine != null;
  const gameStudioUnityContext = gameStudioEngineContext && gameStudioEngine === "unity";
  const unityCommandRequested = isUnityCommandDirective(commandDirective) || gameStudioUnityContext;
  const unityConsoleDiagnosticsRequested =
    isUnityConsoleDiagnosticsDirective(commandDirective) ||
    (unityCommandRequested && hasExplicitUnityConsoleDiagnosticCue(latestUserPromptText));
  const gameStudioScriptEditRequested = (gameStudioEngineContext || unityCommandRequested) &&
    /fix|repair|patch|edit|modify|refactor|script|code|c#|cs|gdscript|blueprint|cpp|c\+\+|修复|补丁|修改|脚本|代码|蓝图|编译|报错|错误/i.test(
      latestUserPromptText,
    );
  const unityScriptEditRequested = unityCommandRequested &&
    /fix|repair|patch|edit|modify|refactor|script|code|c#|cs|修复|补丁|修改|脚本|代码|编译|报错|错误/i.test(
      latestUserPromptText,
    );

  return {
    latestUserPromptText,
    repairExecutionRequestInChat,
    turnInputContextSignals,
    commandDirective,
    gameStudioEngine,
    gameStudioEngineContext,
    gameStudioUnityContext,
    unityCommandRequested,
    unityConsoleDiagnosticsRequested,
    gameStudioScriptEditRequested,
    unityScriptEditRequested,
  };
}

export function createSystemPromptApplier(input: {
  callbacks: OrchestratorCallbacks;
  runtimeState: AgentLoopRuntimeState;
  resolvedInstructions: ResolvedInstructionSet;
  mcpTools: MCPTool[];
  mcpServerStatuses: MCPServerStatusSnapshot[];
  mcpPriorityEngine: ReturnType<typeof normalizeGameStudioEngineKey>;
  gameStudioMcpFirstEligible: boolean;
  unityConsoleDiagnosticsRequested: boolean;
  getUnityMcpFirstPhaseActive: () => boolean;
  setLatestTurnContract: (contract: EffectiveTurnContract) => void;
}): SystemPromptApplier {
  const {
    callbacks,
    runtimeState,
    resolvedInstructions,
    mcpTools,
    mcpServerStatuses,
    mcpPriorityEngine,
    gameStudioMcpFirstEligible,
    unityConsoleDiagnosticsRequested,
    getUnityMcpFirstPhaseActive,
    setLatestTurnContract,
  } = input;
  const {
    config,
    skills,
    settings,
    effectiveToolProtocol,
    compatibilityForcedAtStart,
    modelProtocolProfile,
    workspace,
    mainModeKey,
    workspaceTree,
    workflowMode,
  } = runtimeState;
  const mcpToolNameSet = new Set(mcpTools.map((tool) => tool.name));
  const skillToolNameSet = new Set(skills
    .filter((skill) => skill.active && skill.type === "tool")
    .map((skill) => skillNameToToolName(skill.name))
    .filter(Boolean));
  let appliedSystemPromptKey = "";

  const applySystemPromptForRuntime = (runtimeIntent: ResolvedUserIntent, tools: ToolDefinition[]) => {
    const availableToolNameList = tools.map((tool) => tool.function.name);
    const effectiveTurnContract = buildEffectiveTurnContract({
      conversationIntent: callbacks.getCurrentRunIntent(),
      runtimeIntent,
      commandDirective: callbacks.getCommandDirective?.() ?? null,
      planApproved: callbacks.getIsPlanApproved(),
      planReviewReady:
        !callbacks.getIsPlanApproved() &&
        (callbacks.getPlanArtifacts?.() || []).some((artifact) => artifact.kind === "plan"),
      executionConsentGranted: callbacks.getExecutionConsentGranted?.() === true,
    });
    setLatestTurnContract(effectiveTurnContract);
    const webResearchPromptDate = (
      availableToolNameList.includes("web_search") ||
      availableToolNameList.includes("web_fetch")
    )
      ? formatWebResearchLocalDate()
      : "";
    const unityMcpFirstPhaseActive = getUnityMcpFirstPhaseActive();
    const goalTurnContract = runtimeIntent === "goal"
      ? callbacks.getGoalTurnContract?.() ?? null
      : null;
    const systemPromptKey = [
      runtimeIntent,
      workflowMode,
      callbacks.getPreferredLanguage(),
      webResearchPromptDate,
      callbacks.getGameStudioConfig?.()?.engine ?? "",
      callbacks.getGameStudioConfig?.()?.engineVersion ?? "",
      callbacks.getCommandDirective?.()?.kind ?? "none",
      callbacks.getCommandDirective?.()?.action ?? "",
      effectiveTurnContract.approvalState,
      effectiveTurnContract.planReviewState,
      effectiveTurnContract.operationApprovalState,
      effectiveTurnContract.mutationExpected ? "mutation" : "no-mutation",
      effectiveTurnContract.completionEvidenceRequired,
      goalTurnContract?.cacheKey ?? "no-goal-contract",
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
          .filter((status) => status.status === "connected")
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
      effectiveTurnContract,
      goalTurnContract,
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
      effectiveTurnContract,
    });
  };

  return { applySystemPromptForRuntime };
}

export async function loadAgentLoopResolvedInstructions(input: {
  callbacks: OrchestratorCallbacks;
  runtimeState: AgentLoopRuntimeState;
  associatedPaths: string[];
}): Promise<ResolvedInstructionSet> {
  const { callbacks, runtimeState, associatedPaths } = input;
  const { config, skills, workspace } = runtimeState;
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
  return resolvedInstructions;
}

export async function loadAgentLoopHooksConfig(input: {
  callbacks: OrchestratorCallbacks;
  runtimeState: AgentLoopRuntimeState;
}): Promise<HooksConfig> {
  const { callbacks, runtimeState } = input;
  const hooksConfig = runtimeState.config.hooksEnabled
    ? await loadHooksConfig(runtimeState.workspace)
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
  return hooksConfig;
}

export async function runAgentLoopStartHooks(input: {
  callbacks: OrchestratorCallbacks;
  runtimeState: AgentLoopRuntimeState;
  hooksConfig: HooksConfig;
  associatedPaths: string[];
}): Promise<"continue" | "blocked"> {
  const { callbacks, runtimeState, hooksConfig, associatedPaths } = input;
  const { config, workspace, workflowMode } = runtimeState;
  if (!config.hooksEnabled) return "continue";

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
      .forEach((message) => callbacks.appendMessage(message));
    callbacks.markSessionHookInitialized(sessionKey);
    if (sessionHookResult.blocked) {
      callbacks.onStatusChange("idle");
      return "blocked";
    }
  }

  const lastUserMessage = [...callbacks.getMessages()]
    .reverse()
    .find((message) => message.role === "user");
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
    .forEach((message) => callbacks.appendMessage(message));
  if (promptHookResult.blocked) {
    callbacks.onStatusChange("idle");
    return "blocked";
  }

  return "continue";
}

export function createTaskTargetingRuntime(input: {
  callbacks: OrchestratorCallbacks;
  runtimeState: AgentLoopRuntimeState;
  turnInputContext: AgentLoopTurnInputContext;
  associatedPaths: string[];
}): TaskTargetingRuntime {
  const { callbacks, runtimeState, turnInputContext, associatedPaths } = input;
  const { skills, turnIntent, workflowMode } = runtimeState;
  const { latestUserPromptText, turnInputContextSignals } = turnInputContext;
  const taskTargetingEvidence = getSessionTaskTargetingEvidence(callbacks.getSessionKey());
  const emitTaskOrchestratorPhase = (
    phase: TaskOrchestratorPhase,
    extra: Record<string, unknown> = {},
  ) => {
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

  return {
    taskTargetingEvidence,
    emitTaskOrchestratorPhase,
    buildCurrentTaskTargetingProfile,
  };
}

export function startModelProbeForTurn(settings: StreamSettings): void {
  if (!settings.model || !settings.provider || !settings.baseUrl) return;
  const probeRunner = createProbeRunner(
    settings.provider,
    settings.model,
    settings.baseUrl,
    settings.apiKey ?? "",
  );
  setTimeout(() => {
    runModelProbe(probeRunner, settings.model!, settings.provider!)
      .then(() => {
        // Results are already cached inside runModelProbe.
      })
      .catch(() => {
        // Probe failed; heuristic fallback will be used.
      });
  }, 0);
}

export function createTurnEventEmitter(callbacks: OrchestratorCallbacks): TurnEventEmitter {
  const eventThreadId = callbacks.getSessionKey() || "default";
  const eventTurnId = callbacks.getCurrentTurnId?.() || generateId();
  const marker = readHarnessRunMarker();
  const goalTurnContract = callbacks.getGoalTurnContract?.() as ({ goalSliceId?: string | null } | null | undefined);
  const runIdentity = resolveRuntimeRunIdentity({
    marker,
    sessionKey: eventThreadId,
    turnId: eventTurnId,
    fallbackRunId: `run-event-${generateId()}`,
    goalSliceId: goalTurnContract?.goalSliceId,
  });
  const eventContinuesTurn = markerContinuesLogicalTurn({
    marker,
    sessionKey: eventThreadId,
    turnId: eventTurnId,
    goalSliceId: goalTurnContract?.goalSliceId,
  });
  const initialRunEventIdentity = {
    runId: runIdentity.runId,
    parentRunId: runIdentity.parentRunId,
    ...(runIdentity.goalSliceId ? { goalSliceId: runIdentity.goalSliceId } : {}),
  };
  const resolveRunEventIdentity = () => {
    const current = callbacks.getCurrentRunIdentity?.();
    if (!current?.runId) return initialRunEventIdentity;
    return {
      runId: current.runId,
      parentRunId: current.parentRunId || null,
      ...(current.goalSliceId ? { goalSliceId: current.goalSliceId } : {}),
    };
  };
  let turnEventTerminalEmitted = false;
  let runTerminalEmitted = false;
  const emitTurnEvent = (event: MainThreadEventInput): void => {
    if (
      event.type === "run.paused" ||
      event.type === "run.completed" ||
      event.type === "run.failed"
    ) {
      runTerminalEmitted = true;
    }
    // Progress is a run-scoped observation, not merely turn-scoped history.
    // Stamp newly emitted progress with the active run identity while keeping
    // the event field optional for persisted legacy sessions.
    const eventWithRunIdentity = event.type === "progress.updated" && !event.runId
      ? {
          ...event,
          ...resolveRunEventIdentity(),
        }
      : event;
    callbacks.onTurnEvent?.(withEventSchema(eventWithRunIdentity));
  };
  Object.defineProperty(emitTurnEvent, "runIdentity", {
    configurable: false,
    enumerable: true,
    get: resolveRunEventIdentity,
  });
  const emitTurnCompletedEvent = () => {
    if (turnEventTerminalEmitted) return;
    if (!runTerminalEmitted) {
      const runEventIdentity = resolveRunEventIdentity();
      runTerminalEmitted = true;
      emitTurnEvent({
        type: "run.completed",
        threadId: eventThreadId,
        turnId: eventTurnId,
        timestampMs: Date.now(),
        ...runEventIdentity,
      });
    }
    // Goal slices are child runs of one long-lived logical turn. The outer
    // Goal runtime alone decides whether evidence is sufficient to terminate
    // that turn; a locally completed slice must not consume the one terminal
    // turn event before later slices run.
    if (resolveRunEventIdentity().goalSliceId) return;
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
    if (!runTerminalEmitted) {
      const runEventIdentity = resolveRunEventIdentity();
      runTerminalEmitted = true;
      emitTurnEvent({
        type: "run.failed",
        threadId: eventThreadId,
        turnId: eventTurnId,
        timestampMs: Date.now(),
        error: { message },
        ...runEventIdentity,
      });
    }
    // Inner Goal failures can be recoverable and may advance to another slice.
    // Preserve the run.failed evidence, but defer turn.failed to the outer
    // Goal state machine.
    if (resolveRunEventIdentity().goalSliceId) return;
    turnEventTerminalEmitted = true;
    emitTurnEvent({
      type: "turn.failed",
      threadId: eventThreadId,
      turnId: eventTurnId,
      timestampMs: Date.now(),
      error: { message },
    });
  };
  const emitRunPausedEvent = (
    reason: string,
    message: string,
    progress?: MainThreadProgressUpdate,
  ) => {
    if (runTerminalEmitted) return false;
    const runEventIdentity = resolveRunEventIdentity();
    runTerminalEmitted = true;
    emitTurnEvent({
      type: "run.paused",
      threadId: eventThreadId,
      turnId: eventTurnId,
      timestampMs: Date.now(),
      reason,
      message,
      ...(progress ? { progress } : {}),
      ...runEventIdentity,
    });
    return true;
  };
  if (runIdentity.goalSliceId) {
    callbacks.onHarnessRunUpdate?.({ lastGoalSliceRunId: runIdentity.runId });
  }
  logAgentEvent("run_identity_resolved", {
    threadId: eventThreadId,
    turnId: eventTurnId,
    runId: runIdentity.runId,
    parentRunId: runIdentity.parentRunId,
    outerRunId: runIdentity.outerRunId,
    goalSliceId: runIdentity.goalSliceId || null,
    continuesTurn: eventContinuesTurn,
    source: runIdentity.source,
  });
  return {
    eventThreadId,
    eventTurnId,
    eventRunId: initialRunEventIdentity.runId,
    eventParentRunId: initialRunEventIdentity.parentRunId,
    ...(initialRunEventIdentity.goalSliceId ? { eventGoalSliceId: initialRunEventIdentity.goalSliceId } : {}),
    eventContinuesTurn,
    emitTurnEvent,
    emitTurnCompletedEvent,
    emitTurnFailedEvent,
    emitRunPausedEvent,
  };
}

export function emitInitialTurnPreparationEvents(input: {
  callbacks: OrchestratorCallbacks;
  runtimeState: AgentLoopRuntimeState;
  turnEvents: TurnEventEmitter;
}): void {
  const { callbacks, runtimeState, turnEvents } = input;
  const {
    config,
    effectiveToolProtocol,
    modelProtocolProfile,
    nativeToolsEnabled,
    reasoningPolicy,
    settings,
    turnIntent,
    workflowMode,
  } = runtimeState;
  const {
    eventThreadId,
    eventTurnId,
    eventRunId,
    eventParentRunId,
    eventGoalSliceId,
    eventContinuesTurn,
    emitTurnEvent,
  } = turnEvents;

  if (!eventContinuesTurn) {
    if (!callbacks.hasRuntimeThreadStarted?.(eventThreadId)) {
      emitTurnEvent({
        type: "thread.started",
        threadId: eventThreadId,
        timestampMs: Date.now(),
      });
    }
    emitTurnEvent({
      type: "turn.started",
      threadId: eventThreadId,
      turnId: eventTurnId,
      timestampMs: Date.now(),
    });
  }
  emitTurnEvent({
    type: "run.started",
    threadId: eventThreadId,
    turnId: eventTurnId,
    timestampMs: Date.now(),
    runId: eventRunId,
    parentRunId: eventParentRunId,
    ...(eventGoalSliceId ? { goalSliceId: eventGoalSliceId } : {}),
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
        audience: "internal",
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
}
