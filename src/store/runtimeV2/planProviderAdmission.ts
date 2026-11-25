import type { AgentMessage } from "../../lib/agentMessages";
import type { ToolDefinition } from "../../lib/toolSchemas";
import type { RuntimeV2NormalizedProviderResult, RuntimeV2RunIdentity, TurnAggregateV1 } from "../../lib/runtime-v2";
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

/** Keep at most the latest rejected surface group at the tail of `messages`
 * so repeated invalid tool calls do not bloat prompt tokens linearly. */
export function replaceTrailingPlanAdmissionRejectionGroup(
  messages: AgentMessage[],
  replacement: readonly AgentMessage[],
): void {
  let cursor = messages.length;
  while (cursor > 0) {
    const candidate = messages[cursor - 1];
    const isSkippableTail =
      candidate?.role === "system" ||
      (candidate?.role === "assistant" &&
        !candidate.tool_calls?.length &&
        !String(candidate.content || "").trim());
    if (!isSkippableTail) break;
    cursor -= 1;
  }
  const prefix = messages.slice(0, cursor);
  const group = latestRuntimeV2PlanProviderAdmissionRejectionHistory(prefix);
  if (group.length > 0 && cursor >= group.length) {
    messages.splice(cursor - group.length, group.length);
  }
  messages.push(...replacement);
}

const REPAIR_ALLOWED_TOOLS = new Set([
  "read_file",
  "load_skill",
  "ask_plan_questions",
  "submit_runtime_v2_work_plan",
  "submit_plan_document",
]);

const NARROW_SUBMISSION_TOOLS = new Set([
  "ask_plan_questions",
  "submit_runtime_v2_work_plan",
  "submit_plan_document",
]);

/** Restrict the tool surface on repeated invalid tool requests so the model
 * focuses solely on schema-valid plan synthesis (or repairs with reads). */
export function narrowedPlanSubmissionTools(
  tools: readonly ToolDefinition[],
  options: { readonly submissionRepairPending?: boolean } = {},
): ToolDefinition[] {
  const allow = options.submissionRepairPending === true
    ? REPAIR_ALLOWED_TOOLS
    : NARROW_SUBMISSION_TOOLS;
  return tools.filter((tool) => allow.has(tool.function.name));
}

export interface PlanAdmissionRejectionRecovery {
  readonly consecutiveRejections: number;
  readonly action: "none" | "retry_in_place" | "narrow_to_synthesis" | "exhausted";
}

function samePlanRun(left: RuntimeV2RunIdentity, right: RuntimeV2RunIdentity): boolean {
  return left.runId === right.runId && left.attemptId === right.attemptId;
}

function isAdmissionRejectionResponse(
  event: Extract<TurnAggregateV1["events"][number], { type: "provider.responded" }>,
  includeArgumentRejections: boolean,
): boolean {
  return event.result.diagnostics.some((diagnostic) =>
    diagnostic.code === "tool_surface_rejected" ||
    (includeArgumentRejections && diagnostic.code === "tool_arguments_rejected")
  );
}

/** Shared across both WorkPlan and PlanDocument runners: after 2 consecutive
 * rejected tool surfaces without intervening progress, force narrowed plan
 * synthesis; after 4 consecutive rejections without resolution, halt cleanly. */
export function derivePlanAdmissionRejectionRecovery(input: {
  readonly aggregate: TurnAggregateV1 | null | undefined;
  readonly run: RuntimeV2RunIdentity;
  readonly collaboration?: Readonly<Record<string, unknown>>;
  readonly submissionRepairPending?: boolean;
}): PlanAdmissionRejectionRecovery {
  const includeArgumentRejections = input.submissionRepairPending !== true;
  const events = (input.aggregate?.events || []).filter((event) =>
    !("run" in event) || samePlanRun(event.run, input.run)
  );
  let consecutiveRejections = 0;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]!;
    if (event.type === "provider.responded") {
      if (isAdmissionRejectionResponse(event, includeArgumentRejections)) {
        consecutiveRejections += 1;
        continue;
      }
      if (event.result.toolCalls.length > 0) break;
      continue;
    }
    if (
      event.type === "observation.recorded" ||
      (event.type === "tool.completed" && event.status === "succeeded") ||
      (event.type === "subagent.completed" && event.status === "completed") ||
      event.type === "run.resumed"
    ) {
      break;
    }
  }
  if (consecutiveRejections === 0) {
    return { consecutiveRejections: 0, action: "none" };
  }
  const requiredPending =
    input.collaboration?.collaborationRequired === true &&
    input.collaboration?.collaborationRequirementMet !== true;
  if (requiredPending) {
    return {
      consecutiveRejections,
      action: consecutiveRejections >= 4 ? "exhausted" : "retry_in_place",
    };
  }
  return {
    consecutiveRejections,
    action: consecutiveRejections >= 4
      ? "exhausted"
      : consecutiveRejections >= 2
        ? "narrow_to_synthesis"
        : "retry_in_place",
  };
}
