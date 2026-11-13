import { getRuntimeV2Checkpoint, createRuntimeV2CheckpointPort } from "./checkpointPort";
import { createRuntimeV2ProjectionPort } from "./projectionPort";
import { createRuntimeV2RunnerIdentity, createRuntimeV2RunnerSettlement } from "./executionRunnerIdentity";
import { resolveRuntimeV2ObjectiveAdmission } from "./submissionContext";
import { PlanLedger } from "./planLedger";
import { abortedAgentLoopOutcome, completedAgentLoopOutcome } from "../../lib/runOutcome";
import type { RuntimeV2PlanRunnerInput } from "./planRunnerTypes";
import { runPlanDocumentInterview } from "./planDocumentRunner";
import { inspectProjectInitTarget } from "../../lib/ipc";
import { normalizeNetworkRead } from "../../lib/networkRead";
import { projectWorkspaceIdentity } from "../../lib/projectInitIpc";
import { settlePlanPause } from "./planQuestionControl";

/** One durable interview owner, shared by conceptual plans and /规则 drafts. */
export async function runRuntimeV2PlanInterview(input: RuntimeV2PlanRunnerInput) {
  const state = input.get();
  const turn = state.conversationTurns?.find((item: any) => item.id === input.context.turnId);
  if (!turn) throw new Error("PLAN_INTERVIEW_TURN_MISSING");
  const identity = createRuntimeV2RunnerIdentity(state, input.context, turn);
  const existing = getRuntimeV2Checkpoint(state, identity.turn);
  // Executable draft continuations and interrupted draft saves are owned by
  // the WorkPlan runner. A saved draft must never become document success.
  if (input.context.sourcePlanDraft || input.context.approvedPlanContinuation || turn.approvedPlanContinuation || existing?.aggregate.events.some(event =>
    (event.type === "turn.admitted" && event.sourcePlanDraft) ||
    (event.type === "command.scheduled" && event.command.payload.planDraftMetadata))) return null;
  if (existing?.aggregate.sealedWorkPlan) return null;
  const questions = (existing?.aggregate.events || []).filter(event => event.type === "run.paused" && event.blocker.questionnaire);
  // Existing pre-interview WorkPlan checkpoints retain their original contract.
  if (existing && !existing.aggregate.planPurpose && !questions.length) return null;
  input = { ...input, context: { ...input.context, planPurpose: existing ? existing.aggregate.planPurpose || "plan" : input.context.planPurpose || "plan", workspaceInstructionContext: existing?.aggregate.workspaceInstructionContext ?? input.context.workspaceInstructionContext, knowledgeContext: existing ? existing.aggregate.knowledgeContext : input.context.knowledgeContext } };
  const ledger = new PlanLedger(identity.turn, createRuntimeV2CheckpointPort({ ...input, scopeKey: input.context.runScopeKey, sessionId: input.context.runSessionId }),
    createRuntimeV2ProjectionPort({ ...input, language: input.context.phaseLanguage, nextTaskId: () => input.get()._nextTaskId() }), existing || null, input.logStoreEvent);
  try {
  if (!existing) {
    const admission = resolveRuntimeV2ObjectiveAdmission(input.context, turn.userPrompt);
    await ledger.append({ type: "turn.admitted", turn: identity.turn, strategy: "plan", planPurpose: input.context.planPurpose || "plan", ...(typeof input.context.workspaceInstructionContext === "string" ? { workspaceInstructionContext: input.context.workspaceInstructionContext } : {}), ...(input.context.knowledgeContext ? { knowledgeContext: input.context.knowledgeContext } : {}), networkRead: normalizeNetworkRead(input.context.networkRead),
      objective: admission.objective, constraints: admission.constraints, ...(admission.capabilityRestrictions !== undefined ? { capabilityRestrictions: admission.capabilityRestrictions } : {}), ...(admission.approvalRequiredCapabilities !== undefined ? { approvalRequiredCapabilities: admission.approvalRequiredCapabilities } : {}),
      acceptanceCriteria: admission.acceptanceCriteria.map(item => item.text), acceptanceCriterionIds: admission.acceptanceCriteria.map(item => item.id),
      ...(admission.acceptanceCriteria.some(item => item.evidenceRequirement) ? { acceptanceEvidenceRequirements: admission.acceptanceCriteria.map(item => item.evidenceRequirement ?? null) } : {}),
      subagentRequirement: input.context.turnInputContextSignals.subagentRequirement || "optional" });
  }
  if (!ledger.snapshot()!.run) {
    await ledger.append({ type: "run.started", run: identity.run, phase: "planning", ...(Number.isFinite(input.lifecycleDeadlineAt) ? { lifecycleDeadlineAt: input.lifecycleDeadlineAt } : {}) });
  }
  if (ledger.snapshot()!.terminalOutcome) {
    const terminal = ledger.snapshot()!.terminalOutcome!;
    await ledger.finishTerminal({ run: identity.run, resultKind: terminal.resultKind, reason: terminal.reason });
    return createRuntimeV2RunnerSettlement(input.context, terminal.resultKind === "canceled" ? abortedAgentLoopOutcome(terminal.reason) : completedAgentLoopOutcome(terminal.reason, terminal.resultKind));
  }
  if (input.context.planPurpose === "rules" && !ledger.snapshot()!.events.some(event => event.type === "observation.recorded" && event.evidence.id === "rules-source-snapshot")) {
    const admitted = ledger.snapshot()!.objective;
    if (!input.context.runWorkspace || admitted.capabilityRestrictions?.includes("workspace_read") || admitted.approvalRequiredCapabilities?.includes("workspace_read")) throw new Error("RULES_WORKSPACE_READ_REQUIRED");
    const source = await inspectProjectInitTarget(input.context.runWorkspace);
    await ledger.append({ type: "observation.recorded", run: identity.run,
      evidence: { id: "rules-source-snapshot", kind: "source", target: "AGENTS.md", version: source.contentVersion || "absent" },
      modelContent: JSON.stringify({ rulesInspection: { canonicalWorkspace: source.canonicalWorkspace, workspaceIdentity: projectWorkspaceIdentity(source.canonicalWorkspace), targetPath: source.targetPath, exists: source.exists, content: source.content, baseVersion: source.contentVersion } }) });
  }
  const paused = await settlePlanPause(input, ledger, identity.run);
  if (paused) return paused;
  const initial = questions[0];
  const confirmed = ledger.snapshot()!.events.find(event => event.type === "run.decision_recorded" && initial?.type === "run.paused" && event.requestId === initial.blocker.requestId);
  if (confirmed?.type === "run.decision_recorded" && confirmed.answer?.answers.find(answer => answer.questionId === "result_kind")?.selectedValues.includes("executable")) return null;
  return await runPlanDocumentInterview({ input, ledger, turn: identity.turn, run: identity.run, objective: turn.userPrompt });
  } catch (error) {
    if (!ledger.snapshot()?.run) throw error;
    const canceled = input.context.abortCtrl.signal.aborted;
    const reason = canceled ? "用户停止了计划访谈。" : "计划访谈未能完成；已保留原始目标、问题与已确认答案。";
    input.logStoreEvent("runtime_v2_plan_interview_failed", { turnId: identity.turn.turnId, error: String(error) });
    await ledger.finishTerminal({ run: identity.run, resultKind: canceled ? "canceled" : "error", reason });
    return createRuntimeV2RunnerSettlement(input.context, canceled ? abortedAgentLoopOutcome(reason) : completedAgentLoopOutcome(reason, "error"));
  }
}
