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
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
    fileName: normalizedPath,
  }).outputText;
  const module = { exports: {} };
  moduleCache.set(normalizedPath, module.exports);
  const localRequire = createRequire(normalizedPath);
  const runtimeRequire = (specifier) => {
    if (specifier.startsWith(".")) {
      const basePath = path.resolve(path.dirname(normalizedPath), specifier);
      for (const candidate of [
        basePath,
        `${basePath}.ts`,
        `${basePath}.tsx`,
        path.join(basePath, "index.ts"),
      ]) {
        if (!fsSync.existsSync(candidate)) continue;
        if (candidate.endsWith(".ts") || candidate.endsWith(".tsx")) {
          return loadTranspiledModuleSync(candidate);
        }
      }
    }
    return localRequire(specifier);
  };
  new Function("exports", "module", "require", transpiled)(
    module.exports,
    module,
    runtimeRequire,
  );
  moduleCache.set(normalizedPath, module.exports);
  return module.exports;
}

const {
  detectDominantLanguage,
  resolveTurnResponseLanguage,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/workflowModels.ts"));

const {
  providerModeInstruction,
} = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/store/runtimeV2/executionProviderInstruction.ts"),
);

const {
  buildRuntimeV2ConcludePrompt,
  buildRuntimeV2LanguageRetryFeedback,
  evaluateRuntimeV2LanguageRetry,
} = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/store/runtimeV2/executionProviderRequestPolicy.ts"),
);

const {
  buildRuntimeV2FinalProjection,
  buildRuntimeV2MilestoneProjection,
} = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/lib/runtime-v2/projection.ts"),
);

const {
  runtimeV2ClarificationMessage,
} = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/store/runtimeV2/clarificationHistory.ts"),
);

test("detectDominantLanguage handles mixed Chinese/English technical prompts without flipping to English", () => {
  const mixedChinesePrompts = [
    "修复 ChatArea.tsx 里的 bug",
    "检查 executionProviderRequest.ts 的 concludePrompt 和 languageRetry",
    "运行 npm run test:workflow-assets 看看结果",
    "分析下 codex app 和 deepseek harness app 的反馈格式",
    "帮我看下 src/components/ChatArea.tsx 中的 TurnChangesCard 与 assistant_update",
    "/plan 修复 runtime-v2-core.test.mjs 里的 buildRuntimeV2FinalProjection 逻辑",
  ];
  for (const prompt of mixedChinesePrompts) {
    assert.equal(
      detectDominantLanguage(prompt, "en"),
      "zh",
      `Expected Chinese for prompt: ${prompt}`,
    );
    assert.equal(
      resolveTurnResponseLanguage({
        text: prompt,
        policy: "follow_input_language",
        systemLanguage: "zh",
        fallbackLanguage: "en",
      }),
      "zh",
      `Expected resolved zh for prompt: ${prompt}`,
    );
  }

  assert.equal(
    detectDominantLanguage("Fix the language detection bug in ChatArea.tsx and verify tests", "zh"),
    "en",
  );
  assert.equal(
    resolveTurnResponseLanguage({
      text: "请用英文回复 ChatArea.tsx 的修改说明",
      policy: "follow_input_language",
      systemLanguage: "zh",
      fallbackLanguage: "zh",
    }),
    "en",
  );
});

test("Runtime V2 provider instruction and conclude prompt respect target language while preserving legacy defaults", () => {
  const command = (mode, conclusionKind) => ({
    idempotencyKey: `cmd-${mode}`,
    kind: "request_model",
    run: { sessionKey: "s", sessionEpoch: "e", turnId: "t", parentRunId: null, runId: "r", attemptId: "a" },
    phase: "finalizing",
    payload: { mode, ...(conclusionKind ? { conclusionKind } : {}) },
  });

  const zhConclude = providerModeInstruction(command("conclude"), "", {
    hasReadFile: false,
    hasMutation: false,
    hasSpawnSubagent: false,
    hasWaitSubagents: false,
    responseLanguage: "zh",
  });
  assert.match(zhConclude, /简体中文/);
  assert.match(zhConclude, /核心改动与原因/);

  const enConclude = providerModeInstruction(command("conclude"), "", {
    hasReadFile: false,
    hasMutation: false,
    hasSpawnSubagent: false,
    hasWaitSubagents: false,
    responseLanguage: "en",
  });
  assert.match(enConclude, /English/);
  assert.match(enConclude, /Key changes & rationale/);

  const legacyConclude = providerModeInstruction(command("conclude"), "", {
    hasReadFile: false,
    hasMutation: false,
    hasSpawnSubagent: false,
    hasWaitSubagents: false,
  });
  assert.match(legacyConclude, /Summarize the completed changes, files modified, validations run/);

  assert.match(buildRuntimeV2ConcludePrompt("zh"), /简体中文/);
  assert.doesNotMatch(buildRuntimeV2ConcludePrompt("zh"), /All tools are closed/);
  assert.equal(
    buildRuntimeV2ConcludePrompt("en"),
    "All tools are closed. Deliver the final Markdown answer directly from the conversation and available evidence, and do not output <tool_call> tags.",
  );
  assert.match(buildRuntimeV2LanguageRetryFeedback("zh"), /简体中文/);
  assert.match(buildRuntimeV2LanguageRetryFeedback("en"), /English/);
});

test("evaluateRuntimeV2LanguageRetry triggers bounded retry only for mismatched prose-only replies", () => {
  const englishOnZh = evaluateRuntimeV2LanguageRetry({
    text: "I have fixed the language detection logic in ChatArea.tsx and verified the build.",
    targetLanguage: "zh",
    aborted: false,
    toolCallCount: 0,
    hasProtocolViolation: false,
    outputTruncated: false,
  });
  assert.equal(englishOnZh.shouldRetry, true);
  assert.equal(englishOnZh.detectedLanguage, "en");

  const chineseWithIdentifiers = evaluateRuntimeV2LanguageRetry({
    text: "已修复 `workflowModels.ts` 和 `executionProviderRequest.ts` 的语言判断，并跑通 `npm run test:workflow-assets`。",
    targetLanguage: "zh",
    aborted: false,
    toolCallCount: 0,
    hasProtocolViolation: false,
    outputTruncated: false,
  });
  assert.equal(chineseWithIdentifiers.shouldRetry, false);

  const withToolCalls = evaluateRuntimeV2LanguageRetry({
    text: "Let me inspect ChatArea.tsx first.",
    targetLanguage: "zh",
    aborted: false,
    toolCallCount: 1,
    hasProtocolViolation: false,
    outputTruncated: false,
  });
  assert.equal(withToolCalls.shouldRetry, false);

  const truncatedReply = evaluateRuntimeV2LanguageRetry({
    text: "I have inspected the file and started analyzing the issue",
    targetLanguage: "zh",
    aborted: false,
    toolCallCount: 0,
    hasProtocolViolation: false,
    outputTruncated: true,
  });
  assert.equal(truncatedReply.shouldRetry, false);
});

test("buildRuntimeV2FinalProjection omits mechanical boilerplate when finalMarkdown exists and localizes empty fallback", () => {
  const aggregate = {
    strategy: "execute",
    turn: { workspaceKey: "/tmp/ws", sessionKey: "/tmp/ws:1", turnId: "t1", clientSubmissionId: "c1" },
    phase: "finalizing",
    evidence: [{ id: "e1", kind: "source", target: "src/App.tsx", version: "v1" }],
    events: [],
    scheduledCommands: [],
    pendingToolCalls: [],
  };

  const finalText = "已完成语言检测修复，中文指令现在稳定输出中文结构化总结。";
  const withModelFinal = buildRuntimeV2FinalProjection(
    aggregate,
    "final-1",
    "success",
    "verified",
    finalText,
    "zh",
  );
  assert.equal(withModelFinal.markdown, finalText);
  assert.doesNotMatch(withModelFinal.markdown, /### 已完成/);
  assert.doesNotMatch(withModelFinal.markdown, /已保留 \d+ 条证据/);

  const emptyZhFallback = buildRuntimeV2FinalProjection(
    aggregate,
    "final-2",
    "partial",
    "validation_incomplete",
    "",
    "zh",
  );
  assert.match(emptyZhFallback.markdown, /### 已部分完成/);
  assert.doesNotMatch(emptyZhFallback.markdown, /已保留 \d+ 条证据/);

  const emptyEnFallback = buildRuntimeV2FinalProjection(
    aggregate,
    "final-3",
    "partial",
    "validation_incomplete",
    "",
    "en",
  );
  assert.match(emptyEnFallback.markdown, /### Partially completed/);
  assert.doesNotMatch(emptyEnFallback.markdown, /已保留/);
});

test("buildRuntimeV2MilestoneProjection preserves medium-length stage commentary up to 420 chars", () => {
  const aggregate = {
    strategy: "execute",
    turn: { workspaceKey: "/tmp/ws", sessionKey: "/tmp/ws:1", turnId: "t1", clientSubmissionId: "c1" },
  };
  const commentary = [
    "已经确认第一个根因：`detectDominantLanguage` 在剥离技术标识符前会把 `ChatArea.tsx`、`executionProviderRequest.ts` 和 `assistantProgressPresentation.ts` 的大量英文字母计入自然语言权重，导致中文开发指令被误判为英文。",
    "同时确认收尾提示和澄清记录使用了纯英文消息前缀，导致长工具链结束时模型顺着末尾英文指令漂移到英文回复。",
  ].join("");
  assert.ok(commentary.length > 180 && commentary.length <= 420);

  const milestone = buildRuntimeV2MilestoneProjection(
    aggregate,
    {
      type: "provider.responded",
      idempotencyKey: "k1",
      result: {
        commentary,
        visibleText: commentary,
        toolCalls: [{ id: "tc1", name: "read_file", arguments: {} }],
      },
    },
    "m1",
  );
  assert.ok(milestone);
  assert.equal(milestone.markdown, commentary);

  const longCommentary = [
    "第一阶段已经完成：我们排查了 `workflowModels.ts` 中的中英混排检测逻辑，并确认文件名与驼峰符号会显著拉高拉丁字母占比，使中文任务被误判为英文输出。",
    "第二阶段也已定位到关键问题：`executionProviderRequest.ts` 在工具调用关闭后追加了一条纯英文收尾提示，使模型在收尾阶段发生语言漂移并丢失中文结构化总结要求。",
    "第三阶段将会完成界面改版：把 `TurnChangesCard` 收口到最终总结下方，在每条阶段说明保留主智能体标识，并补充完整的单元测试覆盖。",
    "第四阶段将会补充完整的自动化断言：覆盖中英混排检测、本地化尾部指令、语言纠偏单次重试以及最终总结与阶段说明的投影边界，避免后续回退。",
    "第五阶段还会继续校验全部桌面端交互与回归测试，确保中英文输出行为和所有现有自动化检查都保持稳定通过。",
    "第六阶段将在最终构建和全量测试通过后完成验收总结，明确列出所有修改文件、验证命令以及真实运行结果，确保每一步都可追溯。",
    "第七阶段会复查浅色和深色主题下的视觉层次与边框对比度，保证过程摘要条与底部变更文件收口条在不同主题下都清晰易读。",
  ].join("");
  assert.ok(longCommentary.length > 420);
  const boundedMilestone = buildRuntimeV2MilestoneProjection(
    aggregate,
    {
      type: "provider.responded",
      idempotencyKey: "k3",
      result: {
        commentary: longCommentary,
        visibleText: longCommentary,
        toolCalls: [{ id: "tc3", name: "read_file", arguments: {} }],
      },
    },
    "m3",
  );
  assert.ok(boundedMilestone);
  assert.ok(boundedMilestone.markdown.length > 180 && boundedMilestone.markdown.length <= 420);
  assert.match(boundedMilestone.markdown, /[。！？]$/);

  const protocolOnly = buildRuntimeV2MilestoneProjection(
    aggregate,
    {
      type: "provider.responded",
      idempotencyKey: "k2",
      result: {
        commentary: "<runtime-v2-tools>{}</runtime-v2-tools>",
        visibleText: "",
        toolCalls: [{ id: "tc2", name: "read_file", arguments: {} }],
      },
    },
    "m2",
  );
  assert.equal(protocolOnly, null);
});

test("runtimeV2ClarificationMessage avoids injecting English prose prefix", () => {
  const message = runtimeV2ClarificationMessage({
    type: "run.decision_recorded",
    answer: { answers: { language: "zh" } },
  });
  assert.ok(message);
  assert.doesNotMatch(message.content, /Confirmed information/);
  assert.match(message.content, /^\[confirmed_user_answers\]/);
});
