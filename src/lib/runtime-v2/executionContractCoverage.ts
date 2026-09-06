import type { TurnAggregateV1 } from "./aggregate";
import type { RuntimeV2Event } from "./events";
import { deriveRuntimeV2ExecutionContract, runtimeV2ExecutionContractMutationTargets, scheduledCommandsByKey } from "./executionContract";
import { workspacePathsReferToSameFile } from "../workspacePaths";
import { analyzeValidationCommand } from "../validationContract";

/** Uses only already-admitted, passing validators at the current mutation
 * boundary. Declared checks are obligations, not optional report decoration. */
export function deriveRuntimeV2ExecutionContractCoverage(
  state: TurnAggregateV1,
  currentPasses: readonly Extract<RuntimeV2Event, { type: "validation.completed" }>[],
) {
  const contract = deriveRuntimeV2ExecutionContract(state);
  if (!contract) return { complete: true, pendingTargets: [], missingValidationIndexes: [] };
  const commands = scheduledCommandsByKey(state);
  const mutations = state.events.flatMap((event) => event.type === "tool.completed" && event.status === "succeeded" && event.sequence > contract.recordedAtSequence
    ? event.evidence.filter((item) => item.kind === "mutation") : []);
  const pendingTargets = runtimeV2ExecutionContractMutationTargets(contract).filter((target) =>
    !mutations.some((item) => workspacePathsReferToSameFile(item.target, target)));
  const missingValidationIndexes = contract.validations.flatMap((check, index) => {
    const latest = [...state.events].reverse().find((event) => {
      if (event.type !== "validation.completed") return false;
      if (event.sequence <= contract.recordedAtSequence) return false;
      const request = commands.get(event.idempotencyKey);
      const args = request?.payload.arguments as Record<string, unknown> | undefined;
      const name = request?.payload.toolName;
      if (check.kind === "finite_command") return name === "run_command" && String(args?.command || "").trim() === check.command?.trim();
      if (check.kind === "browser") return name === "browser_evaluate";
      if (check.kind === "desktop") return name === "computer_use";
      const analysis = analyzeValidationCommand(String(args?.command || ""));
      return name === "run_command" && analysis.spec?.kind === "finite_command" && analysis.spec.capability === "inline_assertion";
    });
    // A later failure of this exact obligation invalidates its earlier pass,
    // even if an unrelated validator subsequently succeeds.
    const covered = latest?.type === "validation.completed" && currentPasses.some((event) => event.sequence === latest.sequence);
    return covered ? [] : [index];
  });
  return { complete: !pendingTargets.length && !missingValidationIndexes.length, pendingTargets, missingValidationIndexes };
}
