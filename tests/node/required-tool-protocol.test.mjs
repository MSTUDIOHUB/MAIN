import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";

const workspaceRoot = process.cwd();

function loadTs(sourcePath) {
  const source = fs.readFileSync(sourcePath, "utf8");
  const transpiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    fileName: sourcePath,
  }).outputText;
  const module = { exports: {} };
  const localRequire = createRequire(sourcePath);
  new Function("exports", "module", "require", transpiled)(module.exports, module, localRequire);
  return module.exports;
}

const protocol = loadTs(path.join(workspaceRoot, "src/lib/requiredToolProtocol.ts"));

function streamResult(overrides = {}) {
  return {
    content: "done",
    toolCalls: [],
    finishReason: "stop",
    ...overrides,
  };
}

test("required tool choice with zero calls is a protocol violation, not completion", () => {
  const required = protocol.annotateRequiredToolCallProtocolResult(
    streamResult(),
    "required",
  );
  assert.equal(required.protocolViolation, "required_tool_call_missing");

  const selected = protocol.annotateRequiredToolCallProtocolResult(
    streamResult(),
    { type: "function", function: { name: "browser_evaluate" } },
  );
  assert.equal(selected.protocolViolation, "required_tool_call_missing");
});

test("required tool protocol accepts a real call and leaves auto responses unchanged", () => {
  const called = streamResult({
    toolCalls: [{ index: 0, id: "call-1", name: "run_command", arguments: "{}" }],
    finishReason: "tool_calls",
  });
  assert.equal(
    protocol.annotateRequiredToolCallProtocolResult(called, "required"),
    called,
  );

  const auto = streamResult();
  assert.equal(
    protocol.annotateRequiredToolCallProtocolResult(auto, "auto"),
    auto,
  );
});

test("named function choice quarantines a different provider tool call", () => {
  const mismatched = protocol.annotateRequiredToolCallProtocolResult(
    streamResult({
      toolCalls: [{ index: 0, id: "call-read", name: "read_file", arguments: "{}" }],
      finishReason: "tool_calls",
    }),
    { type: "function", function: { name: "apply_patch" } },
  );

  assert.equal(mismatched.protocolViolation, "required_function_call_mismatch");
  assert.equal(mismatched.protocolExpectedTool, "apply_patch");
  assert.deepEqual(mismatched.protocolActualTools, ["read_file"]);
  assert.deepEqual(mismatched.protocolActualToolCalls, [{
    index: 0,
    id: "call-read",
    name: "read_file",
    arguments: "{}",
  }]);
  assert.deepEqual(mismatched.toolCalls, [], "the mismatched read must never reach IPC execution");
});

test("named function choice keeps only matching calls from a mixed provider response", () => {
  const mixed = protocol.annotateRequiredToolCallProtocolResult(
    streamResult({
      toolCalls: [
        { index: 0, id: "call-read", name: "read_file", arguments: "{}" },
        { index: 1, id: "call-patch", name: "apply_patch", arguments: "{}" },
      ],
      finishReason: "tool_calls",
    }),
    { type: "function", function: { name: "apply_patch" } },
  );

  assert.equal(mixed.protocolViolation, undefined);
  assert.deepEqual(mixed.toolCalls.map((call) => call.name), ["apply_patch"]);
});

test("required capability quarantines calls outside the exposed tool surface", () => {
  const unavailable = protocol.annotateRequiredToolCallProtocolResult(
    streamResult({
      toolCalls: [{ index: 0, id: "call-read", name: "read_file", arguments: "{}" }],
      finishReason: "tool_calls",
    }),
    "required",
    ["apply_patch", "replace_in_file", "write_file", "wait_subagents"],
  );

  assert.equal(unavailable.protocolViolation, "required_tool_call_not_available");
  assert.deepEqual(unavailable.protocolAllowedTools, [
    "apply_patch",
    "replace_in_file",
    "write_file",
    "wait_subagents",
  ]);
  assert.deepEqual(unavailable.protocolActualTools, ["read_file"]);
  assert.deepEqual(unavailable.protocolActualToolCalls, [{
    index: 0,
    id: "call-read",
    name: "read_file",
    arguments: "{}",
  }]);
  assert.deepEqual(unavailable.toolCalls, []);

  const legalAlternative = protocol.annotateRequiredToolCallProtocolResult(
    streamResult({
      toolCalls: [{ index: 0, id: "call-replace", name: "replace_in_file", arguments: "{}" }],
      finishReason: "tool_calls",
    }),
    "required",
    ["apply_patch", "replace_in_file", "write_file"],
  );
  assert.equal(legalAlternative.protocolViolation, undefined);
  assert.deepEqual(legalAlternative.toolCalls.map((call) => call.name), ["replace_in_file"]);
});
