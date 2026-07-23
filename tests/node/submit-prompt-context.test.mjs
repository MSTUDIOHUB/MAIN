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
  buildSubmitPromptContext,
  buildOperationApprovalContinuationPrompt,
} = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/store/submitPromptContext.ts"),
);

function baseInput(overrides = {}) {
  return {
    userContent: "原始内容",
    text: "继续实现",
    preferredLanguage: "zh",
    effectiveRunIntent: "respond",
    effectiveWorkflowMode: "chat",
    preservePlanState: false,
    isPlanApproved: false,
    shouldContinuePlanIntent: false,
    shouldContinuePreviousTurnIntent: false,
    shouldExecuteOnceFromReplyOption: false,
    turnInputContextSignals: {
      imageParts: 0,
      mentionedFilePaths: [],
      attachedFilePaths: [],
    },
    ...overrides,
  };
}

test("submit prompt context prepends plan-mode instructions and turn intake", () => {
  const result = buildSubmitPromptContext(baseInput({
    effectiveRunIntent: "plan",
    effectiveWorkflowMode: "plan",
    text: "制定迁移计划",
    userContent: "制定迁移计划",
  })).userContent;

  assert.match(result, /^\[turn_intake\]/);
  assert.match(result, /workflowMode: plan/);
  assert.match(result, /本轮处于 PLAN 模式/);
  assert.match(result, /\.MAIN\/plans\/plan\.md/);
  assert.match(result, /最新注入的 `\[PLAN AUTHORING CONTRACT\]`/);
  assert.match(result, /声明的当前提交入口/);
  assert.doesNotMatch(result, /<plan_candidate>/);
  assert.match(result, /由 runtime 校验并封存 typed candidate/);
  assert.match(result, /不得.*`write_file`.*`replace_in_file`/);
  assert.doesNotMatch(result, /唯一允许的写入|opencode 风格|增量编辑，否则创建完整计划/);
  assert.match(result, /制定迁移计划$/);
});

test("submit prompt context keeps plan-continuation replacement semantics", () => {
  const result = buildSubmitPromptContext(baseInput({
    preferredLanguage: "en",
    effectiveRunIntent: "plan",
    effectiveWorkflowMode: "plan",
    shouldContinuePlanIntent: true,
    currentTurnUserPrompt: "Refactor MAIN",
    text: "continue",
    userContent: "ATTACHED_CONTEXT_SHOULD_NOT_SURVIVE",
  })).userContent;

  assert.match(result, /^\[turn_intake\]/);
  assert.match(result, /Continue the previous PLAN turn/);
  assert.match(result, /Original plan request: Refactor MAIN/);
  assert.match(result, /complete replacement typed graph/);
  assert.match(result, /latest injected `\[PLAN AUTHORING CONTRACT\]`/);
  assert.match(result, /declared active submission transport/);
  assert.doesNotMatch(result, /<plan_candidate>/);
  assert.match(result, /runtime alone validates, seals, and renders/);
  assert.match(result, /Do not call write_file, replace_in_file, or any write tool/);
  assert.doesNotMatch(result, /write plan\.md directly|short staged ledger/);
  assert.doesNotMatch(result, /ATTACHED_CONTEXT_SHOULD_NOT_SURVIVE/);
});

test("submit prompt context summarizes previous unfinished execute turn", () => {
  const result = buildSubmitPromptContext(baseInput({
    effectiveRunIntent: "execute",
    shouldContinuePreviousTurnIntent: true,
    previousTurnContinuationTarget: {
      userPrompt: "修复测试",
      status: "paused",
    },
    previousTurnLastToolSummary: "run_command npm test",
    previousTurnLastAssistantSummary: "还剩一个失败断言",
    text: "继续",
    userContent: "现有上下文",
  })).userContent;

  assert.match(result, /请继续上一轮未完成回合/);
  assert.match(result, /上一轮原始请求：修复测试/);
  assert.match(result, /上一轮状态：paused。/);
  assert.match(result, /上一轮最后工具活动：run_command npm test。/);
  assert.match(result, /一次性检查\/测试优先用 `run_command`/);
  assert.match(result, /现有上下文$/);
});

test("submit prompt context prepends approved operation execution prompt", () => {
  const result = buildSubmitPromptContext(baseInput({
    preferredLanguage: "en",
    effectiveRunIntent: "execute",
    shouldExecuteOnceFromReplyOption: true,
    approvedProposal: {
      sourceTurnId: "turn-1",
      proposalSummary: "Edit src/store/useAppStore.ts and run tests",
      operationTypes: ["file_write", "command"],
      approvalStatus: "approved",
      evidenceStatus: "none",
      createdAt: 1,
    },
    text: "Approve",
    userContent: "Original user context",
  })).userContent;

  assert.match(result, /The user approved real operations/);
  assert.match(result, /Edit src\/store\/useAppStore\.ts and run tests/);
  assert.match(result, /User approval message: Approve/);
  assert.match(result, /Original user context$/);
});

test("operation approval prompt falls back to assistant summary", () => {
  const prompt = buildOperationApprovalContinuationPrompt({
    language: "en",
    latestAssistantSummary: "Use the smaller patch",
    userChoice: "yes",
  });

  assert.match(prompt, /Use the smaller patch/);
  assert.match(prompt, /User approval message: yes/);
});
