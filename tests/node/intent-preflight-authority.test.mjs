import test from "node:test";
import assert from "node:assert/strict";
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
        return { streamChatCompletion: async (...args) => transport
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
      ...overrides,
    },
    confidence: 0.97,
    needsUserChoice: false,
  };
}

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
