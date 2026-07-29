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
import { resolveRuntimeContextBudget } from "../lib/runtimeContextBudget";
import { runSubmitRuntimeV2Chat } from "./runtimeV2/chatRunner";
import { runSubmitRuntimeV2Execute } from "./runtimeV2/executeRunner";
import { runSubmitRuntimeV2Goal } from "./runtimeV2/goalProductionRunner";
import { runSubmitRuntimeV2Plan } from "./runtimeV2/planRunner";
import { runSubmitRuntimeV2Studio } from "./runtimeV2/studioRunner";
import { createRuntimeV2StudioReceiptFilePort } from "./runtimeV2/studioReceiptFilePort";
import { runSubmitRuntimeV2WorkspaceRead } from "./runtimeV2/workspaceReadRunner";
import type {
  RuntimeV2GameStudioServicePort,
} from "./runtimeV2/studioAdapter";
import type { RuntimeV2StudioAction } from "../lib/runtime-v2";
import { withRuntimeV2ContextBudget } from "./runtimeV2/submissionContext";

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
  runtimeService: RuntimeV2GameStudioServicePort;
  studioActions?: readonly RuntimeV2StudioAction[];
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
  const runtimeContextBudget = await resolveRuntimeContextBudget(
    input.get().config || {},
  );
  const runtimeContext = withRuntimeV2ContextBudget(
    input.context,
    runtimeContextBudget,
  );
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
  if (runtimeV2RunnerKind === "goal") {
    return runSubmitRuntimeV2Goal({
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
  if (
    runtimeV2RunnerKind === "studio" &&
    input.studioActions &&
    input.studioActions.length > 0
  ) {
    const workspace = String(input.context.runWorkspace || "").trim();
    return runSubmitRuntimeV2Studio({
      get: input.get,
      set: input.set,
      context: runtimeContext,
      actions: input.studioActions,
      runtimeService: input.runtimeService,
      studioReceipts: createRuntimeV2StudioReceiptFilePort({ workspace }),
      getSessionRevisionToken: input.getSessionRevisionToken,
      sanitizeTaskBlocksForPersist: input.sanitizeTaskBlocksForPersist,
      buildSessionRuntimeSnapshot: input.buildSessionRuntimeSnapshot,
      publishOwnerScopedRuntimeProjection: input.publishOwnerScopedRuntimeProjection,
      persistSessionRecord: input.persistSessionRecord || saveProjectSession,
      logStoreEvent: input.logStoreEvent,
    });
  }
  if (runtimeV2RunnerKind === "studio") {
    // Ordinary Game Studio work remains one Execute Turn. Only deterministic
    // setup/onboarding actions use the dedicated external-effect adapter.
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
