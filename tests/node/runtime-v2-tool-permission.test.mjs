import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";

const root = process.cwd();
const cache = new Map();
const ipc = { shellPermissionPreflight: async () => { throw new Error("Unexpected preflight"); } };
function loadTs(sourcePath) {
  const source = path.resolve(sourcePath);
  if (source === path.join(root, "src/lib/ipc.ts")) return ipc;
  if (cache.has(source)) return cache.get(source);
  const module = { exports: {} };
  cache.set(source, module.exports);
  const output = ts.transpileModule(fs.readFileSync(source, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    fileName: source,
  }).outputText;
  const require = createRequire(source);
  new Function("exports", "module", "require", output)(module.exports, module, (name) => {
    if (name.startsWith(".")) {
      const base = path.resolve(path.dirname(source), name);
      for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")]) {
        if (/\.tsx?$/.test(candidate) && fs.existsSync(candidate)) return loadTs(candidate);
      }
    }
    return require(name);
  });
  return module.exports;
}

const { resolveRuntimeV2ToolAuthorization } = loadTs(path.join(root, "src/store/runtimeV2/executionExternalLocalRead.ts"));
const { authorizeToolForCurrentTurn } = loadTs(path.join(root, "src/store/runtimeV2/executionAuthorization.ts"));
const { createRuntimeV2LiveExecutionState } = loadTs(path.join(root, "src/store/runtimeV2/executionTypes.ts"));
const { buildShellPermissionApproval } = loadTs(path.join(root, "src/lib/shellAutoApproval.ts"));

function fixture({ consent = null, command = "unity --version", decision = "allow", critical = false } = {}) {
  const state = {
    config: {},
    currentTurnExecutionConsent: consent,
    autoApproveTools: false,
    approvedShellPermissionRules: [],
    approvedLocalFileReadPaths: [],
    taskFlow: [], runtimeEvents: [],
    conversationTurns: [{ id: "turn", title: "Inspect CLI", blockIds: [] }],
    harnessRunMarker: { sessionKey: "/fixture:1", turnId: "turn", runId: "run", status: "running" },
    _nextTaskId: () => 1,
  };
  const preflight = {
    command, decision, requiresApproval: decision === "ask",
    segmentDecisions: [], suggestedRules: ["unity"],
    riskLevel: critical ? "critical" : "low",
    reviewReason: "fixture shell policy",
  };
  ipc.shellPermissionPreflight = async (actual) => {
    assert.equal(actual, command);
    return preflight;
  };
  const ports = {
    get: () => state,
    set: (value) => Object.assign(state, typeof value === "function" ? value(state) : value),
    live: createRuntimeV2LiveExecutionState(),
    context: { turnId: "turn", runWorkspace: "/fixture", runSessionKey: "/fixture:1", runtimeRunIntent: "execute", phaseLanguage: "en" },
    now: () => 100,
    logStoreEvent: () => {},
  };
  const abort = new AbortController();
  const request = {
    ports,
    command: { kind: "execute_tool", phase: "observing", idempotencyKey: "exact-command", payload: { toolName: "run_command", arguments: { command } },
      run: { sessionKey: "/fixture:1", sessionEpoch: "epoch", turnId: "turn", runId: "run", parentRunId: null } },
    toolName: "run_command", args: { command, cwd: "." }, target: command, failureContextTarget: command, signal: abort.signal,
  };
  return { state, ports, request, abort, preflight };
}

async function pendingReview(f) {
  let settled = false;
  const pending = resolveRuntimeV2ToolAuthorization(f.request).then((result) => { settled = true; return result; });
  for (let i = 0; i < 10; i++) await Promise.resolve();
  assert.equal(settled, false, "a concrete permission request must wait for its review, not return to model recovery");
  assert.equal(f.state.activeActionRequest?.status, "pending");
  assert.equal(f.state.agentStatus, "pending_review");
  return { pending, resolve: f.state.pendingReviewResolve };
}

test("missing and stale Turn consent pause the exact shell call without granting broader authority", async () => {
  for (const consent of [null, { turnId: "old-turn", granted: true }, { turnId: "turn", granted: false }]) {
    const f = fixture({ consent });
    const { pending, resolve } = await pendingReview(f);
    assert.equal(f.state.activeActionRequest.turnId, "turn");
    assert.equal(f.state.activeActionRequest.runId, "run");
    assert.equal(f.state.activeActionRequest.toolCallId, "exact-command");
    assert.equal(f.state.pendingToolCall.arguments.command, "unity --version");
    resolve({ action: "accept" });
    const result = await pending;
    assert.equal(result.allowed, true);
    assert.equal(f.state.currentTurnExecutionConsent, consent);
    assert.equal(f.state.autoApproveTools, false);
    const next = await authorizeToolForCurrentTurn(f.ports, "run_command", f.request.args);
    assert.equal(next.allowed, false);
    assert.equal(next.approvalRequired, true);
  }
});

test("dangerous shell review preserves exact command bytes and the one-call shell approval packet", async () => {
  const command = 'rm "Assets/old\\ sprite.txt"';
  const f = fixture({ consent: { turnId: "turn", granted: true }, command, decision: "ask", critical: true });
  const { pending, resolve } = await pendingReview(f);
  assert.equal(f.state.activeActionRequest.target, command);
  assert.deepEqual(f.state.pendingToolCall.arguments, f.request.args);
  assert.equal(f.state.pendingToolCall.localFileReadPath, undefined);
  assert.deepEqual(f.state.pendingToolCall.shellPermissionDecision, f.preflight);
  const packet = buildShellPermissionApproval(f.preflight, "once");
  resolve({ action: "accept", shellPermissionApproval: packet });
  const result = await pending;
  assert.equal(result.allowed, true);
  assert.deepEqual(result.authorization.shellPermissionApproval, packet);
});

test("shell rejection cannot be revived by a later approval", async () => {
  const f = fixture();
  const { pending, resolve } = await pendingReview(f);
  resolve({ action: "reject" });
  const result = await pending;
  assert.equal(result.allowed, false);
  assert.match(f.ports.live.permissionRejection.finalMarkdown, /denied/i);
  resolve({ action: "accept" });
  assert.equal((await pending).allowed, false);
});

test("a shell approval cannot authorize different command bytes", async () => {
  const f = fixture({ decision: "ask" });
  const { pending, resolve } = await pendingReview(f);
  resolve({ action: "accept", shellPermissionApproval: buildShellPermissionApproval({ ...f.preflight, command: "different command" }, "once") });
  assert.equal((await pending).allowed, false);
});

test("cancellation and a replaced Run cannot accept an old shell approval", async () => {
  for (const change of ["cancel", "replace", "arguments"]) {
    const f = fixture();
    const { pending, resolve } = await pendingReview(f);
    if (change === "cancel") f.abort.abort();
    else if (change === "replace") f.state.harnessRunMarker = { ...f.state.harnessRunMarker, runId: "new-run" };
    else f.request.args.cwd = "another-project";
    resolve({ action: "accept" });
    assert.equal((await pending).allowed, false);
    assert.equal(f.state.currentTurnExecutionConsent, null);
  }
});

test("existing safe shell Auto Review and policy denial keep their boundaries", async () => {
  const safe = fixture({ consent: { turnId: "turn", granted: true }, decision: "ask" });
  const automatic = await resolveRuntimeV2ToolAuthorization(safe.request);
  assert.equal(automatic.allowed, true);
  assert.equal(automatic.authorization.shellPermissionApproval.command, safe.preflight.command);
  assert.equal(safe.state.activeActionRequest, undefined);

  const denied = fixture({ consent: { turnId: "turn", granted: true }, decision: "deny" });
  assert.equal((await resolveRuntimeV2ToolAuthorization(denied.request)).allowed, false);
  assert.equal(denied.state.activeActionRequest, undefined);
});

test("external local reads still require the exact normalized path grant", async () => {
  const f = fixture();
  f.request.toolName = "read_file";
  f.request.args = { path: "/outside\\logs\\main.log" };
  f.request.target = f.request.failureContextTarget = "/outside/logs/main.log";
  const { pending, resolve } = await pendingReview(f);
  assert.equal(f.state.pendingToolCall.localFileReadPath, "/outside/logs/main.log");
  f.state.approvedLocalFileReadPaths = ["/outside/logs/main.log"];
  resolve({ action: "accept", grantLocalFileReadPath: "/outside/logs/main.log" });
  const result = await pending;
  assert.equal(result.allowed, true);
  assert.equal(result.authorization.allowExternalLocalRead, true);
});
