import { isRuntimeV2GlobalChatTurn } from "../../lib/runtimeEngineSelection";
import { runSubmitRuntimeV2ReadOnly, type RuntimeV2ReadOnlyRunnerInput } from "./readOnlyRunner";
export { buildRuntimeV2ReadOnlyIdentities as buildRuntimeV2ChatIdentities } from "./readOnlyRunner";
export type RuntimeV2ChatRunnerInput = RuntimeV2ReadOnlyRunnerInput;

/** Chat has its own capability policy and uses the shared provider/tool adapters. */
export function runSubmitRuntimeV2Chat(input: RuntimeV2ChatRunnerInput) {
  if (!isRuntimeV2GlobalChatTurn(input.context.runtimeRunIntent, input.context.runWorkspace, {
    hasAttachedFiles: !!input.context.turnInputContextSignals?.attachedFilePaths?.length,
  })) throw new Error("RUNTIME_V2_CHAT_REJECTS_WORKSPACE_SESSION");
  return runSubmitRuntimeV2ReadOnly(input, "chat");
}
