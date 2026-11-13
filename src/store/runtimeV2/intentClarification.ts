import { pausedAgentLoopOutcome } from "../../lib/runOutcome";
import { inferCommandDirective } from "../../lib/runIntent";
import type { TurnClarification } from "../../lib/turnClarification";
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
  const { context } = input;
  if (!context.runWorkspace && kind !== "execute") return null;
  const state = input.get();
  const turn = state.conversationTurns?.find((item: any) => item.id === context.turnId);
  if (!turn) return null;
  const identity = createRuntimeV2RunnerIdentity(state, context, turn);
  const existing = getRuntimeV2Checkpoint(state, identity.turn);
  const aggregate = existing?.aggregate;
  const blocker = aggregate?.run?.blocker;
  const admission = existing ? null : resolveRuntimeV2ObjectiveAdmission(context, turn.userPrompt);
  const unclassified = kind === "execute" && !context.approvedPlanContinuation &&
    (aggregate?.objective.completionRequirement ?? admission?.completionRequirement)?.kind === "unspecified";
  const pausedForClarification = aggregate?.run?.status === "paused" && blocker?.reasonCode === "intent_clarification";
  const canAsk = !existing || aggregate?.run?.status === "running" && !aggregate.scheduledCommands.length && !aggregate.pendingToolCalls.length;
  if (!pausedForClarification && !(canAsk && (unclassified || !existing && context.intentClarification))) return null;
  if (existing && existing.aggregate.run?.identity.runId !== identity.run.runId) throw new Error("RUNTIME_V2_CLARIFICATION_OWNER_MISMATCH");
  const checkpoint = createRuntimeV2CheckpointPort({ ...input, scopeKey: context.runScopeKey, sessionId: context.runSessionId });
  const ledger = new PlanLedger(identity.turn, checkpoint, createRuntimeV2ProjectionPort({ ...input,
    language: context.phaseLanguage, nextTaskId: () => input.get()._nextTaskId() }), existing || null);
  const clarifyObjective: TurnClarification = {
    kind: "missing_input", field: "objective", evidence: turn.userPrompt.slice(0, 512),
    question: context.phaseLanguage === "zh"
      ? "请明确希望修改的内容、要运行的命令，或要执行的外部操作。"
      : "What should I change, which command should I run, or which external action should I perform?",
  };
  let clarification = pausedForClarification ? undefined : context.intentClarification || clarifyObjective;
  if (admission) {
    const strategy = kind === "workspace_read" ? "analyze" : kind === "chat" ? "chat" : kind === "plan" ? "plan" : "execute";
    const readOnly = strategy === "analyze" || strategy === "chat";
    await ledger.append({ type: "turn.admitted", turn: identity.turn, strategy, objective: admission.objective,
      ...(strategy === "execute" && admission.completionRequirement ? { completionRequirement: admission.completionRequirement } : {}),
      capabilityRestrictions: admission.capabilityRestrictions, approvalRequiredCapabilities: admission.approvalRequiredCapabilities,
      networkRead: context.networkRead,
      workspaceInstructionContext: context.workspaceInstructionContext,
      subagentRequirement: context.turnInputContextSignals?.subagentRequirement === "required" ? "required" : "optional",
      constraints: readOnly ? ["read_only", "no_external_side_effects", ...admission.constraints] : admission.constraints,
      acceptanceCriteria: readOnly ? ["current_complete_answer_without_unexecuted_actions"] : admission.acceptanceCriteria.map(item => item.text),
      acceptanceCriterionIds: readOnly ? undefined : admission.acceptanceCriteria.map(item => item.id),
      acceptanceEvidenceRequirements: readOnly ? undefined : admission.acceptanceCriteria.map(item => item.evidenceRequirement || (strategy === "plan" ? "behavioral" : null)) });
    await ledger.append({ type: "run.started", run: identity.run,
      phase: strategy === "plan" ? "planning" : strategy === "execute" && context.runWorkspace &&
        !isProjectBaselineForWorkspace(context.projectBaselineContext, context.runWorkspace) ? "preparing" : "observing" });
  } else if (pausedForClarification && blocker?.decision && blocker.decision !== "stop") {
    const reply = blocker.decisionReply;
    const next = unclassified && reply ? resolveRuntimeV2ObjectiveAdmission({
      ...context, semanticWorkType: undefined, requiredCapabilities: undefined,
      effectiveCommandDirective: inferCommandDirective(reply, "execute"),
    }, reply).completionRequirement : undefined;
    const completionRequirement = next?.kind !== "unspecified" ? next : undefined;
    await ledger.append({ type: "run.resumed", run: identity.run, requestId: blocker.requestId,
      ...(completionRequirement ? { completionRequirement } : {}) });
    if (!unclassified || completionRequirement) {
      input.set({ activeActionRequest: null });
      return null;
    }
    clarification = clarifyObjective;
  }
  if (clarification) {
    await ledger.append({ type: "run.paused", run: identity.run, blocker: {
      requestId: ledger.nextId("intent-clarification"), reasonCode: "intent_clarification",
      evidenceSequence: ledger.snapshot()!.nextSequence - 1,
      message: clarification.question, clarification, options: ["recheck", "stop"],
    } });
  }
  projectRuntimeV2ExecutionBlocker({ aggregate: ledger.snapshot()!, get: input.get, set: input.set, language: context.phaseLanguage });
  input.logStoreEvent("runtime_v2_intent_clarification_paused", { turnId: identity.turn.turnId, runId: identity.run.runId, kind: ledger.snapshot()!.run?.blocker?.clarification?.kind });
  return createRuntimeV2RunnerSettlement(context, pausedAgentLoopOutcome("intent_clarification", "action_required"));
}
