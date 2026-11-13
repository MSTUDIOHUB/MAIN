import type { TurnAggregateV1 } from "./aggregate";
import type { RuntimeV2CompletionRequirement, RuntimeV2ResultKind } from "./contracts";
import { deriveRuntimeV2PlanExecutionCoverage } from "./planExecution";
import { latestRuntimeV2Answer } from "./providerAnswer";
import {
  deriveRuntimeV2ExecutionContract,
  RECORD_RUNTIME_V2_EXECUTION_CONTRACT_TOOL_NAME,
} from "./executionContract";
import { latestRuntimeV2DirectExecuteValidationSequence, runtimeV2DirectExecuteReadyForConclusion, summarizeRuntimeV2ExecuteEvidence } from "./phaseTransition";
import { isWorkspaceMutationToolName } from "../workspaceMutationTools";
import { isRuntimeV2ReadOnlyToolName, RUNTIME_V2_WORKSPACE_NETWORK_READ_TOOL_NAMES } from "./workspaceReadPolicy";
import { analyzeValidationCommand } from "../validationContract";
import { isRuntimeV2ValidationAttempt } from "./validationAttempt";
import { runtimeV2WorkspaceChangeReceipts } from "./validationReceipt";
import { effectiveRuntimeV2CompletionRequirement } from "./completionRequirement";
import { normalizedEvidenceUrl } from "./readOnlyProgress";

/** Facts supplied by a store adapter after it has inspected actual tool and
 * validation receipts. Provider wording is intentionally reduced to a
 * boolean: prose cannot independently conclude a Turn. */
export interface RuntimeV2CompletionFacts {
  readonly canceled: boolean;
  readonly mutationCount: number;
  readonly passedValidationCount: number;
  readonly hasAcceptanceValidation: boolean;
  readonly failedValidationCount: number;
  readonly stalledValidationCount: number;
  readonly hasProviderConclusion: boolean;
}

export interface RuntimeV2CompletionDecision {
  readonly resultKind: RuntimeV2ResultKind;
  readonly resultReason: string;
}

type RequestedOperation = Extract<RuntimeV2CompletionRequirement, { kind: "requested_operation" }>;

function matchedRequestedOperation(requirement: RequestedOperation | undefined, name: string, args: Readonly<Record<string, unknown>>, operationName?: string): string | null {
  if (!requirement || (requirement.toolName && requirement.toolName !== name && requirement.toolName !== operationName)) return null;
  if (requirement.channel === "network") {
    if (name !== requirement.toolName) return null;
    if (!requirement.targetUrls?.length) return "requested";
    const url = normalizedEvidenceUrl(args.url);
    return requirement.targetUrls.includes(url) ? url : null;
  }
  if (requirement.channel === "external") {
    return name !== "run_command" && (!requirement.action || args.action === requirement.action) ? "requested" : null;
  }
  const command = typeof args.command === "string" ? args.command.trim() : "";
  if (requirement.exactCommand) return name === "run_command" && command === requirement.exactCommand.trim() ? "requested" : null;
  if (requirement.action?.startsWith("git:")) {
    const action = requirement.action.slice(4);
    const verb = name === "git_status" || name === "git_diff" ? name.slice(4)
      : name === "run_command" ? /^git\s+([a-z][a-z-]*)\b/.exec(command)?.[1] : undefined;
    if (action === "commit_push") return verb === "commit" || verb === "push" ? verb : null;
    return verb && (action === "git" || action === verb) ? "requested" : null;
  }
  if (name !== "run_command") return null;
  if (requirement.action === "test" || requirement.action === "build" || requirement.action === "start") {
    const validation = analyzeValidationCommand(command).spec;
    const matches = requirement.action === "start" ? validation?.kind === "service_observation"
      : validation?.kind === "finite_command" && validation.capability === requirement.action;
    return matches ? "requested" : null;
  }
  return "requested";
}

/** One canonical action frontier shared by command and mutation completion.
 * No control-plane receipt or skipped sibling can manufacture an effect. */
function completedRuntimeV2ActionFacts(
  aggregate: TurnAggregateV1,
  afterSequence = -1,
  requirement?: RequestedOperation,
): { hasOperation: boolean; allSettled: boolean } {
  if (!aggregate.run) return { hasOperation: false, allSettled: false };

  // Unlike recovery fingerprints, this key preserves every normalized tool
  // argument. Only the same action can resolve its earlier failed receipt.
  const actionKey = (toolName: string, args: unknown): string => JSON.stringify(
    [toolName, args],
    (_key, value) => value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)))
      : value,
  );
  const commands = new Map<string, { key: string; name: string; args: Readonly<Record<string, unknown>>; readOnly: boolean }>();
  const completedKeys = new Set<string>();
  const results = new Map<string, { settled: boolean; operation: string | null }>();
  for (const event of aggregate.events) {
    if (!("run" in event) || event.run.runId !== aggregate.run.identity.runId) continue;
    if (event.type === "command.scheduled") {
      const command = event.command;
      if (command.kind !== "execute_tool" && command.kind !== "execute_validation") continue;
      const name = String(command.payload.toolName || "");
      const key = actionKey(name, command.payload.arguments || {});
      const readOnly = isRuntimeV2ReadOnlyToolName(name);
      const args = (command.payload.arguments || {}) as Readonly<Record<string, unknown>>;
      commands.set(command.idempotencyKey, { key, name, args, readOnly });
      continue;
    }
    if (event.type !== "tool.completed" && event.type !== "validation.completed") continue;
    const command = commands.get(event.idempotencyKey);
    if (!command) continue;
    completedKeys.add(event.idempotencyKey);
    if (event.sequence <= afterSequence) continue;
    const skipped = event.type === "validation.completed"
      ? !isRuntimeV2ValidationAttempt(event)
      : event.failureReasonCode === "provider_batch_predecessor_failed" ||
        event.failureReasonCode === "provider_batch_predecessor_unsettled";
    // A skipped sibling was not attempted. Its real predecessor failure
    // remains in this frontier until that same action actually succeeds.
    if (skipped) continue;
    const succeeded = event.type === "validation.completed" ? event.passed : event.status === "succeeded";
    const executed = event.type === "validation.completed" || event.receiptOrigin !== "replayed";
    const hasEffect = executed && event.evidence.some((evidence) =>
      evidence.kind === "tool" || evidence.kind === "mutation" || evidence.kind === "validation",
    );
    const readOnly = command.readOnly || event.type === "tool.completed" && event.effectKind === "observation";
    const networkRead = RUNTIME_V2_WORKSPACE_NETWORK_READ_TOOL_NAMES.has(command.name);
    const hasNetworkResult = networkRead && executed && event.type === "tool.completed" &&
      event.evidence.some(evidence => evidence.kind === "tool");
    const matchesEffect = requirement?.channel === "network"
      ? !!aggregate.networkRead?.enabled && hasNetworkResult
      : requirement?.channel !== "external" || (event.type === "tool.completed" && event.effectKind === "external_operation");
    results.set(command.key, {
      settled: succeeded && (networkRead ? hasNetworkResult : readOnly || hasEffect),
      operation: succeeded && matchesEffect && hasEffect && command.name !== RECORD_RUNTIME_V2_EXECUTION_CONTRACT_TOOL_NAME &&
        (!readOnly || requirement?.channel === "command" || requirement?.channel === "network")
        ? matchedRequestedOperation(requirement, command.name, command.args, event.type === "tool.completed" ? event.operationName : undefined) : null,
    });
  }
  const operations = new Set([...results.values()].map(result => result.operation));
  const hasOperation = requirement?.channel === "network" && requirement.targetUrls?.length
    ? requirement.targetUrls.every(url => operations.has(url))
    : requirement?.channel === "command" && requirement.action === "git:commit_push" && !requirement.exactCommand
      ? operations.has("commit") && operations.has("push")
      : operations.has("requested");
  return {
    hasOperation,
    allSettled: [...commands.keys()].every((key) => completedKeys.has(key)) &&
      [...results.values()].every((result) => result.settled),
  };
}

/** A requested command or external operation can settle without a file artifact. */
export function runtimeV2CommandTaskReadyForConclusion(
  aggregate: TurnAggregateV1,
): boolean {
  const requirement = effectiveRuntimeV2CompletionRequirement(aggregate);
  if (
    aggregate.strategy !== "execute" || !aggregate.run ||
    requirement?.kind !== "requested_operation" ||
    aggregate.workPlan || aggregate.sealedWorkPlan ||
    aggregate.objective.acceptanceEvidenceRequirements?.some((requirement) => requirement !== null) ||
    deriveRuntimeV2ExecutionContract(aggregate) ||
    summarizeRuntimeV2ExecuteEvidence(aggregate, {
      isMutationToolName: isWorkspaceMutationToolName,
    }).mutationCount > 0
  ) return false;
  const facts = completedRuntimeV2ActionFacts(aggregate, -1, requirement);
  return facts.hasOperation && facts.allSettled;
}

/** Ordinary Execute may finish through a clean natural response after real
 * command results or current mutation validation. Neither receipts nor an
 * intermediate pass forces the model to stop its remaining authorized work. */
export function latestRuntimeV2ProviderConclusionText(
  aggregate: TurnAggregateV1,
): string {
  const naturalFinalReady = runtimeV2CommandTaskReadyForConclusion(aggregate) || (
    aggregate.strategy === "execute" && !aggregate.workPlan && !aggregate.sealedWorkPlan &&
    !deriveRuntimeV2ExecutionContract(aggregate) &&
    runtimeV2DirectExecuteReadyForConclusion(aggregate) &&
    completedRuntimeV2ActionFacts(aggregate, latestRuntimeV2DirectExecuteValidationSequence(aggregate)).allSettled
  );
  return (
    latestRuntimeV2Answer(aggregate, true) ||
    (naturalFinalReady
      ? latestRuntimeV2Answer(aggregate)
      : "")
  ).slice(0, 24_000);
}

export function exhaustedRuntimeV2ResultKind(
  aggregate: TurnAggregateV1,
): Extract<RuntimeV2ResultKind, "partial" | "error"> {
  if (aggregate.strategy === "chat" || aggregate.strategy === "analyze") return "error";
  const mutationRequired = aggregate.strategy === "execute" ||
    (
      aggregate.strategy === "plan" &&
      aggregate.workPlan?.status === "approved"
    );
  if (mutationRequired) {
    return runtimeV2WorkspaceChangeReceipts(aggregate).length > 0
      ? "partial"
      : "error";
  }
  return aggregate.evidence.length > 0 ? "partial" : "error";
}

/**
 * Determine only outcomes that the runtime can prove from structured facts.
 * A provider response without a tool call is a finish signal after verified
 * mutations or actual command results. Prose alone never creates evidence.
 */
export function decideRuntimeV2TerminalOutcome(
  aggregate: TurnAggregateV1,
  facts: RuntimeV2CompletionFacts,
): RuntimeV2CompletionDecision | null {
  if (facts.canceled) {
    return {
      resultKind: "canceled",
      resultReason: "用户已停止本轮执行；已保留此前已提交的证据和修改。",
    };
  }
  if (aggregate.recovery.exhausted) {
    return {
      resultKind: exhaustedRuntimeV2ResultKind(aggregate),
      resultReason: aggregate.recovery.exhausted.reason,
    };
  }
  if (aggregate.strategy === "execute") {
    const requirement = effectiveRuntimeV2CompletionRequirement(aggregate);
    if (requirement?.kind === "unspecified") return null;
    if (requirement?.kind === "requested_operation") {
      const operation = completedRuntimeV2ActionFacts(aggregate, -1, requirement);
      if (!operation.hasOperation || !operation.allSettled) return null;
    }
    const hasVerifiedEffect =
      facts.mutationCount > 0 &&
      facts.hasAcceptanceValidation &&
      facts.failedValidationCount === 0;
    if (!facts.hasProviderConclusion) return null;
    if (hasVerifiedEffect) {
      return {
        resultKind: "success",
        resultReason:
          "最新工作区效果已由后续有限验证确认，并已生成基于实际证据的完成报告。",
      };
    }
    if (facts.mutationCount === 0 && runtimeV2CommandTaskReadyForConclusion(aggregate)) {
      return {
        resultKind: "success",
        resultReason: "已取得所请求操作的成功回执，并根据实际结果生成报告。",
      };
    }
    return facts.mutationCount > 0
      ? {
          resultKind: "partial",
          resultReason:
            "模型已结束本轮，但最新修改尚未获得与用户目标匹配的完整验收证据。",
        }
      : null;
  }
  const approvedPlanCoverage = deriveRuntimeV2PlanExecutionCoverage(aggregate);
  if (approvedPlanCoverage) {
    if (
      !approvedPlanCoverage.allMutationTargetsCovered ||
      !approvedPlanCoverage.allRequiredValidationsPassed
    ) {
      if (!facts.hasProviderConclusion) return null;
      const missingTargets =
        approvedPlanCoverage.missingMutationTargets;
      const missingValidationIds =
        approvedPlanCoverage.missingRequiredValidationIndexes.map(
          (index) => `work-plan-validation-${index + 1}`,
        );
      const detail = [
        missingTargets.length > 0
          ? `未覆盖修改目标：${missingTargets.join("、")}。`
          : "",
        missingValidationIds.length > 0
          ? `未通过必需验证：${missingValidationIds.join("、")}。`
          : "",
      ].filter(Boolean).join(" ");
      return facts.mutationCount > 0
        ? {
            resultKind: "partial",
            resultReason:
              `模型已结束本轮；已保留实际修改，但已批准 WorkPlan 尚未完整闭环。${detail}`,
          }
        : {
            resultKind: "error",
            resultReason:
              `模型已结束本轮，但已批准 WorkPlan 没有形成可验收的实际修改。${detail}`,
          };
    }
    return facts.hasProviderConclusion
      ? {
          resultKind: "success",
          resultReason:
            "已批准 WorkPlan 的全部修改目标和必需验证均由最终修改后的匹配回执覆盖。",
        }
      : null;
  }
  return null;
}
