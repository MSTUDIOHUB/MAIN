import test from "node:test";
import assert from "node:assert/strict";
import fsSync from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

import ts from "typescript";

const require = createRequire(import.meta.url);
const workspaceRoot = process.cwd();
const transpiledModuleCache = new Map();

function loadTranspiledModuleSync(sourcePath) {
  const normalizedPath = path.resolve(sourcePath);
  if (transpiledModuleCache.has(normalizedPath)) {
    return transpiledModuleCache.get(normalizedPath);
  }

  const source = fsSync.readFileSync(normalizedPath, "utf8");
  const localRequire = createRequire(normalizedPath);
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
    fileName: normalizedPath,
  }).outputText;

  const module = { exports: {} };
  transpiledModuleCache.set(normalizedPath, module.exports);

  globalThis.mockIpcInvoke = globalThis.mockIpcInvoke || (async () => ({}));
  const runtimeRequire = (specifier) => {
    if (specifier === "@tauri-apps/api/core") {
      return {
        invoke: async (cmd, args) => globalThis.mockIpcInvoke(cmd, args),
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

const {
  buildShellReadValidationError,
  buildLoopDetectionValidationError,
  buildReadBeforeModifyValidationError,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/orchestrator.ts"));

// Mock callbacks for the orchestrator
function createMockCallbacks(options = {}) {
  return {
    getPreferredLanguage: () => options.language || "zh",
    getCurrentRunIntent: () => "execute",
    getIsPlanApproved: () => true,
    getWorkspaceTree: () => "tree",
    getSessionKey: () => "mock-session",
    getMessages: () => options.messages || [],
    onToolExecuting: () => {},
    onToolError: () => {},
    ...options,
  };
}

test("buildShellReadValidationError blocks command starting with cat/head/tail/sed", () => {
  const tcRun = { id: "call_run", name: "run_command" };
  const tcExec = { id: "call_exec", name: "execute_command" };

  const callbacks = createMockCallbacks();

  const errCat = buildShellReadValidationError(tcRun, { command: "cat src/App.tsx" }, callbacks);
  const errHead = buildShellReadValidationError(tcRun, { command: "head -n 20 src/App.tsx" }, callbacks);
  const errSed = buildShellReadValidationError(tcRun, { command: "sed -i 's/a/b/g' src/App.tsx" }, callbacks);
  const okLs = buildShellReadValidationError(tcRun, { command: "ls -la" }, callbacks);

  assert.ok(errCat);
  assert.equal(errCat.isError, true);
  assert.match(errCat.content, /SHELL_READ_FORBIDDEN/);

  assert.ok(errHead);
  assert.ok(errSed);
  assert.equal(okLs, null);
});

test("buildLoopDetectionValidationError blocks repetitive tool calls on the same file path", () => {
  const readCall = {
    id: "call_read_1",
    function: {
      name: "read_file",
      arguments: JSON.stringify({ path: "src/App.tsx" }),
    },
  };
  const writeCall = {
    id: "call_write_1",
    function: {
      name: "write_file",
      arguments: JSON.stringify({ path: "src/App.tsx", content: "new" }),
    },
  };

  const messages = [
    { role: "assistant", tool_calls: [readCall] },
    { role: "tool", tool_call_id: "call_read_1", content: "ok" },
    { role: "assistant", tool_calls: [writeCall] },
    { role: "tool", tool_call_id: "call_write_1", content: "success" },
    { role: "assistant", tool_calls: [readCall] },
    { role: "tool", tool_call_id: "call_read_1", content: "ok" },
    { role: "assistant", tool_calls: [writeCall] },
    { role: "tool", tool_call_id: "call_write_1", content: "success" },
    { role: "assistant", tool_calls: [readCall] },
  ];

  const callbacks = createMockCallbacks({ messages });
  const tc = { id: "call_read_new", name: "read_file" };

  const err = buildLoopDetectionValidationError(tc, { path: "src/App.tsx" }, callbacks);
  const ok = buildLoopDetectionValidationError(tc, { path: "src/Chart.tsx" }, callbacks);

  assert.ok(err);
  assert.equal(err.isError, true);
  assert.match(err.content, /LOOP_DETECTED/);
  assert.equal(ok, null);
});

test("buildReadBeforeModifyValidationError blocks write_file when file exists and is >8KB", async () => {
  globalThis.mockIpcInvoke = async (cmd, args) => {
    if (cmd === "get_file_metadata") {
      if (args.path === "src/App.tsx") {
        return { path: "src/App.tsx", sizeBytes: 12000, modifiedMs: 123456 };
      }
      if (args.path === "src/Chart.tsx") {
        return { path: "src/Chart.tsx", sizeBytes: 1000, modifiedMs: 123456 };
      }
    }
    return {};
  };

  const tc = { id: "call_write", name: "write_file" };
  const callbacks = createMockCallbacks();

  const errLarge = await buildReadBeforeModifyValidationError(tc, { path: "src/App.tsx" }, ".", callbacks);
  const okSmall = await buildReadBeforeModifyValidationError(tc, { path: "src/Chart.tsx" }, ".", callbacks);

  assert.ok(errLarge);
  assert.equal(errLarge.isError, true);
  assert.match(errLarge.content, /WRITE_FILE_GATE_BLOCKED/);

  assert.ok(okSmall);
  assert.match(okSmall.content, /READ_BEFORE_MODIFY_BLOCKED/);
});

