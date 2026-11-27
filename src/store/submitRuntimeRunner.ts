import { normalizeTurnApprovalCapabilities, normalizeTurnCapabilityRestrictions } from "../lib/turnCapabilities";
import type {
  SubmissionRuntimeContext,
  SubmissionRuntimeStorePorts,
} from "../lib/submissionRuntimeContracts";
import type { RuntimeRunSettlement } from "../lib/runtimeRunSettlement";
import { saveProjectSession } from "../lib/ipc";
import {
  resolveRuntimeV2VisibleRunnerKind,
  resolveRuntimeEngineVersion,
} from "../lib/runtimeEngineSelection";
import { computeRuntimeContextBudget, resolveRuntimeContextBudget } from "../lib/runtimeContextBudget";
import { runSubmitRuntimeV2Chat } from "./runtimeV2/chatRunner";
import { runSubmitRuntimeV2Execute } from "./runtimeV2/executeRunner";
import { runSubmitRuntimeV2Plan } from "./runtimeV2/planRunner";
import { runSubmitRuntimeV2WorkspaceRead } from "./runtimeV2/workspaceReadRunner";
import { withRuntimeV2ContextBudget } from "./runtimeV2/submissionContext";
import { handleRuntimeV2IntentClarification } from "./runtimeV2/intentClarification";
import { prepareKnowledgeContext } from "./prepareKnowledgeContext";
import { estimateMessagesTokens } from "../lib/contextTrim";
import { normalizeKnowledgeReferences } from "../lib/knowledgeReferences";
import { resolveActiveEngineKnowledgeReferences } from "../lib/engineManualBinding";
import { mergeEngineNavigatorSkillsIntoCatalog } from "../lib/agentSkills";
import { resolveWorkspaceEngineProfile } from "../lib/workspaceEngineProfile";

type SubmitRuntimeStoreGet = () => any;
type SubmitRuntimeStoreSet = any;

type SubmitRuntimePortInputs = Pick<
  SubmissionRuntimeStorePorts,
  | "sanitizeTaskBlocksForPersist"
  | "buildSessionRuntimeSnapshot"
  | "getSessionRevisionToken"
  | "publishOwnerScopedRuntimeProjection"
  | "logStoreEvent"
>;

export interface RunSubmitRuntimeInput extends SubmitRuntimePortInputs {
  get: SubmitRuntimeStoreGet;
  set: SubmitRuntimeStoreSet;
  context: SubmissionRuntimeContext;
  /** Injection seam shared by submission and Runtime v2 checkpoint persistence. */
  persistSessionRecord?: SubmissionRuntimeStorePorts["persistSessionRecord"];
}

export async function runSubmitRuntime(
  input: RunSubmitRuntimeInput,
): Promise<RuntimeRunSettlement> {
  const turn = input.get().conversationTurns?.find((candidate: any) => candidate.id === input.context.turnId);
  const admittedVersion = resolveRuntimeEngineVersion(turn?.runtimeEngineVersion);
  const runtimeV2RunnerKind = resolveRuntimeV2VisibleRunnerKind({
    effectiveIntent: input.context.effectiveRunIntent,
    runtimeIntent: input.context.runtimeRunIntent,
    runWorkspace: input.context.runWorkspace,
    hasAttachedFiles:
      input.context.turnInputContextSignals.attachedFilePaths.length > 0 ||
      !!input.context.turnInputContextSignals.mentionedFilePaths?.length,
    requiredCapabilities: input.context.requiredCapabilities,
    checkpointStrategy: input.context.restoredReadOnlyStrategy,
  });
  if (admittedVersion !== "v2") {
    input.logStoreEvent("runtime_v2_turn_marker_missing", {
      turnId: input.context.turnId,
      runtimeIntent: input.context.runtimeRunIntent,
      admittedVersion,
      action: "fail_closed_without_legacy_fallback",
    });
    throw new Error("RUNTIME_V2_TURN_ADMISSION_REQUIRED");
  }
  const clarification = await handleRuntimeV2IntentClarification({ ...input, persistSessionRecord: input.persistSessionRecord || saveProjectSession }, runtimeV2RunnerKind);
  if (clarification) return clarification;
  const runtimeConfig = input.get().config || {};
  const runtimeContextBudgetPromise = runtimeV2RunnerKind === "chat" && input.context.preparedChatAnswer
    ? computeRuntimeContextBudget({ configuredContextLimit: runtimeConfig.local?.contextLimit, providerContextLimit: null,
      modelLoaded: null, availableMemoryBytes: null })
    : resolveRuntimeContextBudget(runtimeConfig);
  const rawExplicitReferences =
    input.context.knowledgeReferences || input.context.options?.knowledgeReferencesSnapshot || [];
  const explicitReferences = normalizeKnowledgeReferences(rawExplicitReferences);
  const contextPaths = [...new Set([
    ...(input.context.turnInputContextSignals.mentionedFilePaths || []),
    ...input.context.turnInputContextSignals.attachedFilePaths,
  ])];
  const prompt = turn?.userPrompt || "";
  const engineSpecificRequest =
    /\b(?:unity|tuanjie|godot|unreal|ue[456]|uefn|monobehaviour|uobject|projectversion|build\.cs)\b|团结引擎|引擎版本/i.test(prompt);
  const engineSourcePaths = contextPaths.some(path =>
    /\.(?:cs|asmdef|asmref|gd|gdshader|godot|uproject|uefnproject|cpp|h|hpp|verse)(?:#L\d+(?:-L\d+)?|:\d+(?::\d+)?)?$/i.test(path));
  const projectDetailsRelevant = engineSpecificRequest || input.context.requiredCapabilities?.includes("command") ||
    ((runtimeV2RunnerKind === "execute" || runtimeV2RunnerKind === "plan") &&
      (engineSourcePaths || !!input.context.sourceInvestigationTurnId));
  const canInspectEngine = runtimeV2RunnerKind !== "chat" && !!input.context.runWorkspace && projectDetailsRelevant &&
    !normalizeTurnCapabilityRestrictions(input.context.capabilityRestrictions).includes("workspace_read") &&
    !normalizeTurnApprovalCapabilities(input.context.approvalRequiredCapabilities).includes("workspace_read");
  const engineContextPromise = (async () => {
    const engineProfile = canInspectEngine ? await resolveWorkspaceEngineProfile(input.context.runWorkspace, { contextPaths }) : null;
    const needsManual = Boolean(explicitReferences?.length) || (engineSpecificRequest &&
      /\b(?:api|manual|docs?|documentation|compatib\w*|version)\b|文档|手册|版本|兼容|接口用法/i.test(prompt));
    const manuals = needsManual && engineProfile?.manualPresetId
      ? await resolveActiveEngineKnowledgeReferences({
          workspaceEngineProfile: engineProfile,
          knowledgeBases: Array.isArray(input.get().knowledgeBases) ? input.get().knowledgeBases : [],
          explicitReferences: explicitReferences || undefined,
        })
      : null;
    return { engineProfile, manuals };
  })();
  const [runtimeContextBudget, { engineProfile, manuals: resolvedEngineManuals }] = await Promise.all([
    runtimeContextBudgetPromise, engineContextPromise,
  ]);
  const budgetedContext = withRuntimeV2ContextBudget(input.context, runtimeContextBudget);
  const effectiveReferences = resolvedEngineManuals ? resolvedEngineManuals.references : rawExplicitReferences;
  const knowledgeContext = effectiveReferences.length ? await prepareKnowledgeContext({
    references: effectiveReferences,
    query: turn?.userPrompt || "",
    budget: runtimeContextBudget,
    reservedInputTokens: estimateMessagesTokens(input.get().agentMessages || []),
    signal: input.context.abortCtrl.signal,
  }) : undefined;
  const skillCatalog = resolvedEngineManuals?.activePresetIds.length
    ? mergeEngineNavigatorSkillsIntoCatalog(budgetedContext.skillCatalog, resolvedEngineManuals.activePresetIds)
    : budgetedContext.skillCatalog;
  const runtimeContext = {
    ...budgetedContext,
    knowledgeContext,
    skillCatalog,
    ...(canInspectEngine ? {
      workspaceInstructionContext: [budgetedContext.workspaceInstructionContext,
        engineProfile ? `[WORKSPACE ENGINE METADATA]\n${JSON.stringify(engineProfile)}\nRead-only project facts. Use existing project validation commands from this root when authorized. A version, editor diagnostic, or language parse is not proof of a project build or test.`
          : "[WORKSPACE ENGINE METADATA]\nNo unique engine project root was resolved inside the admitted workspace. Source inspection can proceed. Use an existing workspace validation command when available. If a project-level check needs another root and there are multiple plausible choices, ask for the intended project. Report unavailable verification when the workspace only contains source files."].filter(Boolean).join("\n\n"),
    } : {}),
  };
  input.logStoreEvent("runtime_v2_context_budget_resolved", {
    turnId: input.context.turnId,
    runId: input.context.harnessRunId,
    profile: input.get().config?.activeProfile === "cloud"
      ? "cloud"
      : "local",
    contextLimit: runtimeContextBudget?.contextLimit ?? null,
    inputBudget: runtimeContextBudget?.inputBudget ?? null,
    outputBudget: runtimeContextBudget?.outputBudget ?? null,
    readWindowChars: runtimeContextBudget?.readWindowChars ?? null,
    source: runtimeContextBudget?.source ?? "provider_managed",
    providerContextLimit:
      runtimeContextBudget?.providerContextLimit ?? null,
    providerOutputLimit:
      runtimeContextBudget?.providerOutputLimit ?? null,
    preserveAssistantReasoning:
      runtimeContextBudget?.preserveAssistantReasoning ?? null,
    availableMemoryBytes:
      runtimeContextBudget?.availableMemoryBytes ?? null,
  });
  if (runtimeV2RunnerKind === "execute") {
    return runSubmitRuntimeV2Execute({
      get: input.get,
      set: input.set,
      context: runtimeContext,
      getSessionRevisionToken: input.getSessionRevisionToken,
      sanitizeTaskBlocksForPersist: input.sanitizeTaskBlocksForPersist,
      buildSessionRuntimeSnapshot: input.buildSessionRuntimeSnapshot,
      publishOwnerScopedRuntimeProjection: input.publishOwnerScopedRuntimeProjection,
      persistSessionRecord: input.persistSessionRecord || saveProjectSession,
      logStoreEvent: input.logStoreEvent,
    });
  }
  if (runtimeV2RunnerKind === "plan") {
    return runSubmitRuntimeV2Plan({
      get: input.get,
      set: input.set,
      context: runtimeContext,
      getSessionRevisionToken: input.getSessionRevisionToken,
      sanitizeTaskBlocksForPersist: input.sanitizeTaskBlocksForPersist,
      buildSessionRuntimeSnapshot: input.buildSessionRuntimeSnapshot,
      publishOwnerScopedRuntimeProjection: input.publishOwnerScopedRuntimeProjection,
      persistSessionRecord: input.persistSessionRecord || saveProjectSession,
      logStoreEvent: input.logStoreEvent,
    });
  }
  if (runtimeV2RunnerKind === "chat") {
    return runSubmitRuntimeV2Chat({
      get: input.get,
      set: input.set,
      context: runtimeContext,
      getSessionRevisionToken: input.getSessionRevisionToken,
      sanitizeTaskBlocksForPersist: input.sanitizeTaskBlocksForPersist,
      buildSessionRuntimeSnapshot: input.buildSessionRuntimeSnapshot,
      publishOwnerScopedRuntimeProjection: input.publishOwnerScopedRuntimeProjection,
      persistSessionRecord: input.persistSessionRecord || saveProjectSession,
      logStoreEvent: input.logStoreEvent,
    });
  }
  if (runtimeV2RunnerKind === "workspace_read") {
    return runSubmitRuntimeV2WorkspaceRead({
      get: input.get,
      set: input.set,
      context: runtimeContext,
      getSessionRevisionToken: input.getSessionRevisionToken,
      sanitizeTaskBlocksForPersist: input.sanitizeTaskBlocksForPersist,
      buildSessionRuntimeSnapshot: input.buildSessionRuntimeSnapshot,
      publishOwnerScopedRuntimeProjection: input.publishOwnerScopedRuntimeProjection,
      persistSessionRecord: input.persistSessionRecord || saveProjectSession,
      logStoreEvent: input.logStoreEvent,
    });
  }
  input.logStoreEvent("runtime_v2_unsupported_intent", {
    turnId: input.context.turnId,
    effectiveIntent: input.context.effectiveRunIntent,
    runtimeIntent: input.context.runtimeRunIntent,
  });
  throw new Error(
    `RUNTIME_V2_UNSUPPORTED_INTENT:${input.context.runtimeRunIntent}`,
  );
}
