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
  globalThis.mockIpcInvoke = globalThis.mockIpcInvoke || (async () => ({}));
  const runtimeRequire = (specifier) => {
    if (specifier === "@tauri-apps/api/core") {
      return {
        invoke: async (command, args) => globalThis.mockIpcInvoke(command, args),
      };
    }
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

const { isVerifiedNoEffectMutation } = loadTranspiledModuleSync(
  path.join(workspaceRoot, "src/lib/orchestrator.ts"),
);

const metadata = {
  path: "src/example.ts",
  sizeBytes: 24,
  modifiedMs: 42,
};
const snapshot = {
  path: "src/example.ts",
  content: "export const value = 1;\n",
  existed: true,
};

function mutationVerificationInput(overrides = {}) {
  return {
    supportsDiffVerification: true,
    beforeDiffSnapshot: snapshot,
    afterDiffSnapshot: snapshot,
    observedDiffPreview: undefined,
    result: "{}",
    beforeMetadata: metadata,
    afterMetadata: metadata,
    ...overrides,
  };
}

test("diff-capable mutations require both snapshots before declaring no effect", () => {
  assert.equal(
    isVerifiedNoEffectMutation(mutationVerificationInput({ beforeDiffSnapshot: null })),
    false,
  );
  assert.equal(
    isVerifiedNoEffectMutation(mutationVerificationInput({ afterDiffSnapshot: null })),
    false,
  );
  assert.equal(
    isVerifiedNoEffectMutation(mutationVerificationInput({
      beforeDiffSnapshot: null,
      afterDiffSnapshot: null,
    })),
    false,
  );
  assert.equal(
    isVerifiedNoEffectMutation(mutationVerificationInput({ beforeDiffSnapshot: undefined })),
    false,
  );
  assert.equal(isVerifiedNoEffectMutation(mutationVerificationInput()), true);
  assert.equal(
    isVerifiedNoEffectMutation(mutationVerificationInput({
      observedDiffPreview: {
        old: snapshot.content,
        new: "export const value = 2;\n",
        path: snapshot.path,
        existed: true,
        fullFile: true,
      },
    })),
    false,
  );
});

test("metadata fallback cannot turn unknown reads into a no-effect mutation", () => {
  assert.equal(
    isVerifiedNoEffectMutation(mutationVerificationInput({
      supportsDiffVerification: false,
      beforeDiffSnapshot: null,
      afterDiffSnapshot: null,
      beforeMetadata: null,
      afterMetadata: null,
    })),
    false,
  );
  assert.equal(
    isVerifiedNoEffectMutation(mutationVerificationInput({
      supportsDiffVerification: false,
      beforeMetadata: null,
    })),
    false,
  );
  assert.equal(
    isVerifiedNoEffectMutation(mutationVerificationInput({
      supportsDiffVerification: false,
    })),
    true,
  );
  assert.equal(
    isVerifiedNoEffectMutation(mutationVerificationInput({
      supportsDiffVerification: false,
      result: "mutation completed",
    })),
    false,
  );
});

test("tool lifecycle uses capability support, not snapshot availability, to select verification", () => {
  const source = fsSync.readFileSync(
    path.join(workspaceRoot, "src/lib/orchestrator.ts"),
    "utf8",
  );
  const lifecycleStart = source.indexOf("async function executeToolCallWithLifecycle");
  const lifecycleEnd = source.indexOf(
    "export async function autoMaterializePlanArtifactFromVisibleText",
    lifecycleStart,
  );
  const lifecycleSource = source.slice(lifecycleStart, lifecycleEnd);

  assert.match(
    lifecycleSource,
    /isVerifiedNoEffectMutation\(\{[\s\S]*supportsDiffVerification: supportsToolDiffPreview\(executionName\),[\s\S]*beforeDiffSnapshot: mutationBeforeDiffSnapshot,[\s\S]*afterDiffSnapshot: mutationAfterDiffSnapshot/,
  );
  assert.doesNotMatch(
    lifecycleSource,
    /verifiedNoEffectMutation \|\| isNoEffectMutationResult/,
  );
});
