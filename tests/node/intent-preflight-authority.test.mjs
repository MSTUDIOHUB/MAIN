import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";

function loadPreflight(candidate, transport) {
  const cache = new Map();
  function load(file) {
    const resolved = path.resolve(file);
    if (cache.has(resolved)) return cache.get(resolved);
    const module = { exports: {} };
    cache.set(resolved, module.exports);
    const localRequire = createRequire(resolved);
    const requireModule = (name) => {
      if (name === "./streaming") {
        return { resolveJsonObjectOutputOptions: () => ({ responseFormat: { type: "json_object" } }), streamChatCompletion: async (...args) => transport
          ? transport(...args)
          : ({ content: JSON.stringify(candidate), finishReason: "stop", toolCalls: [] }) };
      }
      if (name.startsWith(".")) {
        const base = path.resolve(path.dirname(resolved), name);
        for (const source of [`${base}.ts`, path.join(base, "index.ts")]) {
          if (fs.existsSync(source)) return load(source);
        }
      }
      return localRequire(name);
    };
    new Function("exports", "module", "require", ts.transpileModule(fs.readFileSync(resolved, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }, fileName: resolved,
    }).outputText)(module.exports, module, requireModule);
    return module.exports;
  }
  return load("src/lib/intentPreflight.ts").runIntentPreflight;
}

const params = {
  input: "Only explain where the previous test result came from; do not execute tests.",
  language: "en",
  mainModeKey: "main_mode",
  config: { activeProfile: "local", local: { endpoint: "http://fixture.invalid/v1", model: "fixture" } },
};

function candidate(overrides = {}) {
  return {
    semantic: {
      objective: "Explain the previous result",
      workType: "answer",
      answerFormat: "answer",
      requiredCapabilities: [],
      forbiddenCapabilities: ["workspace_write", "command"],
      approvalRequiredCapabilities: [],
      ...overrides,
    },
    confidence: 0.97,
    needsUserChoice: false,
  };
}

const planContinuationCandidates = [
  { id: "brick-breaker:v3", title: "Unity brick breaker", objective: "Build a playable Unity 6 brick breaker", status: "canceled" },
  { id: "collector:v1", title: "Unity collector", objective: "Prototype a collectible game", status: "review" },
];

test("one tool-free semantic request distinguishes continuing, revising and discussing a scoped plan", async () => {
  for (const [input, kind, expectedIntent, language] of [
    ["继续完成计划方案", "continue", "respond", "zh"],
    ["Revise the brick breaker plan for touch controls.", "revise", "plan", "en"],
    ["Explain the proposed brick breaker verification.", "discuss", "respond", "en"],
    ["Explain how an unrelated browser API works.", "new", "respond", "en"],
  ]) {
    const relation = kind === "new" ? { kind } : { kind, candidateId: planContinuationCandidates[0].id };
    const wire = { ...candidate({ forbiddenCapabilities: ["command"] }), planContinuation: relation, approved: true };
    let requests = 0;
    const preflight = loadPreflight(null, async (messages, _settings, _callbacks, _signal, tools) => {
      requests += 1;
      assert.deepEqual(tools, []);
      assert.deepEqual(JSON.parse(messages[1].content), {
        currentRequest: input, previousRequest: "Pause the previous run.", planContinuationCandidates,
      });
      return { content: JSON.stringify(wire), finishReason: "stop", toolCalls: [] };
    });
    const result = await preflight({ ...params, input, language, hasWorkspace: true,
      previousRequest: "Pause the previous run.", planContinuationCandidates });
    assert.equal(requests, 1);
    assert.equal(result.intent, expectedIntent);
    assert.deepEqual(result.planContinuation, kind === "new" ? undefined : relation);
    assert.deepEqual(result.semantic.forbiddenCapabilities, ["command"]);
    assert.equal(result.approved, undefined);
  }
});

test("continuation candidates cannot be guessed, repeated, or invented by the classifier", async () => {
  const invalid = [
    { kind: "continue", candidateId: "other-session:v3" },
    { kind: "approve", candidateId: planContinuationCandidates[0].id },
    { kind: "ambiguous", candidateIds: [planContinuationCandidates[0].id, planContinuationCandidates[0].id] },
  ];
  for (const planContinuation of invalid) {
    const diagnostics = [];
    const result = await loadPreflight({ ...candidate(), planContinuation })({
      ...params, hasWorkspace: true, planContinuationCandidates, onDiagnostic: value => diagnostics.push(value),
    });
    assert.equal(result, null);
    assert.equal(diagnostics[0].field, "planContinuation");
  }
  const operation = { ...candidate({ workType: "implement", requiredCapabilities: ["workspace_write"], forbiddenCapabilities: [] }),
    planContinuation: { kind: "discuss", candidateId: planContinuationCandidates[0].id } };
  assert.equal(await loadPreflight(operation)({ ...params, hasWorkspace: true, planContinuationCandidates }), null);
  const unbound = { ...candidate(), planContinuation: { kind: "continue", candidateId: planContinuationCandidates[0].id } };
  assert.equal(await loadPreflight(unbound)({ ...params, hasWorkspace: true }), null);
});

test("a missing continuation decision can retain read-only semantics or explicit Plan, while autonomous effects and planning fail closed", async () => {
  for (const [workType, requiredCapabilities, explicitIntent, expected] of [
    ["answer", [], undefined, "respond"],
    ["investigate", ["workspace_read"], undefined, "analyze"],
    ["plan", ["workspace_read"], "plan", "plan"],
    ["plan", ["workspace_read"], undefined, null],
    ["implement", ["workspace_write"], undefined, null],
    ["operate", ["command"], undefined, null],
  ]) {
    const diagnostics = [];
    const result = await loadPreflight(candidate({ workType, requiredCapabilities, forbiddenCapabilities: [] }))({
      ...params, hasWorkspace: true, explicitIntent, planContinuationCandidates,
      onDiagnostic: value => diagnostics.push(value),
    });
    assert.equal(result?.intent ?? null, expected);
    assert.equal(result?.planContinuation, undefined);
    assert.equal(diagnostics[0]?.field, expected === null ? "planContinuation" : undefined);
  }
});

test("public web research uses network capability without becoming an interactive operation", async () => {
  for (const [workType, intent] of [["answer", "respond"], ["investigate", "analyze"], ["operate", "respond"]]) {
    const wire = candidate({
      objective: "Find the requested current public information",
      workType,
      requiredCapabilities: ["network"],
      forbiddenCapabilities: [],
    });
    let request;
    const preflight = loadPreflight(null, async (messages) => {
      request = messages;
      return { content: JSON.stringify(wire), finishReason: "stop", toolCalls: [] };
    });
    const result = await preflight({ ...params, input: "Find current information on the public web." });
    const instruction = request.find(message => message.role === "system").content;
    assert.match(instruction, /network[^\n]*public[^\n]*web_search[^\n]*web_fetch/i,
      "the classifier must know public search and page fetching are network reads");
    assert.match(instruction, /external_interaction[^\n]*browser[^\n]*app[^\n]*MCP/i,
      "the classifier must distinguish interactive tools from public network reads");
    assert.equal(result.intent, intent);
    assert.equal(result.commandDirective.kind, "none");
    assert.equal(result.requiresApproval, false);
    assert.deepEqual(result.semantic.requiredCapabilities, ["network"]);
  }
});

test("operate describes work without overriding its declared read-only capabilities", async () => {
  for (const [requiredCapabilities, expected] of [[[], "respond"], [["workspace_read"], "analyze"], [["workspace_read", "network"], "analyze"]]) {
    const wire = candidate({ objective: "Inspect the supplied guidance and report its confirmed marker", workType: "operate", requiredCapabilities });
    const result = await loadPreflight(wire)(params);
    assert.equal(result.intent, expected);
    assert.deepEqual(result.semantic, wire.semantic);
    assert.equal(result.commandDirective.kind, "none");
    assert.equal(result.requiresApproval, false);
    assert.equal(result.needsUserChoice, false);
  }
});

test("a coarse operate label cannot invent a conflict under the explicit Analyze ceiling", async () => {
  const wire = candidate({ workType: "operate", requiredCapabilities: ["workspace_read"] });
  const result = await loadPreflight(wire)({ ...params, explicitIntent: "analyze" });
  assert.equal(result.intent, "analyze");
  assert.equal(result.needsUserChoice, false);
  assert.equal(result.semantic.clarification, undefined);
  assert.deepEqual(result.semantic.forbiddenCapabilities, ["workspace_write", "command"]);
});

test("declared effect capabilities and implementation retain Execute independently of the operate label", async () => {
  for (const [workType, requiredCapabilities, kind] of [
    ["operate", ["workspace_write"], "file_modify"],
    ["operate", ["command"], "shell"],
    ["operate", ["external_interaction"], "mcp"],
    ["implement", [], "file_modify"],
  ]) {
    const result = await loadPreflight(candidate({ workType, requiredCapabilities, forbiddenCapabilities: [] }))(params);
    assert.equal(result.intent, "execute");
    assert.equal(result.commandDirective.kind, kind);
    assert.equal(result.requiresApproval, true);
    assert.equal(result.approved, undefined);
  }
});

test("semantic preflight drops model authority, commands, and completion claims", async () => {
  const result = await loadPreflight({
    ...candidate(), intent: "execute", requiresApproval: true, approved: true,
    commandDirective: { kind: "shell", exactCommand: "rm -rf outside", target: "/outside" },
    complete: true,
  })(params);
  assert.equal(result.intent, "respond");
  assert.equal(result.requiresApproval, false);
  assert.equal(result.commandDirective.kind, "none");
  assert.equal(result.commandDirective.exactCommand, undefined);
  assert.equal(result.commandDirective.target, undefined);
  assert.equal(result.approved, undefined);
  assert.equal(result.riskLevel, "low");
  assert.equal(result.summary, "Explain the previous result");
  assert.deepEqual(result.semantic.forbiddenCapabilities, ["workspace_write", "command"]);
});

for (const [language, input, question] of [
  ["zh", "请直接完成当前项目的修改，运行命令并验证交互。", "需要运行命令，是否确认继续？"],
  ["en", "Complete this project change, run commands and verify interaction.", "May I proceed with commands and interaction checks?"],
]) test(`preflight cannot invent execution consent from needsUserChoice alone (${language})`, async () => {
  const wire = candidate({ workType: "implement", answerFormat: "report", requiredCapabilities: ["workspace_read", "workspace_write", "command"], forbiddenCapabilities: [] });
  const plain = await loadPreflight(wire)({ ...params, input, language });
  const flagged = await loadPreflight({ ...wire, needsUserChoice: true, question })({ ...params, input, language });
  assert.equal(flagged.needsUserChoice, false);
  assert.equal(flagged.intent, "execute");
  assert.deepEqual(flagged.commandDirective, plain.commandDirective);
  assert.deepEqual(flagged.semantic.approvalRequiredCapabilities, []);
  assert.equal(flagged.question, undefined);
});

test("a clarification must identify a supported gap grounded in the current input", async () => {
  const input = "Deploy to staging or production; I have not selected the target.";
  const wire = candidate({ workType: "operate", requiredCapabilities: ["command"], forbiddenCapabilities: [] });
  const clarification = { kind: "target_ambiguity", field: "deployment target", evidence: "staging or production", question: "Which target?", choices: ["staging", "production"] };
  const result = await loadPreflight({ ...wire, needsUserChoice: true, question: clarification.question, clarification })({ ...params, input });
  assert.equal(result.needsUserChoice, true);
  assert.deepEqual(result.semantic.clarification, clarification);
  for (const invalid of [{ ...clarification, kind: "execution_approval" }, { ...clarification, evidence: "not in current request" }, { ...clarification, choices: ["invented", "production"] }]) {
    const ignored = await loadPreflight({ ...wire, needsUserChoice: true, question: "Confirm?", clarification: invalid })({ ...params, input });
    assert.equal(ignored.needsUserChoice, false);
    assert.equal(ignored.semantic.clarification, undefined);
  }
});

test("current manual review requirements are restrictive semantics, never model approval", async () => {
  const wire = candidate({ workType: "operate", requiredCapabilities: ["command"], forbiddenCapabilities: [], approvalRequiredCapabilities: ["command", "command"] });
  wire.approved = true;
  const result = await loadPreflight(wire)({ ...params, input: "Run one command only after I approve that exact invocation." });
  assert.deepEqual(result.semantic.approvalRequiredCapabilities, ["command"]);
  assert.equal(result.intent, "execute");
  assert.equal(result.approved, undefined);
  assert.equal(result.commandDirective.exactCommand, undefined);
  for (const value of [undefined, null, "command", ["unknown"], [true]]) {
    const invalid = candidate({ approvalRequiredCapabilities: value });
    const diagnostics = [];
    assert.equal(await loadPreflight(invalid)({ ...params, onDiagnostic: (event) => diagnostics.push(event) }), null);
    assert.equal(diagnostics[0].field, "semantic.approvalRequiredCapabilities");
  }
});

test("valid semantic objectives supply missing display titles without changing semantics", async () => {
  for (const title of [undefined, "", " \n "]) {
    const wire = candidate();
    if (title !== undefined) wire.title = title;
    const result = await loadPreflight(wire)(params);
    assert.equal(result.title, wire.semantic.objective);
    assert.deepEqual(result.semantic, wire.semantic);
    assert.equal(result.intent, "respond");
    assert.equal(result.commandDirective.kind, "none");
    assert.equal(result.requiresApproval, false);
  }
  const explicit = await loadPreflight({ ...candidate(), title: "## Result provenance" })(params);
  assert.equal(explicit.title, "Result provenance");
  assert.equal(explicit.summary, candidate().semantic.objective);
  assert.equal(await loadPreflight({ title: "A title alone is not a semantic result" })(params), null);
});

test("complete semantics remain usable when non-authoritative confidence or choice hints are omitted", async () => {
  const semantic = candidate({ objective: "查询特定ETF当天的上午行情", workType: "investigate", requiredCapabilities: ["network"], forbiddenCapabilities: [] }).semantic;
  for (const hints of [{}, { confidence: 0.8 }, { needsUserChoice: false }]) {
    const result = await loadPreflight({ semantic, ...hints })({ ...params, input: "这只基金今天上午的行情怎么样？" });
    assert.ok(result, "complete semantic fields must not depend on optional presentation hints");
    assert.deepEqual(result.semantic, semantic);
    assert.equal(result.intent, "analyze");
    assert.equal(result.confidence, hints.confidence ?? 0);
    assert.equal(result.needsUserChoice, false);
    assert.equal(result.requiresApproval, false);
  }
  const input = "Deploy to staging or production; I have not selected the target.";
  const clarification = { kind: "target_ambiguity", field: "deployment target", evidence: "staging or production", question: "Which target?", choices: ["staging", "production"] };
  const clarified = await loadPreflight({ semantic, clarification })({ ...params, input });
  assert.equal(clarified.needsUserChoice, true, "grounded clarification remains authoritative even without the hint");
  assert.deepEqual(clarified.semantic.clarification, clarification);
  const operation = candidate({ workType: "operate", requiredCapabilities: ["command"], forbiddenCapabilities: [], approvalRequiredCapabilities: ["command"] }).semantic;
  const executable = await loadPreflight({ semantic: operation })({ ...params, input: "Run the requested command only after individual approval." });
  assert.equal(executable.intent, "execute");
  assert.equal(executable.requiresApproval, true);
  assert.deepEqual(executable.semantic.approvalRequiredCapabilities, ["command"]);
  assert.equal(await loadPreflight({ semantic: { ...operation, approvalRequiredCapabilities: undefined } })(params), null);
});

test("work and capabilities determine execution independently of response format", async () => {
  for (const [workType, requiredCapabilities, answerFormat, intent, kind] of [
    ["implement", ["workspace_read", "workspace_write", "command"], "analysis", "execute", "file_modify"],
    ["investigate", ["command"], "report", "execute", "shell"],
    ["operate", ["external_interaction"], "summary", "execute", "mcp"],
    ["investigate", ["workspace_read"], "report", "analyze", "none"],
    ["plan", ["workspace_read"], "plan", "plan", "none"],
    ["answer", [], "analysis", "respond", "none"],
  ]) {
    const result = await loadPreflight(candidate({ workType, requiredCapabilities, answerFormat, forbiddenCapabilities: [] }))(params);
    assert.equal(result.intent, intent);
    assert.equal(result.outputFormat, answerFormat);
    assert.equal(result.commandDirective.kind, kind);
    assert.equal(result.commandDirective.exactCommand, undefined);
    assert.equal(result.requiresApproval, kind !== "none");
    assert.equal(result.needsUserChoice, false);
  }
});

for (const [language, input, objective] of [
  ["zh", "请帮我完善项目设计，跟我讨论并记录我的选择，以后再生成 README.md。", "协助完善项目设计，记录用户决策，为后续生成 README.md 做准备"],
  ["en", "Help refine this project, discuss and record my choices, and generate README.md later.", "Discuss project design and record choices for a future README"],
]) test(`a capability-free natural plan is a discussion while explicit Plan remains structured (${language})`, async () => {
  const wire = { semantic: { objective, workType: "plan", answerFormat: "plan", requiredCapabilities: [], forbiddenCapabilities: [], approvalRequiredCapabilities: [] } };
  const result = await loadPreflight(wire)({ ...params, input, language, hasWorkspace: true });
  assert.equal(result.intent, "respond");
  assert.deepEqual(result.semantic, wire.semantic, "presentation semantics must remain intact");
  assert.equal(result.outputFormat, "plan");
  assert.equal(result.commandDirective.kind, "none");
  assert.equal(result.requiresApproval, false);
  const explicit = await loadPreflight(wire)({ ...params, input, language, hasWorkspace: true, explicitIntent: "plan" });
  assert.equal(explicit.intent, "plan", "a user-selected Plan still owns its artifact contract");
  assert.deepEqual(explicit.semantic, wire.semantic);
  for (const requiredCapabilities of [["workspace_read"], ["workspace_read", "workspace_write", "command"]]) {
    const operational = await loadPreflight({ semantic: { ...wire.semantic, requiredCapabilities } })({ ...params, input, language, hasWorkspace: true });
    assert.equal(operational.intent, "plan", "nonempty capability sets keep the existing Plan mapping");
  }
});

test("current restrictions and explicit mode conflict cannot elevate authority", async () => {
  const execute = candidate({ workType: "implement", requiredCapabilities: ["workspace_write"], forbiddenCapabilities: [] });
  const clipped = await loadPreflight(execute)({ ...params, explicitIntent: "analyze" });
  assert.equal(clipped.intent, "analyze");
  assert.equal(clipped.needsUserChoice, true);
  assert.equal(clipped.requiresApproval, false);
  assert.equal(clipped.commandDirective.kind, "none");
  const contradictory = await loadPreflight(candidate({ workType: "operate", requiredCapabilities: ["command"] }))(params);
  assert.equal(contradictory.needsUserChoice, true);
  assert.equal(contradictory.commandDirective.kind, "none");
  const restricted = await loadPreflight(candidate({ workType: "investigate", requiredCapabilities: ["workspace_read"] }))({ ...params, explicitIntent: "execute" });
  assert.equal(restricted.intent, "analyze");
  assert.deepEqual(restricted.semantic.forbiddenCapabilities, ["workspace_write", "command"]);
  assert.equal(restricted.commandDirective.kind, "none");
  const explanation = await loadPreflight(candidate())({ ...params, explicitIntent: "execute" });
  assert.equal(explanation.intent, "respond");
  assert.equal(explanation.commandDirective.kind, "none");
  assert.equal(explanation.requiresApproval, false);
  assert.equal(explanation.needsUserChoice, false);
});

test("semantic schema is mandatory and never falls back to lexical command inference", async () => {
  for (const invalid of [
    { intent: "execute", confidence: 1 },
    candidate({ objective: "" }), candidate({ workType: "execute" }),
    candidate({ answerFormat: "execution" }), candidate({ requiredCapabilities: ["approve"] }),
    candidate({ forbiddenCapabilities: ["unknown"] }), candidate({ requiredCapabilities: "command" }),
    { ...candidate(), confidence: NaN }, { ...candidate(), confidence: 1.01 },
    { ...candidate(), needsUserChoice: "false" },
  ]) assert.equal(await loadPreflight(invalid)({ ...params, input: "npm test" }), null);
});

test("preflight sends full current request and one relevant original without tools", async () => {
  const input = "Historical reference: read-only baseline. Now implement the fix and validate it.";
  const previousRequest = "Create two files separately, preserve the original requirement.";
  const result = await loadPreflight(null, async (messages, settings, callbacks, signal, tools, maxTokens) => {
    assert.equal(messages.length, 2);
    assert.ok(messages[1].content.includes(input));
    assert.ok(messages[1].content.includes(previousRequest));
    assert.ok(messages[0].content.includes("execute"));
    assert.match(messages[0].content, /historical|reference/i);
    assert.equal(settings.reasoningRequest, "off");
    assert.deepEqual(tools, []);
    assert.equal(maxTokens, 512);
    return { content: JSON.stringify(candidate({ workType: "implement", requiredCapabilities: ["workspace_write", "command"], forbiddenCapabilities: [] })), finishReason: "stop", toolCalls: [] };
  })({ ...params, input, previousRequest, explicitIntent: "execute" });
  assert.equal(result.intent, "execute");
  assert.deepEqual(result.semantic.forbiddenCapabilities, []);
});

test("truncated, canceled, erroneous, or non-strict JSON streams never yield semantic authority", async () => {
  const content = JSON.stringify(candidate());
  for (const result of [
    { content, finishReason: "length" }, { content, finishReason: null },
    { content, finishReason: "stop", clientStopReason: "reasoning_char_limit" },
    { content, finishReason: "stop", protocolViolation: "fixture" },
    { content, finishReason: "tool_calls", toolCalls: [{ id: "x" }] },
    { content: `prefix ${content}`, finishReason: "stop" },
    { content: `\`\`\`json\n${content}\n\`\`\``, finishReason: "stop" },
  ]) assert.equal(await loadPreflight(null, async () => result)(params), null);
  assert.equal(await loadPreflight(null, async (_messages, _settings, callbacks) => {
    callbacks.onToken(content);
    throw new Error("transport failed after a complete JSON fragment");
  })(params), null);
  assert.equal(await loadPreflight(null, async (_messages, _settings, callbacks) => {
    callbacks.onError(new Error("stream error"));
    return { content, finishReason: "stop" };
  })(params), null);
  const controller = new AbortController();
  assert.equal(await loadPreflight(null, async () => {
    controller.abort();
    return { content, finishReason: "stop" };
  })({ ...params, signal: controller.signal }), null);
});

// Exact completed content from the controlled replay, not the historical native response.
const capturedCompleteAnalysisProse = "I need to interpret the user's request. The user is asking to run `pwd` in the terminal in the current workspace, and explicitly states to wait for separate approval before executing.\n\nLet me analyze:\n- Objective: Run `pwd` command in the current workspace terminal\n- Work type: operate (executing a command)\n- Answer format: answer (the output of the command)\n- Required capabilities: command (to run pwd), workspace_read (pwd reads current directory)\n- Forbidden capabilities: None explicitly stated as forbidden in the current request. The user is asking to run a command, so command is needed.\n- The user explicitly says to wait for approval before executing - this is a procedural note, not a capability restriction. It means the system should not auto-execute but wait for approval. This doesn't forbid the command capability itself.\n\nThe request is clear and unambiguous.";


test("preflight requests adapter-owned JSON output without changing the bounded semantic request", async () => {
  let captured;
  const input = "Run pwd once in the workspace after separate command approval.\n" + "CURRENT_REQUEST_SOURCE ".repeat(300);
  const result = await loadPreflight(null, async (messages, settings, callbacks, signal, tools, maxTokens, options) => {
    captured = { messages, settings, tools, maxTokens, options };
    return { content: JSON.stringify(candidate({ workType: "operate", requiredCapabilities: ["command"], forbiddenCapabilities: [] })), finishReason: "stop", toolCalls: [] };
  })({ ...params, input, hasWorkspace: true });
  assert.deepEqual(captured.options, { responseFormat: { type: "json_object" }, contextOwnership: "caller" });
  assert.equal(captured.settings.reasoningRequest, "off");
  assert.equal(captured.maxTokens, 512);
  assert.deepEqual(captured.tools, []);
  assert.equal(JSON.parse(captured.messages[1].content).currentRequest, input);
  assert.equal(result.intent, "execute");
  assert.equal(result.requiresApproval, true);
  assert.equal(result.commandDirective.exactCommand, undefined);
});

test("completed analysis prose is rejected with a safe JSON diagnostic rather than semantic authority", async () => {
  assert.equal(capturedCompleteAnalysisProse.length, 878);
  assert.equal(createHash("sha256").update(capturedCompleteAnalysisProse).digest("hex"), "99befa663c7cc3a343490b39d704515ca588c18c3e097e4058baba55dae34dee");
  const diagnostics = [];
  const result = await loadPreflight(null, async () => ({ content: capturedCompleteAnalysisProse, finishReason: "stop", toolCalls: [] }))({
    ...params, onDiagnostic: (item) => diagnostics.push(item),
  });
  assert.equal(result, null);
  assert.deepEqual(diagnostics, [{ code: "invalid_json", finishReason: "stop", contentChars: 878 }]);
  assert.doesNotMatch(JSON.stringify(diagnostics), /pwd|interpret|separate approval/);
});

test("preflight failure diagnostics name invalid fields and preserve stream rejection boundaries", async () => {
  for (const [wire, expected] of [
    [{ content: JSON.stringify(candidate({ workType: "execute" })), finishReason: "stop" }, { code: "invalid_result", field: "semantic.workType" }],
    [{ content: JSON.stringify(candidate()), finishReason: "length" }, { code: "incomplete_output" }],
    [{ content: JSON.stringify(candidate()), finishReason: "PRIVATE_FINISH_MARKER" }, { code: "incomplete_output" }],
    [{ content: JSON.stringify(candidate()), finishReason: "stop", clientStopReason: "reasoning_char_limit" }, { code: "client_output_limited" }],
    [{ content: JSON.stringify(candidate()), finishReason: "stop", protocolViolation: "PRIVATE_PROTOCOL_MARKER" }, { code: "protocol_violation" }],
    [{ content: JSON.stringify(candidate()), finishReason: "stop", toolCalls: [{ id: "PRIVATE_TOOL_MARKER" }] }, { code: "unexpected_tool_calls" }],
  ]) {
    const diagnostics = [];
    assert.equal(await loadPreflight(null, async () => wire)({ ...params, onDiagnostic: (item) => diagnostics.push(item) }), null);
    assert.equal(diagnostics.length, 1);
    assert.deepEqual({ code: diagnostics[0].code, ...(diagnostics[0].field ? { field: diagnostics[0].field } : {}) }, expected);
    assert.doesNotMatch(JSON.stringify(diagnostics), /PRIVATE_/);
    if (wire.finishReason === "PRIVATE_FINISH_MARKER") assert.equal(diagnostics[0].finishReason, "unknown");
  }
  const diagnostics = [];
  assert.equal(await loadPreflight(null, async () => { throw new Error("PRIVATE_TRANSPORT_MARKER"); })({ ...params, onDiagnostic: (item) => diagnostics.push(item) }), null);
  assert.deepEqual(diagnostics, [{ code: "transport_error" }]);
  const streamDiagnostics = [];
  assert.equal(await loadPreflight(null, async (_messages, _settings, callbacks) => {
    callbacks.onError(new Error("PRIVATE_STREAM_MARKER"));
    return { content: "PRIVATE_RESPONSE_MARKER", finishReason: "stop", toolCalls: [] };
  })({ ...params, onDiagnostic: (item) => streamDiagnostics.push(item) }), null);
  assert.deepEqual(streamDiagnostics, [{ code: "stream_error", finishReason: "stop", contentChars: 23 }]);
  const aborted = new AbortController();
  aborted.abort();
  assert.equal(await loadPreflight(null, async () => { throw new Error("must not call transport"); })({ ...params, signal: aborted.signal, onDiagnostic: () => { throw new Error("Diagnostics cannot alter authority"); } }), null);
});
