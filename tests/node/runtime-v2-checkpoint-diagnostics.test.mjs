import test from 'node:test';
import assert from 'node:assert/strict';
import { createTsModuleLoader } from './tsModuleLoader.mjs';

const load = createTsModuleLoader();
const runtime = load('src/lib/runtime-v2/index.ts');
const turn = { workspaceKey: '/fixture', sessionKey: 'session', sessionEpoch: 'epoch', clientSubmissionId: 'submission', turnId: 'turn' };
function checkpoint() {
  const aggregate = runtime.transition(null, { schemaVersion: runtime.RUNTIME_V2_EVENT_SCHEMA_VERSION, type: 'turn.admitted', sequence: 0,
    eventId: 'admitted', at: 1, turn, strategy: 'plan', objective: 'PRIVATE_PLAN_BODY', acceptanceCriteria: [], constraints: [] });
  return runtime.createRuntimeV2Checkpoint({ aggregate, revision: 1, updatedAt: aggregate.updatedAt });
}
function persisted() { return JSON.parse(JSON.stringify(runtime.serializeRuntimeV2CheckpointMap({ turn: checkpoint() }).turn)); }

test('checkpoint filtering reports exact bounded failure codes without source contents', () => {
  for (const [mutate, code] of [
    [value => { value.aggregateDigest = 'wrong'; }, 'aggregate_digest_mismatch'],
    [value => { value.events[0].sequence = 7; }, 'event_replay_rejected'],
    [value => { value.updatedAt = 0; }, 'updated_at_stale'],
    [value => { value.events = []; }, 'events_missing'],
  ]) {
    const value = persisted(); mutate(value); const diagnostics = [];
    assert.deepEqual(runtime.normalizeRuntimeV2CheckpointMap({ turn: value }, turn, { onRejected: diagnostic => diagnostics.push(diagnostic) }), {});
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0].code, code);
    assert.equal(diagnostics[0].turnId, 'turn');
    assert.equal(diagnostics[0].eventCount, value.events.length);
    assert.doesNotMatch(JSON.stringify(diagnostics), /PRIVATE_PLAN_BODY/);
  }
});

test('same-owner invalid ledgers cannot be silently removed from a successful save', () => {
  const value = persisted(); value.aggregateDigest = 'wrong'; const diagnostics = [];
  assert.throws(() => runtime.serializeRuntimeV2CheckpointMap({ turn: value }, turn, { onRejected: diagnostic => diagnostics.push(diagnostic) }),
    error => error.code === 'RUNTIME_V2_CHECKPOINT_WRITE_BOUNDARY' && error.reasonCode === 'checkpoint_persist_failed');
  assert.equal(diagnostics[0].code, 'aggregate_digest_mismatch');
  assert.throws(() => runtime.normalizeRuntimeV2CheckpointMap({ turn: value }, turn, { rejectInvalid: true, onRejected() {} }), /checkpoint_persist_failed/);
});

test('owner fencing still filters unrelated historical ledgers with an explicit diagnostic', () => {
  const value = persisted(); const diagnostics = [];
  assert.deepEqual(runtime.serializeRuntimeV2CheckpointMap({ turn: value }, { sessionEpoch: 'replacement' }, { onRejected: diagnostic => diagnostics.push(diagnostic) }), {});
  assert.equal(diagnostics[0].code, 'owner_mismatch');
});

test('a same-session ledger under the wrong Turn key is a save error, not unrelated history', () => {
  const value = persisted();
  assert.throws(() => runtime.serializeRuntimeV2CheckpointMap({ wrong: value }, turn, { onRejected() {} }), /checkpoint_persist_failed/);
});

test('valid checkpoint save preserves the exact ledger and cold restore digest', () => {
  const value = checkpoint(); const diagnostics = [];
  const saved = runtime.serializeRuntimeV2CheckpointMap({ turn: value }, turn, { onRejected: diagnostic => diagnostics.push(diagnostic) }).turn;
  assert.strictEqual(saved.events, value.events);
  assert.equal(saved.aggregateDigest, 'runtime-v2-aggregate-sha256-a2f83a41e49c8b8ba37dfd107a0300698144a4755f6a5b05100b485ff258400d', 'already JSON-stable ledgers retain their previous digest');
  assert.equal(saved.aggregateDigest, value.aggregateDigest);
  assert.equal(saved.events.length, value.events.length);
  assert.equal('aggregate' in saved, false);
  assert.deepEqual(runtime.normalizeRuntimeV2Checkpoint(JSON.parse(JSON.stringify(saved)), turn).aggregate, value.aggregate);
  assert.deepEqual(diagnostics, []);
});

test('durable JSON omits optional request fields without invalidating the checkpoint digest', () => {
  const run = { sessionKey: turn.sessionKey, sessionEpoch: turn.sessionEpoch, turnId: turn.turnId,
    runId: 'run', parentRunId: null, attemptId: 'attempt' };
  let live = checkpoint();
  const append = (event) => {
    const result = runtime.appendRuntimeV2Checkpoint({ checkpoint: live, owner: turn, expectedRevision: live.revision, event: {
      schemaVersion: runtime.RUNTIME_V2_EVENT_SCHEMA_VERSION, sequence: live.aggregate.nextSequence,
      eventId: `event-${live.aggregate.nextSequence}`, at: live.updatedAt + 1, run, ...event,
    } });
    assert.equal(result.disposition, 'committed');
    live = result.checkpoint;
  };
  append({ type: 'run.started', phase: 'planning' });
  append({ type: 'command.scheduled', command: { kind: 'request_model', idempotencyKey: 'request', phase: 'planning', run,
    payload: { stage: 'discovery', audit: { optional: undefined, checks: [undefined, , { tool: 'inspect', optional: undefined }] } },
  } });

  const raw = JSON.parse(JSON.stringify(runtime.serializeRuntimeV2CheckpointMap({ turn: live }, turn).turn));
  assert.deepEqual(raw.events.at(-1).command.payload.audit, { checks: [null, null, { tool: 'inspect' }] });
  const diagnostics = [];
  const restored = runtime.normalizeRuntimeV2Checkpoint(raw, turn, diagnostic => diagnostics.push(diagnostic));
  assert.ok(restored, 'a valid ledger must replay after the same JSON encoding used by SQLite');
  assert.equal(restored.aggregateDigest, live.aggregateDigest);
  assert.deepEqual(restored.scheduledCommands[0].payload.audit, { checks: [null, null, { tool: 'inspect' }] });
  assert.deepEqual(diagnostics, []);

  const corrupted = structuredClone(raw);
  corrupted.events.at(-1).command.payload.audit.checks[2].tool = 'write';
  assert.equal(runtime.normalizeRuntimeV2Checkpoint(corrupted, turn, diagnostic => diagnostics.push(diagnostic)), null);
  assert.equal(diagnostics[0].code, 'aggregate_digest_mismatch');
});
