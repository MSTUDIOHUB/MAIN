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
}

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
  seedSessionRuntime: () => void;
  sessionSet: (patchOrUpdater: SubmitSessionPatchInput<TState>) => void;
  sessionGet: () => TState;
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
  const getRuntime = (state: TState): TRuntime =>
    state.runtimeBySessionKey[params.runSessionKey] ||
    params.createRuntimeFromState(state);

  const isRunSessionActive = (candidate = params.get()): boolean =>
    resolveSessionRuntimeKey(
      resolveSessionWorkspaceKey(candidate.currentWorkspace),
      candidate.currentSessionId,
    ) === params.runSessionKey;

  const seedSessionRuntime = () => {
    params.set((state) => ({
      runtimeBySessionKey: {
        ...state.runtimeBySessionKey,
        [params.runSessionKey]: params.createRuntimeFromState(state),
      },
    } as Partial<TState>));
  };

  const sessionSet = (patchOrUpdater: SubmitSessionPatchInput<TState>) => {
    params.set((state) => {
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
      return {
        ...globalPatch,
        runtimeBySessionKey: {
          ...state.runtimeBySessionKey,
          [params.runSessionKey]: {
            ...existing,
            ...runtimePatch,
          },
        },
      } as Partial<TState>;
    });
  };

  const sessionGet = (): TState => {
    const live = params.get();
    const runtime = getRuntime(live);
    const scoped = (isRunSessionActive(live) ? live : { ...live, ...runtime }) as TState;
    return params.decorateScopedState ? params.decorateScopedState(scoped) : scoped;
  };

  return {
    isRunSessionActive,
    seedSessionRuntime,
    sessionSet,
    sessionGet,
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
