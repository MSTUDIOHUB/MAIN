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

const { deriveThoughtDisplay, normalizeThoughtDisplayMode, normalizeThoughtSummaryForCompare } = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/lib/thoughtDisplay.ts"),
);

function countOccurrences(text, needle) {
  return String(text || "").split(needle).length - 1;
}

test("thought display mode falls back to hidden", () => {
  assert.equal(normalizeThoughtDisplayMode("summary"), "summary");
  assert.equal(normalizeThoughtDisplayMode("detailed"), "detailed");
  assert.equal(normalizeThoughtDisplayMode("verbose"), "hidden");
  assert.equal(normalizeThoughtDisplayMode(undefined), "hidden");
});

test("thought display collapses repeated process loops", () => {
  const repeated = [
    "我需要先检查 SettingsModal 的通用设置区域。",
    "下一步会把思考显示接入三档配置。",
    "我需要先检查 SettingsModal 的通用设置区域。",
    "下一步会把思考显示接入三档配置。",
    "我需要先检查 SettingsModal 的通用设置区域。",
    "下一步会把思考显示接入三档配置。",
  ].join("\n");

  const display = deriveThoughtDisplay(`<thinking>${repeated}</thinking>`, {
    mode: "detailed",
    language: "zh",
  });

  assert.equal(countOccurrences(display.detailText, "我需要先检查 SettingsModal"), 1);
  assert.equal(countOccurrences(display.detailText, "下一步会把思考显示"), 1);
});

test("thought display summary filters logs json punctuation and large code", () => {
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
    mode: "summary",
    language: "zh",
  });

  const summary = display.summaryLines.join("\n");
  assert.match(summary, /SettingsModal/);
  assert.match(summary, /三档配置/);
  assert.doesNotMatch(summary, /data:/);
  assert.doesNotMatch(summary, /read_file/);
  assert.doesNotMatch(summary, /const noisy/);
  assert.doesNotMatch(summary, /代码片段/);
});

test("thought display detailed text has a hard cap", () => {
  const display = deriveThoughtDisplay(`我需要先检查。${"继续整理。".repeat(200)}`, {
    mode: "detailed",
    language: "zh",
    maxDetailChars: 120,
  });

  assert.equal(display.truncated, true);
  assert.ok(display.hiddenChars > 0);
  assert.ok(display.detailText.length <= 120);
});

test("thought display detailed text removes dense punctuation noise", () => {
  const display = deriveThoughtDisplay([
    "我需要读取 e2e.ts 中 seedSidebarRemoveLastWorkspaceScenario 函数的具体内容。",
    "实际上，之前的返回了截断的内容 (truncatedPreview)，尝试获取更多信息。",
    "由于似乎缓存，换一种方式。，使用来获取关键代码片段，，，，，，，，，整个 ...... 陷入了循环。。，，，，，所以我无法直接。",
    "我需要读 App.tsx 中 resetToEmptyChatView 的具体实现。",
  ].join("\n"), {
    mode: "detailed",
    language: "zh",
  });

  assert.match(display.detailText, /seedSidebarRemoveLastWorkspaceScenario/);
  assert.match(display.detailText, /resetToEmptyChatView/);
  assert.doesNotMatch(display.detailText, /truncatedPreview|ANGEDUB|get_outline/);
  assert.doesNotMatch(display.detailText, /(?:[，,。.!！？?;；:：、]\s*){4,}/);
  assert.doesNotMatch(display.detailText, /陷入了循环/);
});

test("thought display preserves useful markdown in detailed text", () => {
  const display = deriveThoughtDisplay([
    "- 我会检查 `SettingsModal` 的通用设置区域。",
    "",
    "```ts",
    "const ok = true;",
    "```",
  ].join("\n"), {
    mode: "detailed",
    language: "zh",
  });

  assert.match(display.detailText, /- 我会检查 `SettingsModal`/);
  assert.match(display.detailText, /```ts/);
  assert.match(display.detailText, /const ok = true;/);
});

test("thought display summary removes synthetic placeholder and near duplicate process lines", () => {
  const display = deriveThoughtDisplay([
    "The file keeps returning same stub. Let try reading specific line ranges to get content need.",
    "The file keeps returning the same stub. Let me try reading specific line ranges to get the content I need.",
    "后台思考已折叠，模型尚未生成可见回复或可执行动作。",
    "The file is being truncated. Let me read specific line ranges to get content need.",
    "后台思考已折叠，模型尚未生成可见回复或可执行动作。",
    "The file is being truncated. Let me read specific line ranges to get the content I need.",
  ].join("\n\n"), {
    mode: "summary",
    language: "zh",
  });

  const summary = display.summaryLines.join("\n");
  assert.equal(display.summaryLines.length, 1);
  assert.match(summary, /specific line ranges/);
  assert.doesNotMatch(summary, /后台思考已折叠/);
});

test("thought summary comparison normalizes near duplicate English process lines", () => {
  assert.equal(
    normalizeThoughtSummaryForCompare("The file keeps returning same stub. Let try reading specific line ranges to get content need."),
    normalizeThoughtSummaryForCompare("The file keeps returning the same stub. Let me try reading specific line ranges to get the content I need."),
  );
});
