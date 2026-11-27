import type { KnowledgeBase } from "./ipc";
import type { KnowledgeReference } from "./knowledgeReferences";
import type { EngineManualPresetId } from "./engineManualSkills";
import type { WorkspaceEngineProfile } from "./workspaceEngineProfile";

export function enginePresetFromProjectVersion(versionFile: string): EngineManualPresetId | null {
  const editorVersion = /^m_EditorVersion:[ \t]*(\S+)/mi.exec(versionFile)?.[1];
  if (/^m_TuanjieEditorVersion:[ \t]*\S+/mi.test(versionFile) ||
      (editorVersion && /(?:^\d{4}\.\d+\.\d+t\d+$|tuanjie)/i.test(editorVersion))) {
    return "tuanjie";
  }
  return editorVersion && /^6000\.\d+\.\d+/i.test(editorVersion) ? "unity6" : null;
}

export async function detectWorkspaceEnginePreset(workspace?: string): Promise<EngineManualPresetId | null> {
  const { resolveWorkspaceEngineProfile } = await import("./workspaceEngineProfile");
  return (await resolveWorkspaceEngineProfile(workspace))?.manualPresetId ?? null;
}

export async function resolveActiveEngineKnowledgeReferences(input: {
  readonly workspace?: string;
  readonly workspaceEngineProfile?: WorkspaceEngineProfile | null;
  readonly knowledgeBases: readonly KnowledgeBase[];
  readonly explicitReferences?: readonly KnowledgeReference[];
}, dependencies = {
  detect: detectWorkspaceEnginePreset,
  listBases: async () => (await import("./ipc")).knowledgeListBases(),
}): Promise<{
  readonly references: readonly KnowledgeReference[];
  readonly activePresetIds: readonly string[];
  readonly detectedPresetId: EngineManualPresetId | null;
}> {
  const explicit = [...(input.explicitReferences || [])];
  const detectedPresetId = input.workspaceEngineProfile === undefined
    ? await dependencies.detect(input.workspace)
    : input.workspaceEngineProfile?.manualPresetId ?? null;
  const bases = detectedPresetId
    ? await dependencies.listBases().catch(() => input.knowledgeBases)
    : input.knowledgeBases;
  const explicitPresets = new Set(
    explicit.map(ref => bases.find(base => base.id === ref.kbId)?.presetId).filter(Boolean),
  );
  const noAutomaticBinding = {
    references: Object.freeze(explicit),
    activePresetIds: Object.freeze([] as string[]),
    detectedPresetId,
  };
  if (!detectedPresetId) return noAutomaticBinding;
  if (explicitPresets.size) {
    return {
      ...noAutomaticBinding,
      activePresetIds: Object.freeze(
        explicitPresets.size === 1 && explicitPresets.has(detectedPresetId) ? [detectedPresetId] : [],
      ),
    };
  }
  const selected = bases
    .filter(base => base.presetId === detectedPresetId && base.enabled &&
      (base.sourceCount > 0 || (base.tocEntryCount ?? 0) > 0))
    .sort((a, b) => b.updatedAtMs - a.updatedAtMs || a.id.localeCompare(b.id))[0];
  if (!selected) return noAutomaticBinding;
  const standby: KnowledgeReference = Object.freeze({
    kind: "base",
    kbId: selected.id,
    indexRevision: selected.indexRevision,
    label: selected.name,
    activationMode: "workspace_active",
    presetId: detectedPresetId,
  });
  return {
    references: Object.freeze([...explicit, standby]),
    activePresetIds: Object.freeze([detectedPresetId]),
    detectedPresetId,
  };
}
