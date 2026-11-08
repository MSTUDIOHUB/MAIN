import { retireRemovedFeatures } from "./retiredFeatureMigration";
import { normalizeExternalSkillSelections } from "./externalSkillSelections";
import { normalizeExternalSkillSources } from "./externalSkillSources";
import { normalizeGithubSkillSource } from "./githubSkillSource";

export const LOCAL_PERSIST_SCHEMA_VERSION = 3;

export const LEGACY_RUNTIME_PERSIST_KEYS = [
  "taskFlow",
  "agentMessages",
  "contextMemoryState",
  "conversationTurns",
  "currentTurnId",
  "pendingSlashCommand",
  "activeStudioAgentKey",
  "gameStudioInitialized",
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

/** Legacy tool schemas never had an executable binding. Preserve their
 * instructions and user policy while presenting them as ordinary Skills. */
export function normalizePersistedSkills<T>(skills: T): T {
  if (!Array.isArray(skills)) return skills;
  return skills.map((skill) => {
    if (!skill || typeof skill !== "object") return skill;
    const { githubSource: _source, ...rest } = skill;
    const githubSource = skill.type === "package" && skill.packageStorage?.kind === "global"
      ? normalizeGithubSkillSource(skill.githubSource) : undefined;
    const record = _source === undefined ? skill : { ...rest, ...(githubSource ? { githubSource } : {}) };
    if (skill.type !== "tool") return record;
    const { toolParameters: _schema, ...instruction } = record;
    return { ...instruction, type: "instruction" };
  }) as T;
}

/**
 * Goal is a one-message composer choice, so a historical persisted value must
 * never restore its capsule. Other composer intents retain their existing
 * persistence behavior.
 */
export function sanitizeHydratedLockedComposerIntent(value: unknown): unknown {
  return value === "goal" || value === "image_studio" ? null : value;
}

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
  if (session?._retirementMigrationPending === true) return retireRemovedFeatures(session);
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
  const nextState = retireRemovedFeatures({ ...persistedState }) as Record<string, unknown>;
  // Retired Gemini ZIP installation metadata must not rehydrate hidden Skills
  // or MCP capabilities. Existing package files are left untouched on disk.
  delete nextState.geminiExtensions;
  delete nextState.extensionMcpDiscovery;
  for (const key of LEGACY_RUNTIME_PERSIST_KEYS) {
    if (Object.prototype.hasOwnProperty.call(nextState, key)) {
      delete nextState[key];
    }
  }
  if (Object.prototype.hasOwnProperty.call(nextState, "lockedComposerIntent")) {
    nextState.lockedComposerIntent = sanitizeHydratedLockedComposerIntent(
      nextState.lockedComposerIntent,
    );
  }
  if (nextState.sessionsByWorkspace) {
    // Keep legacy full snapshots in memory until the startup migration has
    // committed them to native storage. Only the persistence writer slims them.
    nextState.sessionsByWorkspace = Object.fromEntries(Object.entries(retireRemovedFeatures(nextState.sessionsByWorkspace) as Record<string, any[]>).map(([workspace, sessions]) => [workspace, (sessions || []).filter(session => !session.recordingDisabled || session.storageStatus === "temporary").map(session => ({ ...session,
      ...((session.messages?.length || session.runtimeSnapshot) && !session.recordingDisabled && session.storageStatus !== "temporary" ? { _retirementMigrationPending: true } : {}),
    }))]));
  }
  if (nextState.config) {
    nextState.config = stripLegacyConfigFields(nextState.config);
  }
  if (nextState.skills) nextState.skills = normalizePersistedSkills(nextState.skills);
  nextState.externalSkillSelections = normalizeExternalSkillSelections(nextState.externalSkillSelections);
  nextState.externalSkillSources = normalizeExternalSkillSources(nextState.externalSkillSources);
  return nextState;
}

export function buildPersistedAppState(state: Record<string, any>): Record<string, unknown> {
  return {
    config: stripLegacyConfigFields(state.config),
    skills: normalizePersistedSkills(state.skills),
    externalSkillSelections: normalizeExternalSkillSelections(state.externalSkillSelections),
    externalSkillSources: normalizeExternalSkillSources(state.externalSkillSources),
    knowledgeBases: state.knowledgeBases,
    sessionsByWorkspace: stripSessionsByWorkspaceForLocalPersist(state.sessionsByWorkspace),
    workspaces: state.workspaces,
    activeSessionByWorkspace: state.activeSessionByWorkspace,
    currentWorkspace: state.currentWorkspace,
    selectedWorkspace: state.selectedWorkspace,
    currentSessionId: state.currentSessionId,
    preferredResponseLanguage: state.preferredResponseLanguage,
    mcpServers: state.mcpServers,
    sidebarWidth: state.sidebarWidth,
    showWorkspaceTreePanel: state.showWorkspaceTreePanel,
    workspaceTreePanelWidth: state.workspaceTreePanelWidth,
    rightPanelWidth: state.rightPanelWidth,
  };
}
