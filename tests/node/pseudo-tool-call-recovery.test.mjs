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
  buildPseudoToolCallRecoveryPrompt,
  looksLikePseudoToolCallPlaceholder,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/orchestrator.ts"));

test("detects bracketed pseudo tool call placeholders", () => {
  assert.equal(looksLikePseudoToolCallPlaceholder("[Tool call: read_file]"), true);
  assert.equal(looksLikePseudoToolCallPlaceholder("Tool call: read_file"), true);
  assert.equal(looksLikePseudoToolCallPlaceholder("工具调用: read_file"), true);
});

test("does not treat real XML tool calls as pseudo placeholders", () => {
  assert.equal(
    looksLikePseudoToolCallPlaceholder("<tool_use><tool>read_file</tool><parameter name=\"path\">README.md</parameter></tool_use>"),
    false,
  );
});

test("pseudo tool recovery prompt requires XML tool_use with parameters", () => {
  const prompt = buildPseudoToolCallRecoveryPrompt("zh", "chat");

  assert.match(prompt, /不是可执行工具调用/);
  assert.match(prompt, /<tool_use>/);
  assert.match(prompt, /<parameter name="path">/);
  assert.match(prompt, /不要再输出 `\[Tool call: \.\.\.\]`/);
});
