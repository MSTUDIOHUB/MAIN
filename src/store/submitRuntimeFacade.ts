import {
  resolveSessionRuntimeKey,
  resolveSessionWorkspaceKey,
} from "../lib/sessionTypes";

export type SubmitSessionPatch<TState> = Partial<TState> | Record<string, unknown>;
export type SubmitSessionPatchInput<TState> =
  | SubmitSessionPatch<TState>
  | ((state: TState) => SubmitSessionPatch<TState>);

export interface SubmitSessionRuntimeFacadeState<TRuntime extends object> {
  currentWorkspace?: string | null;
  currentSessionId?: number | null;
  runtimeBySessionKey: Record<string, TRuntime>;
  sessionsByWorkspace?: Record<string, unknown[]>;
}

export interface SubmitOwnerScopedRuntimeProjectionInput<TState> {
  /** Runtime projection built from the exact owner Session snapshot. */
  projectedState: TState;
  /**
   * Projection returned after durable persistence. Only persistence-owned
   * fields from its exact Session record are merged into the latest Store.
   */
  durableState?: TState;
  scopeKey: string;
  sessionId: number | string | null | undefined;
  /** Raw owner runtime token captured before the async persistence boundary. */
  expectedRevisionToken: unknown;
  /**
   * Synchronous external settlement performed only after the owner/revision
   * CAS succeeds and immediately before the terminal Store patch is applied.
   */
  beforePublish?: () => void;
}

export type SubmitOwnerScopedRuntimePublicationResult =
  | { published: true; disposition: "published" }
  | {
      published: false;
      disposition: "revision_conflict" | "ownership_lost" | "durable_session_missing";
    };

export interface SubmitSessionRuntimeFacadeInput<
  TState extends SubmitSessionRuntimeFacadeState<TRuntime>,
  TRuntime extends object,
> {
  get: () => TState;
  set: (patchOrUpdater: Partial<TState> | ((state: TState) => Partial<TState>)) => void;
  runSessionKey: string;
  createRuntimeFromState: (state: Partial<TState>) => TRuntime;
  pickRuntimePatch: (source: SubmitSessionPatch<TState>) => Partial<TRuntime>;
  normalizePatch?: (patch: SubmitSessionPatch<TState>) => SubmitSessionPatch<TState>;
  decorateScopedState?: (state: TState) => TState;
}

export interface SubmitSessionRuntimeFacade<
  TState extends SubmitSessionRuntimeFacadeState<TRuntime>,
  TRuntime extends object,
> {
  isRunSessionActive: (candidate?: TState) => boolean;
  /** Opaque generation minted when this exact Session runtime is seeded. */
  getSessionRuntimeOwnerToken: () => object;
  /** Key presence alone is insufficient because a recreated Session may reuse it. */
  hasSessionRuntimeOwnership: (expectedOwnerToken?: object) => boolean;
  seedSessionRuntime: () => void;
  sessionSet: (patchOrUpdater: SubmitSessionPatchInput<TState>) => void;
  sessionGet: () => TState;
  getSessionRevisionToken: () => unknown;
  publishOwnerScopedRuntimeProjection: (
    input: SubmitOwnerScopedRuntimeProjectionInput<TState>,
  ) => SubmitOwnerScopedRuntimePublicationResult;
}

const SUBMIT_SESSION_RUNTIME_OWNER = Symbol("submit-session-runtime-owner");

type RuntimeWithSubmitOwner = {
  [SUBMIT_SESSION_RUNTIME_OWNER]?: SubmitSessionRuntimeOwnerToken;
};

interface SubmitSessionRuntimeOwnerToken {
  sessionKey: string;
  sessionGeneration: string | null;
}

function resolveSubmitSessionGeneration<TState extends SubmitSessionRuntimeFacadeState<object>>(
  state: TState,
  sessionKey: string,
): string | null {
  for (const [scopeKey, records] of Object.entries(state.sessionsByWorkspace || {})) {
    if (!Array.isArray(records)) continue;
    for (const record of records as Array<Record<string, unknown>>) {
      const sessionId = typeof record.id === "number" ? record.id : null;
      if (resolveSessionRuntimeKey(scopeKey, sessionId) !== sessionKey) {
        continue;
      }
      const generation = String(record.planLifecycleEpoch || "").trim();
      return generation || null;
    }
  }
  return null;
}

/**
 * Carry the opaque submit owner across an ordinary snapshot refresh of the
 * same Session container. Replacement, deletion, restore, and Session
 * recreation paths must not call this helper: those operations intentionally
 * revoke the previous generation.
 */
export function preserveSubmitSessionRuntimeOwnership<TRuntime extends object>(
  previous: TRuntime | null | undefined,
  replacement: TRuntime,
  currentSessionGeneration: string | null,
): TRuntime {
  const ownerToken = (previous as RuntimeWithSubmitOwner | null | undefined)?.[
    SUBMIT_SESSION_RUNTIME_OWNER
  ];
  if (
    !ownerToken ||
    ownerToken.sessionGeneration !== currentSessionGeneration
  ) {
    return replacement;
  }
  return {
    ...replacement,
    [SUBMIT_SESSION_RUNTIME_OWNER]: ownerToken,
  };
}

const DURABLE_SESSION_PUBLICATION_KEYS = [
  "messages",
  "runtimeSnapshot",
  "storageRevision",
  "storageStatus",
  "recordingDisabled",
  "updatedAt",
  "updatedAtMs",
  "workspaceRoot",
  "projectId",
  "turnCount",
  "messageCount",
  "transcriptPartial",
  "transcriptLoadedTurns",
  "transcriptTotalTurns",
  // Retained for compatibility with older persistence adapters.
  "storagePath",
] as const;

function findSessionRecord<TState>(
  state: TState,
  scopeKey: string,
  sessionId: number | string,
): Record<string, unknown> | null {
  const sessions = (state as any)?.sessionsByWorkspace?.[scopeKey];
  if (!Array.isArray(sessions)) return null;
  return sessions.find((candidate: any) => candidate?.id === sessionId) || null;
}

/**
 * Derive only the fields owned by a completed persistence operation. A save
 * adapter may return the whole Session record; publishing that object would
 * roll back a concurrently refreshed title, model configuration, or index
 * metadata.
 */
export function buildOwnerScopedDurableSessionPatch<TState>(input: {
  projectedState: TState;
  durableState: TState;
  scopeKey: string;
  sessionId: number | string;
}): Record<string, unknown> | null {
  const durableRecord = findSessionRecord(
    input.durableState,
    input.scopeKey,
    input.sessionId,
  );
  if (!durableRecord) return null;

  const patch: Record<string, unknown> = {};
  for (const key of DURABLE_SESSION_PUBLICATION_KEYS) {
    if (
      Object.prototype.hasOwnProperty.call(durableRecord, key)
    ) {
      patch[key] = durableRecord[key];
    }
  }
  return patch;
}

export interface SubmitPreRunSessionPatcherInput<
  TState extends SubmitSessionRuntimeFacadeState<TRuntime>,
  TRuntime extends object,
> {
  originSessionKey: string | null;
  originSnapshot: TState;
  get: () => TState;
  set: (patchOrUpdater: Partial<TState> | ((state: TState) => Partial<TState>)) => void;
  createRuntimeFromState: (state: Partial<TState>) => TRuntime;
  pickRuntimePatch: (source: SubmitSessionPatch<TState>) => Partial<TRuntime>;
}

export function createSubmitPreRunSessionPatcher<
  TState extends SubmitSessionRuntimeFacadeState<TRuntime>,
  TRuntime extends object,
>(
  params: SubmitPreRunSessionPatcherInput<TState, TRuntime>,
): (patch: SubmitSessionPatch<TState>) => void {
  const isOriginSessionActive = (state: TState): boolean =>
    !!params.originSessionKey &&
    resolveSessionRuntimeKey(
      resolveSessionWorkspaceKey(state.currentWorkspace),
      state.currentSessionId,
    ) === params.originSessionKey;

  return (patch) => {
    if (!params.originSessionKey || isOriginSessionActive(params.get())) {
      params.set(patch as Partial<TState>);
      return;
    }

    params.set((state) => {
      const runtimePatch = params.pickRuntimePatch(patch);
      if (Object.keys(runtimePatch).length === 0) return {} as Partial<TState>;
      const existing =
        state.runtimeBySessionKey[params.originSessionKey!] ||
        params.createRuntimeFromState(params.originSnapshot);
      return {
        runtimeBySessionKey: {
          ...state.runtimeBySessionKey,
          [params.originSessionKey!]: {
            ...existing,
            ...runtimePatch,
          },
        },
      } as Partial<TState>;
    });
  };
}

export function createSubmitSessionRuntimeFacade<
  TState extends SubmitSessionRuntimeFacadeState<TRuntime>,
  TRuntime extends object,
>(
  params: SubmitSessionRuntimeFacadeInput<TState, TRuntime>,
): SubmitSessionRuntimeFacade<TState, TRuntime> {
  let seeded = false;
  const runtimeOwnerToken = Object.freeze({
    sessionKey: params.runSessionKey,
    sessionGeneration: resolveSubmitSessionGeneration(params.get(), params.runSessionKey),
  });
  const stampOwnedRuntime = (runtime: TRuntime): TRuntime => ({
    ...runtime,
    [SUBMIT_SESSION_RUNTIME_OWNER]: runtimeOwnerToken,
  });
  const isOwnedRuntime = (runtime: TRuntime | null | undefined): boolean =>
    !!runtime &&
    (runtime as RuntimeWithSubmitOwner)[SUBMIT_SESSION_RUNTIME_OWNER] === runtimeOwnerToken;
  let lastKnownOwnerRuntime =
    params.get().runtimeBySessionKey[params.runSessionKey] ||
    params.createRuntimeFromState(params.get());
  const missingRuntimeRevisionToken = {};
  const hasRuntimeEntry = (state: TState): boolean =>
    Object.prototype.hasOwnProperty.call(state.runtimeBySessionKey, params.runSessionKey);
  const hasOwnedRuntimeEntry = (state: TState): boolean =>
    hasRuntimeEntry(state) && (
      !seeded || isOwnedRuntime(state.runtimeBySessionKey[params.runSessionKey])
    );
  const getRuntime = (state: TState): TRuntime => {
    const owned = state.runtimeBySessionKey[params.runSessionKey];
    if (owned && (!seeded || isOwnedRuntime(owned))) {
      lastKnownOwnerRuntime = owned;
      return owned;
    }
    // Once seeded, deletion of this exact runtime key means the Session owner
    // was removed. Never synthesize a replacement from whichever Session is
    // currently visible in the global Store.
    return lastKnownOwnerRuntime;
  };

  const isRunSessionActive = (candidate = params.get()): boolean =>
    resolveSessionRuntimeKey(
      resolveSessionWorkspaceKey(candidate.currentWorkspace),
      candidate.currentSessionId,
    ) === params.runSessionKey;

  const seedSessionRuntime = () => {
    params.set((state) => {
      const runtime = stampOwnedRuntime(params.createRuntimeFromState(state));
      lastKnownOwnerRuntime = runtime;
      return {
        runtimeBySessionKey: {
          ...state.runtimeBySessionKey,
          [params.runSessionKey]: runtime,
        },
      } as Partial<TState>;
    });
    seeded = true;
  };

  const sessionSet = (patchOrUpdater: SubmitSessionPatchInput<TState>) => {
    params.set((state) => {
      if (seeded && !hasOwnedRuntimeEntry(state)) {
        return {} as Partial<TState>;
      }
      const active = isRunSessionActive(state);
      const existing = getRuntime(state);
      const baseState = active ? state : ({ ...state, ...existing } as TState);
      const rawPatch =
        typeof patchOrUpdater === "function"
          ? patchOrUpdater(baseState)
          : patchOrUpdater;
      if (!rawPatch || typeof rawPatch !== "object") return {} as Partial<TState>;

      const normalizedPatch = params.normalizePatch
        ? params.normalizePatch(rawPatch)
        : rawPatch;
      const runtimePatch = params.pickRuntimePatch(normalizedPatch);
      const globalPatch = active ? normalizedPatch : {};
      lastKnownOwnerRuntime = stampOwnedRuntime({
        ...existing,
        ...runtimePatch,
      });
      return {
        ...globalPatch,
        runtimeBySessionKey: {
          ...state.runtimeBySessionKey,
          [params.runSessionKey]: lastKnownOwnerRuntime,
        },
      } as Partial<TState>;
    });
  };

  const sessionGet = (): TState => {
    const live = params.get();
    const runtime = getRuntime(live);
    const ownsRuntime = hasOwnedRuntimeEntry(live);
    const scoped = (
      isRunSessionActive(live) && (!seeded || ownsRuntime)
        ? live
        : { ...live, ...runtime }
    ) as TState;
    return params.decorateScopedState ? params.decorateScopedState(scoped) : scoped;
  };

  const publishOwnerScopedRuntimeProjection = (
    input: SubmitOwnerScopedRuntimeProjectionInput<TState>,
  ): SubmitOwnerScopedRuntimePublicationResult => {
    const runtimeProjection = stampOwnedRuntime(params.createRuntimeFromState(
      input.durableState || input.projectedState,
    ));
    const runtimePatch = params.pickRuntimePatch(
      runtimeProjection as unknown as SubmitSessionPatch<TState>,
    );
    const hasDurableProjection = !!input.durableState &&
      (input.durableState as any).sessionsByWorkspace !==
        (input.projectedState as any).sessionsByWorkspace;
    const durableSessionPatch = hasDurableProjection && input.sessionId != null
      ? buildOwnerScopedDurableSessionPatch({
          projectedState: input.projectedState,
          durableState: input.durableState as TState,
          scopeKey: input.scopeKey,
          sessionId: input.sessionId,
        })
      : {};
    let result: SubmitOwnerScopedRuntimePublicationResult = {
      published: false,
      disposition: "ownership_lost",
    };

    params.set((latest) => {
      const existing = latest.runtimeBySessionKey[params.runSessionKey];
      if (!existing || (seeded && !isOwnedRuntime(existing))) {
        result = { published: false, disposition: "ownership_lost" };
        return {} as Partial<TState>;
      }
      if (existing !== input.expectedRevisionToken) {
        result = { published: false, disposition: "revision_conflict" };
        return {} as Partial<TState>;
      }

      const latestSessions = input.sessionId == null
        ? null
        : ((latest.sessionsByWorkspace?.[input.scopeKey] || []) as Array<Record<string, unknown>>);
      if (
        hasDurableProjection &&
        input.sessionId != null &&
        (
          durableSessionPatch === null ||
          !latestSessions?.some((candidate) => candidate?.id === input.sessionId)
        )
      ) {
        result = { published: false, disposition: "durable_session_missing" };
        return {} as Partial<TState>;
      }

      input.beforePublish?.();

      const active = isRunSessionActive(latest);
      const nextPatch: Record<string, unknown> = {
        ...(active ? runtimePatch : {}),
        runtimeBySessionKey: {
          ...latest.runtimeBySessionKey,
          [params.runSessionKey]: runtimeProjection,
        },
      };
      if (
        input.sessionId != null &&
        latestSessions &&
        durableSessionPatch &&
        Object.keys(durableSessionPatch).length > 0
      ) {
        nextPatch.sessionsByWorkspace = {
          ...latest.sessionsByWorkspace,
          [input.scopeKey]: latestSessions.map((candidate) =>
            candidate?.id === input.sessionId
              ? {
                  ...candidate,
                  ...durableSessionPatch,
                  ...(typeof candidate.storageRevision === "number" ||
                    typeof durableSessionPatch.storageRevision === "number"
                    ? {
                        storageRevision: Math.max(
                          Number(candidate.storageRevision) || 0,
                          Number(durableSessionPatch.storageRevision) || 0,
                        ),
                      }
                    : {}),
                }
              : candidate
          ),
        };
      }

      lastKnownOwnerRuntime = runtimeProjection;
      result = { published: true, disposition: "published" };
      return nextPatch as Partial<TState>;
    });
    return result;
  };

  return {
    isRunSessionActive,
    getSessionRuntimeOwnerToken: () => runtimeOwnerToken,
    hasSessionRuntimeOwnership: (expectedOwnerToken = runtimeOwnerToken) =>
      expectedOwnerToken === runtimeOwnerToken && hasOwnedRuntimeEntry(params.get()),
    seedSessionRuntime,
    sessionSet,
    sessionGet,
    getSessionRevisionToken: () => {
      const live = params.get();
      // Every session-scoped mutation replaces this exact runtime snapshot,
      // including mutations applied through the Store sync middleware. Using
      // it as the token avoids false CAS conflicts from unrelated sessions or
      // global UI state while still detecting writes to this session.
      const runtime = live.runtimeBySessionKey[params.runSessionKey];
      return runtime && (!seeded || isOwnedRuntime(runtime))
        ? runtime
        : missingRuntimeRevisionToken;
    },
    publishOwnerScopedRuntimeProjection,
  };
}

export interface SubmitElapsedTimerInput<
  TState extends { agentStatus?: string },
  TTimerHandle,
> {
  sessionGet: () => TState;
  sessionSet: (patch: { elapsedTime: number }) => void;
  initialElapsedSeconds?: number;
  nowMs?: () => number;
  setTimer?: (callback: () => void, ms: number) => TTimerHandle;
  clearTimer?: (timer: TTimerHandle) => void;
}

export interface SubmitElapsedTimer<TTimerHandle> {
  timerInterval: TTimerHandle;
  getElapsedSeconds: () => number;
  updateElapsedTime: () => void;
  dispose: () => void;
}

export function startSubmitElapsedTimer<
  TState extends { agentStatus?: string },
  TTimerHandle = ReturnType<typeof setInterval>,
>(
  params: SubmitElapsedTimerInput<TState, TTimerHandle>,
): SubmitElapsedTimer<TTimerHandle> {
  const nowMs = params.nowMs || Date.now;
  const setTimer = params.setTimer || ((callback, ms) => setInterval(callback, ms) as TTimerHandle);
  const clearTimer = params.clearTimer || ((timer) => clearInterval(timer as ReturnType<typeof setInterval>));
  const startTime = nowMs();
  const initialElapsedSeconds = Math.max(0, Math.round(Number(params.initialElapsedSeconds) || 0));
  const getElapsedSeconds = () => initialElapsedSeconds + Math.round((nowMs() - startTime) / 1000);
  const updateElapsedTime = () => {
    params.sessionSet({ elapsedTime: getElapsedSeconds() });
  };
  const timerInterval = setTimer(() => {
    const state = params.sessionGet();
    if (state.agentStatus === "idle" || state.agentStatus === "error") {
      clearTimer(timerInterval);
      return;
    }
    updateElapsedTime();
  }, 1000);

  return {
    timerInterval,
    getElapsedSeconds,
    updateElapsedTime,
    dispose: () => clearTimer(timerInterval),
  };
}
