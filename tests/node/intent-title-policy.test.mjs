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

test("semantic turn metadata request triggers for every fresh turn in Main and Game Studio", () => {
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
      mainModeKey: "game_studio",
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
