import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import ts from 'typescript';

const root = process.cwd(); const cache = new Map();
function loadTs(file) {
  file = path.resolve(file); if (cache.has(file)) return cache.get(file);
  const module = { exports: {} }; cache.set(file, module.exports); const require = createRequire(file);
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }, fileName: file }).outputText;
  new Function('exports', 'module', 'require', code)(module.exports, module, name => {
    if (name.startsWith('.')) { const base = path.resolve(path.dirname(file), name); for (const candidate of [base, `${base}.ts`, path.join(base, 'index.ts')]) if (fs.existsSync(candidate) && candidate.endsWith('.ts')) return loadTs(candidate); }
    return require(name);
  }); return module.exports;
}
const runtime = loadTs(path.join(root, 'src/lib/runtime-v2/index.ts'));
const types = loadTs(path.join(root, 'src/store/runtimeV2/executionTypes.ts'));
const provider = loadTs(path.join(root, 'src/store/runtimeV2/executionProviderPort.ts'));
const tool = loadTs(path.join(root, 'src/store/runtimeV2/executionToolPort.ts'));
const outcome = loadTs(path.join(root, 'src/store/runtimeV2/executionOutcome.ts'));
const instruction = loadTs(path.join(root, 'src/store/runtimeV2/executionProviderInstruction.ts'));
const streaming = loadTs(path.join(root, 'src/lib/streaming.ts'));
const ipc = loadTs(path.join(root, 'src/lib/ipc.ts'));

function fixture({ strategy = 'execute', objective = 'Create src/new-controller.ts and verify the requested behavior.', unreadableTarget = null, unknownProbeTarget = null, raceOnCreate = false } = {}) {
  let ordinal = 0; let aggregate = null;
  const files = new Map([['config/version.txt', 'version: 1\n'], ['src/existing-controller.ts', 'export const value = 1;\n']]);
  const writes = []; const shellCalls = []; const wires = [];
  const state = { config: { activeProfile: 'local', local: { provider: 'ollama', endpoint: 'http://fixture.invalid', model: 'fixture', toolProtocol: 'native', contextLimit: 64000 } },
    currentTurnExecutionConsent: { turnId: 'turn', granted: true }, autoApproveTools: false, autoApproveToolScopes: [], approvedShellPermissionRules: [], approvedLocalFileReadPaths: [],
    conversationTurns: [{ id: 'turn', userPrompt: objective }], agentMessages: [], runtimeV2Checkpoints: {}, taskFlow: [], runtimeEvents: [], _nextTaskId: () => ++ordinal,
    harnessRunMarker: { sessionKey: '/fixture:1', turnId: 'turn', runId: 'run', status: 'running' },
  };
  const live = types.createRuntimeV2LiveExecutionState(); const run = { sessionKey: '/fixture:1', sessionEpoch: 'epoch', turnId: 'turn', runId: 'run', parentRunId: null, attemptId: 'attempt' };
  const append = draft => {
    aggregate = runtime.transition(aggregate, { ...draft, schemaVersion: runtime.RUNTIME_V2_EVENT_SCHEMA_VERSION, sequence: aggregate?.nextSequence || 0, eventId: `event-${++ordinal}`, at: ordinal });
    state.runtimeV2Checkpoints.turn = runtime.createRuntimeV2Checkpoint({ aggregate, revision: ordinal, updatedAt: aggregate.updatedAt });
  };
  append({ type: 'turn.admitted', turn: { workspaceKey: '/fixture', sessionKey: '/fixture:1', sessionEpoch: 'epoch', turnId: 'turn', clientSubmissionId: 'submission' }, strategy, objective, constraints: [], acceptanceCriteria: [] });
  append({ type: 'run.started', run, phase: strategy === 'plan' ? 'planning' : 'observing' });
  const ports = { get: () => state, set: patch => Object.assign(state, typeof patch === 'function' ? patch(state) : patch), live,
    context: { turnId: 'turn', runWorkspace: '/fixture', runSessionKey: '/fixture:1', runtimeRunIntent: strategy === 'plan' ? 'plan' : strategy === 'execute' ? 'execute' : 'analyze', phaseLanguage: 'en', runtimeContextBudget: { contextLimit: 64000, inputBudget: 48000, outputBudget: 4096, readWindowChars: 24000 } },
    nextId: scope => `${scope}-${++ordinal}`, now: () => ++ordinal, logStoreEvent() {},
  };
  const originals = new Map();
  const stub = (object, name, value) => { originals.set(name, [object, object[name]]); object[name] = value; };
  stub(ipc, 'readFile', async target => { if (target === unreadableTarget) throw Object.assign(new Error('read denied'), { code: 'EACCES' }); if (!files.has(target)) throw Object.assign(new Error('not found'), { code: 'ENOENT' }); return files.get(target); });
  stub(ipc, 'getFileMetadata', async target => { if (target === unknownProbeTarget) throw new Error('FILE_METADATA_UNAVAILABLE: probe failed'); if (!files.has(target)) throw new Error('FILE_METADATA_NOT_FOUND: absent'); return { path: `/fixture/${target}`, sizeBytes: files.get(target).length, modifiedMs: 1 }; });
  stub(ipc, 'readFileWindow', async target => { const content = await ipc.readFile(target); return { content, contentVersion: runtime.runtimeV2EvidenceVersion(content), startLine: 1, endLine: 1, totalLines: 1, totalChars: content.length, returnedChars: content.length, truncated: false }; });
  stub(ipc, 'writeFile', async (target, content) => { writes.push(target); files.set(target, content); });
  stub(ipc, 'writeFileCreateNew', async (target, content) => { if (raceOnCreate) files.set(target, 'concurrent file'); if (files.has(target)) throw new Error('CREATE_NEW_TARGET_EXISTS'); writes.push(target); files.set(target, content); });
  stub(ipc, 'checkSourceSyntax', async target => ({ path: target, language: 'typescript', applicable: true, hasErrors: false, errorCount: 0 }));
  stub(ipc, 'shellPermissionPreflight', async command => ({ command, decision: 'allow', requiresApproval: false, segmentDecisions: [], suggestedRules: [], riskLevel: 'low' }));
  stub(ipc, 'runCommand', async command => { shellCalls.push(command); return { command, stdout: '/fixture\n', stderr: '', exitCode: 0, success: true, durationMs: 1, timedOut: false }; });
  let nextAction = { name: 'write_file', arguments: { path: 'src/new-controller.ts', content: 'export const started = true;\n' } };
  stub(streaming, 'streamChatCompletion', async messages => { wires.push(structuredClone(messages)); return { content: '', semanticContent: '', finishReason: 'tool_calls', toolCalls: [{ id: 'model-call', type: 'function', function: { name: nextAction.name, arguments: JSON.stringify(nextAction.arguments) } }], usage: null }; });
  const signal = new AbortController().signal;
  const command = (kind, payload) => ({ kind, payload, phase: aggregate.phase, idempotencyKey: `command-${++ordinal}`, run });
  const execute = async call => {
    const cmd = command('execute_tool', { toolName: call.name, arguments: call.arguments, toolCallId: call.id });
    append({ type: 'command.scheduled', run, command: cmd });
    const receipt = await tool.createRuntimeV2ToolPort(ports).execute({ command: cmd, signal }); append(receipt); return receipt;
  };
  const request = async () => {
    const cmd = command('request_model', { mode: strategy === 'analyze' ? 'analyze' : aggregate.phase === 'validating' ? 'validate' : 'execute', hasVersionedSourceEvidence: aggregate.evidence.some(e => e.kind === 'source'), ...(strategy === 'execute' ? { effectPressure: runtime.deriveRuntimeV2EffectPressure(aggregate) } : {}) });
    append({ type: 'command.scheduled', run, command: cmd });
    const result = await provider.createRuntimeV2ProviderPort(ports).request({ command: cmd, signal }); append({ type: 'provider.responded', run, idempotencyKey: cmd.idempotencyKey, result }); return result;
  };
  return { state, ports, live, files, writes, shellCalls, wires, execute, request, append, run, command, aggregate: () => aggregate, action: action => { nextAction = action; },
    approvePlan(operation, target) {
      const adapter = loadTs(path.join(root, 'src/store/runtimeV2/workPlanAdapter.ts'));
      const plan = runtime.sealWorkPlanV1({ id: 'write-file-plan', revision: 1, createdAt: 1,
        draft: { schemaVersion: runtime.WORK_PLAN_V1_SCHEMA_VERSION, objective, summary: 'Implement one exact approved file operation.', findings: [],
          steps: [{ title: 'Update target', operation, targets: [target], basis: ['source-plan'], change: 'Implement the requested target.', expectedOutcome: 'The target is correct.', dependsOn: [], criterionIds: ['criterion-user-objective'] }],
          validations: [{ stepIndexes: [0], kind: 'finite_command', command: 'npm test', expectedOutcome: 'Tests pass.', required: true, criterionIds: ['criterion-user-objective'] }], risks: [], assumptions: [], blockingQuestions: [] },
        evidence: [{ id: 'source-plan', target, version: runtime.runtimeV2EvidenceVersion(files.get(target) || ''), statement: 'The exact target was reviewed.' }],
      });
      const commit = adapter.createRuntimeV2PlanReviewCommit({ plan, turn: aggregate.turn, run, requestId: 'approved-write-review', createdAt: 2 });
      append({ type: 'work_plan.sealed', run, workPlan: adapter.toRuntimeV2WorkPlanReference(plan), sealedPlan: plan, reviewCommit: commit });
      append({ type: 'work_plan.approved', run, workPlan: adapter.toRuntimeV2WorkPlanReference(plan) });
      append({ type: 'phase.changed', run, phase: 'observing', reason: 'approved Plan begins execution' });
    },
    async readTarget(target) { const call = { id: `read-${target}`, name: 'read_file', arguments: { path: target } }; live.messages.push({ role: 'assistant', content: '', tool_calls: [{ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] }); return execute(call); },
    async recordContract(operation, target) { return execute({ id: 'contract-call', name: 'record_execution_contract', arguments: { summary: 'Implement the requested exact change.', root_causes: ['Fixture evidence identifies the target.'], changes: [{ operation, targets: [target], change: 'Apply this exact operation.', expected_outcome: 'The target has the requested result.' }], validations: [{ kind: 'finite_command', command: 'npm test', expected_outcome: 'Assertions pass.' }] } }); },
    async readMetadata() { const call = { id: 'metadata-read', name: 'read_file', arguments: { path: 'config/version.txt' } }; live.messages.push({ role: 'assistant', content: '', tool_calls: [{ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] }); return execute(call); },
    final(text) { const cmd = command('request_model', { mode: 'execute' }); append({ type: 'command.scheduled', run, command: cmd }); append({ type: 'provider.responded', run, idempotencyKey: cmd.idempotencyKey, result: { visibleText: text, toolCalls: [], diagnostics: [] } }); },
    restore() { for (const [name, [object, value]] of originals) object[name] = value; },
  };
}

test('real Execute request describes authorized new creation consistently with real ToolPort policy despite unrelated visible metadata', async () => {
  const f = fixture();
  try {
    await f.readMetadata(); const response = await f.request();
    assert.equal(response.toolCalls[0].name, 'write_file');
    const receipt = await f.execute(response.toolCalls[0]);
    assert.equal(receipt.status, 'succeeded', receipt.presentation?.message);
    assert.deepEqual(f.writes, ['src/new-controller.ts']);
    assert.equal(f.files.get('config/version.txt'), 'version: 1\n');
    assert.ok(receipt.evidence.some(e => e.kind === 'mutation'));
    const tail = f.wires.at(-1).at(-1).content;
    assert.doesNotMatch(tail, /Use only that visible source for a mutation or validation/);
    assert.match(tail, /New files.*do not require.*existing.*source/i);
    assert.match(tail, /existing.*file.*exact.*source/i);
    const base = f.wires.at(-1).find(message => message.role === 'system' && message.content.startsWith('[MAIN RUNTIME V2]')).content;
    assert.doesNotMatch(base, /A final answer must state confirmed cause/);
    assert.match(base, /Report the actual result/);
    f.final('Created src/new-controller.ts; verification remains pending.');
    assert.equal(outcome.runtimeV2ExecuteTerminalDecision({ aggregate: f.aggregate(), signal: new AbortController().signal }), null, 'a file mutation still carries real validation debt');
  } finally { f.restore(); }
});

test('the existing-file source lease remains mandatory and readonly authority cannot inherit the creation guidance', async () => {
  const f = fixture();
  try {
    await f.readMetadata(); f.action({ name: 'replace_in_file', arguments: { path: 'src/existing-controller.ts', search_text: 'export const value = 1;', replace_text: 'export const value = 2;' } });
    const response = await f.request(); const receipt = await f.execute(response.toolCalls[0]);
    assert.equal(receipt.status, 'blocked'); assert.equal(receipt.failureReasonCode, 'mutation_target_lease_mismatch');
    assert.deepEqual(f.writes, []); assert.equal(f.files.get('src/existing-controller.ts'), 'export const value = 1;\n');
  } finally { f.restore(); }
  const readonly = fixture({ strategy: 'analyze', objective: 'Inspect the current project only.' });
  try {
    await readonly.readMetadata(); const response = await readonly.request();
    assert.equal(response.toolCalls.length, 0, 'a forged write is outside the actual readonly provider surface');
    const receipt = await readonly.execute({ id: 'forged', name: 'write_file', arguments: { path: 'src/new-controller.ts', content: 'no' } });
    assert.equal(receipt.status, 'blocked'); assert.deepEqual(readonly.writes, []);
    assert.doesNotMatch(readonly.wires.at(-1).map(message => message.content).join('\n'), /New files.*do not require.*existing.*source/i);
  } finally { readonly.restore(); }
});

test('ordinary command effects use their own approval and result evidence without an unrelated file-source or write obligation', async () => {
  const f = fixture({ objective: 'Run pwd and report the actual current directory.' });
  try {
    await f.readMetadata(); f.action({ name: 'run_command', arguments: { command: 'pwd', cwd: '.', description: 'Report the current directory.' } });
    const response = await f.request(); const receipt = await f.execute(response.toolCalls[0]);
    assert.equal(receipt.status, 'succeeded'); assert.deepEqual(f.shellCalls, ['pwd']); assert.deepEqual(f.writes, []);
    assert.ok(receipt.evidence.every(item => item.kind === 'tool'));
    const tail = f.wires.at(-1).at(-1).content;
    assert.match(tail, /Commands and external operations.*source lease/i);
    assert.match(tail, /command or external-operation task.*complete final report/i);
    f.final('The actual pwd command succeeded and returned /fixture.');
    assert.equal(outcome.runtimeV2ExecuteTerminalDecision({ aggregate: f.aggregate(), signal: new AbortController().signal })?.resultKind, 'success');
  } finally { f.restore(); }
});

test('recovery hints retain exact existing-file leases and validation debt without inventing a path lock', () => {
  const command = { kind: 'request_model', phase: 'acting', payload: { mode: 'execute' } };
  const surface = { hasReadFile: true, hasMutation: true, hasCreateFile: true, hasSpawnSubagent: false, hasWaitSubagents: false, hasMaterializedSourceEvidence: true, sourceOnlyFrontier: true, materializedSourceCoverage: [{ target: 'src/existing.ts', version: 'v1', complete: true, windows: [{ startLine: 1, endLine: 1 }] }], actionWindow: 'closed_recovery' };
  const corrective = instruction.providerModeInstruction(command, '', surface);
  assert.match(corrective, /Each existing target needs its own versioned source lease/);
  assert.match(corrective, /Safe reads remain available/);
  assert.doesNotMatch(corrective, /observation branch is closed|target.locked/i);
  const validation = instruction.providerModeInstruction({ ...command, phase: 'validating', payload: { mode: 'validate' } }, '', { ...surface, actionWindow: 'validation_handoff' });
  assert.match(validation, /Ordinary shell actions produce tool results and do not discharge.*validation debt/);
  assert.match(validation, /latest committed mutation/);
  for (const restricted of [
    { ...surface, actionWindow: null, validationCorrectionActive: true },
    { ...surface, actionWindow: null, executionContractAdvanceRequired: true, executionContractPendingTargets: ['src/existing.ts'] },
  ]) {
    const prompt = instruction.providerModeInstruction({ ...command, phase: 'validating', payload: { mode: 'validate' } }, '', restricted);
    assert.doesNotMatch(prompt, /New files.*do not require.*existing.*source/i);
    assert.match(prompt, /validation debt/);
  }
});

test('actual restricted provider tool surfaces do not advertise creation when write_file is absent', async () => {
  const requestModule = loadTs(path.join(root, 'src/store/runtimeV2/executionProviderRequest.ts'));
  const { TOOL_DEFINITIONS } = loadTs(path.join(root, 'src/lib/toolSchemas.ts'));
  for (const toolName of ['run_command', 'replace_in_file']) {
    const f = fixture({ objective: 'Continue only with the currently advertised action.' });
    try {
      await f.readMetadata();
      f.action(toolName === 'run_command'
        ? { name: toolName, arguments: { command: 'pwd', cwd: '.', description: 'Read the current directory.' } }
        : { name: toolName, arguments: { path: 'src/existing-controller.ts', search_text: 'old', replace_text: 'new' } });
      const tools = TOOL_DEFINITIONS.filter(tool => tool.function.name === toolName);
      assert.equal(tools.length, 1);
      await requestModule.requestRuntimeV2ProviderOnce({ live: f.live, ports: f.ports, command: f.command('request_model', { mode: 'execute', effectPressure: runtime.deriveRuntimeV2EffectPressure(f.aggregate()) }), tools, textEnvelope: false, toolChoice: null, signal: new AbortController().signal });
      const tail = f.wires.at(-1).at(-1).content;
      assert.match(tail, new RegExp(`exactly 1 tool: ${toolName}`));
      assert.doesNotMatch(tail, /New files.*do not require.*existing.*source/i);
      assert.equal(f.writes.length, 0);
    } finally { f.restore(); }
  }
});

test('ordinary validation keeps authorized second-file creation available while retaining validation debt for the newest mutation', async () => {
  const f = fixture({ objective: 'Create two small modules and validate the complete result.' });
  try {
    await f.readMetadata();
    const first = await f.request();
    f.append({ type: 'phase.changed', run: f.run, phase: 'acting', reason: 'pending_mutation_call' });
    assert.equal((await f.execute(first.toolCalls[0])).status, 'succeeded');
    f.append({ type: 'phase.changed', run: f.run, phase: 'validating', reason: 'mutation_committed' });
    f.action({ name: 'write_file', arguments: { path: 'src/second-module.ts', content: 'export const second = true;\n' } });
    const second = await f.request();
    assert.equal(second.toolCalls[0]?.name, 'write_file', JSON.stringify(second.diagnostics));
    const transition = runtime.decideRuntimeV2ExecutePhaseTransition(f.aggregate(), { isMutationToolName: name => name === 'write_file' });
    assert.deepEqual(transition, { from: 'validating', to: 'acting', reason: 'pending_mutation_call' });
    f.append({ type: 'phase.changed', run: f.run, phase: transition.to, reason: transition.reason });
    assert.equal((await f.execute(second.toolCalls[0])).status, 'succeeded');
    assert.deepEqual(f.writes, ['src/new-controller.ts', 'src/second-module.ts']);
    const tail = f.wires.at(-1).at(-1).content;
    assert.match(tail, /New files.*do not require.*existing.*source/i);
    assert.doesNotMatch(tail, /continue with one exact source-backed mutation/);
    assert.match(tail, /validation debt attached to the newest/);
    f.final('Both requested modules were created; verification is still pending.');
    assert.equal(outcome.runtimeV2ExecuteTerminalDecision({ aggregate: f.aggregate(), signal: new AbortController().signal }), null);
  } finally { f.restore(); }
});


test('write_file cannot overwrite an unread existing file through an unrelated source or a create contract', async () => {
  const target = 'src/existing-controller.ts';
  for (const withCreateContract of [false, true]) {
    const f = fixture();
    try {
      await f.readMetadata();
      if (withCreateContract) assert.equal((await f.recordContract('create', target)).status, 'succeeded');
      f.action({ name: 'write_file', arguments: { path: target, content: 'export const replaced = true;\n' } });
      const response = await f.request(); const receipt = await f.execute(response.toolCalls[0]);
      assert.notEqual(receipt.status, 'succeeded');
      assert.deepEqual(f.writes, []);
      assert.equal(f.files.get(target), 'export const value = 1;\n');
    } finally { f.restore(); }
  }
});

test('write_file modification uses actual existence and a complete current provider source lease', async () => {
  const target = 'src/existing-controller.ts';
  for (const condition of ['current', 'partial', 'stale', 'create-contract']) {
    const f = fixture();
    try {
      assert.equal((await f.readTarget(target)).status, 'succeeded');
      assert.equal((await f.recordContract(condition === 'create-contract' ? 'create' : 'modify', target)).status, 'succeeded');
      f.action({ name: 'write_file', arguments: { path: target, content: 'export const value = 2;\n' } });
      const response = await f.request();
      if (condition === 'partial') f.live.mutationSourceCoverageByToolCallId.set(response.toolCalls[0].id, f.live.mutationSourceCoverageByToolCallId.get(response.toolCalls[0].id).map(source => ({ ...source, complete: false })));
      if (condition === 'stale') f.files.set(target, 'export const concurrentlyChanged = true;\n');
      const receipt = await f.execute(response.toolCalls[0]);
      if (condition === 'current') {
        assert.equal(receipt.status, 'succeeded', receipt.presentation?.message);
        assert.deepEqual(f.writes, [target]);
        assert.equal(f.files.get(target), response.toolCalls[0].arguments.content, 'the write preserves the accepted provider arguments');
      } else {
        assert.notEqual(receipt.status, 'succeeded', condition);
        assert.deepEqual(f.writes, [], condition);
      }
    } finally { f.restore(); }
  }
});

test('write_file requires proved absence and create_new preserves a file appearing after preflight', async () => {
  for (const options of [
    { unreadableTarget: 'src/existing-controller.ts' },
    { unknownProbeTarget: 'src/new-controller.ts' },
    { raceOnCreate: true },
  ]) {
    const f = fixture(options);
    const target = options.unreadableTarget || 'src/new-controller.ts';
    try {
      f.action({ name: 'write_file', arguments: { path: target, content: 'export const value = 2;\n' } });
      const response = await f.request(); const receipt = await f.execute(response.toolCalls[0]);
      assert.notEqual(receipt.status, 'succeeded', JSON.stringify(options));
      assert.deepEqual(f.writes, []);
      if (options.raceOnCreate) assert.equal(f.files.get(target), 'concurrent file');
    } finally { f.restore(); }
  }
});

test('a preserve-only contract advertises no mutation tools while retaining read, revision and validation capabilities', async () => {
  const f = fixture();
  try {
    await f.readTarget('src/existing-controller.ts');
    assert.equal((await f.recordContract('preserve', 'src/existing-controller.ts')).status, 'succeeded');
    const tools = loadTs(path.join(root, 'src/store/runtimeV2/executionAuthorizationContext.ts')).providerToolDefinitionsForCommand(f.ports, f.command('request_model', { mode: 'execute' }));
    const names = tools.map(item => item.function.name);
    assert.ok(names.includes('read_file') && names.includes('run_command') && names.includes('record_execution_contract'));
    assert.ok(!names.some(name => ['write_file', 'replace_in_file', 'apply_patch', 'delete_workspace_path'].includes(name)));
    assert.ok(tools.every(item => !Object.values(item.function.parameters.properties || {}).some(property => Array.isArray(property.enum) && property.enum.length === 0)));
    const forged = await f.execute({ id: 'forged-preserve-write', name: 'write_file', arguments: { path: 'src/existing-controller.ts', content: 'forged' } });
    assert.notEqual(forged.status, 'succeeded'); assert.deepEqual(f.writes, []);
  } finally { f.restore(); }
});


test('Plan write_file uses actual create/modify facts and preserves that operation through checkpoint restore', async () => {
  const target = 'src/existing-controller.ts';
  for (const operation of ['create', 'modify']) {
    const f = fixture({ strategy: 'plan', objective: 'Update the reviewed target.' });
    try {
      f.approvePlan(operation, target);
      assert.equal((await f.readTarget(target)).status, 'succeeded');
      f.action({ name: 'write_file', arguments: { path: target, content: 'export const value = 2;' } });
      const response = await f.request();
      assert.equal(response.toolCalls[0]?.name, 'write_file', JSON.stringify(response.diagnostics));
      const receipt = await f.execute(response.toolCalls[0]);
      if (operation === 'create') {
        assert.notEqual(receipt.status, 'succeeded');
        assert.equal(receipt.failureReasonCode, 'approved_plan_write_file_operation_scope');
        assert.deepEqual(f.writes, []);
      } else {
        assert.equal(receipt.status, 'succeeded', receipt.presentation?.message);
        assert.deepEqual(receipt.mutationRequests, [{ target, operation: 'modify' }]);
        const frontier = runtime.deriveRuntimeV2PlanExecutionFrontier(f.aggregate());
        assert.equal(frontier.steps[0].status, 'completed');
        const checkpoint = runtime.createRuntimeV2Checkpoint({ aggregate: f.aggregate(), revision: 100, updatedAt: 100 });
        const restored = runtime.normalizeRuntimeV2CheckpointMap({ turn: JSON.parse(JSON.stringify(checkpoint)) }).turn;
        assert.ok(restored);
        assert.equal(runtime.deriveRuntimeV2PlanExecutionFrontier(restored.aggregate).steps[0].status, 'completed');
        assert.deepEqual(restored.aggregate.events.find(event => event.type === 'tool.completed' && event.mutationRequests)?.mutationRequests, [{ target, operation: 'modify' }]);
      }
    } finally { f.restore(); }
  }
});
