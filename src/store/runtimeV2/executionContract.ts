import type { ToolDefinition } from "../../lib/toolSchemas";
import type { TurnAggregateV1 } from "../../lib/runtime-v2";
import { workspacePathsReferToSameFile } from "../../lib/workspacePaths";
import { analyzeValidationCommand } from "../../lib/validationContract";
import { isRuntimeV2ValidationAttempt } from "../../lib/runtime-v2/validationAttempt";
import { finiteValidationCommandRejection } from "./executionValidationCommand";
import {
  RECORD_RUNTIME_V2_EXECUTION_CONTRACT_TOOL_NAME,
  deriveRuntimeV2ExecutionContract,
  parseRuntimeV2ExecutionContractArguments,
  runtimeV2ExecutionContractMutationTargets,
  scheduledCommandsByKey,
  versionedSourceEvidenceBefore,
  type RuntimeV2ExecutionContract,
  type RuntimeV2ExecutionContractOperation,
} from "../../lib/runtime-v2/executionContract";
export {
  RECORD_RUNTIME_V2_EXECUTION_CONTRACT_TOOL_NAME,
  deriveRuntimeV2ExecutionContract,
  parseRuntimeV2ExecutionContractArguments,
  runtimeV2ExecutionContractMutationTargets,
  type RuntimeV2ExecutionContract,
  type RuntimeV2ExecutionContractOperation,
  type RuntimeV2ExecutionContractChange,
  type RuntimeV2ExecutionContractValidation,
} from "../../lib/runtime-v2/executionContract";

export const RECORD_RUNTIME_V2_EXECUTION_CONTRACT_TOOL: ToolDefinition = {
  type: "function",
  function: {
    name: RECORD_RUNTIME_V2_EXECUTION_CONTRACT_TOOL_NAME,
    description:
      "Record or revise the parent Execute implementation contract after reading exact source. This does not modify files. It binds proved causes, exact operations/targets, preserved boundaries, and finite acceptance checks so later parent or child mutations cannot drift outside the evidence-backed solution.",
    parameters: {
      type: "object",
      properties: {
        summary: {
          type: "string",
          description:
            "Concise complete solution connecting every user-visible symptom to the proved cause and intended repair.",
        },
        root_causes: {
          type: "array",
          minItems: 1,
          items: { type: "string" },
          description:
            "Evidence-backed causal findings. Do not list guesses or restate symptoms.",
        },
        changes: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            properties: {
              operation: {
                type: "string",
                enum: ["modify", "create", "delete", "preserve"],
              },
              targets: {
                type: "array",
                minItems: 1,
                items: { type: "string" },
                description:
                  "Every exact workspace-relative file owned by this change. Use preserve for an investigated owner that must remain unchanged.",
              },
              change: {
                type: "string",
                description:
                  "Concrete symbol/API/behavior change and the unrelated behavior it must preserve.",
              },
              expected_outcome: { type: "string" },
            },
            required: ["operation", "targets", "change", "expected_outcome"],
          },
        },
        validations: {
          type: "array",
          minItems: 1,
          description:
            "Static and behavioral checks. For a user-visible objective, build/lint/typecheck alone is invalid; include a real test/inline assertion or browser/desktop observation.",
          items: {
            type: "object",
            properties: {
              kind: {
                type: "string",
                enum: ["finite_command", "browser", "desktop", "assertion"],
              },
              command: {
                type: "string",
                description:
                  "For finite_command only: one bounded build, test, lint, typecheck, check, or inline assertion without shell wrappers.",
              },
              expected_outcome: {
                type: "string",
                description: "Observable pass condition tied to the user objective.",
              },
            },
            required: ["kind", "expected_outcome"],
          },
        },
        behavioral_validation: {
          description:
            "Runtime-required user-visible acceptance. This field becomes required in the advertised schema when the admitted objective has a behavioral or interaction acceptance floor.",
          anyOf: [{
            type: "object",
            properties: {
              kind: { type: "string", enum: ["finite_command"] },
              command: {
                type: "string",
                description:
                  "One finite test or inline assertion. Build, lint, typecheck, source inspection, services, and watchers are not behavioral evidence.",
              },
              expected_outcome: {
                type: "string",
                description:
                  "The observable assertion tied to the user's reported behavior.",
              },
            },
            required: ["kind", "command", "expected_outcome"],
          }, {
            type: "object",
            properties: {
              kind: { type: "string", enum: ["browser", "desktop"] },
              expected_outcome: {
                type: "string",
                description:
                  "The observable post-action result that proves the user's scenario.",
              },
            },
            required: ["kind", "expected_outcome"],
          }],
        },
        revision_reason: {
          type: "string",
          description:
            "Required when replacing an existing contract: name the new source or failed validation evidence that changes the solution or scope.",
        },
      },
      required: ["summary", "root_causes", "changes", "validations"],
    },
  },
};

export function validateRuntimeV2ExecutionContractSubmission(input: {
  readonly aggregate: TurnAggregateV1 | null;
  readonly args: Readonly<Record<string, unknown>>;
}): { readonly allowed: true; readonly contract: ReturnType<typeof parseRuntimeV2ExecutionContractArguments> } |
  { readonly allowed: false; readonly reason: string } {
  if (!input.aggregate || input.aggregate.strategy !== "execute") {
    return {
      allowed: false,
      reason: "EXECUTION_CONTRACT_REJECTED: only a direct Execute Run may record this contract.",
    };
  }
  const parsed = parseRuntimeV2ExecutionContractArguments(input.args);
  if (!parsed.summary || parsed.rootCauses.length === 0) {
    return {
      allowed: false,
      reason:
        "EXECUTION_CONTRACT_REJECTED: provide a concise complete summary and at least one evidence-backed root cause.",
    };
  }
  if (parsed.changes.length === 0 || parsed.validations.length === 0) {
    return {
      allowed: false,
      reason:
        "EXECUTION_CONTRACT_REJECTED: provide at least one concrete change/preserve entry and one finite or observable validation.",
    };
  }
  const invalidFiniteValidation = parsed.validations.find((validation) =>
    validation.kind === "finite_command" &&
    finiteValidationCommandRejection(validation.command)
  );
  if (invalidFiniteValidation) {
    const rejection = finiteValidationCommandRejection(
      invalidFiniteValidation.command,
    );
    return {
      allowed: false,
      reason: [
        "EXECUTION_CONTRACT_REJECTED: finite_command must be one bounded build, test, lint, typecheck, check, or failing inline assertion; services and observers are not acceptance checks.",
        rejection?.message || "The command has no finite validation exit status.",
      ].join(" "),
    };
  }
  const acceptanceRequirements =
    input.aggregate.objective?.acceptanceEvidenceRequirements || [];
  const hasInteractionValidation = parsed.validations.some((validation) =>
    validation.kind === "browser" || validation.kind === "desktop"
  );
  const hasBehavioralFiniteValidation = parsed.validations.some(
    (validation) => {
      if (validation.kind !== "finite_command" || !validation.command) {
        return false;
      }
      const analysis = analyzeValidationCommand(validation.command);
      const capability = analysis.spec?.kind === "finite_command"
        ? analysis.spec.capability
        : null;
      return capability === "test" || capability === "inline_assertion";
    },
  );
  if (
    acceptanceRequirements.includes("interaction") &&
    !hasInteractionValidation
  ) {
    return {
      allowed: false,
      reason:
        "EXECUTION_CONTRACT_REJECTED: the runtime-owned interaction acceptance floor requires a browser or desktop validation with an observable post-action result; a static command cannot replace it.",
    };
  }
  if (
    acceptanceRequirements.includes("behavioral") &&
    !hasInteractionValidation &&
    !hasBehavioralFiniteValidation
  ) {
    return {
      allowed: false,
      reason:
        "EXECUTION_CONTRACT_REJECTED: the runtime-owned behavioral acceptance floor requires a real test/inline assertion or browser/desktop validation; build, lint, and source inspection alone cannot prove the user-visible behavior.",
    };
  }
  const existing = deriveRuntimeV2ExecutionContract(input.aggregate);
  if (existing && !parsed.revisionReason) {
    return {
      allowed: false,
      reason:
        "EXECUTION_CONTRACT_REJECTED: a revision_reason naming the new evidence is required when replacing the current contract.",
    };
  }
  if (existing) {
    const commands = scheduledCommandsByKey(input.aggregate);
    const hasRevisionBasis = input.aggregate.events.some((event) =>
      event.sequence > existing.recordedAtSequence &&
      (
        (
          event.type === "tool.completed" &&
          (
            (
              event.status !== "succeeded" &&
              commands.get(event.idempotencyKey)?.payload.toolName !==
                RECORD_RUNTIME_V2_EXECUTION_CONTRACT_TOOL_NAME
            ) ||
            event.evidence.some((evidence) =>
              evidence.kind === "source" && !!evidence.version
            )
          )
        ) ||
        (isRuntimeV2ValidationAttempt(event) && !event.passed) ||
        (
          event.type === "subagent.completed" &&
          event.evidence.length > 0
        )
      )
    );
    if (!hasRevisionBasis) {
      return {
        allowed: false,
        reason:
          "EXECUTION_CONTRACT_REJECTED: the active contract cannot be churned without newer source, child, rejected-action, or failed-validation evidence.",
      };
    }
  }
  const sourceEvidence = versionedSourceEvidenceBefore(input.aggregate);
  const unreadTargets = parsed.changes
    .filter((change) => change.operation !== "create")
    .flatMap((change) => change.targets)
    .filter((target) => !sourceEvidence.some((evidence) =>
      workspacePathsReferToSameFile(evidence.target, target)
    ));
  if (unreadTargets.length > 0) {
    return {
      allowed: false,
      reason: [
        "EXECUTION_CONTRACT_REJECTED: every modify/delete/preserve target must have versioned source evidence before planning.",
        `Unread targets: ${[...new Set(unreadTargets)].join(", ")}.`,
      ].join(" "),
    };
  }
  const operationByTarget = new Map<string, RuntimeV2ExecutionContractOperation>();
  for (const change of parsed.changes) {
    for (const target of change.targets) {
      const prior = [...operationByTarget.entries()].find(([candidate]) =>
        workspacePathsReferToSameFile(candidate, target)
      );
      if (prior && prior[1] !== change.operation) {
        return {
          allowed: false,
          reason:
            `EXECUTION_CONTRACT_REJECTED: ${target} has conflicting ${prior[1]} and ${change.operation} operations.`,
        };
      }
      operationByTarget.set(target, change.operation);
    }
  }
  return { allowed: true, contract: parsed };
}

export function runtimeV2ExecutionContractAllowsTargets(input: {
  readonly contract: RuntimeV2ExecutionContract | null;
  readonly targets: readonly string[];
}): boolean {
  if (!input.contract) return true;
  const allowed = runtimeV2ExecutionContractMutationTargets(input.contract);
  return input.targets.length > 0 && input.targets.every((target) =>
    allowed.some((candidate) => workspacePathsReferToSameFile(candidate, target))
  );
}

export function runtimeV2ExecutionContractAnchor(
  contract: RuntimeV2ExecutionContract | null,
): string {
  if (!contract) return "";
  return `[execution_contract_v1] ${JSON.stringify({
    revision: contract.revision,
    summary: contract.summary,
    rootCauses: contract.rootCauses,
    changes: contract.changes,
    validations: contract.validations,
    sourceEvidenceIds: contract.sourceEvidenceIds,
  })}`;
}
