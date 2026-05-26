import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

import ts from "typescript";

const require = createRequire(import.meta.url);
const workspaceRoot = process.cwd();

async function loadTranspiledModule(sourcePath) {
  const source = await fs.readFile(sourcePath, "utf8");
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
    fileName: sourcePath,
  }).outputText;
  const module = { exports: {} };
  const factory = new Function("exports", "module", "require", transpiled);
  factory(module.exports, module, require);
  return module.exports;
}

test("local provider routing sends Ollama /v1 endpoints through the Rust proxy", async () => {
  const {
    endpointLooksOpenAiCompatible,
    shouldUseRustProxyForLocalProvider,
  } = await loadTranspiledModule(path.join(workspaceRoot, "src/lib/localProviderRouting.ts"));

  assert.equal(endpointLooksOpenAiCompatible("http://127.0.0.1:11434/v1"), true);
  assert.equal(endpointLooksOpenAiCompatible("http://127.0.0.1:11434/v1/"), true);
  assert.equal(endpointLooksOpenAiCompatible("http://127.0.0.1:11434/api/chat"), false);
  assert.equal(endpointLooksOpenAiCompatible("http://127.0.0.1:11434"), false);

  assert.equal(shouldUseRustProxyForLocalProvider("Ollama", "http://127.0.0.1:11434/v1"), true);
  assert.equal(shouldUseRustProxyForLocalProvider("Ollama", "http://127.0.0.1:11434"), false);
  assert.equal(shouldUseRustProxyForLocalProvider("LM Studio", "http://127.0.0.1:1234/v1"), true);
  assert.equal(shouldUseRustProxyForLocalProvider("OMLX", "http://127.0.0.1:11535/v1"), true);
});

test("orchestrator and preflight share the local provider routing helper", async () => {
  const orchestrator = await fs.readFile(path.join(workspaceRoot, "src/lib/orchestrator.ts"), "utf8");
  const preflight = await fs.readFile(path.join(workspaceRoot, "src/lib/intentPreflight.ts"), "utf8");

  assert.match(orchestrator, /shouldUseRustProxyForLocalProvider\(config\.local\.provider,\s*config\.local\.endpoint\)/);
  assert.match(preflight, /shouldUseRustProxyForLocalProvider\(config\.local\.provider,\s*config\.local\.endpoint\)/);
});
