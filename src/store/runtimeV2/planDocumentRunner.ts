import { appendPlanDecisionJournal, buildPlanDecisionJournal } from "../../lib/planDecisionJournal";
import { completedAgentLoopOutcome } from "../../lib/runOutcome";
import type { ProjectInitInspection, RulesDraftReview } from "../../lib/projectInit";
import { withProjectInitManagedBlock } from "../../lib/projectInit";
import { planDocumentDisplayTitle, type PlanDocumentRef } from "../../lib/planDocuments";
import { resolvePlanDocumentFromAggregate } from "../../lib/planDocumentRecords";
import type { RuntimeV2RunIdentity, RuntimeV2TurnIdentity, WorkPlanRuntimeEvidence } from "../../lib/runtime-v2";
import { isRuntimeV2ProviderTransportsUnavailableError } from "../../lib/runtime-v2";
import { deriveReadOnlyRecoveryWindow } from "../../lib/runtime-v2/readOnlyProgress";
import { runtimeV2ProviderRecoveryStallExpired } from "../../lib/runtime-v2/lifecycle";
import { runtimeV2ParallelReadCount } from "./executionText";
import { createRuntimeV2RunnerSettlement } from "./executionRunnerIdentity";
import { ASK_PLAN_QUESTIONS, SUBMIT_PLAN_DOCUMENT, planDocumentMessages, planDocumentTools } from "./planDocumentProtocol";
import { createRuntimeV2PlanCollaboration } from "./planCollaboration";
import { requestPlanModel } from "./planProviderPort";
import { executeReadOnlyPlanTool, settlePlanTool } from "./planEvidencePort";
import { priorPlanConversationMessages } from "./planConversationHistory";
import { DOCUMENT_SAVE_BLOCKER, planDocumentSaveInput, resolvePlanDocumentSaveRecovery, schedulePlanDocumentSave, writePlanDocumentOrPause, pausePlanDocumentSave } from "./planDocumentSavePort";
import { recoverPlanDocumentInvocations } from "./planDocumentRecovery";
import { resolveRuntimeV2PlanSubmissionLifecycle } from "./planSubmissionRepair";
import { restorePlanHistory } from "./planHistory";
import { handlePlanQuestionTool } from "./planQuestionControl";
import type { RuntimeV2PlanRunnerInput } from "./planRunnerTypes";
import type { PlanLedger } from "./planLedger";

function rulesInspection(ledger: PlanLedger): ProjectInitInspection | null {
  const event = ledger.snapshot()?.events.find(event => event.type === "observation.recorded" && event.evidence.id === "rules-source-snapshot");
  if (event?.type !== "observation.recorded" || !event.modelContent) return null;
  try { return JSON.parse(event.modelContent).rulesInspection || null; } catch { return null; }
}

export async function runPlanDocumentInterview({ input, ledger, turn, run, objective }: {
  input: RuntimeV2PlanRunnerInput; ledger: PlanLedger; turn: RuntimeV2TurnIdentity; run: RuntimeV2RunIdentity; objective: string;
}) {
  const messages = planDocumentMessages(input.context, objective);
  messages.splice(1, 0, ...priorPlanConversationMessages(input.get(), turn.turnId));
  const evidence: WorkPlanRuntimeEvidence[] = [];
  const evidenceContents = new Map<string, string>();
  restorePlanHistory({ aggregate: ledger.snapshot()!, run, messages, evidence, evidenceContents, omitUnsettledCalls: true });
  const inspection = rulesInspection(ledger);
  if (inspection?.content && !String(input.context.workspaceInstructionContext || "").includes(inspection.content.trim())) {
    messages.push({ role: "system", content: `[REVIEWED AGENTS.md BASE]\n${inspection.content}` });
  }
  const deadlineAt = resolveRuntimeV2PlanSubmissionLifecycle({ aggregate: ledger.snapshot()!, run, fallbackStartedAt: Date.now() }).originalDeadlineAt;
  const collaboration = createRuntimeV2PlanCollaboration({ runner: input, ledger, run, messages, evidence, evidenceContents,
    deadlineAt, logStoreEvent: input.logStoreEvent });
  const complete = async (documentRef: PlanDocumentRef, markdown: string) => {
    const rules = input.context.planPurpose === "rules";
    input.set((state: any) => {
      if (state.currentTurnId !== turn.turnId || state.harnessRunMarker?.runId !== run.runId || state.harnessRunMarker?.sessionKey !== turn.sessionKey) return {};
      return { ...(rules && inspection ? { rulesDraftReview: { documentRef, markdown, inspection } satisfies RulesDraftReview } : {}),
        conversationTurns: state.conversationTurns.map((item: any) => item.id === turn.turnId ? { ...item, planDocument: documentRef } : item) };
    });
    const reason = rules ? "项目规则草稿已保存，请审阅后再写入 AGENTS.md。" : "计划文档已保存。";
    await ledger.finishTerminal({ run, resultKind: "success", reason, finalMarkdown: `${markdown}\n\n${reason}` });
    return createRuntimeV2RunnerSettlement(input.context, completedAgentLoopOutcome(reason));
  };
  // A saved receipt closes the lost-projection/crash window without another write.
  const saved = resolvePlanDocumentFromAggregate(ledger.snapshot());
  if (saved) return complete(saved.documentRef, saved.markdown);
  const saveRecovery = resolvePlanDocumentSaveRecovery(ledger.snapshot()!);
  if (saveRecovery) {
    const blocker = ledger.snapshot()!.run?.blocker;
    const retryChosen = blocker?.reasonCode === DOCUMENT_SAVE_BLOCKER && blocker.actionIdentity === saveRecovery.command.idempotencyKey && blocker.decision === "recheck";
    if (!saveRecovery.pending && !retryChosen) return pausePlanDocumentSave(input, ledger, run, saveRecovery.command, saveRecovery.error || "Document storage did not acknowledge the save.");
    if (input.context.abortCtrl.signal.aborted) throw new Error("PLAN_DOCUMENT_CANCELED");
    if (Date.now() >= deadlineAt) throw new Error("PLAN_DOCUMENT_CALLER_DEADLINE");
    const command = saveRecovery.pending ? saveRecovery.command : await schedulePlanDocumentSave({ ledger, run, saveInput: saveRecovery.saveInput, retryOf: saveRecovery.command.idempotencyKey });
    const result = await writePlanDocumentOrPause({ runner: input, ledger, run, command, saveInput: saveRecovery.saveInput });
    return "settlement" in result ? result.settlement : complete(result.documentRef, result.markdown);
  }
  await collaboration.restoreProactive();
  let recoveryCalls = await recoverPlanDocumentInvocations(ledger, run);
  while (true) {
    if (input.context.abortCtrl.signal.aborted) throw new Error("PLAN_DOCUMENT_CANCELED");
    if (Date.now() >= deadlineAt) throw new Error("PLAN_DOCUMENT_CALLER_DEADLINE");
    if (!recoveryCalls && await collaboration.advanceProactive()) continue;
    const recovery = deriveReadOnlyRecoveryWindow(ledger.snapshot()!, { finalTextIsProgress: false });
    if (recovery && runtimeV2ProviderRecoveryStallExpired({ startedAt: recovery.startedAt, reason: recovery.pressure.reason, latestOccurrence: recovery.pressure.occurrence }, Date.now())) {
      // Stalled exploration changes guidance, never the truth of the Turn.
      const content = "Retained evidence has not yielded a saved plan. Name one missing fact, ask one consequential user question, or submit the current reviewable document. Do not repeat an unchanged action.";
      const index = messages.findIndex(message => message.role === "system" && message.content === content);
      if (index < 0) messages.push({ role: "system", content });
    }
    const recovered = recoveryCalls;
    recoveryCalls = null;
    let response: { visibleText?: string; toolCalls: import("../../lib/runtime-v2").RuntimeV2NormalizedProviderResult["toolCalls"] };
    try {
      response = recovered ? { visibleText: "", toolCalls: recovered.calls } : await requestPlanModel({ get: input.get, context: input.context, ledger, run, messages, deadlineAt,
        stage: "discovery", evidence, evidenceContents, collaboration: collaboration.current().payload,
        submissionRepairPending: false, customTools: planDocumentTools({ ...input.context, networkRead: ledger.snapshot()?.networkRead, knowledgeContext: ledger.snapshot()?.knowledgeContext }), logStoreEvent: input.logStoreEvent });
    } catch (error) {
      if (isRuntimeV2ProviderTransportsUnavailableError(error) || input.context.abortCtrl.signal.aborted) throw error;
      await ledger.recordSoftSignal(run, "protocol_drift");
      messages.push({ role: "system", content: "The last provider request failed. Continue the same plan from retained receipts; no save or approval occurred." });
      continue;
    }
    input.context.abortCtrl.signal.throwIfAborted();
    if (!response.toolCalls.length) {
      await ledger.recordSoftSignal(run, response.visibleText?.trim() ? "no_tool_call" : "empty_response");
      messages.push({ role: "system", content: "No document has been saved. Ask a specific user-owned question, read one missing fact, or submit the completed document through submit_plan_document." });
      continue;
    }
    for (const call of response.toolCalls) {
      const feedback = async (content: string) => {
        await settlePlanTool({ ledger, run, call, status: "failed", evidence: [], modelContent: content, failureKind: "protocol_invalid" });
        messages.push({ role: "tool", tool_call_id: call.id, content });
      };
      if ([ASK_PLAN_QUESTIONS, SUBMIT_PLAN_DOCUMENT].includes(call.name) && response.toolCalls.length !== 1) {
        await feedback("A user question or document submission must be a single control call, after other tool results have settled."); continue;
      }
      if (call.name === ASK_PLAN_QUESTIONS) {
        const pause = await handlePlanQuestionTool({ runner: input, ledger, run, call, messages, includeResultChoice: true,
          receiptAlreadySettled: recovered?.settledQuestion,
          joinChildren: async () => !collaboration.activeChildCount() || collaboration.joinActive("plan_question_requires_joined_children", true),
        });
        if (pause) return pause;
        continue;
      }
      if (call.name === SUBMIT_PLAN_DOCUMENT) {
        if (!ledger.snapshot()!.events.some(event => event.type === "run.decision_recorded" && event.answer && event.choice !== "stop")) { await feedback("No user confirmation has been received. Investigate and ask the consequential user-owned questions before saving a plan."); continue; }
        if (input.context.planPurpose === "rules" && !inspection) { await feedback("The captured AGENTS.md base is missing. No rules draft can be saved without its original review base."); continue; }
        const rawTitle = typeof call.arguments.title === "string" ? call.arguments.title.trim() : "";
        const title = rawTitle ? planDocumentDisplayTitle(rawTitle) : "";
        const body = typeof call.arguments.markdown === "string" ? call.arguments.markdown : "";
        if (!title || !body.trim()) { await feedback("A document needs a title and its complete Markdown body."); continue; }
        let markdown: string;
        if (input.context.planPurpose === "rules") {
          const baseline = input.context.projectBaselineContext;
          try {
            markdown = baseline?.workspace.identity === inspection?.workspaceIdentity && baseline
              ? withProjectInitManagedBlock(body, baseline, input.context.phaseLanguage)
              : body;
          } catch {
            await feedback("Submit the rules with human text intact and remove malformed MAIN-managed section markers. MAIN will generate the summary.");
            continue;
          }
        } else {
          markdown = appendPlanDecisionJournal(body, buildPlanDecisionJournal(ledger.snapshot()));
        }
        if (collaboration.activeChildCount()) await collaboration.joinActive("plan_document_submission", true);
        const policy = collaboration.current().payload;
        if (policy.collaborationRequired === true && policy.collaborationRequirementMet !== true) { await feedback("The required planning child has not delivered a joined report. Continue that existing work before saving."); continue; }
        const saveInput = planDocumentSaveInput(ledger.snapshot()!, title, markdown);
        const command = await schedulePlanDocumentSave({ ledger, run, saveInput, call });
        const result = await writePlanDocumentOrPause({ runner: input, ledger, run, command, saveInput });
        return "settlement" in result ? result.settlement : complete(result.documentRef, result.markdown);
      }
      if (call.name === "spawn_subagent" || call.name === "wait_subagents") {
        await collaboration.executeProviderCall(call, collaboration.current().decision);
        continue;
      }
      await executeReadOnlyPlanTool({ context: input.context, ledger, run, call, messages, evidence, evidenceContents,
        logStoreEvent: input.logStoreEvent, parallelReadCount: runtimeV2ParallelReadCount(response.toolCalls) });
    }
  }
}
