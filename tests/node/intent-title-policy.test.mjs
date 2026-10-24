import test from "node:test";
import assert from "node:assert/strict";
import fsSync from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

import ts from "typescript";

const workspaceRoot = process.cwd();
const transpiledModuleCache = new Map();

function loadTranspiledModuleSync(sourcePath) {
  const normalizedPath = path.resolve(sourcePath);
  if (transpiledModuleCache.has(normalizedPath)) {
    return transpiledModuleCache.get(normalizedPath);
  }

  const source = fsSync.readFileSync(normalizedPath, "utf8");
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
    fileName: normalizedPath,
  }).outputText;

  const module = { exports: {} };
  transpiledModuleCache.set(normalizedPath, module.exports);
  const localRequire = createRequire(normalizedPath);
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

function loadIntentTitlePolicyModule() {
  return loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/intentTitlePolicy.ts"));
}

const {
  canUpdateSeedSessionTitle,
  isSemanticTurnMetadataCallbackCurrent,
  parseIntentTitleCandidate,
  shouldRequestSemanticTurnMetadataForTurn,
  shouldSeedSessionTitle,
} = loadIntentTitlePolicyModule();

test("semantic turn metadata request triggers for every fresh turn in supported MAIN modes", () => {
  assert.equal(
    shouldRequestSemanticTurnMetadataForTurn({
      input: "把登录错误修复掉",
      hidden: false,
      reuseCurrentTurn: false,
      turnTitle: "",
      mainModeKey: "chat",
    }),
    true,
  );

  assert.equal(
    shouldRequestSemanticTurnMetadataForTurn({
      input: "把登录错误修复掉",
      hidden: false,
      reuseCurrentTurn: false,
      turnTitle: "",
      mainModeKey: "image_studio",
    }),
    true,
  );

  assert.equal(
    shouldRequestSemanticTurnMetadataForTurn({
      input: "  ",
      hidden: false,
      reuseCurrentTurn: false,
    }),
    false,
  );

  assert.equal(
    shouldRequestSemanticTurnMetadataForTurn({
      input: "继续",
      hidden: true,
      reuseCurrentTurn: false,
    }),
    false,
  );

  assert.equal(
    shouldRequestSemanticTurnMetadataForTurn({
      input: "继续",
      hidden: false,
      reuseCurrentTurn: true,
    }),
    false,
  );

  assert.equal(
    shouldRequestSemanticTurnMetadataForTurn({
      input: "继续",
      hidden: false,
      reuseCurrentTurn: false,
      turnTitle: "意图确认",
    }),
    false,
  );
});

test("session title seeding only applies in first-turn seed states", () => {
  assert.equal(shouldSeedSessionTitle({ title: "", messages: [{ id: 1 }] }), true);
  assert.equal(shouldSeedSessionTitle({ title: "New Conversation", messages: [{ id: 2 }] }), true);
  assert.equal(shouldSeedSessionTitle({ title: "新聊天", messages: [{ id: 3 }] }), true);
  assert.equal(shouldSeedSessionTitle({ title: "自定义标题", messages: [] }), true);
  assert.equal(shouldSeedSessionTitle({ title: "修复 Plan 流程", titleSource: "local_seed", messages: [] }), true);
  assert.equal(shouldSeedSessionTitle({ title: "修复 Plan 流程", titleSource: "semantic", messages: [] }), false);
  assert.equal(shouldSeedSessionTitle({ title: "登录模块修复", messages: [{ id: 4 }] }), false);
});

test("seeded sidebar title updates only while the seed title remains unchanged", () => {
  assert.equal(
    canUpdateSeedSessionTitle({
      session: { title: "New Chat" },
      seededTitle: "占位标题",
    }),
    true,
  );

  assert.equal(
    canUpdateSeedSessionTitle({
      session: { title: "占位标题" },
      seededTitle: "占位标题",
    }),
    true,
  );

  assert.equal(
    canUpdateSeedSessionTitle({
      session: { title: "模型原始占位", titleSource: "local_seed", messages: [{ id: 1 }] },
      seededTitle: "其它占位",
    }),
    true,
  );

  assert.equal(
    canUpdateSeedSessionTitle({
      session: { title: "用户手动改名" },
      seededTitle: "占位标题",
    }),
    false,
  );

  assert.equal(
    canUpdateSeedSessionTitle({
      session: { title: "语义标题", titleSource: "semantic" },
      seededTitle: "占位标题",
    }),
    false,
  );
});

test("stale semantic title callbacks are dropped by turn/prompt/session guards", () => {
  assert.equal(
    isSemanticTurnMetadataCallbackCurrent({
      expectedTurnId: "turn-1",
      expectedUserPrompt: "修复登录按钮",
      expectedSessionId: 101,
      turn: { id: "turn-1", userPrompt: "修复登录按钮" },
      session: { id: 101 },
    }),
    true,
  );

  assert.equal(
    isSemanticTurnMetadataCallbackCurrent({
      expectedTurnId: "turn-1",
      expectedUserPrompt: "修复登录按钮",
      expectedSessionId: 101,
      turn: { id: "turn-1", userPrompt: "修复支付按钮" },
      session: { id: 101 },
    }),
    false,
  );

  assert.equal(
    isSemanticTurnMetadataCallbackCurrent({
      expectedTurnId: "turn-1",
      expectedUserPrompt: "修复登录按钮",
      expectedSessionId: 101,
      turn: { id: "turn-2", userPrompt: "修复登录按钮" },
      session: { id: 101 },
    }),
    false,
  );

  assert.equal(
    isSemanticTurnMetadataCallbackCurrent({
      expectedTurnId: "turn-1",
      expectedUserPrompt: "修复登录按钮",
      expectedSessionId: 101,
      turn: { id: "turn-1", userPrompt: "修复登录按钮" },
      session: null,
    }),
    false,
  );
});

test("intent title parser accepts loose local model title output", () => {
  const parsed = parseIntentTitleCandidate({
    content: "标题：重写 Plan 流程\n摘要：将默认计划产物切换到 plan.md",
  });

  assert.equal(parsed.source, "loose_key_value");
  assert.equal(parsed.metadata.title, "重写 Plan 流程");
  assert.equal(parsed.metadata.summary, "将默认计划产物切换到 plan.md");
});

test("intent title parser falls back to reasoning-only local output", () => {
  const parsed = parseIntentTitleCandidate({
    content: "",
    reasoning: '{"title":"修复标题同步","summary":"让 turn 和 session 共用同一标题结果"}',
  });

  assert.equal(parsed.source, "reasoning_json");
  assert.equal(parsed.metadata.title, "修复标题同步");
  assert.equal(parsed.metadata.summary, "让 turn 和 session 共用同一标题结果");
});

test("intent title parser can use a first-line title and reports failures", () => {
  const firstLine = parseIntentTitleCandidate({
    content: "Plan 审批链路收束\n更多解释文本",
  });
  const failed = parseIntentTitleCandidate({ content: "", reasoning: "" });

  assert.equal(firstLine.source, "first_line");
  assert.equal(firstLine.metadata.title, "Plan 审批链路收束");
  assert.equal(failed.source, "none");
  assert.equal(failed.failureReason, "empty_model_output");
});

test("intent title parser rejects malformed structured output instead of treating it as a title", () => {
  const malformedOutputs = [
    '{"title":"查询 structuredClone transfer',
    '{"title":"Fix cloning","summary":',
    '{"title":"Fix cloning",}',
    '[{"title":"Fix cloning"}]',
    '"title": "Fix cloning"',
    '```json\n{"title":"Fix cloning"',
  ];

  for (const content of malformedOutputs) {
    const parsed = parseIntentTitleCandidate({ content });
    assert.equal(parsed.metadata, null, content);
    assert.equal(parsed.source, "none", content);
    assert.equal(parsed.failureReason, "unparseable_title_output", content);
  }
});

test("intent title parser never promotes reasoning prose or loose reasoning labels to metadata", () => {
  for (const reasoning of [
    "我们需要回答用户问题：如果我使用海外的三星 fold8，是否可以配对国行手表？",
    "We need to answer whether the devices can pair, then choose a concise title.",
    "まずユーザーの質問を整理して、タイトルを選びます。",
    "title: Device pairing\nsummary: Check compatibility",
    'I will return {"title":"Device pairing","summary":"Check compatibility"} after choosing the topic.',
  ]) {
    const parsed = parseIntentTitleCandidate({ reasoning });
    assert.equal(parsed.metadata, null, reasoning);
    assert.equal(parsed.source, "none", reasoning);
  }
});

test("intent title parser excludes hidden reasoning tags including interrupted thinking", () => {
  for (const content of [
    '<think>{"title":"Hidden deliberation"}</think>',
    "<think>We need to choose a title before returning JSON.",
    "<analysis>まず質問を整理します。",
  ]) {
    assert.equal(parseIntentTitleCandidate({ content }).metadata, null, content);
  }

  const visible = parseIntentTitleCandidate({
    content: '<think>{"title":"Hidden deliberation"}</think>\n{"title":"Device compatibility","summary":"Verify pairing support"}',
  });
  assert.equal(visible.source, "json");
  assert.equal(visible.metadata.title, "Device compatibility");
});

test("intent title parser preserves visible plain titles and complete fenced JSON compatibility", () => {
  const title = parseIntentTitleCandidate({ content: "デバイスの互換性を確認" });
  assert.equal(title.source, "first_line");
  assert.equal(title.metadata.title, "デバイスの互換性を確認");

  const json = parseIntentTitleCandidate({
    content: '```json\n{"title":"Device pairing","summary":"Check compatibility"}\n```',
    reasoning: "We should select a title.",
  });
  assert.equal(json.source, "json");
  assert.equal(json.metadata.title, "Device pairing");
});
