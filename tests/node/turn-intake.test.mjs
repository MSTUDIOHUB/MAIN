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
  const factory = new Function("exports", "module", "require", transpiled);
  factory(module.exports, module, localRequire);
  transpiledModuleCache.set(normalizedPath, module.exports);
  return module.exports;
}

const {
  buildSemanticMetadataContextLines,
  buildTurnIntakeContextBlock,
  extractPrimaryUserRequestText,
  extractTurnInputContextSignalsFromMessages,
  hasTurnProvidedContext,
  resolveEffectiveSubagentDelegationPreference,
  resolveEffectiveSubagentRequirement,
  resolveSubagentDelegationPreference,
  resolveSubagentRequirement,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/turnIntake.ts"));

test("turn intake block makes screenshots and files first-class context", () => {
  const block = buildTurnIntakeContextBlock({
    rawUserInput: "查看截图，确认批准按钮为什么没有反应。",
    signals: {
      imageParts: 2,
      mentionedFilePaths: ["src/App.tsx"],
      attachedFilePaths: ["main-debug.log"],
    },
    language: "zh",
    workflowMode: "plan",
  });

  assert.match(block, /\[turn_intake\]/);
  assert.match(block, /imageParts: 2/);
  assert.match(block, /@file: src\/App\.tsx/);
  assert.match(block, /attachment: main-debug\.log/);
  assert.match(block, /图片、附件、@ 文件都是一等证据/);
  assert.equal(extractPrimaryUserRequestText(block), "查看截图，确认批准按钮为什么没有反应。");
});

test("turn intake signals can be recovered from multimodal messages", () => {
  const block = buildTurnIntakeContextBlock({
    rawUserInput: "根据截图修复选项流程。",
    signals: {
      imageParts: 1,
      mentionedFilePaths: ["src/lib/replyOptions.ts"],
      attachedFilePaths: ["main-debug.log"],
    },
    language: "zh",
    workflowMode: "plan",
  });
  const signals = extractTurnInputContextSignalsFromMessages([
    {
      role: "user",
      content: [
        { type: "image_url", image_url: { url: "data:image/png;base64,abc" } },
        { type: "text", text: block },
      ],
    },
  ]);

  assert.equal(signals.imageParts, 1);
  assert.deepEqual(signals.mentionedFilePaths, ["src/lib/replyOptions.ts"]);
  assert.deepEqual(signals.attachedFilePaths, ["main-debug.log"]);
  assert.equal(signals.subagentPreference, "unspecified");
  assert.equal(hasTurnProvidedContext(signals), true);
});

test("semantic metadata context lines include visual and file hints for local models", () => {
  const lines = buildSemanticMetadataContextLines({
    signals: {
      imageParts: 2,
      mentionedFilePaths: ["src/store/useAppStore.ts"],
      attachedFilePaths: ["main-debug.log"],
    },
    language: "zh",
  });

  assert.ok(lines.includes("Image parts: 2"));
  assert.ok(lines.includes("- @ src/store/useAppStore.ts"));
  assert.ok(lines.includes("- attachment main-debug.log"));
  assert.match(lines.join("\n"), /标题\/摘要必须体现用户真实任务/);
});

test("primary request extraction keeps original plan target for continue turns", () => {
  const block = [
    "[turn_intake]",
    "[user_request]",
    "继续",
    "[/user_request]",
    "[/turn_intake]",
    "",
    "上一轮计划请求：修复 MAIN 的计划审批按钮无响应问题",
    "现在必须产生实际规划进展。",
    "用户最新消息：继续",
  ].join("\n");

  assert.equal(
    extractPrimaryUserRequestText(block),
    "修复 MAIN 的计划审批按钮无响应问题\n继续",
  );
});

test("turn intake distinguishes preferred, allowed, and forbidden subagent delegation", () => {
  assert.equal(
    resolveSubagentDelegationPreference("可以开启多个subagent协同工作"),
    "preferred",
  );
  assert.equal(
    resolveSubagentDelegationPreference("可以使用一个 subagent 帮忙检查"),
    "allowed",
  );
  assert.equal(
    resolveSubagentDelegationPreference("这次不要使用子智能体"),
    "forbidden",
  );
  assert.equal(
    resolveSubagentDelegationPreference(
      "必须先连续调用 spawn_subagent 三次；主体不要重读子智能体租约路径。",
    ),
    "preferred",
  );
  assert.equal(
    resolveSubagentDelegationPreference(
      "可以开启多个子智能体并行分析，但子智能体不要修改文件。",
    ),
    "preferred",
  );
  assert.equal(
    resolveSubagentDelegationPreference(
      "Use several subagents, but no subagents may modify files.",
    ),
    "preferred",
  );
  assert.equal(
    resolveSubagentDelegationPreference(
      "Please spawn three subagents, but do not reread subagent leased paths.",
    ),
    "preferred",
  );
  assert.equal(
    resolveSubagentDelegationPreference(
      "必须先使用三个子智能体分析；但本轮不要使用子智能体。",
    ),
    "forbidden",
  );
  assert.equal(
    resolveSubagentDelegationPreference("修复启动白屏"),
    "unspecified",
  );
});

test("turn intake separates explicit subagent requirements from collaboration preference", () => {
  assert.equal(
    resolveSubagentRequirement("必须使用一个子智能体检查测试设计。"),
    "required",
  );
  assert.equal(
    resolveSubagentRequirement("请把测试策略调查交给只读子 Agent。"),
    "required",
  );
  assert.equal(
    resolveSubagentRequirement("请使用或启动子agent检查计划。"),
    "required",
  );
  assert.equal(
    resolveSubagentRequirement("可以开启多个 subagent 并行分析。"),
    "optional",
  );
  assert.equal(resolveEffectiveSubagentRequirement({
    rawUserInput: "检查这两个模块",
    defaultRequirement: "required",
  }), "required");
  assert.equal(resolveEffectiveSubagentRequirement({
    rawUserInput: "这次不要使用子智能体",
    defaultRequirement: "required",
  }), "optional");
  assert.equal(resolveEffectiveSubagentRequirement({
    rawUserInput: "这次不要使用子 Agent",
    defaultRequirement: "required",
  }), "optional");
});

test("child mutation restrictions do not disable delegation", () => {
  assert.equal(
    resolveSubagentDelegationPreference("可以开启多个子智能体，但禁止子智能体修改文件。"),
    "preferred",
  );
  assert.equal(
    resolveSubagentDelegationPreference("本轮禁止子智能体参与。"),
    "forbidden",
  );
});

test("preferred subagent collaboration prioritizes useful parallel work without a stage gate", () => {
  const block = buildTurnIntakeContextBlock({
    rawUserInput: "修复启动白屏，可以开启多个subagent协同工作",
    signals: {},
    language: "zh",
    workflowMode: "edit",
  });

  assert.match(block, /subagentPreference: preferred/);
  assert.match(block, /明确选择本轮优先使用协作/);
  assert.match(block, /至少两个边界明确的工作包可以重叠/);
  assert.match(block, /应优先在公布的容量内启动尽可能多的有用子智能体/);
  assert.match(block, /父线程继续推进不依赖子结果的工作/);
  assert.match(block, /读取、修改或验证任一阶段/);
  assert.match(block, /不是强制生命周期阶段/);
  assert.match(block, /简单或线性任务直接执行/);
  assert.match(block, /父线程已形成证据化方案/);
  assert.match(block, /只接收父线程整理的上下文胶囊/);
  assert.match(block, /不会继承父线程隐藏推理或完整对话/);
  assert.match(block, /每个精确且互不重叠的文件目标/);
  assert.match(block, /不能只授权目录/);
  assert.match(block, /汇合时重新校验并提交/);
  assert.match(block, /父线程继续推进不依赖子结果的工作/);
  assert.match(block, /不得只按目录拆分或复用已终止实例/);
});

test("session collaboration switch stays preferred unless user explicitly forbids delegation", () => {
  assert.equal(resolveEffectiveSubagentDelegationPreference({
    rawUserInput: "检查这两个模块",
    defaultPreference: "preferred",
  }), "preferred");
  assert.equal(resolveEffectiveSubagentDelegationPreference({
    rawUserInput: "这次不要使用子智能体",
    defaultPreference: "preferred",
  }), "forbidden");
  assert.equal(resolveEffectiveSubagentDelegationPreference({
    rawUserInput: "可以使用一个 subagent 帮忙检查",
    defaultPreference: "preferred",
  }), "preferred");
  assert.equal(resolveEffectiveSubagentDelegationPreference({
    rawUserInput: "找到这些问题的根本原因并修复，可以启动子智能体协作。",
    defaultPreference: "preferred",
  }), "preferred");
});

test("turn intake persists a session-supplied subagent preference for runtime recovery", () => {
  const block = buildTurnIntakeContextBlock({
    rawUserInput: "检查 src/main.js 的启动流程",
    signals: { subagentPreference: "preferred" },
    language: "zh",
    workflowMode: "edit",
  });
  const signals = extractTurnInputContextSignalsFromMessages([
    { role: "user", content: block },
  ]);

  assert.match(block, /subagentPreference: preferred/);
  assert.equal(signals.subagentPreference, "preferred");
});

test("turn intake round-trips explicit subagent requirement authority", () => {
  const block = buildTurnIntakeContextBlock({
    rawUserInput: "请使用一个子智能体独立检查测试策略。",
    signals: { subagentRequirement: "required" },
    language: "zh",
    workflowMode: "plan",
  });
  const signals = extractTurnInputContextSignalsFromMessages([
    { role: "user", content: block },
  ]);

  assert.match(block, /subagentRequirement: required/);
  assert.equal(signals.subagentRequirement, "required");
});

test("turn intake treats the user's multi-Agent imperative as required", () => {
  const userRequest = "过程中也使用多Agent功能看看MAIN的多Agent是否合理并运行正常";
  assert.equal(resolveSubagentRequirement(userRequest), "required");
  assert.equal(resolveEffectiveSubagentRequirement({
    rawUserInput: userRequest,
  }), "required");
  assert.equal(resolveSubagentDelegationPreference(userRequest), "preferred");
});

test("turn intake round-trips explicit diagnosis outcome authority", () => {
  const block = buildTurnIntakeContextBlock({
    rawUserInput: "Identifique la causa raíz y repare el flujo.",
    signals: { diagnosisRequirement: "required" },
    language: "en",
    workflowMode: "plan",
  });
  const signals = extractTurnInputContextSignalsFromMessages([
    { role: "user", content: block },
  ]);

  assert.match(block, /diagnosisRequirement: required/);
  assert.equal(signals.diagnosisRequirement, "required");
});
