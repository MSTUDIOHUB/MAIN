import type { PublicAssistantProgressIdentity, TaskBlock } from "./taskTypes";

export function buildPublicAssistantProgressIdentity(input: {
  kind: PublicAssistantProgressIdentity["kind"];
  sessionKey: string;
  turnId: string;
  displayTurnId: string;
  runId: string;
  parentRunId?: string | null;
  createdAt?: number;
}): PublicAssistantProgressIdentity | undefined {
  const sessionKey = String(input.sessionKey || "").trim();
  const turnId = String(input.turnId || "").trim();
  const displayTurnId = String(input.displayTurnId || "").trim();
  const runId = String(input.runId || "").trim();
  if (!sessionKey || !turnId || !displayTurnId || !runId) return undefined;
  return {
    schemaVersion: 1,
    kind: input.kind,
    source: "model_visible_content",
    sessionKey,
    turnId,
    displayTurnId,
    runId,
    parentRunId: String(input.parentRunId || "").trim() || null,
    createdAt: Math.max(0, Number(input.createdAt) || Date.now()),
  };
}

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
