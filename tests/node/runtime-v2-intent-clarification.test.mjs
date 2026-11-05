import test from "node:test";
import assert from "node:assert/strict";
import { createTsModuleLoader } from "./tsModuleLoader.mjs";
const runtime = createTsModuleLoader()("src/lib/runtime-v2/index.ts");

for (const kind of ["execute", "workspace_read", "plan"]) test(`grounded clarification preserves ${kind} admission and resumes the same canonical owner`, async () => {
  const context = { turnId: "turn", runWorkspace: "/fixture", runScopeKey: "/fixture", runSessionKey: "/fixture:1", runSessionId: 1, runSessionEpoch: "epoch", harnessRunId: "run", phaseLanguage: "en",
    capabilityRestrictions: ["workspace_write"], approvalRequiredCapabilities: ["command"], networkRead: { enabled: true, provider: "fixture" },
    turnInputContextSignals: { subagentRequirement: "required" },
    intentClarification: { kind: "target_ambiguity", field: "target", evidence: "staging or production", question: "Which?", choices: ["staging", "production"] } };
  let state = { currentTurnId: "turn", currentSessionId: 1, runtimeV2Checkpoints: {}, taskFlow: [],
    harnessRunMarker: { runId: "run", sessionKey: "/fixture:1", status: "running" }, _nextTaskId: () => 1,
    conversationTurns: [{ id: "turn", userPrompt: "Inspect staging or production.", clientSubmissionId: "submit" }] };
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
  assert.equal((await handle(input, kind)).outcome.status, "paused");
  let aggregate = state.runtimeV2Checkpoints.turn.aggregate;
  assert.equal(aggregate.strategy, kind === "workspace_read" ? "analyze" : kind);
  assert.deepEqual(aggregate.objective.capabilityRestrictions, ["workspace_write"]);
  assert.deepEqual(aggregate.objective.approvalRequiredCapabilities, ["command"]);
  assert.equal(aggregate.networkRead.enabled, true);
  assert.equal(aggregate.subagentRequirement, "required");
  assert.equal(aggregate.terminalOutcome, null);
  assert.equal(aggregate.events.some(event => event.type === "command.scheduled"), false);
  assert.equal(state.activeActionRequest.kind, "user_choice");
  const event = { schemaVersion: runtime.RUNTIME_V2_EVENT_SCHEMA_VERSION, eventId: "choice", at: aggregate.updatedAt + 1, sequence: aggregate.nextSequence,
    type: "run.decision_recorded", run: aggregate.run.identity, requestId: aggregate.run.blocker.requestId, choice: "recheck", reply: "staging" };
  const result = runtime.appendRuntimeV2Checkpoint({ checkpoint: state.runtimeV2Checkpoints.turn, owner: aggregate.turn, expectedRevision: state.runtimeV2Checkpoints.turn.revision, event });
  set({ runtimeV2Checkpoints: runtime.normalizeRuntimeV2CheckpointMap(runtime.serializeRuntimeV2CheckpointMap({ turn: result.checkpoint })) });
  assert.equal(await handle({ ...input, context: { ...context, intentClarification: undefined } }, kind), null);
  aggregate = state.runtimeV2Checkpoints.turn.aggregate;
  assert.equal(aggregate.run.status, "running");
  assert.equal(aggregate.run.identity.runId, "run");
  assert.equal(aggregate.events.filter(event => event.type === "run.started").length, 1);
  assert.equal(aggregate.events.filter(event => event.type === "run.resumed").length, 1);
  assert.equal(aggregate.events.filter(event => event.type === "run.decision_recorded")[0].reply, "staging");
});
