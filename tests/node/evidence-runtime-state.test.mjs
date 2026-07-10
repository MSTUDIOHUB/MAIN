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
  applyRecentSuccessfulProjectWriteRuntimeState,
  createAgentLoopEvidenceRuntimeState,
  markExecuteOperationEvidenceRuntimeState,
  setLastAssistantTextForCheckpointRuntimeState,
} = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/lib/orchestrator/loop/evidenceRuntimeState.ts"),
);

test("evidence runtime state initializes completion evidence fields", () => {
  assert.deepEqual(createAgentLoopEvidenceRuntimeState(), {
    recentSuccessfulProjectWrite: null,
    sawExecuteOperationEvidence: false,
    lastAssistantTextForCheckpoint: "",
  });
});

test("execution evidence mark is idempotent", () => {
  const state = createAgentLoopEvidenceRuntimeState();
  const marked = markExecuteOperationEvidenceRuntimeState(state);

  assert.equal(marked.sawExecuteOperationEvidence, true);
  assert.equal(markExecuteOperationEvidenceRuntimeState(marked), marked);
});

test("recent successful project write reducer applies tool-result state", () => {
  const state = createAgentLoopEvidenceRuntimeState();
  const recentSuccessfulProjectWrite = {
    name: "replace_in_file",
    target: "src/App.tsx",
  };

  assert.deepEqual(applyRecentSuccessfulProjectWriteRuntimeState(state, {
    recentSuccessfulProjectWrite,
  }), {
    ...state,
    recentSuccessfulProjectWrite,
  });
});

test("assistant checkpoint text setter preserves explicit checkpoint text", () => {
  const state = createAgentLoopEvidenceRuntimeState();
  assert.deepEqual(setLastAssistantTextForCheckpointRuntimeState(state, "Checkpoint"), {
    ...state,
    lastAssistantTextForCheckpoint: "Checkpoint",
  });
});
