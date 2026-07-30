import {
  deriveProviderAdapterCapabilities,
  deriveStreamSettings,
} from "../../lib/providerLaneSettings";
import {
  DEFAULT_PROVIDER_LANE_PROFILE_V1,
  deriveRuntimeV2PlanSourceFreshness,
  type ProviderLaneProfileV1,
} from "../../lib/runtime-v2";
import {
  aggregateForCurrentTurn,
  approvedPlanForCurrentTurn,
} from "./executionAggregate";
import { upsertRuntimeV2ContextAnchor } from "./executionProviderAnchors";
import type {
  RuntimeV2ExecutionPortsInput,
} from "./executionTypes";

export function containsProviderTextEnvelopePrompt(
  language: "zh" | "en",
  toolRequired: boolean,
): string {
  if (language === "en") {
    return toolRequired
      ? "Native tools are unavailable for this request. A structured tool call is required now. Output exactly `<runtime-v2-tools>{\"toolCalls\":[{\"id\":\"id\",\"name\":\"tool_name\",\"arguments\":{}}]}</runtime-v2-tools>` with valid JSON and no prose."
      : "Native tools are unavailable for this request. If a tool is needed, output exactly `<runtime-v2-tools>{\"toolCalls\":[{\"id\":\"id\",\"name\":\"tool_name\",\"arguments\":{}}]}</runtime-v2-tools>` with valid JSON and no prose.";
  }
  return toolRequired
    ? "本次请求不使用原生工具，但当前阶段必须提交一个结构化工具调用。只输出完整的 `<runtime-v2-tools>{\"toolCalls\":[{\"id\":\"id\",\"name\":\"tool_name\",\"arguments\":{}}]}</runtime-v2-tools>` JSON 信封，不要混入说明文字。"
    : "本次请求不使用原生工具。若需要工具，只输出一个完整的 `<runtime-v2-tools>{\"toolCalls\":[{\"id\":\"id\",\"name\":\"tool_name\",\"arguments\":{}}]}</runtime-v2-tools>` JSON 信封，不要混入说明文字。";
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
  const aggregate = aggregateForCurrentTurn(input);
  const approved = approvedPlanForCurrentTurn(input);
  if (!aggregate || !approved) return;
  const freshness = deriveRuntimeV2PlanSourceFreshness(aggregate);
  const content = [
    "This sealed WorkPlan is the mutation and validation authority for the current Run.",
    JSON.stringify({
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
    }, null, 2),
    freshness && !freshness.allFresh
      ? `Before the first mutation, call read_file for every missing exact target: ${freshness.missingTargets.join(", ") || "none"}. A stale target invalidates this approval.`
      : "",
  ].join("\n\n");
  upsertRuntimeV2ContextAnchor(input.live, {
    key: "approved-work-plan",
    content,
  });
}

/** A phase-level hint sourced only from an approved WorkPlan.
 * Workspace manifests cannot silently promote a convenient build command
 * into acceptance evidence. Direct Execute leaves validation selection to the
 * model and checks the resulting finite receipt at completion. */
export function preferredFiniteValidationCommand(
  input: RuntimeV2ExecutionPortsInput,
): string {
  const approved = approvedPlanForCurrentTurn(input);
  const approvedValidation = approved?.plan.draft.validations.find(
    (validation) =>
      validation.kind === "finite_command" &&
      String(validation.command || "").trim(),
  );
  const approvedCommand = String(approvedValidation?.command || "").trim();
  return approvedCommand;
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
