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
  resolveSubagentDelegationPreference,
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

test("preferred subagent collaboration becomes an explicit runtime intake contract", () => {
  const block = buildTurnIntakeContextBlock({
    rawUserInput: "修复启动白屏，可以开启多个subagent协同工作",
    signals: {},
    language: "zh",
    workflowMode: "edit",
  });

  assert.match(block, /subagentPreference: preferred/);
  assert.match(block, /存在一个独立范围时应尽早创建一个/);
  assert.match(block, /当前运行容量创建多个/);
});

test("session preference supplies preferred only when user text is unspecified", () => {
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
  }), "allowed");
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
