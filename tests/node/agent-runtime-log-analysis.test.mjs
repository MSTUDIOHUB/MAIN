import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  analyzeAgentRuntimeEvents,
  parseAgentRuntimeLog,
} from "../../scripts/analyze-agent-runtime-log.mjs";

test("runtime log analysis groups runs and reports efficiency signals", async (t) => {
  const fixtureDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "main-runtime-log-"));
  const fixturePath = path.join(fixtureDirectory, "main-debug.log");
  t.after(() => fs.rm(fixtureDirectory, { recursive: true, force: true }));

  const fixture = [
    "unparseable prefix",
    '[2026-07-10T08:00:00.000Z] [info] [agent.loop_start] {"workflowMode":"plan","runtimeIntent":"plan","maxIterations":25}',
    '[2026-07-10T08:00:01.000Z] [info] [agent.iteration_start] {"iteration":1}',
    '[2026-07-10T08:00:02.000Z] [info] [agent.tool_calls_detected] {"iteration":1,"count":2,"names":["read_file","read_file"]}',
    '[2026-07-10T08:00:03.000Z] [info] [agent.tool_calls_detected] {"iteration":2,"count":2,"names":["apply_patch","read_file"]}',
    '[2026-07-10T08:00:04.000Z] [info] [agent.tool_calls_detected] {"iteration":3,"count":1,"names":["run_command"]}',
    '[2026-07-10T08:00:05.000Z] [info] [agent.context_pack_built] {"forceManaged":true,"forceReason":"token_budget_threshold","droppedMessageCount":4}',
    '[2026-07-10T08:00:06.000Z] [info] [agent.loop_stop] {"reason":"assistant_text_done","iteration":3}',
    '[2026-07-10T09:00:00.000Z] [info] [agent.loop_start] {"workflowMode":"edit","runtimeIntent":"execute","maxIterations":50}',
    '[2026-07-10T09:00:01.000Z] [warn] [agent.provider_compatibility_retry] {"iteration":1,"reason":"unsupported tools"}',
    '[2026-07-10T09:00:02.000Z] [info] [agent.tool_calls_detected] {"iteration":1,"count":1,"names":["read_file"]}',
    '[2026-07-10T09:00:03.000Z] [info] [agent.tool_calls_detected] {"iteration":2,"count":2,"names":["replace_in_file","execute_command"]}',
    '[2026-07-10T09:00:04.000Z] [info] [agent.context_pack_built] {"forceManaged":true,"forceReason":"tool_message_threshold","droppedMessageCount":0}',
    '[2026-07-10T09:00:04.500Z] [info] [agent.execute_recovery_context_compacted] {"forceReason":"token_budget_threshold","droppedMessageCount":3}',
    '[2026-07-10T09:00:05.000Z] [info] [agent.loop_stop] {"reason":"execution_evidence_required","iteration":2}',
    '[2026-07-10T09:00:05.100Z] [info] [store.non_actionable_stop] {"reason":"no_action","recoveryReason":"execution_evidence_required"}',
    '[2026-07-10T09:00:06.000Z] [info] [app.lifecycle] {"phase":"unrelated"}',
    '[broken] [info] [agent.loop_stop] {not-json}',
  ].join("\n");

  await fs.writeFile(fixturePath, fixture, "utf8");
  const events = parseAgentRuntimeLog(await fs.readFile(fixturePath, "utf8"));
  const report = analyzeAgentRuntimeEvents(events);

  assert.equal(report.runs.length, 2);
  assert.deepEqual(
    report.runs.map((run) => [run.workflowMode, run.runtimeIntent, run.maxIteration]),
    [["plan", "plan", 3], ["edit", "execute", 2]],
  );

  const [planRun, executeRun] = report.runs;
  assert.equal(planRun.readFileCalls, 3);
  assert.equal(planRun.toolCallsByName.read_file, 3);
  assert.equal(planRun.mutationToolCalls, 1);
  assert.equal(planRun.validationToolCalls, 1);
  assert.equal(planRun.firstMutationIteration, 2);
  assert.equal(planRun.forcedContextPacks, 1);
  assert.equal(planRun.forcedContextReasons.token_budget_threshold, 1);
  assert.equal(planRun.actualDroppedMessages, 4);

  assert.equal(executeRun.providerCompatibilityRetries, 1);
  assert.equal(executeRun.noActionStops, 1);
  assert.equal(executeRun.firstMutationIteration, 2);
  assert.equal(executeRun.forcedContextReasons.tool_message_threshold, 1);
  assert.equal(executeRun.forcedContextReasons.token_budget_threshold, 1);
  assert.equal(executeRun.actualDroppedMessages, 3);
  assert.equal(executeRun.endedAt, "2026-07-10T09:00:05.100Z");

  assert.deepEqual(report.aggregate.workflowModes, { plan: 1, edit: 1 });
  assert.equal(report.aggregate.readFileCalls, 4);
  assert.equal(report.aggregate.mutationToolCalls, 2);
  assert.equal(report.aggregate.validationToolCalls, 2);
  assert.equal(report.aggregate.providerCompatibilityRetries, 1);
  assert.equal(report.aggregate.noActionStops, 1);
  assert.equal(report.aggregate.forcedContextPacks, 3);
  assert.equal(report.aggregate.actualDroppedMessages, 7);
});
