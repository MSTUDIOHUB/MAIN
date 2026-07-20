import type { TaskBlock } from "./taskTypes";

/**
 * Public Capsule commentary is a live-run capability, not durable final-text
 * provenance. Once an assistant block crosses a terminal visibility boundary,
 * remove that capability so later demotion cannot revive old final text as
 * current model progress.
 */
export function stripAssistantPublicProgress<T extends TaskBlock>(block: T): T {
  if (block.type !== "agent") return block;
  const stripped = { ...block } as Extract<TaskBlock, { type: "agent" }>;
  if (stripped.publicProgress === undefined) return block;
  delete stripped.publicProgress;
  return stripped as T;
}
