import type { PlanRuntimePhase } from "../../workflowModels";
import type { FetchLLMStreamOptions } from "../types";
import { SUBMIT_PLAN_CANDIDATE_TOOL_NAME } from "../../toolSchemas";

// The lease must fit the typed replacement graph and bounded provider output
// overhead. Scale from the frozen graph shape, while retaining a hard ceiling
// and zero automatic escalation so a malformed rewrite cannot grow forever.
export const PREAPPROVAL_PLAN_QUALITY_RECOVERY_BASE_OUTPUT_TOKENS = 4_096;
export const PREAPPROVAL_PLAN_QUALITY_RECOVERY_MAX_OUTPUT_TOKENS = 8_192;
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

export interface PreapprovalPlanGraphSize {
  goals?: number;
  evidence?: number;
  changes?: number;
  validations?: number;
  interfaces?: number;
}

function boundedCount(value: number | undefined, max: number): number {
  const parsed = Number(value) || 0;
  return Math.min(max, Math.max(0, Math.floor(parsed)));
}

export function resolvePreapprovalPlanQualityRecoveryOutputTokens(
  graphSize: PreapprovalPlanGraphSize | undefined,
): number {
  if (!graphSize) return PREAPPROVAL_PLAN_QUALITY_RECOVERY_BASE_OUTPUT_TOKENS;
  const goals = boundedCount(graphSize.goals, 32);
  const evidence = boundedCount(graphSize.evidence, 96);
  const changes = boundedCount(graphSize.changes, 48);
  const validations = boundedCount(graphSize.validations, 48);
  const interfaces = boundedCount(graphSize.interfaces, 48);
  const estimated =
    PREAPPROVAL_PLAN_QUALITY_RECOVERY_BASE_OUTPUT_TOKENS +
    Math.max(0, goals - 1) * 220 +
    evidence * 72 +
    changes * 120 +
    validations * 160 +
    interfaces * 72;
  return Math.min(
    PREAPPROVAL_PLAN_QUALITY_RECOVERY_MAX_OUTPUT_TOKENS,
    Math.max(PREAPPROVAL_PLAN_QUALITY_RECOVERY_BASE_OUTPUT_TOKENS, estimated),
  );
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
  planAutoScaffoldPromptIssued: boolean;
  llmToolNames: string[];
  forceXmlTools: boolean;
  graphSize?: PreapprovalPlanGraphSize;
}): PreapprovalPlanQualityRecoveryStreamPolicy {
  const active =
    input.workflowMode === "plan" &&
    !input.isPlanApproved &&
    input.planRuntimePhase === "needs_rewrite";
  if (!active) return INACTIVE_POLICY;

  const stage: PreapprovalPlanQualityRecoveryStage = input.planAutoScaffoldPromptIssued
    ? "auto_scaffold"
    : "rewrite";
  return {
    active: true,
    stage,
    maxOutputTokens: resolvePreapprovalPlanQualityRecoveryOutputTokens(input.graphSize),
    maxStreamElapsedMs: PREAPPROVAL_PLAN_QUALITY_RECOVERY_MAX_ELAPSED_MS,
    maxStreamElapsedLabel: `preapproval_plan_quality_recovery_${stage}`,
    // The control-plane submission is not a write tool. Require it only when
    // it is the exact native surface; compatibility providers follow the
    // replacement authoring contract injected for their actual transport.
    toolChoice:
      !input.forceXmlTools &&
      input.llmToolNames.length === 1 &&
      input.llmToolNames[0] === SUBMIT_PLAN_CANDIDATE_TOOL_NAME
        ? "required"
        : undefined,
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
