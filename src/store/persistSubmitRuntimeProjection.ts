export interface SubmitRuntimeProjectionBaseInput<TState extends Record<string, any>> {
  state: TState;
  scopeKey: string;
  sessionId: number | null | undefined;
  sanitizeTaskBlocksForPersist: (blocks: any[]) => any[];
  buildRuntimeSnapshot: (state: TState) => unknown;
  nowMs?: () => number;
}

export interface PersistSubmitRuntimeProjectionInput<TState extends Record<string, any>>
  extends SubmitRuntimeProjectionBaseInput<TState> {
  persistSessionRecord: (scopeKey: string, session: unknown) => Promise<unknown>;
}

function prepareSubmitRuntimeProjection<TState extends Record<string, any>>(
  input: SubmitRuntimeProjectionBaseInput<TState>,
  recordingDisabled: boolean,
): {
  projectedState: TState;
  sessionRecord: any | null;
  sessionPatch: Record<string, unknown>;
} {
  if (input.sessionId == null) {
    return {
      projectedState: input.state,
      sessionRecord: null,
      sessionPatch: {},
    };
  }
  const sessions = input.state.sessionsByWorkspace?.[input.scopeKey] || [];
  const sessionRecord = sessions.find((candidate: any) => candidate.id === input.sessionId) || null;
  const messages = input.sanitizeTaskBlocksForPersist(input.state.taskFlow || []);
  const updatedAtMs = (input.nowMs || Date.now)();
  const sessionPatch: Record<string, unknown> = {
    updatedAt: new Date(updatedAtMs).toISOString(),
    updatedAtMs,
    messages,
    storageStatus: "temporary",
    recordingDisabled,
    runtimeSnapshot: input.buildRuntimeSnapshot({
      ...input.state,
      taskFlow: messages,
    }),
  };
  return {
    projectedState: {
      ...input.state,
      sessionsByWorkspace: {
        ...input.state.sessionsByWorkspace,
        [input.scopeKey]: sessions.map((candidate: any) =>
          candidate.id === input.sessionId
            ? { ...candidate, ...sessionPatch }
            : candidate
        ),
      },
    },
    sessionRecord,
    sessionPatch,
  };
}

/**
 * Build the explicit temporary/memory projection used after bounded storage
 * retries. A transient write failure never changes the Session's recording
 * policy; an already-disabled Session remains disabled.
 */
export function buildTemporarySubmitRuntimeProjection<TState extends Record<string, any>>(
  input: SubmitRuntimeProjectionBaseInput<TState>,
): TState {
  if (input.sessionId == null) return input.state;
  const sessions = input.state.sessionsByWorkspace?.[input.scopeKey] || [];
  const sessionRecord = sessions.find((candidate: any) => candidate.id === input.sessionId);
  // A missing Session record must not turn the final runtime-only fallback into
  // `durable_session_missing`. Returning the same projection omits the durable
  // Session patch while still allowing the owner-scoped Turn to close.
  if (!sessionRecord) return input.state;
  return prepareSubmitRuntimeProjection(
    input,
    sessionRecord?.recordingDisabled === true,
  ).projectedState;
}

/**
 * Persist a submission conclusion without mutating the live Store. The caller
 * may publish the returned projection only after this promise resolves and its
 * run owner is still current.
 */
export async function persistSubmitRuntimeProjection<TState extends Record<string, any>>(
  input: PersistSubmitRuntimeProjectionInput<TState>,
): Promise<TState> {
  if (input.sessionId == null) return input.state;
  const sessions = input.state.sessionsByWorkspace?.[input.scopeKey] || [];
  const sessionRecord = sessions.find((candidate: any) => candidate.id === input.sessionId);
  const shouldPersist =
    input.state.config?.sessionRecordingEnabled === true &&
    sessionRecord?.recordingDisabled !== true;
  const prepared = prepareSubmitRuntimeProjection(
    input,
    sessionRecord?.recordingDisabled === true ||
      input.state.config?.sessionRecordingEnabled !== true,
  );
  const sessionPatch = prepared.sessionPatch;
  let committedPatch = sessionPatch;

  if (shouldPersist) {
    if (!sessionRecord) {
      throw new Error(`SESSION_RUNTIME_RECORD_MISSING: ${input.scopeKey}:${input.sessionId}`);
    }
    const saved = await input.persistSessionRecord(input.scopeKey, {
      ...sessionRecord,
      ...sessionPatch,
    });
    committedPatch = {
      ...sessionPatch,
      ...(saved && typeof saved === "object" ? saved : {}),
      storageStatus: "ok",
      recordingDisabled: false,
    };
  }

  if (committedPatch === sessionPatch) return prepared.projectedState;
  return {
    ...prepared.projectedState,
    sessionsByWorkspace: {
      ...prepared.projectedState.sessionsByWorkspace,
      [input.scopeKey]: sessions.map((candidate: any) =>
        candidate.id === input.sessionId
          ? { ...candidate, ...committedPatch }
          : candidate
      ),
    },
  };
}
