import type { RuntimeV2RunIdentity } from "./runtime-v2/contracts";

export type CapsuleModelStage = "preparing" | "acquiring_lane" | "waiting" | "receiving";

interface CapsuleActivityOwner {
  readonly run: RuntimeV2RunIdentity;
  readonly commandKey: string;
  readonly signal: AbortSignal;
}

interface CapsuleActivityBase {
  readonly run: RuntimeV2RunIdentity;
  readonly commandKey: string;
  readonly key: string;
  readonly startedAt: number;
}

export type CapsuleLiveActivity = CapsuleActivityBase & (
  | { readonly kind: "model"; readonly stage: CapsuleModelStage }
  | { readonly kind: "tool"; readonly toolName: string; readonly target: string; readonly validation: boolean }
);

interface ActivityEntry {
  activity: CapsuleLiveActivity;
  close(): void;
}

const entries = new Map<string, ActivityEntry>();
const listeners = new Set<() => void>();
let snapshot: readonly CapsuleLiveActivity[] = [];
let activitySequence = 0;

export function subscribeCapsuleLiveActivity(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function getCapsuleLiveActivitySnapshot(): readonly CapsuleLiveActivity[] {
  return snapshot;
}

function publish(): void {
  snapshot = Array.from(entries.values(), (entry) => entry.activity);
  for (const listener of listeners) {
    try { listener(); } catch { /* A presentation observer cannot fail the active request or tool. */ }
  }
}

function newActivityKey(): string {
  return String(++activitySequence);
}

function openActivity(owner: CapsuleActivityOwner, activity: CapsuleLiveActivity) {
  const { run, signal } = owner;
  const slot = JSON.stringify([
    run.sessionKey, run.sessionEpoch, run.turnId, run.runId, run.parentRunId, run.attemptId,
    activity.kind, activity.kind === "tool" ? owner.commandKey : null,
  ]);
  const entry: ActivityEntry = { activity, close };
  function close(): void {
    signal.removeEventListener("abort", close);
    if (entries.get(slot) !== entry) return;
    entries.delete(slot);
    publish();
  }
  if (!signal.aborted) {
    const replaced = entries.get(slot);
    entries.set(slot, entry);
    replaced?.close();
    signal.addEventListener("abort", close, { once: true });
    publish();
  }
  return {
    close,
    update(update: (current: CapsuleLiveActivity) => CapsuleLiveActivity): void {
      if (signal.aborted || entries.get(slot) !== entry) return;
      const next = update(entry.activity);
      if (next === entry.activity) return;
      entry.activity = next;
      publish();
    },
  };
}

/** Presentation only. The active Run owns visibility and each transport
 * dispatch owns its first output signal. No text or provider payload enters
 * the request activity state. */
export function beginCapsuleModelActivity(run: RuntimeV2RunIdentity, commandKey: string, signal: AbortSignal) {
  const entry = openActivity({ run, commandKey, signal }, {
    kind: "model",
    stage: "preparing",
    run,
    commandKey,
    key: newActivityKey(),
    startedAt: Date.now(),
  });
  const setStage = (stage: CapsuleModelStage) => entry.update((current) =>
    current.kind !== "model" || current.stage === stage
      ? current : { ...current, stage, startedAt: Date.now() }
  );
  return {
    acquiringLane: () => setStage("acquiring_lane"),
    preparing: () => setStage("preparing"),
    requestDispatched(): () => void {
      const key = newActivityKey();
      entry.update((current) => current.kind === "model"
        ? { ...current, key, stage: "waiting", startedAt: Date.now() } : current);
      let observed = false;
      return () => {
        if (observed) return;
        observed = true;
        entry.update((current) => current.kind === "model" && current.key === key && current.stage === "waiting"
          ? { ...current, stage: "receiving", startedAt: Date.now() } : current);
      };
    },
    finish: entry.close,
  };
}

/** Call after the tool's admission and replay checks, at actual dispatch. */
export function beginCapsuleToolActivity(owner: CapsuleActivityOwner & {
  readonly toolName: string;
  readonly target: string;
  readonly validation?: boolean;
}): () => void {
  return openActivity(owner, {
    kind: "tool",
    run: owner.run,
    commandKey: owner.commandKey,
    key: newActivityKey(),
    startedAt: Date.now(),
    toolName: owner.toolName,
    target: owner.target,
    validation: owner.validation === true,
  }).close;
}
