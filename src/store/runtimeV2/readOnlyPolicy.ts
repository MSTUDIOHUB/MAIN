import { normalizeNetworkRead } from "../../lib/networkRead";
import { isRuntimeV2ChatIntent, isRuntimeV2GlobalChatTurn } from "../../lib/runtimeEngineSelection";
import type { RuntimeV2ExecutionPortsInput } from "./executionTypes";

export function isReadOnlyContext(input: Pick<RuntimeV2ExecutionPortsInput, "context">): boolean {
  return isRuntimeV2ChatIntent(input.context.runtimeRunIntent);
}

/** The runner resolves this from the admission ledger on restore. */
export function readOnlyNetworkPolicy(input: Pick<RuntimeV2ExecutionPortsInput, "context">) {
  return normalizeNetworkRead(input.context.networkRead);
}

export function isChatContext(input: Pick<RuntimeV2ExecutionPortsInput, "context">): boolean {
  return isRuntimeV2GlobalChatTurn(input.context?.runtimeRunIntent, input.context?.runWorkspace, {
    hasAttachedFiles: !!input.context?.turnInputContextSignals?.attachedFilePaths?.length,
  });
}
