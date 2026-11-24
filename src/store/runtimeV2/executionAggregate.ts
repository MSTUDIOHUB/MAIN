import {
  normalizeRuntimeV2Checkpoint,
  type TurnAggregateV1,
} from "../../lib/runtime-v2";
import { resolveApprovedRuntimeV2WorkPlanFromAggregate } from "./workPlanAdapter";
import type { RuntimeV2ExecutionPortsInput } from "./executionTypes";

export function aggregateForCurrentTurn(
  input: RuntimeV2ExecutionPortsInput,
): TurnAggregateV1 | null {
  const { turnId } = input.context;
  const checkpoint = normalizeRuntimeV2Checkpoint(input.get()?.runtimeV2Checkpoints?.[turnId], { turnId });
  return checkpoint?.aggregate || null;
}

export function approvedPlanForCurrentTurn(
  input: RuntimeV2ExecutionPortsInput,
) {
  return resolveApprovedRuntimeV2WorkPlanFromAggregate(
    aggregateForCurrentTurn(input),
  );
}
