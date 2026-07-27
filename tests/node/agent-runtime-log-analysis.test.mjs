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

test("runtime log analysis reconstructs Runtime v2 tools, children, projections, and terminal truth", () => {
  const events = parseAgentRuntimeLog([
    '[1785135799.722] [info] [store.runtime_v2_execute_admitted] {"turnId":"turn-v2","runId":"run-v2","strategy":"execute"}',
    '[1785135800.000] [info] [store.runtime_v2_provider_request_opened] {"turnId":"turn-v2","runId":"run-v2","phase":"acting"}',
    '[1785135800.050] [warn] [store.runtime_v2_provider_protocol_failed] {"turnId":"turn-v2","runId":"run-v2","protocolCode":"tool_surface_rejected"}',
    '[1785135800.060] [warn] [store.runtime_v2_provider_protocol_failed] {"turnId":"turn-v2","runId":"run-v2","protocolCode":"tool_arguments_rejected"}',
    '[1785135800.065] [info] [store.runtime_v2_validation_fallback_selected] {"turnId":"turn-v2","runId":"run-v2","command":"npm run build"}',
    '[1785135800.062] [warn] [store.runtime_v2_provider_transport_failed] {"turnId":"turn-v2","runId":"run-v2","timedOut":true,"timeoutMs":90000}',
    '[1785135800.064] [warn] [store.runtime_v2_tool_deadline_exceeded] {"turnId":"turn-v2","runId":"run-v2","toolName":"read_file","timeoutMs":45000}',
    '[1785135800.068] [info] [store.runtime_v2_failure_read_window_selected] {"turnId":"turn-v2","runId":"run-v2","path":"src/main.js","failureLine":405,"failureLabel":"replace_in_file"}',
    '[1785135800.069] [info] [store.runtime_v2_source_refresh_fallback_selected] {"turnId":"turn-v2","runId":"run-v2","path":"src/main.js","startLine":381,"endLine":485}',
    '[1785135800.070] [info] [store.runtime_v2_provider_tool_batch_normalized] {"turnId":"turn-v2","runId":"run-v2","originalToolCount":3,"discardedToolNames":["read_file","read_file"]}',
    '[1785135800.075] [info] [store.runtime_v2_context_prepared] {"turnId":"turn-v2","runId":"run-v2","mode":"execute","executePolicy":"mutation_required","mutationToolAvailable":true,"sourceReadAvailable":false,"mutationLeaseAuthority":"acceptance_failure","excludedMutationTool":"apply_patch","availableContextEntries":16,"droppedEvidenceEntries":4,"contextSources":{"workspace":1,"tool":12,"subagent":2,"provider":1,"plan":0},"retainedContextSources":{"workspace":1,"tool":3,"subagent":2,"provider":1,"plan":0}}',
    '[1785135800.076] [warn] [store.runtime_v2_context_prepared] {"turnId":"turn-v2","runId":"run-v2","mode":"observe","mutationToolAvailable":true}',
    '[1785135800.077] [warn] [store.runtime_v2_context_prepared] {"turnId":"turn-v2","runId":"run-v2","mode":"execute","executePolicy":"source_gap_allowed","mutationToolAvailable":true}',
    '[1785135800.078] [warn] [store.runtime_v2_context_prepared] {"turnId":"turn-v2","runId":"run-v2","mode":"execute","executePolicy":"mutation_required","mutationToolAvailable":true}',
    '[1785135800.100] [info] [store.runtime_v2_tool_execution_started] {"turnId":"turn-v2","runId":"run-v2","toolName":"read_file","target":"src/main.js"}',
    '[1785135800.200] [info] [store.runtime_v2_subagent_request_opened] {"turnId":"turn-v2","runId":"run-v2","jobId":"child-a"}',
    '[1785135800.300] [info] [store.runtime_v2_subagent_joined] {"turnId":"turn-v2","runId":"run-v2","jobId":"child-a"}',
    '[1785135800.400] [info] [store.runtime_v2_phase_transition] {"turnId":"turn-v2","runId":"run-v2","from":"observing","to":"acting"}',
    '[1785135800.500] [info] [store.runtime_v2_projection_published] {"turnId":"turn-v2","runId":"run-v2","audience":"capsule_live","storeDisposition":"projected"}',
    '[1785135800.600] [info] [store.runtime_v2_tool_execution_started] {"turnId":"turn-v2","runId":"run-v2","toolName":"apply_patch","target":"src/main.js"}',
    '[1785135800.650] [info] [store.runtime_v2_mutation_preflight_rejected] {"turnId":"turn-v2","runId":"run-v2","toolName":"apply_patch","target":"src/main.js","reason":"oversized_change"}',
    '[1785135800.660] [info] [store.runtime_v2_mutation_preflight_rejected] {"turnId":"turn-v2","runId":"run-v2","toolName":"write_file","target":"/tmp/outside.js","reason":"outside_workspace"}',
    '[1785135800.700] [info] [store.runtime_v2_ledger_committed] {"turnId":"turn-v2","runId":"run-v2","eventType":"soft_signal.observed"}',
    '[1785135800.725] [info] [store.runtime_v2_tool_execution_blocked] {"turnId":"turn-v2","runId":"run-v2","commandKind":"execute_validation","toolName":"run_command","reason":"finite_validation_contract_required"}',
    '[1785135800.730] [info] [store.runtime_v2_tool_execution_blocked] {"turnId":"turn-v2","runId":"run-v2","commandKind":"execute_tool","toolName":"replace_in_file","reason":"mutation_target_lease_mismatch"}',
    '[1785135800.750] [info] [store.runtime_v2_tool_execution_completed] {"turnId":"turn-v2","runId":"run-v2","commandKind":"execute_validation","toolName":"run_command","validationPassed":true}',
    '[1785135800.800] [info] [store.runtime_v2_execute_terminal] {"turnId":"turn-v2","runId":"run-v2","resultKind":"success","reason":"validated","mutations":1}',
  ].join("\n"));

  const report = analyzeAgentRuntimeEvents(events);
  assert.equal(report.schemaVersion, 2);
  assert.equal(report.runs.length, 1);
  assert.equal(report.runs[0].runtimeVersion, "v2");
  assert.equal(report.runs[0].providerRequests, 1);
  assert.equal(report.runs[0].providerProtocolFailures, 2);
  assert.equal(report.runs[0].providerRequestTimeouts, 1);
  assert.equal(report.runs[0].toolDeadlineExceeded, 1);
  assert.equal(report.runs[0].readFileCalls, 1);
  assert.equal(report.runs[0].mutationToolCalls, 1);
  assert.equal(report.runs[0].subagentRequests, 1);
  assert.equal(report.runs[0].subagentsJoined, 1);
  assert.equal(report.runs[0].softSignals, 1);
  assert.equal(report.runs[0].validationPasses, 1);
  assert.equal(report.runs[0].invalidValidationAttempts, 2);
  assert.equal(report.runs[0].validationFallbacks, 1);
  assert.equal(report.runs[0].failureReadWindows, 1);
  assert.equal(report.runs[0].sourceMismatchRefreshes, 1);
  assert.equal(report.runs[0].runtimeOwnedSourceRefreshes, 1);
  assert.equal(report.runs[0].normalizedToolBatches, 1);
  assert.equal(report.runs[0].discardedToolCalls, 2);
  assert.equal(report.runs[0].mutationPreflightRejections, 2);
  assert.equal(report.runs[0].oversizedMutationRejections, 1);
  assert.equal(report.runs[0].outsideWorkspaceMutationRejections, 1);
  assert.equal(report.runs[0].correctiveTargetRejections, 1);
  assert.equal(report.runs[0].investigationMutationSurfaceViolations, 1);
  assert.equal(report.runs[0].sourceGapMutationSurfaceViolations, 1);
  assert.equal(report.runs[0].mutationRequestsWithoutLease, 1);
  assert.equal(report.runs[0].mutationEditorFallbacks, 1);
  assert.deepEqual(report.runs[0].executePolicies, {
    mutation_required: 2,
    source_gap_allowed: 1,
  });
  assert.deepEqual(report.runs[0].mutationLeaseAuthorities, {
    acceptance_failure: 1,
  });
  assert.equal(report.runs[0].maxAvailableContextEntries, 16);
  assert.equal(report.runs[0].maxDroppedContextEntries, 4);
  assert.equal(report.runs[0].contextAnchorLosses, 0);
  assert.equal(report.runs[0].terminalResultKind, "success");
  assert.deepEqual(report.runs[0].phaseTransitions, { "observing->acting": 1 });
  assert.deepEqual(report.runs[0].projections, { "capsule_live:projected": 1 });
  assert.deepEqual(report.aggregate.runtimeVersions, { v2: 1 });
  assert.equal(report.aggregate.validationFallbacks, 1);
  assert.equal(report.aggregate.failureReadWindows, 1);
  assert.equal(report.aggregate.providerRequestTimeouts, 1);
  assert.equal(report.aggregate.toolDeadlineExceeded, 1);
  assert.equal(report.aggregate.sourceMismatchRefreshes, 1);
  assert.equal(report.aggregate.runtimeOwnedSourceRefreshes, 1);
  assert.equal(report.aggregate.discardedToolCalls, 2);
  assert.equal(report.aggregate.oversizedMutationRejections, 1);
  assert.equal(report.aggregate.outsideWorkspaceMutationRejections, 1);
  assert.equal(report.aggregate.correctiveTargetRejections, 1);
  assert.equal(report.aggregate.investigationMutationSurfaceViolations, 1);
  assert.equal(report.aggregate.sourceGapMutationSurfaceViolations, 1);
  assert.equal(report.aggregate.mutationRequestsWithoutLease, 1);
  assert.equal(report.aggregate.mutationEditorFallbacks, 1);
});
