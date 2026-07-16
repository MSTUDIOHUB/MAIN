import type { HydratedPlanArtifacts } from "../lib/planArtifactHydration";
import {
  shouldPromoteHydratedPlanToExecuting,
  type PlanStateHydrationReason,
} from "../lib/planStateHydration";
import { resolveSessionRuntimeKey, resolveSessionWorkspaceKey } from "../lib/sessionTypes";
import { appendRuntimeEvent, withEventSchema } from "../lib/turnEvents";
import type { PlanArtifact, PlanStage, PlanTask } from "../lib/workflowModels";

type SubmitPlanHydrationGet = () => any;
type SubmitPlanHydrationSet = (patch: any) => void;

export interface SubmitPlanHydrationOptions {
  preservePlanState?: boolean;
  [key: string]: unknown;
}

export interface RunSubmitPlanHydrationEffectInput {
  reason: PlanStateHydrationReason;
  text: string;
  images?: string[];
  options?: SubmitPlanHydrationOptions;
  preferredLanguage: "zh" | "en";
  workspace: string;
  sendOriginSessionKey: string | null | undefined;
  getState: SubmitPlanHydrationGet;
  setState: SubmitPlanHydrationSet;
  hydrateExistingPlanArtifactsForWorkspace: (
    workspace: string,
    language: "zh" | "en",
  ) => Promise<HydratedPlanArtifacts>;
  derivePlanStageFromArtifacts: (
    artifacts: PlanArtifact[],
    tasks: PlanTask[],
    isPlanApproved: boolean,
    currentStage: PlanStage,
  ) => PlanStage;
  isSessionRuntimeActive: (state: any, sessionKey: string) => boolean;
  resumeSubmission: (
    text: string,
    images: string[] | undefined,
    options: SubmitPlanHydrationOptions,
  ) => void;
  logStoreEvent: (event: string, data?: Record<string, unknown>) => void;
  nowMs?: () => number;
}

export async function runSubmitPlanHydrationEffect(
  input: RunSubmitPlanHydrationEffectInput,
): Promise<void> {
  const nowMs = input.nowMs || Date.now;
  let hydrated: HydratedPlanArtifacts | null = null;
  try {
    hydrated = await input.hydrateExistingPlanArtifactsForWorkspace(
      input.workspace,
      input.preferredLanguage,
    );
  } catch {
    hydrated = null;
  }

  // Hydration itself writes Plan state, so stale-session rejection must happen
  // before applying the hydrated artifact projection, not only before the
  // recursive submission below. The supplied identity is always populated by
  // sendMessage, including workspace-only submissions without a session id.
  const stateAfterHydrationRead = input.getState();
  if (
    input.sendOriginSessionKey &&
    !input.isSessionRuntimeActive(stateAfterHydrationRead, input.sendOriginSessionKey)
  ) {
    input.logStoreEvent("send_async_resume_skipped_inactive_session", {
      phase: "auto_plan_hydration",
      sessionKey: input.sendOriginSessionKey,
    });
    return;
  }

  const shouldPromoteToExecuting = shouldPromoteHydratedPlanToExecuting(input.reason);
  const hasHydratedData = !!hydrated && (hydrated.artifacts.length > 0 || hydrated.tasks.length > 0);
  if (hydrated && hasHydratedData) {
    input.setState((s: any) => {
      const alreadyHasPlanState =
        s.planArtifacts.length > 0 ||
        s.planTasks.length > 0 ||
        s.planStage !== "idle";
      if (alreadyHasPlanState) return {};
      const baseStage = input.derivePlanStageFromArtifacts(
        hydrated.artifacts,
        hydrated.tasks,
        shouldPromoteToExecuting,
        s.planStage,
      );
      const nextStage =
        shouldPromoteToExecuting && (baseStage === "idle" || baseStage === "ready_to_execute")
          ? "executing"
          : baseStage;
      const threadId =
        resolveSessionRuntimeKey(resolveSessionWorkspaceKey(s.currentWorkspace), s.currentSessionId) ||
        "default";
      const nextEvent = withEventSchema({
        type: "plan_state_hydrated",
        threadId,
        turnId: s.currentTurnId || undefined,
        timestampMs: nowMs(),
        reason: input.reason,
        taskCount: hydrated.tasks.length,
        artifactPaths: hydrated.artifacts.map((artifact) => artifact.path),
      });
      return {
        planArtifacts: hydrated.artifacts,
        planTasks: hydrated.tasks,
        planStage: nextStage,
        isPlanApproved: shouldPromoteToExecuting || s.isPlanApproved,
        showPlanPanel: true,
        rightPanelTab: "plan",
        showDiff: false,
        runtimeEvents: appendRuntimeEvent(s.runtimeEvents, nextEvent),
      };
    });
    input.logStoreEvent("plan_state_hydrated", {
      workspace: input.workspace || null,
      reason: input.reason,
      artifacts: hydrated.artifacts.map((artifact) => artifact.path),
      taskCount: hydrated.tasks.length,
    });
  }

  const nextOptions: SubmitPlanHydrationOptions = {
    ...(input.options || {}),
    skipAutoPlanHydration: true,
    preservePlanState:
      input.options?.preservePlanState === true || (hasHydratedData && shouldPromoteToExecuting),
  };
  const latestState = input.getState();
  if (
    input.sendOriginSessionKey &&
    !input.isSessionRuntimeActive(latestState, input.sendOriginSessionKey)
  ) {
    input.logStoreEvent("send_async_resume_skipped_inactive_session", {
      phase: "auto_plan_hydration",
      sessionKey: input.sendOriginSessionKey,
    });
    return;
  }
  input.resumeSubmission(input.text, input.images, nextOptions);
}

export function startSubmitPlanHydrationEffect(
  input: RunSubmitPlanHydrationEffectInput,
): void {
  void runSubmitPlanHydrationEffect(input);
}
