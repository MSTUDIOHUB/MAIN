import type { ResolvedRunIntent } from "./runIntent";
import type { RuntimeEngineVersion } from "./runtime-v2/contracts";

/**
 * The kernel is selected once at Turn admission and never inferred from
 * provider prose. Every agentic Turn is admitted to Runtime v2. Image Studio
 * is handled by its local renderer before this selector and therefore remains
 * outside the agent runtime.
 */
export function selectRuntimeEngineVersionForNewTurn(
  intent: ResolvedRunIntent | null | undefined,
): RuntimeEngineVersion {
  return intent === "execute" ||
      intent === "plan" ||
      intent === "goal" ||
      isRuntimeV2ChatIntent(intent)
    ? "v2"
    : "legacy";
}

export function isRuntimeV2ChatIntent(
  intent: ResolvedRunIntent | null | undefined,
): boolean {
  return intent === "respond" ||
    intent === "discuss" ||
    intent === "analyze" ||
    intent === "summarize" ||
    intent === "report";
}

/** Chat owns only workspace-free Sessions without external tools or network access.
 * Workspace-bound read-only intents, file attachments, and network-enabled
 * queries use the separate `analyze` strategy and its finite read-only capability surface. */
export function isRuntimeV2GlobalChatTurn(
  intent: ResolvedRunIntent | null | undefined,
  runWorkspace: string | null | undefined,
  options?: { webSearchEnabled?: boolean; hasAttachedFiles?: boolean },
): boolean {
  return isRuntimeV2ChatIntent(intent) &&
    String(runWorkspace || "").trim().length === 0 &&
    options?.webSearchEnabled !== true &&
    options?.hasAttachedFiles !== true;
}

export function isRuntimeV2WorkspaceReadTurn(
  intent: ResolvedRunIntent | null | undefined,
  runWorkspace: string | null | undefined,
  options?: { webSearchEnabled?: boolean; hasAttachedFiles?: boolean },
): boolean {
  return isRuntimeV2ChatIntent(intent) && (
    String(runWorkspace || "").trim().length > 0 ||
    options?.webSearchEnabled === true ||
    options?.hasAttachedFiles === true
  );
}

export type RuntimeV2VisibleRunnerKind =
  | "execute"
  | "plan"
  | "goal"
  | "chat"
  | "workspace_read";

export function resolveRuntimeV2VisibleRunnerKind(input: {
  readonly effectiveIntent: ResolvedRunIntent | null | undefined;
  readonly runtimeIntent: ResolvedRunIntent | null | undefined;
  readonly runWorkspace: string | null | undefined;
  readonly hasAttachedFiles?: boolean;
  readonly webSearchEnabled?: boolean;
}): RuntimeV2VisibleRunnerKind | null {
  // runtimeIntent is the immutable admission authority. effectiveIntent is
  // retained only as diagnostic input; a later UI projection must never
  // redirect the admitted Turn or force it back to another executor.
  if (input.runtimeIntent === "execute") return "execute";
  if (input.runtimeIntent === "plan") return "plan";
  if (input.runtimeIntent === "goal") return "goal";
  if (
    isRuntimeV2ChatIntent(input.runtimeIntent) &&
    String(input.runWorkspace || "").trim().length === 0 &&
    (input.hasAttachedFiles === true || input.webSearchEnabled === true)
  ) {
    return "workspace_read";
  }
  if (isRuntimeV2GlobalChatTurn(input.runtimeIntent, input.runWorkspace, {
    webSearchEnabled: input.webSearchEnabled,
    hasAttachedFiles: input.hasAttachedFiles,
  })) {
    return "chat";
  }
  if (isRuntimeV2WorkspaceReadTurn(input.runtimeIntent, input.runWorkspace, {
    webSearchEnabled: input.webSearchEnabled,
    hasAttachedFiles: input.hasAttachedFiles,
  })) {
    return "workspace_read";
  }
  return null;
}

/** Persisted pre-v2 turns stay readable without a history rewrite. */
export function resolveRuntimeEngineVersion(value: unknown): RuntimeEngineVersion {
  return value === "v2" ? "v2" : "legacy";
}
