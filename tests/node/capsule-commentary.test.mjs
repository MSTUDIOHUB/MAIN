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

const {
  selectCapsulePublicCommentary,
  selectCapsuleThoughtSummary,
} = loadTranspiledModuleSync(
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

test("Capsule thought summary keeps complete Markdown from the latest substantive exact-owner update", () => {
  const selected = selectCapsuleThoughtSummary({
    blocks: [commentaryBlock({
      content: [
        "## 当前判断",
        "- 已确认重复展示来自同一条 `publicProgress` 投影。",
        "- **Capsule 应只保留精简判断**。",
      ].join("\n"),
    })],
    language: "zh",
    ...exactOwner,
  });

  assert.match(selected, /^## 当前判断/m);
  assert.match(selected, /`publicProgress`/);
  assert.match(selected, /\*\*Capsule 应只保留精简判断\*\*/);
  assert.doesNotMatch(selected, /…$/);
});

test("Capsule current flow prefers the latest typed model preamble without duplicating structured activity", () => {
  const selected = selectCapsuleThoughtSummary({
    blocks: [
      commentaryBlock({
        id: 1,
        content: "已确认保存失败来自路径返回值解析错误，需要统一提取逻辑。",
        createdAt: 10,
      }),
      capsuleActivityBlock({
        id: 2,
        content: "让我 apply_patch 来修复：",
        createdAt: 20,
      }),
    ],
    language: "zh",
    ...exactOwner,
  });

  assert.equal(selected, "让我 apply_patch 来修复：");
});

test("Capsule current flow rejects a thin preamble misclassified as settled commentary", () => {
  const selected = selectCapsuleThoughtSummary({
    blocks: [commentaryBlock({ content: "让我 sed 来修复：" })],
    language: "zh",
    ...exactOwner,
  });

  assert.equal(selected, "");
});

test("Capsule thought summary strips hidden reasoning and rejects cross-Run content", () => {
  const block = commentaryBlock({
    content: "<thinking>private chain</thinking>\n\n已确认 Capsule 应显示公开阶段判断。",
  });
  const selected = selectCapsuleThoughtSummary({
    blocks: [block],
    language: "zh",
    ...exactOwner,
  });

  assert.equal(selected, "已确认 Capsule 应显示公开阶段判断。");
  assert.doesNotMatch(selected, /private chain|thinking/i);
  assert.equal(selectCapsuleThoughtSummary({
    blocks: [block],
    language: "zh",
    ...exactOwner,
    runId: "run-old",
  }), "");
});

test("Capsule accepts a child logical Turn only through its exact display-Turn projection", () => {
  const childOwner = {
    sessionKey: "session-a",
    logicalTurnId: "turn-child",
    displayTurnId: "turn-a",
    runId: "run-child",
  };
  const childProgress = commentaryBlock({
    content: "已确认保存失败来自路径返回值解析错误，需要统一提取逻辑。",
    publicProgress: {
      ...commentaryBlock().publicProgress,
      turnId: "turn-child",
      displayTurnId: "turn-a",
      runId: "run-child",
    },
  });

  assert.equal(selectCapsulePublicCommentary({
    blocks: [childProgress],
    ...childOwner,
  }), "已确认保存失败来自路径返回值解析错误，需要统一提取逻辑。");
  assert.equal(selectCapsuleThoughtSummary({
    blocks: [childProgress],
    language: "zh",
    ...childOwner,
  }), "已确认保存失败来自路径返回值解析错误，需要统一提取逻辑。");

  const wrongLogicalOwner = {
    ...childProgress,
    publicProgress: {
      ...childProgress.publicProgress,
      turnId: "turn-sibling",
    },
  };
  assert.equal(selectCapsulePublicCommentary({
    blocks: [wrongLogicalOwner],
    ...childOwner,
  }), "");
  assert.equal(selectCapsuleThoughtSummary({
    blocks: [wrongLogicalOwner],
    language: "zh",
    ...childOwner,
  }), "");
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
  assert.equal(selectCapsuleThoughtSummary({
    blocks: [demotedFinal],
    language: "zh",
    ...exactOwner,
  }), "");
});
