import test from "node:test";
import assert from "node:assert/strict";
import { createTsModuleLoader } from "./tsModuleLoader.mjs";

const { formatReadFileWindowPayloadForModel } = createTsModuleLoader()("src/lib/readFileWindow.ts");
const path = "tests/project.config";
const version = "sha256-" + "1".repeat(64);
const oldWindow = formatReadFileWindowPayloadForModel(path, {
  path, content: "Play Mode tests\n", contentVersion: version,
  startLine: 1, endLine: 1, totalLines: 3, totalChars: 45, returnedChars: 16, truncated: true,
}, { start_line: 1, end_line: 1 });
const prior = {
  toolName: "read_file", arguments: { path, start_line: 1, end_line: 1 }, observedAt: 100,
  evidence: { id: "E2", target: path, kind: "source", version }, modelContent: `[E2] ${path}\n${oldWindow}`,
};

for (const [name, origin, modifiedMs, requestedLine, expectedReplay] of [
  ["same-run unchanged", "current", 90, 1, true],
  ["historical unchanged", "historical", 90, 1, true],
  ["edited on disk", "historical", 110, 1, false],
  ["new line range", "historical", 90, 3, false],
]) {
  test(`Plan readiness read reuses only a retained unchanged range (${name})`, async () => {
    const effects = [];
    const load = createTsModuleLoader({
      "../../lib/ipc": { getFileMetadata: async () => ({ path: `/fixture/${path}`, sizeBytes: 45, modifiedMs }) },
      "../../lib/toolExecutor": { executeTool: async (...args) => { effects.push(args); return "Fresh workspace read."; } },
      "./sourceEvidenceVersion": { resolveRuntimeV2SourceEvidenceVersion: async () => "sha256-" + "2".repeat(64) },
    });
    const { executeReadOnlyPlanTool } = load("src/store/runtimeV2/planEvidencePort.ts");
    const run = { turnId: "turn", runId: "run" };
    const events = origin === "current" ? [
      { type: "command.scheduled", sequence: 0, run, command: { kind: "execute_tool", idempotencyKey: "old", run,
        payload: { toolName: prior.toolName, arguments: prior.arguments } } },
      { type: "tool.completed", sequence: 1, at: prior.observedAt, run, idempotencyKey: "old", status: "succeeded",
        evidence: [prior.evidence], modelContent: prior.modelContent },
    ] : [];
    const retainedId = origin === "current" ? "E2" : "draft-E2";
    const evidence = [{ ...prior.evidence, id: retainedId }];
    const receipts = [];
    const messages = [];
    const logs = [];
    await executeReadOnlyPlanTool({
      context: { runWorkspace: "/fixture", runSessionKey: "session" },
      ledger: {
        snapshot: () => ({ events, nextSequence: events.length, objective: {} }),
        schedule: async () => ({ idempotencyKey: "current" }),
        settleCommand: async event => receipts.push(event),
      },
      run,
      call: { id: "validation-read", name: "read_file", arguments: { path, start_line: requestedLine, end_line: requestedLine } },
      messages, evidence, evidenceContents: new Map([[retainedId, prior.modelContent]]), parallelReadCount: 1,
      logStoreEvent: (event, data) => logs.push({ event, data }),
      reuseRetainedRead: { historicalReads: origin === "historical" ? [prior] : [] },
    });
    assert.equal(effects.length, expectedReplay ? 0 : 1);
    assert.equal(receipts[0].receiptOrigin, expectedReplay ? "replayed" : "executed");
    if (expectedReplay) {
      assert.deepEqual(receipts[0].evidence, []);
      assert.match(messages[0].content, /Play Mode tests/);
      assert.equal(logs[0].data.evidenceId, retainedId);
    } else {
      assert.equal(evidence.some(item => item.id === retainedId), false);
      assert.match(messages[0].content, /Fresh workspace read/);
    }
  });
}
