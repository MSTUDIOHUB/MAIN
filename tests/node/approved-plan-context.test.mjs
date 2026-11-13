import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createTsModuleLoader } from './tsModuleLoader.mjs';

const load = createTsModuleLoader();
const runtime = load('src/lib/runtime-v2/index.ts');
const adapter = load('src/store/runtimeV2/workPlanAdapter.ts');
const approval = load('src/store/runtimeV2/planApproval.ts');
const projection = load('src/store/runtimeV2/planReviewProjection.ts');
const context = load('src/store/runtimeV2/executionProviderContext.ts');
const requestPort = load('src/store/runtimeV2/executionProviderRequest.ts');
const providerPort = load('src/store/runtimeV2/executionProviderPort.ts');
const types = load('src/store/runtimeV2/executionTypes.ts');
const streaming = load('src/lib/streaming.ts');
const history = load('src/store/runtimeV2/executionProviderHistory.ts');
const { buildPlanDecisionJournal } = load('src/lib/planDecisionJournal.ts');
const { ensureVersionedReadFileResultForModel } = load('src/lib/readFileWindow.ts');
const { TOOL_DEFINITIONS } = load('src/lib/toolSchemas.ts');

const parserSource = 'export const creator = "example";\r\n';
const skillContent = '# Unity workflow\r\nRun the intended Editor verification.\r\n';
const skillReceipt = JSON.stringify({ type: 'skill.loaded', id: 'panel:unity-workflow', ref: 'panel:unity-workflow',
  version: 'skill-v1', disclosure: 'full', effect: 'instructions_loaded_no_additional_permissions',
  readTarget: { skill_id: 'panel:unity-workflow', expected_version: 'skill-v1' },
  returnedRange: { startLine: 1, endLine: 2, startChar: 0, endChar: skillContent.length },
  totalLines: 2, totalChars: skillContent.length, content: skillContent });

async function fixture({ approve = true, cold = false, stale = false, incidentHistory = false, skillHistory = false } = {}) {
  let ordinal = 0;
  let aggregate = null;
  const turn = { workspaceKey: '/fixture', sessionKey: '/fixture:1', sessionEpoch: 'epoch-1', turnId: 'plan-turn', clientSubmissionId: 'submission' };
  const run = { ...turn, runId: 'plan-run', parentRunId: null, attemptId: 'attempt' };
  const append = draft => {
    aggregate = runtime.transition(aggregate, { schemaVersion: runtime.RUNTIME_V2_EVENT_SCHEMA_VERSION,
      sequence: aggregate?.nextSequence || 0, eventId: `event-${++ordinal}`, at: Math.max(ordinal, (aggregate?.updatedAt || 0) + 1), ...draft });
  };
  append({ type: 'turn.admitted', turn, strategy: 'plan', objective: 'Repair the creatorName mapping and validate.', constraints: [], acceptanceCriteria: ['The mapping passes tests.'] });
  append({ type: 'run.started', run, phase: 'planning' });
  if (incidentHistory) {
    const calls = [
      { id: 'kept', name: 'read_file', arguments: { path: 'src/parser.ts' } },
      { id: 'irrelevant', name: 'read_file', arguments: { path: 'unrelated.ts' } },
      { id: 'outdated', name: 'read_file', arguments: { path: 'src/parser.ts', max_lines: 1 } },
      { id: 'draft', name: 'submit_runtime_v2_work_plan', arguments: { planMarkdown: 'OLD_REVIEW_DRAFT' } },
    ];
    append({ type: 'command.scheduled', run, command: { kind: 'request_model', phase: 'planning', run, idempotencyKey: 'plan-discovery', payload: {} } });
    append({ type: 'provider.responded', run, idempotencyKey: 'plan-discovery', result: { diagnostics: [], toolCalls: calls } });
    for (const [index, call] of calls.entries()) {
      const idempotencyKey = `plan-tool-${call.id}`;
      const target = call.arguments.path;
      const id = `E${index + 1}`;
      const source = target ? [{ id, kind: 'source', target, version: 'source-v1' }] : [];
      const content = call.id === 'kept' ? parserSource : `OLD_${call.id.toUpperCase()}\n`;
      const readBody = target && ensureVersionedReadFileResultForModel(
        target, content, call.id === 'outdated' ? 'stale-version' : 'source-v1',
      );
      append({ type: 'command.scheduled', run, command: { kind: 'execute_tool', phase: 'planning', run, idempotencyKey, payload: { toolName: call.name, toolCallId: call.id, arguments: call.arguments } } });
      append({ type: 'tool.completed', run, idempotencyKey, status: target ? 'succeeded' : 'failed',
        modelContent: target ? `[${id}] ${target}\n${readBody}` : 'OLD_REVIEW_REPAIR', evidence: source });
    }
  }
  if (skillHistory) {
    const call = { id: 'exact-skill-call', name: 'load_skill', arguments: { skill_id: 'panel:unity-workflow' } };
    append({ type: 'command.scheduled', run, command: { kind: 'request_model', phase: 'planning', run, idempotencyKey: 'skill-discovery', payload: {} } });
    append({ type: 'provider.responded', run, idempotencyKey: 'skill-discovery', result: {
      diagnostics: [], toolCalls: [call], visibleText: 'OLD_SKILL_PREAMBLE',
    } });
    append({ type: 'command.scheduled', run, command: { kind: 'execute_tool', phase: 'planning', run, idempotencyKey: 'skill-executed',
      payload: { toolName: call.name, toolCallId: call.id, arguments: call.arguments } } });
    append({ type: 'tool.completed', run, idempotencyKey: 'skill-executed', status: 'succeeded', evidence: [],
      modelContent: `[E14] s:unity-workflow\n${skillReceipt}` });
    const requestId = 'confirm-editor';
    const questionnaire = { revision: 1, purpose: 'plan_interview', title: 'Validation', questions: [
      { id: 'validation', prompt: 'How should we verify?', selectionMode: 'single', required: true,
        options: [{ id: 'editor', label: 'Use the Editor to validate.' }, { id: 'static', label: 'Check statically.' }] },
    ] };
    append({ type: 'run.paused', run, blocker: { requestId, reasonCode: 'user_questionnaire', evidenceSequence: aggregate.nextSequence - 1,
      message: questionnaire.title, options: ['recheck', 'stop'], questionnaire } });
    append({ type: 'run.decision_recorded', run, requestId, choice: 'recheck', answer: { requestId, revision: 1,
      answers: [{ questionId: 'validation', selectedValues: ['editor'] }] } });
    append({ type: 'run.resumed', run, requestId });
  }
  const plan = runtime.sealWorkPlanV1({ id: 'exact-plan', revision: 2, createdAt: 2,
    ...(skillHistory ? { decisionJournal: buildPlanDecisionJournal(aggregate) } : {}),
    draft: { schemaVersion: 'work-plan.v1', objective: 'Repair the creatorName mapping and validate.', summary: 'Preserve existing fields.', findings: [],
      steps: [{ title: 'Fix mapping', operation: 'modify', targets: ['src/parser.ts'], basis: ['E1'], change: 'Map creator to creatorName.', expectedOutcome: 'Both fields remain available.', dependsOn: [] }],
      validations: [{ stepIndexes: [0], kind: 'finite_command', command: 'npm test', expectedOutcome: 'The mapping assertion passes.', required: true }], risks: [], assumptions: [], blockingQuestions: [] },
    evidence: [{ id: 'E1', target: 'src/parser.ts', version: 'source-v1', statement: 'Current mapping source.' }] });
  const documentRef = { owner: { workspace: turn.workspaceKey, sessionKey: turn.sessionKey, sessionEpoch: turn.sessionEpoch, turnId: turn.turnId },
    documentId: 'plan-doc', revision: 1, contentHash: createHash('sha256').update(plan.markdown).digest('hex'),
    path: '/fixture/.MAIN/plans/plan-doc/rev-1.md', title: plan.draft.objective, kind: 'plan' };
  const commit = adapter.createRuntimeV2PlanReviewCommit({ plan, turn, run, requestId: 'exact-review-request', createdAt: 3, documentRef });
  append({ type: 'command.scheduled', run, command: { kind: 'execute_tool', phase: 'planning', run, idempotencyKey: 'save-artifact', payload: { toolName: 'save_plan_document', runtimeOwnedPlanArtifact: true, target: documentRef.documentId } } });
  append({ type: 'tool.completed', run, idempotencyKey: 'save-artifact', status: 'succeeded', modelContent: JSON.stringify({ planDocument: documentRef, markdown: plan.markdown }), evidence: [] });
  append({ type: 'work_plan.sealed', run, workPlan: adapter.toRuntimeV2WorkPlanReference(plan), sealedPlan: plan, reviewCommit: commit });
  let checkpoint = runtime.createRuntimeV2Checkpoint({ aggregate, revision: aggregate.nextSequence, updatedAt: aggregate.updatedAt });
  const port = { async load() { return checkpoint; }, async append(input) {
    const result = runtime.appendRuntimeV2Checkpoint({ checkpoint, ...input });
    if (result.checkpoint) checkpoint = result.checkpoint;
    return result;
  } };
  const ui = { conversationTurns: [{ id: turn.turnId }] };
  projection.applyReviewProjection({ set(update) { Object.assign(ui, update(ui)); } }, commit);
  if (approve) {
    const approved = await approval.approveRuntimeV2PlanReviewCheckpoint({ checkpoint, port, request: ui.activeActionRequest,
      expected: ui.activeActionRequest, now: Math.max(20, aggregate.updatedAt + 1), eventId: 'canonical-approval' });
    assert.equal(approved.ok, true);
    aggregate = checkpoint.aggregate;
  }
  if (stale) {
    append({ type: 'work_plan.invalidated', run, workPlan: adapter.toRuntimeV2WorkPlanReference(plan), reason: 'Source changed; the plan requires review again.' });
    checkpoint = runtime.createRuntimeV2Checkpoint({ aggregate, revision: aggregate.nextSequence, updatedAt: aggregate.updatedAt });
  }
  if (cold) {
    const persisted = runtime.serializeRuntimeV2CheckpointMap({ [turn.turnId]: checkpoint })[turn.turnId];
    assert.equal(Object.hasOwn(persisted, 'aggregate'), false);
    checkpoint = runtime.normalizeRuntimeV2Checkpoint(JSON.parse(JSON.stringify(persisted)), turn);
    assert.ok(checkpoint);
  }
  const state = { config: { activeProfile: 'local', local: { provider: 'ollama', endpoint: 'http://fixture.invalid', model: 'fixture', toolProtocol: 'native', contextLimit: 64000 } },
    runtimeV2Checkpoints: { [turn.turnId]: checkpoint }, conversationTurns: [{ id: turn.turnId, userPrompt: plan.draft.objective }], agentMessages: [], taskFlow: [] };
  const live = types.createRuntimeV2LiveExecutionState();
  live.messages.push({ role: 'user', content: 'Confirmed information. This interview answer is not execution approval.' },
    { role: 'assistant', content: 'The work plan has been submitted for approval and is awaiting confirmation.' });
  if (cold) history.restoreRuntimeV2ExecutionHistory(live, checkpoint.aggregate);
  const ports = { get: () => state, set: patch => Object.assign(state, typeof patch === 'function' ? patch(state) : patch), live,
    context: { turnId: turn.turnId, runWorkspace: turn.workspaceKey, runSessionKey: turn.sessionKey, runtimeRunIntent: 'execute', phaseLanguage: 'en', runtimeContextBudget: { contextLimit: 64000, inputBudget: 48000, outputBudget: 4096, readWindowChars: 24000 } },
    nextId: scope => `${scope}-${++ordinal}`, now: () => ++ordinal, logStoreEvent() {} };
  return { turn, run, plan, commit, documentRef, state, live, ports, checkpoint, ui, commitMutation() {
    append({ type: 'command.scheduled', run, command: { kind: 'execute_tool', phase: aggregate.phase, run, idempotencyKey: 'edited-parser',
      payload: { toolName: 'replace_in_file', arguments: { path: 'src/parser.ts' } } } });
    append({ type: 'tool.completed', run, idempotencyKey: 'edited-parser', status: 'succeeded',
      mutationRequests: [{ target: 'src/parser.ts', operation: 'modify' }],
      evidence: [{ id: 'mutation', kind: 'mutation', target: 'src/parser.ts', version: 'source-v2' }] });
    state.runtimeV2Checkpoints[turn.turnId] = runtime.createRuntimeV2Checkpoint({ aggregate, revision: aggregate.nextSequence, updatedAt: aggregate.updatedAt });
  }, async wire() {
    let wire;
    const previous = streaming.streamChatCompletion;
    streaming.streamChatCompletion = async (messages, _settings, _callbacks, _signal, tools, _maxTokens, options) => {
      wire = { messages: structuredClone(messages), tools: tools.map(tool => tool.function.name), options };
      return { content: 'Fixture request only.', toolCalls: [], finishReason: 'stop' };
    };
    try {
      await requestPort.requestRuntimeV2ProviderOnce({ live, ports, command: { kind: 'request_model', phase: checkpoint.aggregate.phase, run,
        idempotencyKey: 'model-request', payload: { mode: 'execute' } }, tools: TOOL_DEFINITIONS.filter(tool => ['read_file', 'replace_in_file', 'run_command'].includes(tool.function.name)),
        textEnvelope: false, toolChoice: null, signal: new AbortController().signal });
      return wire;
    } finally { streaming.streamChatCompletion = previous; }
  } };
}

for (const cold of [false, true]) test(`validated canonical approval reaches the actual outbound request${cold ? ' after ledger-only cold restore' : ''}`, async () => {
  const f = await fixture({ cold });
  const before = JSON.stringify(f.state.runtimeV2Checkpoints);
  const wire = await f.wire();
  const anchors = wire.messages.filter(message => message.role === 'system' && message.content.startsWith('[runtime-v2 context: approved-work-plan]'));
  assert.equal(anchors.length, 1);
  const anchor = anchors[0].content;
  assert.match(anchor, /user has already separately approved this exact WorkPlan/i);
  assert.match(anchor, /interview.*not execution approval/i);
  assert.match(anchor, /independent.*approval.*effective/i);
  assert.match(anchor, /changed plans.*high-risk.*approval/i);
  const payload = JSON.parse(anchor.slice(anchor.indexOf('{'), anchor.lastIndexOf('}') + 1));
  assert.equal(payload.status, 'approved_for_execution');
  assert.deepEqual(payload.approvalReceipt, { eventType: 'work_plan.approved', eventId: 'canonical-approval',
    sequence: f.checkpoint.aggregate.events.find(event => event.eventId === 'canonical-approval').sequence, at: 20,
    requestId: f.commit.review.requestId,
    owner: { sessionKey: f.turn.sessionKey, sessionEpoch: f.turn.sessionEpoch, turnId: f.turn.turnId, runId: f.run.runId, parentRunId: null },
    authority: f.commit.authority, documentRef: f.documentRef });
  assert.equal(wire.options.toolChoice ?? null, null);
  assert.deepEqual(new Set(wire.tools), new Set(['read_file', 'replace_in_file', 'run_command']));
  assert.equal(JSON.stringify(f.state.runtimeV2Checkpoints), before, 'a model projection cannot mutate canonical approval');
  assert.equal(wire.messages.filter(message => message.role === 'user' && /approved.*exact WorkPlan/i.test(message.content)).length, 0);
});

test('approved handoff projects only relevant exact Plan reads and keeps its static prefix stable', async () => {
  const f = await fixture({ cold: true, incidentHistory: true });
  const before = await f.wire();
  const retained = before.messages.filter(message => message.role === 'tool');
  assert.equal(retained.length, 1);
  assert.equal(retained[0].tool_call_id, 'kept');
  assert.match(retained[0].content, /^READ_FILE_RESULT\npath: src\/parser.ts\ncontentVersion: source-v1/);
  assert.ok(retained[0].content.includes(parserSource), 'exact CRLF bytes survive the legacy header');
  assert.deepEqual(before.messages.flatMap(message => message.tool_calls?.map(call => call.id) || []), ['kept']);
  assert.doesNotMatch(JSON.stringify(before.messages), /OLD_|submit_runtime_v2_work_plan/);
  assert.match(before.messages.at(-1).content, /"completedStepIndexes":\[\]/);
  f.commitMutation();
  const after = await f.wire();
  assert.deepEqual(after.messages.slice(0, -1), before.messages.slice(0, -1));
  assert.match(after.messages.at(-1).content, /"completedStepIndexes":\[0\]/);
});

test('approved continuation starts with the exact plan and Skill receipt instead of past conversational failures', async () => {
  const f = await fixture({ cold: true, incidentHistory: true, skillHistory: true });
  let previous = f.checkpoint.aggregate;
  let current = null;
  let sequence = 0;
  const append = (aggregate, event) => runtime.transition(aggregate, { ...event,
    schemaVersion: runtime.RUNTIME_V2_EVENT_SCHEMA_VERSION, sequence: aggregate?.nextSequence ?? 0,
    at: (aggregate?.updatedAt || 20) + 1, eventId: `continuation-fixture-${++sequence}`,
  });
  const finalProjection = runtime.buildRuntimeV2FinalProjection(previous, 'old-final', 'canceled', 'OLD_FAILURE');
  const outcome = { resultKind: 'canceled', reason: 'OLD_FAILURE', completedAt: previous.updatedAt + 2, finalProjectionId: finalProjection.id };
  previous = append(previous, { type: 'run.aborted', run: f.run, reason: outcome.reason });
  previous = append(previous, { type: 'run.completed', run: f.run, outcome, finalProjection });
  previous = append(previous, { type: 'projection.published', run: f.run, audience: 'final', projectionId: finalProjection.id, projection: finalProjection });
  previous = append(previous, { type: 'turn.completed', turn: f.turn, runId: f.run.runId, outcome });
  const approvalEvent = adapter.resolveHistoricalRuntimeV2ApprovedWorkPlan(previous).approvalEvent;
  const turn = { ...f.turn, turnId: 'continued', clientSubmissionId: 'continued-receipt' };
  const run = { ...f.run, turnId: turn.turnId, runId: 'continued-run', attemptId: 'continued-attempt' };
  current = append(current, { type: 'turn.admitted', turn, strategy: 'plan', objective: f.plan.draft.objective,
    constraints: [], acceptanceCriteria: ['The mapping passes tests.'] });
  current = append(current, { type: 'run.started', run, phase: 'planning' });
  const commit = adapter.createRuntimeV2PlanReviewCommit({ plan: f.plan, turn, run, requestId: 'continued-review', createdAt: current.updatedAt });
  current = append(current, { type: 'work_plan.sealed', run, sealedPlan: f.plan, reviewCommit: commit,
    workPlan: adapter.toRuntimeV2WorkPlanReference(f.plan), continuation: {
      source: { turn: f.turn, run: f.run, approvalEventId: approvalEvent.eventId, workPlan: approvalEvent.workPlan },
      completedStepIndexes: [], carriedTargets: [],
    } });
  current = append(current, { type: 'work_plan.approved', run, workPlan: { ...current.workPlan, status: 'approved' },
    continuationApprovalId: approvalEvent.eventId });
  const checkpoint = (aggregate) => runtime.createRuntimeV2Checkpoint({ aggregate, revision: aggregate.nextSequence, updatedAt: aggregate.updatedAt });
  const live = types.createRuntimeV2LiveExecutionState();
  const state = { ...f.state, runtimeV2Checkpoints: { [f.turn.turnId]: checkpoint(previous), [turn.turnId]: checkpoint(current) },
    conversationTurns: [{ id: f.turn.turnId, userPrompt: 'OLD_PROMPT', summary: 'OLD_FAILURE' }, { id: turn.turnId, userPrompt: 'Continue this plan.' }] };
  const ports = { ...f.ports, live, get: () => state, context: { ...f.ports.context, turnId: turn.turnId } };
  const request = async (live, ports) => {
    let messages;
    const previous = streaming.streamChatCompletion;
    streaming.streamChatCompletion = async (sent) => {
      messages = sent;
      return { content: 'Fixture request only.', toolCalls: [], finishReason: 'stop' };
    };
    try {
      await requestPort.requestRuntimeV2ProviderOnce({ live, ports, command: { kind: 'request_model', phase: 'preparing', run,
        idempotencyKey: 'continued-model-request', payload: { mode: 'execute' } }, tools: TOOL_DEFINITIONS.filter(tool => ['read_file', 'load_skill'].includes(tool.function.name)),
        textEnvelope: false, toolChoice: null, signal: new AbortController().signal });
      return messages;
    } finally { streaming.streamChatCompletion = previous; }
  };
  const messages = await request(live, ports);
  assert.doesNotMatch(JSON.stringify(messages), /OLD_|submit_runtime_v2_work_plan/);
  assert.equal(messages.filter(message => message.role === 'tool').length, 1);
  assert.equal(messages.find(message => message.role === 'tool').content, skillReceipt);
  assert.equal(messages.filter(message => message.role === 'user').map(message => message.content).join(), 'Continue this plan.');
  const anchor = messages.find(message => message.content.startsWith('[runtime-v2 context: approved-work-plan]')).content;
  assert.equal(JSON.parse(anchor.slice(anchor.indexOf('{'))).confirmedChoices, f.plan.decisionJournal);
  assert.match(f.plan.decisionJournal, /Use the Editor to validate\./);
  assert.deepEqual(live.latestProviderRequestSourceCoverage, []);

  const withoutSource = types.createRuntimeV2LiveExecutionState();
  const unbound = await request(withoutSource, { ...ports, live: withoutSource, get: () => ({ ...state,
    runtimeV2Checkpoints: { [turn.turnId]: checkpoint(current) },
  }) });
  assert.equal(unbound.some(message => message.role === 'tool'), false, 'missing source may not create an apparent Skill receipt');
});

test('approved local action guard reuses proven reasoning recovery and traces each wire attempt', async () => {
  const f = await fixture();
  f.state.config.local.provider = 'OMLX';
  const calls = [];
  const events = [];
  f.ports.logStoreEvent = (name, data) => events.push({ name, data });
  const port = providerPort.createRuntimeV2ProviderPort(f.ports);
  const request = (key, mode = 'execute') => port.request({
    run: f.run,
    command: { kind: 'request_model', phase: mode === 'validate' ? 'validating' : 'acting', run: f.run, idempotencyKey: key, payload: { mode } },
    signal: new AbortController().signal,
  });
  const previous = streaming.streamChatCompletion;
  streaming.streamChatCompletion = async (_messages, settings, callbacks, _signal, tools, _maxTokens, options) => {
    const ordinal = calls.push({ reasoning: settings.reasoningRequest, guard: options.reasoningOnlyTimeoutMs });
    const markOutput = callbacks.onRequestDispatched?.();
    callbacks.onLifecycle?.({ phase: 'first_chunk', streamId: `wire-${ordinal}`, elapsedMs: 5 });
    markOutput?.();
    callbacks.onLifecycle?.({ phase: 'model_progress' });
    if (ordinal === 1) return { content: '', reasoningContent: 'thinking', toolCalls: [], finishReason: null, clientStopReason: 'reasoning_only_timeout' };
    if (ordinal === 5) return { content: '', reasoningContent: 'thinking before an incomplete native call', toolCalls: [], finishReason: 'length', streamDiagnostics: { firstToolElapsedMs: 12 } };
    assert.ok(tools.some(tool => tool.function.name === 'read_file'));
    const name = ordinal === 4 ? 'unavailable_tool' : 'read_file';
    return { content: '', toolCalls: [{ id: `tool-${ordinal}`, name, arguments: JSON.stringify({ path: `src/tool-${ordinal}.ts` }) }], finishReason: 'tool_calls' };
  };
  try {
    const initial = await request('initial');
    assert.equal(initial.toolCalls[0].name, 'read_file');
    assert.equal(Object.hasOwn(initial, 'reasoningActionScope'), false, 'provider preference stays out of the durable result');
    f.commitMutation();
    assert.equal((await request('next-action')).toolCalls[0].name, 'read_file');
    assert.equal((await request('rejected-action')).toolCalls.length, 0);
    assert.equal((await request('restored-auto')).toolCalls[0].name, 'read_file');
    assert.equal((await request('after-incomplete-tool')).toolCalls[0].name, 'read_file');
    await request('validation', 'validate');
    assert.deepEqual(calls, [
      { reasoning: 'auto', guard: 60_000 },
      { reasoning: 'off', guard: undefined },
      { reasoning: 'off', guard: undefined },
      { reasoning: 'off', guard: undefined },
      { reasoning: 'auto', guard: 60_000 },
      { reasoning: 'off', guard: undefined },
      { reasoning: 'auto', guard: 60_000 },
      { reasoning: 'auto', guard: 60_000 },
    ]);
    assert.deepEqual(events.filter(event => event.name === 'runtime_v2_provider_request_timing' && event.data.commandKey === 'initial').map(event => event.data.stage), [
      'provider_entered', 'lane_requested', 'lane_acquired',
      'dispatched', 'first_chunk', 'first_model_progress',
      'dispatched', 'first_chunk', 'first_model_progress',
    ]);
    assert.equal(events.find(event => event.name === 'runtime_v2_provider_reasoning_truncated' &&
      event.data.commandKey === 'restored-auto')?.data.truncationKind, 'incomplete_tool_call');
  } finally {
    streaming.streamChatCompletion = previous;
  }
});

test('pending review and a rejected stale UI approval do not claim effective execution approval', async () => {
  const f = await fixture({ approve: false });
  f.state.isPlanApproved = true;
  f.state.currentTurnExecutionConsent = { turnId: f.turn.turnId, granted: true };
  const rejected = await approval.approveRuntimeV2PlanReviewCheckpoint({ checkpoint: f.checkpoint, port: { append() { assert.fail('stale review reached persistence'); } },
    request: f.ui.activeActionRequest, expected: { ...f.ui.activeActionRequest, sessionEpoch: 'stale-epoch' }, now: 20, eventId: 'must-not-append' });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.reason, 'runtime_v2_plan_expected_identity_mismatch');
  const wire = await f.wire();
  assert.equal(wire.messages.some(message => message.role === 'system' && message.content.startsWith('[runtime-v2 context: approved-work-plan]')), false);
  assert.equal(f.checkpoint.aggregate.events.filter(event => event.type === 'work_plan.approved').length, 0);
});

test('invalidating an approved plan removes its obsolete approval projection', async () => {
  const f = await fixture({ stale: true, cold: true });
  f.live.messages.push({ role: 'system', content: '[runtime-v2 context: approved-work-plan]\nThe user has already separately approved this exact WorkPlan.' });
  context.recordApprovedPlanContext(f.ports);
  assert.equal(f.live.messages.some(message => message.role === 'system' && message.content.startsWith('[runtime-v2 context: approved-work-plan]')), false);
  assert.equal(f.checkpoint.aggregate.workPlan.status, 'invalidated');
});
