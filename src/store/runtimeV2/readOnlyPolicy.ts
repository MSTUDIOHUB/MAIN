import { normalizeNetworkRead } from "../../lib/networkRead";
import { isRuntimeV2ChatIntent, resolveRuntimeV2VisibleRunnerKind } from "../../lib/runtimeEngineSelection";
import { RUNTIME_V2_KNOWLEDGE_READ_TOOL_NAMES, RUNTIME_V2_WORKSPACE_NETWORK_READ_TOOL_NAMES } from "../../lib/runtime-v2/workspaceReadPolicy";
import type { RuntimeV2ExecutionPortsInput } from "./executionTypes";

export function isReadOnlyContext(input: Pick<RuntimeV2ExecutionPortsInput, "context">): boolean {
  return isRuntimeV2ChatIntent(input.context.runtimeRunIntent);
}

/** The runner resolves this from the admission ledger on restore. */
export function readOnlyNetworkPolicy(input: Pick<RuntimeV2ExecutionPortsInput, "context">) {
  return normalizeNetworkRead(input.context.networkRead);
}

export function isChatContext(input: Pick<RuntimeV2ExecutionPortsInput, "context">): boolean {
  const context = input.context;
  if (context.readOnlyStrategy) return context.readOnlyStrategy === "chat";
  return resolveRuntimeV2VisibleRunnerKind({
    effectiveIntent: context.effectiveRunIntent,
    runtimeIntent: context.runtimeRunIntent,
    runWorkspace: context.runWorkspace,
    hasAttachedFiles: !!(context.turnInputContextSignals?.attachedFilePaths?.length || context.turnInputContextSignals?.mentionedFilePaths?.length),
    requiredCapabilities: context.requiredCapabilities,
  }) === "chat";
}

export function runtimeV2ChatToolNames(input: Pick<RuntimeV2ExecutionPortsInput, "context">): ReadonlySet<string> {
  const names = new Set<string>();
  if (readOnlyNetworkPolicy(input).enabled) {
    for (const name of RUNTIME_V2_WORKSPACE_NETWORK_READ_TOOL_NAMES) names.add(name);
  }
  const knowledge = input.context.knowledgeContext;
  if (knowledge && knowledge.state !== "error" && knowledge.state !== "stale" &&
    knowledge.references.some(reference => reference.kind !== "base" || reference.activationMode !== "workspace_active")) {
    for (const name of RUNTIME_V2_KNOWLEDGE_READ_TOOL_NAMES) names.add(name);
  }
  if (input.context.skillCatalog?.explicitSkillIds.length) names.add("load_skill");
  return names;
}
