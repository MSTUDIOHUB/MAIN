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

test("only known tool contracts own failure; user source and stderr words cannot change status", () => {
  const { runtimeV2StructuredToolOutcome: outcome } = load("src/store/runtimeV2/executionToolOutcome.ts");
  for (const name of ["read_file", "load_skill", "grep_search", "mcp_example"]) {
    assert.equal(outcome(name, { success: false, exitCode: 6, ok: false }).status, "succeeded");
    assert.equal(outcome(name, '{"success":false,"exitCode":6}').status, "succeeded");
  }
  assert.equal(outcome("run_command", { success: true, exitCode: 0, timedOut: false, stderr: "error 错误" }).status, "succeeded");
  assert.equal(outcome("browser_evaluate", { ok: false }).status, "failed");
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
