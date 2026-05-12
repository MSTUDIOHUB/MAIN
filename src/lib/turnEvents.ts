import type { ToolLifecycleState } from "./runtimeTools";

export const MAIN_THREAD_EVENT_SCHEMA_VERSION = 1 as const;

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export type EventStreamMode = "legacy" | "dual" | "events_only";
export type ToolFeedbackFormat = "legacy" | "envelope_v1";

export interface MainThreadUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}

export interface MainThreadError {
  message: string;
}

export interface MainThreadItem {
  id: string;
  details: MainThreadItemDetails;
}

export type MainThreadItemDetails =
  | { type: "agent_message"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool_call"; toolCallId: string; tool: string; target: string; status: ToolLifecycleState }
  | { type: "tool_result"; toolCallId: string; tool: string; target: string; status: ToolLifecycleState; text: string }
  | { type: "tool_lifecycle"; toolCallId: string; tool: string; target: string; status: ToolLifecycleState; reason?: string }
  | { type: "command_execution"; command: string; status: ToolLifecycleState; output?: string; exitCode?: number | null }
  | { type: "file_change"; path: string; kind: "add" | "delete" | "update"; status: ToolLifecycleState }
  | { type: "context_compaction"; reason: "proactive" | "reactive"; tokenReduction: number; beforeTokens: number; afterTokens: number }
  | { type: "todo_list"; items: Array<{ text: string; completed: boolean }> }
  | { type: "error"; message: string };

export type MainThreadEvent =
  | { schemaVersion: typeof MAIN_THREAD_EVENT_SCHEMA_VERSION; type: "thread.started"; threadId: string; timestampMs: number }
  | { schemaVersion: typeof MAIN_THREAD_EVENT_SCHEMA_VERSION; type: "turn.started"; threadId: string; turnId: string; timestampMs: number }
  | { schemaVersion: typeof MAIN_THREAD_EVENT_SCHEMA_VERSION; type: "turn.completed"; threadId: string; turnId: string; timestampMs: number; usage?: MainThreadUsage }
  | { schemaVersion: typeof MAIN_THREAD_EVENT_SCHEMA_VERSION; type: "turn.failed"; threadId: string; turnId: string; timestampMs: number; error: MainThreadError }
  | { schemaVersion: typeof MAIN_THREAD_EVENT_SCHEMA_VERSION; type: "slash.command.started"; threadId: string; turnId?: string; timestampMs: number; command: string; executionMode: "local_fast" | "model_workflow" }
  | { schemaVersion: typeof MAIN_THREAD_EVENT_SCHEMA_VERSION; type: "slash.command.completed"; threadId: string; turnId?: string; timestampMs: number; command: string; executionMode: "local_fast" | "model_workflow" }
  | { schemaVersion: typeof MAIN_THREAD_EVENT_SCHEMA_VERSION; type: "slash.command.failed"; threadId: string; turnId?: string; timestampMs: number; command: string; executionMode: "local_fast" | "model_workflow"; error: MainThreadError }
  | { schemaVersion: typeof MAIN_THREAD_EVENT_SCHEMA_VERSION; type: "path_alias_hit"; threadId: string; turnId: string; timestampMs: number; tool: string; field: string; from: string; to: string; rule: string }
  | { schemaVersion: typeof MAIN_THREAD_EVENT_SCHEMA_VERSION; type: "plan_state_hydrated"; threadId: string; turnId?: string; timestampMs: number; reason: string; taskCount: number; artifactPaths: string[] }
  | { schemaVersion: typeof MAIN_THREAD_EVENT_SCHEMA_VERSION; type: "item.started"; threadId: string; turnId: string; timestampMs: number; item: MainThreadItem }
  | { schemaVersion: typeof MAIN_THREAD_EVENT_SCHEMA_VERSION; type: "item.updated"; threadId: string; turnId: string; timestampMs: number; item: MainThreadItem }
  | { schemaVersion: typeof MAIN_THREAD_EVENT_SCHEMA_VERSION; type: "item.completed"; threadId: string; turnId: string; timestampMs: number; item: MainThreadItem }
  | { schemaVersion: typeof MAIN_THREAD_EVENT_SCHEMA_VERSION; type: "error"; threadId: string; turnId?: string; timestampMs: number; error: MainThreadError };

export type MainThreadEventInput = DistributiveOmit<MainThreadEvent, "schemaVersion">;

export function normalizeEventStreamMode(value: unknown, fallback: EventStreamMode = "dual"): EventStreamMode {
  return value === "legacy" || value === "events_only" || value === "dual"
    ? value
    : fallback;
}

export function normalizeToolFeedbackFormat(value: unknown, fallback: ToolFeedbackFormat = "envelope_v1"): ToolFeedbackFormat {
  return value === "legacy" || value === "envelope_v1"
    ? value
    : fallback;
}

export function withEventSchema<T extends MainThreadEventInput>(event: T): MainThreadEvent {
  return {
    schemaVersion: MAIN_THREAD_EVENT_SCHEMA_VERSION,
    ...event,
  } as MainThreadEvent;
}

export function appendRuntimeEvent(
  events: MainThreadEvent[] | null | undefined,
  event: MainThreadEvent,
  maxEvents = 800,
): MainThreadEvent[] {
  const next = [...(events || []), event];
  if (next.length <= maxEvents) return next;
  return next.slice(next.length - maxEvents);
}

export function isTerminalTurnEvent(event: MainThreadEvent): boolean {
  return event.type === "turn.completed" || event.type === "turn.failed";
}
