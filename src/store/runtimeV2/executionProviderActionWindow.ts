import type { RuntimeV2Command } from "../../lib/runtime-v2";
import {
  type RuntimeV2ProviderEffectFacts,
} from "./executionProviderEffectFacts";
import type {
  RuntimeV2MaterializedSourceCoverage,
  RuntimeV2ProviderActionWindow,
} from "./executionTypes";

export const RUNTIME_V2_CORRECTIVE_MUTATION_MAX_FAILURES = 8;

export function runtimeV2CorrectiveMutationFailureLimitReached(
  effects: RuntimeV2ProviderEffectFacts,
): boolean {
  return (effects.correctiveMutationFailureToolCallIds?.size || 0) >=
    RUNTIME_V2_CORRECTIVE_MUTATION_MAX_FAILURES;
}

/**
 * Inspired by gg-framework / gg-agent:
 * Never trap the model in closed recovery windows (`corrective_source`,
 * `corrective_mutation`, `closed_recovery`) that confiscate inspection/edit
 * tools and invalidate the KV cache prefix. Let natural tool error feedback
 * (with nearby source context) guide the model's next action.
 */
export function runtimeV2ProviderActionWindowFor(_input: {
  readonly command: Pick<RuntimeV2Command, "payload">;
  readonly effects: RuntimeV2ProviderEffectFacts;
  readonly sourceCoverage:
    readonly RuntimeV2MaterializedSourceCoverage[];
  readonly workspace?: string;
  readonly completedContractAwaitingValidation?: boolean;
  readonly newerValidationFailureSequence?: number | null;
}): RuntimeV2ProviderActionWindow | null {
  return null;
}
