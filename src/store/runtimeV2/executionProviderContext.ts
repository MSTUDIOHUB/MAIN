import {
  deriveProviderAdapterCapabilities,
  deriveStreamSettings,
} from "../../lib/providerLaneSettings";
import {
  DEFAULT_PROVIDER_LANE_PROFILE_V1,
  deriveRuntimeV2PlanExecutionCoverage,
  deriveRuntimeV2PlanExecutionFrontier,
  deriveRuntimeV2PlanSourceFreshness,
  runtimeV2DirectExecuteContractCoverage,
  type ProviderLaneProfileV1,
  type RuntimeV2Event,
} from "../../lib/runtime-v2";
import {
  aggregateForCurrentTurn,
  approvedPlanForCurrentTurn,
} from "./executionAggregate";
import { upsertRuntimeV2ContextAnchor } from "./executionProviderAnchors";
import { deriveRuntimeV2ExecutionContract } from "./executionContract";
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
): void {
  // This keyed model projection is rebuilt from current canonical authority.
  // An invalidated or replaced Plan must not retain a previous approval claim.
  for (let index = input.live.messages.length - 1; index >= 0; index -= 1) {
    const message = input.live.messages[index];
    if (message.role === "system" && typeof message.content === "string" &&
      message.content.startsWith("[runtime-v2 context: approved-work-plan]")) {
      input.live.messages.splice(index, 1);
    }
  }
  const aggregate = aggregateForCurrentTurn(input);
  const approved = approvedPlanForCurrentTurn(input);
  if (!aggregate || !approved) return;
  const approvalEvent = [...aggregate.events].reverse().find(
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
  if (!approvalEvent) return;
  const freshness = deriveRuntimeV2PlanSourceFreshness(aggregate);
  const frontier = deriveRuntimeV2PlanExecutionFrontier(aggregate);
  const content = [
    "The user has already separately approved this exact WorkPlan through MAIN's plan-review request. This independent plan-review approval is effective now: execute only its bounded steps and validations. Earlier interview answers supplied information, not execution approval. Changed plans, out-of-scope actions and separately gated high-risk operations still require their own approval. Existing source leases and tool permission checks remain in force.",
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
      authority: approved.commit.authority,
      objective: approved.plan.draft.objective,
      summary: approved.plan.draft.summary,
      findings: approved.plan.draft.findings,
      steps: approved.plan.draft.steps,
      validations: approved.plan.draft.validations,
      risks: approved.plan.draft.risks,
      assumptions: approved.plan.draft.assumptions,
      sourceFreshness: freshness
        ? {
            allFresh: freshness.allFresh,
            missingTargets: freshness.missingTargets,
            staleTargets: freshness.staleTargets,
            unversionedTargets: freshness.unversionedTargets,
          }
        : null,
      executionFrontier: frontier
        ? {
            completedStepIndexes: frontier.completedStepIndexes,
            readyStepIndexes: frontier.readyStepIndexes,
            blockedStepIndexes: frontier.blockedStepIndexes,
            readyMutationTargets: frontier.readyMutationTargets,
            validationReady: frontier.validationReady,
          }
        : null,
    }, null, 2),
    frontier && !frontier.validationReady
      ? "Follow the approved WorkPlan steps and verify once changes are complete."
      : frontier?.validationReady
        ? "All mutation stages are complete. Run the planned validations."
        : "",
  ].join("\n\n");
  upsertRuntimeV2ContextAnchor(input.live, {
    key: "approved-work-plan",
    content,
  });
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
