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
