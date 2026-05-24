import test from "node:test";
import assert from "node:assert/strict";
import fsSync from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

import ts from "typescript";

const workspaceRoot = process.cwd();
const fixtureIndex = {
  root: "/tmp/main-repo-map",
  generatedAtMs: 123,
  symbols: [
    { name: "DashboardStore", kind: "constant", file: "src/store/dashboardStore.ts", line: 10, signature: "export const DashboardStore = create(...)" },
    { name: "useCsvParser", kind: "function", file: "src/hooks/useCsvParser.ts", line: 4, signature: "export function useCsvParser()" },
    { name: "Dashboard", kind: "function", file: "src/App.tsx", line: 20, signature: "function Dashboard()" },
  ],
  imports: [
    { from: "src/App.tsx", to: "src/store/dashboardStore", kind: "import", line: 2 },
    { from: "src/App.tsx", to: "src/hooks/useCsvParser", kind: "import", line: 3 },
  ],
  calls: [
    { from: "src/App.tsx", symbol: "useCsvParser", line: 25 },
  ],
  dependencies: [],
  embeddings: [],
};

function loadRepoMapToolsWithMock() {
  const sourcePath = path.join(workspaceRoot, "src/lib/repoMapTools.ts");
  const source = fsSync.readFileSync(sourcePath, "utf8");
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
    fileName: sourcePath,
  }).outputText;
  const module = { exports: {} };
  const localRequire = createRequire(sourcePath);
  const runtimeRequire = (specifier) => {
    if (specifier === "./ipc") {
      return {
        buildRepositoryIndex: async () => fixtureIndex,
      };
    }
    return localRequire(specifier);
  };
  const factory = new Function("exports", "module", "require", transpiled);
  factory(module.exports, module, runtimeRequire);
  return module.exports;
}

const {
  repoMapContext,
  repoMapFiles,
  repoMapImpact,
  repoMapSearch,
  repoMapStatus,
} = loadRepoMapToolsWithMock();

test("repo_map_status reports built-in local index storage", async () => {
  const status = JSON.parse(await repoMapStatus("/tmp/main-repo-map"));
  assert.equal(status.ok, true);
  assert.equal(status.storage, ".MAIN/index/repo_map.db");
  assert.equal(status.symbols, 3);
  assert.equal(status.calls, 1);
});

test("repo_map_search and context locate symbols without returning full source", async () => {
  const search = JSON.parse(await repoMapSearch({ query: "useCsvParser" }, "/tmp/main-repo-map"));
  assert.equal(search.matches[0].file, "src/hooks/useCsvParser.ts");
  assert.equal(search.matches[0].line, 4);

  const context = JSON.parse(await repoMapContext({ task: "fix csv parser dashboard flow" }, "/tmp/main-repo-map"));
  assert.ok(context.files.includes("src/hooks/useCsvParser.ts"));
  assert.ok(context.imports.length > 0);
  assert.match(context.note, /small start_line/);
});

test("repo_map_files and impact summarize project structure and affected files", async () => {
  const files = JSON.parse(await repoMapFiles({ filter: "src/" }, "/tmp/main-repo-map"));
  assert.ok(files.files.some((entry) => entry.file === "src/App.tsx"));

  const impact = JSON.parse(await repoMapImpact({ target: "useCsvParser" }, "/tmp/main-repo-map"));
  assert.ok(impact.impactedFiles.includes("src/App.tsx"));
});
