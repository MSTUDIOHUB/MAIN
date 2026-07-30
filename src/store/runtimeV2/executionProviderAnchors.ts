import type { AgentMessage } from "../../lib/agentMessages";
import type { RuntimeV2LiveExecutionState } from "./executionTypes";

export const RUNTIME_V2_CONTEXT_ANCHOR_PREFIX = "[runtime-v2 context:";

function contextAnchorPrefix(key: string): string {
  const normalized = key.trim().replace(/[\]\r\n]/g, "-").slice(0, 240);
  return `${RUNTIME_V2_CONTEXT_ANCHOR_PREFIX} ${normalized || "context"}]`;
}

/**
 * Durable run context belongs in the same transcript as tool exchanges.
 * Replacing an anchor with the same semantic key keeps one canonical copy
 * without a parallel context store or an extra synthesized digest.
 */
export function upsertRuntimeV2ContextAnchor(
  live: RuntimeV2LiveExecutionState,
  input: {
    readonly key: string;
    readonly content: string;
  },
): void {
  const prefix = contextAnchorPrefix(input.key);
  const content = `${prefix}\n${String(input.content || "").trim()}`.trim();
  const existing = live.messages.findIndex((message) =>
    message.role === "system" &&
    typeof message.content === "string" &&
    message.content.startsWith(prefix)
  );
  const message: AgentMessage = { role: "system", content };
  if (existing >= 0) live.messages.splice(existing, 1);
  live.messages.push(message);
}
