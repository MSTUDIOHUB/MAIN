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
  buildPersistedAppState,
  stripLegacyRuntimeFieldsFromPersistedState,
  stripSessionsByWorkspaceForLocalPersist,
} = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/lib/persistState.ts"),
);

test("persist schema version is bumped for runtime payload slimming", () => {
  assert.equal(LOCAL_PERSIST_SCHEMA_VERSION, 2);
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
  assert.equal(
    Object.prototype.hasOwnProperty.call(persisted.sessionsByWorkspace["/repo"][0], "runtimeSnapshot"),
    false,
  );
  assert.equal(
    Object.prototype.hasOwnProperty.call(persisted.sessionsByWorkspace["/repo"][0], "messages"),
    false,
  );
});

test("stripLegacyRuntimeFieldsFromPersistedState removes heavy runtime keys and stale session payloads", () => {
  const stripped = stripLegacyRuntimeFieldsFromPersistedState({
    taskFlow: [{ id: 1 }],
    agentMessages: [{ role: "assistant", content: "x" }],
    conversationTurns: [{ id: "t1" }],
    input: "draft",
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
