import test from "node:test";
import assert from "node:assert/strict";
import fsSync from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

import ts from "typescript";

const workspaceRoot = process.cwd();
const moduleCache = new Map();

function loadTranspiledModuleSync(sourcePath) {
  const normalizedPath = path.resolve(sourcePath);
  if (moduleCache.has(normalizedPath)) return moduleCache.get(normalizedPath);

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
  moduleCache.set(normalizedPath, module.exports);
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
  moduleCache.set(normalizedPath, module.exports);
  return module.exports;
}

const {
  applySubmitSeedSessionTitle,
  startSubmitSemanticMetadataEffect,
} = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/store/submitTitleEffects.ts"),
);

function createDecision(overrides = {}) {
  return {
    expectedTurnId: "turn-1",
    expectedTurnPrompt: "修复标题同步",
    expectedSessionId: 7,
    sessionScopeKey: "workspace-a",
    titleIntentSignature: "execute|修复标题同步",
    seededSessionTitleCandidate: "修复标题同步",
    request: {
      input: "修复标题同步",
      intent: "execute",
      language: "zh",
      config: {},
      contextSignals: {
        imageParts: 0,
        mentionedFilePaths: [],
        attachedFilePaths: [],
      },
    },
    ...overrides,
  };
}

test("submit title effects seed visible sessions with sanitized task blocks", () => {
  const updates = [];
  const seeded = applySubmitSeedSessionTitle({
    isHidden: false,
    shouldSeedSessionTitleForTurn: true,
    ensuredSessionId: 7,
    sessionScopeKey: "workspace-a",
    turnTitle: "修复标题同步",
    titleIntentSignature: "sig",
    taskFlow: [{ id: 1, type: "user", content: "raw" }],
    sessionRecordingEnabled: false,
    sanitizeTaskBlocksForPersist: (blocks) => blocks.map((block) => ({ ...block, persisted: true })),
    updateSession: (scopeKey, sessionId, patch) => updates.push({ scopeKey, sessionId, patch }),
  });

  assert.equal(seeded, true);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].scopeKey, "workspace-a");
  assert.equal(updates[0].sessionId, 7);
  assert.deepEqual(updates[0].patch, {
    title: "修复标题同步",
    titleSource: "local_seed",
    titleIntentSignature: "sig",
    active: true,
    messages: [{ id: 1, type: "user", content: "raw", persisted: true }],
    storageStatus: "temporary",
    recordingDisabled: true,
  });
});

test("submit title effects do not seed hidden or missing sessions", () => {
  const updates = [];
  const seeded = applySubmitSeedSessionTitle({
    isHidden: true,
    shouldSeedSessionTitleForTurn: true,
    ensuredSessionId: 7,
    sessionScopeKey: "workspace-a",
    turnTitle: "修复标题同步",
    titleIntentSignature: "sig",
    taskFlow: [],
    sessionRecordingEnabled: true,
    sanitizeTaskBlocksForPersist: (blocks) => blocks,
    updateSession: (scopeKey, sessionId, patch) => updates.push({ scopeKey, sessionId, patch }),
  });

  assert.equal(seeded, false);
  assert.equal(updates.length, 0);
});

test("submit semantic metadata effect updates current turn and seeded session", async () => {
  const turnUpdates = [];
  const sessionUpdates = [];
  const logs = [];
  const completion = startSubmitSemanticMetadataEffect({
    decision: createDecision(),
    async requestSemanticTurnMetadata() {
      return { title: "语义标题", summary: "语义摘要" };
    },
    getLatestSnapshot: () => ({
      conversationTurns: [{ id: "turn-1", userPrompt: "修复标题同步" }],
      sessionsByWorkspace: {
        "workspace-a": [{ id: 7, title: "修复标题同步", titleSource: "local_seed" }],
      },
    }),
    updateConversationTurn: (turnId, patch) => turnUpdates.push({ turnId, patch }),
    updateSession: (scopeKey, sessionId, patch) => sessionUpdates.push({ scopeKey, sessionId, patch }),
    logStoreEvent: (event, data) => logs.push({ event, data }),
    runSessionKey: "workspace-a:7",
    runWorkspace: "/repo",
    nowMs: () => 12345,
  });

  assert.ok(completion);
  await completion;
  assert.deepEqual(turnUpdates, [
    { turnId: "turn-1", patch: { title: "语义标题", intentSummary: "语义摘要" } },
  ]);
  assert.deepEqual(sessionUpdates, [
    {
      scopeKey: "workspace-a",
      sessionId: 7,
      patch: {
        title: "语义标题",
        titleSource: "semantic",
        semanticTitleUpdatedAt: 12345,
        titleIntentSignature: "execute|修复标题同步",
        active: true,
      },
    },
  ]);
  assert.equal(logs.length, 0);
});

test("submit semantic metadata effect ignores stale callback targets", async () => {
  const turnUpdates = [];
  const sessionUpdates = [];
  const completion = startSubmitSemanticMetadataEffect({
    decision: createDecision(),
    async requestSemanticTurnMetadata() {
      return { title: "语义标题", summary: "语义摘要" };
    },
    getLatestSnapshot: () => ({
      conversationTurns: [{ id: "turn-1", userPrompt: "用户改了输入" }],
      sessionsByWorkspace: {
        "workspace-a": [{ id: 7, title: "修复标题同步", titleSource: "local_seed" }],
      },
    }),
    updateConversationTurn: (turnId, patch) => turnUpdates.push({ turnId, patch }),
    updateSession: (scopeKey, sessionId, patch) => sessionUpdates.push({ scopeKey, sessionId, patch }),
    logStoreEvent: () => {},
    runSessionKey: "workspace-a:7",
    runWorkspace: "/repo",
  });

  await completion;
  assert.equal(turnUpdates.length, 0);
  assert.equal(sessionUpdates.length, 0);
});

test("submit semantic metadata effect keeps manual session titles while updating the turn", async () => {
  const turnUpdates = [];
  const sessionUpdates = [];
  const logs = [];
  const completion = startSubmitSemanticMetadataEffect({
    decision: createDecision(),
    async requestSemanticTurnMetadata() {
      return { title: "语义标题", summary: "语义摘要" };
    },
    getLatestSnapshot: () => ({
      conversationTurns: [{ id: "turn-1", userPrompt: "修复标题同步" }],
      sessionsByWorkspace: {
        "workspace-a": [{ id: 7, title: "用户自定义标题", titleSource: "manual" }],
      },
    }),
    updateConversationTurn: (turnId, patch) => turnUpdates.push({ turnId, patch }),
    updateSession: (scopeKey, sessionId, patch) => sessionUpdates.push({ scopeKey, sessionId, patch }),
    logStoreEvent: (event, data) => logs.push({ event, data }),
    runSessionKey: "workspace-a:7",
    runWorkspace: "/repo",
  });

  await completion;
  assert.deepEqual(turnUpdates, [
    { turnId: "turn-1", patch: { title: "语义标题", intentSummary: "语义摘要" } },
  ]);
  assert.equal(sessionUpdates.length, 0);
  assert.equal(logs[0].event, "semantic_title_session_update_skipped");
  assert.equal(logs[0].data.titleSource, "manual");
});
