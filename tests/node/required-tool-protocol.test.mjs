import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";

const workspaceRoot = process.cwd();
const moduleCache = new Map();

function loadTs(sourcePath) {
  const normalizedPath = path.resolve(sourcePath);
  if (moduleCache.has(normalizedPath)) return moduleCache.get(normalizedPath);
  const source = fs.readFileSync(normalizedPath, "utf8");
  const transpiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    fileName: normalizedPath,
  }).outputText;
  const module = { exports: {} };
  moduleCache.set(normalizedPath, module.exports);
  const localRequire = createRequire(normalizedPath);
  const runtimeRequire = (specifier) => {
    if (specifier.startsWith(".")) {
      const basePath = path.resolve(path.dirname(normalizedPath), specifier);
      for (const candidate of [basePath, `${basePath}.ts`, `${basePath}.tsx`, path.join(basePath, "index.ts")]) {
        if (fs.existsSync(candidate) && /\.tsx?$/.test(candidate)) return loadTs(candidate);
      }
    }
    return localRequire(specifier);
  };
  new Function("exports", "module", "require", transpiled)(module.exports, module, runtimeRequire);
  moduleCache.set(normalizedPath, module.exports);
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

const typedPlanDraft = {
  schemaVersion: 1,
  evidenceRefs: ["E1"],
  summary: [],
  diagnoses: [],
  changes: [],
  decisions: [],
  interfaces: [],
  validations: [],
  assumptions: [],
  blockingChoices: [],
};
const typedPlanEnvelope =
  `<plan_candidate>${JSON.stringify(typedPlanDraft)}</plan_candidate>`;

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

test("sole native Plan surface adapts one complete content envelope into typed ingress", () => {
  const adapted = protocol.annotateRequiredToolCallProtocolResult(
    streamResult({
      content: `provider preface\n${typedPlanEnvelope}\nprovider suffix`,
      reasoningContent: "unused hidden reasoning",
    }),
    "required",
    ["submit_plan_candidate"],
  );

  assert.equal(adapted.protocolViolation, undefined);
  assert.equal(adapted.protocolTransportAdaptation, "typed_plan_text_envelope");
  assert.equal(adapted.protocolTransportSource, "content");
  assert.equal(adapted.content, typedPlanEnvelope);
  assert.equal(adapted.semanticContent, typedPlanEnvelope);
  assert.equal(adapted.actionableContent, typedPlanEnvelope);
  assert.equal(adapted.finishReason, "stop");
  assert.doesNotMatch(adapted.content, /provider (?:preface|suffix)/);
});

test("sole native Plan surface never promotes a hidden reasoning envelope", () => {
  const rejected = protocol.annotateRequiredToolCallProtocolResult(
    streamResult({
      content: "ordinary visible progress",
      reasoningContent: `hidden analysis before\n${typedPlanEnvelope}\nhidden analysis after`,
    }),
    { type: "function", function: { name: "submit_plan_candidate" } },
    ["submit_plan_candidate"],
  );

  assert.equal(rejected.protocolViolation, "required_tool_call_missing");
  assert.equal(rejected.protocolTransportAdaptation, undefined);
  assert.equal(rejected.protocolTransportSource, undefined);
  assert.equal(rejected.content, "ordinary visible progress");
  assert.match(rejected.reasoningContent, /hidden analysis/);
});

test("native capability success requires a real allowed raw call", () => {
  const allowedCall = streamResult({
    toolCalls: [{ index: 0, id: "call-read", name: "read_file", arguments: "{}" }],
    finishReason: "tool_calls",
  });
  assert.equal(protocol.hasSuccessfulAllowedRawNativeToolCall({
    rawResult: allowedCall,
    allowedToolNames: ["read_file"],
  }), true);

  assert.equal(protocol.hasSuccessfulAllowedRawNativeToolCall({
    rawResult: streamResult(),
    allowedToolNames: ["read_file"],
  }), false, "exposing a tool without receiving a call is not native success");

  const mixed = streamResult({
    toolCalls: [
      { index: 0, id: "call-read", name: "read_file", arguments: "{}" },
      { index: 1, id: "call-write", name: "write_file", arguments: "{}" },
    ],
    finishReason: "tool_calls",
  });
  assert.equal(protocol.hasSuccessfulAllowedRawNativeToolCall({
    rawResult: mixed,
    allowedToolNames: ["read_file"],
  }), false, "a mixed out-of-surface transaction cannot prove the capability");

  const visibleAdaptation = protocol.annotateRequiredToolCallProtocolResult(
    streamResult({ content: typedPlanEnvelope }),
    "required",
    ["submit_plan_candidate"],
  );
  assert.equal(protocol.hasSuccessfulAllowedRawNativeToolCall({
    rawResult: streamResult({ content: typedPlanEnvelope }),
    normalizedResult: visibleAdaptation,
    allowedToolNames: ["submit_plan_candidate"],
  }), false, "visible envelope adaptation is not a native call");
});

test("native and visible Plan transports preserve the same scalar validation payload", () => {
  const scalarDraft = {
    ...typedPlanDraft,
    validations: [
      {
        id: "V1",
        goalRefs: ["G1"],
        changeRefs: [],
        primitive: {
          kind: "service_observation",
          launchCommand: "npm run dev",
          ownerKey: "dev-server",
          readiness: { kind: "port", target: "127.0.0.1:1420", expected: 1420 },
        },
        expectedOutcome: "The service becomes reachable.",
      },
      {
        id: "V2",
        goalRefs: ["G1"],
        changeRefs: [],
        primitive: {
          kind: "assertion",
          acceptance: "advisory",
          target: "runtime:dialog.open",
          matcher: "equals",
          producer: "runtime_evidence_ledger",
          expected: false,
        },
        expectedOutcome: "No dialog opens.",
      },
      {
        id: "V3",
        goalRefs: ["G1"],
        changeRefs: [],
        primitive: {
          kind: "browser_interaction",
          actions: [],
          assertions: [{ kind: "text", target: "#empty", expected: null }],
        },
        expectedOutcome: "The empty state remains unset.",
      },
    ],
  };
  const expectedEnvelope = `<plan_candidate>${JSON.stringify(scalarDraft)}</plan_candidate>`;
  const native = protocol.consumeNativePlanCandidateSubmission({
    enabled: true,
    result: streamResult({
      toolCalls: [{
        index: 0,
        id: "call-submit",
        name: "submit_plan_candidate",
        arguments: JSON.stringify(scalarDraft),
      }],
      finishReason: "tool_calls",
    }),
  });
  const visible = protocol.annotateRequiredToolCallProtocolResult(
    streamResult({ content: expectedEnvelope }),
    "required",
    ["submit_plan_candidate"],
  );

  assert.equal(native.result.content, expectedEnvelope);
  assert.equal(visible.content, expectedEnvelope);
  assert.match(native.result.content, /"expected":1420/);
  assert.match(native.result.content, /"expected":false/);
  assert.match(native.result.content, /"expected":null/);
});

test("sole native Plan surface never adapts arbitrary prose or bare JSON", () => {
  for (const content of [
    "I revised the plan and it is ready for review.",
    JSON.stringify(typedPlanDraft),
  ]) {
    const rejected = protocol.annotateRequiredToolCallProtocolResult(
      streamResult({ content }),
      "required",
      ["submit_plan_candidate"],
    );

    assert.equal(rejected.protocolViolation, "required_tool_call_missing");
    assert.equal(rejected.protocolTransportAdaptation, undefined);
    assert.equal(rejected.content, content);
  }
});

test("sole native Plan surface fails closed for wrong or mixed tool transactions", () => {
  const wrong = protocol.annotateRequiredToolCallProtocolResult(
    streamResult({
      content: typedPlanEnvelope,
      toolCalls: [{ index: 0, id: "call-write", name: "write_file", arguments: "{}" }],
      finishReason: "tool_calls",
    }),
    "required",
    ["submit_plan_candidate"],
  );
  assert.equal(wrong.protocolViolation, "required_tool_call_not_available");
  assert.deepEqual(wrong.toolCalls, []);
  assert.equal(wrong.protocolTransportAdaptation, undefined);

  const mixedAnnotated = protocol.annotateRequiredToolCallProtocolResult(
    streamResult({
      toolCalls: [
        { index: 0, id: "call-submit", name: "submit_plan_candidate", arguments: "{}" },
        { index: 1, id: "call-write", name: "write_file", arguments: "{}" },
      ],
      finishReason: "tool_calls",
    }),
    "required",
    ["submit_plan_candidate"],
  );
  const mixedConsumed = protocol.consumeNativePlanCandidateSubmission({
    enabled: true,
    result: mixedAnnotated,
  });
  assert.equal(mixedAnnotated.protocolViolation, "required_tool_call_not_available");
  assert.deepEqual(mixedAnnotated.toolCalls, []);
  assert.equal(mixedConsumed.consumed, false);
});

test("native typed Plan submission becomes the shared ingress envelope without execution", () => {
  const adapted = protocol.consumeNativePlanCandidateSubmission({
    enabled: true,
    result: streamResult({
      content: "ordinary progress text must not become Plan authority",
      toolCalls: [{
        index: 0,
        id: "call-submit",
        name: "submit_plan_candidate",
        arguments: JSON.stringify(typedPlanDraft),
      }],
      finishReason: "tool_calls",
    }),
  });

  assert.equal(adapted.consumed, true);
  assert.deepEqual(adapted.callIds, ["call-submit"]);
  assert.equal(adapted.result.toolCalls.length, 0);
  assert.equal(adapted.result.finishReason, "stop");
  assert.equal(
    adapted.result.content,
    typedPlanEnvelope,
  );
  assert.doesNotMatch(adapted.result.content, /ordinary progress text/);
});

test("mixed native Plan submission transactions fail closed before execution", () => {
  const adapted = protocol.consumeNativePlanCandidateSubmission({
    enabled: true,
    result: streamResult({
      toolCalls: [
        { index: 0, id: "call-submit", name: "submit_plan_candidate", arguments: "{}" },
        { index: 1, id: "call-write", name: "write_file", arguments: "{}" },
      ],
      finishReason: "tool_calls",
    }),
  });

  assert.equal(adapted.consumed, false);
  assert.deepEqual(adapted.quarantinedToolNames, ["write_file"]);
  assert.equal(adapted.result.protocolViolation, "required_tool_call_not_available");
  assert.deepEqual(adapted.result.toolCalls, []);
  assert.equal(adapted.result.content, "");
});

test("a required preferred checkpoint adapts one exact read intent into a bounded reviewer child", () => {
  const raw = streamResult({
    toolCalls: [{
      index: 0,
      id: "call-rust-handler",
      name: "read_file",
      arguments: JSON.stringify({ path: "src-tauri/src/main.rs", start_line: 1 }),
    }],
    finishReason: "tool_calls",
  });
  const adapted = protocol.adaptRequiredPreferredDelegationReadIntent({
    result: raw,
    preferredDelegationRequired: true,
    allowedToolNames: ["spawn_subagent"],
  });

  assert.equal(adapted.adapted, true);
  assert.equal(adapted.sourceToolName, "read_file");
  assert.equal(adapted.target, "src-tauri/src/main.rs");
  assert.equal(adapted.result.toolCalls[0].name, "spawn_subagent");
  const args = JSON.parse(adapted.result.toolCalls[0].arguments);
  assert.equal(args.role, "reviewer");
  assert.equal(args.allowed_paths, "src-tauri/src/main.rs");
  assert.match(args.objective, /src-tauri\/src\/main\.rs/);

  assert.strictEqual(protocol.adaptRequiredPreferredDelegationReadIntent({
    result: raw,
    preferredDelegationRequired: false,
    allowedToolNames: ["spawn_subagent"],
  }).result, raw);
  assert.equal(protocol.adaptRequiredPreferredDelegationReadIntent({
    result: streamResult({
      toolCalls: [{ index: 0, id: "call-root", name: "grep_search", arguments: '{"path":"."}' }],
    }),
    preferredDelegationRequired: true,
    allowedToolNames: ["spawn_subagent"],
  }).adapted, false);
});
