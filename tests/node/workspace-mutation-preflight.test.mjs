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
  assert.equal(result.recoveryKind, "source_mismatch");
  assert.match(result.message || "", /当前版本化源码观察/);
  assert.match(result.message || "", /文件版本变化|缺少精确范围/);
});

test("replace_in_file preflight rejects an ambiguous exact block", async () => {
  const result = await preflightWorkspaceMutation({
    toolName: "replace_in_file",
    args: {
      path: "src/main.js",
      search_text: "const duplicate = true;",
      replace_text: "const duplicate = false;",
    },
    language: "en",
    readFile: async () => [
      "const duplicate = true;",
      "const middle = true;",
      "const duplicate = true;",
    ].join("\n"),
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "search_text_ambiguous");
  assert.equal(result.recoveryKind, "mutation_rejected");
  assert.match(result.message || "", /unique|more than once/i);
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

  const overwrite = await preflightWorkspaceMutation({
    toolName: "write_file",
    args: { path: "src/hooks/useCsvParser.ts", content: "replacement" },
    language: "en",
    readFile: async () => "existing",
  });

  assert.equal(overwrite.ok, false);
  assert.equal(overwrite.reason, "existing_file_requires_patch");
  assert.match(overwrite.message || "", /replace_in_file|apply_patch/);

  const create = await preflightWorkspaceMutation({
    toolName: "write_file",
    args: { path: "new-file.ts", content: "new" },
    language: "en",
    readFile: async () => { throw new Error("missing"); },
  });

  assert.equal(create.ok, true);
});

test("mutation preflight rejects external and traversing targets before reading", async () => {
  let reads = 0;
  const outside = await preflightWorkspaceMutation({
    toolName: "write_file",
    args: { path: "/tmp/generated-source.js", content: "unsafe" },
    workspaceRoot: "/fixture",
    language: "zh",
    readFile: async () => {
      reads += 1;
      throw new Error("must not read");
    },
  });
  assert.equal(outside.ok, false);
  assert.equal(outside.reason, "outside_workspace");
  assert.equal(outside.recoveryKind, "target_invalid");
  assert.equal(reads, 0);

  const traversalPatch = await preflightWorkspaceMutation({
    toolName: "apply_patch",
    args: {
      patch: [
        "*** Begin Patch",
        "*** Update File: ../outside.js",
        "@@",
        "-old",
        "+new",
        "*** End Patch",
      ].join("\n"),
    },
    workspaceRoot: "/fixture",
    language: "en",
    readFile: async () => {
      reads += 1;
      return "old";
    },
  });
  assert.equal(traversalPatch.ok, false);
  assert.equal(traversalPatch.reason, "outside_workspace");
  assert.equal(traversalPatch.recoveryKind, "target_invalid");
  assert.equal(reads, 0);
});

test("mutation preflight rejects whole-file rewrites but permits focused edits", async () => {
  const source = Array.from(
    { length: 1_000 },
    (_, index) => `const line${index} = ${index};`,
  ).join("\n");
  const rewrite = await preflightWorkspaceMutation({
    toolName: "replace_in_file",
    args: {
      path: "src/main.js",
      search_text: source,
      replace_text: "const replacement = true;\n",
    },
    language: "zh",
    readFile: async () => source,
  });
  assert.equal(rewrite.ok, false);
  assert.equal(rewrite.reason, "oversized_change");
  assert.equal(rewrite.recoveryKind, "mutation_rejected");

  const focused = await preflightWorkspaceMutation({
    toolName: "replace_in_file",
    args: {
      path: "src/main.js",
      search_text: "const line500 = 500;",
      replace_text: "const line500 = 501;",
    },
    language: "zh",
    readFile: async () => source,
  });
  assert.equal(focused.ok, true);

  const patch = await preflightWorkspaceMutation({
    toolName: "apply_patch",
    args: {
      patch: [
        "*** Begin Patch",
        "*** Update File: src/main.js",
        "@@",
        "-const line500 = 500;",
        "+const line500 = 501;",
        "*** End Patch",
      ].join("\n"),
    },
    language: "zh",
    readFile: async () => source,
  });
  assert.equal(patch.ok, true);

  const oversizedCorrectivePatch = await preflightWorkspaceMutation({
    toolName: "apply_patch",
    args: {
      patch: [
        "*** Begin Patch",
        "*** Update File: src/main.js",
        "@@",
        "-const line500 = 500;",
        ...Array.from(
          { length: 49 },
          (_, index) => `+const repair${index} = ${index};`,
        ),
        "*** End Patch",
      ].join("\n"),
    },
    language: "zh",
    maxTouchedLines: 48,
    readFile: async () => source,
  });
  assert.equal(oversizedCorrectivePatch.ok, false);
  assert.equal(oversizedCorrectivePatch.reason, "oversized_change");
  assert.equal(
    oversizedCorrectivePatch.recoveryKind,
    "mutation_rejected",
  );
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
  assert.equal(invalid.recoveryKind, "source_mismatch");
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

test("mutation preflight rejects parser-confirmed post-images before writing", async () => {
  const checked = [];
  const checkSyntax = async (path, content) => {
    checked.push({ path, content });
    const malformed = content.includes("}entFile(");
    return {
      applicable: path.endsWith(".js"),
      hasErrors: malformed,
      errorCount: malformed ? 1 : 0,
      firstErrorLine: malformed ? 2 : null,
      firstErrorColumn: malformed ? 1 : null,
    };
  };
  const replacement = await preflightWorkspaceMutation({
    toolName: "replace_in_file",
    args: {
      path: "src/toolbar.js",
      search_text: "function openFile(filePath) {",
      replace_text: "}entFile(filePath) {",
    },
    language: "zh",
    readFile: async () => [
      "const ready = true;",
      "function openFile(filePath) {",
      "  return filePath;",
      "}",
    ].join("\n"),
    checkSyntax,
  });

  assert.equal(replacement.ok, false);
  assert.equal(replacement.reason, "syntax_error");
  assert.equal(replacement.recoveryKind, "mutation_rejected");
  assert.match(replacement.message || "", /文件尚未修改/);
  assert.deepEqual(checked.map((entry) => entry.path), [
    "src/toolbar.js",
    "src/toolbar.js",
  ]);

  const patch = await preflightWorkspaceMutation({
    toolName: "apply_patch",
    args: {
      patch: [
        "*** Begin Patch",
        "*** Update File: src/toolbar.js",
        "@@",
        "-function openFile(filePath) {",
        "+}entFile(filePath) {",
        "*** End Patch",
      ].join("\n"),
    },
    language: "en",
    readFile: async () => "function openFile(filePath) {\n  return filePath;\n}\n",
    checkSyntax,
  });

  assert.equal(patch.ok, false);
  assert.equal(patch.reason, "syntax_error");
  assert.match(patch.message || "", /No file was changed/);
});

test("mutation preflight requires a parser-clean postimage for an already-broken file", async () => {
  const checkSyntax = async (_path, content) => {
    const errorCount = [...String(content).matchAll(/BROKEN/g)].length;
    return {
      applicable: true,
      hasErrors: errorCount > 0,
      errorCount,
      firstErrorLine: errorCount > 0 ? 1 : null,
      firstErrorColumn: errorCount > 0 ? 1 : null,
      errors: Array.from({ length: errorCount }, (_, index) => ({
        line: index + 4,
        column: 2,
        kind: `parse_${index + 1}`,
      })),
      errorsTruncated: false,
    };
  };
  const current = "BROKEN first\nBROKEN second\n";
  const improved = await preflightWorkspaceMutation({
    toolName: "replace_in_file",
    args: {
      path: "src/toolbar.js",
      search_text: "BROKEN first",
      replace_text: "fixed first",
    },
    language: "en",
    readFile: async () => current,
    checkSyntax,
  });
  assert.equal(improved.ok, false);
  assert.equal(improved.reason, "syntax_error");
  assert.match(
    improved.message || "",
    /pre-existing 2 -> proposed 1/,
  );

  const equallyBroken = await preflightWorkspaceMutation({
    toolName: "replace_in_file",
    args: {
      path: "src/toolbar.js",
      search_text: "BROKEN first",
      replace_text: "BROKEN replacement",
    },
    language: "en",
    readFile: async () => current,
    checkSyntax,
  });
  assert.equal(equallyBroken.ok, false);
  assert.equal(equallyBroken.reason, "syntax_error");
  assert.match(
    equallyBroken.message || "",
    /pre-existing 2 -> proposed 2/,
  );
  assert.match(
    equallyBroken.message || "",
    /src\/toolbar\.js:4:2 parse_1, src\/toolbar\.js:5:2 parse_2/,
  );
});

test("missing mutation targets request workspace reorientation instead of rereading the invented path", async () => {
  const replace = await preflightWorkspaceMutation({
    toolName: "replace_in_file",
    args: {
      path: "src/invented.ts",
      search_text: "old",
      replace_text: "new",
    },
    workspaceRoot: "/fixture",
    language: "en",
    readFile: async () => {
      throw new Error("not found");
    },
  });
  assert.equal(replace.reason, "read_failed");
  assert.equal(replace.recoveryKind, "target_invalid");

  const patch = await preflightWorkspaceMutation({
    toolName: "apply_patch",
    args: {
      patch: [
        "*** Begin Patch",
        "*** Update File: src/invented.ts",
        "@@",
        "-old",
        "+new",
        "*** End Patch",
      ].join("\n"),
    },
    workspaceRoot: "/fixture",
    language: "en",
    readFile: async () => {
      throw new Error("not found");
    },
  });
  assert.equal(patch.reason, "invalid_patch");
  assert.equal(patch.recoveryKind, "target_invalid");
  assert.equal(patch.patchRecoveryMismatch, undefined);
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
