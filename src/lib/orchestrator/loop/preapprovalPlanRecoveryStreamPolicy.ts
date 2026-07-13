import { isPlanDraftWriteToolName } from "../../planRuntime";
import type { PlanRuntimePhase } from "../../workflowModels";
import type { FetchLLMStreamOptions } from "../types";

export const PREAPPROVAL_PLAN_QUALITY_RECOVERY_MAX_OUTPUT_TOKENS = 2_048;
export const PREAPPROVAL_PLAN_QUALITY_RECOVERY_MAX_ELAPSED_MS = 120_000;
export const PREAPPROVAL_PLAN_QUALITY_RECOVERY_TIMEOUT_STOP_CLASS =
  "preapproval_plan_quality_recovery_stream_timeout";

export type PreapprovalPlanQualityRecoveryStage =
  | "none"
  | "rewrite"
  | "auto_scaffold";

export interface PreapprovalPlanQualityRecoveryStreamPolicy {
  active: boolean;
  stage: PreapprovalPlanQualityRecoveryStage;
  maxOutputTokens: number | undefined;
  maxStreamElapsedMs: number | undefined;
  maxStreamElapsedLabel: string | undefined;
  toolChoice: "required" | undefined;
  stopClass: string | undefined;
}

const INACTIVE_POLICY: PreapprovalPlanQualityRecoveryStreamPolicy = {
  active: false,
  stage: "none",
  maxOutputTokens: undefined,
  maxStreamElapsedMs: undefined,
  maxStreamElapsedLabel: undefined,
  toolChoice: undefined,
  stopClass: undefined,
};

export function resolvePreapprovalPlanQualityRecoveryStreamPolicy(input: {
  workflowMode: "chat" | "edit" | "plan";
  isPlanApproved: boolean;
  planRuntimePhase: PlanRuntimePhase;
  planQualityRejectCount: number;
  planAutoScaffoldPromptIssued: boolean;
  llmToolNames: string[];
  forceXmlTools: boolean;
}): PreapprovalPlanQualityRecoveryStreamPolicy {
  const active =
    input.workflowMode === "plan" &&
    !input.isPlanApproved &&
    input.planRuntimePhase === "needs_rewrite";
  if (!active) return INACTIVE_POLICY;

  const stage: PreapprovalPlanQualityRecoveryStage =
    input.planAutoScaffoldPromptIssued || input.planQualityRejectCount >= 2
      ? "auto_scaffold"
      : "rewrite";
  const canRequireNativePlanWrite =
    !input.forceXmlTools &&
    input.llmToolNames.some(isPlanDraftWriteToolName);

  return {
    active: true,
    stage,
    maxOutputTokens: PREAPPROVAL_PLAN_QUALITY_RECOVERY_MAX_OUTPUT_TOKENS,
    maxStreamElapsedMs: PREAPPROVAL_PLAN_QUALITY_RECOVERY_MAX_ELAPSED_MS,
    maxStreamElapsedLabel: `preapproval_plan_quality_recovery_${stage}`,
    toolChoice: canRequireNativePlanWrite ? "required" : undefined,
    stopClass: PREAPPROVAL_PLAN_QUALITY_RECOVERY_TIMEOUT_STOP_CLASS,
  };
}

export function capPreapprovalPlanQualityRecoveryMaxTokens(
  policy: PreapprovalPlanQualityRecoveryStreamPolicy,
  requestedMaxTokens: number | undefined,
): number | undefined {
  if (!policy.active || policy.maxOutputTokens == null) {
    return requestedMaxTokens;
  }
  return Math.min(
    requestedMaxTokens ?? policy.maxOutputTokens,
    policy.maxOutputTokens,
  );
}

export function capPreapprovalPlanQualityRecoveryMaxEscalations(
  policy: PreapprovalPlanQualityRecoveryStreamPolicy,
  requestedMaxEscalations: number,
): number {
  return policy.active ? 0 : requestedMaxEscalations;
}

export function applyPreapprovalPlanQualityRecoveryStreamOptions(
  policy: PreapprovalPlanQualityRecoveryStreamPolicy,
  options: FetchLLMStreamOptions = {},
  nativeToolCount = 0,
): FetchLLMStreamOptions {
  if (!policy.active || policy.maxStreamElapsedMs == null) return options;

  const existingMaxElapsedMs = Number(options.maxStreamElapsedMs) || 0;
  const usePolicyElapsedBound =
    existingMaxElapsedMs <= 0 ||
    policy.maxStreamElapsedMs < existingMaxElapsedMs;
  return {
    ...options,
    maxStreamElapsedMs: usePolicyElapsedBound
      ? policy.maxStreamElapsedMs
      : existingMaxElapsedMs,
    maxStreamElapsedLabel: usePolicyElapsedBound
      ? policy.maxStreamElapsedLabel
      : options.maxStreamElapsedLabel,
    toolChoice:
      options.toolChoice ??
      (nativeToolCount > 0 ? policy.toolChoice : undefined),
  };
}
