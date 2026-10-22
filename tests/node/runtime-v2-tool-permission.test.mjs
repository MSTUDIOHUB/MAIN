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

function fixture({ consent = null, command = "unity --version", decision = "allow", critical = false, autoApproveTools = false, autoApproveToolScopes = [], approvalRequiredCapabilities = [] } = {}) {
  const state = {
    config: {},
    currentTurnExecutionConsent: consent,
    autoApproveTools,
    autoApproveToolScopes,
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
    context: { turnId: "turn", runWorkspace: "/fixture", runSessionKey: "/fixture:1", runtimeRunIntent: "execute", phaseLanguage: "en", approvalRequiredCapabilities },
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
  const f = fixture({ consent: { turnId: "turn", granted: true }, command, decision: "ask", critical: true, autoApproveTools: true, autoApproveToolScopes: ["shell"] });
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
  const safe = fixture({ consent: { turnId: "turn", granted: true }, decision: "ask", autoApproveTools: true, autoApproveToolScopes: ["shell"] });
  const automatic = await resolveRuntimeV2ToolAuthorization(safe.request);
  assert.equal(automatic.allowed, true);
  assert.equal(automatic.authorization.shellPermissionApproval.command, safe.preflight.command);
  assert.equal(safe.state.activeActionRequest, undefined);

  const denied = fixture({ consent: { turnId: "turn", granted: true }, decision: "deny", autoApproveTools: true, autoApproveToolScopes: ["shell"] });
  assert.equal((await resolveRuntimeV2ToolAuthorization(denied.request)).allowed, false);
  assert.equal(denied.state.activeActionRequest, undefined);
});

test("Execute consent cannot enable safe shell ask Auto Review without the session flag and scope", async () => {
  for (const settings of [
    { autoApproveTools: false, autoApproveToolScopes: [] },
    { autoApproveTools: false, autoApproveToolScopes: ["shell"] },
    { autoApproveTools: true, autoApproveToolScopes: [] },
    { autoApproveTools: true, autoApproveToolScopes: ["workspace_write"] },
  ]) {
    const f = fixture({ consent: { turnId: "turn", granted: true }, decision: "ask", ...settings });
    const initial = await authorizeToolForCurrentTurn(f.ports, "run_command", f.request.args);
    assert.equal(initial.allowed, false, "task consent cannot create an Auto Review shell approval");
    assert.equal(initial.approvalRequired, true);
    assert.equal(initial.shellPermissionApproval, undefined);
    const { pending, resolve } = await pendingReview(f);
    resolve({ action: "accept", shellPermissionApproval: buildShellPermissionApproval(f.preflight, "once") });
    assert.equal((await pending).allowed, true);
    assert.equal(f.state.autoApproveTools, settings.autoApproveTools);
    assert.deepEqual(f.state.autoApproveToolScopes, settings.autoApproveToolScopes);
    assert.equal((await authorizeToolForCurrentTurn(f.ports, "run_command", f.request.args)).allowed, false,
      "one-call approval cannot enable review of later commands");
  }
});

test("an explicit shell allow rule does not require enabling Auto Review", async () => {
  const f = fixture({ consent: { turnId: "turn", granted: true }, decision: "allow", autoApproveTools: false });
  const result = await resolveRuntimeV2ToolAuthorization(f.request);
  assert.equal(result.allowed, true);
  assert.equal(result.authorization.shellPermissionApproval, undefined);
  assert.equal(f.state.activeActionRequest, undefined);
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

test("canonical Turn capability restrictions survive checkpoint replay", async () => {
  const runtime = loadTs(path.join(root, "src/lib/runtime-v2/index.ts"));
  let checkpoint = null;
  let sequence = 0;
  const turn = { workspaceKey: "/fixture", sessionKey: "/fixture:1", sessionEpoch: "epoch", clientSubmissionId: "submission", turnId: "turn" };
  const run = { sessionKey: "/fixture:1", sessionEpoch: "epoch", turnId: "turn", runId: "run", parentRunId: null, attemptId: "attempt" };
  const controller = new runtime.RuntimeV2Controller({
    checkpoint: { append: async (input) => {
      const result = runtime.appendRuntimeV2Checkpoint({ checkpoint, ...input });
      if (result.checkpoint) checkpoint = result.checkpoint;
      return result;
    } },
    projection: { publish: async () => {} },
    clockId: { now: () => ++sequence, nextId: (scope) => `${scope}-${++sequence}` },
  });
  await controller.admit({ turn, run, strategy: "execute", objective: "Inspect and report without writes or commands.", capabilityRestrictions: ["workspace_write", "command"], initialPhase: "observing" });
  assert.deepEqual(controller.snapshot().aggregate.objective.capabilityRestrictions, ["workspace_write", "command"]);
  assert.deepEqual(checkpoint.events[0].capabilityRestrictions, ["workspace_write", "command"]);
  const restored = runtime.normalizeRuntimeV2Checkpoint(JSON.parse(JSON.stringify(checkpoint)));
  assert.deepEqual(restored.aggregate.objective.capabilityRestrictions, ["workspace_write", "command"]);
});

test("current no-write contract cannot be overridden by task consent, shell allow or auto review", async () => {
  const f = fixture({ consent: { turnId: "turn", granted: true }, autoApproveTools: true, autoApproveToolScopes: ["shell"] });
  f.ports.context.capabilityRestrictions = ["workspace_write"];
  let inspections = 0;
  ipc.shellPermissionPreflight = async () => { inspections += 1; return f.preflight; };
  const decision = await authorizeToolForCurrentTurn(f.ports, "run_command", f.request.args);
  assert.equal(decision.allowed, false, "an opaque command can write and cannot bypass current no-write authority");
  assert.equal(decision.approvalRequired, undefined, "approval cannot undo the current explicit restriction");
  assert.match(decision.reason, /workspace_write/);
  assert.equal(inspections, 0, "the restriction is enforced before native shell approval");
});

test("current no-command contract filters the actual provider surface and rejects a forged call", async () => {
  const { providerToolDefinitionsForCommand } = loadTs(path.join(root, "src/store/runtimeV2/executionAuthorizationContext.ts"));
  const f = fixture({ consent: { turnId: "turn", granted: true }, autoApproveTools: true });
  f.ports.context.capabilityRestrictions = ["command"];
  const definitions = providerToolDefinitionsForCommand(f.ports, { ...f.request.command, kind: "request_model", payload: { mode: "execute" } });
  assert.equal(definitions.some((tool) => tool.function.name === "run_command"), false);
  assert.equal(definitions.some((tool) => tool.function.name === "read_file"), true, "unrelated safe workspace reads remain available");
  const decision = await authorizeToolForCurrentTurn(f.ports, "run_command", f.request.args);
  assert.equal(decision.allowed, false);
  assert.equal(decision.approvalRequired, undefined);
  assert.match(decision.reason, /command/);
});

async function restrictedCheckpoint(restrictions, approvalRequiredCapabilities) {
  const runtime = loadTs(path.join(root, "src/lib/runtime-v2/index.ts"));
  let checkpoint = null;
  let sequence = 0;
  const controller = new runtime.RuntimeV2Controller({
    checkpoint: { append: async (input) => {
      const result = runtime.appendRuntimeV2Checkpoint({ checkpoint, ...input });
      if (result.checkpoint) checkpoint = result.checkpoint;
      return result;
    } },
    projection: { publish: async () => {} },
    clockId: { now: () => ++sequence, nextId: (scope) => `${scope}-${++sequence}` },
  });
  await controller.admit({
    turn: { workspaceKey: "/fixture", sessionKey: "/fixture:1", sessionEpoch: "epoch", clientSubmissionId: "submission", turnId: "turn" },
    run: { sessionKey: "/fixture:1", sessionEpoch: "epoch", turnId: "turn", runId: "run", parentRunId: null, attemptId: "attempt" },
    strategy: "execute", objective: "Respect this Turn's explicit capability restrictions.",
    capabilityRestrictions: restrictions, approvalRequiredCapabilities, initialPhase: "observing",
  });
  return JSON.parse(JSON.stringify(checkpoint));
}

test("ExecutionToolPort enforces restored restrictions before approvals, execution and cached receipt replay", async () => {
  const { createRuntimeV2ToolPort } = loadTs(path.join(root, "src/store/runtimeV2/executionToolPort.ts"));
  const { providerToolDefinitionsForCommand } = loadTs(path.join(root, "src/store/runtimeV2/executionAuthorizationContext.ts"));
  for (const [restriction, toolName, args] of [
    ["workspace_write", "run_command", { command: "example --inspect", cwd: "." }],
    ["workspace_write", "write_file", { path: "result.txt", content: "forbidden" }],
    ["command", "run_command", { command: "example --inspect", cwd: "." }],
    ["workspace_read", "read_file", { path: "private.txt" }],
  ]) {
    const f = fixture({ consent: { turnId: "turn", granted: true }, autoApproveTools: true, autoApproveToolScopes: ["shell", "workspace_write"] });
    f.state.runtimeV2Checkpoints = { turn: await restrictedCheckpoint([restriction]) };
    f.ports.context.capabilityRestrictions = [];
    f.ports.live.coveredReadToolResults.set("restricted-call", "previously approved cached source");
    f.ports.live.messages.push({ role: "assistant", content: "", tool_calls: [{ id: "restricted-call", type: "function", function: { name: toolName, arguments: JSON.stringify(args) } }] });
    let inspections = 0;
    ipc.shellPermissionPreflight = async () => { inspections++; return f.preflight; };
    const definitions = providerToolDefinitionsForCommand(f.ports, { ...f.request.command, kind: "request_model", payload: { mode: "execute" } });
    const event = await createRuntimeV2ToolPort(f.ports).execute({
      command: { ...f.request.command, payload: { toolName, arguments: args, toolCallId: "restricted-call" } }, signal: f.abort.signal,
    });
    assert.equal(event.type, "tool.completed");
    assert.equal(event.status, "blocked");
    assert.equal(event.failureKind, "not_authorized");
    assert.equal(event.failureReasonCode, "turn_capability_restricted");
    assert.equal(definitions.some((tool) => tool.function.name === toolName), false, `${restriction} is absent from the actual restored provider surface`);
    assert.equal(event.receiptOrigin, undefined, "an old source receipt cannot become a successful restricted read");
    assert.deepEqual(event.evidence, []);
    assert.match(f.ports.live.messages.at(-1).content, new RegExp(restriction));
    assert.equal(inspections, 0, "approval cannot override the durable restriction");
    assert.equal(f.state.activeActionRequest, undefined);
  }
});

test("child advertised tools and forged calls inherit the parent's restored capability restrictions", async () => {
  const childProvider = loadTs(path.join(root, "src/store/runtimeV2/executionSubagentProvider.ts"));
  const executor = loadTs(path.join(root, "src/lib/toolExecutor.ts"));
  const { startRuntimeV2Child } = loadTs(path.join(root, "src/store/runtimeV2/executionSubagentRunner.ts"));
  const originalRequest = childProvider.requestRuntimeV2ChildStep;
  const originalExecute = executor.executeTool;
  let executed = 0;
  const f = fixture({ consent: { turnId: "turn", granted: true }, autoApproveTools: true, autoApproveToolScopes: ["shell"] });
  f.state.runtimeV2Checkpoints = { turn: await restrictedCheckpoint(["workspace_read", "command"]) };
  f.ports.context.capabilityRestrictions = [];
  executor.executeTool = async () => { executed++; throw new Error("Restricted child action reached execution"); };
  try {
    for (const call of [
      { id: "forged-read", name: "read_file", arguments: { path: "private.txt" } },
      { id: "forged-command", name: "run_command", arguments: { command: "npm test", cwd: "." } },
    ]) {
    const requests = [];
    childProvider.requestRuntimeV2ChildStep = async (input) => {
      requests.push({ tools: input.tools.map((tool) => tool.function.name), messages: structuredClone(input.messages) });
      return requests.length === 1
        ? { toolCalls: [call], diagnostics: [], visibleText: "" }
        : { toolCalls: [], diagnostics: [{ code: "fixture_done" }], visibleText: "" };
    };
    await startRuntimeV2Child(f.ports, {
      id: "child-job", parentRunId: "run", scopeKey: "scope", taskKind: "validate", accessMode: "read", allowedPaths: ["."], objective: "Validate without the forbidden capabilities.",
      run: { ...f.request.command.run, runId: "child-run", parentRunId: "run" },
    }, f.abort.signal);
    assert.equal(requests.length, 2);
    assert.equal(executed, 0);
    assert.equal(requests[0].tools.includes("run_command"), false);
    assert.equal(requests[0].tools.includes("read_file"), false);
    assert.deepEqual(requests[1].messages.filter((message) => message.role === "tool").map((message) => message.tool_call_id), [call.id]);
    for (const message of requests[1].messages.filter((message) => message.role === "tool")) assert.match(message.content, /TOOL_BLOCKED/);
    }
  } finally {
    childProvider.requestRuntimeV2ChildStep = originalRequest;
    executor.executeTool = originalExecute;
  }
});

test('children cannot bypass restored manual review or inherit an automatic source baseline', async () => {
  const childProvider = loadTs(path.join(root, 'src/store/runtimeV2/executionSubagentProvider.ts'));
  const executor = loadTs(path.join(root, 'src/lib/toolExecutor.ts'));
  const { startRuntimeV2Child } = loadTs(path.join(root, 'src/store/runtimeV2/executionSubagentRunner.ts'));
  const originalRequest = childProvider.requestRuntimeV2ChildStep; const originalExecute = executor.executeTool;
  let executed = 0;
  const f = fixture({ consent: { turnId: 'turn', granted: true }, autoApproveTools: true, autoApproveToolScopes: ['shell'] });
  f.state.runtimeV2Checkpoints = { turn: await restrictedCheckpoint([], ['workspace_read', 'command']) };
  f.ports.context.workspaceInstructionContext = 'UNREVIEWED_WORKSPACE_INSTRUCTIONS';
  f.ports.context.projectBaselineContext = {
    kind: 'project_baseline_context', schemaVersion: 1, parserVersion: 1,
    workspace: { canonicalPath: '/fixture', identity: 'source-baseline', vcs: null },
    limits: {}, anchors: [], topology: [{ path: 'UNREVIEWED_BASELINE_PATH', kind: 'directory' }],
    facts: { languages: [], packageManagers: [], runtimes: [], scripts: [] }, omissions: [], diagnostics: [],
    truncated: { anchors: false, topology: false, scripts: false }, fingerprints: { anchors: 'a', topology: 't', facts: 'f', overall: 'o' },
  };
  executor.executeTool = async () => { executed++; throw new Error('Manual child action executed without a parent review'); };
  try {
    for (const call of [
      { id: 'child-manual-read', name: 'read_file', arguments: { path: 'private.txt' } },
      { id: 'child-manual-command', name: 'run_command', arguments: { command: 'npm test', cwd: '.' } },
    ]) {
      const requests = [];
      childProvider.requestRuntimeV2ChildStep = async input => {
        requests.push(structuredClone(input.messages));
        return requests.length === 1 ? { toolCalls: [call], diagnostics: [], visibleText: '' }
          : { toolCalls: [], diagnostics: [{ code: 'fixture_done' }], visibleText: '' };
      };
      await startRuntimeV2Child(f.ports, { id: call.id, parentRunId: 'run', scopeKey: 'scope', taskKind: 'validate', accessMode: 'read', allowedPaths: ['.'], objective: 'Inspect only after parent review.', run: { ...f.request.command.run, runId: `${call.id}-run`, parentRunId: 'run' } }, f.abort.signal);
      assert.equal(executed, 0); assert.equal(requests.length, 2);
      assert.doesNotMatch(JSON.stringify(requests[0]), /UNREVIEWED_WORKSPACE_INSTRUCTIONS|UNREVIEWED_BASELINE_PATH/);
      assert.deepEqual(requests[1].filter(message => message.role === 'tool').map(message => message.tool_call_id), [call.id]);
      for (const message of requests[1].filter(message => message.role === 'tool')) assert.match(message.content, /TOOL_BLOCKED/);
    }
    assert.equal(f.state.activeActionRequest, undefined, 'a child cannot manufacture a parent review owner');
  } finally { childProvider.requestRuntimeV2ChildStep = originalRequest; executor.executeTool = originalExecute; }
});

test("a capability-blocked validator has no attempted validation evidence", async () => {
  const { createRuntimeV2ToolPort } = loadTs(path.join(root, "src/store/runtimeV2/executionToolPort.ts"));
  const f = fixture({ consent: { turnId: "turn", granted: true }, autoApproveTools: true });
  f.ports.context.capabilityRestrictions = ["command"];
  const event = await createRuntimeV2ToolPort(f.ports).execute({ command: { ...f.request.command, kind: "execute_validation" }, signal: f.abort.signal });
  assert.equal(event.type, "validation.completed");
  assert.equal(event.passed, false);
  assert.equal(event.failureKind, "not_executed");
  assert.equal(event.failureReasonCode, "turn_capability_restricted");
  assert.deepEqual(event.evidence, []);
});

test("global Skill resource reads remain guidance and grant no external file, write or shell authority", async () => {
  const { createRuntimeV2ToolPort } = loadTs(path.join(root, "src/store/runtimeV2/executionToolPort.ts"));
  const packageId = "a".repeat(64);
  const skillId = `global:${packageId}:review/SKILL.md`;
  const f = fixture({ consent: { turnId: "turn", granted: true }, autoApproveTools: true, autoApproveToolScopes: ["shell", "workspace_write"] });
  f.ports.context.capabilityRestrictions = ["workspace_write", "command"];
  f.ports.context.skillCatalog = { entries: [{ id: skillId, name: "global-guidance", description: "Reference", source: "package", content: "BODY", version: "body", allowImplicitInvocation: true, supportingFiles: [], entryPath: `main-skill://${packageId}/review/SKILL.md`, basePath: `main-skill://${packageId}/review`, globalPackageId: packageId, globalResourceBase: "review", globalResourcePaths: ["review/SKILL.md", "review/references/check.md"] }], explicitSkillIds: [], warnings: [], loadedAt: 1 };
  ipc.readGlobalSkillPackageFile = async (id, path) => { assert.equal(id, packageId); assert.equal(path, "review/references/check.md"); return "Use commands only if independently authorized."; };
  const event = await createRuntimeV2ToolPort(f.ports).execute({ command: { ...f.request.command, payload: { toolName: "load_skill", toolCallId: "resource", arguments: { skill_id: skillId, resource: "references/check.md" } } }, signal: f.abort.signal });
  assert.equal(event.status, "succeeded");
  assert.equal(event.evidence[0].kind, "tool", "global references do not create source or mutation evidence");
  assert.equal(f.ports.live.latestProviderRequestSourceCoverage.length, 0);
  assert.deepEqual(f.state.approvedLocalFileReadPaths, []);
  assert.deepEqual(f.state.approvedShellPermissionRules, []);
  assert.equal(f.ports.context.runWorkspace, "/fixture");
  assert.equal((await authorizeToolForCurrentTurn(f.ports, "run_command", f.request.args)).allowed, false);
  assert.equal((await authorizeToolForCurrentTurn(f.ports, "write_file", { path: `main-skill://${packageId}/result`, content: "no" })).allowed, false);
  const external = await authorizeToolForCurrentTurn(f.ports, "read_file", { path: "/outside/reference.md" });
  assert.equal(external.allowed, false);
  assert.equal(external.approvalRequired, true);
});

test('explicit per-action review overrides native allow, task consent and session automation', async () => {
  for (const decision of ['allow', 'ask']) {
    const f = fixture({ consent: { turnId: 'turn', granted: true }, command: 'pwd', decision, autoApproveTools: true, autoApproveToolScopes: ['shell'], approvalRequiredCapabilities: ['command'] });
    f.state.approvedShellPermissionRules = ['pwd'];
    const { pending, resolve } = await pendingReview(f);
    assert.equal(f.state.activeActionRequest.approvalRequiredCapability, 'command');
    resolve({ action: 'accept', ...(decision === 'ask' ? { shellPermissionApproval: buildShellPermissionApproval(f.preflight, 'once') } : {}) });
    const result = await pending;
    assert.equal(result.allowed, true);
    if (decision === 'allow') assert.equal(result.authorization.shellPermissionApproval, undefined, 'safe native allow needs no fabricated ask approval');
    assert.equal((await authorizeToolForCurrentTurn(f.ports, 'run_command', f.request.args)).approvalRequired, true, 'the next exact call still requires its own review');
  }
});
test('explicit review also applies to source reads, writes and enabled network tools', async () => {
  for (const [capability, toolName, args] of [['workspace_read', 'read_file', { path: 'private.txt' }], ['workspace_write', 'write_file', { path: 'result.txt', content: 'value' }], ['network', 'web_search', { query: 'fixture' }]]) {
    const f = fixture({ consent: { turnId: 'turn', granted: true }, autoApproveTools: true, autoApproveToolScopes: ['workspace_write', 'external_read'], approvalRequiredCapabilities: [capability] });
    f.state.webSearchEnabled = true;
    Object.assign(f.request, { toolName, args, target: args.path || 'fixture', failureContextTarget: args.path || 'fixture' });
    const { pending, resolve } = await pendingReview(f);
    assert.equal(f.state.activeActionRequest.approvalRequiredCapability, capability);
    resolve({ action: 'accept' });
    assert.equal((await pending).allowed, true);
    assert.equal((await authorizeToolForCurrentTurn(f.ports, toolName, args)).approvalRequired, true);
  }
});
test('deny precedes explicit review and cancelling or rejecting review never authorizes execution', async () => {
  const denied = fixture({ consent: { turnId: 'turn', granted: true }, decision: 'deny', approvalRequiredCapabilities: ['command'] });
  const refusal = await resolveRuntimeV2ToolAuthorization(denied.request);
  assert.equal(refusal.allowed, false); assert.equal(denied.state.activeActionRequest, undefined);
  for (const action of ['reject', 'cancel']) {
    const f = fixture({ consent: { turnId: 'turn', granted: true }, approvalRequiredCapabilities: ['command'] });
    const { pending, resolve } = await pendingReview(f);
    if (action === 'cancel') f.abort.abort(); else resolve({ action: 'reject' });
    const result = await pending;
    assert.equal(result.allowed, false); resolve({ action: 'accept' });
    assert.equal((await authorizeToolForCurrentTurn(f.ports, 'run_command', f.request.args)).approvalRequired, true);
  }
});

test('restored canonical review requirements override mutable context and legacy empty requirements stay empty', async () => {
  const f = fixture({ consent: { turnId: 'turn', granted: true }, approvalRequiredCapabilities: [] });
  f.state.runtimeV2Checkpoints = { turn: await restrictedCheckpoint([], ['command']) };
  const { pending, resolve } = await pendingReview(f); resolve({ action: 'accept' }); assert.equal((await pending).allowed, true);
  assert.equal((await authorizeToolForCurrentTurn(f.ports, 'run_command', f.request.args)).approvalRequiredCapability, 'command');
  const legacy = fixture({ consent: { turnId: 'turn', granted: true }, approvalRequiredCapabilities: ['command'] });
  legacy.state.runtimeV2Checkpoints = { turn: await restrictedCheckpoint([]) };
  assert.equal((await authorizeToolForCurrentTurn(legacy.ports, 'run_command', legacy.request.args)).allowed, true, 'a new mutable context cannot rewrite admitted legacy policy');
});
test('review cancellation and owner or argument replacement prevent a late manual acceptance', async () => {
  for (const mutate of [f => f.abort.abort(), f => { f.state.harnessRunMarker = { ...f.state.harnessRunMarker, runId: 'replacement' }; }, f => { f.request.args.command = 'different command'; }]) {
    const f = fixture({ consent: { turnId: 'turn', granted: true }, approvalRequiredCapabilities: ['command'] });
    const { pending, resolve } = await pendingReview(f); mutate(f); resolve({ action: 'accept' });
    assert.equal((await pending).allowed, false);
  }
});
test('a new hard policy denial wins over an already waiting manual review', async () => {
  const f = fixture({ consent: { turnId: 'turn', granted: true }, approvalRequiredCapabilities: ['command'] });
  const { pending, resolve } = await pendingReview(f);
  const prior = f.ports.live.authorization;
  f.ports.live.authorization = { ...prior, policy: { ...prior.policy, disabledRiskLevels: ['shell'] } };
  resolve({ action: 'accept' }); assert.equal((await pending).allowed, false);
});
test('cached source replay waits for exact manual review before replaying any bytes', async () => {
  const { createRuntimeV2ToolPort } = loadTs(path.join(root, 'src/store/runtimeV2/executionToolPort.ts'));
  const executor = loadTs(path.join(root, 'src/lib/toolExecutor.ts')); const original = executor.executeTool;
  let executed = 0; executor.executeTool = async () => { executed++; throw new Error('Cached read reached IPC'); };
  try {
    for (const action of ['accept', 'reject']) {
      const f = fixture({ consent: { turnId: 'turn', granted: true }, approvalRequiredCapabilities: [] });
      f.state.runtimeV2Checkpoints = { turn: await restrictedCheckpoint([], ['workspace_read']) };
      f.ports.live.coveredReadToolResults.set('manual-source', 'CACHED_SOURCE_BYTES');
      const command = { ...f.request.command, payload: { toolName: 'read_file', toolCallId: 'manual-source', arguments: { path: 'private.txt' } } };
      const pending = createRuntimeV2ToolPort(f.ports).execute({ command, signal: f.abort.signal });
      for (let i = 0; i < 20; i++) await Promise.resolve();
      assert.equal(f.state.activeActionRequest?.approvalRequiredCapability, 'workspace_read');
      assert.equal(executed, 0); assert.equal(f.ports.live.messages.some(x => String(x.content).includes('CACHED_SOURCE_BYTES')), false);
      f.state.pendingReviewResolve({ action }); const result = await pending;
      if (action === 'accept') { assert.equal(result.status, 'succeeded'); assert.equal(result.receiptOrigin, 'replayed'); }
      else { assert.equal(result.status, 'blocked'); assert.deepEqual(result.evidence, []); }
      assert.equal(executed, 0);
    }
  } finally { executor.executeTool = original; }
});
test('cold automatic observation defers manual or forbidden reads through the real controller without source evidence', async () => {
  const runtime = loadTs(path.join(root, 'src/lib/runtime-v2/index.ts'));
  const { createRuntimeV2ToolPort } = loadTs(path.join(root, 'src/store/runtimeV2/executionToolPort.ts'));
  const executor = loadTs(path.join(root, 'src/lib/toolExecutor.ts')); const original = executor.executeTool;
  let executed = 0; executor.executeTool = async () => { executed++; throw new Error('Unreviewed bootstrap reached IPC'); };
  try {
    for (const manual of [true, false]) {
      const f = fixture({ consent: { turnId: 'turn', granted: true }, approvalRequiredCapabilities: [] });
      const logs = []; f.ports.logStoreEvent = (name, detail) => logs.push({ name, ...detail });
      let checkpoint = null; let sequence = 0;
      const controllerPorts = {
        checkpoint: { append: async (input) => {
          const result = runtime.appendRuntimeV2Checkpoint({ checkpoint, ...input });
          if (result.checkpoint) { checkpoint = result.checkpoint; f.state.runtimeV2Checkpoints = { turn: JSON.parse(JSON.stringify(checkpoint)) }; }
          return result;
        } },
        projection: { publish: async () => {} }, tool: createRuntimeV2ToolPort(f.ports),
        provider: { request: async () => { throw new Error('This preparation step must not request a model'); } },
        clockId: { now: () => ++sequence, nextId: scope => `${scope}-${++sequence}` },
      };
      const controller = new runtime.RuntimeV2Controller(controllerPorts);
      await controller.admit({
        turn: { workspaceKey: '/fixture', sessionKey: '/fixture:1', sessionEpoch: 'epoch', clientSubmissionId: 'submission', turnId: 'turn' },
        run: { ...f.request.command.run, attemptId: 'attempt' }, strategy: 'execute', objective: 'Read only after approval.',
        capabilityRestrictions: manual ? [] : ['workspace_read'], approvalRequiredCapabilities: manual ? ['workspace_read'] : [], initialPhase: 'preparing',
      });
      // Serialize the admitted checkpoint and restore a new controller as production cold resume does.
      const restored = runtime.normalizeRuntimeV2Checkpoint(JSON.parse(JSON.stringify(checkpoint)));
      const resumed = new runtime.RuntimeV2Controller(controllerPorts, { aggregate: restored.aggregate, revision: checkpoint.revision });
      assert.equal(await resumed.driveOnce(), true);
      const aggregate = resumed.snapshot().aggregate;
      assert.equal(executed, 0); assert.equal(f.state.activeActionRequest, undefined);
      assert.deepEqual(aggregate.evidence, []); assert.deepEqual(aggregate.scheduledCommands, []);
      assert.equal(aggregate.events.some(event => ['observation.recorded', 'tool.completed', 'validation.completed'].includes(event.type)), false);
      assert.equal(aggregate.events.filter(event => event.type === 'command.completed').at(-1).status, 'succeeded', 'only the automatic preparation step is settled');
      assert.equal(runtime.hasCompletedRuntimeV2InitialObservation(aggregate), true);
      await resumed.changePhase('observing', 'initial_observation_completed');
      assert.equal(resumed.snapshot().aggregate.phase, 'observing');
      const next = runtime.decideNextCommands(resumed.snapshot().aggregate, {});
      assert.equal(next[0]?.kind, 'request_model');
      assert.equal(next[0]?.phase, 'observing', 'the existing phase transition advances deferred preparation to observation');
      assert.equal(logs.at(-1).name, 'runtime_v2_automatic_observation_deferred');
      assert.equal(logs.at(-1).reason, manual ? 'turn_requires_human_review' : 'turn_capability_restricted');
    }
  } finally { executor.executeTool = original; }
});
test('a pre-approved external path still needs each required manual review', async () => {
  const f = fixture({ consent: { turnId: 'turn', granted: true }, approvalRequiredCapabilities: ['workspace_read'] });
  f.state.approvedLocalFileReadPaths = ['/outside/secret.txt'];
  Object.assign(f.request, { toolName: 'read_file', args: { path: '/outside/secret.txt' }, target: '/outside/secret.txt', failureContextTarget: '/outside/secret.txt' });
  const { pending, resolve } = await pendingReview(f); resolve({ action: 'accept', grantLocalFileReadPath: '/outside/secret.txt' });
  const result = await pending; assert.equal(result.allowed, true); assert.equal(result.authorization.allowExternalLocalRead, true);
  assert.equal((await authorizeToolForCurrentTurn(f.ports, 'read_file', f.request.args)).approvalRequiredCapability, 'workspace_read');
});
test('manual disclosure metadata suppresses session approval without changing ordinary policy', () => {
  const { requiresPerCallToolPermissionApproval } = loadTs(path.join(root, 'src/lib/actionRequest.ts'));
  assert.equal(requiresPerCallToolPermissionApproval('shell', 'command'), true);
  assert.equal(requiresPerCallToolPermissionApproval('read_only', 'workspace_read'), true);
  assert.equal(requiresPerCallToolPermissionApproval('shell'), false);
  assert.equal(requiresPerCallToolPermissionApproval('read_only'), false);
});

test('the permission presentation adapter discloses optional canonical review metadata without constructing authorization', async () => {
  const { requestRuntimeV2ToolPermission } = loadTs(path.join(root, 'src/store/runtimeV2/executionToolPermission.ts'));
  for (const capability of [undefined, 'command']) {
    const f = fixture();
    delete f.state.config;
    const presentationPorts = {
      get: f.ports.get, set: f.ports.set, now: f.ports.now, logStoreEvent: f.ports.logStoreEvent,
      context: { phaseLanguage: 'en', turnId: 'turn' },
    };
    assert.equal(presentationPorts.live, undefined);
    const review = requestRuntimeV2ToolPermission({
      ports: presentationPorts, command: f.request.command, toolName: 'run_command', args: f.request.args,
      target: f.request.target, permissionTarget: f.request.target, risk: 'shell', approvalRequiredCapability: capability,
    });
    assert.equal(f.state.activeActionRequest.status, 'pending');
    assert.equal(f.state.activeActionRequest.approvalRequiredCapability, capability);
    assert.equal(f.state.pendingToolCall.approvalRequiredCapability, capability);
    f.state.pendingReviewResolve({ action: 'accept' });
    assert.equal((await review).action, 'accept');
    assert.equal(f.state.currentTurnExecutionConsent, null, 'presentation metadata cannot grant Turn consent');
  }
});
