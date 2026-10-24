import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import ts from 'typescript';

const root = process.cwd();
const cache = new Map();
function loadTs(file) {
  file = path.resolve(file);
  if (cache.has(file)) return cache.get(file);
  const module = { exports: {} }; cache.set(file, module.exports);
  const require = createRequire(file);
  const output = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }, fileName: file,
  }).outputText;
  new Function('exports', 'module', 'require', output)(module.exports, module, name => {
    if (name.startsWith('.')) {
      const base = path.resolve(path.dirname(file), name);
      for (const candidate of [base, `${base}.ts`, path.join(base, 'index.ts')]) {
        if (fs.existsSync(candidate) && candidate.endsWith('.ts')) return loadTs(candidate);
      }
    }
    return require(name);
  });
  return module.exports;
}
const types = loadTs(path.join(root, 'src/store/runtimeV2/executionTypes.ts'));
const provider = loadTs(path.join(root, 'src/store/runtimeV2/executionProviderPort.ts'));
const tool = loadTs(path.join(root, 'src/store/runtimeV2/executionToolPort.ts'));
const streaming = loadTs(path.join(root, 'src/lib/streaming.ts'));
const skill = loadTs(path.join(root, 'src/lib/agentSkills.ts'));
const transcript = loadTs(path.join(root, 'src/store/runtimeV2/executionProviderSkillTranscript.ts'));
const authorization = loadTs(path.join(root, 'src/store/runtimeV2/executionAuthorization.ts'));

function fixture() {
  let id = 0;
  const state = {
    config: { activeProfile: 'local', local: { provider: 'ollama', endpoint: 'http://fixture.invalid', model: 'fixture', toolProtocol: 'native', contextLimit: 64000 } },
    currentTurnExecutionConsent: { turnId: 'turn', granted: true },
    autoApproveTools: false, autoApproveToolScopes: [], approvedShellPermissionRules: [], approvedLocalFileReadPaths: [],
    conversationTurns: [{ id: 'turn', userPrompt: 'Use the admitted guidance to implement and verify the requested change.' }],
  };
  const content = `# Guidance\n${'GUIDANCE_SOURCE_SENTINEL instruction.\n'.repeat(450)}`;
  const catalog = { entries: [{ id: 'skill:fixture', name: 'Fixture guidance', description: 'Only relevant instructions.', content, source: 'panel', entryPath: null, basePath: null, version: 'body-v1', supportingFiles: [], allowImplicitInvocation: true }], explicitSkillIds: [], warnings: [], loadedAt: 1 };
  const live = types.createRuntimeV2LiveExecutionState();
  const ref = skill.skillReference(catalog, 'skill:fixture');
  const logs = [];
  const input = {
    get: () => state, live,
    context: { turnId: 'turn', runWorkspace: '/fixture', runSessionKey: '/fixture:1', runtimeRunIntent: 'execute', phaseLanguage: 'en', skillCatalog: catalog,
      runtimeContextBudget: { contextLimit: 64000, inputBudget: 28000, outputBudget: 4096, readWindowChars: 24000 },
    },
    nextId: scope => `${scope}-${++id}`, now: () => ++id, logStoreEvent: (event, data) => logs.push({ event, data }),
  };
  const run = { sessionKey: '/fixture:1', sessionEpoch: 'epoch', turnId: 'turn', runId: 'run', parentRunId: null, attemptId: 'attempt' };
  const command = () => ({ kind: 'request_model', phase: 'observing', idempotencyKey: `request-${++id}`, run, payload: { mode: 'execute', allowedToolNames: ['load_skill'], collaborationAllowed: false, remainingSubagentCapacity: 0 } });
  const signal = new AbortController().signal;
  let nextArgs = { skill_id: ref, expected_version: 'body-v1', start_line: 1, max_lines: 451, max_chars: 24000 };
  const wires = [];
  const originalStream = streaming.streamChatCompletion;
  streaming.streamChatCompletion = async messages => {
    wires.push(structuredClone(messages));
    return { content: '', semanticContent: '', finishReason: 'tool_calls', toolCalls: [{ id: 'provider-call', type: 'function', function: { name: 'load_skill', arguments: JSON.stringify(nextArgs) } }], usage: null };
  };
  const request = () => provider.createRuntimeV2ProviderPort(input).request({ command: command(), signal });
  const execute = call => tool.createRuntimeV2ToolPort(input).execute({ command: { kind: 'execute_tool', phase: 'observing', idempotencyKey: `tool-${++id}`, run, payload: { toolName: call.name, toolCallId: call.id, arguments: call.arguments } }, signal });
  const pressure = () => live.messages.push(
    { role: 'assistant', content: '', tool_calls: [{ id: 'large-command', type: 'function', function: { name: 'run_command', arguments: JSON.stringify({ command: 'example inspect' }) } }] },
    { role: 'tool', tool_call_id: 'large-command', content: 'ACTUAL_COMMAND_FIXTURE_DATA '.repeat(1500) },
  );
  return { state, input, live, catalog, content, wires, logs, request, execute, pressure, setArgs: args => { nextArgs = args; }, args: () => structuredClone(nextArgs), restore: () => { streaming.streamChatCompletion = originalStream; } };
}

test('real ProviderPort and ToolPort allow the same exact Skill read after its body is evicted, but close a currently visible duplicate', async () => {
  const f = fixture();
  try {
    const originalArgs = f.args();
    const first = await f.request();
    assert.equal(first.toolCalls.length, 1);
    const firstReceipt = await f.execute(first.toolCalls[0]);
    assert.equal(firstReceipt.status, 'succeeded');
    assert.ok(firstReceipt.evidence.every(item => item.kind === 'tool'));
    const loaded = transcript.runtimeV2TranscriptSkillGuidanceWindows(f.live.messages);
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0].content, f.content);
    const visibleDuplicate = await f.request();
    assert.equal(visibleDuplicate.toolCalls.length, 0);
    assert.ok(visibleDuplicate.diagnostics.some(item => item.code === 'repeated_action_rejected'));
    f.pressure();
    f.setArgs(originalArgs);
    const reread = await f.request();
    const actualWire = f.wires.at(-1);
    assert.equal(transcript.runtimeV2TranscriptSkillGuidanceWindows(actualWire).length, 0, 'pressure must evict instruction bytes for this recovery scenario');
    assert.ok(actualWire.some(message => String(message.content).includes('skill.context_evicted')), 'wire advertises the missing window honestly');
    assert.equal(reread.toolCalls.length, 1, JSON.stringify(reread.diagnostics));
    assert.deepEqual(reread.toolCalls[0].arguments, originalArgs, 'the exact call is eligible without a nonce or changed parameters');
    const rereadReceipt = await f.execute(reread.toolCalls[0]);
    assert.equal(rereadReceipt.status, 'succeeded');
    assert.equal(transcript.runtimeV2TranscriptSkillGuidanceWindows(f.live.messages).at(-1).content, f.content);
    assert.deepEqual(f.live.latestProviderRequestSourceCoverage, []);
    assert.equal(f.live.hasExecutedMutationEffect, false);
    assert.equal(f.state.autoApproveTools, false);
    assert.deepEqual(f.state.approvedShellPermissionRules, []);
    assert.deepEqual(f.state.approvedLocalFileReadPaths, []);
    assert.equal((await authorization.authorizeToolForCurrentTurn({ ...f.input, context: { ...f.input.context, capabilityRestrictions: ['workspace_write'] } }, 'write_file', { path: 'result.txt', content: 'not authorized' })).allowed, false);
  } finally { f.restore(); }
});

test('ProviderPort compares exact document, version and contiguous bytes rather than call IDs or model visibility claims', async t => {
  const requestModule = loadTs(path.join(root, 'src/store/runtimeV2/executionProviderRequest.ts'));
  const runtime = loadTs(path.join(root, 'src/lib/runtime-v2/index.ts'));
  for (const scenario of ['covered by another call', 'contiguous halves', 'gap', 'other resource', 'other version', 'pointer only', 'assistant claim only']) {
    await t.test(scenario, async () => {
      const f = fixture(); const originalRequest = requestModule.requestRuntimeV2ProviderOnce;
      try {
        const first = await f.request(); await f.execute(first.toolCalls[0]);
        const originalPair = structuredClone(f.live.messages.slice(-2));
        const receipt = JSON.parse(originalPair[1].content);
        const pair = (id, body, args = f.args()) => [
          { role: 'assistant', content: '', tool_calls: [{ id, type: 'function', function: { name: 'load_skill', arguments: JSON.stringify(args) } }] },
          { role: 'tool', tool_call_id: id, content: JSON.stringify(body) },
        ];
        let currentView = pair('different-call', receipt);
        if (scenario === 'contiguous halves' || scenario === 'gap') {
          const middle = Math.floor(receipt.content.length / 2);
          const firstBody = { ...receipt, content: receipt.content.slice(0, middle), returnedRange: { ...receipt.returnedRange, endChar: middle } };
          const start = middle + (scenario === 'gap' ? 1 : 0);
          const secondBody = { ...receipt, content: receipt.content.slice(start), returnedRange: { ...receipt.returnedRange, startChar: start } };
          currentView = [...pair('half-1', firstBody), ...pair('half-2', secondBody)];
        } else if (scenario === 'other resource') {
          const resource = 'references/other.md';
          currentView = pair('other-resource', { ...receipt, type: 'skill.resource', resource, readTarget: { ...receipt.readTarget, resource }, effect: 'resource_guidance_no_additional_permissions' }, { ...f.args(), resource });
        } else if (scenario === 'other version') {
          currentView = pair('other-version', { ...receipt, version: 'body-v2', readTarget: { ...receipt.readTarget, expected_version: 'body-v2' } }, { ...f.args(), expected_version: 'body-v2' });
        } else if (scenario === 'pointer only') {
          currentView = [{ role: 'system', content: JSON.stringify({ type: 'skill.context_evicted', readTarget: receipt.readTarget, returnedRange: receipt.returnedRange }) }];
        } else if (scenario === 'assistant claim only') {
          currentView = [{ role: 'assistant', content: JSON.stringify(receipt) }];
        }
        requestModule.requestRuntimeV2ProviderOnce = async () => {
          // This owner-boundary matrix supplies the request adapter's derived
          // visibility. The preceding test exercises its real wire assembly.
          f.live.latestProviderRequestSkillGuidanceWindows = transcript.runtimeV2TranscriptSkillGuidanceWindows(currentView)
            .map(({ documentKey, version, returnedRange, readTarget }) => ({ documentKey, version, returnedRange, readTarget }));
          return runtime.normalizeProviderResponseV1({ tool_calls: [{ id: 'again', type: 'function', function: { name: 'load_skill', arguments: JSON.stringify(f.args()) } }] });
        };
        const result = await f.request();
        const covered = scenario === 'covered by another call' || scenario === 'contiguous halves';
        assert.equal(result.toolCalls.length, covered ? 0 : 1, JSON.stringify(result.diagnostics));
        if (covered) assert.ok(result.diagnostics.some(item => item.code === 'repeated_action_rejected'));
        assert.deepEqual(f.live.latestProviderRequestSourceCoverage, []);
        assert.equal(f.live.hasExecutedMutationEffect, false);
      } finally { requestModule.requestRuntimeV2ProviderOnce = originalRequest; f.restore(); }
    });
  }
});

test('real recovery request refreshes Skill visibility from its bounded wire and cannot turn guidance into source authority', async () => {
  const f = fixture();
  f.state.config.local.provider = 'omlx';
  try {
    const first = await f.request(); await f.execute(first.toolCalls[0]);
    f.pressure();
    const recoveryWires = [];
    streaming.streamChatCompletion = async (messages, settings) => {
      recoveryWires.push({ messages: structuredClone(messages), reasoning: settings.reasoningRequest });
      return recoveryWires.length === 1
        ? { content: '', semanticContent: '', reasoningContent: 'Incomplete reasoning draft', finishReason: 'length', toolCalls: [], usage: null }
        : { content: '', semanticContent: '', finishReason: 'tool_calls', toolCalls: [{ id: 'recovery-call', type: 'function', function: { name: 'load_skill', arguments: JSON.stringify(f.args()) } }], usage: null };
    };
    const result = await f.request();
    assert.equal(recoveryWires.length, 2);
    assert.equal(recoveryWires[1].reasoning, 'off');
    const expected = transcript.runtimeV2TranscriptSkillGuidanceWindows(recoveryWires[1].messages)
      .map(({ documentKey, version, returnedRange, readTarget }) => ({ documentKey, version, returnedRange, readTarget }));
    assert.deepEqual(f.live.latestProviderRequestSkillGuidanceWindows, expected);
    assert.equal(expected.length, 0);
    assert.equal(result.toolCalls.length, 1, JSON.stringify(result.diagnostics));
    assert.deepEqual(f.live.latestProviderRequestSourceCoverage, []);
    assert.equal(f.live.hasExecutedMutationEffect, false);
    assert.ok(f.logs.some(entry => entry.event === 'runtime_v2_context_prepared' && entry.data.visibleSkillGuidanceWindows === 0));
  } finally { f.restore(); }
});
