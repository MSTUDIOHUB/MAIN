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
  isShellFileReadCommand,
  buildLoopDetectionValidationError,
  buildReadBeforeModifyValidationError,
  summarizeReadFileRepeatLimitBatch,
  buildReadFileRepeatLimitBatchPauseNotice,
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
    onToolDone: () => {},
    onToolError: () => {},
    onDebugEvent: () => {},
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
  const errCdSed = buildShellReadValidationError(tcExec, { command: "cd /tmp/project && sed -n '270,310p' src/App.tsx" }, callbacks);
  const errCdCatPipe = buildShellReadValidationError(tcExec, { command: "cd /tmp/project && cat -n src/App.tsx | grep -A 15 rawOrders" }, callbacks);
  const okLs = buildShellReadValidationError(tcRun, { command: "ls -la" }, callbacks);
  const okCloneTail = buildShellReadValidationError(tcRun, {
    command: "git clone --depth 1 https://github.com/siddharthvaddem/openscreen.git /tmp/openscreen-repo 2>&1 | tail -5",
  }, callbacks);

  assert.ok(errCat);
  assert.equal(errCat.isError, true);
  assert.match(errCat.content, /SHELL_READ_FORBIDDEN/);

  assert.ok(errHead);
  assert.ok(errSed);
  assert.ok(errCdSed);
  assert.ok(errCdCatPipe);
  assert.equal(okLs, null);
  assert.equal(okCloneTail, null);
});

test("isShellFileReadCommand detects read commands after directory changes", () => {
  assert.equal(isShellFileReadCommand("cd /tmp/project && sed -n '1,20p' src/App.tsx"), true);
  assert.equal(isShellFileReadCommand("FOO=1 command head -n 5 package.json"), true);
  assert.equal(isShellFileReadCommand("tail -5 package.json"), true);
  assert.equal(isShellFileReadCommand("cat src/App.tsx | head -5"), true);
  assert.equal(isShellFileReadCommand("git clone --depth 1 https://github.com/siddharthvaddem/openscreen.git /tmp/openscreen-repo 2>&1 | tail -5"), false);
  assert.equal(isShellFileReadCommand("curl -s http://localhost:1421 | head -30"), false);
  assert.equal(isShellFileReadCommand("printf '%s\\n' ok | sed -n '1p'"), false);
  assert.equal(isShellFileReadCommand("printf '%s\\n' ok | cat"), false);
  assert.equal(isShellFileReadCommand("cd /tmp/project && npm run build"), false);
  assert.equal(isShellFileReadCommand("grep -n \"loadOrders\" src/App.tsx"), false);
});

test("orchestrator reports shell-read misuse before shell metadata errors", () => {
  const source = (fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator.ts"), "utf8") + "\n" + fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/AgentOrchestrator.ts"), "utf8"));
  const shellReadIndex = source.indexOf("const shellReadValidationErrorBeforeContract = buildShellReadValidationError");
  const contractIndex = source.indexOf("const validationError = validateToolExecutionContract");

  assert.ok(shellReadIndex > 0);
  assert.ok(contractIndex > 0);
  assert.ok(shellReadIndex < contractIndex);
});

test("plan artifact quality gate only validates mutation tools", () => {
  const source = (fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator.ts"), "utf8") + "\n" + fsSync.readFileSync(path.join(workspaceRoot, "src/lib/orchestrator/loop/AgentOrchestrator.ts"), "utf8"));

  assert.match(
    source,
    /if \(kind && kind !== "tasks" && PLAN_ARTIFACT_MUTATION_TOOLS\.has\(tc\.name\)\)/,
  );
});

test("buildLoopDetectionValidationError blocks repetitive writes on the same file path", () => {
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
  const tc = { id: "call_write_new", name: "write_file" };

  const err = buildLoopDetectionValidationError(tc, { path: "src/App.tsx" }, callbacks);
  const ok = buildLoopDetectionValidationError(tc, { path: "src/Chart.tsx" }, callbacks);

  assert.ok(err);
  assert.equal(err.isError, true);
  assert.match(err.content, /LOOP_DETECTED/);
  assert.equal(ok, null);
});

test("buildLoopDetectionValidationError returns clear non-error guidance for repeated read_file", () => {
  const debugEvents = [];
  const doneEvents = [];
  const readCall = (id) => ({
    id,
    function: {
      name: "read_file",
      arguments: JSON.stringify({ path: "src/App.tsx" }),
    },
  });
  const messages = [
    { role: "user", content: "modify App" },
    { role: "assistant", tool_calls: [readCall("call_read_1")] },
    { role: "tool", tool_call_id: "call_read_1", content: "ok" },
    { role: "assistant", tool_calls: [readCall("call_read_2")] },
    { role: "tool", tool_call_id: "call_read_2", content: "ok" },
    { role: "assistant", tool_calls: [readCall("call_read_3")] },
    { role: "tool", tool_call_id: "call_read_3", content: "ok" },
    { role: "assistant", tool_calls: [readCall("call_read_4")] },
    { role: "tool", tool_call_id: "call_read_4", content: "ok" },
    { role: "assistant", tool_calls: [readCall("call_read_5")] },
  ];

  const callbacks = createMockCallbacks({
    messages,
    onToolDone: (...args) => doneEvents.push(args),
    onDebugEvent: (event, data) => debugEvents.push({ event, data }),
  });
  const result = buildLoopDetectionValidationError(
    { id: "call_read_new", name: "read_file" },
    { path: "src/App.tsx" },
    callbacks,
  );

  assert.ok(result);
  assert.equal(result.isError, false);
  assert.equal(result.lifecycleState, "completed");
  assert.match(result.content, /READ_FILE_REPEAT_LIMIT/);
  assert.equal(doneEvents.length, 1);
  assert.equal(debugEvents[0].event, "agent.tool_preflight_blocked");
  assert.equal(debugEvents[0].data.reason, "read_file_repeat_limit");
});

test("read_file repeat-limit batches summarize into a pause signal", () => {
  const results = Array.from({ length: 9 }, (_, index) => ({
    toolCallId: `call_${index}`,
    name: "read_file",
    target: index < 8 ? "Assets/Scripts/Entities/SnakeController.cs" : "Assets/Scripts/Core/GridManager.cs",
    content: "READ_FILE_REPEAT_LIMIT: duplicate read",
    isError: false,
    lifecycleState: "completed",
  }));

  const summary = summarizeReadFileRepeatLimitBatch(results);
  assert.deepEqual(summary, {
    total: 9,
    target: "Assets/Scripts/Entities/SnakeController.cs",
    targetCount: 8,
  });

  assert.match(
    buildReadFileRepeatLimitBatchPauseNotice({
      language: "zh",
      target: summary.target,
      total: summary.total,
      targetCount: summary.targetCount,
    }),
    /不要原样重试同一个 read_file/,
  );
});

test("loop detection ignores repeated reads before the latest user message", () => {
  const readCall = (id) => ({
    id,
    function: {
      name: "read_file",
      arguments: JSON.stringify({ path: "src/App.tsx" }),
    },
  });
  const messages = [
    { role: "user", content: "old turn" },
    { role: "assistant", tool_calls: [readCall("old_1")] },
    { role: "tool", tool_call_id: "old_1", content: "ok" },
    { role: "assistant", tool_calls: [readCall("old_2"), readCall("old_3"), readCall("old_4")] },
    { role: "tool", tool_call_id: "old_2", content: "ok" },
    { role: "tool", tool_call_id: "old_3", content: "ok" },
    { role: "tool", tool_call_id: "old_4", content: "ok" },
    { role: "assistant", tool_calls: [readCall("old_5")] },
    { role: "user", content: "继续执行" },
  ];

  const result = buildLoopDetectionValidationError(
    { id: "call_read_new", name: "read_file" },
    { path: "src/App.tsx" },
    createMockCallbacks({ messages }),
  );

  assert.equal(result, null);
});

test("post-write verification read is allowed once after repeated same-file activity", () => {
  const call = (id, name) => ({
    id,
    function: {
      name,
      arguments: JSON.stringify(name === "read_file"
        ? { path: "src/App.tsx" }
        : { path: "src/App.tsx", content: "new" }),
    },
  });
  const messages = [
    { role: "user", content: "edit App" },
    { role: "assistant", tool_calls: [call("read_1", "read_file"), call("read_2", "read_file")] },
    { role: "tool", tool_call_id: "read_1", content: "ok" },
    { role: "tool", tool_call_id: "read_2", content: "ok" },
    { role: "assistant", tool_calls: [call("write_1", "write_file")] },
    { role: "tool", tool_call_id: "write_1", content: "success" },
    { role: "assistant", tool_calls: [call("read_3", "read_file"), call("read_4", "read_file")] },
    { role: "tool", tool_call_id: "read_3", content: "ok" },
    { role: "tool", tool_call_id: "read_4", content: "ok" },
    { role: "assistant", tool_calls: [call("write_2", "replace_in_file")] },
    { role: "tool", tool_call_id: "write_2", content: "success" },
    { role: "assistant", tool_calls: [call("verify_read", "read_file")] },
  ];

  const result = buildLoopDetectionValidationError(
    { id: "verify_read", name: "read_file" },
    { path: "src/App.tsx" },
    createMockCallbacks({ messages }),
  );

  assert.equal(result, null);
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

test("buildReadBeforeModifyValidationError recovers read evidence from message history", async () => {
  globalThis.mockIpcInvoke = async (cmd, args) => {
    if (cmd === "get_file_metadata" && args.path === "src/Chart.tsx") {
      return { path: "src/Chart.tsx", sizeBytes: 1000, modifiedMs: 123456 };
    }
    return {};
  };

  const tc = { id: "call_write", name: "write_file" };
  const readCall = {
    id: "call_read_1",
    function: {
      name: "read_file",
      arguments: JSON.stringify({ path: "src/Chart.tsx" }),
    },
  };

  // 1. With actual read success content
  const messagesWithContent = [
    { role: "assistant", tool_calls: [readCall] },
    { role: "tool", tool_call_id: "call_read_1", content: "some file content" },
  ];
  const callbacksWithContent = createMockCallbacks({
    messages: messagesWithContent,
    getSessionKey: () => "mock-session-content",
  });
  const resultWithContent = await buildReadBeforeModifyValidationError(tc, { path: "src/Chart.tsx" }, ".", callbacksWithContent);
  assert.equal(resultWithContent, null); // Allowed

  // 2. With pruned activeMemoryReclamation read stub
  const messagesPruned = [
    { role: "assistant", tool_calls: [readCall] },
    { role: "tool", tool_call_id: "call_read_1", content: "[System: Historical read content of src/Chart.tsx removed; file was successfully mutated in a later turn]" },
  ];
  const callbacksPruned = createMockCallbacks({
    messages: messagesPruned,
    getSessionKey: () => "mock-session-pruned",
  });
  const resultPruned = await buildReadBeforeModifyValidationError(tc, { path: "src/Chart.tsx" }, ".", callbacksPruned);
  assert.equal(resultPruned, null); // Allowed

  // 3. With failed read
  const messagesFailed = [
    { role: "assistant", tool_calls: [readCall] },
    { role: "tool", tool_call_id: "call_read_1", content: "Error: READ_FILE_NOT_AVAILABLE_IN_RECOVERY" },
  ];
  const callbacksFailed = createMockCallbacks({
    messages: messagesFailed,
    getSessionKey: () => "mock-session-failed",
  });
  const resultFailed = await buildReadBeforeModifyValidationError(tc, { path: "src/Chart.tsx" }, ".", callbacksFailed);
  assert.ok(resultFailed);
  assert.match(resultFailed.content, /READ_BEFORE_MODIFY_BLOCKED/);
});


