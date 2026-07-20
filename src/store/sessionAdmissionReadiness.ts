export interface SessionAdmissionRestoreLease {
  readonly sessionKey: string;
  readonly sessionEpoch: string;
  readonly generation: number;
}

interface SessionAdmissionRestoreGate {
  lease: SessionAdmissionRestoreLease;
  promise: Promise<void>;
  resolve: () => void;
}

export type SessionAdmissionReadiness = "ready" | "owner_changed";

const gates = new Map<string, SessionAdmissionRestoreGate>();
let nextGeneration = 0;

function normalizeIdentity(value: unknown): string {
  return String(value || "").trim();
}

/**
 * Fence admission while an exact Session generation is being hydrated.
 * Replacing a restore wakes existing waiters; they loop onto the newer gate.
 */
export function beginSessionAdmissionRestore(input: {
  sessionKey: string;
  sessionEpoch: string;
}): SessionAdmissionRestoreLease {
  const sessionKey = normalizeIdentity(input.sessionKey);
  const sessionEpoch = normalizeIdentity(input.sessionEpoch);
  if (!sessionKey || !sessionEpoch) {
    throw new Error("Session admission restore requires an exact Session owner.");
  }
  const lease = Object.freeze({
    sessionKey,
    sessionEpoch,
    generation: ++nextGeneration,
  });
  let resolve = () => {};
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  const previous = gates.get(sessionKey);
  gates.set(sessionKey, { lease, promise, resolve });
  previous?.resolve();
  return lease;
}

export function settleSessionAdmissionRestore(
  lease: SessionAdmissionRestoreLease,
): boolean {
  const current = gates.get(lease.sessionKey);
  if (!current ||
    current.lease.generation !== lease.generation ||
    current.lease.sessionEpoch !== lease.sessionEpoch
  ) return false;
  gates.delete(lease.sessionKey);
  current.resolve();
  return true;
}

export async function waitForSessionAdmissionReadiness(input: {
  sessionKey: string;
  sessionEpoch: string;
}): Promise<SessionAdmissionReadiness> {
  const sessionKey = normalizeIdentity(input.sessionKey);
  const sessionEpoch = normalizeIdentity(input.sessionEpoch);
  if (!sessionKey || !sessionEpoch) return "owner_changed";
  for (;;) {
    const current = gates.get(sessionKey);
    if (!current) return "ready";
    if (current.lease.sessionEpoch !== sessionEpoch) return "owner_changed";
    await current.promise;
  }
}

/** Test/reset boundary; production invalidation settles leases explicitly. */
export function resetSessionAdmissionReadinessForTests(): void {
  for (const gate of gates.values()) gate.resolve();
  gates.clear();
}
