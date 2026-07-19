export type RuntimeUiStatus = "idle" | "running" | "pending_review" | "error";

export interface TerminalStatusPublicationDecision {
  publishNow: boolean;
  deferredIdleCount: number;
}

interface TerminalPublicationState {
  terminalProjectionCommitted: boolean;
  deferredIdleCount: number;
  inFlight: Promise<boolean> | null;
}

const LEGACY_RUN_KEY = "__legacy_terminal_publication__";

/**
 * Keeps UI-idle publication behind the durable terminal projection. Agent-loop
 * branches may request idle before they emit their final run event; the owning
 * workflow commits and persists the terminal turn once, then publishes idle.
 */
export function createTerminalStatusPublicationGate() {
  let activeRunKey = LEGACY_RUN_KEY;
  const states = new Map<string, TerminalPublicationState>();

  const normalizeRunKey = (runKey?: string): string => {
    const normalized = String(runKey || "").trim();
    return normalized || activeRunKey;
  };
  const getState = (runKey: string): TerminalPublicationState => {
    const existing = states.get(runKey);
    if (existing) return existing;
    const created: TerminalPublicationState = {
      terminalProjectionCommitted: false,
      deferredIdleCount: 0,
      inFlight: null,
    };
    states.set(runKey, created);
    return created;
  };

  return {
    requestStatus(status: RuntimeUiStatus, runKey?: string): TerminalStatusPublicationDecision {
      const key = normalizeRunKey(runKey);
      if (runKey) activeRunKey = key;
      if (status === "running") {
        activeRunKey = key;
        const existing = states.get(key);
        if (existing?.terminalProjectionCommitted || existing?.inFlight) {
          return { publishNow: false, deferredIdleCount: existing.deferredIdleCount };
        }
        if (existing) {
          existing.deferredIdleCount = 0;
        } else {
          states.set(key, {
            terminalProjectionCommitted: false,
            deferredIdleCount: 0,
            inFlight: null,
          });
        }
      }
      const state = getState(key);
      if (
        status !== "idle" &&
        status !== "running" &&
        (state.terminalProjectionCommitted || state.inFlight)
      ) {
        return { publishNow: false, deferredIdleCount: state.deferredIdleCount };
      }
      if (status === "idle" && !state.terminalProjectionCommitted) {
        state.deferredIdleCount += 1;
        return { publishNow: false, deferredIdleCount: state.deferredIdleCount };
      }
      return { publishNow: true, deferredIdleCount: state.deferredIdleCount };
    },

    commitTerminal(input: {
      runKey?: string;
      persistTerminalProjection: () => boolean | void | Promise<boolean | void>;
      publishTerminalStatus: () => void;
    }): Promise<boolean> {
      const key = normalizeRunKey(input.runKey);
      if (input.runKey) activeRunKey = key;
      const state = getState(key);
      if (state.terminalProjectionCommitted) return Promise.resolve(true);
      if (state.inFlight) return state.inFlight;

      let resolveTransaction: (value: boolean) => void = () => {};
      let rejectTransaction: (reason: unknown) => void = () => {};
      const transaction = new Promise<boolean>((resolve, reject) => {
        resolveTransaction = resolve;
        rejectTransaction = reject;
      });
      state.inFlight = transaction;
      const finish = () => {
        if (state.inFlight === transaction) state.inFlight = null;
      };
      const resolvePersistedProjection = (committed: boolean | void) => {
        try {
          if (committed === false || states.get(key) !== state) return false;
          input.publishTerminalStatus();
          if (states.get(key) !== state) return false;
          state.terminalProjectionCommitted = true;
          state.deferredIdleCount = 0;
          return true;
        } catch (error) {
          finish();
          rejectTransaction(error);
          return null;
        }
      };
      try {
        const persisted = input.persistTerminalProjection();
        Promise.resolve(persisted).then(
          (committed) => {
            const resolved = resolvePersistedProjection(committed);
            if (resolved === null) return;
            finish();
            resolveTransaction(resolved);
          },
          (error) => {
            finish();
            rejectTransaction(error);
          },
        );
      } catch (error) {
        finish();
        rejectTransaction(error);
      }
      return transaction;
    },

    discardDeferredIdle(runKey?: string): void {
      const key = normalizeRunKey(runKey);
      if (runKey) activeRunKey = key;
      const state = getState(key);
      state.deferredIdleCount = 0;
    },
  };
}
