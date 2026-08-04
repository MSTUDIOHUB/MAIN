import type { RuntimeV2ExecutionPortsInput } from "./executionContext";
import type {
  runtimeV2ModelSelectedSubagentCandidate,
} from "./executionSubagentCandidate";
import {
  normalizedRuntimeV2SubagentPath,
} from "./executionSubagentWriteScope";
export function parentHasImplementationSourceAuthority(input: {
  readonly ports: RuntimeV2ExecutionPortsInput;
  readonly candidate: ReturnType<typeof runtimeV2ModelSelectedSubagentCandidate>;
}): boolean {
  if (
    input.candidate.taskKind !== "implement" ||
    input.candidate.accessMode !== "write" ||
    input.candidate.implementationOperation === "create"
  ) {
    return true;
  }
  const sources = input.ports.live.latestProviderRequestSourceCoverage;
  return input.candidate.allowedPaths.every((path) =>
    sources.some((coverage) =>
      !!coverage.version &&
      normalizedRuntimeV2SubagentPath(coverage.target) ===
        normalizedRuntimeV2SubagentPath(path) &&
      (
        input.candidate.implementationOperation !== "delete" ||
        coverage.complete
      )
    )
  );
}
