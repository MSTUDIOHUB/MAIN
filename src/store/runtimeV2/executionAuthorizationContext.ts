import type { ToolDefinition } from "../../lib/toolSchemas";
import {
  buildToolCapabilityRegistry,
  normalizeToolPermissionPolicy,
  type ToolRiskLevel,
} from "../../lib/toolCapabilities";
import { buildToolCatalog } from "../../lib/toolCatalog";
import type { RuntimeV2Command } from "../../lib/runtime-v2";
import { aggregateForCurrentTurn } from "./executionAggregate";
import {
  deriveRuntimeV2ProviderEffectFacts,
  latestRuntimeV2CorrectiveMutationFailure,
} from "./executionProviderEffectFacts";
import { buildRuntimeV2DecisionView } from "./executionProviderDecisionView";
import {
  materializedRuntimeV2SourceCoverage,
} from "./executionProviderSourceCoverage";
import { runtimeV2ProviderActionWindowFor } from "./executionProviderActionWindow";
import { runtimeV2ToolDefinitions } from "./executionToolDefinitions";
import {
  buildRuntimeV2TextEnvelopeCatalog,
  selectRuntimeV2ProviderToolDefinitions,
} from "./executionProviderTools";
import type {
  RuntimeV2ExecutionAuthorization,
  RuntimeV2ExecutionPortsInput,
} from "./executionTypes";
import { preferredFiniteValidationCommand } from "./executionProviderContext";
import {
  deriveRuntimeV2ExecutionContractAdvance,
} from "./executionContractAdvance";
import {
  deriveRuntimeV2ValidationCorrectionWindow,
} from "./executionValidationCorrection";

export const RUNTIME_V2_VALIDATION_TOOL_NAMES = new Set([
  "run_command", "browser_evaluate", "computer_use",
]);

export interface RuntimeV2ToolAuthorizationResult {
  readonly allowed: boolean;
  readonly reason: string | null;
  readonly allowExternalLocalRead: boolean;
  readonly shellPermissionApproval?: import("../../lib/ipc").ShellPermissionApproval;
  readonly approvalRequired?: boolean;
  readonly risk?: ToolRiskLevel;
  readonly localFileReadPath?: string;
}

/** Freeze the built-in tool surface and policy for this Runtime v2 Turn.
 * Extensions stay on the legacy adapter until their own capability contract
 * is migrated; an unknown tool can therefore never bypass the catalog. */
export function createRuntimeV2ExecutionAuthorization(
  state: any,
): RuntimeV2ExecutionAuthorization {
  const toolDefinitions = runtimeV2ToolDefinitions(state);
  const policy = normalizeToolPermissionPolicy(
    state?.config?.toolPermissionPolicy,
  );
  const toolCatalog = buildToolCatalog({ builtInDefinitions: toolDefinitions });
  const capabilityRegistry = buildToolCapabilityRegistry({
    toolDefinitions,
    toolCatalog,
    policy,
  });
  return { toolDefinitions, toolCatalog, capabilityRegistry, policy };
}

export function authorizationFor(
  input: RuntimeV2ExecutionPortsInput,
): RuntimeV2ExecutionAuthorization {
  if (!input.live.authorization) {
    input.live.authorization = createRuntimeV2ExecutionAuthorization(
      input.get(),
    );
  }
  return input.live.authorization;
}

export function providerToolDefinitionsForCommand(
  input: RuntimeV2ExecutionPortsInput,
  command: RuntimeV2Command,
): ToolDefinition[] {
  const aggregate = aggregateForCurrentTurn(input);
  const effects = deriveRuntimeV2ProviderEffectFacts(aggregate);
  const executionContractAdvance =
    deriveRuntimeV2ExecutionContractAdvance(aggregate);
  const validationCorrection =
    deriveRuntimeV2ValidationCorrectionWindow(aggregate);
  // Tool selection runs before the next provider request rebuilds its final
  // decision view. Refresh this presentation-derived fact from the durable
  // transcript now so a just-completed corrective read can reopen mutation
  // immediately instead of forcing one redundant read decision.
  const currentSourceCoverage = materializedRuntimeV2SourceCoverage(
    buildRuntimeV2DecisionView(input.live.messages, effects),
    input.context.runWorkspace || "",
    effects,
  );
  input.live.latestProviderRequestSourceCoverage = currentSourceCoverage;
  const actionWindow = runtimeV2ProviderActionWindowFor({
    command,
    effects,
    sourceCoverage: currentSourceCoverage,
    workspace: input.context.runWorkspace || "",
    completedContractAwaitingValidation:
      executionContractAdvance.required &&
      executionContractAdvance.pendingTargets.length === 0,
    newerValidationFailureSequence: validationCorrection.active
      ? validationCorrection.failureSequence
      : null,
  });
  const correctiveSourceTargets = actionWindow === "corrective_source"
    ? [...new Set(
        (latestRuntimeV2CorrectiveMutationFailure(effects)?.targets || [])
          .map((target) => String(target || "").trim())
          .filter(Boolean),
      )]
    : [];
  input.live.latestProviderActionWindow = actionWindow;
  return selectRuntimeV2ProviderToolDefinitions({
    ports: input,
    command,
    available: authorizationFor(input).toolDefinitions,
    actionWindow,
    correctiveSourceTargets,
    correctiveValidationCommand:
      String(command.payload.mode || "").trim() === "validate"
        ? validationCorrection.validationCommandUnavailable
          ? ""
          : input.live.correctiveValidationCommand ||
            preferredFiniteValidationCommand(input)
        : "",
  });
}

export function compactTextEnvelopeCatalog(
  tools: readonly ToolDefinition[],
): string {
  return buildRuntimeV2TextEnvelopeCatalog(tools);
}
