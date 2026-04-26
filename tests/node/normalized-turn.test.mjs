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

const { isAssistantTurnEmpty, normalizeAssistantTurn } = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/lib/normalizedTurn.ts"),
);

test("assistant turn empty guard matches truly empty responses", () => {
  assert.equal(
    isAssistantTurnEmpty({
      visibleText: "",
      hiddenThought: "",
      replyOptions: [],
      toolCalls: [],
    }),
    true,
  );
});

test("assistant turn empty guard ignores tool-only and text responses", () => {
  assert.equal(
    isAssistantTurnEmpty({
      visibleText: "",
      hiddenThought: "",
      replyOptions: [],
      toolCalls: [{ id: "call_1", name: "read_file", arguments: "{}", source: "text" }],
    }),
    false,
  );

  assert.equal(
    isAssistantTurnEmpty({
      visibleText: "这里是可见正文",
      hiddenThought: "",
      replyOptions: [],
      toolCalls: [],
    }),
    false,
  );
});

test("normalization collapses repeated local-model preamble loops", () => {
  const repeated = [
    "让我开始实现。",
    "首先，我需要创建BattleUnit.cs - 战斗单位类",
    "然后，我需要修复现有代码中的问题。",
    "让我开始实现。",
    "首先，我需要创建BattleUnit.cs - 战斗单位类",
    "然后，我需要修复现有代码中的问题。",
    "让我开始实现。",
    "首先，我需要创建BattleUnit.cs - 战斗单位类",
    "然后，我需要修复现有代码中的问题。",
    "<tool_use>",
    "<tool>get_project_skeleton</tool>",
    "<parameter name=\"depth\">3</parameter>",
    "</tool_use>",
  ].join("\n\n");

  const normalized = normalizeAssistantTurn({
    content: repeated,
    toolCalls: [],
    finishReason: "tool_calls",
  });

  assert.equal(
    normalized.visibleText,
    [
      "让我开始实现。",
      "首先，我需要创建BattleUnit.cs - 战斗单位类",
      "然后，我需要修复现有代码中的问题。",
    ].join("\n\n"),
  );
  assert.equal(normalized.toolCalls.length, 1);
  assert.equal(normalized.toolCalls[0].name, "get_project_skeleton");
});
