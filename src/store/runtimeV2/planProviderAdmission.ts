import type { AgentMessage } from "../../lib/agentMessages";
import type { RuntimeV2NormalizedProviderResult, RuntimeV2RunIdentity } from "../../lib/runtime-v2";
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

/** Build the sanitized assistant/tool rejection messages appended when the
 * provider emits an unadvertised tool or schema-invalid arguments. */
export function buildPlanToolAdmissionRejectionMessages(input: {
  readonly toolCalls: RuntimeV2NormalizedProviderResult["toolCalls"];
  readonly unexpectedToolNames: readonly string[];
  readonly argumentViolation: { readonly call: { readonly id: string; readonly name: string }; readonly reason: string } | null;
  readonly advertisedToolNames: readonly string[];
  readonly activeSubagentCount: number;
}): AgentMessage[] {
  const out: AgentMessage[] = [{
    role: "assistant",
    content: "",
    tool_calls: input.toolCalls.map((call) => ({
      id: call.id,
      type: "function" as const,
      function: {
        name: call.name,
        arguments: JSON.stringify({ runtime_v2_rejected_tool_surface: true, effect: "none" }),
      },
    })),
  }];
  for (const call of input.toolCalls) {
    const argumentRejection = !!input.argumentViolation;
    const waitedWhenIdle = !argumentRejection &&
      input.unexpectedToolNames.includes("wait_subagents") &&
      input.activeSubagentCount === 0;
    const rejection = argumentRejection
      ? {
          schemaVersion: "runtime-v2.plan-tool-rejection.v1",
          code: call.id === input.argumentViolation!.call.id
            ? "PLAN_TOOL_ARGUMENTS_REJECTED"
            : "PLAN_TOOL_BATCH_REJECTED",
          effect: "none",
          requestedTool: call.name,
          rejectedTool: input.argumentViolation!.call.name,
          reason: input.argumentViolation!.reason,
          allowedToolNames: input.advertisedToolNames,
          responseDisposition: "rejected_before_dispatch",
          instruction: "Submit exactly one currently advertised structured tool action with schema-valid arguments next.",
        }
      : {
          schemaVersion: "runtime-v2.plan-tool-rejection.v1",
          code: input.unexpectedToolNames.includes(call.name)
            ? "PLAN_TOOL_SURFACE_REJECTED"
            : "PLAN_TOOL_BATCH_REJECTED",
          effect: "none",
          requestedTool: call.name,
          unexpectedToolNames: input.unexpectedToolNames,
          allowedToolNames: input.advertisedToolNames,
          responseDisposition: "rejected_before_dispatch",
          instruction: waitedWhenIdle
            ? "All spawned planning subagents have ALREADY completed and their reports are already in your context above (activeSubagentCount = 0). Do NOT call wait_subagents again. Call an advertised tool such as ask_plan_questions, a targeted read, or submit_plan_document / submit_runtime_v2_work_plan next."
            : "Submit exactly one currently advertised structured tool action next.",
        };
    out.push({
      role: "tool",
      tool_call_id: call.id,
      content: `${argumentRejection ? "PLAN_TOOL_ARGUMENTS_REJECTED" : "PLAN_TOOL_NOT_ADVERTISED"}: ${JSON.stringify(rejection)}`,
    });
  }
  return out;
}
