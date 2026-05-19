import test from "node:test";
import assert from "node:assert/strict";
import fsSync from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

import ts from "typescript";

const require = createRequire(import.meta.url);
const workspaceRoot = process.cwd();

const transpiledModuleCache = new Map();

function loadTranspiledModuleSync(sourcePath) {
  const normalizedPath = path.resolve(sourcePath);
  if (transpiledModuleCache.has(normalizedPath)) {
    return transpiledModuleCache.get(normalizedPath);
  }

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
  transpiledModuleCache.set(normalizedPath, module.exports);

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

const {
  deriveThoughtDisplay,
  normalizeThinkingPolicy,
  normalizeThinkingPolicyWithLegacy,
  normalizeThoughtSummaryForCompare,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/thoughtDisplay.ts"));

function countOccurrences(text, needle) {
  return String(text || "").split(needle).length - 1;
}

test("thinking policy falls back to normal", () => {
  assert.equal(normalizeThinkingPolicy("action_only"), "action_only");
  assert.equal(normalizeThinkingPolicy("normal"), "normal");
  assert.equal(normalizeThinkingPolicy("foo"), "normal");
  assert.equal(normalizeThinkingPolicy(undefined), "normal");
});

test("legacy thought display mode migrates to thinking policy", () => {
  assert.equal(normalizeThinkingPolicyWithLegacy("action_only", "summary"), "action_only");
  assert.equal(normalizeThinkingPolicyWithLegacy("normal", "hidden"), "normal");
  assert.equal(normalizeThinkingPolicyWithLegacy(undefined, "hidden"), "action_only");
  assert.equal(normalizeThinkingPolicyWithLegacy(undefined, "summary"), "normal");
  assert.equal(normalizeThinkingPolicyWithLegacy(undefined, "detailed"), "normal");
  assert.equal(normalizeThinkingPolicyWithLegacy(undefined, "unknown"), "normal");
});

test("thought summary collapses repeated process loops", () => {
  const repeated = [
    "我需要先检查 SettingsModal 的通用设置区域。",
    "下一步会把思考显示接入三档配置。",
    "我需要先检查 SettingsModal 的通用设置区域。",
    "下一步会把思考显示接入三档配置。",
    "我需要先检查 SettingsModal 的通用设置区域。",
    "下一步会把思考显示接入三档配置。",
  ].join("\n");

  const display = deriveThoughtDisplay(`<thinking>${repeated}</thinking>`, {
    language: "zh",
  });
  const summary = display.summaryLines.join("\n");

  assert.equal(countOccurrences(summary, "SettingsModal"), 1);
  assert.equal(countOccurrences(summary, "三档配置"), 1);
});

test("thought summary filters logs json punctuation and large code", () => {
  const display = deriveThoughtDisplay([
    'data: {"choices":[{"delta":{"content":"noise"}}]}',
    '{"tool":"read_file","arguments":{"path":"src/App.tsx"}}',
    ".....................",
    "```ts",
    "const noisy = true;",
    "function dumpRawCode() {",
    "  return noisy;",
    "}",
    "if (noisy) {",
    "  dumpRawCode();",
    "}",
    "```",
    "我需要先检查 SettingsModal 的通用设置区域。",
    "下一步会把思考显示接入三档配置。",
  ].join("\n"), {
    language: "zh",
  });

  const summary = display.summaryLines.join("\n");
  assert.match(summary, /SettingsModal/);
  assert.match(summary, /三档配置/);
  assert.doesNotMatch(summary, /data:/);
  assert.doesNotMatch(summary, /read_file/);
  assert.doesNotMatch(summary, /const noisy/);
});

test("latest thought summary prefers the newest useful step", () => {
  const display = deriveThoughtDisplay([
    "我需要先读取用户第一次指令并确认范围。",
    '{"tool":"read_file","arguments":{"path":"src/App.tsx"}}',
    "下一步会检查旧的 App.tsx 结构。",
    "现在已经完成实现，正在整理验证结果和最终说明。",
  ].join("\n"), {
    language: "zh",
    mode: "latest",
  });

  const summary = display.summaryLines.join("\n");
  assert.match(summary, /整理验证结果/);
  assert.doesNotMatch(summary, /第一次指令/);
  assert.doesNotMatch(summary, /read_file/);
});

test("adaptive latest thought summary keeps a recent useful reasoning chain", () => {
  const display = deriveThoughtDisplay([
    "我需要先读取用户第一次指令并确认范围。",
    '{"tool":"read_file","arguments":{"path":"src/App.tsx"}}',
    "下一步会检查旧的 App.tsx 结构。",
    "我已经确认归档外层 ring 存在，所以视觉容器不是主要缺口。",
    "现在需要增强每一步意图，把为什么读取、做了什么、结果如何放到同一条时间线。",
    "最后会补充回归测试，确保 action_only 隐藏 thought 但保留工具意图。",
  ].join("\n"), {
    language: "zh",
    mode: "latest",
    density: "adaptive",
  });

  const summary = display.summaryLines.join("\n");
  assert.ok(display.summaryLines.length >= 3);
  assert.match(summary, /归档外层 ring/);
  assert.match(summary, /增强每一步意图/);
  assert.match(summary, /回归测试/);
  assert.doesNotMatch(summary, /read_file/);
  assert.doesNotMatch(summary, /第一次指令/);
});

test("adaptive thought summary drops thin operation narrations", () => {
  const display = deriveThoughtDisplay([
    "按方案修改目标文件。",
    "让我继续检查剩余关键文件。",
    "已经确认重复的短说明会挤占本轮步骤，所以需要让阶段策略承载同一批编辑。",
    "下一步保留 diff 证据，但主时间线只展示一个合并后的策略说明。",
  ].join("\n"), {
    language: "zh",
    mode: "latest",
    density: "adaptive",
  });

  const summary = display.summaryLines.join("\n");
  assert.match(summary, /阶段策略/);
  assert.match(summary, /diff 证据/);
  assert.doesNotMatch(summary, /按方案修改目标文件/);
  assert.doesNotMatch(summary, /继续检查剩余关键文件/);
});

test("adaptive thought summary limits repeated progress echo lines", () => {
  const display = deriveThoughtDisplay([
    "已经完成主题配色检查，接下来继续处理 CSV 图表。",
    "已经完成 CSV 图表检查，接下来继续处理课程名称清洗。",
    "已经完成课程名称清洗检查，接下来继续处理布局遮挡。",
    "已经完成布局遮挡检查，接下来继续验证构建。",
    "关键结论是重复读取 App.tsx 会让 tool result 快速变大，需要缩窄 read_file 窗口。",
  ].join("\n"), {
    language: "zh",
    mode: "latest",
    density: "adaptive",
  });

  const summary = display.summaryLines.join("\n");
  assert.ok(countOccurrences(summary, "接下来") <= 2);
  assert.match(summary, /tool result/);
  assert.match(summary, /read_file/);
});

test("thought summary removes dense punctuation noise and mode complaint loops", () => {
  const display = deriveThoughtDisplay([
    "当前 discuss 模式下 write_file 不可用，需要切换到执行模式。",
    "工具 disabled in discuss mode，必须进入 execute mode。",
    "由于似乎缓存，换一种方式。，使用来获取关键代码片段，，，，，，，，，整个 ...... 陷入了循环。。，，，，，所以我无法直接。",
    "我会继续检查目标文件并完成修改。",
  ].join("\n"), {
    language: "zh",
  });

  const summary = display.summaryLines.join("\n");
  assert.match(summary, /继续检查目标文件/);
  assert.doesNotMatch(summary, /discuss 模式下 write_file 不可用/);
  assert.doesNotMatch(summary, /disabled in discuss mode/);
  assert.doesNotMatch(summary, /陷入了循环/);
});

test("thought summary removes synthetic placeholder and near-duplicate lines", () => {
  const display = deriveThoughtDisplay([
    "The file keeps returning same stub. Let try reading specific line ranges to get content need.",
    "The file keeps returning the same stub. Let me try reading specific line ranges to get the content I need.",
    "后台思考已折叠，模型尚未生成可见回复或可执行动作。",
    "The file is being truncated. Let me read specific line ranges to get content need.",
    "后台思考已折叠，模型尚未生成可见回复或可执行动作。",
    "The file is being truncated. Let me read specific line ranges to get the content I need.",
  ].join("\n\n"), {
    language: "zh",
  });

  const summary = display.summaryLines.join("\n");
  assert.equal(display.summaryLines.length, 1);
  assert.match(summary, /specific line ranges/);
  assert.doesNotMatch(summary, /后台思考已折叠/);
});

test("thought summary comparison normalizes near-duplicate English lines", () => {
  assert.equal(
    normalizeThoughtSummaryForCompare("The file keeps returning same stub. Let try reading specific line ranges to get content need."),
    normalizeThoughtSummaryForCompare("The file keeps returning the same stub. Let me try reading specific line ranges to get the content I need."),
  );
});
