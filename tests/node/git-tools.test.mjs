import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

import ts from "typescript";

const require = createRequire(import.meta.url);
const workspaceRoot = process.cwd();

async function loadCommonJs(relativePath, dependencies = {}) {
  const sourcePath = path.join(workspaceRoot, relativePath);
  const source = await fs.readFile(sourcePath, "utf8");
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
    fileName: sourcePath,
  }).outputText;
  const module = { exports: {} };
  const localRequire = (id) => Object.hasOwn(dependencies, id) ? dependencies[id] : require(id);
  const factory = new Function("exports", "module", "require", transpiled);
  factory(module.exports, module, localRequire);
  return module.exports;
}

const invokeState = {
  payload: null,
  calls: [],
};

const keyedAsyncQueue = await loadCommonJs("src/lib/keyedAsyncQueue.ts");
const projectSessionMutationCoordinator = await loadCommonJs(
  "src/lib/projectSessionMutationCoordinator.ts",
  { "./keyedAsyncQueue": keyedAsyncQueue },
);

const ipc = await loadCommonJs("src/lib/ipc.ts", {
  "@tauri-apps/api/core": {
    invoke: async (command, args) => {
      invokeState.calls.push({ command, args });
      return invokeState.payload;
    },
  },
  "@tauri-apps/api/event": {
    listen: async () => () => {},
  },
  "./projectSessionMutationCoordinator": projectSessionMutationCoordinator,
});
const diff = await loadCommonJs("src/lib/diff.ts");
const gitTools = await loadCommonJs("src/lib/gitTools.ts", {
  "./diff": diff,
  "./ipc": ipc,
});

test("Git diff IPC normalizes a null empty payload for every consumer", async () => {
  invokeState.payload = null;
  invokeState.calls.length = 0;

  const entries = await ipc.getGitDiff("/workspace");

  assert.deepEqual(entries, []);
  assert.deepEqual(invokeState.calls, [{
    command: "get_git_diff",
    args: { workspace: "/workspace", path: undefined, filter: undefined },
  }]);
});

test("Git diff IPC removes malformed records and supplies safe display defaults", () => {
  assert.deepEqual(ipc.normalizeGitDiffEntries([
    null,
    {},
    { path: "" },
    {
      path: " src/main.ts ",
      status: "",
      old: null,
      new: "export const ready = true;\n",
    },
  ]), [{
    path: "src/main.ts",
    status: "M",
    old: "",
    new: "export const ready = true;\n",
    existed: false,
    fullFile: true,
  }]);
});

test("git_diff accepts omitted arguments and renders an empty result without throwing", async () => {
  invokeState.payload = null;
  invokeState.calls.length = 0;

  const result = JSON.parse(await gitTools.runGitDiffTool(undefined, "/workspace"));

  assert.deepEqual(result, {
    mode: "head_to_worktree",
    path: null,
    filter: null,
    changedFiles: 0,
    returnedFiles: 0,
    entries: [],
    truncated: false,
    note: "No HEAD-to-worktree differences matched this request. The empty result is valid and needs no pagination.",
  });
});

test("git_diff still formats a normalized bounded patch", async () => {
  invokeState.payload = [{
    path: "src/main.ts",
    status: "M",
    old: "const value = 1;\n",
    new: "const value = 2;\n",
    existed: true,
    fullFile: true,
    binary: false,
  }];

  const result = JSON.parse(await gitTools.runGitDiffTool({ context_lines: 0 }, "/workspace"));

  assert.equal(result.changedFiles, 1);
  assert.equal(result.returnedFiles, 1);
  assert.equal(result.entries[0].path, "src/main.ts");
  assert.equal(result.entries[0].added, 1);
  assert.equal(result.entries[0].removed, 1);
  assert.match(result.entries[0].patch, /-const value = 1;/);
  assert.match(result.entries[0].patch, /\+const value = 2;/);
});
