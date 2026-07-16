import type { ToolLifecycleState } from "./runtimeTools";
import type { SubagentActivity, SubagentRunPatch, SubagentRunSnapshot } from "./subagents";
import type { ActionRequestKind } from "./actionRequest";

export const MAIN_THREAD_EVENT_SCHEMA_VERSION = 2 as const;

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

export interface MainThreadHarnessTelemetry {
  name: string;
  details: Record<string, unknown>;
}

export interface MainThreadRunIdentity {
  runId: string;
  parentRunId: string | null;
  goalSliceId?: string;
}

export interface MainThreadProgressUpdate {
  phase: "understanding" | "investigating" | "editing" | "verifying" | "blocked" | "summarizing" | string;
  title: string;
  status: "running" | "done" | "failed" | "paused" | "completed" | string;
  summary?: string;
  action?: string;
  evidence?: string;
  next?: string;
  /** Canonical structured target used by runtime projections and deduplication. */
  canonicalTarget?: string;
  /** Legacy target alias retained for persisted pre-v2 progress events. */
  target?: string;
  tool?: string;
  /** Tool calls that produced this progress snapshot. */
  sourceToolCallIds?: string[];
  dedupeKey?: string;
  repeatCount?: number;
  iteration?: number;
  /** Internal diagnostics are persisted/logged but never projected as user work. */
  audience?: "user" | "internal";
}

type MainThreadProgressUpdateInput = MainThreadProgressUpdate & {
  targets?: unknown;
  toolName?: unknown;
};

function normalizeProgressTarget(value: unknown): string {
  const normalized = String(value || "").trim().replace(/\\/g, "/");
  if (!normalized) return "";
  const scheme = normalized.match(/^([a-z][a-z0-9+.-]*:\/\/)(.*)$/i);
  if (scheme) {
    const suffix = scheme[2].replace(/\/{2,}/g, "/").replace(/\/$/, "");
    return `${scheme[1]}${suffix}`;
  }
  return normalized.replace(/\/{2,}/g, "/").replace(/\/$/, "");
}

/**
 * Normalize progress at the event boundary so UI projections never have to
 * infer tool identity or targets from localized presentation text.
 */
export function normalizeMainThreadProgressUpdate(
  progress: MainThreadProgressUpdateInput,
): MainThreadProgressUpdate {
  const legacyTargets = Array.isArray(progress.targets) ? progress.targets : [];
  const canonicalTarget = normalizeProgressTarget(
    progress.canonicalTarget || progress.target || legacyTargets[0] || "",
  );
  const tool = String(progress.tool || progress.toolName || "").trim();
  const sourceToolCallIds = Array.from(new Set(
    (Array.isArray(progress.sourceToolCallIds) ? progress.sourceToolCallIds : [])
      .map((id) => String(id || "").trim())
      .filter(Boolean),
  )).slice(0, 12);

  return {
    ...progress,
    ...(tool ? { tool } : {}),
    ...(canonicalTarget ? { target: canonicalTarget, canonicalTarget } : {}),
    sourceToolCallIds,
  };
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
  | ({ schemaVersion: typeof MAIN_THREAD_EVENT_SCHEMA_VERSION; type: "harness.telemetry"; threadId: string; turnId?: string; timestampMs: number; telemetry: MainThreadHarnessTelemetry } & Partial<MainThreadRunIdentity>)
  // Progress belongs to a concrete run whenever the emitter can identify one.
  // Keep the identity optional so persisted pre-v2 events remain readable.
  | ({ schemaVersion: typeof MAIN_THREAD_EVENT_SCHEMA_VERSION; type: "progress.updated"; threadId: string; turnId: string; timestampMs: number; progress: MainThreadProgressUpdate } & Partial<MainThreadRunIdentity>)
  | { schemaVersion: typeof MAIN_THREAD_EVENT_SCHEMA_VERSION; type: "plan.ready"; threadId: string; turnId: string; timestampMs: number; path?: string; summary?: string }
  | { schemaVersion: typeof MAIN_THREAD_EVENT_SCHEMA_VERSION; type: "goal.started"; threadId: string; turnId?: string; timestampMs: number; goalId: string; revision: number }
  | { schemaVersion: typeof MAIN_THREAD_EVENT_SCHEMA_VERSION; type: "goal.state_changed"; threadId: string; turnId?: string; timestampMs: number; goalId: string; from: string; to: string; phase?: string | null; reason?: string }
  | { schemaVersion: typeof MAIN_THREAD_EVENT_SCHEMA_VERSION; type: "goal.checkpoint_saved"; threadId: string; turnId?: string; timestampMs: number; goalId: string; checkpointId: string; iteration: number }
  | { schemaVersion: typeof MAIN_THREAD_EVENT_SCHEMA_VERSION; type: "goal.completed"; threadId: string; turnId?: string; timestampMs: number; goalId: string; evidenceCount: number }
  | { schemaVersion: typeof MAIN_THREAD_EVENT_SCHEMA_VERSION; type: "goal.cleared"; threadId: string; turnId?: string; timestampMs: number; goalId: string; previousStatus: string }
  | { schemaVersion: typeof MAIN_THREAD_EVENT_SCHEMA_VERSION; type: "subagent.created"; threadId: string; turnId: string; timestampMs: number; subagent: SubagentRunSnapshot }
  | { schemaVersion: typeof MAIN_THREAD_EVENT_SCHEMA_VERSION; type: "subagent.updated"; threadId: string; turnId: string; timestampMs: number; subagentId: string; patch: SubagentRunPatch; activity?: SubagentActivity }
  | { schemaVersion: typeof MAIN_THREAD_EVENT_SCHEMA_VERSION; type: "subagent.closed"; threadId: string; turnId: string; timestampMs: number; subagentId: string; closedAt: number; reason?: string }
  | { schemaVersion: typeof MAIN_THREAD_EVENT_SCHEMA_VERSION; type: "subagent.dismissed"; threadId: string; turnId: string; timestampMs: number; subagentId: string }
  | { schemaVersion: typeof MAIN_THREAD_EVENT_SCHEMA_VERSION; type: "subagent.handed_back"; threadId: string; turnId: string; timestampMs: number; subagentId: string; reason: string; evidenceCount: number; remainingWork?: string }
  | { schemaVersion: typeof MAIN_THREAD_EVENT_SCHEMA_VERSION; type: "model_lane.pressure"; threadId: string; turnId: string; timestampMs: number; laneKey: string; availableBytes: number; reserveBytes: number; action: "sample" | "hold" | "degrade" }
  | ({
      schemaVersion: typeof MAIN_THREAD_EVENT_SCHEMA_VERSION;
      type: "approval.requested";
      threadId: string;
      turnId: string;
      timestampMs: number;
      requestId: string;
      actionKind: ActionRequestKind;
      title: string;
      reason: string;
      target?: string;
    } & MainThreadRunIdentity)
  | ({ schemaVersion: typeof MAIN_THREAD_EVENT_SCHEMA_VERSION; type: "run.started"; threadId: string; turnId: string; timestampMs: number } & MainThreadRunIdentity)
  | ({ schemaVersion: typeof MAIN_THREAD_EVENT_SCHEMA_VERSION; type: "run.paused"; threadId: string; turnId: string; timestampMs: number; reason: string; message: string; progress?: MainThreadProgressUpdate } & MainThreadRunIdentity)
  | ({ schemaVersion: typeof MAIN_THREAD_EVENT_SCHEMA_VERSION; type: "run.completed"; threadId: string; turnId: string; timestampMs: number; summary?: string } & MainThreadRunIdentity)
  | ({ schemaVersion: typeof MAIN_THREAD_EVENT_SCHEMA_VERSION; type: "run.failed"; threadId: string; turnId: string; timestampMs: number; error: MainThreadError } & MainThreadRunIdentity)
  | { schemaVersion: typeof MAIN_THREAD_EVENT_SCHEMA_VERSION; type: "item.started"; threadId: string; turnId: string; timestampMs: number; item: MainThreadItem }
  | { schemaVersion: typeof MAIN_THREAD_EVENT_SCHEMA_VERSION; type: "item.updated"; threadId: string; turnId: string; timestampMs: number; item: MainThreadItem }
  | { schemaVersion: typeof MAIN_THREAD_EVENT_SCHEMA_VERSION; type: "item.completed"; threadId: string; turnId: string; timestampMs: number; item: MainThreadItem }
  | { schemaVersion: typeof MAIN_THREAD_EVENT_SCHEMA_VERSION; type: "error"; threadId: string; turnId?: string; timestampMs: number; error: MainThreadError };

/** Versioned event envelope used by session, turn, run, and action projections. */
export type TurnEventV2 = MainThreadEvent;

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
  const normalizedEvent = event.type === "progress.updated"
    ? {
        ...event,
        progress: normalizeMainThreadProgressUpdate(event.progress as MainThreadProgressUpdateInput),
      }
    : event;
  return {
    schemaVersion: MAIN_THREAD_EVENT_SCHEMA_VERSION,
    ...normalizedEvent,
  } as MainThreadEvent;
}

export function appendRuntimeEvent(
  events: MainThreadEvent[] | null | undefined,
  event: MainThreadEvent,
  maxEvents = 800,
): MainThreadEvent[] {
  const existing = events || [];
  if (
    event.type === "thread.started" &&
    existing.some((candidate) => candidate.type === "thread.started" && candidate.threadId === event.threadId)
  ) {
    return existing;
  }
  if (
    (event.type === "run.paused" || event.type === "run.completed" || event.type === "run.failed") &&
    existing.some((candidate) =>
      (candidate.type === "run.paused" || candidate.type === "run.completed" || candidate.type === "run.failed") &&
      candidate.threadId === event.threadId &&
      candidate.turnId === event.turnId &&
      candidate.runId === event.runId
    )
  ) {
    return existing;
  }
  if (
    isTerminalTurnEvent(event) &&
    existing.some((candidate) =>
      isTerminalTurnEvent(candidate) &&
      candidate.threadId === event.threadId &&
      candidate.turnId === event.turnId
    )
  ) {
    return existing;
  }
  const next = [...existing, event];
  if (next.length <= maxEvents) return next;
  const firstThreadStarted = next.find((candidate) => candidate.type === "thread.started");
  if (!firstThreadStarted || maxEvents <= 1) return next.slice(next.length - maxEvents);
  const tail = next
    .filter((candidate) => candidate !== firstThreadStarted)
    .slice(-(maxEvents - 1));
  return [firstThreadStarted, ...tail];
}

export function isTerminalTurnEvent(
  event: MainThreadEvent,
): event is Extract<MainThreadEvent, { type: "turn.completed" | "turn.failed" }> {
  return event.type === "turn.completed" || event.type === "turn.failed";
}
