export type SessionRestoreRevisionFence = Readonly<{
  sessionKey: string;
  runtimeRef: unknown;
}>;

type SessionRuntimeRevisionState = {
  runtimeBySessionKey?: Record<string, unknown> | null;
};

/**
 * Capture the exact in-memory runtime revision owned by one Session.
 *
 * `runtimeBySessionKey` is updated immutably, so the value object is the
 * Session-scoped revision token. Capturing the whole map would make unrelated
 * Session activity cancel a valid restore; capturing only this entry keeps the
 * fence local to its owner.
 */
export function captureSessionRestoreRevisionFence(
  state: SessionRuntimeRevisionState,
  sessionKey: string | null | undefined,
): SessionRestoreRevisionFence | null {
  const normalizedSessionKey = String(sessionKey || "").trim();
  if (!normalizedSessionKey) return null;
  return {
    sessionKey: normalizedSessionKey,
    runtimeRef: state.runtimeBySessionKey?.[normalizedSessionKey],
  };
}

/**
 * Return true only while the target Session still has the captured runtime
 * object. Changes to another Session deliberately do not invalidate the fence.
 */
export function isSessionRestoreRevisionFenceCurrent(
  fence: SessionRestoreRevisionFence | null | undefined,
  state: SessionRuntimeRevisionState,
): boolean {
  if (!fence) return false;
  return state.runtimeBySessionKey?.[fence.sessionKey] === fence.runtimeRef;
}
