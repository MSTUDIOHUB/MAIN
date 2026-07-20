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
        if (candidate.endsWith(".ts") || candidate.endsWith(".tsx")) {
          return loadTranspiledModuleSync(candidate);
        }
      }
    }
    return localRequire(specifier);
  };
  new Function("exports", "module", "require", transpiled)(module.exports, module, runtimeRequire);
  moduleCache.set(normalizedPath, module.exports);
  return module.exports;
}

const { selectCapsulePublicCommentary } = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/lib/capsuleCommentary.ts"),
);
const { stripAssistantPublicProgress } = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/lib/assistantPublicProgress.ts"),
);

function commentaryBlock(overrides = {}) {
  return {
    id: overrides.id || 1,
    type: "agent",
    turnId: "turn-a",
    content: "我确认打开逻辑仍缺少一个分支，接下来会修复它。",
    streaming: false,
    hiddenProcess: false,
    visibility: "assistant_update",
    publicProgress: {
      schemaVersion: 1,
      kind: "assistant_commentary",
      source: "model_visible_content",
      sessionKey: "session-a",
      turnId: "turn-a",
      displayTurnId: "turn-a",
      runId: "run-a",
      parentRunId: null,
      createdAt: overrides.createdAt || 10,
    },
    ...overrides,
  };
}

function capsuleActivityBlock(overrides = {}) {
  const block = commentaryBlock({
    content: "让我先查看 src/main.js，确认文件打开事件入口。",
    streaming: true,
    visibility: "user_progress",
    ...overrides,
  });
  return {
    ...block,
    publicProgress: {
      ...block.publicProgress,
      kind: "capsule_activity",
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

test("Capsule selects only the latest exact-owner provider-visible commentary", () => {
  const selected = selectCapsulePublicCommentary({
    blocks: [
      commentaryBlock({ id: 1, content: "较早进展", createdAt: 10 }),
      commentaryBlock({ id: 2, content: "**当前判断**：打开路径还要处理空白标签页。", createdAt: 20 }),
    ],
    ...exactOwner,
  });

  assert.equal(selected, "当前判断：打开路径还要处理空白标签页。");
});

test("Capsule exposes exact-owner provisional activity while the model stream is live", () => {
  const selected = selectCapsulePublicCommentary({
    blocks: [capsuleActivityBlock()],
    ...exactOwner,
  });

  assert.equal(selected, "让我先查看 src/main.js，确认文件打开事件入口。");
});

test("Capsule rejects legacy, cross-owner, final, streaming, and hidden blocks", () => {
  const rejected = [
    { ...commentaryBlock(), publicProgress: undefined },
    commentaryBlock({ publicProgress: { ...commentaryBlock().publicProgress, sessionKey: "session-old" } }),
    commentaryBlock({ turnId: "turn-display-old" }),
    commentaryBlock({ publicProgress: { ...commentaryBlock().publicProgress, turnId: "turn-logical-old" } }),
    commentaryBlock({ publicProgress: { ...commentaryBlock().publicProgress, displayTurnId: "turn-display-old" } }),
    commentaryBlock({ publicProgress: { ...commentaryBlock().publicProgress, runId: "run-old" } }),
    commentaryBlock({ visibility: "assistant_final" }),
    commentaryBlock({ streaming: true }),
    capsuleActivityBlock({ visibility: "assistant_update" }),
    capsuleActivityBlock({ publicProgress: { ...capsuleActivityBlock().publicProgress, runId: "run-old" } }),
    commentaryBlock({ hiddenProcess: true }),
    commentaryBlock({ options: [{ label: "继续", value: "continue" }] }),
  ];

  for (const block of rejected) {
    assert.equal(selectCapsulePublicCommentary({ blocks: [block], ...exactOwner }), "");
  }
});

test("Capsule sanitizes protocol and reasoning blocks and applies a hard length bound", () => {
  const selected = selectCapsulePublicCommentary({
    blocks: [commentaryBlock({
      content: `<thinking>hidden chain of thought</thinking>\n\n公开进展：${"验证目标。".repeat(80)}`,
    })],
    ...exactOwner,
  });

  assert.doesNotMatch(selected, /hidden chain of thought|thinking/i);
  assert.match(selected, /^公开进展/);
  assert.ok(selected.length <= 180);
});

test("terminal promotion and later demotion cannot revive public progress", () => {
  const commentary = commentaryBlock();
  const finalBlock = {
    ...stripAssistantPublicProgress(commentary),
    content: "最终结论",
    visibility: "assistant_final",
  };
  const demotedFinal = {
    ...stripAssistantPublicProgress(finalBlock),
    visibility: "assistant_update",
  };

  assert.equal(finalBlock.publicProgress, undefined);
  assert.equal(demotedFinal.publicProgress, undefined);
  assert.equal(selectCapsulePublicCommentary({ blocks: [demotedFinal], ...exactOwner }), "");
});
