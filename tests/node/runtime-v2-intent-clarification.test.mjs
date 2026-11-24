import test from "node:test";
import assert from "node:assert/strict";
import { createTsModuleLoader } from "./tsModuleLoader.mjs";
const runtime = createTsModuleLoader()("src/lib/runtime-v2/index.ts");

function fixture(userPrompt, contextOverrides) {
  const context = { turnId: "turn", runWorkspace: "/fixture", runScopeKey: "/fixture", runSessionKey: "/fixture:1", runSessionId: 1, runSessionEpoch: "epoch", harnessRunId: "run", phaseLanguage: "en",
    capabilityRestrictions: ["workspace_write"], approvalRequiredCapabilities: ["command"], networkRead: { enabled: true, provider: "fixture" },
    turnInputContextSignals: { subagentRequirement: "required" }, ...contextOverrides };
  let state = { currentTurnId: "turn", currentSessionId: 1, runtimeV2Checkpoints: {}, taskFlow: [],
    harnessRunMarker: { runId: "run", sessionKey: "/fixture:1", status: "running" }, _nextTaskId: () => 1,
    conversationTurns: [{ id: "turn", userPrompt, clientSubmissionId: "submit" }] };
  const get = () => state;
  const set = patch => { state = { ...state, ...(typeof patch === "function" ? patch(state) : patch) }; };
  const load = createTsModuleLoader({ "./checkpointPort": {
    getRuntimeV2Checkpoint: () => state.runtimeV2Checkpoints.turn,
    createRuntimeV2CheckpointPort: () => ({ append: async input => {
      const result = runtime.appendRuntimeV2Checkpoint({ checkpoint: state.runtimeV2Checkpoints.turn, ...input });
      if (result.checkpoint) set({ runtimeV2Checkpoints: { turn: result.checkpoint } }); return result;
    } }),
  } });
  const { handleRuntimeV2IntentClarification: handle } = load("src/store/runtimeV2/intentClarification.ts");
  const input = { context, get, set, logStoreEvent() {} };
  return {
    run: kind => handle(input, kind),
    state: get,
    aggregate: () => state.runtimeV2Checkpoints.turn.aggregate,
    reply(text) {
      const checkpoint = state.runtimeV2Checkpoints.turn;
      const aggregate = checkpoint.aggregate;
      const event = { schemaVersion: runtime.RUNTIME_V2_EVENT_SCHEMA_VERSION, eventId: `choice-${aggregate.nextSequence}`,
        at: aggregate.updatedAt + 1, sequence: aggregate.nextSequence,
        type: "run.decision_recorded", run: aggregate.run.identity, requestId: aggregate.run.blocker.requestId, choice: "recheck", reply: text };
      const result = runtime.appendRuntimeV2Checkpoint({ checkpoint, owner: aggregate.turn, expectedRevision: checkpoint.revision, event });
      assert.equal(result.disposition, "committed");
      set({ runtimeV2Checkpoints: runtime.normalizeRuntimeV2CheckpointMap(runtime.serializeRuntimeV2CheckpointMap({ turn: result.checkpoint })) });
    },
  };
}

for (const kind of ["execute", "workspace_read", "plan"]) test(`grounded clarification preserves ${kind} admission and resumes the same canonical owner`, async () => {
  const run = fixture("Inspect staging or production.", {
    intentClarification: { kind: "target_ambiguity", field: "target", evidence: "staging or production", question: "Which?", choices: ["staging", "production"] },
  });
  assert.equal((await run.run(kind)).outcome.status, "paused");
  let aggregate = run.aggregate();
  assert.equal(aggregate.strategy, kind === "workspace_read" ? "analyze" : kind);
  assert.deepEqual(aggregate.objective.capabilityRestrictions, ["workspace_write"]);
  assert.deepEqual(aggregate.objective.approvalRequiredCapabilities, ["command"]);
  assert.equal(aggregate.networkRead.enabled, true);
  assert.equal(aggregate.subagentRequirement, "required");
  assert.equal(aggregate.terminalOutcome, null);
  assert.equal(aggregate.events.some(event => event.type === "command.scheduled"), false);
  assert.equal(run.state().activeActionRequest.kind, "user_choice");
  run.reply("staging");
  assert.equal(await run.run(kind), null);
  aggregate = run.aggregate();
  assert.equal(aggregate.run.status, "running");
  assert.equal(aggregate.run.identity.runId, "run");
  assert.equal(aggregate.events.filter(event => event.type === "run.started").length, 1);
  assert.equal(aggregate.events.filter(event => event.type === "run.resumed").length, 1);
  assert.equal(aggregate.events.filter(event => event.type === "run.decision_recorded")[0].reply, "staging");
});

test("unclassified Execute pauses before any operation and persists the clarified command on the same Run", async () => {
  const run = fixture("Do it for me.", { runtimeRunIntent: "execute" });
  assert.equal((await run.run("execute")).outcome.status, "paused");
  const initial = run.aggregate();
  assert.equal(initial.objective.completionRequirement.kind, "unspecified");
  assert.equal(initial.run.blocker.clarification.field, "objective");
  assert.equal(initial.events.some(event => event.type === "command.scheduled"), false);
  run.reply("The usual one.");
  assert.equal((await run.run("execute")).outcome.status, "paused");
  assert.notEqual(run.aggregate().run.blocker.requestId, initial.run.blocker.requestId);

  const exactCommand = "printf 'two  spaces'";
  run.reply(`Run \`${exactCommand}\` and report the output.`);
  assert.equal(await run.run("execute"), null);
  const resolved = run.aggregate();
  assert.deepEqual(resolved.run.identity, initial.run.identity);
  assert.deepEqual(resolved.objective.capabilityRestrictions, ["workspace_write"]);
  assert.deepEqual(resolved.objective.approvalRequiredCapabilities, ["command"]);
  const expected = { kind: "requested_operation", channel: "command", exactCommand };
  assert.deepEqual(resolved.objective.completionRequirement, expected);
  assert.deepEqual(runtime.replayRuntimeV2Events(resolved.events).objective.completionRequirement, expected);
});
