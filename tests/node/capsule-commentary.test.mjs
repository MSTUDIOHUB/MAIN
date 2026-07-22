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
  const transpiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    fileName: normalizedPath,
  }).outputText;
  const module = { exports: {} };
  moduleCache.set(normalizedPath, module.exports);
  const localRequire = createRequire(normalizedPath);
  const runtimeRequire = (specifier) => {
    if (specifier.startsWith(".")) {
      const basePath = path.resolve(path.dirname(normalizedPath), specifier);
      for (const candidate of [basePath, `${basePath}.ts`, `${basePath}.tsx`, path.join(basePath, "index.ts")]) {
        if (!fsSync.existsSync(candidate)) continue;
        if (candidate.endsWith(".ts") || candidate.endsWith(".tsx")) return loadTranspiledModuleSync(candidate);
      }
    }
    return localRequire(specifier);
  };
  new Function("exports", "module", "require", transpiled)(module.exports, module, runtimeRequire);
  moduleCache.set(normalizedPath, module.exports);
  return module.exports;
}

const { selectCapsuleLiveGuidance } = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/lib/capsuleCommentary.ts"),
);
const { stripAssistantPublicProgress } = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/lib/assistantPublicProgress.ts"),
);

function activityBlock(overrides = {}) {
  return {
    id: overrides.id || 1,
    type: "agent",
    turnId: "turn-a",
    content: "让我先查看 src/main.js，确认文件打开事件入口。",
    streaming: true,
    hiddenProcess: false,
    visibility: "user_progress",
    publicProgress: {
      schemaVersion: 1,
      kind: "capsule_activity",
      source: "model_visible_content",
      sessionKey: "session-a",
      turnId: "turn-a",
      displayTurnId: "turn-a",
      runId: "run-a",
      parentRunId: null,
      createdAt: overrides.createdAt || 20,
    },
    ...overrides,
  };
}

function commentaryBlock(overrides = {}) {
  const block = activityBlock({
    content: "已确认打开逻辑缺少空白标签页分支。",
    streaming: false,
    visibility: "assistant_update",
    ...overrides,
  });
  return {
    ...block,
    publicProgress: {
      ...block.publicProgress,
      kind: "assistant_commentary",
      ...(overrides.publicProgress || {}),
    },
  };
}

const exactOwner = {
  sessionKey: "session-a",
  logicalTurnId: "turn-a",
  displayTurnId: "turn-a",
  runId: "run-a",
};

test("Capsule selects only the latest exact-owner transient guidance", () => {
  const selected = selectCapsuleLiveGuidance({
    blocks: [
      activityBlock({ id: 1, content: "让我先读取 src/main.js。", createdAt: 10 }),
      activityBlock({ id: 2, content: "接下来我会检查保存事件的返回路径。", createdAt: 20 }),
    ],
    ...exactOwner,
  });

  assert.equal(selected, "接下来我会检查保存事件的返回路径。");
});

test("settled ChatArea commentary is never eligible for Capsule", () => {
  assert.equal(selectCapsuleLiveGuidance({
    blocks: [commentaryBlock()],
    ...exactOwner,
  }), "");
});

test("a newer structured runtime event invalidates stale model guidance", () => {
  assert.equal(selectCapsuleLiveGuidance({
    blocks: [activityBlock({ createdAt: 20 })],
    notOlderThan: 21,
    ...exactOwner,
  }), "");
  assert.equal(selectCapsuleLiveGuidance({
    blocks: [activityBlock({ createdAt: 20 })],
    notOlderThan: 20,
    ...exactOwner,
  }), "让我先查看 src/main.js，确认文件打开事件入口。");
});

test("Capsule rejects raw tool-name preambles and defers to structured guidance", () => {
  assert.equal(selectCapsuleLiveGuidance({
    blocks: [activityBlock({ content: "让我 apply_patch 来修复：" })],
    ...exactOwner,
  }), "");
});

test("Capsule rejects legacy, cross-owner, final, hidden, and option blocks", () => {
  const rejected = [
    { ...activityBlock(), publicProgress: undefined },
    activityBlock({ publicProgress: { ...activityBlock().publicProgress, sessionKey: "session-old" } }),
    activityBlock({ turnId: "turn-display-old" }),
    activityBlock({ publicProgress: { ...activityBlock().publicProgress, turnId: "turn-logical-old" } }),
    activityBlock({ publicProgress: { ...activityBlock().publicProgress, displayTurnId: "turn-display-old" } }),
    activityBlock({ publicProgress: { ...activityBlock().publicProgress, runId: "run-old" } }),
    activityBlock({ visibility: "assistant_final" }),
    activityBlock({ hiddenProcess: true }),
    activityBlock({ options: [{ label: "继续", value: "continue" }] }),
  ];

  for (const block of rejected) {
    assert.equal(selectCapsuleLiveGuidance({ blocks: [block], ...exactOwner }), "");
  }
});

test("Capsule accepts a child logical Turn only through its exact display-Turn projection", () => {
  const childOwner = {
    sessionKey: "session-a",
    logicalTurnId: "turn-child",
    displayTurnId: "turn-a",
    runId: "run-child",
  };
  const childProgress = activityBlock({
    content: "接下来我会检查保存路径的返回值。",
    publicProgress: {
      ...activityBlock().publicProgress,
      turnId: "turn-child",
      displayTurnId: "turn-a",
      runId: "run-child",
    },
  });

  assert.equal(selectCapsuleLiveGuidance({
    blocks: [childProgress],
    ...childOwner,
  }), "接下来我会检查保存路径的返回值。");

  const wrongLogicalOwner = {
    ...childProgress,
    publicProgress: { ...childProgress.publicProgress, turnId: "turn-sibling" },
  };
  assert.equal(selectCapsuleLiveGuidance({
    blocks: [wrongLogicalOwner],
    ...childOwner,
  }), "");
});

test("terminal promotion and later demotion cannot revive Capsule progress", () => {
  const finalBlock = {
    ...stripAssistantPublicProgress(activityBlock()),
    content: "最终结论",
    visibility: "assistant_final",
  };
  const demotedFinal = { ...finalBlock, visibility: "user_progress" };

  assert.equal(finalBlock.publicProgress, undefined);
  assert.equal(selectCapsuleLiveGuidance({ blocks: [demotedFinal], ...exactOwner }), "");
});
