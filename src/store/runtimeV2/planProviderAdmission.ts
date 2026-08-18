import type { AgentMessage } from "../../lib/agentMessages";
import type { RuntimeV2RunIdentity } from "../../lib/runtime-v2";
import type { PlanLedger } from "./planLedger";
import type { RuntimeV2PlanLog } from "./planEvidencePort";
import type { PlanModelStage } from "./planModelProtocol";
import type { RuntimeV2PlanProviderResult } from "./planProviderPort";

/** Retain only the latest complete causal rejection group when synthesis
 * builds a compact decision view. Canonical history remains in the shared
 * transcript; this selects, but never rewrites, that history. */
export function latestRuntimeV2PlanProviderAdmissionRejectionHistory(
  messages: readonly AgentMessage[],
): AgentMessage[] {
  let toolStart = messages.length;
  while (toolStart > 0 && messages[toolStart - 1]?.role === "tool") {
    toolStart -= 1;
  }
  const tools = messages.slice(toolStart);
  const assistant = messages[toolStart - 1];
  const isAdmissionRejection = tools.some((message) =>
    /PLAN_TOOL_(?:NOT_ADVERTISED|ARGUMENTS_REJECTED):/.test(
      String(message.content || ""),
    )
  );
  return assistant?.role === "assistant" &&
      assistant.tool_calls?.length === tools.length &&
      isAdmissionRejection
    ? [assistant, ...tools]
    : [];
}

/** Project a provider-side Plan admission quarantine into soft recovery.
 * The provider port has already persisted a sanitized result and appended the
 * causal assistant/tool rejection pair; this helper must never dispatch the
 * quarantined calls or advance the Plan stage. */
export async function handleRuntimeV2PlanProviderAdmissionRejection(input: {
  readonly ledger: PlanLedger;
  readonly run: RuntimeV2RunIdentity;
  readonly response: RuntimeV2PlanProviderResult;
  readonly collaboration: Readonly<Record<string, unknown>>;
  readonly round: number;
  readonly stage: PlanModelStage;
  readonly logStoreEvent: RuntimeV2PlanLog;
}): Promise<boolean> {
  const surfaceRejection = input.response.diagnostics.find((diagnostic) =>
    diagnostic.code === "tool_surface_rejected"
  );
  const argumentRejection = input.response.diagnostics.find((diagnostic) =>
    diagnostic.code === "tool_arguments_rejected"
  );
  const rejection = surfaceRejection || argumentRejection;
  if (!rejection) return false;

  await input.ledger.recordSoftSignal(input.run, "protocol_drift");
  const detail = [
    input.collaboration.collaborationRequired === true &&
        input.collaboration.collaborationRequirementMet !== true
      ? "required planning collaboration is still pending"
      : surfaceRejection
        ? "the provider requested a tool outside the current Plan surface"
        : "the provider supplied arguments outside the exact advertised Plan schema",
    rejection.message,
  ].join("; ");
  input.logStoreEvent("runtime_v2_plan_submission_rejected", {
    turnId: input.run.turnId,
    runId: input.run.runId,
    round: input.round,
    stage: input.stage,
    detail,
    allowedToolNames: input.response.advertisedToolNames,
    effect: "none",
  });
  return true;
}
