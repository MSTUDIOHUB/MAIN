export const LOCAL_PERSIST_SCHEMA_VERSION = 2;

export const LEGACY_RUNTIME_PERSIST_KEYS = [
  "taskFlow",
  "agentMessages",
  "contextMemoryState",
  "conversationTurns",
  "currentTurnId",
  "pendingSlashCommand",
  "planArtifacts",
  "planTasks",
  "planExecutionEvidenceLedger",
  "planExecutionEvidenceCount",
  "planAutoResumeCount",
  "planExecutionProgressSnapshot",
  "planStage",
  "isPlanApproved",
  "showPlanPanel",
  "showDiff",
  "showTerminal",
  "showFilePanel",
  "selectedDiffTaskId",
  "input",
] as const;

export const LEGACY_CONFIG_PERSIST_KEYS = [
  "thinkingPolicy",
  "thoughtDisplayMode",
] as const;

export function stripLegacyConfigFields(config: unknown): Record<string, unknown> | undefined {
  if (!config || typeof config !== "object") return undefined;
  const nextConfig = { ...(config as Record<string, unknown>) };
  for (const key of LEGACY_CONFIG_PERSIST_KEYS) {
    delete nextConfig[key];
  }
  return nextConfig;
}

function stripSessionDetailsForLocalPersist(session: any): any | null {
  if (session?.recordingDisabled && session?.storageStatus !== "temporary") return null;
  const { messages: _messages, runtimeSnapshot: _runtimeSnapshot, ...meta } = session || {};
  return {
    ...meta,
    storageStatus: session?.storageStatus === "temporary" ? "temporary" : session?.storageStatus,
  };
}

export function stripSessionsByWorkspaceForLocalPersist(
  sessionsByWorkspace: Record<string, any[]> | undefined,
): Record<string, any[]> {
  if (!sessionsByWorkspace) return {};
  return Object.fromEntries(
    Object.entries(sessionsByWorkspace)
      .map(([workspace, sessions]) => [
        workspace,
        (sessions || [])
          .map(stripSessionDetailsForLocalPersist)
          .filter((session): session is any => Boolean(session)),
      ])
      .filter(([, sessions]) => sessions.length > 0),
  );
}

export function stripLegacyRuntimeFieldsFromPersistedState(
  persistedState: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  if (!persistedState || typeof persistedState !== "object") return {};
  const nextState = { ...persistedState } as Record<string, unknown>;
  for (const key of LEGACY_RUNTIME_PERSIST_KEYS) {
    if (Object.prototype.hasOwnProperty.call(nextState, key)) {
      delete nextState[key];
    }
  }
  if (nextState.sessionsByWorkspace) {
    nextState.sessionsByWorkspace = stripSessionsByWorkspaceForLocalPersist(
      nextState.sessionsByWorkspace as Record<string, any[]>,
    );
  }
  if (nextState.config) {
    nextState.config = stripLegacyConfigFields(nextState.config);
  }
  return nextState;
}

export function buildPersistedAppState(state: Record<string, any>): Record<string, unknown> {
  return {
    config: stripLegacyConfigFields(state.config),
    skills: state.skills,
    sessionsByWorkspace: stripSessionsByWorkspaceForLocalPersist(state.sessionsByWorkspace),
    workspaces: state.workspaces,
    activeSessionByWorkspace: state.activeSessionByWorkspace,
    currentWorkspace: state.currentWorkspace,
    selectedWorkspace: state.selectedWorkspace,
    currentSessionId: state.currentSessionId,
    selectedMainModeKey: state.selectedMainModeKey,
    selectedNexusModeKey: state.selectedNexusModeKey,
    activeStudioAgentKey: state.activeStudioAgentKey,
    gameStudioInitialized: state.gameStudioInitialized,
    preferredResponseLanguage: state.preferredResponseLanguage,
    mcpServers: state.mcpServers,
    sidebarWidth: state.sidebarWidth,
    showWorkspaceTreePanel: state.showWorkspaceTreePanel,
    workspaceTreePanelWidth: state.workspaceTreePanelWidth,
    rightPanelWidth: state.rightPanelWidth,
  };
}
