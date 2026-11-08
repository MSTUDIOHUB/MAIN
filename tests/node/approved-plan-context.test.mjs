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
const types = load('src/store/runtimeV2/executionTypes.ts');
const streaming = load('src/lib/streaming.ts');
const history = load('src/store/runtimeV2/executionProviderHistory.ts');
const { TOOL_DEFINITIONS } = load('src/lib/toolSchemas.ts');

async function fixture({ approve = true, cold = false, stale = false } = {}) {
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
  const plan = runtime.sealWorkPlanV1({ id: 'exact-plan', revision: 2, createdAt: 2,
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
      expected: ui.activeActionRequest, now: 20, eventId: 'canonical-approval' });
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
  return { turn, run, plan, commit, documentRef, state, live, ports, checkpoint, ui, async wire() {
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
