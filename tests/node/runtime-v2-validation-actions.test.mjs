import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";

const cache = new Map();
function loadTs(sourcePath) {
  const normalized = path.resolve(sourcePath);
  if (cache.has(normalized)) return cache.get(normalized);
  const localRequire = createRequire(normalized);
  const output = ts.transpileModule(fs.readFileSync(normalized, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    fileName: normalized,
  }).outputText;
  const module = { exports: {} };
  cache.set(normalized, module.exports);
  const runtimeRequire = (specifier) => {
    if (specifier.startsWith(".")) {
      const base = path.resolve(path.dirname(normalized), specifier);
      for (const candidate of [base, `${base}.ts`, path.join(base, "index.ts")]) {
        if (fs.existsSync(candidate) && candidate.endsWith(".ts")) return loadTs(candidate);
      }
    }
    return localRequire(specifier);
  };
  new Function("exports", "module", "require", output)(module.exports, module, runtimeRequire);
  cache.set(normalized, module.exports);
  return module.exports;
}

const runtime = loadTs("src/lib/runtime-v2/index.ts");
const providerPort = loadTs("src/store/runtimeV2/executionProviderPort.ts");
const providerRequest = loadTs("src/store/runtimeV2/executionProviderRequest.ts");
const executionContext = loadTs("src/store/runtimeV2/executionContext.ts");
const executionTypes = loadTs("src/store/runtimeV2/executionTypes.ts");
const providerTools = loadTs("src/store/runtimeV2/executionProviderTools.ts");
const surfaceRejection = loadTs("src/store/runtimeV2/executionProviderSurfaceRejection.ts");
const outcomes = loadTs("src/store/runtimeV2/executionOutcome.ts");
const turn = { workspaceKey: "/fixture", sessionKey: "session", sessionEpoch: "epoch", clientSubmissionId: "submission", turnId: "turn" };
const run = { sessionKey: "session", sessionEpoch: "epoch", turnId: "turn", runId: "run", parentRunId: null, attemptId: "attempt" };
const definition = {
  type: "function",
  function: { name: "run_command", description: "Execute an authorized shell command", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } },
};
const validationRequest = { idempotencyKey: "model-validation", kind: "request_model", phase: "validating", run, payload: { mode: "validate" } };

test("the production validation-phase provider admits ordinary external commands through the regular action path", async () => {
  const originalSurface = Object.getOwnPropertyDescriptor(executionContext, "providerToolDefinitionsForCommand");
  const originalRequest = providerRequest.requestRuntimeV2ProviderOnce;
  Object.defineProperty(executionContext, "providerToolDefinitionsForCommand", { configurable: true, enumerable: true, value: () => [definition] });
  try {
    for (const command of ["editor-tool status", "editor-tool command script eval --code 'CreateScene();'", "grep -n handleOpenFile src/main.js"]) {
      const live = executionTypes.createRuntimeV2LiveExecutionState();
      live.providerLaneProfile = { schemaVersion: "provider-lane.v1", nativeTools: true, requiredToolChoice: false, streaming: true, textToolEnvelope: true, reasoning: false, imageInput: false, toolResultRole: "tool" };
      let id = 0;
      providerRequest.requestRuntimeV2ProviderOnce = async () => ({ visibleText: "", toolCalls: [{ id: "external-action", name: "run_command", arguments: { command } }], diagnostics: [], usage: {} });
      const result = await providerPort.createRuntimeV2ProviderPort({
        get: () => ({}), live,
        context: { turnId: "turn", runWorkspace: "/fixture", phaseLanguage: "en" },
        nextId: (scope) => `${scope}-${++id}`, now: () => Date.now(), logStoreEvent() {},
      }).request({ command: validationRequest, signal: new AbortController().signal });
      assert.equal(result.toolCalls[0]?.arguments.command, command, command);
      assert.deepEqual(result.diagnostics, [], command);
      assert.equal(live.correctiveValidationCommand, null, "an ordinary action cannot seal an unrelated validator");
    }
  } finally {
    providerRequest.requestRuntimeV2ProviderOnce = originalRequest;
    Object.defineProperty(executionContext, "providerToolDefinitionsForCommand", originalSurface);
  }
});

test("validation-phase command guidance preserves ordinary actions and an explicitly sealed command enum", () => {
  const live = executionTypes.createRuntimeV2LiveExecutionState();
  const ports = { live, get: () => ({}), context: { turnId: "turn", runWorkspace: "/fixture" } };
  const tools = providerTools.selectRuntimeV2ProviderToolDefinitions({ ports, command: validationRequest, available: [definition] });
  assert.match(tools[0].function.description, /ordinary.*actions/i);
  assert.match(tools[0].function.description, /do not discharge.*validation debt/i);
  assert.equal(tools[0].function.parameters.properties.command.enum, undefined);
  const prompt = providerRequest.providerModeInstruction(validationRequest);
  assert.match(prompt, /still-needed authorized external actions/i);
  assert.match(prompt, /ordinary shell actions produce tool results and do not discharge/i);
  const sealed = providerTools.selectRuntimeV2ProviderToolDefinitions({ ports, command: validationRequest, available: [definition], actionWindow: "validation_handoff", correctiveValidationCommand: "npm test" });
  assert.deepEqual(sealed[0].function.parameters.properties.command.enum, ["npm test"]);
  const rejected = surfaceRejection.rejectRuntimeV2InvalidProviderToolArguments({
    ports: { ...ports, nextId: () => "rejected-command", logStoreEvent() {} }, command: validationRequest, tools: sealed,
    result: { visibleText: "", toolCalls: [{ id: "wrong-sealed-command", name: "run_command", arguments: { command: "editor-tool status" } }], diagnostics: [] },
  });
  assert.deepEqual(rejected?.toolCalls, [], "explicit command authority still rejects a different action");
});

let id = 0;
function append(state, type, fields) {
  return runtime.transition(state, { schemaVersion: runtime.RUNTIME_V2_EVENT_SCHEMA_VERSION, sequence: state?.nextSequence || 0, eventId: `validation-action-${++id}`, at: id, type, ...fields });
}
function response(state, result) {
  const command = runtime.decideNextCommands(state)[0];
  assert.equal(command.kind, "request_model");
  state = append(state, "command.scheduled", { run, command });
  return append(state, "provider.responded", { run, idempotencyKey: command.idempotencyKey, result: { visibleText: "", toolCalls: [], diagnostics: [], ...result } });
}
function receipt(state, completion) {
  const command = runtime.decideNextCommands(state)[0];
  state = append(state, "command.scheduled", { run, command });
  const authority = command.payload.validationAuthority;
  const boundary = authority ? runtime.deriveRuntimeV2ValidationBoundary(state, authority.targetPaths) : {};
  return append(state, completion.type, { run, idempotencyKey: command.idempotencyKey, ...(authority ? { authority, ...boundary } : {}), ...completion });
}

test("ordinary validation-phase commands remain tool effects and cannot clear a real file mutation's acceptance debt", () => {
  let state = append(null, "turn.admitted", { turn, strategy: "execute", objective: "Create a working game", constraints: [], acceptanceCriteria: ["Game is ready"], acceptanceCriterionIds: ["game-ready"], acceptanceEvidenceRequirements: [null] });
  state = append(state, "run.started", { run, phase: "acting" });
  state = response(state, { toolCalls: [{ id: "write-script", name: "write_file", arguments: { path: "Assets/Game.cs", content: "class Game {}" } }] });
  state = receipt(state, { type: "tool.completed", status: "succeeded", evidence: [{ id: "game-script-v1", kind: "mutation", target: "Assets/Game.cs", version: "v1" }] });
  state = append(state, "phase.changed", { run, phase: "validating", reason: "file mutation committed" });
  state = response(state, { toolCalls: [{ id: "create-scene", name: "run_command", arguments: { command: "editor-tool command script eval --code 'CreateScene();'" } }] });
  assert.equal(runtime.decideNextCommands(state)[0].kind, "execute_tool");
  state = receipt(state, { type: "tool.completed", status: "succeeded", evidence: [{ id: "game-scene-result", kind: "tool", target: "editor-tool", version: "exit-0" }] });
  state = response(state, { visibleText: "Done." });
  assert.equal(runtime.runtimeV2DirectExecuteReadyForConclusion(state), false);
  assert.equal(outcomes.runtimeV2ExecuteTerminalDecision({ aggregate: state, signal: new AbortController().signal }), null);
  const validator = 'python3 -c \'from pathlib import Path; assert Path("Assets/Game.cs").is_file()\'';
  state = response(state, { toolCalls: [{ id: "assert-game", name: "run_command", arguments: { command: validator } }] });
  assert.equal(runtime.decideNextCommands(state)[0].kind, "execute_validation");
  state = receipt(state, { type: "validation.completed", passed: true, evidence: [{ id: "game-assertion", kind: "validation", target: "python3", version: "passed" }], presentation: { toolName: "run_command", target: validator } });
  assert.equal(runtime.runtimeV2DirectExecuteReadyForConclusion(state), true);
  state = response(state, { visibleText: "The change and validation succeeded." });
  assert.equal(outcomes.runtimeV2ExecuteTerminalDecision({ aggregate: state, signal: new AbortController().signal })?.resultKind, "success");
});
