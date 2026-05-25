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
  parseApplyPatch,
  previewApplyPatch,
  summarizeApplyPatchTarget,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/applyPatchTool.ts"));

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
