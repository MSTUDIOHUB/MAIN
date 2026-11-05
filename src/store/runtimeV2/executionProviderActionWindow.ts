import type { RuntimeV2Command } from "../../lib/runtime-v2";
import {
  type RuntimeV2ProviderEffectFacts,
} from "./executionProviderEffectFacts";
import type {
  RuntimeV2MaterializedSourceCoverage,
  RuntimeV2ProviderActionWindow,
} from "./executionTypes";

/**
 * Recovery pressure guides the next decision without confiscating safe reads
 * or imposing a target lock. Mutation leases and per-call authorization remain
 * enforced independently at execution; repeated failures are soft signals.
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
