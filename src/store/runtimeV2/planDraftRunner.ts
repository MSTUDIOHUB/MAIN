import { completedAgentLoopOutcome } from "../../lib/runOutcome";
import { appendPlanDecisionJournal } from "../../lib/planDecisionJournal";
import { resolvePlanDocumentFromAggregate, resolvePlanDraftFromAggregate } from "../../lib/planDocumentRecords";
import { planDocumentDisplayTitle } from "../../lib/planDocuments";
import { formatPlanSubmissionDiagnostics, hashPlanDraftCandidate, type PlanDraftRecord, type PlanDraftSaveMetadata, type PlanSubmissionDiagnostic } from "../../lib/planDrafts";
import type { RuntimeRunSettlement } from "../../lib/runtimeRunSettlement";
import type { RuntimeV2NormalizedToolCall, RuntimeV2RunIdentity } from "../../lib/runtime-v2";
import type { PlanLedger } from "./planLedger";
import type { RuntimeV2PlanRunnerInput } from "./planRunnerTypes";
import { planSettlement, terminalPlanOutcome } from "./planSettlement";
import { DOCUMENT_SAVE_BLOCKER, pausePlanDocumentSave, planDocumentSaveInput, resolvePlanDocumentSaveRecovery, schedulePlanDocumentSave, writePlanDocumentOrPause } from "./planDocumentSavePort";

export function projectSavedPlanDraft(runner: RuntimeV2PlanRunnerInput, run: RuntimeV2RunIdentity, record: PlanDraftRecord): void {
  runner.set((state: any) => {
    if ((state.currentTurnId && state.currentTurnId !== run.turnId) || state.harnessRunMarker?.runId !== run.runId ||
      state.harnessRunMarker?.sessionKey !== run.sessionKey || state.planLifecycle?.sessionEpoch !== run.sessionEpoch) return {};
    return { isPlanApproved: false, planStage: "idle",
      ...(state.activeActionRequest?.turnId === run.turnId ? { activeActionRequest: null } : {}),
      conversationTurns: state.conversationTurns.map((turn: any) => turn.id === run.turnId
        ? { ...turn, planDocument: record.documentRef, planDraft: record } : turn) };
  });
}

async function completeSavedPlanDraft(runner: RuntimeV2PlanRunnerInput, ledger: PlanLedger, run: RuntimeV2RunIdentity): Promise<RuntimeRunSettlement> {
  const record = resolvePlanDraftFromAggregate(ledger.snapshot());
  const document = resolvePlanDocumentFromAggregate(ledger.snapshot());
  if (!record || !document) throw new Error("PLAN_DRAFT_SAVED_RECEIPT_INVALID");
  projectSavedPlanDraft(runner, run, record);
  const terminal = ledger.snapshot()!.terminalOutcome;
  if (terminal) {
    await ledger.finishTerminal({ run, resultKind: terminal.resultKind, reason: terminal.reason });
    return planSettlement(runner.context, terminalPlanOutcome(terminal.resultKind, terminal.reason));
  }
  const reason = runner.context.phaseLanguage === "zh"
    ? "计划草稿已保存。点击「补全验证」，可补充验收要求，或由 MAIN 先调查验证方式，遇到需要你决定的事项再提问。"
    : "Plan draft saved. Select Complete validation to add acceptance requirements or let MAIN investigate and ask about decisions you need to make.";
  await ledger.finishTerminal({ run, resultKind: "partial", reason, finalMarkdown: `${document.markdown}\n\n${reason}` });
  runner.logStoreEvent("runtime_v2_plan_draft_saved", { turnId: run.turnId, runId: run.runId, documentId: record.documentRef.documentId,
    candidateHash: record.source.candidateHash, diagnosticCodes: record.diagnostics.map(item => item.code), resultKind: "partial" });
  return planSettlement(runner.context, completedAgentLoopOutcome(reason, "partial"));
}

/** Replays the immutable save before any cold-recovery settlement or provider
 * call. A saved draft remains partial, including after a lost final projection. */
export async function recoverRuntimeV2PlanDraft(runner: RuntimeV2PlanRunnerInput, ledger: PlanLedger, run: RuntimeV2RunIdentity): Promise<RuntimeRunSettlement | null> {
  if (!ledger.snapshot()) return null;
  if (resolvePlanDraftFromAggregate(ledger.snapshot())) return completeSavedPlanDraft(runner, ledger, run);
  const recovery = resolvePlanDocumentSaveRecovery(ledger.snapshot()!);
  if (!recovery?.command.payload.planDraftMetadata) return null;
  const blocker = ledger.snapshot()!.run?.blocker;
  const retryChosen = blocker?.reasonCode === DOCUMENT_SAVE_BLOCKER && blocker.actionIdentity === recovery.command.idempotencyKey && blocker.decision === "recheck";
  if (!recovery.pending && !retryChosen) return pausePlanDocumentSave(runner, ledger, run, recovery.command, recovery.error || "Document storage did not acknowledge the save.");
  if (runner.context.abortCtrl.signal.aborted) throw new Error("PLAN_DRAFT_SAVE_CANCELED");
  const deadline = ledger.snapshot()!.events.find(event => event.type === "run.started" && event.run.runId === run.runId);
  if (deadline?.type === "run.started" && Number.isFinite(deadline.lifecycleDeadlineAt) && Date.now() >= deadline.lifecycleDeadlineAt!) throw new Error("PLAN_DRAFT_CALLER_DEADLINE");
  if (ledger.snapshot()!.run?.status === "paused" && blocker && retryChosen) await ledger.append({ type: "run.resumed", run, requestId: blocker.requestId });
  const command = recovery.pending ? recovery.command : await schedulePlanDocumentSave({ ledger, run, saveInput: recovery.saveInput,
    retryOf: recovery.command.idempotencyKey, draftMetadata: recovery.command.payload.planDraftMetadata as PlanDraftSaveMetadata });
  const result = await writePlanDocumentOrPause({ runner, ledger, run, command, saveInput: recovery.saveInput });
  return "settlement" in result && result.settlement ? result.settlement : completeSavedPlanDraft(runner, ledger, run);
}

export async function saveRuntimeV2PlanDraft(input: { runner: RuntimeV2PlanRunnerInput; ledger: PlanLedger; run: RuntimeV2RunIdentity;
  call: RuntimeV2NormalizedToolCall; candidate: Record<string, unknown>; diagnostics: readonly PlanSubmissionDiagnostic[]; decisionJournal?: string }): Promise<RuntimeRunSettlement> {
  const aggregate = input.ledger.snapshot()!;
  const source = [...aggregate.events].reverse().find(event => event.type === "provider.responded" && event.run.runId === input.run.runId &&
    event.result.toolCalls.some(call => call.id === input.call.id && call.name === input.call.name));
  if (source?.type !== "provider.responded") throw new Error("PLAN_DRAFT_SOURCE_INVOCATION_MISSING");
  const admission = aggregate.events.find(event => event.type === "turn.admitted");
  const derivedFrom = admission?.type === "turn.admitted" ? admission.sourcePlanDraft?.documentRef : undefined;
  const metadata: PlanDraftSaveMetadata = { schemaVersion: 1, source: { turnId: input.run.turnId, runId: input.run.runId,
    providerSequence: source.sequence, toolCallId: input.call.id, candidateHash: hashPlanDraftCandidate(input.call.arguments) }, diagnostics: input.diagnostics,
    ...(derivedFrom ? { derivedFrom } : {}) };
  const zh = input.runner.context.phaseLanguage === "zh";
  const heading = zh ? "## 待补全的执行验证" : "## Execution validation to complete";
  const disclaimer = zh ? "此文档为可审核草稿，尚未形成可批准执行的计划。" : "This reviewable draft is not ready for execution approval.";
  const diagnostics = formatPlanSubmissionDiagnostics(input.diagnostics, zh ? "zh" : "en").map(message => `- ${message}`).join("\n");
  const markdown = `${appendPlanDecisionJournal(String(input.candidate.planMarkdown), input.decisionJournal)}\n\n${heading}\n\n${disclaimer}\n\n${diagnostics}\n`;
  const saveInput = planDocumentSaveInput(aggregate, planDocumentDisplayTitle(aggregate.objective.text), markdown);
  const command = await schedulePlanDocumentSave({ ledger: input.ledger, run: input.run, saveInput, draftMetadata: metadata });
  const result = await writePlanDocumentOrPause({ runner: input.runner, ledger: input.ledger, run: input.run, command, saveInput });
  return "settlement" in result && result.settlement ? result.settlement : completeSavedPlanDraft(input.runner, input.ledger, input.run);
}
