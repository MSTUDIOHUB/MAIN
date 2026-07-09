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
  const getElapsedSeconds = () => Math.round((nowMs() - startTime) / 1000);
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
