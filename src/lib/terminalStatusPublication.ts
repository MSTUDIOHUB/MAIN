export type RuntimeUiStatus = "idle" | "running" | "pending_review" | "error";

export interface TerminalStatusPublicationDecision {
  publishNow: boolean;
  deferredIdleCount: number;
}

/**
 * Keeps UI-idle publication behind the durable terminal projection. Agent-loop
 * branches may request idle before they emit their final run event; the owning
 * workflow commits and persists the terminal turn once, then publishes idle.
 */
export function createTerminalStatusPublicationGate() {
  let terminalProjectionCommitted = false;
  let deferredIdleCount = 0;

  return {
    requestStatus(status: RuntimeUiStatus): TerminalStatusPublicationDecision {
      if (status === "running") {
        terminalProjectionCommitted = false;
        deferredIdleCount = 0;
      }
      if (status === "idle" && !terminalProjectionCommitted) {
        deferredIdleCount += 1;
        return { publishNow: false, deferredIdleCount };
      }
      return { publishNow: true, deferredIdleCount };
    },

    commitTerminal(input: {
      persistTerminalProjection: () => void;
      publishTerminalStatus: () => void;
    }): void {
      input.persistTerminalProjection();
      terminalProjectionCommitted = true;
      input.publishTerminalStatus();
      deferredIdleCount = 0;
    },

    discardDeferredIdle(): void {
      deferredIdleCount = 0;
    },
  };
}
