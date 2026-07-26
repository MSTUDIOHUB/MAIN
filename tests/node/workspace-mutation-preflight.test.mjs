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
  preflightWorkspaceMutation,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/workspaceMutationPreflight.ts"));

test("replace_in_file preflight blocks mismatched search_text before review", async () => {
  const result = await preflightWorkspaceMutation({
    toolName: "replace_in_file",
    args: {
      path: "src/hooks/useCsvParser.ts",
      search_text: "not in file",
      replace_text: "new text",
    },
    language: "zh",
    readFile: async () => "export function parseCsv() { return []; }\n",
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "search_text_mismatch");
  assert.match(result.message || "", /当前版本化源码观察/);
  assert.match(result.message || "", /文件版本变化|缺少精确范围/);
});

test("replace mismatch range prefers clustered rare identifiers over an early generic match", async () => {
  const source = [
    "const filePath = getInitialPath();",
    ...Array.from({ length: 118 }, (_, index) =>
      `const filler${index} = filePath || "";`
    ),
    "await invoke('save_file_content', {",
    "  file_path: filePath,",
    "  content: activeFile.content,",
    "});",
    ...Array.from({ length: 40 }, (_, index) => `const tail${index} = true;`),
  ].join("\n");
  const result = await preflightWorkspaceMutation({
    toolName: "replace_in_file",
    args: {
      path: "src/main.js",
      search_text: [
        'await invoke("save_file_content", {',
        "  file_path: activeFile.path,",
        "  content: activeFile.content",
        "});",
      ].join("\n"),
      replace_text: "fixed",
    },
    language: "zh",
    readFile: async () => source,
  });

  assert.equal(result.reason, "search_text_mismatch");
  const range = result.patchRecoveryMismatch?.requestedRange;
  assert.ok(range);
  assert.ok((range.startLine || 0) > 80);
  assert.ok((range.startLine || 0) <= 120);
  assert.ok((range.endLine || 0) >= 123);
});

test("replace_in_file preflight blocks empty/no-op replacements", async () => {
  const result = await preflightWorkspaceMutation({
    toolName: "replace_in_file",
    args: {
      path: "src/hooks/useCsvParser.ts",
      search_text: "",
      replace_text: "",
    },
    language: "zh",
    readFile: async () => "abc",
  });

  assert.equal(result.ok, true);

  const identical = await preflightWorkspaceMutation({
    toolName: "replace_in_file",
    args: {
      path: "src/hooks/useCsvParser.ts",
      search_text: "abc",
      replace_text: "abc",
    },
    language: "zh",
    readFile: async () => "abc",
  });

  assert.equal(identical.ok, false);
  assert.equal(identical.reason, "empty_change");
});

test("write_file preflight blocks missing or identical content", async () => {
  const missing = await preflightWorkspaceMutation({
    toolName: "write_file",
    args: { path: "src/hooks/useCsvParser.ts" },
    language: "en",
    readFile: async () => "existing",
  });

  assert.equal(missing.ok, false);
  assert.equal(missing.reason, "missing_content");
  assert.match(missing.message || "", /Do not ask for approval/);

  const identical = await preflightWorkspaceMutation({
    toolName: "write_file",
    args: { path: "src/hooks/useCsvParser.ts", content: "existing" },
    language: "en",
    readFile: async () => "existing",
  });

  assert.equal(identical.ok, false);
  assert.equal(identical.reason, "identical_content");

  const create = await preflightWorkspaceMutation({
    toolName: "write_file",
    args: { path: "new-file.ts", content: "new" },
    language: "en",
    readFile: async () => { throw new Error("missing"); },
  });

  assert.equal(create.ok, true);
});

test("apply_patch preflight blocks invalid, no-op, and mismatched patches before review", async () => {
  const invalid = await preflightWorkspaceMutation({
    toolName: "apply_patch",
    args: { patch: "*** Begin Patch\n*** Update File: src/App.tsx\n@@\n-old\n+new\n*** End Patch" },
    language: "en",
    readFile: async () => "current\n",
  });

  assert.equal(invalid.ok, false);
  assert.equal(invalid.reason, "invalid_patch");
  assert.equal(invalid.path, "src/App.tsx");
  assert.match(invalid.message || "", /active source observation/);
  assert.doesNotMatch(invalid.message || "", /Read the current file once/);

  const valid = await preflightWorkspaceMutation({
    toolName: "apply_patch",
    args: { patch: "*** Begin Patch\n*** Update File: src/App.tsx\n@@\n-current\n+updated\n*** End Patch" },
    language: "zh",
    readFile: async () => "current\n",
  });

  assert.equal(valid.ok, true);
});

test("patch mismatch preflight carries target, range, and current-version identity", async () => {
  const patch = [
    "*** Begin Patch",
    "*** Update File: src/main.js",
    "@@ -205,52 +205,52 @@",
    "-stale toolbar block",
    "+fixed toolbar block",
    "*** End Patch",
  ].join("\n");
  const result = await preflightWorkspaceMutation({
    toolName: "apply_patch",
    args: { patch },
    language: "en",
    readFile: async () => "current toolbar block\n",
    readFileMetadata: async () => ({
      sizeBytes: 8192,
      modifiedMs: 1700000000000,
    }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.patchRecoveryMismatch?.target, "src/main.js");
  assert.deepEqual(result.patchRecoveryMismatch?.requestedRange, {
    startLine: 205,
    endLine: 256,
    maxLines: 52,
  });
  assert.equal(result.patchRecoveryMismatch?.observedVersion, "8192:1700000000000");
  assert.match(
    result.patchRecoveryMismatch?.mismatchFingerprint || "",
    /^patch_mismatch::src\/main\.js::invalid_patch$/,
  );

  const same = await preflightWorkspaceMutation({
    toolName: "apply_patch",
    args: { patch },
    language: "en",
    readFile: async () => "current toolbar block\n",
    readFileMetadata: async () => ({ sizeBytes: 8192, modifiedMs: 1700000000000 }),
  });
  assert.equal(
    same.patchRecoveryMismatch?.mismatchFingerprint,
    result.patchRecoveryMismatch?.mismatchFingerprint,
    "the same target and mismatch kind must retain one stable identity",
  );

  const changedPatchSameSnapshot = await preflightWorkspaceMutation({
    toolName: "apply_patch",
    args: { patch: patch.replace("stale toolbar block", "different stale block") },
    language: "en",
    readFile: async () => "current toolbar block\n",
    readFileMetadata: async () => ({ sizeBytes: 8192, modifiedMs: 1700000000000 }),
  });
  assert.equal(
    changedPatchSameSnapshot.patchRecoveryMismatch?.mismatchFingerprint,
    result.patchRecoveryMismatch?.mismatchFingerprint,
    "changing patch prose alone must not mint another read lease for the same snapshot",
  );
});
