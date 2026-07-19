export interface PersistSubmitRuntimeProjectionInput<TState extends Record<string, any>> {
  state: TState;
  scopeKey: string;
  sessionId: number | null | undefined;
  sanitizeTaskBlocksForPersist: (blocks: any[]) => any[];
  buildRuntimeSnapshot: (state: TState) => unknown;
  persistSessionRecord: (scopeKey: string, session: unknown) => Promise<unknown>;
  nowMs?: () => number;
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
  const messages = input.sanitizeTaskBlocksForPersist(input.state.taskFlow || []);
  const updatedAtMs = (input.nowMs || Date.now)();
  const shouldPersist =
    input.state.config?.sessionRecordingEnabled === true &&
    sessionRecord?.recordingDisabled !== true;
  const sessionPatch: Record<string, unknown> = {
    updatedAt: new Date(updatedAtMs).toISOString(),
    updatedAtMs,
    messages,
    storageStatus: "temporary",
    recordingDisabled:
      sessionRecord?.recordingDisabled === true ||
      input.state.config?.sessionRecordingEnabled !== true,
    runtimeSnapshot: input.buildRuntimeSnapshot({
      ...input.state,
      taskFlow: messages,
    }),
  };
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

  return {
    ...input.state,
    sessionsByWorkspace: {
      ...input.state.sessionsByWorkspace,
      [input.scopeKey]: sessions.map((candidate: any) =>
        candidate.id === input.sessionId
          ? { ...candidate, ...committedPatch }
          : candidate
      ),
    },
  };
}
