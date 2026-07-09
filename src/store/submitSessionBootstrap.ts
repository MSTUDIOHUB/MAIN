import {
  buildSubmitSessionBootstrapDecision,
  buildSubmitSessionBootstrapPatch,
  type SubmitSessionBootstrapDecision,
} from "../lib/submit/turnSubmission";

type SubmitSessionBootstrapSet = (patch: any) => void;

export interface ApplySubmitSessionBootstrapInput {
  state: {
    currentWorkspace?: string | null;
    currentSessionId?: number | null;
    sessionsByWorkspace: Record<string, Array<{ id: number; active?: boolean }>>;
    activeSessionByWorkspace: Record<string, number | null>;
    autoApproveTools: boolean;
    autoApproveToolScopes: unknown[];
    webSearchEnabled: boolean;
    webSearchProvider: unknown;
    config: {
      language: string;
      sessionRecordingEnabled: boolean;
    };
  };
  set: SubmitSessionBootstrapSet;
  updateSession: (
    scopeKey: string,
    sessionId: number,
    patch: {
      updatedAt: string;
      updatedAtMs: number;
      active: true;
    },
  ) => void;
  autoSessionNowMs: number;
  commandIssuedAtMs: number;
}

export function applySubmitSessionBootstrap(
  input: ApplySubmitSessionBootstrapInput,
): SubmitSessionBootstrapDecision {
  const { state } = input;
  const decision = buildSubmitSessionBootstrapDecision({
    currentWorkspace: state.currentWorkspace,
    currentSessionId: state.currentSessionId,
    sessionsByWorkspace: state.sessionsByWorkspace,
    language: state.config.language === "en" ? "en" : "zh",
    sessionRecordingEnabled: state.config.sessionRecordingEnabled,
    autoSessionNowMs: input.autoSessionNowMs,
    commandIssuedAtMs: input.commandIssuedAtMs,
  });

  if (decision.autoSession) {
    input.set((s: typeof state) =>
      buildSubmitSessionBootstrapPatch({
        decision,
        sessionsByWorkspace: s.sessionsByWorkspace,
        activeSessionByWorkspace: s.activeSessionByWorkspace,
        autoApproveTools: s.autoApproveTools,
        autoApproveToolScopes: s.autoApproveToolScopes,
        webSearchEnabled: s.webSearchEnabled,
        webSearchProvider: s.webSearchProvider,
      }) || {},
    );
  }

  input.updateSession(decision.runScopeKey, decision.runSessionId, {
    updatedAt: decision.commandIssuedAtIso,
    updatedAtMs: decision.commandIssuedAtMs,
    active: true,
  });

  return decision;
}
