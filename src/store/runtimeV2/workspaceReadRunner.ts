import { runSubmitRuntimeV2ReadOnly, type RuntimeV2ReadOnlyRunnerInput } from "./readOnlyRunner";
export type RuntimeV2WorkspaceReadRunnerInput = RuntimeV2ReadOnlyRunnerInput;
export function runSubmitRuntimeV2WorkspaceRead(input: RuntimeV2WorkspaceReadRunnerInput) {
  return runSubmitRuntimeV2ReadOnly(input, "analyze");
}
