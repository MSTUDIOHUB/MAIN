import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "./tsModuleLoader.mjs";

const workspace = "/fixture";
const ball = "Assets/Scripts/Ball.cs";
const missing = "Assets/Scenes/Breakout.unity";
const unreadable = "Assets/Audio/Hit.wav";
const alias = "Assets/Linked.cs";
const large = "Assets/LargeScene.unity";
const version = `sha256-${"a".repeat(64)}`;

async function fixture({ abortRead } = {}) {
  const calls = [];
  const load = createTsModuleLoader({ "../../lib/ipc": {
    getFileMetadata: async (target, cwd) => {
      calls.push(["metadata", target, cwd]);
      if (target === missing) throw new Error("FILE_METADATA_NOT_FOUND: fixture");
      return { path: `${workspace}/${target === alias ? "Assets/Unexpected.cs" : target}`,
        sizeBytes: target === large ? 3 * 1024 * 1024 : 26 };
    },
    readFileWindow: async (target, cwd, startLine, endLine, maxLines, maxChars, startChar) => {
      calls.push(["source", target, cwd, maxChars]);
      assert.deepEqual([startLine, endLine, maxLines, startChar], [1, undefined, 500, 0]);
      if (target === unreadable) throw new Error("invalid UTF-8");
      if (abortRead) abortRead.abort(new Error("revision canceled during read"));
      return { path: target, content: "velocity = linearVelocity;", contentVersion: version,
        startLine: 0, endLine: 0, totalLines: 1, totalChars: 26, returnedChars: 26,
        returnedStartChar: 0, returnedEndChar: 26, truncated: false };
    },
  } });
  const runtime = load("src/lib/runtime-v2/index.ts");
  const helpers = load("src/store/runtimeV2/planRevisionEvidence.ts");
  const { PlanLedger } = load("src/store/runtimeV2/planLedger.ts");
  const turn = { workspaceKey: workspace, sessionKey: "session", sessionEpoch: "epoch", turnId: "revision", clientSubmissionId: "revision-submission" };
  const run = { sessionKey: turn.sessionKey, sessionEpoch: turn.sessionEpoch, turnId: turn.turnId, runId: "revision-run", attemptId: "revision-run", parentRunId: null };
  let checkpoint = null;
  const port = { append: async input => {
    const result = runtime.appendRuntimeV2Checkpoint({ ...input, checkpoint });
    checkpoint = result.checkpoint;
    return result;
  } };
  const ledger = new PlanLedger(turn, port, {}, null);
  await ledger.append({ type: "turn.admitted", turn, strategy: "plan", objective: "Revise only changed project files", constraints: [], acceptanceCriteria: [] });
  await ledger.append({ type: "run.started", run, phase: "planning" });
  return { helpers, calls, ledger, run, restore: () => {
    const persisted = JSON.parse(JSON.stringify(runtime.serializeRuntimeV2CheckpointMap({ [turn.turnId]: checkpoint })));
    const recovered = runtime.normalizeRuntimeV2Checkpoint(persisted[turn.turnId], turn);
    return new PlanLedger(turn, port, {}, recovered);
  } };
}

test("revision scope intersects exact sealed targets with durable drift paths", async () => {
  const { helpers } = await fixture();
  assert.deepEqual(helpers.scopedPlanRevisionTargets(
    [`${workspace}/${ball}`, ball, missing, "/other/Assets/Scripts/Ball.cs", "Assets/../escape.cs", ".MAIN/plans/rev-1.md", "unrelated.cs"],
    [ball, `./${missing}`, "escape.cs", ".MAIN/plans/rev-1.md"], workspace,
  ), [ball, missing]);
  assert.deepEqual(helpers.scopedPlanRevisionTargets(["other/Assets/Scripts/Ball.cs"], [`${workspace}/${ball}`], workspace), []);
  assert.equal(helpers.observedPlanRevisionArtifact([`${workspace}/.MAIN/plans/rev-1.md`], ".MAIN/plans/rev-1.md", workspace), true);
  assert.equal(helpers.observedPlanRevisionArtifact(["/other/.MAIN/plans/rev-1.md"], ".MAIN/plans/rev-1.md", workspace), false);
});

test("revision reads bounded trusted files, records unknown and missing facts, and restores without rereading", async () => {
  const { helpers, ledger, calls, run, restore } = await fixture();
  const paths = [ball, missing, unreadable, alias, large];
  const first = { ledger, run, workspace, paths, canRead: true, signal: new AbortController().signal,
    readWindowChars: 512, evidence: [], evidenceContents: new Map() };
  const message = await helpers.collectPlanRevisionPathEvidence(first);
  assert.deepEqual(calls, [
    ["metadata", ball, workspace], ["source", ball, workspace, 512], ["metadata", missing, workspace],
    ["metadata", unreadable, workspace], ["source", unreadable, workspace, 512], ["metadata", alias, workspace], ["metadata", large, workspace],
  ]);
  assert.match(message, /velocity = linearVelocity/);
  assert.match(message, /"status":"missing"/);
  assert.match(message, /"status":"unavailable"/);
  assert.match(message, /"status":"deferred_large_file"/);
  assert.deepEqual(first.evidence.map(({ id, version }) => [id, version]), [["E1", version], ["E2", null], ["E3", null], ["E4", null], ["E5", null]]);
  assert.deepEqual(ledger.snapshot().evidence.map(({ kind }) => kind), ["source", "tool", "tool", "tool", "tool"]);

  const cold = { ...first, ledger: restore(), evidence: [], evidenceContents: new Map() };
  assert.equal(await helpers.collectPlanRevisionPathEvidence(cold), message);
  assert.deepEqual(cold.evidence, first.evidence);
  assert.equal(cold.ledger.snapshot().evidence.length, 5);
  assert.equal(calls.length, 7);
});

test("revision read restrictions and interrupted reads produce no source or durable read receipt", async () => {
  const abortRead = new AbortController();
  const { helpers, ledger, calls, run } = await fixture({ abortRead });
  const input = { ledger, run, workspace, paths: [ball], canRead: false,
    signal: abortRead.signal, evidence: [], evidenceContents: new Map() };
  assert.match(await helpers.collectPlanRevisionPathEvidence(input), /authorization_required/);
  assert.deepEqual(calls, []);
  assert.deepEqual(ledger.snapshot().evidence, []);
  await assert.rejects(helpers.collectPlanRevisionPathEvidence({ ...input, canRead: true }), /revision canceled during read/);
  assert.deepEqual(ledger.snapshot().evidence, []);
  assert.deepEqual(input.evidence, []);
});
