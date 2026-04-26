import { deleteWorkspacePath, readFile, writeFile } from "./ipc";
import {
  buildAgentCatalog,
  buildGameStudioUserEnvelope,
  buildWorkflowCommandCatalog,
  createDefaultStudioConfig,
  GAME_STUDIO_PACK_VERSION,
  GAME_STUDIO_SOURCE_REPO,
  GAME_STUDIO_SOURCE_TAG,
  type GameStudioPackManifest,
  type NexusModeKey,
  type NonAutoStudioAgentKey,
  type PendingSlashCommand,
  type SlashCommandCatalogItem,
  type StudioCatalogLanguage,
  type StudioAgentKey,
  type StudioConfig,
  type StudioWorkflowCommandSlug,
} from "./gameStudioCatalog";

type WorkspacePackFile = {
  path: string;
  content: string;
};

type HookEventName = "SessionStart" | "UserPromptSubmit" | "PreToolUse" | "PostToolUse";

type HookDefinitionLike = {
  id: string;
  command: string;
  enabled: boolean;
  timeoutMs?: number;
  description?: string;
};

type HookConfigFile = {
  hooks: Record<HookEventName, HookDefinitionLike[]>;
};

const rawWorkspaceFiles = import.meta.glob("../gameStudioPack/workspace-files/**/*", {
  eager: true,
  import: "default",
  query: "?raw",
}) as Record<string, string>;

const GAME_STUDIO_HOOKS: HookConfigFile = {
  hooks: {
    SessionStart: [
      {
        id: "game-studio-session-context",
        command: "bash .MAIN/game-studio/hooks/session-start.sh",
        enabled: true,
        timeoutMs: 4000,
        description: "Summarize the current Game Studio workspace state when a session starts.",
      },
      {
        id: "game-studio-gap-detect",
        command: "bash .MAIN/game-studio/hooks/detect-gaps.sh",
        enabled: true,
        timeoutMs: 5000,
        description: "Surface lightweight documentation and workflow gaps for game projects.",
      },
    ],
    UserPromptSubmit: [],
    PreToolUse: [
      {
        id: "game-studio-command-guard",
        command: "bash .MAIN/game-studio/hooks/pretool-command-guard.sh",
        enabled: true,
        timeoutMs: 5000,
        description: "Warn or block dangerous git and shell commands in Game Studio workflows.",
      },
    ],
    PostToolUse: [
      {
        id: "game-studio-asset-validation",
        command: "bash .MAIN/game-studio/hooks/posttool-asset-check.sh",
        enabled: true,
        timeoutMs: 5000,
        description: "Validate JSON-heavy asset writes after tool execution.",
      },
      {
        id: "game-studio-workflow-reminder",
        command: "bash .MAIN/game-studio/hooks/posttool-workflow-reminder.sh",
        enabled: true,
        timeoutMs: 3000,
        description: "Remind the agent to re-run relevant Game Studio reviews after editing protocol assets.",
      },
    ],
  },
};

function normalizePackPath(sourcePath: string): string {
  return sourcePath.replace(/\\/g, "/");
}

function mapWorkspacePath(sourcePath: string): string | null {
  const normalized = normalizePackPath(sourcePath);
  const workspaceMarker = "/workspace-files/";
  const idx = normalized.indexOf(workspaceMarker);
  if (idx === -1) return null;
  const relative = normalized.slice(idx + workspaceMarker.length);

  if (relative.startsWith("protocols/")) {
    return `.${relative}`;
  }

  if (relative.startsWith("main/")) {
    return `.MAIN/${relative.slice("main/".length)}`;
  }

  return null;
}

function parseDescription(raw: string): string | null {
  const frontmatterMatch = raw.match(/^---\s*\n([\s\S]*?)\n---\s*/);
  if (!frontmatterMatch) return null;
  const descriptionMatch = frontmatterMatch[1].match(/^description:\s*"?(.+?)"?$/m);
  return descriptionMatch?.[1]?.trim() || null;
}

function parseAgentDescriptions(): Partial<Record<NonAutoStudioAgentKey, string>> {
  const result: Partial<Record<NonAutoStudioAgentKey, string>> = {};
  for (const [key, content] of Object.entries(rawWorkspaceFiles)) {
    if (!key.includes("/protocols/game-studio/agents/")) continue;
    const slug = key.split("/").pop()?.replace(/\.md$/i, "");
    if (!slug || slug === "studio_auto") continue;
    result[slug as NonAutoStudioAgentKey] = parseDescription(content) ?? "Game Studio specialist profile.";
  }
  return result;
}

function parseCommandDescriptions(): Partial<Record<StudioWorkflowCommandSlug, string>> {
  const result: Partial<Record<StudioWorkflowCommandSlug, string>> = {};
  for (const [key, content] of Object.entries(rawWorkspaceFiles)) {
    if (!key.includes("/protocols/game-studio/commands/")) continue;
    const slug = key.split("/").pop()?.replace(/\.md$/i, "");
    if (!slug) continue;
    result[slug as StudioWorkflowCommandSlug] = parseDescription(content) ?? "Game Studio workflow command.";
  }
  return result;
}

const bundledWorkspaceFiles: WorkspacePackFile[] = Object.entries(rawWorkspaceFiles)
  .map(([sourcePath, content]) => {
    const path = mapWorkspacePath(sourcePath);
    return path ? { path, content } : null;
  })
  .filter((entry): entry is WorkspacePackFile => Boolean(entry))
  .sort((a, b) => a.path.localeCompare(b.path));

const agentDescriptions = parseAgentDescriptions();
const commandDescriptions = parseCommandDescriptions();

export const GAME_STUDIO_COMMAND_PATH_ROOT = ".protocols/game-studio/commands";
export const GAME_STUDIO_AGENT_PATH_ROOT = ".protocols/game-studio/agents";
export const GAME_STUDIO_PROTOCOL_ENTRY = ".protocols/game-studio/SKILL.md";
export const GAME_STUDIO_CONFIG_PATH = ".MAIN/game-studio/studio.config.json";
export const GAME_STUDIO_MANIFEST_PATH = ".MAIN/game-studio/pack-manifest.json";
export const GAME_STUDIO_PROTOCOL_ROOT = ".protocols/game-studio";
export const GAME_STUDIO_TEMPLATE_ROOT = ".MAIN/templates/game-studio";
export const GAME_STUDIO_RULE_ROOT = ".MAIN/rules/game-studio";
export const GAME_STUDIO_MAIN_ROOT = ".MAIN/game-studio";

export function getBundledGameStudioWorkspaceFiles(): WorkspacePackFile[] {
  return bundledWorkspaceFiles;
}

export function getGameStudioProtocolPathForCommand(slug: StudioWorkflowCommandSlug): string {
  return `${GAME_STUDIO_COMMAND_PATH_ROOT}/${slug}.md`;
}

export function getGameStudioProtocolPathForAgent(slug: NonAutoStudioAgentKey): string {
  return `${GAME_STUDIO_AGENT_PATH_ROOT}/${slug}.md`;
}

export function getGameStudioSlashCatalog(language: StudioCatalogLanguage = "en"): SlashCommandCatalogItem[] {
  return [
    ...buildWorkflowCommandCatalog(commandDescriptions, language),
    ...buildAgentCatalog(agentDescriptions, language),
  ];
}

export function createGameStudioPackManifest(): GameStudioPackManifest {
  return {
    version: GAME_STUDIO_PACK_VERSION,
    sourceRepo: GAME_STUDIO_SOURCE_REPO,
    sourceCommitOrTag: GAME_STUDIO_SOURCE_TAG,
    license: "MIT",
    commands: buildWorkflowCommandCatalog(commandDescriptions).map(
      (item) => item.canonicalCommand.slice(1).split(" ")[0] as StudioWorkflowCommandSlug,
    ),
    agents: buildAgentCatalog(agentDescriptions).map(
      (item) => item.canonicalCommand.replace("/agent ", "") as NonAutoStudioAgentKey,
    ),
    rules: bundledWorkspaceFiles
      .filter((file) => file.path.startsWith(".MAIN/rules/game-studio/"))
      .map((file) => file.path),
    templates: bundledWorkspaceFiles
      .filter((file) => file.path.startsWith(".MAIN/templates/game-studio/"))
      .map((file) => file.path),
    hooks: Object.entries(GAME_STUDIO_HOOKS.hooks).flatMap(([event, items]) =>
      items.map((item) => ({
        id: item.id,
        event: event as HookEventName,
        command: item.command,
        compatibility: "adapted" as const,
      })),
    ),
  };
}

const GAME_STUDIO_HOOK_IDS = new Set(
  Object.values(GAME_STUDIO_HOOKS.hooks).flatMap((items) => items.map((item) => item.id)),
);

const GAME_STUDIO_REMOVABLE_PATHS = [
  GAME_STUDIO_PROTOCOL_ROOT,
  GAME_STUDIO_TEMPLATE_ROOT,
  GAME_STUDIO_RULE_ROOT,
  GAME_STUDIO_MAIN_ROOT,
] as const;

function mergeHookDefinitions(
  existing: HookConfigFile | null,
  addition: HookConfigFile,
): HookConfigFile {
  const merged: HookConfigFile = {
    hooks: {
      SessionStart: [...(existing?.hooks.SessionStart ?? [])],
      UserPromptSubmit: [...(existing?.hooks.UserPromptSubmit ?? [])],
      PreToolUse: [...(existing?.hooks.PreToolUse ?? [])],
      PostToolUse: [...(existing?.hooks.PostToolUse ?? [])],
    },
  };

  (Object.keys(addition.hooks) as HookEventName[]).forEach((event) => {
    const seen = new Set(merged.hooks[event].map((hook) => hook.id));
    for (const hook of addition.hooks[event]) {
      if (seen.has(hook.id)) continue;
      merged.hooks[event].push(hook);
      seen.add(hook.id);
    }
  });

  return merged;
}

async function readHookConfigFile(): Promise<HookConfigFile | null> {
  try {
    const raw = await readFile(".MAIN/hooks.json");
    const parsed = JSON.parse(raw) as HookConfigFile;
    if (!parsed || typeof parsed !== "object" || !parsed.hooks) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function writeHookConfigFile(config: HookConfigFile): Promise<void> {
  await writeFile(".MAIN/hooks.json", `${JSON.stringify(config, null, 2)}\n`);
}

function removeGameStudioHooksFromConfig(config: HookConfigFile | null): HookConfigFile | null {
  if (!config) return null;

  return {
    hooks: {
      SessionStart: (config.hooks.SessionStart ?? []).filter((hook) => !GAME_STUDIO_HOOK_IDS.has(hook.id)),
      UserPromptSubmit: (config.hooks.UserPromptSubmit ?? []).filter((hook) => !GAME_STUDIO_HOOK_IDS.has(hook.id)),
      PreToolUse: (config.hooks.PreToolUse ?? []).filter((hook) => !GAME_STUDIO_HOOK_IDS.has(hook.id)),
      PostToolUse: (config.hooks.PostToolUse ?? []).filter((hook) => !GAME_STUDIO_HOOK_IDS.has(hook.id)),
    },
  };
}

function hasAnyHookDefinitions(config: HookConfigFile | null): boolean {
  if (!config) return false;
  return Object.values(config.hooks).some((items) => items.length > 0);
}

async function writePackFiles(files: WorkspacePackFile[]): Promise<void> {
  const chunkSize = 12;
  for (let i = 0; i < files.length; i += chunkSize) {
    const chunk = files.slice(i, i + chunkSize);
    await Promise.all(chunk.map((file) => writeFile(file.path, file.content)));
  }
}

export async function loadGameStudioConfig(): Promise<StudioConfig | null> {
  try {
    const raw = await readFile(GAME_STUDIO_CONFIG_PATH);
    const parsed = JSON.parse(raw) as Partial<StudioConfig>;
    return {
      ...createDefaultStudioConfig(parsed.activeStudioAgent ?? "studio_auto"),
      ...parsed,
      activeStudioAgent: (parsed.activeStudioAgent ?? "studio_auto") as StudioAgentKey,
    };
  } catch {
    return null;
  }
}

export async function ensureGameStudioWorkspaceInitialized(
  activeStudioAgent: StudioAgentKey = "studio_auto",
): Promise<StudioConfig> {
  const existing = await loadGameStudioConfig();
  if (existing) return existing;

  const manifest = createGameStudioPackManifest();
  const studioConfig = createDefaultStudioConfig(activeStudioAgent);
  const filesToWrite: WorkspacePackFile[] = [
    ...bundledWorkspaceFiles,
    {
      path: GAME_STUDIO_MANIFEST_PATH,
      content: `${JSON.stringify(manifest, null, 2)}\n`,
    },
    {
      path: GAME_STUDIO_CONFIG_PATH,
      content: `${JSON.stringify(studioConfig, null, 2)}\n`,
    },
  ];

  await writePackFiles(filesToWrite);
  const mergedHooks = mergeHookDefinitions(await readHookConfigFile(), GAME_STUDIO_HOOKS);
  await writeHookConfigFile(mergedHooks);
  return studioConfig;
}

export async function setGameStudioActiveAgent(activeStudioAgent: StudioAgentKey): Promise<StudioConfig> {
  const current = (await loadGameStudioConfig()) ?? createDefaultStudioConfig(activeStudioAgent);
  const next = {
    ...current,
    activeStudioAgent,
  };
  await writeFile(GAME_STUDIO_CONFIG_PATH, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

export async function removeGameStudioWorkspaceAssets(): Promise<void> {
  const existingHooks = await readHookConfigFile();
  const cleanedHooks = removeGameStudioHooksFromConfig(existingHooks);

  if (hasAnyHookDefinitions(cleanedHooks)) {
    await writeHookConfigFile(cleanedHooks as HookConfigFile);
  } else {
    await deleteWorkspacePath(".MAIN/hooks.json");
  }

  await Promise.all(GAME_STUDIO_REMOVABLE_PATHS.map((targetPath) => deleteWorkspacePath(targetPath)));
}

export function buildGameStudioEnvelopeForTurn(params: {
  originalText: string;
  nexusMode: NexusModeKey;
  activeStudioAgent: StudioAgentKey;
  command: PendingSlashCommand | null;
  responseLanguage?: "zh" | "en";
}): string {
  if (params.nexusMode !== "nexus_game_studio") {
    return params.originalText;
  }

  const commandPath = params.command?.type === "workflow"
    ? getGameStudioProtocolPathForCommand(params.command.slug)
    : null;
  const agentPath = params.activeStudioAgent !== "studio_auto"
    ? getGameStudioProtocolPathForAgent(params.activeStudioAgent as NonAutoStudioAgentKey)
    : params.command?.type === "agent"
    ? getGameStudioProtocolPathForAgent(params.command.slug)
    : null;

  return buildGameStudioUserEnvelope({
    originalText: params.originalText,
    activeStudioAgent: params.activeStudioAgent,
    command: params.command,
    commandPath,
    agentPath,
    responseLanguage: params.responseLanguage,
  });
}
