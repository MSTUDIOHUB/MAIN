import test from "node:test";
import assert from "node:assert/strict";
import { createTsModuleLoader } from "./tsModuleLoader.mjs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const load = createTsModuleLoader();
const { createRuntimeV2ToolPort } = load("src/store/runtimeV2/executionToolPort.ts");
const { createRuntimeV2LiveExecutionState } = load("src/store/runtimeV2/executionTypes.ts");
const executor = load("src/lib/toolExecutor.ts");
const authorization = load("src/store/runtimeV2/executionAuthorization.ts");
const { deriveRuntimeV2ProviderEffectFacts } = load("src/store/runtimeV2/executionProviderEffectFacts.ts");
const run = { sessionKey: "session", sessionEpoch: "epoch", turnId: "turn", runId: "run", parentRunId: null, attemptId: "attempt" };

for (const [name, output, reason] of [
  ["exit 6", { success: false, exitCode: 6, timedOut: false, stdout: "", stderr: "Scene is not open." }, "command_exit_nonzero"],
  ["timeout", { success: false, exitCode: null, timedOut: true, stdout: "partial", stderr: "" }, "command_timed_out"],
  ["inconsistent success flag", { success: true, exitCode: 6, timedOut: false }, "command_exit_nonzero"],
  ["native failure without exit code", { success: false, exitCode: null, timedOut: false }, "command_execution_failed"],
]) test(`ordinary ToolPort records ${name} as failed before evidence and effect projection`, async () => {
  const live = createRuntimeV2LiveExecutionState();
  const command = { run, kind: "execute_tool", phase: "acting", idempotencyKey: "shell", payload: { toolCallId: "call", toolName: "run_command", arguments: { command: "example inspect", description: "Inspect" } } };
  live.messages.push({ role: "assistant", content: "", tool_calls: [{ id: "call", type: "function", function: { name: "run_command", arguments: JSON.stringify(command.payload.arguments) } }] });
  const originalExecute = executor.executeTool, originalAuthorize = authorization.authorizeToolForCurrentTurn;
  executor.executeTool = async () => output;
  authorization.authorizeToolForCurrentTurn = async () => ({ allowed: true });
  const ports = { context: { turnId: "turn", runWorkspace: "/tmp/outcome", runSessionKey: "session", phaseLanguage: "en" }, live, get: () => ({}), now: () => 1, nextId: scope => scope, logStoreEvent() {} };
  try {
    const completion = await createRuntimeV2ToolPort(ports).execute({ command, signal: new AbortController().signal });
    assert.equal(completion.status, "failed");
    assert.equal(completion.failureKind, "execution_failed");
    assert.equal(completion.failureReasonCode, reason);
    assert.deepEqual(completion.evidence, []);
    assert.equal(live.hasExecutedMutationEffect, false);
    assert.match(live.messages.at(-1).content, /runtime-v2 failed action/);
    const facts = deriveRuntimeV2ProviderEffectFacts({ events: [{ type: "command.scheduled", command }, { ...completion, sequence: 2 }] });
    assert.equal(facts.failedToolCallIds.has("call"), true);
    assert.equal(facts.committedMutationTargetsByToolCallId.size, 0);
    assert.equal(facts.rejectedActionIdentities.size, 1);
  } finally { executor.executeTool = originalExecute; authorization.authorizeToolForCurrentTurn = originalAuthorize; }
});

test("trusted Shell denials reach the model with the safe next action and do not dispatch", async () => {
  const ipc = load("src/lib/ipc.ts");
  const originalPreflight = ipc.shellPermissionPreflight;
  const originalExecute = executor.executeTool;
  let executions = 0;
  executor.executeTool = async () => { executions++; return "unexpected command execution"; };
  try {
    for (const [rule, commandText, reasonCode, hint] of [
      ["PathnameExpansion", "ls *.hlsl", "shell_pathname_expansion", /find.*-name|glob_search/],
      ["WorkingDirectoryChange", "cd Library && ls", "shell_working_directory_change", /cwd/],
      ["WorkspacePathEscape", 'find / -name "*.hlsl"', "shell_workspace_path_escape", /workspace-relative/],
    ]) {
      ipc.shellPermissionPreflight = async (command) => ({ command, decision: "deny", segmentDecisions: [],
        matchedRule: `trusted_execution::${rule}`, riskLevel: "critical", reviewReason: "Trusted parser rejected this command" });
      const live = createRuntimeV2LiveExecutionState();
      const command = { run, kind: "execute_tool", phase: "acting", idempotencyKey: rule,
        payload: { toolCallId: "shell", toolName: "run_command", arguments: { command: commandText } } };
      const ports = { context: { turnId: "turn", runWorkspace: "/tmp/outcome", runSessionKey: "session", phaseLanguage: "en", runtimeRunIntent: "execute" },
        live, get: () => ({ currentTurnExecutionConsent: { turnId: "turn", granted: true } }),
        now: () => 1, nextId: scope => scope, logStoreEvent() {} };
      const receipt = await createRuntimeV2ToolPort(ports).execute({ command, signal: new AbortController().signal });
      assert.equal(receipt.status, "blocked");
      assert.equal(receipt.failureReasonCode, reasonCode);
      assert.match(receipt.modelContent, hint);
      assert.deepEqual(receipt.evidence, []);
    }
    assert.equal(executions, 0);
  } finally {
    ipc.shellPermissionPreflight = originalPreflight;
    executor.executeTool = originalExecute;
  }
});

test("a project validation whose manifest has changed never runs", async () => {
  const workspace = "/tmp/project-validation-fixture";
  const manifestVersion = `sha256-${"e".repeat(64)}`;
  const ipc = load("src/lib/ipc.ts");
  const originalRead = ipc.readFileWindow;
  const originalAuthorize = authorization.authorizeToolForCurrentTurn;
  const originalExecute = executor.executeTool;
  let executions = 0;
  ipc.readFileWindow = async (target, root) => {
    assert.equal(target, "package.json");
    assert.equal(root, workspace);
    return { contentVersion: `sha256-${"f".repeat(64)}` };
  };
  authorization.authorizeToolForCurrentTurn = async () => ({ allowed: true });
  executor.executeTool = async () => { executions++; };
  try {
    const command = { run, kind: "execute_validation", phase: "validating", idempotencyKey: "project-test",
      payload: { projectValidationManifestVersion: manifestVersion, toolName: "run_command", arguments: { command: "npm run test" } } };
    const ports = { context: { turnId: "turn", runWorkspace: workspace, runSessionKey: "session", phaseLanguage: "en", runtimeRunIntent: "execute" },
      live: createRuntimeV2LiveExecutionState(), get: () => ({}), now: Date.now, nextId: scope => scope, logStoreEvent() {} };
    const receipt = await createRuntimeV2ToolPort(ports).execute({ command, signal: new AbortController().signal });
    assert.equal(receipt.type, "validation.completed");
    assert.equal(receipt.passed, false);
    assert.equal(receipt.failureKind, "not_executed");
    assert.equal(receipt.failureReasonCode, "project_validation_manifest_changed");
    assert.deepEqual(receipt.evidence, []);
    assert.equal(executions, 0);
  } finally {
    ipc.readFileWindow = originalRead;
    executor.executeTool = originalExecute;
    authorization.authorizeToolForCurrentTurn = originalAuthorize;
  }
});

test("only known tool contracts own failure; user source and stderr words cannot change status", () => {
  const { runtimeV2StructuredToolOutcome: outcome } = load("src/store/runtimeV2/executionToolOutcome.ts");
  for (const name of ["read_file", "load_skill", "grep_search", "mcp_example"]) {
    assert.equal(outcome(name, { success: false, exitCode: 6, ok: false }).status, "succeeded");
    assert.equal(outcome(name, '{"success":false,"exitCode":6}').status, "succeeded");
  }
  assert.equal(outcome("run_command", { success: true, exitCode: 0, timedOut: false, stderr: "error 错误" }).status, "succeeded");
  assert.equal(outcome("browser_evaluate", { ok: false }).status, "failed");
});

test("a Unity process exit cannot stand in for a fresh, nonempty test verdict", () => {
  const { runtimeV2StructuredToolOutcome: outcome } = load("src/store/runtimeV2/executionToolOutcome.ts");
  const process = { success: true, exitCode: 0, timedOut: false };
  const batch = { command: "unity test . --mode PlayMode --output test-results.xml" };
  assert.equal(outcome("run_command", process, batch).status, "failed");
  assert.equal(outcome("run_command", { ...process, unityTestReports: [{ status: "verified", passed: 0 }] }, batch).status, "failed");
  assert.equal(outcome("run_command", { ...process, unityTestReports: [{ status: "verified", passed: 2 }] }, batch).status, "succeeded");
  assert.equal(outcome("run_command", { ...process, unityTestReports: [{ status: "verified", passed: 2 }] }, batch, { expectedTestCases: 5 }).status, "failed");
  const live = { command: "unity command test run --project-path . --caller plugin --skill unity-cli --mode playmode --filter BreakoutTests --async-tests --timeout 90 --format json --non-interactive" };
  const verdict = { success: true, mode: "PlayMode", filterApplied: "testName: BreakoutTests",
    summary: { total: 1, passed: 1, failed: 0, skipped: 0, inconclusive: 0 }, results: [{ fullName: "BreakoutTests.SceneLoads", status: "Passed" }] };
  const result = changes => ({ ...process, stdout: JSON.stringify({ success: true, data: { result: { ...verdict, ...changes } } }) });
  assert.equal(outcome("run_command", result({}), live).status, "succeeded");
  assert.equal(outcome("run_command", result({}), live, { expectedTestCases: 1 }).status, "succeeded");
  assert.equal(outcome("run_command", result({}), live, { expectedTestCases: 5 }).status, "failed");
  for (const change of [{ summary: { ...verdict.summary, failed: 1 } }, { results: [] }, { filterApplied: "testName: OtherTests" }, { results: [{ fullName: "OtherTests.LooksGood", status: "Passed" }] }]) {
    assert.equal(outcome("run_command", result(change), live).failureReasonCode, "unity_validation_verdict_unverified");
  }
  const managed = { command: "unity test . --mode PlayMode --filter BreakoutTests" };
  const authority = { useProjectEditor: true, expectedTestCases: 1 };
  assert.equal(outcome("run_command", result({}), managed, authority).status, "succeeded");
  assert.equal(outcome("run_command", result({}), managed).status, "failed", "old batch approval cannot adopt live results");
  assert.equal(outcome("run_command", { ...process, unityTestReports: [{ status: "verified", passed: 1 }] }, managed, authority).status, "succeeded");
  assert.equal(outcome("run_command", { ...process, unityTestReports: [{ status: "verified", passed: 0 }] }, managed, authority).status, "failed");
  assert.equal(outcome("run_command", process, { command: "unity command script recompile" }).status, "failed");
  assert.equal(outcome("run_command", process, { command: "unity command test run --mode playmode" }).status, "failed");
});

test("automatic Editor recheck requires a newly available exact-project route", () => {
  const { readyUnityEditorRoute } = load("src/lib/runtime-v2/unityCompilation.ts");
  const disconnected = { status: "unavailable", kind: "csharp", message: "UNITY_EDITOR_UNREACHABLE: fixture" };
  const shader = { status: "unavailable", kind: "shader_import", editor: "closed", message: "UNITY_SHADER_IMPORT_UNVERIFIED: fixture" };
  assert.equal(readyUnityEditorRoute(disconnected, null), null);
  assert.equal(readyUnityEditorRoute(disconnected, { route: "closed", version: "6000.6.5f1" }), "closed:6000.6.5f1");
  assert.equal(readyUnityEditorRoute(shader, { route: "closed", version: "6000.6.5f1" }), null);
  assert.equal(readyUnityEditorRoute(shader, { route: "connected", version: "6000.6.5f1", pid: 42 }), "connected:6000.6.5f1:42");
  assert.equal(readyUnityEditorRoute({ ...shader, editor: "connected", editorPid: 42 }, { route: "connected", version: "6000.6.5f1", pid: 42 }), null);
});

test("the live ToolPort independently checks committed C# and Shader versions", async () => {
  let checkpoint = null;
  let ordinal = 0;
  const nativeCalls = [];
  let checkedInitialShader = false;
  const shaderPath = "Assets/Atmosphere.shader";
  const scriptVersion = `sha256-${"a".repeat(64)}`;
  const shaderVersion = `sha256-${"b".repeat(64)}`;
  const fixedShaderVersion = `sha256-${"c".repeat(64)}`;
  const workspace = "/tmp/compiler-fixture";
  const diagnostic = { file: "Assets/BreakoutTests.cs", line: 88, column: 10, code: "CS0246", message: "Missing UnityTest" };
  const nativeLoad = createTsModuleLoader({ "@tauri-apps/api/core": { invoke: async (command, args) => {
    assert.equal(command, "unity_compile_project");
    assert.equal(args.workspace, workspace);
    assert.equal(args.deferClosed, false);
    assert.equal(checkpoint.aggregate.scheduledCommands.some(command => command.payload.runtimeOwnedUnityCompile), true);
    nativeCalls.push(args.checkKind);
    if (args.checkKind === "csharp") {
      assert.deepEqual(args.expectedVersions, { [diagnostic.file]: scriptVersion });
      return { status: "failed", editor: "connected", diagnostics: [diagnostic] };
    }
    assert.deepEqual(args.targets, [shaderPath]);
    if (args.expectedVersions[shaderPath] === shaderVersion && !checkedInitialShader) {
      checkedInitialShader = true;
      // Transport success without a verified target version and instance.
      return { status: "passed", editor: "connected", kind: "shader_import" };
    }
    const expected = nativeCalls.length === 3 ? shaderVersion : fixedShaderVersion;
    assert.deepEqual(args.expectedVersions, { [shaderPath]: expected });
    return { status: "passed", editor: "connected", editorPid: 72, kind: "shader_import",
      targets: [{ path: shaderPath, version: expected }] };
  } } });
  const runtime = nativeLoad("src/lib/runtime-v2/index.ts");
  const { deriveUnityCompilation, deriveUnityShaderImport, unresolvedUnityEditorCheck } = nativeLoad("src/lib/runtime-v2/unityCompilation.ts");
  const live = nativeLoad("src/store/runtimeV2/executionTypes.ts").createRuntimeV2LiveExecutionState();
  const ports = { context: { turnId: "turn", runWorkspace: workspace, runSessionKey: "session", phaseLanguage: "en", runtimeRunIntent: "execute" }, live,
    get: () => ({ runtimeV2Checkpoints: checkpoint ? { turn: checkpoint } : {} }),
    now: Date.now, nextId: scope => `${scope}-${++ordinal}`, logStoreEvent() {} };
  const nativeTool = nativeLoad("src/store/runtimeV2/executionToolPort.ts").createRuntimeV2ToolPort(ports);
  const controllerPorts = {
    checkpoint: { append: async input => {
      const result = runtime.appendRuntimeV2Checkpoint({ checkpoint, ...input });
      checkpoint = result.checkpoint;
      return result;
    } },
    provider: { request: async () => assert.fail("The compiler check does not need a provider request") },
    tool: { execute: async request => request.command.payload.toolName === "write_file" ? {
      type: "tool.completed", run, idempotencyKey: request.command.idempotencyKey, status: "succeeded",
      evidence: [{ id: request.command.idempotencyKey, kind: "mutation",
        target: request.command.payload.arguments.path, version: request.command.payload.arguments.version }],
    } : nativeTool.execute(request) },
    scheduler: { execute: async () => [] }, projection: { publish: async () => {} },
    clockId: { now: Date.now, nextId: ports.nextId, nextIdempotencyKey: ({ kind }) => `${kind}-${++ordinal}` },
  };
  let controller = new runtime.RuntimeV2Controller(controllerPorts);
  await controller.admit({ turn: { workspaceKey: workspace, sessionKey: "session", sessionEpoch: "epoch", clientSubmissionId: "submission", turnId: "turn" }, run,
    strategy: "execute", objective: "Add a PlayMode test", initialPhase: "acting" });
  await controller.schedule({ run, kind: "execute_tool", phase: "acting", idempotencyKey: "write-tests",
    payload: { toolName: "write_file", arguments: { path: diagnostic.file, version: scriptVersion } } });
  await controller.resumeScheduled();
  assert.equal(await controller.driveOnce({ checkUnityCompilation: true }), true);
  assert.equal(await controller.driveOnce({ checkUnityCompilation: true }), false);
  assert.equal(nativeCalls.length, 1);
  const receipt = deriveUnityCompilation(controller.snapshot().aggregate).receipt;
  assert.deepEqual(receipt.result.diagnostics, [diagnostic]);
  const checkShader = async (idempotencyKey, version) => {
    await controller.schedule({ run, kind: "execute_tool", phase: "acting", idempotencyKey,
      payload: { toolName: "write_file", arguments: { path: shaderPath, version } } });
    await controller.resumeScheduled();
    assert.equal(await controller.driveOnce({ checkUnityCompilation: true }), true);
    assert.equal(await controller.driveOnce({ checkUnityCompilation: true }), false);
    return deriveUnityShaderImport(controller.snapshot().aggregate).receipt.result;
  };
  assert.equal((await checkShader("write-shader", shaderVersion)).status, "unavailable");
  const shaderReceipt = deriveUnityShaderImport(controller.snapshot().aggregate).receipt;
  await controller.pauseRun({ requestId: "recheck-editor", reasonCode: "unity_editor_verification_pending",
    evidenceSequence: shaderReceipt.sequence, message: "Editor verification pending", options: ["recheck", "stop"] });
  assert.equal(await controller.driveOnce({ checkUnityCompilation: true }), false);
  const decision = runtime.appendRuntimeV2Checkpoint({ checkpoint, owner: checkpoint.owner,
    expectedRevision: checkpoint.revision, event: { schemaVersion: "runtime-v2-event.v1", type: "run.decision_recorded",
      eventId: "decision:recheck-editor", sequence: checkpoint.aggregate.nextSequence,
      at: Date.now(), run, requestId: "recheck-editor", choice: "recheck", source: "editor_reconnected" } });
  assert.equal(decision.disposition, "committed");
  checkpoint = decision.checkpoint;
  controller = new runtime.RuntimeV2Controller(controllerPorts, { aggregate: checkpoint.aggregate, revision: checkpoint.revision });
  await controller.resumeRun("recheck-editor");
  assert.equal(await controller.driveOnce({ checkUnityCompilation: true }), true);
  assert.equal(await controller.driveOnce({ checkUnityCompilation: true }), false);
  assert.equal(deriveUnityShaderImport(controller.snapshot().aggregate).receipt.result.status, "passed");
  const shaderResult = await checkShader("fix-shader", fixedShaderVersion);
  assert.equal(shaderResult.status, "passed");
  assert.equal(shaderResult.editorPid, 72);
  assert.deepEqual(nativeCalls, ["csharp", "shader_import", "shader_import", "shader_import"]);
  assert.equal(unresolvedUnityEditorCheck(controller.snapshot().aggregate).result.status, "failed");
  assert.equal(controller.snapshot().aggregate.evidence.filter(item => item.kind === "mutation").length, 3);
  assert.equal(controller.snapshot().aggregate.events.some(event => event.type === "validation.completed"), false);
});

test("Rust → executeTool → ToolPort → Controller keeps native failures, skips batch tail and survives cold restore", { skip: process.env.MAIN_NATIVE_TOOL_BRIDGE_TEST !== "1" }, async t => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "main-outcome-native-"));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const nativeResults = [];
  const nativeLoad = createTsModuleLoader({ "@tauri-apps/api/core": { invoke: async (cmd, args) => {
    const result = JSON.parse(execFileSync("src-tauri/target/debug/examples/runtime_tool_bridge", [], { input: JSON.stringify({ workspace, cmd, args }), encoding: "utf8" }));
    nativeResults.push({ cmd, result });
    if (!result.ok) throw new Error(result.error);
    return result.body;
  } } });
  const runtime = nativeLoad("src/lib/runtime-v2/index.ts");
  const { createRuntimeV2ToolPort: createPort } = nativeLoad("src/store/runtimeV2/executionToolPort.ts");
  const { createRuntimeV2LiveExecutionState: createLive } = nativeLoad("src/store/runtimeV2/executionTypes.ts");
  const { deriveRuntimeV2ProviderEffectFacts: effects } = nativeLoad("src/store/runtimeV2/executionProviderEffectFacts.ts");
  for (const [shell, timeout] of [["python3 -c 'import sys;sys.exit(6)'", 1000], ["python3 -c 'import time;time.sleep(2)'", 50], ["python3 -c 'from pathlib import Path;Path(\"partial.txt\").write_text(\"x\");raise SystemExit(6)'", 1000]]) {
    let checkpoint = null, ordinal = 0;
    const live = createLive();
    const ports = { context: { turnId: "turn", runWorkspace: workspace, runSessionKey: "session", phaseLanguage: "en", runtimeRunIntent: "execute" }, live,
      get: () => ({ autoApproveTools: true, autoApproveToolScopes: ["shell"], currentTurnExecutionConsent: { turnId: "turn", granted: true }, runtimeV2Checkpoints: checkpoint ? { turn: checkpoint } : {} }),
      now: Date.now, nextId: scope => `${scope}-${++ordinal}`, logStoreEvent() {} };
    const calls = [{ id: "first", name: "run_command", arguments: { command: shell, timeout_ms: timeout, description: "Native outcome" } },
      { id: "tail", name: "run_command", arguments: { command: "printf forbidden > tail.txt", description: "Dependent tail" } }];
    live.messages.push({ role: "assistant", content: "", tool_calls: calls.map(call => ({ id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments) } })) });
    const controller = new runtime.RuntimeV2Controller({
      checkpoint: { append: async input => { const result = runtime.appendRuntimeV2Checkpoint({ checkpoint, ...input }); checkpoint = result.checkpoint; return result; } },
      provider: { request: async () => ({ toolCalls: calls, diagnostics: [], visibleText: "" }) }, tool: createPort(ports), scheduler: { execute: async () => [] },
      projection: { publish: async () => {} }, clockId: { now: Date.now, nextId: ports.nextId, nextIdempotencyKey: ({ kind }) => `${kind}-${++ordinal}` },
    });
    await controller.admit({ turn: { workspaceKey: workspace, sessionKey: "session", sessionEpoch: "epoch", clientSubmissionId: "submission", turnId: "turn" }, run,
      strategy: "execute", objective: "Run a failing command and do not execute its dependent tail", initialPhase: "acting" });
    await controller.driveOnce();
    await controller.driveOnce();
    await controller.driveOnce();
    const aggregate = controller.snapshot().aggregate;
    const receipts = aggregate.events.filter(event => event.type === "tool.completed");
    assert.equal(receipts[0]?.status, "failed", JSON.stringify(receipts));
    assert.equal(receipts[0].failureKind, "execution_failed");
    assert.equal(receipts[1]?.status, "blocked");
    assert.equal(receipts[1].failureReasonCode, "provider_batch_predecessor_failed");
    assert.deepEqual(receipts.flatMap(event => event.evidence), []);
    assert.equal(await fs.stat(path.join(workspace, "tail.txt")).then(() => true, () => false), false);
    const cold = runtime.normalizeRuntimeV2Checkpoint(runtime.serializeRuntimeV2CheckpointMap({ turn: checkpoint }).turn).aggregate;
    assert.deepEqual(cold.events.filter(event => event.type === "tool.completed"), receipts);
    assert.equal(effects(cold).failedToolCallIds.has("first"), true);
    assert.equal(effects(cold).unexecutedToolCallIds.has("tail"), true);
    assert.match(live.messages.find(message => message.tool_call_id === "first").content, /runtime-v2 failed action/);
  }
  assert.equal(await fs.readFile(path.join(workspace, "partial.txt"), "utf8"), "x");
  const executed = nativeResults.filter(item => item.cmd === "run_command");
  assert.equal(executed.length, 3);
  assert.deepEqual(executed.map(item => item.result.body.success), [false, false, false]);
  assert.equal(executed[1].result.body.timedOut, true);
});

test("bound MCP compiler fallback only reports new attributable diagnostics", async () => {
  const workspace = "/tmp/compiler-fixture";
  const path = "Assets/Smoke.cs";
  const version = `sha256-${"c".repeat(64)}`;
  const server = { serverUrl: "http://localhost:8080/mcp", instanceId: "fixture@0000000000000000",
    projectHash: "0000000000000000", editorVersion: "2022.3.62t16" };
  const stale = { type: "Error", file: path, line: 2, message: `${path}(2,1): error CS1002: Historic error` };
  const current = { type: "Error", file: path, line: 4, message: `${path}(4,2): error CS0246: MissingFixtureType` };
  const other = { type: "Error", file: "Assets/Other.cs", line: 1, message: "Assets/Other.cs(1,1): error CS1002: Unrelated" };
  const calls = [];
  let autoApproveTools = true;
  let addCurrent = true;
  let compilerProbeEnabled = false;
  let compilerFailed = false;
  let refreshAt = 0;
  const fixture = createTsModuleLoader({
    "../../lib/ipc": { readFileWindow: async () => ({ contentVersion: version }) },
    "../../lib/mcpClient": {
      executeMcpTool: async (_url, tool, args, binding) => {
        assert.equal(binding, server);
        calls.push(tool);
        if (tool === "refresh_unity") {
          assert.equal(args.compile, "request");
          assert.equal(args.wait_for_ready, false);
          refreshAt = Date.now();
          return JSON.stringify({ success: true, data: { compile_requested: true } });
        }
        if (tool === "execute_code") {
          assert.match(args.code, /EditorUtility\.scriptCompilationFailed/);
          return JSON.stringify({ success: true, data: { result: { dataPath: `${workspace}/Assets`, editorVersion: server.editorVersion,
            idle: true, compilerFailed } } });
        }
        assert.equal(args.action, "get");
        return JSON.stringify({ success: true, data: { truncated: false,
          items: refreshAt && addCurrent ? [stale, other, current] : [stale] } });
      },
      readBoundUnityMcpEditorState: async () => ({
        success: true, data: { compilation: { is_compiling: false, is_domain_reload_pending: false,
          last_compile_started_unix_ms: refreshAt, last_compile_finished_unix_ms: refreshAt }, assets: { is_updating: false } },
      }),
    },
    "../../lib/workspaceMcp": { normalizeMcpWorkspace: value => value },
    "./executionAuthorization": { authorizeToolForCurrentTurn: async () => ({ allowed: true }) },
    "./executionAuthorizationContext": {
      authorizationFor: () => ({
        toolCatalog: { entries: ["read_console", "refresh_unity", ...(compilerProbeEnabled ? ["execute_code"] : [])].map(exposedName => ({
          exposedName, source: "mcp", serverUrl: server.serverUrl, executionName: exposedName,
        })) },
        capabilityRegistry: { tools: { read_console: { enabled: true }, refresh_unity: { enabled: true }, execute_code: { enabled: true } } },
        policy: { disabledRiskLevels: [] },
      }),
      runtimeV2ToolRiskForCall: (_auth, name) => name === "read_console" ? "external_read" : "external_write",
    },
  });
  const { observeBoundUnityMcpDiagnostics } = fixture("src/store/runtimeV2/executionUnityMcpDiagnostics.ts");
  const input = { workspace, kind: "csharp", targets: [path], expectedVersions: { [path]: version },
    signal: new AbortController().signal, deadlineAt: Date.now() + 5_000,
    ports: { context: { workspaceMcpSnapshot: { workspace, unityBindings: { [server.serverUrl]: server } } },
      get: () => ({ autoApproveTools, autoApproveToolScopes: ["mcp_action"] }) } };
  const failed = await observeBoundUnityMcpDiagnostics(input);
  assert.equal(failed.status, "failed");
  assert.deepEqual(failed.diagnostics, [{ file: path, line: 4, column: 2, code: "CS0246", message: "MissingFixtureType" }]);
  assert.deepEqual(failed.targets, [{ path, version }]);
  assert.deepEqual(calls, ["read_console", "refresh_unity", "read_console"]);

  refreshAt = 0;
  addCurrent = false;
  assert.equal((await observeBoundUnityMcpDiagnostics(input)).status, "unavailable");

  compilerProbeEnabled = true;
  assert.equal((await observeBoundUnityMcpDiagnostics(input)).status, "passed");
  compilerFailed = true;
  assert.equal((await observeBoundUnityMcpDiagnostics(input)).status, "failed");

  autoApproveTools = false;
  calls.length = 0;
  await assert.rejects(observeBoundUnityMcpDiagnostics(input), /MCP_UNITY_CHECK_REQUIRES_APPROVAL/);
  assert.deepEqual(calls, ["read_console"]);
});

test("a bound MCP Editor can verify the exact Shader import without a CLI connector", async () => {
  const workspace = "/tmp/shader-fixture";
  const target = "Assets/Smoke.shader";
  const version = `sha256-${"b".repeat(64)}`;
  const server = { serverUrl: "http://127.0.0.1:8080/mcp", instanceId: "fixture@0000000000000000",
    projectHash: "0000000000000000", editorVersion: "2022.3.62t16" };
  let imports = [{ path: target, completed: true, diagnostics: [] }];
  let autoApproveTools = true;
  let currentVersion = version;
  let reportedDataPath = `${workspace}/Assets`;
  let versionAfterImport = version;
  let dispatches = 0;
  const importProgram = await fs.readFile(new URL("../../src-tauri/Scripts/unity_shader_import.cs", import.meta.url), "utf8");
  const fixture = createTsModuleLoader({
    "../../../src-tauri/Scripts/unity_shader_import.cs?raw": { default: importProgram },
    "../../lib/ipc": { readFileWindow: async (path, root) => {
      assert.equal(path, target);
      assert.equal(root, workspace);
      return { contentVersion: currentVersion };
    } },
    "../../lib/mcpClient": { executeMcpTool: async (_url, tool, args, binding) => {
      assert.equal(binding, server);
      assert.equal(tool, "execute_code");
      assert.equal(args.action, "execute");
      assert.equal(args.safety_checks, true);
      assert.ok(args.code.includes(JSON.stringify(target)));
      assert.ok(args.code.includes(JSON.stringify(`${workspace}/Assets`)));
      assert.ok(args.code.includes(JSON.stringify(server.editorVersion)));
      assert.match(args.code, /ForceSynchronousImport/);
      dispatches++;
      currentVersion = versionAfterImport;
      return JSON.stringify({ success: true, data: { result: { imports, dataPath: reportedDataPath, editorVersion: server.editorVersion } } });
    } },
    "../../lib/workspaceMcp": { normalizeMcpWorkspace: value => value },
    "./executionAuthorization": { authorizeToolForCurrentTurn: async () => ({ allowed: true }) },
    "./executionAuthorizationContext": {
      authorizationFor: () => ({ toolCatalog: { entries: [{ source: "mcp", serverUrl: server.serverUrl,
        executionName: "execute_code", exposedName: "execute_code" }] },
        capabilityRegistry: { tools: { execute_code: { enabled: true } } }, policy: { disabledRiskLevels: [] } }),
      runtimeV2ToolRiskForCall: () => "external_write",
    },
  });
  const { observeBoundUnityMcpDiagnostics } = fixture("src/store/runtimeV2/executionUnityMcpDiagnostics.ts");
  const input = { workspace, kind: "shader_import", targets: [target], expectedVersions: { [target]: version },
    signal: new AbortController().signal, deadlineAt: Date.now() + 5_000,
    ports: { context: { workspaceMcpSnapshot: { workspace, unityBindings: { [server.serverUrl]: server } } },
      get: () => ({ autoApproveTools, autoApproveToolScopes: ["mcp_action"] }) } };
  const passed = await observeBoundUnityMcpDiagnostics(input);
  assert.equal(passed?.status, "passed");
  assert.equal(passed.editorInstanceId, server.instanceId);
  assert.deepEqual(passed.targets, [{ path: target, version }]);

  imports = [{ path: target, completed: true, diagnostics: [{ line: 12, message: "Invalid pass" }] }];
  const failed = await observeBoundUnityMcpDiagnostics(input);
  assert.equal(failed.status, "failed");
  assert.deepEqual(failed.diagnostics, [{ file: target, line: 12, column: 0, code: "SHADER_IMPORT", message: "Invalid pass" }]);
  imports = [{ path: "Assets/Other.shader", completed: true, diagnostics: [] }];
  assert.equal((await observeBoundUnityMcpDiagnostics(input)).status, "unavailable");
  imports = [{ path: target, completed: false, diagnostics: [] }];
  assert.equal((await observeBoundUnityMcpDiagnostics(input)).status, "unavailable");
  reportedDataPath = "/tmp/another-project/Assets";
  await assert.rejects(observeBoundUnityMcpDiagnostics(input), /MCP_UNITY_CHECK_EDITOR_MISMATCH/);
  reportedDataPath = `${workspace}/Assets`;
  versionAfterImport = `sha256-${"c".repeat(64)}`;
  await assert.rejects(observeBoundUnityMcpDiagnostics(input), /MCP_UNITY_CHECK_TARGET_CHANGED/);
  currentVersion = `sha256-${"d".repeat(64)}`;
  await assert.rejects(observeBoundUnityMcpDiagnostics(input), /MCP_UNITY_CHECK_TARGET_CHANGED/);
  currentVersion = version;
  autoApproveTools = false;
  await assert.rejects(observeBoundUnityMcpDiagnostics(input), /MCP_UNITY_CHECK_REQUIRES_APPROVAL/);
  assert.equal(dispatches, 6);
});
