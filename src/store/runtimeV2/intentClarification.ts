import { pausedAgentLoopOutcome } from "../../lib/runOutcome";
import { isProjectBaselineForWorkspace } from "../../lib/workspaceAdmission";
import type { RuntimeV2VisibleRunnerKind } from "../../lib/runtimeEngineSelection";
import { createRuntimeV2CheckpointPort, getRuntimeV2Checkpoint } from "./checkpointPort";
import { createRuntimeV2RunnerIdentity, createRuntimeV2RunnerSettlement } from "./executionRunnerIdentity";
import { projectRuntimeV2ExecutionBlocker } from "./executionBlocker";
import type { RuntimeV2ExecuteRunnerInput } from "./executeRunner";
import { PlanLedger } from "./planLedger";
import { resolveRuntimeV2ObjectiveAdmission } from "./submissionContext";
import { createRuntimeV2ProjectionPort } from "./projectionPort";

/** Shared admission gate. A question preserves the original strategy, Turn,
 * Run, constraints and acceptance; it never creates tool approval. */
export async function handleRuntimeV2IntentClarification(input: RuntimeV2ExecuteRunnerInput, kind: RuntimeV2VisibleRunnerKind | null) {
  if (!input.context.runWorkspace) return null;
  const state = input.get();
  const turn = state.conversationTurns?.find((item: any) => item.id === input.context.turnId);
  if (!turn) return null;
  const identity = createRuntimeV2RunnerIdentity(state, input.context, turn);
  const existing = getRuntimeV2Checkpoint(state, identity.turn);
  const initial = !existing && input.context.intentClarification;
  const blocker = existing?.aggregate.run?.blocker;
  if (!initial && !(existing?.aggregate.run?.status === "paused" && blocker?.reasonCode === "intent_clarification")) return null;
  if (existing && existing.aggregate.run?.identity.runId !== identity.run.runId) throw new Error("RUNTIME_V2_CLARIFICATION_OWNER_MISMATCH");
  const checkpoint = createRuntimeV2CheckpointPort({ ...input, scopeKey: input.context.runScopeKey, sessionId: input.context.runSessionId });
  const ledger = new PlanLedger(identity.turn, checkpoint, createRuntimeV2ProjectionPort({ ...input,
    language: input.context.phaseLanguage, nextTaskId: () => input.get()._nextTaskId() }), existing || null);
  if (initial) {
    const admission = resolveRuntimeV2ObjectiveAdmission(input.context, turn.userPrompt);
    const strategy = kind === "workspace_read" ? "analyze" : kind === "chat" ? "chat" : kind === "plan" ? "plan" : "execute";
    const readOnly = strategy === "analyze" || strategy === "chat";
    await ledger.append({ type: "turn.admitted", turn: identity.turn, strategy, objective: admission.objective,
      capabilityRestrictions: admission.capabilityRestrictions, approvalRequiredCapabilities: admission.approvalRequiredCapabilities,
      networkRead: input.context.networkRead,
      subagentRequirement: input.context.turnInputContextSignals?.subagentRequirement === "required" ? "required" : "optional",
      constraints: readOnly ? ["read_only", "no_external_side_effects", ...admission.constraints] : admission.constraints,
      acceptanceCriteria: readOnly ? ["current_complete_answer_without_unexecuted_actions"] : admission.acceptanceCriteria.map(item => item.text),
      acceptanceCriterionIds: readOnly ? undefined : admission.acceptanceCriteria.map(item => item.id),
      acceptanceEvidenceRequirements: readOnly ? undefined : admission.acceptanceCriteria.map(item => item.evidenceRequirement || (strategy === "plan" ? "behavioral" : null)) });
    await ledger.append({ type: "run.started", run: identity.run,
      phase: strategy === "plan" ? "planning" : strategy === "execute" && !isProjectBaselineForWorkspace(input.context.projectBaselineContext, input.context.runWorkspace) ? "preparing" : "observing" });
    await ledger.append({ type: "run.paused", run: identity.run, blocker: {
      requestId: ledger.nextId("intent-clarification"), reasonCode: "intent_clarification",
      evidenceSequence: ledger.snapshot()!.nextSequence - 1,
      message: initial.question, clarification: initial, options: ["recheck", "stop"],
    } });
  } else if (blocker?.decision && blocker.decision !== "stop") {
    await ledger.append({ type: "run.resumed", run: identity.run, requestId: blocker.requestId });
    input.set({ activeActionRequest: null });
    return null;
  }
  projectRuntimeV2ExecutionBlocker({ aggregate: ledger.snapshot()!, get: input.get, set: input.set, language: input.context.phaseLanguage });
  input.logStoreEvent("runtime_v2_intent_clarification_paused", { turnId: identity.turn.turnId, runId: identity.run.runId, kind: ledger.snapshot()!.run?.blocker?.clarification?.kind });
  return createRuntimeV2RunnerSettlement(input.context, pausedAgentLoopOutcome("intent_clarification", "action_required"));
}
