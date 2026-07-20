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
  prepareSubmitTurnDraft,
} = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/store/submitTurnDraft.ts"),
);

function conversationTurn(overrides = {}) {
  return {
    id: "turn-existing",
    userPrompt: "Fix camera shake",
    title: "Existing Camera Fix",
    mode: "edit",
    status: "executing",
    summary: "",
    blockIds: [],
    collapsed: false,
    createdAt: 1,
    ...overrides,
  };
}

function baseInput(overrides = {}) {
  return {
    sessionGet: () => ({
      _nextTaskId: () => 100,
      sessionsByWorkspace: {
        "/tmp/project": [
          {
            id: 7,
            title: "New Conversation",
            titleSource: "default",
            messages: [],
          },
        ],
      },
    }),
    conversationTurns: [conversationTurn()],
    text: "Fix the player camera shake",
    images: [],
    mentionSnapshot: [],
    attachedFilesSnapshot: [],
    runWorkspace: "/tmp/project",
    preferredLanguage: "en",
    effectiveRunIntent: "execute",
    isMainDebugShortcut: false,
    reuseCurrentTurn: false,
    reusableTurnId: null,
    ensuredSessionId: 7,
    sessionScopeKey: "/tmp/project",
    createTurnId: () => "turn-created",
    ...overrides,
  };
}

test("submit turn draft builds deterministic new turn context and title seed", () => {
  const draft = prepareSubmitTurnDraft(baseInput({
    mentionSnapshot: ["/tmp/project/src/App.tsx"],
    attachedFilesSnapshot: ["/tmp/project/docs/notes.md"],
    images: ["data:image/png;base64,abc"],
  }));

  assert.equal(draft.nextTaskId(), 100);
  assert.equal(draft.turnId, "turn-created");
  assert.equal(draft.uiDisplayTurnId, "turn-created");
  assert.equal(draft.currentImages.length, 1);
  assert.deepEqual(draft.turnInputContextSignals.mentionedFilePaths, ["/tmp/project/src/App.tsx"]);
  assert.deepEqual(draft.turnInputContextSignals.attachedFilePaths, ["/tmp/project/docs/notes.md"]);
  assert.deepEqual(draft.userContextItems.map((item) => item.kind), [
    "mention",
    "attachment",
    "image",
  ]);
  assert.equal(draft.titleDecision.shouldSeedSessionTitleForTurn, true);
  assert.equal(draft.titleDecision.seededSessionTitleCandidate, draft.titleDecision.turnTitle);
});

test("submit turn draft reuses existing turn title and UI parent", () => {
  const draft = prepareSubmitTurnDraft(baseInput({
    reuseCurrentTurn: true,
    reusableTurnId: "turn-existing",
    uiParentTurnId: "turn-parent",
    optionTurnTitle: "Ignored option title",
  }));

  assert.equal(draft.turnId, "turn-existing");
  assert.equal(draft.uiDisplayTurnId, "turn-parent");
  assert.equal(draft.existingTurn?.id, "turn-existing");
  assert.equal(draft.titleDecision.turnTitle, "Existing Camera Fix");
});

test("a rejected reuse override cannot create a duplicate logical Turn id", () => {
  const draft = prepareSubmitTurnDraft(baseInput({
    reuseCurrentTurn: false,
    reusableTurnId: null,
    turnIdOverride: "turn-existing",
  }));

  assert.equal(draft.turnId, "turn-created");
  assert.equal(draft.existingTurn, null);
});

test("a preallocated fresh Turn id remains valid for a new continuation", () => {
  const draft = prepareSubmitTurnDraft(baseInput({
    reuseCurrentTurn: false,
    reusableTurnId: null,
    turnIdOverride: "turn-preallocated",
  }));

  assert.equal(draft.turnId, "turn-preallocated");
});

test("durable admission adopts the exact open Turn and linked user block", () => {
  const draft = prepareSubmitTurnDraft(baseInput({
    conversationTurns: [conversationTurn({
      id: "turn-admitted",
      status: "awaiting_input",
      blockIds: [41],
    })],
    adoptExistingTurn: true,
    admittedUserBlockId: 41,
    turnIdOverride: "turn-admitted",
    createTurnId: () => {
      throw new Error("adoption must not allocate another Turn id");
    },
  }));

  assert.deepEqual(draft.adoptionDecision, {
    kind: "adopted",
    turnId: "turn-admitted",
    userBlockId: 41,
  });
  assert.equal(draft.turnId, "turn-admitted");
  assert.equal(draft.existingTurn?.id, "turn-admitted");
});

test("durable admission replaces its provisional title with an exact intent title", () => {
  const draft = prepareSubmitTurnDraft(baseInput({
    conversationTurns: [conversationTurn({
      id: "turn-admitted-debug",
      title: "/MDEBUG Terminal output is missing",
      status: "planning",
      blockIds: [43],
    })],
    text: "[MDEBUG: USER FEEDBACK SELF-REPAIR]",
    effectiveRunIntent: "plan",
    isMainDebugShortcut: true,
    optionTurnTitle: "MDEBUG：用户反馈自修复",
    adoptExistingTurn: true,
    admittedUserBlockId: 43,
    turnIdOverride: "turn-admitted-debug",
  }));

  assert.equal(draft.adoptionDecision.kind, "adopted");
  assert.equal(draft.titleDecision.turnTitle, "MDEBUG：用户反馈自修复");
});

test("durable admission deterministically rejects missing and closed Turns", () => {
  const missing = prepareSubmitTurnDraft(baseInput({
    adoptExistingTurn: true,
    admittedUserBlockId: 41,
    turnIdOverride: "turn-missing",
  }));
  assert.deepEqual(missing.adoptionDecision, {
    kind: "rejected",
    reason: "turn_not_found",
    turnId: "turn-missing",
    userBlockId: 41,
  });
  assert.equal(missing.existingTurn, null);

  const closed = prepareSubmitTurnDraft(baseInput({
    conversationTurns: [conversationTurn({
      id: "turn-closed",
      status: "done",
      blockIds: [42],
    })],
    adoptExistingTurn: true,
    admittedUserBlockId: 42,
    turnIdOverride: "turn-closed",
  }));
  assert.deepEqual(closed.adoptionDecision, {
    kind: "rejected",
    reason: "turn_closed",
    turnId: "turn-closed",
    userBlockId: 42,
  });
  assert.equal(closed.existingTurn, null);
});
