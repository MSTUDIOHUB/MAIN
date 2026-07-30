import type { ToolLifecycleState } from "./runtimeTools";
import type { SubagentActivity, SubagentRunPatch, SubagentRunSnapshot } from "./subagents";
import type { ActionRequestKind } from "./actionRequest";
import type { VisualContextDeliveryState } from "./visualContext";

export const MAIN_THREAD_EVENT_SCHEMA_VERSION = 2 as const;

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export type EventStreamMode = "legacy" | "dual" | "events_only";
export type ToolFeedbackFormat = "legacy" | "envelope_v1";
export type TerminalResultKind = "success" | "partial" | "blocked" | "error" | "canceled";

export interface MainThreadUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}

export interface MainThreadError {
  message: string;
}

/** Persisted pre-v2 compatibility only. These events never enter live state. */
export type LegacyFailedMainThreadEvent =
  | { schemaVersion?: number; type: "turn.failed"; threadId: string; turnId: string; timestampMs: number; error: MainThreadError }
  | ({ schemaVersion?: number; type: "run.failed"; threadId: string; turnId: string; timestampMs: number; error: MainThreadError } & MainThreadRunIdentity);

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
  /** Exact visual-input delivery state; delivery is not recognition evidence. */
  visualContext?: VisualContextDeliveryState;
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
  const visualContext = progress.visualContext && typeof progress.visualContext === "object"
    ? {
        status: progress.visualContext.status,
        expectedImageParts: Math.max(0, Math.floor(Number(progress.visualContext.expectedImageParts) || 0)),
        deliveredImageParts: Math.max(0, Math.floor(Number(progress.visualContext.deliveredImageParts) || 0)),
        omittedImageParts: Math.max(0, Math.floor(Number(progress.visualContext.omittedImageParts) || 0)),
        ...(progress.visualContext.recognition === "pending" ||
        progress.visualContext.recognition === "observed" ||
        progress.visualContext.recognition === "unverified"
          ? { recognition: progress.visualContext.recognition }
          : {}),
        ...(progress.visualContext.observationSummary
          ? { observationSummary: String(progress.visualContext.observationSummary).trim().slice(0, 360) }
          : {}),
        ...(progress.visualContext.observationId
          ? { observationId: String(progress.visualContext.observationId).trim().slice(0, 96) }
          : {}),
      }
    : undefined;

  return {
    ...progress,
    ...(tool ? { tool } : {}),
    ...(canonicalTarget ? { target: canonicalTarget, canonicalTarget } : {}),
    sourceToolCallIds,
    ...(visualContext ? { visualContext } : {}),
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
  | { schemaVersion: typeof MAIN_THREAD_EVENT_SCHEMA_VERSION; type: "turn.completed"; threadId: string; turnId: string; timestampMs: number; usage?: MainThreadUsage; resultKind?: TerminalResultKind }
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
  | { schemaVersion: typeof MAIN_THREAD_EVENT_SCHEMA_VERSION; type: "subagent.created"; threadId: string; turnId: string; timestampMs: number; collaborationTaskId?: string; subagentId?: string; runId?: string; parentRunId?: string | null; subagent: SubagentRunSnapshot }
  | { schemaVersion: typeof MAIN_THREAD_EVENT_SCHEMA_VERSION; type: "subagent.updated"; threadId: string; turnId: string; timestampMs: number; collaborationTaskId?: string; subagentId: string; runId?: string; parentRunId?: string | null; patch: SubagentRunPatch; activity?: SubagentActivity }
  | { schemaVersion: typeof MAIN_THREAD_EVENT_SCHEMA_VERSION; type: "subagent.completed"; threadId: string; turnId: string; timestampMs: number; collaborationTaskId?: string; subagentId: string; runId?: string; parentRunId?: string | null; completedAt: number; status: import("./subagents").SubagentStatus }
  | { schemaVersion: typeof MAIN_THREAD_EVENT_SCHEMA_VERSION; type: "subagent.handoff_delivered"; threadId: string; turnId: string; timestampMs: number; collaborationTaskId?: string; subagentId: string; runId?: string; parentRunId?: string | null; receiptId: string; evidenceIds: string[] }
  | { schemaVersion: typeof MAIN_THREAD_EVENT_SCHEMA_VERSION; type: "subagent.handoff_applied"; threadId: string; turnId: string; timestampMs: number; collaborationTaskId?: string; subagentId: string; runId?: string; parentRunId?: string | null; receiptId: string; sourceEventId: string; evidenceIds: string[] }
  | { schemaVersion: typeof MAIN_THREAD_EVENT_SCHEMA_VERSION; type: "subagent.closed"; threadId: string; turnId: string; timestampMs: number; collaborationTaskId?: string; subagentId: string; runId?: string; parentRunId?: string | null; closedAt: number; reason?: string }
  | { schemaVersion: typeof MAIN_THREAD_EVENT_SCHEMA_VERSION; type: "subagent.dismissed"; threadId: string; turnId: string; timestampMs: number; subagentId: string }
  | { schemaVersion: typeof MAIN_THREAD_EVENT_SCHEMA_VERSION; type: "subagent.handed_back"; threadId: string; turnId: string; timestampMs: number; collaborationTaskId?: string; subagentId: string; runId?: string; parentRunId?: string | null; reason: string; evidenceCount: number; remainingWork?: string }
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
  | ({ schemaVersion: typeof MAIN_THREAD_EVENT_SCHEMA_VERSION; type: "run.completed"; threadId: string; turnId: string; timestampMs: number; summary?: string; resultKind?: TerminalResultKind } & MainThreadRunIdentity)
  | ({ schemaVersion: typeof MAIN_THREAD_EVENT_SCHEMA_VERSION; type: "run.aborted"; threadId: string; turnId: string; timestampMs: number; reason: string; message?: string } & MainThreadRunIdentity)
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
  const eventType = String((event as { type?: unknown }).type || "");
  if (eventType === "turn.failed" || eventType === "run.failed") {
    throw new Error(`${eventType} is a legacy persisted event; normalize it at the read boundary`);
  }
  const normalizedEvent = event.type === "progress.updated"
    ? {
        ...event,
        progress: normalizeMainThreadProgressUpdate(event.progress as MainThreadProgressUpdateInput),
      }
    : event;
  return {
    ...normalizedEvent,
    // Persisted inputs can still carry a legacy schemaVersion at runtime even
    // though MainThreadEventInput omits it statically. Write the live version
    // last so a v1 payload cannot leak back into the v2 event stream.
    schemaVersion: MAIN_THREAD_EVENT_SCHEMA_VERSION,
  } as MainThreadEvent;
}

/**
 * Convert persisted legacy failure events into the sole application
 * conclusion shape. Callers should perform their ordinary persisted-event
 * validation before invoking this boundary helper.
 */
export function normalizePersistedMainThreadEvent(
  event: MainThreadEventInput | LegacyFailedMainThreadEvent,
): MainThreadEvent {
  if (event.type === "turn.failed") {
    return withEventSchema({
      type: "turn.completed",
      threadId: event.threadId,
      turnId: event.turnId,
      timestampMs: event.timestampMs,
      resultKind: "error",
    });
  }
  if (event.type === "run.failed") {
    return withEventSchema({
      type: "run.completed",
      threadId: event.threadId,
      turnId: event.turnId,
      timestampMs: event.timestampMs,
      runId: event.runId,
      parentRunId: event.parentRunId,
      ...(event.goalSliceId ? { goalSliceId: event.goalSliceId } : {}),
      resultKind: "error",
      summary: String(event.error?.message || "Persisted run error").trim() || "Persisted run error",
    });
  }
  return withEventSchema(event);
}

export function appendRuntimeEvent(
  events: MainThreadEvent[] | null | undefined,
  event: MainThreadEvent,
  maxEvents = 800,
): MainThreadEvent[] {
  return appendRuntimeEventWithResult(events, event, maxEvents).events;
}

export type AppendRuntimeEventDisposition = "committed" | "idempotent" | "conflict";

export interface AppendRuntimeEventResult {
  events: MainThreadEvent[];
  disposition: AppendRuntimeEventDisposition;
  existingEvent?: MainThreadEvent;
}

function completedResultKind(
  event: Extract<MainThreadEvent, { type: "run.completed" | "turn.completed" }>,
): TerminalResultKind {
  return event.resultKind || "success";
}

function hasSameLifecycleMeaning(existing: MainThreadEvent, incoming: MainThreadEvent): boolean {
  if (existing.type !== incoming.type) return false;
  if (existing.type === "run.completed" && incoming.type === "run.completed") {
    return completedResultKind(existing) === completedResultKind(incoming);
  }
  if (existing.type === "turn.completed" && incoming.type === "turn.completed") {
    return completedResultKind(existing) === completedResultKind(incoming);
  }
  if (existing.type === "run.paused" && incoming.type === "run.paused") {
    return existing.reason === incoming.reason;
  }
  if (existing.type === "run.aborted" && incoming.type === "run.aborted") {
    return existing.reason === incoming.reason;
  }
  return false;
}

/**
 * Append an event and expose whether a terminal transition was accepted,
 * replayed, or rejected. Reducers must not apply side effects from a
 * conflicting terminal candidate.
 */
export function appendRuntimeEventWithResult(
  events: MainThreadEvent[] | null | undefined,
  event: MainThreadEvent,
  maxEvents = 800,
): AppendRuntimeEventResult {
  const existing = events || [];
  if (
    event.type === "thread.started" &&
    existing.some((candidate) => candidate.type === "thread.started" && candidate.threadId === event.threadId)
  ) {
    return {
      events: existing,
      disposition: "idempotent",
      existingEvent: existing.find((candidate) =>
        candidate.type === "thread.started" && candidate.threadId === event.threadId
      ),
    };
  }
  if (event.type === "run.started") {
    const existingStart = existing.find((candidate) =>
      candidate.type === "run.started" &&
      candidate.threadId === event.threadId &&
      candidate.turnId === event.turnId &&
      candidate.runId === event.runId
    );
    if (existingStart?.type === "run.started") {
      return {
        events: existing,
        disposition: existingStart.parentRunId === event.parentRunId
          ? "idempotent"
          : "conflict",
        existingEvent: existingStart,
      };
    }
  }
  if (isRunBoundaryEvent(event)) {
    const existingConclusion = existing.find((candidate) =>
      isRunTerminalEvent(candidate) &&
      candidate.threadId === event.threadId &&
      candidate.turnId === event.turnId &&
      candidate.runId === event.runId
    );
    if (existingConclusion) {
      return {
        events: existing,
        disposition: "conflict",
        existingEvent: existingConclusion,
      };
    }
    const existingBoundary = existing.find((candidate) =>
      isRunBoundaryEvent(candidate) &&
      candidate.type === event.type &&
      candidate.threadId === event.threadId &&
      candidate.turnId === event.turnId &&
      candidate.runId === event.runId
    );
    if (existingBoundary) {
      return {
        events: existing,
        disposition: hasSameLifecycleMeaning(existingBoundary, event) ? "idempotent" : "conflict",
        existingEvent: existingBoundary,
      };
    }
  }
  if (isRunTerminalEvent(event)) {
    const existingTerminal = existing.find((candidate) =>
      isRunTerminalEvent(candidate) &&
      candidate.threadId === event.threadId &&
      candidate.turnId === event.turnId &&
      candidate.runId === event.runId
    );
    if (existingTerminal) {
      return {
        events: existing,
        disposition: hasSameLifecycleMeaning(existingTerminal, event) ? "idempotent" : "conflict",
        existingEvent: existingTerminal,
      };
    }
  }
  if (isTerminalTurnEvent(event)) {
    const existingTerminal = existing.find((candidate) =>
      isTerminalTurnEvent(candidate) &&
      candidate.threadId === event.threadId &&
      candidate.turnId === event.turnId
    );
    if (existingTerminal) {
      return {
        events: existing,
        disposition: hasSameLifecycleMeaning(existingTerminal, event) ? "idempotent" : "conflict",
        existingEvent: existingTerminal,
      };
    }
  }
  const next = [...existing, event];
  if (next.length <= maxEvents) return { events: next, disposition: "committed" };
  const firstThreadStarted = next.find((candidate) => candidate.type === "thread.started");
  if (!firstThreadStarted || maxEvents <= 1) {
    return { events: next.slice(next.length - maxEvents), disposition: "committed" };
  }
  const tail = next
    .filter((candidate) => candidate !== firstThreadStarted)
    .slice(-(maxEvents - 1));
  return { events: [firstThreadStarted, ...tail], disposition: "committed" };
}

export function isRunTerminalEvent(
  event: MainThreadEvent,
): event is Extract<MainThreadEvent, { type: "run.completed" }> {
  return event.type === "run.completed";
}

/** A pause or abort is an observable boundary, never the Run conclusion. */
export function isRunBoundaryEvent(
  event: MainThreadEvent,
): event is Extract<MainThreadEvent, { type: "run.paused" | "run.aborted" }> {
  return event.type === "run.paused" || event.type === "run.aborted";
}

export function isTerminalTurnEvent(
  event: MainThreadEvent,
): event is Extract<MainThreadEvent, { type: "turn.completed" }> {
  return event.type === "turn.completed";
}
