import {
  deriveProviderAdapterCapabilities,
  deriveStreamSettings,
} from "../../lib/providerLaneSettings";
import {
  DEFAULT_PROVIDER_LANE_PROFILE_V1,
  approvedRuntimeV2PlanContinuation,
  deriveRuntimeV2PlanExecutionCoverage,
  deriveRuntimeV2PlanExecutionFrontier,
  deriveRuntimeV2PlanSourceFreshness,
  deriveRuntimeV2ValidationBoundary,
  runtimeV2DirectExecuteContractCoverage,
  type ProviderLaneProfileV1,
  type RuntimeV2Event,
  type TurnAggregateV1,
} from "../../lib/runtime-v2";
import { unresolvedUnityEditorCheck } from "../../lib/runtime-v2/unityCompilation";
import { isRuntimeV2ValidationAttempt } from "../../lib/runtime-v2/validationAttempt";
import { analyzeValidationCommand } from "../../lib/validationContract";
import { isProjectBaselineForWorkspace } from "../../lib/workspaceAdmission";
import {
  aggregateForCurrentTurn,
  approvedPlanForCurrentTurn,
} from "./executionAggregate";
import { RUNTIME_V2_CONTEXT_ANCHOR_PREFIX } from "./executionProviderAnchors";
import { deriveRuntimeV2ExecutionContract } from "./executionContract";
import { resolveApprovedRuntimeV2WorkPlanFromAggregate } from "./workPlanAdapter";
import type {
  RuntimeV2ExecutionPortsInput,
} from "./executionTypes";

export function containsProviderTextEnvelopePrompt(
  language: "zh" | "en",
  toolRequired: boolean,
): string {
  if (language === "en") {
    return toolRequired
      ? "Native tools are unavailable for this request. A structured tool call is required now. Output `<tool_call>{\"name\":\"tool_name\",\"arguments\":{}}</tool_call>` with valid JSON and no prose."
      : "Native tools are unavailable for this request. If a tool is needed, output `<tool_call>{\"name\":\"tool_name\",\"arguments\":{}}</tool_call>` with valid JSON and no prose.";
  }
  return toolRequired
    ? "本次请求不使用原生工具，当前阶段必须提交一个结构化工具调用。只输出完整的 `<tool_call>{\"name\":\"tool_name\",\"arguments\":{}}</tool_call>` JSON 调用块，不要混入说明文字。"
    : "本次请求不使用原生工具。若需要工具，只输出一个完整的 `<tool_call>{\"name\":\"tool_name\",\"arguments\":{}}</tool_call>` JSON 调用块，不要混入说明文字。";
}

export function baseProviderProfile(state: any): ProviderLaneProfileV1 {
  const settings = deriveStreamSettings(state.config);
  const adapterCapabilities = deriveProviderAdapterCapabilities(settings);
  const nativeTools =
    String(settings.toolProtocol || "auto").toLowerCase() !== "xml" &&
    adapterCapabilities.nativeToolRoundTrip;
  return {
    ...DEFAULT_PROVIDER_LANE_PROFILE_V1,
    nativeTools,
    requiredToolChoice: false,
    textToolEnvelope: true,
  };
}

export function recordApprovedPlanContext(
  input: RuntimeV2ExecutionPortsInput,
  aggregate = aggregateForCurrentTurn(input),
) {
  const prefix = `${RUNTIME_V2_CONTEXT_ANCHOR_PREFIX} approved-work-plan]`;
  const existing = input.live.messages.findIndex(message =>
    message.role === "system" && typeof message.content === "string" &&
    message.content.startsWith(prefix)
  );
  const approved = resolveApprovedRuntimeV2WorkPlanFromAggregate(aggregate);
  const approvalEvent = aggregate && approved && [...aggregate.events].reverse().find(
    (event): event is Extract<RuntimeV2Event, { type: "work_plan.approved" }> =>
      event.type === "work_plan.approved" &&
      event.run.sessionKey === approved.commit.review.sessionKey &&
      event.run.sessionEpoch === approved.commit.review.sessionEpoch &&
      event.run.turnId === approved.commit.review.turnId &&
      event.run.runId === approved.commit.review.runId &&
      event.run.parentRunId === approved.commit.review.parentRunId &&
      event.workPlan.id === approved.commit.authority.id &&
      event.workPlan.revision === approved.commit.authority.revision &&
      event.workPlan.digest === approved.commit.authority.digest &&
      event.workPlan.projectionHash === approved.commit.authority.projectionHash,
  );
  if (!aggregate || !approved || !approvalEvent) {
    if (existing >= 0) input.live.messages.splice(existing, 1);
    return null;
  }
  const continuation = approvedRuntimeV2PlanContinuation(aggregate.events)?.continuation;
  const content = [
    prefix,
    continuation
      ? "MAIN verified the exact previously approved WorkPlan for the current continuation. Execute only its remaining bounded steps and validations under the current request's restrictions. Carry forward the confirmed choices and committed progress. Earlier interview answers supplied information, not execution approval. Changed plans, out-of-scope actions and separately gated high-risk operations still require their own approval. Existing source leases and tool permission checks remain in force."
      : "The user has already separately approved this exact WorkPlan through MAIN's plan-review request. This independent plan-review approval is effective now: execute only its bounded steps and validations. Earlier interview answers supplied information, not execution approval. Changed plans, out-of-scope actions and separately gated high-risk operations still require their own approval. Existing source leases and tool permission checks remain in force.",
    JSON.stringify({
      status: "approved_for_execution",
      approvalReceipt: {
        eventType: approvalEvent.type,
        eventId: approvalEvent.eventId,
        sequence: approvalEvent.sequence,
        at: approvalEvent.at,
        requestId: approved.commit.review.requestId,
        owner: {
          sessionKey: approvalEvent.run.sessionKey,
          sessionEpoch: approvalEvent.run.sessionEpoch,
          turnId: approvalEvent.run.turnId,
          runId: approvalEvent.run.runId,
          parentRunId: approvalEvent.run.parentRunId,
        },
        authority: approved.commit.authority,
        documentRef: approved.commit.artifact.documentRef ?? null,
      },
      objective: approved.plan.draft.objective,
      ...(continuation && approved.plan.decisionJournal ? { confirmedChoices: approved.plan.decisionJournal } : {}),
      summary: approved.plan.draft.summary,
      findings: approved.plan.draft.findings,
      steps: approved.plan.draft.steps,
      validations: approved.plan.draft.validations,
      risks: approved.plan.draft.risks,
      assumptions: approved.plan.draft.assumptions,
    }),
  ].join("\n\n");
  // Keep the immutable approval in the cacheable prefix. Only the decision
  // instruction at the end carries the changing execution frontier.
  if (existing < 0) {
    input.live.messages.unshift({ role: "system", content });
  } else if (input.live.messages[existing]?.content !== content) {
    input.live.messages[existing] = { role: "system", content };
  }
  const freshness = deriveRuntimeV2PlanSourceFreshness(aggregate);
  const frontier = deriveRuntimeV2PlanExecutionFrontier(aggregate);
  const compileFailed = unresolvedUnityEditorCheck(aggregate)?.result.status === "failed";
  return {
    approvalKey: approvalEvent.eventId,
    frontierInstruction: [
      "Approved WorkPlan progress:",
      JSON.stringify({
        sourceFreshness: freshness ? {
          allFresh: freshness.allFresh,
          missingTargets: freshness.missingTargets,
          staleTargets: freshness.staleTargets,
          unversionedTargets: freshness.unversionedTargets,
        } : null,
        executionFrontier: frontier ? {
          completedStepIndexes: frontier.completedStepIndexes,
          readyStepIndexes: frontier.readyStepIndexes,
          blockedStepIndexes: frontier.blockedStepIndexes,
          readyMutationTargets: frontier.readyMutationTargets,
          validationReady: frontier.validationReady && !compileFailed,
        } : null,
      }),
      compileFailed ? "Resolve the current compiler diagnostics before PlayMode."
        : frontier?.validationReady
        ? "All mutation stages are complete. Run the planned validations."
        : "Follow the approved WorkPlan steps and verify once changes are complete.",
    ].join(" "),
  };
}

/** Resolve only a finite validator that already belongs to the Turn's sealed
 * authority. Workspace manifests cannot silently promote a convenient build
 * command into acceptance evidence. A direct Execute contract is as binding
 * here as an approved WorkPlan: after mutation MAIN can force the model onto
 * the validator it explicitly promised instead of reopening tool selection. */
export function preferredFiniteValidationCommand(
  input: RuntimeV2ExecutionPortsInput,
): string {
  const aggregate = aggregateForCurrentTurn(input);
  const approved = approvedPlanForCurrentTurn(input);
  const coverage = aggregate
    ? deriveRuntimeV2PlanExecutionCoverage(aggregate)
    : null;
  const approvedValidation = approved && coverage
    ? coverage.missingRequiredValidationIndexes
      .map((index) => approved.plan.draft.validations[index])
      .find((validation) =>
        validation?.kind === "finite_command" &&
        String(validation.command || "").trim()
      )
    : approved?.plan.draft.validations.find((validation) =>
      validation.required &&
      validation.kind === "finite_command" &&
      String(validation.command || "").trim()
    );
  const approvedCommand = String(approvedValidation?.command || "").trim();
  if (approvedCommand) return approvedCommand;
  // Once every required WorkPlan validator has a current passing receipt,
  // do not reopen the first command merely because it remains in the sealed
  // catalog. Completion owns the next transition.
  if (approved && coverage) return "";
  const contract = deriveRuntimeV2ExecutionContract(
    aggregate,
  );
  const missing = aggregate ? runtimeV2DirectExecuteContractCoverage(aggregate).missingValidationIndexes : [];
  const contractedValidation = contract?.validations.find((validation, index) =>
    missing.includes(index) && validation.kind === "finite_command" &&
    String(validation.command || "").trim()
  );
  return String(contractedValidation?.command || "").trim();
}

/** Project scripts are suggestions for the next decision. Acceptance still
 * requires a matching validation receipt under the current authority. */
export function projectFiniteValidationCommands(input: Pick<RuntimeV2ExecutionPortsInput, "context">) {
  const baseline = input.context.projectBaselineContext;
  if (!isProjectBaselineForWorkspace(baseline, input.context.runWorkspace || "")) return [];
  return baseline.facts.scripts.flatMap(script => {
    if (!script.invocation || script.provenance.path !== "package.json") return [];
    const spec = analyzeValidationCommand(script.invocation).spec;
    return spec?.kind === "finite_command" ? [{ command: spec.command, capability: spec.capability,
      manifestVersion: script.provenance.contentHash }] : [];
  });
}

export function projectValidationRecoveryReceipt(aggregate: TurnAggregateV1 | null): string {
  if (!aggregate?.run) return "";
  const runId = aggregate.run.identity.runId;
  const commandKeys = new Set(aggregate.events.flatMap(event => event.type === "command.scheduled" &&
    event.run.runId === runId && event.command.payload.projectValidationManifestVersion ? [event.command.idempotencyKey] : []));
  const result = [...aggregate.events].reverse().find(event => event.type === "validation.completed" &&
    event.run.runId === runId && commandKeys.has(event.idempotencyKey));
  if (result?.type !== "validation.completed" || result.mutationBoundarySequence !== deriveRuntimeV2ValidationBoundary(aggregate, []).mutationBoundarySequence) return "";
  const status = result.passed ? "passed" : isRuntimeV2ValidationAttempt(result) ? "failed" : "not executed";
  return `[Project validation receipt] ${result.presentation?.target || "run_command"}: ${status}${result.failureReasonCode ? ` (${result.failureReasonCode})` : ""}.`;
}

export function normalizeRuntimeV2WorkspacePath(
  value: string,
  workspace: string,
): string {
  let normalized = value.trim()
    .replace(/^file:\s+/i, "")
    .replace(/^file:\/\//i, "")
    .replace(/^file:(?=\/)/i, "")
    .replace(/\\/g, "/")
    .replace(/^(["'`])([\s\S]*)\1$/, "$2")
    .replace(/^\.\//, "");
  try {
    normalized = decodeURIComponent(normalized);
  } catch {
    // Keep a literal percent sign usable when the diagnostic is not a URI.
  }
  const root = workspace.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  return root && normalized.startsWith(`${root}/`)
    ? normalized.slice(root.length + 1)
    : normalized;
}
