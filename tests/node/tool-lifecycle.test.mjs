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

const { findToolLifecycleBlockIndex } = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/toolLifecycle.ts"));
const { buildCompletedToolGroupRanges } = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/toolUiGrouping.ts"));
const { formatToolPresentation } = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/toolPresentation.ts"));

test("tool lifecycle matching prefers toolCallId and then falls back to name+target", () => {
  const taskFlow = [
    { id: 1, type: "tool", turnId: "turn-1", toolName: "manage_camera", target: "Main Camera", toolStatus: "running", toolCallId: "call-1" },
    { id: 2, type: "tool", turnId: "turn-1", toolName: "manage_camera", target: "Main Camera", toolStatus: "running", toolCallId: "call-2" },
  ];

  const firstById = findToolLifecycleBlockIndex({
    taskFlow,
    turnId: "turn-1",
    toolName: "manage_camera",
    target: "Main Camera",
    allowedStatuses: ["running"],
    meta: { toolCallId: "call-1" },
  });
  assert.equal(firstById, 0);

  const fallbackLatest = findToolLifecycleBlockIndex({
    taskFlow,
    turnId: "turn-1",
    toolName: "manage_camera",
    target: "Main Camera",
    allowedStatuses: ["running"],
    meta: { toolCallId: "missing-call-id" },
  });
  assert.equal(fallbackLatest, 1);

  const fallbackWithoutMeta = findToolLifecycleBlockIndex({
    taskFlow,
    turnId: "turn-1",
    toolName: "manage_camera",
    target: "Main Camera",
    allowedStatuses: ["running"],
  });
  assert.equal(fallbackWithoutMeta, 1);
});

test("completed tool groups break on pending/failed/agent blocks and skip excluded read tools", () => {
  const blocks = [
    { type: "tool", toolName: "manage_camera", toolStatus: "executed" },      // 0
    { type: "tool", toolName: "find_gameobjects", toolStatus: "executed" },   // 1
    { type: "tool", toolName: "manage_camera", toolStatus: "pending" },       // 2
    { type: "tool", toolName: "manage_scene", toolStatus: "executed" },        // 3
    { type: "tool", toolName: "execute_code", toolStatus: "executed" },        // 4
    { type: "agent", content: "阶段结论" },                                       // 5
    { type: "tool", toolName: "manage_camera", toolStatus: "executed" },       // 6
    { type: "tool", toolName: "execute_code", toolStatus: "executed" },        // 7
    { type: "tool", toolName: "read_file", toolStatus: "executed" },           // 8 (excluded)
    { type: "tool", toolName: "read_file", toolStatus: "executed" },           // 9 (excluded)
    { type: "tool", toolName: "manage_components", toolStatus: "executed" },   // 10
    { type: "tool", toolName: "manage_components", toolStatus: "failed" },     // 11
    { type: "tool", toolName: "manage_scene", toolStatus: "executed" },        // 12
    { type: "tool", toolName: "manage_camera", toolStatus: "executed" },       // 13
  ];

  const ranges = buildCompletedToolGroupRanges({
    blocks,
    excludedToolNames: new Set(["read_file"]),
  });

  assert.deepEqual(ranges, [
    { startIndex: 0, endIndex: 1 },
    { startIndex: 3, endIndex: 4 },
    { startIndex: 6, endIndex: 7 },
    { startIndex: 12, endIndex: 13 },
  ]);
});

test("tool presentation uses friendly labels and compact targets", () => {
  const readFile = formatToolPresentation({
    toolName: "read_file",
    target: "/Users/michael/Documents/GitHub/MAIN/src/lib/orchestrator.ts",
    language: "zh",
  });

  assert.equal(readFile.label, "读取文件");
  assert.equal(readFile.target, ".../src/lib/orchestrator.ts");
  assert.equal(readFile.summary, "读取文件：.../src/lib/orchestrator.ts");

  const skeleton = formatToolPresentation({
    toolName: "get_project_skeleton",
    target: "",
    language: "zh",
  });
  assert.equal(skeleton.summary, "查看项目结构：项目骨架");
});
