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
  applyWorkspacePatch,
  normalizeApplyPatchHeaderPath,
  parseApplyPatch,
  previewApplyPatch,
  summarizeApplyPatchTarget,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/applyPatchTool.ts"));

test("apply_patch header normalization strips one exact lowercase path= prefix only", () => {
  assert.equal(normalizeApplyPatchHeaderPath("path=src/main.js"), "src/main.js");
  assert.equal(normalizeApplyPatchHeaderPath("path=./src/main.js"), "src/main.js");
  assert.equal(normalizeApplyPatchHeaderPath("Path=src/main.js"), "Path=src/main.js");
  assert.equal(normalizeApplyPatchHeaderPath("path=path=src/main.js"), "path=src/main.js");
});

test("parseApplyPatch normalizes path= in every recognized Codex patch file header", () => {
  const parsed = parseApplyPatch([
    "*** Begin Patch",
    "*** Add File: path=src/new.ts",
    "+export const created = true;",
    "*** Update File: path=src/old.ts",
    "*** Move to: path=src/moved.ts",
    "@@",
    "-old",
    "+new",
    "*** Delete File: path=src/delete.ts",
    "*** End Patch",
  ].join("\n"));

  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.operations.map((operation) => ({
    kind: operation.kind,
    path: operation.path,
    newPath: operation.newPath,
  })), [
    { kind: "add", path: "src/new.ts", newPath: undefined },
    { kind: "update", path: "src/old.ts", newPath: "src/moved.ts" },
    { kind: "delete", path: "src/delete.ts", newPath: undefined },
  ]);
});

test("parseApplyPatch accepts Codex-style update and add file patches", () => {
  const parsed = parseApplyPatch([
    "*** Begin Patch",
    "*** Update File: src/App.tsx",
    "@@",
    "-const title = \"old\";",
    "+const title = \"new\";",
    "*** Add File: src/new.ts",
    "+export const ok = true;",
    "*** End Patch",
  ].join("\n"));

  assert.equal(parsed.ok, true);
  assert.equal(parsed.operations.length, 2);
  assert.equal(summarizeApplyPatchTarget(parsed.operations.length ? [
    "*** Begin Patch",
    "*** Update File: src/App.tsx",
    "@@",
    "-old",
    "+new",
    "*** End Patch",
  ].join("\n") : ""), "src/App.tsx");
});

test("previewApplyPatch rejects unsafe paths and mismatched context", async () => {
  const unsafe = parseApplyPatch("*** Begin Patch\n*** Add File: ../oops.ts\n+x\n*** End Patch");
  assert.equal(unsafe.ok, false);

  const mismatch = await previewApplyPatch(
    "*** Begin Patch\n*** Update File: src/App.tsx\n@@\n-missing\n+new\n*** End Patch",
    async () => "current\n",
  );
  assert.equal(mismatch.ok, false);
  assert.match(mismatch.error || "", /not found/);
});

test("previewApplyPatch accepts common unified diff patches from local models", async () => {
  const files = new Map([["src/hooks/useCsvParser.ts", [
    "export function parseCourseOrders(rows) {",
    "  return rows.map((row) => ({",
    "    creatorName: \"\",",
    "    amount: Number(row.sales || 0),",
    "  }));",
    "}",
    "",
  ].join("\n")]]);
  const patch = [
    "--- a/src/hooks/useCsvParser.ts",
    "+++ b/src/hooks/useCsvParser.ts",
    "@@ -1,7 +1,7 @@",
    " export function parseCourseOrders(rows) {",
    "   return rows.map((row) => ({",
    "-    creatorName: \"\",",
    "+    creatorName: row.creator_name || row.creator || row['创建人'] || 'Unknown',",
    "     amount: Number(row.sales || 0),",
    "   }));",
    " }",
  ].join("\n");

  const preview = await previewApplyPatch(patch, async (file) => files.get(file));

  assert.equal(preview.ok, true);
  assert.match(preview.changes[0].newContent, /creator_name/);
  assert.equal(summarizeApplyPatchTarget(patch), "src/hooks/useCsvParser.ts");
});

test("previewApplyPatch normalizes path= in unified diff headers", async () => {
  const patch = [
    "--- path=src/main.js",
    "+++ path=src/main.js",
    "@@ -1 +1 @@",
    "-const ready = false;",
    "+const ready = true;",
  ].join("\n");
  const preview = await previewApplyPatch(
    patch,
    async (file) => file === "src/main.js" ? "const ready = false;\n" : undefined,
  );

  assert.equal(preview.ok, true);
  assert.equal(preview.changes[0].path, "src/main.js");
  assert.equal(preview.changes[0].newContent, "const ready = true;\n");
});

test("previewApplyPatch accepts unified diff wrapped in apply_patch markers", async () => {
  const files = new Map([["src/hooks/useCsvParser.ts", [
    "export function normalizeCsvOrder(row) {",
    "  return {",
    "    creator: row.creator || '',",
    "  };",
    "}",
    "",
  ].join("\n")]]);
  const patch = [
    "*** Begin Patch",
    "--- a/src/hooks/useCsvParser.ts",
    "+++ b/src/hooks/useCsvParser.ts",
    "@@ -1,6 +1,7 @@",
    " export function normalizeCsvOrder(row) {",
    "   return {",
    "     creator: row.creator || '',",
    "+    creatorName: row.creator || '',",
    "   };",
    " }",
    "*** End Patch",
  ].join("\n");

  const preview = await previewApplyPatch(patch, async (file) => files.get(file));

  assert.equal(preview.ok, true);
  assert.match(preview.changes[0].newContent, /creatorName/);
});

test("applyWorkspacePatch writes real staged changes through the provided IO", async () => {
  const files = new Map([["src/App.tsx", "const title = \"old\";\n"]]);
  const result = await applyWorkspacePatch(
    "*** Begin Patch\n*** Update File: src/App.tsx\n@@\n-const title = \"old\";\n+const title = \"new\";\n*** End Patch",
    {
      readFile: async (file) => {
        if (!files.has(file)) throw new Error("missing");
        return files.get(file);
      },
      writeFile: async (file, content) => {
        files.set(file, content);
      },
    },
  );

  assert.equal(result.ok, true);
  assert.equal(files.get("src/App.tsx"), "const title = \"new\";\n");
});

test("applyWorkspacePatch writes path= header changes to the canonical workspace target", async () => {
  const files = new Map([["src/main.js", "const title = \"old\";\n"]]);
  const writes = [];
  const result = await applyWorkspacePatch(
    "*** Begin Patch\n*** Update File: path=src/main.js\n@@\n-const title = \"old\";\n+const title = \"new\";\n*** End Patch",
    {
      readFile: async (file) => {
        if (!files.has(file)) throw new Error("missing");
        return files.get(file);
      },
      writeFile: async (file, content) => {
        writes.push(file);
        files.set(file, content);
      },
    },
  );

  assert.equal(result.ok, true);
  assert.deepEqual(writes, ["src/main.js"]);
  assert.equal(files.get("src/main.js"), "const title = \"new\";\n");
  assert.equal(files.has("path=src/main.js"), false);
});

test("applyWorkspacePatch rolls back earlier files when a later write fails", async () => {
  const files = new Map([
    ["src/a.ts", "export const a = 'old';\n"],
    ["src/b.ts", "export const b = 'old';\n"],
  ]);
  const patch = [
    "*** Begin Patch",
    "*** Update File: src/a.ts",
    "@@",
    "-export const a = 'old';",
    "+export const a = 'new';",
    "*** Update File: src/b.ts",
    "@@",
    "-export const b = 'old';",
    "+export const b = 'new';",
    "*** End Patch",
  ].join("\n");

  await assert.rejects(() => applyWorkspacePatch(patch, {
    readFile: async (file) => files.get(file),
    writeFile: async (file, content) => {
      if (file === "src/b.ts" && content.includes("'new'")) throw new Error("disk full");
      files.set(file, content);
    },
  }), /disk full/);

  assert.equal(files.get("src/a.ts"), "export const a = 'old';\n");
  assert.equal(files.get("src/b.ts"), "export const b = 'old';\n");
});

test("applyWorkspacePatch performs a real move and reports both destination and source", async () => {
  const files = new Map([["src/old.ts", "export const value = 'old';\n"]]);
  const patch = [
    "*** Begin Patch",
    "*** Update File: src/old.ts",
    "*** Move to: src/moved.ts",
    "@@",
    "-export const value = 'old';",
    "+export const value = 'new';",
    "*** End Patch",
  ].join("\n");
  const result = await applyWorkspacePatch(patch, {
    readFile: async (file) => {
      if (!files.has(file)) throw new Error("missing");
      return files.get(file);
    },
    probePath: async (file) => files.has(file) ? "exists" : "absent",
    writeFile: async (file, content) => {
      files.set(file, content);
    },
    writeNewFile: async (file, content) => {
      if (files.has(file)) throw new Error("CREATE_NEW_TARGET_EXISTS");
      files.set(file, content);
    },
    deletePath: async (file) => {
      files.delete(file);
    },
  });

  assert.equal(result.ok, true);
  assert.equal(files.has("src/old.ts"), false);
  assert.equal(files.get("src/moved.ts"), "export const value = 'new';\n");
  assert.deepEqual(
    result.changes.map((change) => [change.kind, change.path]),
    [["add", "src/moved.ts"], ["delete", "src/old.ts"]],
  );
});

test("applyWorkspacePatch rejects an existing or unverified move destination before any write", async () => {
  const patch = [
    "*** Begin Patch",
    "*** Update File: src/old.ts",
    "*** Move to: src/existing.ts",
    "*** End Patch",
  ].join("\n");
  for (const destinationStatus of ["exists", "unknown"]) {
    const writes = [];
    const deletes = [];
    const result = await applyWorkspacePatch(patch, {
      readFile: async (file) => file === "src/old.ts" ? "old\n" : "occupied\n",
      probePath: async () => destinationStatus,
      writeFile: async (file) => { writes.push(file); },
      deletePath: async (file) => { deletes.push(file); },
    });
    assert.equal(result.ok, false);
    assert.match(result.error || "", /Move destination/);
    assert.deepEqual(writes, []);
    assert.deepEqual(deletes, []);
  }
});

test("applyWorkspacePatch rejects an unverified Add File target before any write", async () => {
  const writes = [];
  const result = await applyWorkspacePatch(
    "*** Begin Patch\n*** Add File: src/new.ts\n+export const value = true;\n*** End Patch",
    {
      readFile: async () => { throw new Error("permission denied"); },
      probePath: async () => "unknown",
      writeFile: async (file) => { writes.push(file); },
      writeNewFile: async (file) => { writes.push(file); },
    },
  );

  assert.equal(result.ok, false);
  assert.match(result.error || "", /Add File target availability could not be verified/);
  assert.deepEqual(writes, []);
});

test("applyWorkspacePatch requires atomic create-new support for Add File", async () => {
  const writes = [];
  const result = await applyWorkspacePatch(
    "*** Begin Patch\n*** Add File: src/new.ts\n+export const value = true;\n*** End Patch",
    {
      readFile: async () => { throw new Error("missing"); },
      probePath: async () => "absent",
      writeFile: async (file) => { writes.push(file); },
    },
  );

  assert.equal(result.ok, false);
  assert.match(result.error || "", /Atomic Add File .*not supported/);
  assert.deepEqual(writes, []);
});
