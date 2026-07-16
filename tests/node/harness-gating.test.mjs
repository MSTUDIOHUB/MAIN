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
  buildNoProgressBatchSignature,
  buildLoopDetectionValidationError,
  buildReadBeforeModifyValidationError,
  buildPlanArtifactMutationValidationError,
  isPreApprovalPlanDraftWrite,
  isPlanArtifactPath,
  getProtectedPlanArtifactMutationViolation,
  collectPlanClosureMaterializationInput,
  getOriginalUserPromptForPlanFallback,
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

test("Plan fallback selects canonical turn input instead of ContextState or hidden approval prompts", () => {
  const callbacks = createMockCallbacks({
    messages: [
      {
        role: "user",
        content: "[System: ContextState]\nconstraints: do not persist [turn_intake] wrappers\nLatest user request: stale packet",
      },
      {
        role: "user",
        content: "[turn_intake]\n[user_request]\n修复双击 Markdown 文件后空白和打开按钮失效的问题。\n[/user_request]\n[/turn_intake]",
      },
      {
        role: "user",
        content: "[turn_intake]\n[user_request]\n计划已批准。请继续执行已批准计划。\n[/user_request]\n[/turn_intake]",
      },
    ],
  });

  assert.equal(
    getOriginalUserPromptForPlanFallback(callbacks),
    "修复双击 Markdown 文件后空白和打开按钮失效的问题。",
  );
});

test("Plan closure preserves multiline numbered user-goal facets", () => {
  const userGoal = [
    "请制定可审批计划：",
    "1、保存后详情页仍显示旧标题。",
    "2、删除后列表计数没有更新。",
    "每个问题都需要证据、改动和验证。",
  ].join("\n");
  const callbacks = createMockCallbacks({
    getCurrentTurnId: () => "turn-numbered-goal",
    getContextMemoryState: () => null,
  });

  const closure = collectPlanClosureMaterializationInput(
    callbacks,
    [],
    [],
    `[turn_intake]\n[user_request]\n${userGoal}\n[/user_request]\n[/turn_intake]`,
  );

  assert.equal(closure.userGoal, userGoal);
  assert.match(closure.userGoal, /^1、/m);
  assert.match(closure.userGoal, /^2、/m);
});

test("buildShellReadValidationError blocks shell file reads but permits in-place sed writes", () => {
  const tcRun = { id: "call_run", name: "run_command" };
  const tcExec = { id: "call_exec", name: "execute_command" };

  const callbacks = createMockCallbacks();

  const errCat = buildShellReadValidationError(tcRun, { command: "cat src/App.tsx" }, callbacks);
  const errHead = buildShellReadValidationError(tcRun, { command: "head -n 20 src/App.tsx" }, callbacks);
  const okSedWrite = buildShellReadValidationError(tcRun, { command: "sed -i '' 's/a/b/g' src/App.tsx" }, callbacks);
  const errCdSed = buildShellReadValidationError(tcExec, { command: "cd /tmp/project && sed -n '270,310p' src/App.tsx" }, callbacks);
  const errCdCatPipe = buildShellReadValidationError(tcExec, { command: "cd /tmp/project && cat -n src/App.tsx | grep -A 15 rawOrders" }, callbacks);
  const okLs = buildShellReadValidationError(tcRun, { command: "ls -la" }, callbacks);
  const okCloneTail = buildShellReadValidationError(tcRun, {
    command: "git clone --depth 1 https://github.com/siddharthvaddem/openscreen.git /tmp/openscreen-repo 2>&1 | tail -5",
  }, callbacks);

  assert.ok(errCat);
  assert.equal(errCat.isError, true);
  assert.match(errCat.content, /SHELL_READ_FORBIDDEN/);
  assert.match(errCat.content, /请使用 read_file|Use read_file instead/);
  assert.match(errCat.content, /文件版本变化、新范围、上下文淘汰、补丁失配或修改后核验|changed version, new range, evicted context, patch mismatch, or post-mutation check/);
  assert.match(errCat.content, /同版本同窗口.*缓存 stub.*修改、验证或精确阻塞|same active version\/window returns a cache stub and should lead to mutation, validation, or an exact blocker/);
  assert.doesNotMatch(errCat.content, /read_file (?:is )?(?:unavailable|not available|disabled)/i);

  assert.ok(errHead);
  assert.equal(okSedWrite, null);
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
  assert.equal(isShellFileReadCommand("sed -i '' 's/a/b/g' src/App.tsx"), false);
  assert.equal(isShellFileReadCommand("sed --in-place=.bak 's/a/b/g' src/App.tsx"), false);
  assert.equal(isShellFileReadCommand("sed -Ei 's/a/b/g' src/App.tsx"), false);
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
    /if \(kind && kind !== "summary" && PLAN_ARTIFACT_MUTATION_TOOLS\.has\(tc\.name\)\)/,
  );
});

test("invalid tasks.md is rejected before disk mutation and cannot update runtime tasks", async () => {
  const lifecycle = [];
  const result = await buildPlanArtifactMutationValidationError(
    {
      id: "call-invalid-tasks",
      name: "write_file",
      arguments: JSON.stringify({
        path: ".MAIN/plans/tasks.md",
        content: "# Tasks\n- [ ] 修复逻辑",
      }),
    },
    {
      path: ".MAIN/plans/tasks.md",
      content: "# Tasks\n- [ ] 修复逻辑",
    },
    "/tmp/workspace",
    createMockCallbacks({
      onToolExecuting: () => lifecycle.push("executing"),
      onToolDone: (_name, _target, _message, meta) => lifecycle.push(meta?.internalFeedback ? "internal_done" : "done"),
      onToolError: () => lifecycle.push("error"),
      getPlanTasks: () => [{ id: "task-old", text: "修复逻辑", status: "pending" }],
    }),
  );

  assert.equal(result?.internalFeedback, true);
  assert.equal(result?.qualityGateReason, "missing_task_evidence");
  assert.equal(result?.planRecoveryAction, "rewrite");
  assert.match(result?.content || "", /(?:未|没有)写入磁盘|not written/i);
  assert.deepEqual(lifecycle, ["executing", "internal_done"]);
});

test("apply_patch cannot bypass the atomic Plan artifact quality gate", async () => {
  const planPatch = [
    "*** Begin Patch",
    "*** Update File: .MAIN/plans/plan.md",
    "@@",
    "-old",
    "+new",
    "*** End Patch",
  ].join("\n");
  const lifecycle = [];
  const result = await buildPlanArtifactMutationValidationError(
    { id: "call-plan-patch", name: "apply_patch", arguments: JSON.stringify({ patch: planPatch }) },
    { patch: planPatch },
    "/tmp/workspace",
    createMockCallbacks({
      onToolExecuting: () => lifecycle.push("executing"),
      onToolDone: (_name, _target, _message, meta) => lifecycle.push(meta?.internalFeedback ? "internal_done" : "done"),
      onToolError: () => lifecycle.push("error"),
    }),
  );

  assert.equal(result?.internalFeedback, true);
  assert.equal(result?.qualityGateReason, "plan_artifact_patch_requires_single_file_mutation");
  assert.equal(result?.planRecoveryAction, "rewrite");
  assert.match(result?.content || "", /write_file|replace_in_file/);
  assert.deepEqual(lifecycle, ["executing", "internal_done"]);
  assert.equal(isPreApprovalPlanDraftWrite("apply_patch", { patch: planPatch }), true);

  const mixedPatch = planPatch.replace(
    "*** End Patch",
    [
      "*** Update File: src/main.ts",
      "@@",
      "-old",
      "+new",
      "*** End Patch",
    ].join("\n"),
  );
  const mixedResult = await buildPlanArtifactMutationValidationError(
    { id: "call-mixed-patch", name: "apply_patch", arguments: JSON.stringify({ patch: mixedPatch }) },
    { patch: mixedPatch },
    "/tmp/workspace",
    createMockCallbacks(),
  );
  assert.equal(mixedResult?.qualityGateReason, "plan_artifact_patch_requires_single_file_mutation");
  assert.equal(isPreApprovalPlanDraftWrite("apply_patch", { patch: mixedPatch }), false);

  const sourcePatch = mixedPatch.replace(".MAIN/plans/plan.md", "src/plan.ts");
  assert.equal(
    await buildPlanArtifactMutationValidationError(
      { id: "call-source-patch", name: "apply_patch", arguments: JSON.stringify({ patch: sourcePatch }) },
      { patch: sourcePatch },
      "/tmp/workspace",
      createMockCallbacks(),
    ),
    null,
  );
});

test("Plan mutation classification accepts only the canonical session-owned artifact path", () => {
  assert.equal(isPlanArtifactPath(".MAIN/plans/plan.md"), true);
  assert.equal(isPlanArtifactPath("./.MAIN\\plans\\plan.md"), true);
  assert.equal(isPlanArtifactPath("nested/.MAIN/plans/plan.md"), false);
  assert.equal(isPlanArtifactPath("/tmp/other/.MAIN/plans/plan.md"), false);
  assert.equal(
    isPreApprovalPlanDraftWrite("write_file", { path: "nested/.MAIN/plans/plan.md", content: "# Plan" }),
    false,
  );
  assert.equal(
    isPreApprovalPlanDraftWrite("write_file", { path: "/tmp/other/.MAIN/plans/plan.md", content: "# Plan" }),
    false,
  );
});

test("shell and delete tools cannot bypass protected Plan artifact mutations", async () => {
  const shellViolation = getProtectedPlanArtifactMutationViolation(
    "run_command",
    { command: "python -c \"open('.MAIN/plans/tasks.md','w').write('bad')\"" },
    "en",
  );
  assert.equal(shellViolation?.reason, "plan_artifact_shell_access_blocked");
  assert.match(shellViolation?.message || "", /write_file|replace_in_file/);

  const deleteViolation = getProtectedPlanArtifactMutationViolation(
    "delete_workspace_path",
    { path: "./.MAIN/plans/plan.md" },
    "en",
  );
  assert.equal(deleteViolation?.reason, "plan_artifact_delete_blocked");
  assert.equal(deleteViolation?.target, ".MAIN/plans/plan.md");
  assert.equal(
    getProtectedPlanArtifactMutationViolation(
      "delete_workspace_path",
      { path: "nested/.MAIN/plans/plan.md" },
      "en",
    ),
    null,
  );

  const result = await buildPlanArtifactMutationValidationError(
    { id: "call-shell-plan-write", name: "execute_command", arguments: JSON.stringify({ command: "rm .MAIN/plans/plan.md" }) },
    { command: "rm .MAIN/plans/plan.md" },
    "/tmp/workspace",
    createMockCallbacks(),
  );
  assert.equal(result?.internalFeedback, true);
  assert.equal(result?.qualityGateReason, "plan_artifact_shell_access_blocked");
});

test("validated Plan replace is promoted to one exact full-content write", async () => {
  const original = "# Tasks\n- [ ] Repair src/old.ts\n";
  globalThis.mockIpcInvoke = async (cmd) => cmd === "read_file" ? original : {};
  const args = {
    path: ".MAIN/plans/tasks.md",
    search_text: "src/old.ts",
    replace_text: "src/new.ts",
  };
  const tc = {
    id: "call-plan-replace",
    name: "replace_in_file",
    arguments: JSON.stringify(args),
  };
  const result = await buildPlanArtifactMutationValidationError(
    tc,
    args,
    "/tmp/workspace",
    createMockCallbacks({ getPlanTasks: () => [] }),
  );

  assert.equal(result, null);
  assert.equal(tc.name, "write_file");
  assert.equal(args.search_text, undefined);
  assert.equal(args.replace_text, undefined);
  assert.equal(args.content, "# Tasks\n- [ ] Repair src/new.ts\n");
  assert.deepEqual(JSON.parse(tc.arguments), {
    path: ".MAIN/plans/tasks.md",
    content: "# Tasks\n- [ ] Repair src/new.ts\n",
  });
});

test("buildLoopDetectionValidationError blocks repeated failed mutations on the same file path", () => {
  const messages = Array.from({ length: 5 }, (_value, index) => {
    const id = `call_write_${index + 1}`;
    return [
      {
        role: "assistant",
        tool_calls: [{
          id,
          function: {
            name: "write_file",
            arguments: JSON.stringify({ path: "src/App.tsx", content: `new-${index}` }),
          },
        }],
      },
      { role: "tool", tool_call_id: id, content: "Error: mutation failed" },
    ];
  }).flat();

  const callbacks = createMockCallbacks({ messages });
  const tc = { id: "call_write_new", name: "write_file" };

  const err = buildLoopDetectionValidationError(tc, { path: "src/App.tsx" }, callbacks);
  const ok = buildLoopDetectionValidationError(tc, { path: "src/Chart.tsx" }, callbacks);

  assert.ok(err);
  assert.equal(err.isError, true);
  assert.match(err.content, /LOOP_DETECTED/);
  assert.equal(ok, null);
});

test("a successful mutation resets the same-path failure streak", () => {
  const outcomes = [
    "Error: mutation failed 1",
    "Error: mutation failed 2",
    "Error: mutation failed 3",
    "updated successfully",
    "Error: mutation failed 4",
    "Error: mutation failed 5",
  ];
  const messages = outcomes.flatMap((content, index) => {
    const id = `call_write_reset_${index + 1}`;
    return [
      {
        role: "assistant",
        tool_calls: [{
          id,
          function: {
            name: "write_file",
            arguments: JSON.stringify({ path: "src/App.tsx", content: `new-${index}` }),
          },
        }],
      },
      { role: "tool", tool_call_id: id, content },
    ];
  });

  const result = buildLoopDetectionValidationError(
    { id: "call_write_after_reset", name: "write_file" },
    { path: "src/App.tsx" },
    createMockCallbacks({ messages }),
  );

  assert.equal(result, null);
});

test("a successful apply_patch resets failures for every patched target", () => {
  const messages = [];
  for (let index = 0; index < 3; index += 1) {
    const id = `failed_before_patch_${index}`;
    messages.push({
      role: "assistant",
      tool_calls: [{
        id,
        function: {
          name: "write_file",
          arguments: JSON.stringify({ path: "src/App.tsx", content: `bad-${index}` }),
        },
      }],
    });
    messages.push({ role: "tool", tool_call_id: id, content: "Error: mutation failed" });
  }
  messages.push({
    role: "assistant",
    tool_calls: [{
      id: "successful_patch",
      function: {
        name: "apply_patch",
        arguments: JSON.stringify({
          patch: "*** Begin Patch\n*** Update File: src/App.tsx\n@@\n-old\n+new\n*** End Patch",
        }),
      },
    }],
  });
  messages.push({ role: "tool", tool_call_id: "successful_patch", content: "patched" });
  for (let index = 0; index < 2; index += 1) {
    const id = `failed_after_patch_${index}`;
    messages.push({
      role: "assistant",
      tool_calls: [{
        id,
        function: {
          name: "replace_in_file",
          arguments: JSON.stringify({ path: "./src/App.tsx", search_text: "x", replace_text: "y" }),
        },
      }],
    });
    messages.push({ role: "tool", tool_call_id: id, content: "Error: mutation failed" });
  }

  const result = buildLoopDetectionValidationError(
    { id: "write_after_patch_reset", name: "write_file" },
    { path: "src/App.tsx" },
    createMockCallbacks({ messages }),
  );
  assert.equal(result, null);
});

test("an unexecuted sibling mutation does not reset an existing failure streak", () => {
  const messages = Array.from({ length: 5 }, (_value, index) => {
    const id = `historical_failure_${index}`;
    return [
      {
        role: "assistant",
        tool_calls: [{
          id,
          function: {
            name: "write_file",
            arguments: JSON.stringify({ path: "src/App.tsx", content: `bad-${index}` }),
          },
        }],
      },
      { role: "tool", tool_call_id: id, content: "Error: mutation failed" },
    ];
  }).flat();
  messages.push({
    role: "assistant",
    tool_calls: [{
      id: "pending_sibling",
      function: {
        name: "write_file",
        arguments: JSON.stringify({ path: "src/App.tsx", content: "not executed yet" }),
      },
    }],
  });

  const result = buildLoopDetectionValidationError(
    { id: "current_write", name: "write_file" },
    { path: "/workspace/src/App.tsx" },
    createMockCallbacks({ messages }),
  );
  assert.ok(result);
  assert.match(result.content, /LOOP_DETECTED/);
});

test("path-level loop detection never blocks distinct read_file windows", () => {
  const debugEvents = [];
  const doneEvents = [];
  const readCall = (id, startLine) => ({
    id,
    function: {
      name: "read_file",
      arguments: JSON.stringify({ path: "src/App.tsx", start_line: startLine, max_lines: 100 }),
    },
  });
  const messages = [
    { role: "user", content: "modify App" },
    { role: "assistant", tool_calls: [readCall("call_read_1", 1)] },
    { role: "tool", tool_call_id: "call_read_1", content: "ok" },
    { role: "assistant", tool_calls: [readCall("call_read_2", 101)] },
    { role: "tool", tool_call_id: "call_read_2", content: "ok" },
    { role: "assistant", tool_calls: [readCall("call_read_3", 201)] },
    { role: "tool", tool_call_id: "call_read_3", content: "ok" },
    { role: "assistant", tool_calls: [readCall("call_read_4", 301)] },
    { role: "tool", tool_call_id: "call_read_4", content: "ok" },
    { role: "assistant", tool_calls: [readCall("call_read_5", 401)] },
  ];

  const callbacks = createMockCallbacks({
    messages,
    onToolDone: (...args) => doneEvents.push(args),
    onDebugEvent: (event, data) => debugEvents.push({ event, data }),
  });
  const result = buildLoopDetectionValidationError(
    { id: "call_read_new", name: "read_file" },
    { path: "src/App.tsx", start_line: 501, max_lines: 100 },
    callbacks,
  );

  assert.equal(result, null);
  assert.equal(doneEvents.length, 0);
  assert.equal(debugEvents.length, 0);
});

test("distinct read_file windows do not contribute to a later mutation limit", () => {
  const readCall = (id, startLine) => ({
    id,
    function: {
      name: "read_file",
      arguments: JSON.stringify({ path: "src/App.tsx", start_line: startLine, max_lines: 100 }),
    },
  });
  const messages = [{ role: "user", content: "inspect then update App" }];
  for (let index = 0; index < 6; index += 1) {
    const id = `window_${index}`;
    messages.push({ role: "assistant", tool_calls: [readCall(id, index * 100 + 1)] });
    messages.push({ role: "tool", tool_call_id: id, content: "READ_FILE_RESULT" });
  }

  const result = buildLoopDetectionValidationError(
    { id: "first_write", name: "write_file" },
    { path: "src/App.tsx", content: "updated" },
    createMockCallbacks({ messages }),
  );

  assert.equal(result, null);
});

test("run_command batches do not create no-progress signatures", () => {
  const signature = buildNoProgressBatchSignature([
    {
      toolCallId: "call_run",
      name: "run_command",
      target: "npm run build",
      content: JSON.stringify({ exitCode: 0, stdout: "built" }),
      isError: false,
      lifecycleState: "completed",
    },
  ]);

  assert.equal(signature, "");
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

test("buildReadBeforeModifyValidationError blocks write_file when file exists and is large", async () => {
  globalThis.mockIpcInvoke = async (cmd, args) => {
    if (cmd === "get_file_metadata") {
      if (args.path === "src/App.tsx") {
        return { path: "src/App.tsx", sizeBytes: 60 * 1024 * 1024, modifiedMs: 123456 };
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
