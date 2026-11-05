import test from "node:test";
import assert from "node:assert/strict";
import fsSync from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";

const require = createRequire(import.meta.url);
const workspaceRoot = process.cwd();

const transpiledModuleCache = new Map();

function loadTranspiledModuleSync(sourcePath) {
  const normalizedPath = path.resolve(sourcePath);
  if (transpiledModuleCache.has(normalizedPath)) {
    return transpiledModuleCache.get(normalizedPath);
  }

  const source = fsSync.readFileSync(normalizedPath, "utf8");
  const localRequire = createRequire(normalizedPath);
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
    fileName: normalizedPath,
  }).outputText;

  const module = { exports: {} };
  transpiledModuleCache.set(normalizedPath, module.exports);

  const runtimeRequire = (specifier) => {
    if (specifier.startsWith(".")) {
      const basePath = path.resolve(path.dirname(normalizedPath), specifier);
      const candidates = [
        basePath,
        `${basePath}.ts`,
        `${basePath}.tsx`,
        path.join(basePath, "index.ts"),
      ];

      for (const candidate of candidates) {
        if (!fsSync.existsSync(candidate)) continue;
        if (candidate.endsWith(".ts") || candidate.endsWith(".tsx")) {
          return loadTranspiledModuleSync(candidate);
        }
      }
    }

    return localRequire(specifier);
  };

  const factory = new Function("exports", "module", "require", transpiled);
  factory(module.exports, module, runtimeRequire);
  transpiledModuleCache.set(normalizedPath, module.exports);
  return module.exports;
}

const {
  LOCAL_PERSIST_SCHEMA_VERSION,
  normalizePersistedSkills,
  buildPersistedAppState,
  sanitizeHydratedLockedComposerIntent,
  stripLegacyRuntimeFieldsFromPersistedState,
  stripSessionsByWorkspaceForLocalPersist,
} = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/lib/persistState.ts"),
);

test("persist schema version is bumped for runtime payload slimming", () => {
  assert.equal(LOCAL_PERSIST_SCHEMA_VERSION, 2);
});

test("retired Gemini ZIP extension metadata cannot restore or persist a hidden capability", () => {
  const installations = [{ id: "extension-one", packageHash: "revision-one" }];
  const persisted = buildPersistedAppState({ geminiExtensions: installations, extensionMcpDiscovery: { old: { tools: ["stale"] } } });
  assert.equal(Object.hasOwn(persisted, "geminiExtensions"), false);
  assert.equal(Object.hasOwn(persisted, "extensionMcpDiscovery"), false);
  const hydrated = stripLegacyRuntimeFieldsFromPersistedState({ geminiExtensions: installations, extensionMcpDiscovery: { stale: {} }, skills: [] });
  assert.equal(Object.hasOwn(hydrated, "geminiExtensions"), false);
  assert.equal(Object.hasOwn(hydrated, "extensionMcpDiscovery"), false);
});

test("external Skill selections persist scoped references and default to manual admission", () => {
  const selections = [
    { entryPath: "/home/user/.agents/skills/review/SKILL.md", workspaceScope: null, mode: "auto", content: "DO_NOT_COPY_EXTERNAL_BODY" },
    { entryPath: "/home/user/.agents/skills/review/SKILL.md", workspaceScope: "/project", mode: "disabled" },
    { entryPath: "/home/user/.agents/skills/manual/SKILL.md", workspaceScope: "/project", mode: "manual" },
    { entryPath: "../untrusted", workspaceScope: null, mode: "auto" },
  ];
  const persisted = buildPersistedAppState({ externalSkillSelections: selections });
  assert.deepEqual(persisted.externalSkillSelections, selections.slice(0, 3).map(({ content, ...record }) => record));
  assert.doesNotMatch(JSON.stringify(persisted.externalSkillSelections), /DO_NOT_COPY_EXTERNAL_BODY/);
  assert.deepEqual(buildPersistedAppState({}).externalSkillSelections, []);
  assert.deepEqual(stripLegacyRuntimeFieldsFromPersistedState({}).externalSkillSelections, []);
});

test("external Skill source switches persist separately without removing individual selections", () => {
  const selections = [{ entryPath: "/home/user/.claude/skills/review/SKILL.md", workspaceScope: null, mode: "manual" }];
  const sources = { codex: true, claude: false, gemini: false, custom: true };
  const persisted = buildPersistedAppState({ externalSkillSelections: selections, externalSkillSources: sources });
  assert.deepEqual(persisted.externalSkillSources, sources);
  assert.deepEqual(persisted.externalSkillSelections, selections);
  assert.deepEqual(stripLegacyRuntimeFieldsFromPersistedState({ externalSkillSources: { claude: false } }).externalSkillSources,
    { codex: true, claude: false, gemini: true, custom: true });
  assert.deepEqual(buildPersistedAppState({}).externalSkillSources,
    { codex: true, claude: true, gemini: true, custom: true });
});

test("hydration drops stale Goal composer intent without changing other intents", () => {
  assert.equal(sanitizeHydratedLockedComposerIntent("goal"), null);
  assert.equal(sanitizeHydratedLockedComposerIntent("plan"), "plan");
  assert.equal(sanitizeHydratedLockedComposerIntent("analyze"), "analyze");
  assert.equal(sanitizeHydratedLockedComposerIntent(null), null);
});

test("buildPersistedAppState keeps lightweight config/session metadata only", () => {
  const persisted = buildPersistedAppState({
    config: { language: "zh" },
    skills: [{ id: "a" }],
    sessionsByWorkspace: {
      "/repo": [
        {
          id: 1,
          title: "Session A",
          storageStatus: "ok",
          recordingDisabled: false,
          messages: [{ id: 9, type: "user", content: "x" }],
          runtimeSnapshot: { taskFlow: [{ id: 9 }] },
        },
        {
          id: 2,
          title: "Session B",
          storageStatus: "temporary",
          recordingDisabled: true,
          messages: [{ id: 10, type: "user", content: "y" }],
          runtimeSnapshot: { taskFlow: [{ id: 10 }] },
        },
      ],
    },
    workspaces: [{ path: "/repo" }],
    activeSessionByWorkspace: { "/repo": 1 },
    currentWorkspace: "/repo",
    selectedWorkspace: "/repo",
    currentSessionId: 1,
    selectedMainModeKey: "main_mode",
    selectedNexusModeKey: "nexus_general",
    imageStudio: {
      config: {
        engine: "huggingface_space",
        endpoint: "https://hidream-ai-hidream-o1-image-dev.hf.space",
        defaultSize: { width: 1024, height: 1024 },
        aspectRatio: "1:1",
        steps: 28,
        guidanceScale: 0,
        promptRefine: true,
        seedMode: "random",
        seed: 32,
        outputDirectory: "",
      },
      status: {
        state: "unknown",
        message: "not checked",
        capabilities: {
          textToImage: true,
          imageToImage: true,
          progressPreview: true,
          cudaRequired: true,
        },
      },
      setupGuideOpen: false,
      activeJobId: null,
      activeStreamId: null,
    },
    activeStudioAgentKey: "studio_auto",
    gameStudioInitialized: true,
    preferredResponseLanguage: "zh",
    mcpServers: [{ name: "demo" }],
    sidebarWidth: 260,
    showWorkspaceTreePanel: false,
    workspaceTreePanelWidth: 320,
    rightPanelWidth: 520,
    taskFlow: [{ id: 1 }],
    conversationTurns: [{ id: "turn-1" }],
    input: "draft",
  });

  assert.equal(Object.prototype.hasOwnProperty.call(persisted, "taskFlow"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(persisted, "conversationTurns"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(persisted, "input"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(persisted, "selectedNexusModeKey"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(persisted, "activeStudioAgentKey"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(persisted, "gameStudioInitialized"), false);
  assert.equal(
    Object.prototype.hasOwnProperty.call(persisted.sessionsByWorkspace["/repo"][0], "runtimeSnapshot"),
    false,
  );
  assert.equal(
    Object.prototype.hasOwnProperty.call(persisted.sessionsByWorkspace["/repo"][0], "messages"),
    false,
  );
  assert.equal(persisted.imageStudio?.config?.endpoint, "https://hidream-ai-hidream-o1-image-dev.hf.space");
});

test("stripLegacyRuntimeFieldsFromPersistedState removes heavy runtime keys and stale session payloads", () => {
  const stripped = stripLegacyRuntimeFieldsFromPersistedState({
    taskFlow: [{ id: 1 }],
    agentMessages: [{ role: "assistant", content: "x" }],
    conversationTurns: [{ id: "t1" }],
    input: "draft",
    pendingSlashCommand: { type: "workflow", slug: "help" },
    activeStudioAgentKey: "studio_auto",
    gameStudioInitialized: true,
    lockedComposerIntent: "goal",
    sessionsByWorkspace: {
      "/repo": [
        {
          id: 1,
          title: "Persisted",
          storageStatus: "ok",
          recordingDisabled: false,
          messages: [{ id: 5 }],
          runtimeSnapshot: { taskFlow: [{ id: 5 }] },
        },
        {
          id: 2,
          title: "Disabled",
          storageStatus: "ok",
          recordingDisabled: true,
          messages: [{ id: 6 }],
          runtimeSnapshot: { taskFlow: [{ id: 6 }] },
        },
      ],
    },
  });

  assert.equal(Object.prototype.hasOwnProperty.call(stripped, "taskFlow"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(stripped, "agentMessages"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(stripped, "conversationTurns"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(stripped, "input"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(stripped, "pendingSlashCommand"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(stripped, "activeStudioAgentKey"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(stripped, "gameStudioInitialized"), false);
  assert.equal(stripped.lockedComposerIntent, null);
  assert.deepEqual(stripped.sessionsByWorkspace, {
    "/repo": [
      {
        id: 1,
        title: "Persisted",
        storageStatus: "ok",
        recordingDisabled: false,
      },
    ],
  });
});

test("legacy hydration preserves non-Goal composer intent", () => {
  const stripped = stripLegacyRuntimeFieldsFromPersistedState({
    lockedComposerIntent: "plan",
  });

  assert.equal(stripped.lockedComposerIntent, "plan");
});

test("stripSessionsByWorkspaceForLocalPersist keeps temporary recording-disabled sessions", () => {
  const sessions = stripSessionsByWorkspaceForLocalPersist({
    "/repo": [
      { id: 1, storageStatus: "ok", recordingDisabled: true },
      { id: 2, storageStatus: "temporary", recordingDisabled: true, messages: [{ id: 1 }] },
    ],
  });

  assert.deepEqual(sessions, {
    "/repo": [
      { id: 2, storageStatus: "temporary", recordingDisabled: true },
    ],
  });
});


test("legacy tool descriptions migrate to rules without losing content or invocation policy", () => {
  const legacy = { id: "legacy", type: "tool", name: "Checklist", content: "Keep exact rules.\n", active: false, allowImplicitInvocation: false, toolParameters: '{"type":"object"}' };
  const current = { id: "current", type: "instruction", content: "Other rules" };
  const result = normalizePersistedSkills([legacy, current]);
  assert.deepEqual(result[0], { id: "legacy", type: "instruction", name: "Checklist", content: "Keep exact rules.\n", active: false, allowImplicitInvocation: false });
  assert.equal(result[1], current);
  assert.equal(legacy.type, "tool");
  assert.equal(buildPersistedAppState({ skills: [legacy] }).skills[0].type, "instruction");
  assert.equal(stripLegacyRuntimeFieldsFromPersistedState({ skills: [legacy] }).skills[0].type, "instruction");
});

test("GitHub package provenance persists only public repository/ref fields without changing user policy", () => {
  const githubSource = {
    repository: "Owner/skills", branch: "feature/docs",
    token: "PRIVATE_GITHUB_TOKEN", headers: { authorization: "PRIVATE_AUTHORIZATION" },
    url: "https://user:PRIVATE_PASSWORD@github.com/Owner/skills", downloadedBody: "DO_NOT_COPY_BODY",
  };
  const original = {
    id: "keep-id", type: "package", name: "Keep name", desc: "Keep description", content: "",
    packageStorage: { kind: "global", packageId: "a".repeat(64) },
    active: false, allowImplicitInvocation: false, githubSource,
  };
  for (const records of [
    normalizePersistedSkills([original]),
    buildPersistedAppState({ skills: [original] }).skills,
    stripLegacyRuntimeFieldsFromPersistedState({ skills: [original] }).skills,
  ]) {
    assert.deepEqual(records[0], { ...original, githubSource: { repository: "Owner/skills", branch: "feature/docs" } });
    assert.notEqual(records[0].githubSource, githubSource);
    assert.doesNotMatch(JSON.stringify(records), /PRIVATE_|DO_NOT_COPY_BODY/);
  }
  assert.equal(original.githubSource, githubSource);
  assert.equal(original.githubSource.token, "PRIVATE_GITHUB_TOKEN", "normalization must not mutate the caller's object");
});

test("invalid GitHub sources and sources attached to rules or legacy paths cannot restore an update authority", () => {
  const source = { repository: "owner/skills", branch: "main" };
  const globalRecord = { id: "global", type: "package", packageStorage: { kind: "global", packageId: "a".repeat(64) } };
  const invalidSources = [
    null, "https://github.com/owner/skills", [], {}, { repository: "owner/skills" },
    { repository: "https://github.com/owner/skills", branch: "main" },
    { repository: "user:secret@github.com/owner/skills", branch: "main" },
    { repository: "owner/../skills", branch: "main" }, { repository: "/owner/skills", branch: "main" },
    { repository: " owner/skills", branch: "main" }, { repository: "owner/skills", branch: 1 },
    ...["../main", "/main", "main/", "feature//docs", "main?token=x", "main#x", "main%2fsecret", "main\\secret", "main\n"].map((branch) => ({ repository: "owner/skills", branch })),
  ];
  const records = [
    ...invalidSources.map((githubSource) => ({ ...globalRecord, githubSource })),
    { id: "rule", type: "instruction", githubSource: source },
    { id: "legacy", type: "package", packagePath: ".protocols/legacy", workspaceScope: "/repo", githubSource: source },
  ];
  for (const normalized of [
    normalizePersistedSkills(records),
    buildPersistedAppState({ skills: records }).skills,
    stripLegacyRuntimeFieldsFromPersistedState({ skills: records }).skills,
  ]) {
    assert.equal(normalized.length, records.length, "bad provenance does not delete the user's registration");
    assert.ok(normalized.every((record) => !Object.hasOwn(record, "githubSource")));
    assert.equal(normalized.at(-2).type, "instruction");
    assert.equal(normalized.at(-1).packagePath, ".protocols/legacy");
  }
});
