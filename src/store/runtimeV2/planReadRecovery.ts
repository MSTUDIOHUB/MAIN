import type { RuntimeV2NormalizedToolCall, RuntimeV2RunIdentity, TurnAggregateV1 } from "../../lib/runtime-v2";
import { RUNTIME_V2_WORKSPACE_NETWORK_READ_TOOL_NAMES } from "../../lib/runtime-v2/workspaceReadPolicy";
import { executeReadOnlyPlanTool } from "./planEvidencePort";
import { runtimeV2ParallelReadCount } from "./executionText";
import { PLAN_READ_ONLY_TOOL_NAMES } from "./planModelProtocol";

interface PendingPlanReadBatch {
  readonly requestKey: string;
  readonly parallelReadCount: number;
  readonly calls: readonly RuntimeV2NormalizedToolCall[];
}

/** Recover the unsettled suffix of an admitted read batch. Its original size
 * still owns the shared read window, including any already settled reads. */
export function recoverPendingPlanReadBatch(
  aggregate: TurnAggregateV1,
  run: RuntimeV2RunIdentity,
): PendingPlanReadBatch | null {
  const pending = aggregate.pendingToolCalls;
  if (!pending.length || pending.some(call => !PLAN_READ_ONLY_TOOL_NAMES.has(call.name) &&
    !RUNTIME_V2_WORKSPACE_NETWORK_READ_TOOL_NAMES.has(call.name))) return null;
  const response = [...aggregate.events].reverse().find(event =>
    event.type === "provider.responded" && event.run.runId === run.runId);
  if (response?.type !== "provider.responded") return null;
  const calls = response.result.toolCalls.filter(call => pending.some(candidate => candidate.id === call.id && candidate.name === call.name));
  return calls.length === pending.length ? {
    requestKey: response.idempotencyKey,
    parallelReadCount: runtimeV2ParallelReadCount(response.result.toolCalls),
    calls,
  } : null;
}

export async function replayPendingPlanReadBatch(
  batch: PendingPlanReadBatch,
  input: Omit<Parameters<typeof executeReadOnlyPlanTool>[0], "call" | "parallelReadCount">,
): Promise<void> {
  for (const call of batch.calls) {
    if (input.context.abortCtrl.signal.aborted) throw new Error("RUNTIME_V2_PLAN_ABORTED");
    await executeReadOnlyPlanTool({ ...input, call, parallelReadCount: batch.parallelReadCount });
  }
  input.logStoreEvent("runtime_v2_plan_read_batch_recovered", {
    turnId: input.run.turnId, runId: input.run.runId, requestKey: batch.requestKey,
    settledCalls: batch.calls.length,
  });
}

