import type { RuntimeV2Command } from "../../lib/runtime-v2";
import {
  aggregateForCurrentTurn,
} from "./executionAggregate";
import type { RuntimeV2ExecutionPortsInput } from "./executionTypes";
import {
  runtimeV2ProviderToolCallIdentity,
} from "./providerToolSurface";

export function attemptedRuntimeV2ProviderToolCallIdentities(
  input: RuntimeV2ExecutionPortsInput,
  command: RuntimeV2Command,
): Set<string> {
  const aggregate = aggregateForCurrentTurn(input);
  if (!aggregate) return new Set();
  let phaseBoundary = 0;
  for (let index = aggregate.events.length - 1; index >= 0; index -= 1) {
    const event = aggregate.events[index]!;
    if (
      (event.type === "phase.changed" && event.phase === command.phase) ||
      (event.type === "run.started" && event.phase === command.phase)
    ) {
      phaseBoundary = index + 1;
      break;
    }
  }
  return new Set(aggregate.events
    .slice(phaseBoundary)
    .filter((event) =>
      event.type === "command.scheduled" &&
      event.command.phase === command.phase
    )
    .map((event) => {
      if (event.type !== "command.scheduled") return null;
      const scheduled = event.command;
      const argumentsValue =
        scheduled.payload.arguments &&
          typeof scheduled.payload.arguments === "object" &&
          !Array.isArray(scheduled.payload.arguments)
          ? scheduled.payload.arguments as Record<string, unknown>
          : {};
      const name =
        scheduled.kind === "execute_tool" ||
          scheduled.kind === "execute_validation"
          ? String(scheduled.payload.toolName || "")
          : scheduled.kind === "commit_execution_contract"
            ? "submit_execution_contract"
            : scheduled.kind === "schedule_subagents"
              ? "spawn_subagent"
              : scheduled.kind === "join_subagents"
                ? "wait_subagents"
                : "";
      return name
        ? runtimeV2ProviderToolCallIdentity({
            name,
            arguments: argumentsValue,
          })
        : null;
    })
    .filter((identity): identity is string => !!identity));
}
