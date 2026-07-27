import {
  normalizeRuntimeV2CheckpointMap,
  type TurnAggregateV1,
} from "../../lib/runtime-v2";
import { resolveApprovedRuntimeV2WorkPlanFromAggregate } from "./workPlanAdapter";
import type { RuntimeV2ExecutionPortsInput } from "./executionTypes";

export function aggregateForCurrentTurn(
  input: RuntimeV2ExecutionPortsInput,
): TurnAggregateV1 | null {
  const checkpoint = normalizeRuntimeV2CheckpointMap(
    input.get()?.runtimeV2Checkpoints,
  )[input.context.turnId];
  return checkpoint?.aggregate || null;
}

export function approvedPlanForCurrentTurn(
  input: RuntimeV2ExecutionPortsInput,
) {
  return resolveApprovedRuntimeV2WorkPlanFromAggregate(
    aggregateForCurrentTurn(input),
  );
}
