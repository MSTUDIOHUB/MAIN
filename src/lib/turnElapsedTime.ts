export interface TurnElapsedRuntimeEvent {
  readonly type: string;
  readonly turnId?: string | null;
  readonly runId?: string | null;
  readonly timestampMs?: number | null;
}

export interface TurnRunTimeWindow {
  readonly runId: string | null;
  readonly startedAt: number;
  readonly completedAt: number;
}

const MIN_EPOCH_MS = 1_000_000_000_000;
const TERMINAL_EVENT_TYPES = new Set([
  "run.completed",
  "run.aborted",
  "turn.completed",
]);

export function resolveTurnRunTimeWindow(input: {
  readonly events: readonly TurnElapsedRuntimeEvent[];
  readonly turnId: string;
}): TurnRunTimeWindow {
  let start: TurnElapsedRuntimeEvent | null = null;
  for (let index = input.events.length - 1; index >= 0; index -= 1) {
    const event = input.events[index]!;
    if (
      event.type === "run.started" &&
      event.turnId === input.turnId &&
      Number(event.timestampMs) >= MIN_EPOCH_MS
    ) {
      start = event;
      break;
    }
  }
  if (!start) return { runId: null, startedAt: 0, completedAt: 0 };

  const startedAt = Number(start.timestampMs);
  const runId = typeof start.runId === "string" && start.runId.trim()
    ? start.runId
    : null;
  let completedAt = 0;
  for (let index = input.events.length - 1; index >= 0; index -= 1) {
    const event = input.events[index]!;
    const timestampMs = Number(event.timestampMs);
    if (
      TERMINAL_EVENT_TYPES.has(event.type) &&
      event.turnId === input.turnId &&
      timestampMs >= startedAt &&
      timestampMs >= MIN_EPOCH_MS &&
      (!runId || !event.runId || event.runId === runId)
    ) {
      completedAt = timestampMs;
      break;
    }
  }
  return { runId, startedAt, completedAt };
}

export function deriveTurnElapsedSeconds(input: {
  readonly window: TurnRunTimeWindow;
  readonly nowMs: number;
  readonly isActive: boolean;
  readonly savedElapsedSeconds?: number;
  readonly sessionElapsedSeconds?: number;
}): number {
  const persisted = Math.max(0, Number(input.savedElapsedSeconds) || 0);
  const liveSession = input.isActive
    ? Math.max(0, Number(input.sessionElapsedSeconds) || 0)
    : 0;
  const boundary = input.window.startedAt > 0
    ? input.isActive
      ? Math.max(input.window.startedAt, input.nowMs)
      : input.window.completedAt || input.window.startedAt
    : 0;
  const eventElapsed = boundary > 0
    ? Math.max(
        0,
        Math.floor((boundary - input.window.startedAt) / 1_000),
      )
    : 0;
  return Math.floor(Math.max(persisted, liveSession, eventElapsed));
}
