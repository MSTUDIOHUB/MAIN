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

const { isAssistantTurnEmpty } = loadTranspiledModuleSync(
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
